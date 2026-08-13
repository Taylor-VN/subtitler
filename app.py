import os
import sys
import socket
import threading
import http.server
import socketserver
import webview

def find_available_port(default_port=8000):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        if s.connect_ex(('127.0.0.1', default_port)) != 0:
            return default_port
    # If default port is in use, request open port from OS
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]

DIRECTORY = os.path.dirname(os.path.abspath(__file__))

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

if __name__ == '__main__':
    port = find_available_port(8000)
    
    # Start background local server for static files
    server_thread = threading.Thread(target=run_server, args=(port,), daemon=True)
    server_thread.start()

    print(f"Launching Standalone Desktop Window for Subtitler Pro on port {port}...")
    
    # Launch Native PyWebView Standalone Desktop Window
    webview.create_window(
        title='Subtitler Pro — Premiere Captions Editor',
        url=f'http://127.0.0.1:{port}',
        width=1400,
        height=900,
        resizable=True,
        min_size=(1024, 700),
        background_color='#121212'
    )
    webview.start()
