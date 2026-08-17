"""
Environment bootstrap.

The app owns its own virtual environment at `.venv` inside the project folder.
On launch it creates that venv if missing, installs the base dependencies into
it, and re-executes itself with the venv's interpreter. Nothing is ever
installed into the user's system Python.

Why this exists rather than a README line telling people to run pip:

  * On macOS with Homebrew Python (and on Debian/Ubuntu), `pip install` against
    the system interpreter is refused outright under PEP 668
    ("externally-managed-environment"), so the documented setup step simply
    failed for a lot of people.
  * Installing an app's dependencies globally pollutes every other Python
    project on the machine.
  * Owning the venv also means the app can install its own *optional* runtimes
    later from the Settings panel, so nobody needs a terminal at all.

This module deliberately uses only the standard library — it has to run before
anything is installed.
"""

import hashlib
import os
import platform
import subprocess
import sys
import venv

PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
VENV_DIR = os.path.join(PROJECT_DIR, '.venv')
STAMP_FILE = os.path.join(VENV_DIR, '.deps-stamp')
GUARD_ENV = 'TRANSCRIBER_BOOTSTRAPPED'

MIN_PYTHON = (3, 9)

# Kept small on purpose: this is what must be present for the window to open at
# all. Everything heavier (speech runtimes, torch) is optional and installed on
# demand from Settings.
BASE_REQUIREMENTS = [
    'pywebview>=4.4',
    'huggingface-hub>=0.23.0',
]


def venv_python(venv_dir=VENV_DIR):
    if os.name == 'nt':
        return os.path.join(venv_dir, 'Scripts', 'python.exe')
    return os.path.join(venv_dir, 'bin', 'python')


def in_project_venv():
    """
    True when the running interpreter is the project's own venv Python.

    This compares sys.prefix, not sys.executable. A venv created with symlinks
    has .venv/bin/python pointing straight at the system interpreter, so
    os.path.samefile() on the executables follows the link and reports a match
    from *outside* the venv too — which would stop the re-exec from ever
    happening and leave every installed dependency invisible. sys.prefix is the
    venv root when running inside it and the base prefix otherwise, so it
    answers the question being asked.
    """
    try:
        return os.path.samefile(sys.prefix, VENV_DIR)
    except OSError:
        return os.path.normcase(os.path.abspath(sys.prefix)) == \
               os.path.normcase(os.path.abspath(VENV_DIR))


def requirements_stamp():
    """Hash of what we intend to install, so we only re-run pip when it changes."""
    h = hashlib.sha256()
    h.update(('\n'.join(BASE_REQUIREMENTS)).encode())
    h.update(platform.python_version().encode())
    return h.hexdigest()


def stamp_is_current():
    try:
        with open(STAMP_FILE, encoding='utf-8') as fh:
            return fh.read().strip() == requirements_stamp()
    except OSError:
        return False


def write_stamp():
    try:
        with open(STAMP_FILE, 'w', encoding='utf-8') as fh:
            fh.write(requirements_stamp())
    except OSError:
        pass


def _log(msg):
    print(f'[setup] {msg}', flush=True)


def create_venv():
    _log(f'Creating a virtual environment at {VENV_DIR}')
    # with_pip=True gives us pip inside the venv without needing ensurepip
    # separately; symlinks keep it small on Unix.
    builder = venv.EnvBuilder(with_pip=True, symlinks=(os.name != 'nt'), upgrade=False)
    builder.create(VENV_DIR)


def pip_install(args, python=None, quiet=True):
    python = python or venv_python()
    cmd = [python, '-m', 'pip', 'install', '--disable-pip-version-check']
    if quiet:
        cmd.append('-q')
    cmd += list(args)
    return subprocess.run(cmd, cwd=PROJECT_DIR)


def install_base_requirements():
    _log('Installing base dependencies (one-time, ~20 MB)…')
    # Upgrading pip first avoids a class of resolver and wheel-format failures
    # on the pip that ships inside older venvs.
    subprocess.run([venv_python(), '-m', 'pip', 'install', '-q', '--upgrade',
                    'pip', 'setuptools', 'wheel'], cwd=PROJECT_DIR)
    result = pip_install(BASE_REQUIREMENTS)
    if result.returncode != 0:
        _log('Base dependency install failed. See the pip output above.')
        return False
    write_stamp()
    _log('Base dependencies ready.')
    return True


def ensure_environment(argv=None):
    """
    Guarantee we are running inside the project venv with base deps present.

    Re-executes the process with the venv interpreter when needed, so callers
    should treat a return from this function as "we are good to continue".
    """
    if sys.version_info < MIN_PYTHON:
        sys.exit(f'Python {MIN_PYTHON[0]}.{MIN_PYTHON[1]} or newer is required '
                 f'(this is {platform.python_version()}).')

    # Already re-executed once — never loop, whatever the state.
    if os.environ.get(GUARD_ENV) == '1':
        return

    if in_project_venv():
        if not stamp_is_current():
            install_base_requirements()
        os.environ[GUARD_ENV] = '1'
        return

    if not os.path.isfile(venv_python()):
        try:
            create_venv()
        except Exception as e:
            sys.exit(f'Could not create the virtual environment at {VENV_DIR}:\n  {e}\n\n'
                     'If your Python lacks the venv module, install it '
                     '(e.g. "sudo apt install python3-venv") and try again.')

    if not stamp_is_current():
        if not install_base_requirements():
            sys.exit('Setup could not complete. See the pip output above.')

    # Hand over to the venv interpreter.
    env = dict(os.environ)
    env[GUARD_ENV] = '1'
    script = os.path.abspath(sys.argv[0])
    args = [venv_python(), script] + (argv if argv is not None else sys.argv[1:])
    _log('Starting in the project environment…')

    if os.name == 'nt':
        # Windows has no exec that replaces the process cleanly for GUI apps.
        sys.exit(subprocess.run(args, env=env, cwd=PROJECT_DIR).returncode)
    os.execve(args[0], args, env)


# ---------------------------------------------------------------------------
# Optional runtime installation (called from the Settings panel)
# ---------------------------------------------------------------------------

def can_install_runtimes():
    """
    Only ever install into our own venv. If the app is somehow running against
    a different interpreter, refuse rather than touching it.
    """
    return in_project_venv() or os.environ.get(GUARD_ENV) == '1'


def install_packages_streaming(packages, on_line=None):
    """
    pip install with output streamed line by line so the UI can show progress.
    @returns (ok, last_lines)
    """
    if not can_install_runtimes():
        return False, ['Refusing to install: not running inside the project '
                       'virtual environment.']

    cmd = [sys.executable, '-m', 'pip', 'install', '--disable-pip-version-check',
           '--progress-bar', 'off'] + list(packages)

    tail = []
    proc = subprocess.Popen(cmd, cwd=PROJECT_DIR, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, bufsize=1)
    for line in proc.stdout:
        line = line.rstrip()
        if not line:
            continue
        tail.append(line)
        del tail[:-40]
        if on_line:
            on_line(line)
    proc.wait()
    return proc.returncode == 0, tail
