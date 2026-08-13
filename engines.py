"""
Transcription engine adapters and the forced aligner.

Every adapter exposes the same shape:

    engine = SomeEngine(model_desc, options)
    engine.load(progress_cb)
    result = engine.transcribe(wav_path, options, progress_cb)
        -> {'segments': [...], 'words': [...], 'language': str|None}

Recognition and timing are deliberately separate concerns. The most accurate
models available are LLM-backbone designs that return text without usable word
times, which is fine for a transcript and useless for captions. Rather than
ruling those models out, the ForcedAligner attaches precise per-word times to
whatever transcript comes back, so model choice and timing quality stop being
the same decision.
"""

import os
import re
import wave

import model_registry as registry


class EngineError(RuntimeError):
    pass


def _read_wav_mono16k(path):
    """The front-end always sends 16 kHz mono PCM, so this stays simple."""
    with wave.open(path, 'rb') as w:
        if w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise EngineError('Internal error: expected 16-bit mono PCM audio.')
        frames = w.readframes(w.getnframes())
        rate = w.getframerate()
    import array
    samples = array.array('h')
    samples.frombytes(frames)
    return samples, rate


class BaseEngine:
    def __init__(self, model_desc, options=None):
        self.model = model_desc
        self.options = options or {}
        self.handle = None

    @property
    def repo(self):
        custom = (self.options.get('custom_model') or '').strip()
        if custom:
            return os.path.expanduser(custom) if os.path.isdir(os.path.expanduser(custom)) else custom
        return self.model['repo']

    def load(self, progress_cb=None):
        raise NotImplementedError

    def transcribe(self, wav_path, options, progress_cb=None):
        raise NotImplementedError

    @staticmethod
    def _lang(options):
        lang = options.get('language')
        return None if lang in (None, '', 'auto') else lang


class MlxWhisperEngine(BaseEngine):
    """Whisper on the Apple GPU through MLX."""

    def load(self, progress_cb=None):
        try:
            import mlx_whisper  # noqa: F401
        except ImportError:
            raise EngineError('mlx-whisper is not installed. Install it with: pip install mlx-whisper')
        self.handle = True

    def transcribe(self, wav_path, options, progress_cb=None):
        import mlx_whisper
        if progress_cb:
            progress_cb(0.1, 'Running Whisper on the Apple GPU…')

        raw = mlx_whisper.transcribe(
            wav_path,
            path_or_hf_repo=self.repo,
            language=self._lang(options),
            task=options.get('task') or 'transcribe',
            word_timestamps=True,
            condition_on_previous_text=False,
        )

        segments, words = [], []
        for seg in raw.get('segments', []) or []:
            seg_words = []
            for w in (seg.get('words') or []):
                item = {
                    'word': w.get('word', ''),
                    'start': float(w.get('start', seg.get('start', 0))),
                    'end': float(w.get('end', seg.get('end', 0))),
                    'probability': float(w.get('probability', 1.0) or 1.0),
                }
                seg_words.append(item)
                words.append(item)
            segments.append({
                'start': float(seg.get('start', 0)),
                'end': float(seg.get('end', 0)),
                'text': (seg.get('text') or '').strip(),
                'words': seg_words,
            })

        return {'segments': segments, 'words': words,
                'language': raw.get('language'), 'text': raw.get('text', '')}


class ParakeetMlxEngine(BaseEngine):
    """NVIDIA Parakeet on the Apple GPU through MLX. English, fast, accurate."""

    def load(self, progress_cb=None):
        try:
            from parakeet_mlx import from_pretrained
        except ImportError:
            raise EngineError('parakeet-mlx is not installed. Install it with: pip install parakeet-mlx')
        if progress_cb:
            progress_cb(0.05, f'Loading {self.model["label"]}…')
        self.handle = from_pretrained(self.repo)

    def transcribe(self, wav_path, options, progress_cb=None):
        if progress_cb:
            progress_cb(0.1, 'Running Parakeet on the Apple GPU…')
        raw = self.handle.transcribe(wav_path)

        words, segments = [], []
        for seg in (getattr(raw, 'sentences', None) or []):
            seg_words = []
            for tok in (getattr(seg, 'tokens', None) or []):
                item = {
                    'word': getattr(tok, 'text', ''),
                    'start': float(getattr(tok, 'start', 0.0)),
                    'end': float(getattr(tok, 'end', 0.0)),
                    'probability': 1.0,
                }
                seg_words.append(item)
                words.append(item)
            segments.append({
                'start': float(getattr(seg, 'start', 0.0)),
                'end': float(getattr(seg, 'end', 0.0)),
                'text': (getattr(seg, 'text', '') or '').strip(),
                'words': seg_words,
            })

        text = getattr(raw, 'text', '') or ' '.join(s['text'] for s in segments)
        if not segments and text:
            segments = [{'start': 0.0, 'end': 0.0, 'text': text.strip(), 'words': []}]

        return {'segments': segments, 'words': words, 'language': 'en', 'text': text}


class Qwen3AsrMlxEngine(BaseEngine):
    """Qwen3-ASR on the Apple GPU. Text only — the aligner supplies timings."""

    def load(self, progress_cb=None):
        try:
            import mlx_qwen3_asr  # noqa: F401
        except ImportError:
            raise EngineError('mlx-qwen3-asr is not installed. Install it with: pip install mlx-qwen3-asr')
        self.handle = True

    def transcribe(self, wav_path, options, progress_cb=None):
        import mlx_qwen3_asr
        if progress_cb:
            progress_cb(0.1, 'Running Qwen3-ASR on the Apple GPU…')

        raw = mlx_qwen3_asr.transcribe(
            wav_path,
            path_or_hf_repo=self.repo,
            language=self._lang(options),
        )
        text = raw.get('text', '') if isinstance(raw, dict) else str(raw)
        language = raw.get('language') if isinstance(raw, dict) else self._lang(options)

        return {
            'segments': [{'start': 0.0, 'end': 0.0, 'text': text.strip(), 'words': []}] if text.strip() else [],
            'words': [],
            'language': language,
            'text': text,
        }


class TransformersEngine(BaseEngine):
    """
    Generic Hugging Face path — Cohere Transcribe, Granite Speech, Distil-Whisper.
    Uses MPS on Apple Silicon, CUDA where present, otherwise CPU.
    """

    def _device(self):
        requested = self.options.get('device') or 'auto'
        try:
            import torch
            if requested != 'auto':
                return requested
            if torch.cuda.is_available():
                return 'cuda'
            if getattr(torch.backends, 'mps', None) and torch.backends.mps.is_available():
                return 'mps'
        except Exception:
            pass
        return 'cpu'

    def load(self, progress_cb=None):
        try:
            from transformers import pipeline
        except ImportError:
            raise EngineError(
                'transformers is not installed. Install it with: pip install "transformers>=4.40" torch')
        device = self._device()
        if progress_cb:
            progress_cb(0.05, f'Loading {self.model["label"]} on {device.upper()}…')
        self.device = device
        self.handle = pipeline(
            'automatic-speech-recognition',
            model=self.repo,
            device=device,
            chunk_length_s=30,
        )

    def transcribe(self, wav_path, options, progress_cb=None):
        if progress_cb:
            progress_cb(0.1, f'Transcribing on {self.device.upper()}…')

        generate_kwargs = {}
        lang = self._lang(options)
        if lang:
            generate_kwargs['language'] = lang
        if options.get('task'):
            generate_kwargs['task'] = options['task']

        wants_words = bool(self.model.get('word_timings'))
        try:
            raw = self.handle(wav_path,
                              return_timestamps='word' if wants_words else False,
                              generate_kwargs=generate_kwargs or None)
        except (ValueError, TypeError):
            # Not every checkpoint supports word timestamps or generate kwargs.
            raw = self.handle(wav_path)

        text = (raw.get('text') if isinstance(raw, dict) else str(raw)) or ''
        words = []
        for chunk in ((raw.get('chunks') if isinstance(raw, dict) else None) or []):
            ts = chunk.get('timestamp') or (None, None)
            if ts[0] is None:
                continue
            words.append({
                'word': chunk.get('text', ''),
                'start': float(ts[0]),
                'end': float(ts[1] if ts[1] is not None else ts[0] + 0.2),
                'probability': 1.0,
            })

        segments = [{
            'start': words[0]['start'] if words else 0.0,
            'end': words[-1]['end'] if words else 0.0,
            'text': text.strip(),
            'words': words,
        }] if text.strip() else []

        return {'segments': segments, 'words': words, 'language': lang, 'text': text}


class FasterWhisperEngine(BaseEngine):
    """
    CTranslate2 Whisper. Note this has no Metal backend — on Apple Silicon it
    runs on CPU cores only and leaves the GPU idle, so the MLX engines are
    preferred there. Kept for CUDA machines and as a universal fallback.
    """

    def _device(self):
        requested = self.options.get('device') or 'auto'
        if requested != 'auto':
            return requested
        try:
            import torch
            if torch.cuda.is_available():
                return 'cuda'
        except Exception:
            pass
        return 'cpu'

    def load(self, progress_cb=None):
        try:
            from faster_whisper import WhisperModel
        except ImportError:
            raise EngineError('faster-whisper is not installed. Install it with: pip install faster-whisper')
        device = self._device()
        compute = self.options.get('compute_type') or ('float16' if device == 'cuda' else 'int8')
        if progress_cb:
            progress_cb(0.05, f'Loading {self.model["label"]} on {device.upper()}…')
        self.device = device
        self.handle = WhisperModel(self.repo, device=device, compute_type=compute)

    def transcribe(self, wav_path, options, progress_cb=None):
        segments_iter, info = self.handle.transcribe(
            wav_path,
            language=self._lang(options),
            task=options.get('task') or 'transcribe',
            word_timestamps=True,
            vad_filter=bool(options.get('vad', True)),
            beam_size=int(options.get('beam_size', 5)),
            condition_on_previous_text=False,
        )

        total = float(getattr(info, 'duration', 0) or 0)
        segments, words = [], []
        for seg in segments_iter:
            seg_words = []
            for w in (getattr(seg, 'words', None) or []):
                item = {'word': w.word, 'start': float(w.start), 'end': float(w.end),
                        'probability': float(getattr(w, 'probability', 1.0) or 1.0)}
                seg_words.append(item)
                words.append(item)
            segments.append({'start': float(seg.start), 'end': float(seg.end),
                             'text': seg.text.strip(), 'words': seg_words})
            if progress_cb and total > 0:
                progress_cb(min(0.95, float(seg.end) / total), 'Transcribing…')

        return {'segments': segments, 'words': words,
                'language': getattr(info, 'language', None),
                'text': ' '.join(s['text'] for s in segments)}


ENGINE_CLASSES = {
    registry.ENGINE_MLX_WHISPER: MlxWhisperEngine,
    registry.ENGINE_MLX_PARAKEET: ParakeetMlxEngine,
    registry.ENGINE_MLX_QWEN3: Qwen3AsrMlxEngine,
    registry.ENGINE_TRANSFORMERS: TransformersEngine,
    registry.ENGINE_FASTER_WHISPER: FasterWhisperEngine,
}


def build_engine(model_desc, options=None):
    cls = ENGINE_CLASSES.get(model_desc['engine'])
    if not cls:
        raise EngineError(f"Unknown engine '{model_desc['engine']}'.")
    return cls(model_desc, options)


# ---------------------------------------------------------------------------
# Forced alignment
# ---------------------------------------------------------------------------

class ForcedAligner:
    """
    Attaches precise per-word times to an existing transcript using CTC forced
    alignment.

    This is what makes the accuracy-tier models usable for subtitling: they
    recognise the words well but report no timings, and Whisper's own timings
    are inferred from cross-attention and drift by a hundred milliseconds or
    more. Alignment is a separate, cheap pass that pins each word to the audio.
    """

    def __init__(self, repo=None):
        self.repo = repo or registry.ALIGNER_MODEL['repo']
        self.bundle = None

    def available(self):
        try:
            import torch, torchaudio  # noqa: F401
            return True
        except Exception:
            return False

    def align(self, wav_path, text, language=None, progress_cb=None):
        """
        @returns list of {word, start, end} or None when alignment is unavailable.
        Never raises — a failure here must not lose an otherwise good transcript.
        """
        words = [w for w in re.split(r'\s+', (text or '').strip()) if w]
        if not words:
            return []

        try:
            import torch
            import torchaudio
            from torchaudio.pipelines import MMS_FA as bundle
        except Exception:
            return None

        try:
            if progress_cb:
                progress_cb(0.9, 'Aligning word timings…')

            waveform, sample_rate = torchaudio.load(wav_path)
            if waveform.shape[0] > 1:
                waveform = waveform.mean(dim=0, keepdim=True)
            if sample_rate != bundle.sample_rate:
                waveform = torchaudio.functional.resample(waveform, sample_rate, bundle.sample_rate)

            device = 'cpu'
            if getattr(torch.backends, 'mps', None) and torch.backends.mps.is_available():
                device = 'mps'
            elif torch.cuda.is_available():
                device = 'cuda'

            model = bundle.get_model().to(device)
            tokenizer = bundle.get_tokenizer()
            aligner = bundle.get_aligner()

            with torch.inference_mode():
                emission, _ = model(waveform.to(device))
                token_spans = aligner(emission[0], tokenizer(self._normalise(words)))

            ratio = waveform.shape[1] / emission.shape[1] / bundle.sample_rate
            out = []
            for word, spans in zip(words, token_spans):
                if not spans:
                    continue
                out.append({
                    'word': word,
                    'start': float(ratio * spans[0].start),
                    'end': float(ratio * spans[-1].end),
                    'probability': float(sum(s.score for s in spans) / len(spans)),
                })
            return out
        except Exception:
            # Alignment is an enhancement; the transcript still stands without it.
            return None

    @staticmethod
    def _normalise(words):
        """MMS_FA expects lowercase tokens without punctuation."""
        out = []
        for w in words:
            cleaned = re.sub(r"[^\w'’]", '', w.lower())
            out.append(cleaned or w.lower())
        return out
