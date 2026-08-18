"""
Transcription model registry.

Each entry records not just "how accurate", but the three things that actually
decide whether a model is usable in a subtitling tool:

  * `engine`        — which runtime loads it. On Apple Silicon this matters more
                      than the model choice: CTranslate2 (faster-whisper) has no
                      Metal backend, so it runs on CPU cores only and leaves the
                      GPU idle. The MLX engines use the GPU.
  * `word_timings`  — whether the model itself reports per-word times.
                      The strongest current models are LLM-backbone designs that
                      emit text without reliable timings, so they need the
                      forced aligner to be usable for captions at all.
  * `languages`     — 'multilingual' or an explicit list. An English-only model
                      paired with a non-English language silently returns
                      nonsense, so the UI must not offer that combination.

WER figures are the reported English averages from the Hugging Face Open ASR
Leaderboard at the time of writing. The top of that leaderboard moves monthly
and is separated by well under one WER point, so treat them as a rough tier
guide rather than a ranking to optimise against. Entries where no figure is
recorded are left as None rather than guessed.
"""

import os
import platform
import shutil

# Engine identifiers
ENGINE_MLX_WHISPER = 'mlx-whisper'
ENGINE_MLX_PARAKEET = 'parakeet-mlx'
ENGINE_MLX_QWEN3 = 'mlx-qwen3-asr'
ENGINE_TRANSFORMERS = 'transformers'
ENGINE_GRANITE_SPEECH = 'granite-speech'
ENGINE_FASTER_WHISPER = 'faster-whisper'

ENGINE_LABELS = {
    ENGINE_MLX_WHISPER: 'MLX (Apple GPU)',
    ENGINE_MLX_PARAKEET: 'MLX (Apple GPU)',
    ENGINE_MLX_QWEN3: 'MLX (Apple GPU)',
    ENGINE_TRANSFORMERS: 'Transformers (MPS/CUDA/CPU)',
    ENGINE_GRANITE_SPEECH: 'Transformers (MPS/CUDA/CPU)',
    ENGINE_FASTER_WHISPER: 'faster-whisper (CPU on Mac)',
}

ENGINE_PACKAGES = {
    ENGINE_MLX_WHISPER: 'mlx-whisper',
    ENGINE_MLX_PARAKEET: 'parakeet-mlx',
    ENGINE_MLX_QWEN3: 'mlx-qwen3-asr',
    ENGINE_TRANSFORMERS: 'transformers',
    ENGINE_GRANITE_SPEECH: 'transformers',
    ENGINE_FASTER_WHISPER: 'faster-whisper',
}


def _m(**kw):
    base = {
        'id': None,
        'repo': None,
        'label': '',
        'engine': ENGINE_FASTER_WHISPER,
        'size_gb': None,
        'languages': 'multilingual',
        'english_only': False,
        'wer': None,               # reported Open ASR Leaderboard English avg
        'word_timings': False,     # does the model itself give per-word times
        'needs_alignment': True,   # run the forced aligner for caption timing
        'notes': '',
        'tier': 'balanced',        # accuracy | balanced | fast
    }
    base.update(kw)
    return base


MODELS = {
    # ---------------------------------------------------------------- accuracy
    'qwen3-asr-1.7b': _m(
        id='qwen3-asr-1.7b',
        repo='mlx-community/Qwen3-ASR-1.7B',
        label='Qwen3-ASR 1.7B',
        engine=ENGINE_MLX_QWEN3,
        size_gb=3.6,
        languages='multilingual',
        wer=None,
        word_timings=False,
        needs_alignment=True,
        tier='accuracy',
        notes=('State of the art among open ASR models and competitive with the '
               'strongest commercial APIs. Clearly ahead on Mandarin, and the '
               'strongest option for noisy or accented speech. LLM-backbone, so '
               'it emits no usable word timings — the forced aligner supplies them.'),
    ),
    'cohere-transcribe-2b': _m(
        id='cohere-transcribe-2b',
        repo='CohereLabs/cohere-transcribe-03-2026',
        label='Cohere Transcribe 2B',
        engine=ENGINE_TRANSFORMERS,
        size_gb=4.2,
        languages='multilingual',
        wer=5.42,
        word_timings=False,
        needs_alignment=True,
        tier='accuracy',
        notes=('Apache 2.0. Topped the Open ASR Leaderboard for English on '
               'release and is comparable or better than other open models '
               'across 13 further languages. No word timings of its own.'),
    ),
    'granite-speech-4.1-2b': _m(
        id='granite-speech-4.1-2b',
        repo='ibm-granite/granite-speech-4.1-2b',
        label='IBM Granite Speech 4.1 2B',
        engine=ENGINE_GRANITE_SPEECH,
        size_gb=4.4,
        languages='multilingual',
        wer=5.33,
        word_timings=False,
        needs_alignment=True,
        tier='accuracy',
        notes=('Lowest reported English WER of the models listed here. '
               'LLM-backbone: accurate but slower per audio-hour, and it needs '
               'the forced aligner for caption timing.'),
    ),

    # ------------------------------------------------------- English specialist
    'parakeet-tdt-0.6b-v2': _m(
        id='parakeet-tdt-0.6b-v2',
        repo='mlx-community/parakeet-tdt-0.6b-v2',
        label='NVIDIA Parakeet TDT 0.6B v2',
        engine=ENGINE_MLX_PARAKEET,
        size_gb=1.3,
        languages=['en'],
        english_only=True,
        word_timings=True,
        needs_alignment=False,
        tier='accuracy',
        notes=('Very strong on English and by far the fastest of the accurate '
               'options on Apple Silicon — it runs on the GPU through MLX and '
               'reports its own token timings. English only.'),
    ),

    # ------------------------------------------------------------ whisper family
    'whisper-large-v3': _m(
        id='whisper-large-v3',
        repo='mlx-community/whisper-large-v3-mlx',
        label='Whisper large-v3',
        engine=ENGINE_MLX_WHISPER,
        size_gb=3.1,
        languages='multilingual',
        word_timings=True,
        needs_alignment=False,
        tier='balanced',
        notes=('The long-standing multilingual baseline. Now well behind the '
               'accuracy tier above, but it reports word timings natively and '
               'handles 99 languages.'),
    ),
    'whisper-large-v3-turbo': _m(
        id='whisper-large-v3-turbo',
        repo='mlx-community/whisper-large-v3-turbo',
        label='Whisper large-v3-turbo',
        engine=ENGINE_MLX_WHISPER,
        size_gb=1.6,
        languages='multilingual',
        word_timings=True,
        needs_alignment=False,
        tier='balanced',
        notes=('Distilled decoder: close to large-v3 quality for transcription '
               'at roughly 8x the speed. Weaker at the translate task. A good '
               'default when you want multilingual output quickly.'),
    ),
    'whisper-medium': _m(
        id='whisper-medium', repo='mlx-community/whisper-medium-mlx',
        label='Whisper medium', engine=ENGINE_MLX_WHISPER, size_gb=1.5,
        word_timings=True, needs_alignment=False, tier='balanced',
        notes='Mid-size multilingual Whisper.',
    ),
    'whisper-small': _m(
        id='whisper-small', repo='mlx-community/whisper-small-mlx',
        label='Whisper small', engine=ENGINE_MLX_WHISPER, size_gb=0.5,
        word_timings=True, needs_alignment=False, tier='fast',
        notes='Small multilingual Whisper. Quick, noticeably less accurate.',
    ),
    'whisper-tiny': _m(
        id='whisper-tiny', repo='mlx-community/whisper-tiny-mlx',
        label='Whisper tiny', engine=ENGINE_MLX_WHISPER, size_gb=0.08,
        word_timings=True, needs_alignment=False, tier='fast',
        notes='Fastest, lowest accuracy. Useful for a rough first pass.',
    ),
    'distil-large-v3': _m(
        id='distil-large-v3',
        repo='distil-whisper/distil-large-v3',
        label='Distil-Whisper large-v3',
        engine=ENGINE_TRANSFORMERS,
        size_gb=1.5,
        languages=['en'],
        english_only=True,
        word_timings=True,
        needs_alignment=False,
        tier='fast',
        notes='English only. Fast, but Parakeet is both faster and more accurate on Apple Silicon.',
    ),
}

# The forced aligner. Multilingual CTC alignment covering 1000+ languages, used
# to attach precise word times to any transcript, whatever produced it.
ALIGNER_MODEL = {
    'id': 'mms-fa-aligner',
    'repo': 'MahmoudAshraf/mms-300m-1130-forced-aligner',
    'label': 'MMS Forced Aligner (word timing)',
    'size_gb': 1.2,
    'notes': ('Supplies precise per-word start/end times for models that do not '
              'report their own, and tightens the approximate timings that '
              "Whisper derives from cross-attention. Recommended for captions."),
}

# Speaker separation. ECAPA-TDNN turns a passage of speech into a vector that
# describes the voice rather than the words, which is what lets the same person
# be recognised across a whole timeline. Small, and ungated — unlike pyannote's
# diarisation weights, which need a licence acceptance and an access token.
DIARIZER_MODEL = {
    'id': 'ecapa-speaker-embeddings',
    'repo': 'speechbrain/spkrec-ecapa-voxceleb',
    'label': 'ECAPA Speaker Embeddings (speaker separation)',
    'size_gb': 0.08,
    'notes': ('Identifies who is speaking, so captions break at every change of '
              'voice and never put two people on one line. Needs word timings, '
              'so it pairs with the aligner.'),
}

# Models that are not transcription engines but still install and remove like
# one from the Settings panel.
EXTRA_MODELS = {m['id']: m for m in (ALIGNER_MODEL, DIARIZER_MODEL)}


def is_apple_silicon():
    return platform.system() == 'Darwin' and platform.machine() in ('arm64', 'aarch64')


def has_nvidia():
    try:
        import torch
        return bool(torch.cuda.is_available())
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Optional runtimes, installable into the app's own venv from Settings
# ---------------------------------------------------------------------------
#
# Each entry is a pip-installable runtime plus the module that proves it landed.
# `platforms` restricts what is offered: the MLX runtimes only exist for Apple
# Silicon, so showing them elsewhere would just produce install failures.

RUNTIMES = {
    ENGINE_MLX_WHISPER: {
        'id': ENGINE_MLX_WHISPER,
        'label': 'MLX Whisper (Apple GPU)',
        'packages': ['mlx-whisper>=0.4.0'],
        'module': 'mlx_whisper',
        'platforms': ['darwin-arm64'],
        'size_mb': 90,
        'notes': 'Runs the Whisper family on the Apple GPU instead of the CPU.',
    },
    ENGINE_MLX_PARAKEET: {
        'id': ENGINE_MLX_PARAKEET,
        'label': 'Parakeet MLX (Apple GPU)',
        'packages': ['parakeet-mlx>=0.3.0'],
        'module': 'parakeet_mlx',
        'platforms': ['darwin-arm64'],
        'size_mb': 90,
        'notes': 'Fastest accurate English option on Apple Silicon.',
    },
    ENGINE_MLX_QWEN3: {
        'id': ENGINE_MLX_QWEN3,
        'label': 'Qwen3-ASR MLX (Apple GPU)',
        'packages': ['mlx-qwen3-asr>=0.1.0'],
        'module': 'mlx_qwen3_asr',
        'platforms': ['darwin-arm64'],
        'size_mb': 90,
        'notes': 'Strongest multilingual accuracy, on the Apple GPU.',
    },
    ENGINE_TRANSFORMERS: {
        'id': ENGINE_TRANSFORMERS,
        'label': 'Transformers + PyTorch',
        'packages': ['transformers>=4.40.0', 'torch>=2.2.0', 'torchaudio>=2.2.0'],
        'module': 'transformers',
        'platforms': ['any'],
        'size_mb': 2500,
        'notes': ('Needed for Cohere Transcribe, and it also provides the '
                  'word-timing aligner. Large download.'),
    },
    ENGINE_GRANITE_SPEECH: {
        'id': ENGINE_GRANITE_SPEECH,
        'label': 'Transformers + PyTorch (Granite Speech)',
        'packages': ['transformers>=4.52.1', 'torch>=2.2.0', 'torchaudio>=2.2.0'],
        'module': 'transformers',
        'platforms': ['any'],
        'size_mb': 2500,
        'notes': ('Same underlying packages as Transformers + PyTorch, pinned to '
                  'a newer transformers release — Granite Speech\'s processor '
                  'classes only exist from 4.52.1 onward. Already satisfied if '
                  'that runtime is installed and current.'),
    },
    ENGINE_FASTER_WHISPER: {
        'id': ENGINE_FASTER_WHISPER,
        'label': 'faster-whisper (CTranslate2)',
        'packages': ['faster-whisper>=1.0.0'],
        'module': 'faster_whisper',
        'platforms': ['any'],
        'size_mb': 150,
        'notes': ('For NVIDIA GPUs and generic CPU. No Metal backend, so on '
                  'Apple Silicon this stays on the CPU.'),
    },
    'demucs': {
        'id': 'demucs',
        'label': 'Demucs (music suppression)',
        'packages': ['demucs>=4.0.0', 'torch>=2.2.0', 'torchaudio>=2.2.0'],
        'module': 'demucs',
        'platforms': ['any'],
        'size_mb': 2400,
        'notes': ('Isolates the dialogue from a music bed before transcribing. The '
                  'single biggest accuracy gain on advertising and promo material, '
                  'at the cost of a slow extra pass.'),
    },
    'diarizer-speechbrain': {
        'id': 'diarizer-speechbrain',
        'label': 'SpeechBrain (speaker separation)',
        'packages': ['speechbrain>=1.0.0', 'torch>=2.2.0', 'torchaudio>=2.2.0'],
        'module': 'speechbrain',
        'platforms': ['any'],
        'size_mb': 2300,
        'notes': ('Works out who is speaking, so each caption holds one voice and '
                  'carries their name. Shares torch with the aligner, so on top of '
                  'that runtime it is a small extra download.'),
    },
    'aligner-torch': {
        'id': 'aligner-torch',
        'label': 'PyTorch + torchaudio (word-timing aligner)',
        'packages': ['torch>=2.2.0', 'torchaudio>=2.2.0'],
        'module': 'torchaudio',
        'platforms': ['any'],
        'size_mb': 2200,
        'notes': ('Powers the forced aligner, which measures per-word times '
                  'instead of inferring them. Strongly recommended for captions.'),
    },
}


def platform_tag():
    system = platform.system().lower()
    machine = platform.machine().lower()
    if system == 'darwin' and machine in ('arm64', 'aarch64'):
        return 'darwin-arm64'
    return f'{system}-{machine}'


def runtime_supported(runtime):
    plats = runtime.get('platforms') or ['any']
    return 'any' in plats or platform_tag() in plats


def module_available(module_name):
    try:
        __import__(module_name)
        return True
    except Exception:
        return False


def list_runtimes():
    """Installable runtimes for this machine, with live installed state."""
    out = []
    for rt in RUNTIMES.values():
        if not runtime_supported(rt):
            continue
        out.append(dict(rt,
                        installed=module_available(rt['module']),
                        recommended=rt['id'] in recommended_runtimes()))
    return out


def recommended_runtimes():
    """
    The set worth having on this machine.

    On Apple Silicon that means the GPU runtimes — faster-whisper would work but
    would leave the GPU idle — plus torch for the aligner, since without it the
    accuracy-tier models cannot produce caption timings at all.
    """
    if is_apple_silicon():
        return [ENGINE_MLX_WHISPER, ENGINE_MLX_PARAKEET, 'aligner-torch']
    return [ENGINE_FASTER_WHISPER, 'aligner-torch']


def get_runtime(runtime_id):
    return RUNTIMES.get(runtime_id)


def engine_available(engine):
    """Whether the runtime package for an engine is importable."""
    module = {
        ENGINE_MLX_WHISPER: 'mlx_whisper',
        ENGINE_MLX_PARAKEET: 'parakeet_mlx',
        ENGINE_MLX_QWEN3: 'mlx_qwen3_asr',
        ENGINE_TRANSFORMERS: 'transformers',
        ENGINE_GRANITE_SPEECH: 'transformers',
        ENGINE_FASTER_WHISPER: 'faster_whisper',
    }.get(engine)
    if not module:
        return False
    try:
        __import__(module)
        return True
    except Exception:
        return False


def hf_cache_dir():
    return os.environ.get('HF_HOME') or os.path.join(
        os.path.expanduser('~'), '.cache', 'huggingface')


def repo_cache_path(repo):
    """Where huggingface_hub would place this repo's snapshot."""
    if not repo:
        return None
    folder = 'models--' + repo.replace('/', '--')
    return os.path.join(hf_cache_dir(), 'hub', folder)


def is_installed(repo):
    path = repo_cache_path(repo)
    if not path or not os.path.isdir(path):
        return False
    snapshots = os.path.join(path, 'snapshots')
    if not os.path.isdir(snapshots):
        return False
    # A snapshot directory containing at least one real file means it landed.
    for root, _dirs, files in os.walk(snapshots):
        if files:
            return True
    return False


def dir_size_bytes(path):
    if not path or not os.path.isdir(path):
        return 0
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            fp = os.path.join(root, f)
            try:
                # follow_symlinks=False: the blob is counted once, not per link
                total += os.stat(fp, follow_symlinks=False).st_size
            except OSError:
                pass
    return total


def describe(model):
    """Registry entry plus live install state."""
    out = dict(model)
    out['installed'] = is_installed(model['repo'])
    out['engine_label'] = ENGINE_LABELS.get(model['engine'], model['engine'])
    out['engine_package'] = ENGINE_PACKAGES.get(model['engine'], model['engine'])
    out['engine_available'] = engine_available(model['engine'])
    out['disk_bytes'] = dir_size_bytes(repo_cache_path(model['repo'])) if out['installed'] else 0
    return out


def list_models():
    return [describe(m) for m in MODELS.values()]


def get(model_id):
    return MODELS.get(model_id)


def recommended(purpose='accuracy'):
    """
    Platform-aware suggestion.

    On Apple Silicon the MLX engines run on the GPU while faster-whisper is
    stuck on CPU, so the recommendation differs from a CUDA box.
    """
    if purpose == 'fast':
        return 'parakeet-tdt-0.6b-v2' if is_apple_silicon() else 'whisper-large-v3-turbo'
    if purpose == 'multilingual':
        return 'qwen3-asr-1.7b'
    if purpose == 'english':
        return 'parakeet-tdt-0.6b-v2'
    return 'qwen3-asr-1.7b'


def free_disk_bytes():
    try:
        return shutil.disk_usage(hf_cache_dir() if os.path.isdir(hf_cache_dir())
                                 else os.path.expanduser('~')).free
    except Exception:
        return 0
