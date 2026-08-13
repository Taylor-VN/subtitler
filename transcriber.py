"""
Local AI transcription backend for Subtitler Pro.

Runs an open-source Whisper model entirely on this machine — nothing is
uploaded anywhere. Models come from the Hugging Face Hub (cached under
~/.cache/huggingface after the first download) or from a local directory you
point at.

Two engines are supported, tried in this order:

  1. faster-whisper (CTranslate2) — the default. Several times faster than the
     reference implementation on CPU, low memory, and it emits the word-level
     timestamps this app needs to cut captions accurately.
  2. transformers — fallback, so any Whisper-architecture checkpoint on the Hub
     (including community fine-tunes) can be used.

Audio arrives from the front-end already decoded to 16 kHz mono WAV, which is
exactly what Whisper wants, so no ffmpeg is required for transcription.
"""

import os
import base64
import tempfile
import threading
import traceback
import uuid

# Whisper's own size presets. faster-whisper resolves the bare names to the
# corresponding Systran/faster-whisper-* repository on the Hub.
MODEL_PRESETS = {
    'tiny':           {'id': 'tiny',              'label': 'Tiny — fastest, roughly 75 MB',        'params': '39M'},
    'base':           {'id': 'base',              'label': 'Base — fast, roughly 145 MB',          'params': '74M'},
    'small':          {'id': 'small',             'label': 'Small — balanced, roughly 480 MB',     'params': '244M'},
    'medium':         {'id': 'medium',            'label': 'Medium — accurate, roughly 1.5 GB',    'params': '769M'},
    'large-v3':       {'id': 'large-v3',          'label': 'Large v3 — best quality, roughly 3 GB', 'params': '1550M'},
    'distil-large-v3': {'id': 'distil-large-v3',  'label': 'Distil Large v3 — near-large quality, about 2x faster', 'params': '756M'},
}

TERMINAL_STATES = ('done', 'error', 'cancelled')


class TranscriptionJob:
    def __init__(self, job_id, options):
        self.id = job_id
        self.options = options or {}
        self.state = 'receiving'      # receiving -> loading -> transcribing -> done
        self.progress = 0.0
        self.message = 'Waiting for audio…'
        self.error = None
        self.result = None
        self.cancelled = False
        self.audio_path = None
        self.audio_file = None
        self.bytes_received = 0
        self.thread = None

    def snapshot(self):
        return {
            'ok': True,
            'job_id': self.id,
            'state': self.state,
            'progress': round(self.progress, 4),
            'message': self.message,
            'error': self.error,
            'result': self.result if self.state == 'done' else None,
            'bytes_received': self.bytes_received,
        }


class Transcriber:
    def __init__(self):
        self.jobs = {}
        self._lock = threading.Lock()

    # ------------------------------------------------------------------
    # Capability probing
    # ------------------------------------------------------------------
    def probe(self):
        """Report which engines are installed, and what hardware is available."""
        engines = []
        try:
            import faster_whisper  # noqa: F401
            engines.append('faster-whisper')
        except Exception:
            pass
        try:
            import transformers  # noqa: F401
            engines.append('transformers')
        except Exception:
            pass

        device = 'cpu'
        device_name = 'CPU'
        try:
            import torch
            if torch.cuda.is_available():
                device = 'cuda'
                device_name = torch.cuda.get_device_name(0)
            elif getattr(torch.backends, 'mps', None) and torch.backends.mps.is_available():
                device = 'mps'
                device_name = 'Apple Silicon GPU (MPS)'
        except Exception:
            pass

        return {
            'ok': True,
            'available': len(engines) > 0,
            'engines': engines,
            'device': device,
            'device_name': device_name,
            'presets': MODEL_PRESETS,
            'cached_models': self.list_cached_models(),
            'install_hint': 'pip install -r requirements.txt',
        }

    def list_cached_models(self):
        """Models already downloaded, so the UI can show what runs offline."""
        found = []
        try:
            from huggingface_hub import scan_cache_dir
            cache = scan_cache_dir()
            for repo in cache.repos:
                name = repo.repo_id
                if 'whisper' in name.lower():
                    found.append({
                        'id': name,
                        'size_on_disk': repo.size_on_disk,
                        'path': str(repo.repo_path),
                    })
        except Exception:
            pass
        return found

    # ------------------------------------------------------------------
    # Audio upload — the page streams 16 kHz mono WAV over in chunks
    # ------------------------------------------------------------------
    def begin(self, options):
        try:
            probe = self.probe()
            if not probe['available']:
                return {
                    'ok': False,
                    'error': ('No transcription engine is installed.\n\n'
                              'Install one with:\n'
                              '    pip install -r requirements.txt\n\n'
                              'then relaunch Subtitler Pro.')
                }

            job_id = uuid.uuid4().hex
            job = TranscriptionJob(job_id, options)
            fd, path = tempfile.mkstemp(prefix=f'subtitler_audio_{job_id}_', suffix='.wav')
            os.close(fd)
            job.audio_path = path
            job.audio_file = open(path, 'wb')

            with self._lock:
                self.jobs[job_id] = job
            return {'ok': True, 'job_id': job_id}
        except Exception as e:
            return {'ok': False, 'error': str(e)}

    def push_audio(self, job_id, b64_chunk):
        try:
            job = self.jobs.get(job_id)
            if not job:
                return {'ok': False, 'error': 'Unknown transcription job.'}
            if job.cancelled:
                return {'ok': False, 'error': 'Cancelled.'}
            data = base64.b64decode(b64_chunk)
            job.audio_file.write(data)
            job.bytes_received += len(data)
            return {'ok': True, 'bytes_received': job.bytes_received}
        except Exception as e:
            return {'ok': False, 'error': str(e)}

    def finish_audio_and_run(self, job_id):
        """Close the WAV and kick the model off on a worker thread."""
        try:
            job = self.jobs.get(job_id)
            if not job:
                return {'ok': False, 'error': 'Unknown transcription job.'}
            if job.audio_file:
                job.audio_file.close()
                job.audio_file = None
            if job.bytes_received == 0:
                job.state = 'error'
                job.error = 'No audio was received.'
                return {'ok': False, 'error': job.error}

            job.state = 'loading'
            job.message = 'Loading model…'
            job.thread = threading.Thread(target=self._run_job, args=(job,), daemon=True)
            job.thread.start()
            return {'ok': True, 'job_id': job_id}
        except Exception as e:
            return {'ok': False, 'error': str(e)}

    def status(self, job_id):
        job = self.jobs.get(job_id)
        if not job:
            return {'ok': False, 'error': 'Unknown transcription job.'}
        return job.snapshot()

    def cancel(self, job_id):
        job = self.jobs.get(job_id)
        if not job:
            return {'ok': False, 'error': 'Unknown transcription job.'}
        job.cancelled = True
        if job.state not in TERMINAL_STATES:
            job.state = 'cancelled'
            job.message = 'Cancelled.'
        return {'ok': True}

    def cleanup(self, job_id):
        try:
            with self._lock:
                job = self.jobs.pop(job_id, None)
            if job:
                job.cancelled = True
                if job.audio_file:
                    try:
                        job.audio_file.close()
                    except Exception:
                        pass
                if job.audio_path and os.path.exists(job.audio_path):
                    os.unlink(job.audio_path)
            return {'ok': True}
        except Exception as e:
            return {'ok': False, 'error': str(e)}

    # ------------------------------------------------------------------
    # Worker
    # ------------------------------------------------------------------
    def _run_job(self, job):
        try:
            opts = job.options
            model_ref = self._resolve_model_ref(opts)

            engine = opts.get('engine') or 'auto'
            if engine in ('auto', 'faster-whisper'):
                try:
                    import faster_whisper  # noqa: F401
                    self._run_faster_whisper(job, model_ref)
                    return
                except ImportError:
                    if engine == 'faster-whisper':
                        raise RuntimeError('faster-whisper is not installed.')
            self._run_transformers(job, model_ref)
        except Exception as e:
            job.state = 'error'
            job.error = f'{e}\n\n{traceback.format_exc(limit=3)}'
            job.message = str(e)

    def _resolve_model_ref(self, opts):
        """A size preset, an arbitrary HF repo id, or a local directory."""
        custom = (opts.get('custom_model') or '').strip()
        if custom:
            expanded = os.path.expanduser(custom)
            if os.path.isdir(expanded):
                return expanded
            return custom
        preset = opts.get('model') or 'small'
        return MODEL_PRESETS.get(preset, {}).get('id', preset)

    def _pick_device(self, opts):
        requested = opts.get('device') or 'auto'
        if requested != 'auto':
            return requested
        try:
            import torch
            if torch.cuda.is_available():
                return 'cuda'
        except Exception:
            pass
        return 'cpu'

    def _run_faster_whisper(self, job, model_ref):
        from faster_whisper import WhisperModel

        opts = job.options
        device = self._pick_device(opts)
        # int8 keeps CPU inference fast and memory small; fp16 suits a GPU.
        compute_type = opts.get('compute_type') or ('float16' if device == 'cuda' else 'int8')

        job.state = 'loading'
        job.message = f'Loading "{model_ref}" on {device.upper()}… (first run downloads the model)'
        model = WhisperModel(model_ref, device=device, compute_type=compute_type)

        if job.cancelled:
            job.state = 'cancelled'
            return

        language = opts.get('language') or None
        if language in ('auto', ''):
            language = None

        job.state = 'transcribing'
        job.message = 'Transcribing…'

        segments_iter, info = model.transcribe(
            job.audio_path,
            language=language,
            task=opts.get('task') or 'transcribe',
            word_timestamps=True,
            vad_filter=bool(opts.get('vad', True)),
            beam_size=int(opts.get('beam_size', 5)),
            condition_on_previous_text=False,
        )

        total = float(getattr(info, 'duration', 0) or 0)
        detected = getattr(info, 'language', None)
        out_segments = []

        for seg in segments_iter:
            if job.cancelled:
                job.state = 'cancelled'
                job.message = 'Cancelled.'
                return
            words = []
            for w in (getattr(seg, 'words', None) or []):
                words.append({
                    'word': w.word,
                    'start': float(w.start),
                    'end': float(w.end),
                    'probability': float(getattr(w, 'probability', 1.0) or 1.0),
                })
            out_segments.append({
                'start': float(seg.start),
                'end': float(seg.end),
                'text': seg.text.strip(),
                'words': words,
            })
            if total > 0:
                job.progress = min(0.99, float(seg.end) / total)
                job.message = f'Transcribing… {int(job.progress * 100)}%'

        job.progress = 1.0
        job.state = 'done'
        job.message = f'Transcribed {len(out_segments)} segments.'
        job.result = {
            'segments': out_segments,
            'language': detected,
            'duration': total,
            'engine': 'faster-whisper',
            'model': model_ref,
            'device': device,
        }

    def _run_transformers(self, job, model_ref):
        from transformers import pipeline

        opts = job.options
        device = self._pick_device(opts)

        job.state = 'loading'
        job.message = f'Loading "{model_ref}" with transformers on {device.upper()}…'

        device_arg = 0 if device == 'cuda' else -1
        asr = pipeline(
            'automatic-speech-recognition',
            model=model_ref,
            device=device_arg,
            chunk_length_s=30,
        )

        if job.cancelled:
            job.state = 'cancelled'
            return

        job.state = 'transcribing'
        job.message = 'Transcribing…'
        job.progress = 0.05

        generate_kwargs = {}
        language = opts.get('language')
        if language and language not in ('auto', ''):
            generate_kwargs['language'] = language
        if opts.get('task'):
            generate_kwargs['task'] = opts['task']

        raw = asr(job.audio_path, return_timestamps='word', generate_kwargs=generate_kwargs or None)

        words = []
        for chunk in (raw.get('chunks') or []):
            ts = chunk.get('timestamp') or (None, None)
            start, end = ts[0], ts[1]
            if start is None:
                continue
            if end is None:
                end = start + 0.2
            words.append({
                'word': chunk.get('text', ''),
                'start': float(start),
                'end': float(end),
                'probability': 1.0,
            })

        segments = [{
            'start': words[0]['start'] if words else 0.0,
            'end': words[-1]['end'] if words else 0.0,
            'text': (raw.get('text') or '').strip(),
            'words': words,
        }] if words else []

        job.progress = 1.0
        job.state = 'done'
        job.message = f'Transcribed {len(words)} words.'
        job.result = {
            'segments': segments,
            'language': opts.get('language') or None,
            'duration': words[-1]['end'] if words else 0.0,
            'engine': 'transformers',
            'model': model_ref,
            'device': device,
        }
