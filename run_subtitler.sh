#!/bin/bash
# Standalone Desktop Application Launcher for Taylor's Transcriber
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR"
python3 app.py
