import os
import sys
import base64
import shutil
import socket
import subprocess
import tempfile
import threading
import http.server
import socketserver
import uuid

from transcriber import Transcriber

try:
    import webview
except ImportError:  # pragma: no cover - only hit when pywebview is missing
    webview = None


DIRECTORY = os.path.dirname(os.path.abspath(__file__))


def find_available_port(default_port=8000):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        if s.connect_ex(('127.0.0.1', default_port)) != 0:
            return default_port
    # If default port is in use, request open port from OS
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def find_ffmpeg():
    """Locate an ffmpeg binary, including the usual GUI-app-blind spots."""
    found = shutil.which('ffmpeg')
    if found:
        return found
    for candidate in (
        '/opt/homebrew/bin/ffmpeg',
        '/usr/local/bin/ffmpeg',
        '/usr/bin/ffmpeg',
        '/snap/bin/ffmpeg',
        os.path.join(DIRECTORY, 'bin', 'ffmpeg'),
        r'C:\ffmpeg\bin\ffmpeg.exe',
    ):
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


class CustomHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def log_message(self, format, *args):
        pass


def run_server(port):
    socketserver.TCPServer.allow_reuse_address = True
    try:
        with socketserver.TCPServer(("127.0.0.1", port), CustomHTTPRequestHandler) as httpd:
            httpd.serve_forever()
    except Exception as e:
        print(f"Server notice: {e}")


class ExportApi:
    """
    Bridge exposed to the page as window.pywebview.api.

    The front-end renders each caption frame to a transparent PNG and streams it
    here; we drop the frames on disk and let ffmpeg mux them into a ProRes 4444
    QuickTime file that carries a genuine alpha channel.
    """

    def __init__(self):
        self.jobs = {}
        self._lock = threading.Lock()
        self.transcriber = Transcriber()

    # --- capability probe -------------------------------------------------
    def get_capabilities(self):
        ffmpeg = find_ffmpeg()
        return {
            'ok': True,
            'native': True,
            'ffmpeg': bool(ffmpeg),
            'ffmpeg_path': ffmpeg or '',
        }

    # --- AI transcription (see transcriber.py) ----------------------------
    def transcribe_probe(self):
        return self.transcriber.probe()

    def transcribe_begin(self, options):
        return self.transcriber.begin(options)

    def transcribe_push_audio(self, job_id, b64_chunk):
        return self.transcriber.push_audio(job_id, b64_chunk)

    def transcribe_finish_audio(self, job_id):
        return self.transcriber.finish_audio_and_run(job_id)

    def transcribe_status(self, job_id):
        return self.transcriber.status(job_id)

    def transcribe_cancel(self, job_id):
        return self.transcriber.cancel(job_id)

    def transcribe_cleanup(self, job_id):
        return self.transcriber.cleanup(job_id)

    # --- export lifecycle -------------------------------------------------
    def begin_export(self, meta):
        try:
            if not find_ffmpeg():
                return {
                    'ok': False,
                    'error': 'ffmpeg was not found on this system. Install ffmpeg '
                             '(e.g. "brew install ffmpeg") and relaunch, or use the '
                             'PNG sequence export instead.'
                }
            job_id = uuid.uuid4().hex
            frames_dir = tempfile.mkdtemp(prefix=f'subtitler_{job_id}_')
            with self._lock:
                self.jobs[job_id] = {
                    'dir': frames_dir,
                    'meta': meta or {},
                    'last_frame': None,
                }
            return {'ok': True, 'job_id': job_id}
        except Exception as e:
            return {'ok': False, 'error': str(e)}

    def write_frame(self, job_id, index, b64_png):
        try:
            job = self.jobs.get(job_id)
            if not job:
                return {'ok': False, 'error': 'Unknown export job.'}
            path = os.path.join(job['dir'], f'frame_{index:06d}.png')
            with open(path, 'wb') as fh:
                fh.write(base64.b64decode(b64_png))
            job['last_frame'] = path
            return {'ok': True}
        except Exception as e:
            return {'ok': False, 'error': str(e)}

    def repeat_frame(self, job_id, index):
        """Duplicate the previous frame without re-sending its bytes over the bridge."""
        try:
            job = self.jobs.get(job_id)
            if not job:
                return {'ok': False, 'error': 'Unknown export job.'}
            last = job.get('last_frame')
            if not last or not os.path.exists(last):
                return {'ok': False, 'error': 'No previous frame to repeat.'}
            path = os.path.join(job['dir'], f'frame_{index:06d}.png')
            try:
                os.link(last, path)  # hard link: no extra disk, no copy cost
            except OSError:
                shutil.copyfile(last, path)
            return {'ok': True}
        except Exception as e:
            return {'ok': False, 'error': str(e)}

    def encode_prores(self, job_id, opts):
        try:
            job = self.jobs.get(job_id)
            if not job:
                return {'ok': False, 'error': 'Unknown export job.'}

            ffmpeg = find_ffmpeg()
            if not ffmpeg:
                return {'ok': False, 'error': 'ffmpeg was not found on this system.'}

            opts = opts or {}
            fps = opts.get('fps', 25)
            profile = int(opts.get('profile', 4))  # 4 = ProRes 4444, 5 = 4444 XQ
            filename = opts.get('filename') or 'subtitles_alpha.mov'
            if not filename.lower().endswith('.mov'):
                filename += '.mov'

            out_path = self._ask_save_path(filename)
            if not out_path:
                return {'ok': False, 'error': 'Export cancelled.'}

            cmd = [
                ffmpeg, '-y',
                '-framerate', str(fps),
                '-i', os.path.join(job['dir'], 'frame_%06d.png'),
                '-c:v', 'prores_ks',
                '-profile:v', str(profile),
                '-pix_fmt', 'yuva444p10le',
                '-alpha_bits', '16',
                '-vendor', 'apl0',
                '-r', str(fps),
                out_path,
            ]
            proc = subprocess.run(cmd, capture_output=True, text=True)
            if proc.returncode != 0:
                tail = (proc.stderr or '').strip().splitlines()[-6:]
                return {'ok': False, 'error': 'ffmpeg failed:\n' + '\n'.join(tail)}

            return {'ok': True, 'path': out_path}
        except Exception as e:
            return {'ok': False, 'error': str(e)}

    def cleanup_export(self, job_id):
        try:
            with self._lock:
                job = self.jobs.pop(job_id, None)
            if job and os.path.isdir(job['dir']):
                shutil.rmtree(job['dir'], ignore_errors=True)
            return {'ok': True}
        except Exception as e:
            return {'ok': False, 'error': str(e)}

    # --- generic file save (used by SRT/VTT/XML/preset exports too) --------
    def save_text_file(self, filename, content):
        try:
            out_path = self._ask_save_path(filename)
            if not out_path:
                return {'ok': False, 'error': 'Save cancelled.'}
            with open(out_path, 'w', encoding='utf-8') as fh:
                fh.write(content)
            return {'ok': True, 'path': out_path}
        except Exception as e:
            return {'ok': False, 'error': str(e)}

    def _ask_save_path(self, filename):
        if webview is None or not webview.windows:
            return os.path.join(os.path.expanduser('~'), filename)
        result = webview.windows[0].create_file_dialog(
            webview.SAVE_DIALOG,
            directory=os.path.expanduser('~'),
            save_filename=filename,
        )
        if not result:
            return None
        return result if isinstance(result, str) else result[0]


if __name__ == '__main__':
    if webview is None:
        sys.exit(
            "pywebview is not installed.\n"
            "Install it with:  pip install pywebview\n"
        )

    port = find_available_port(8000)

    # Start background local server for static files
    server_thread = threading.Thread(target=run_server, args=(port,), daemon=True)
    server_thread.start()

    print(f"Launching Standalone Desktop Window for Subtitler Pro on port {port}...")
    if find_ffmpeg():
        print(f"ffmpeg found at {find_ffmpeg()} — ProRes 4444 alpha export enabled.")
    else:
        print("ffmpeg NOT found — alpha export will fall back to a PNG sequence.")

    api = ExportApi()

    _probe = api.transcribe_probe()
    if _probe.get('available'):
        print(f"AI transcription ready via {', '.join(_probe['engines'])} on {_probe['device_name']}.")
    else:
        print("AI transcription unavailable — run 'pip install -r requirements.txt' to enable it.")

    # Launch Native PyWebView Standalone Desktop Window
    webview.create_window(
        title='Subtitler Pro — Premiere Captions Editor',
        url=f'http://127.0.0.1:{port}',
        js_api=api,
        width=1400,
        height=900,
        resizable=True,
        min_size=(1024, 700),
        background_color='#121212'
    )
    webview.start()
