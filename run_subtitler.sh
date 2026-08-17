#!/bin/bash
# Launcher for Taylor's Transcriber.
#
# There is nothing to install first. On the first run the app creates its own
# virtual environment (in your application-support directory, not next to the
# project — macOS will not load native libraries from external volumes) and
# installs what it needs there, never into your system Python. Later runs skip
# straight to launching.
#
# Pass --browser to skip the native window and use your default browser.
set -e
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR"

# Prefer a venv that already exists; otherwise find any usable Python 3.9+ and
# let app.py bootstrap the venv itself.
if [ -x ".venv/bin/python" ]; then
  exec .venv/bin/python app.py "$@"
fi

for PY in python3.13 python3.12 python3.11 python3.10 python3.9 python3 python; do
  if command -v "$PY" >/dev/null 2>&1; then
    if "$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null; then
      exec "$PY" app.py "$@"
    fi
  fi
done

echo "Python 3.9 or newer was not found on this system."
echo
echo "  macOS          brew install python@3.12"
echo "  Debian/Ubuntu  sudo apt install python3 python3-venv"
echo "  Windows        https://www.python.org/downloads/"
exit 1
