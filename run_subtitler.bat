@echo off
REM Launcher for Taylor's Transcriber on Windows.
REM
REM Nothing needs installing first. The first run creates a private virtual
REM environment in .venv inside this folder; later runs launch straight away.
setlocal
cd /d "%~dp0"

if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" app.py %*
  goto :eof
)

where py >nul 2>nul
if %errorlevel%==0 (
  py -3 app.py %*
  goto :eof
)

where python >nul 2>nul
if %errorlevel%==0 (
  python app.py %*
  goto :eof
)

echo Python 3.9 or newer was not found.
echo Install it from https://www.python.org/downloads/ and run this again.
pause
