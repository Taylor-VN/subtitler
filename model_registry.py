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
ENGINE_FASTER_WHISPER = 'faster-whisper'

ENGINE_LABELS = {
    ENGINE_MLX_WHISPER: 'MLX (Apple GPU)',
    ENGINE_MLX_PARAKEET: 'MLX (Apple GPU)',
    ENGINE_MLX_QWEN3: 'MLX (Apple GPU)',
    ENGINE_TRANSFORMERS: 'Transformers (MPS/CUDA/CPU)',
    ENGINE_FASTER_WHISPER: 'faster-whisper (CPU on Mac)',
}

ENGINE_PACKAGES = {
    ENGINE_MLX_WHISPER: 'mlx-whisper',
    ENGINE_MLX_PARAKEET: 'parakeet-mlx',
    ENGINE_MLX_QWEN3: 'mlx-qwen3-asr',
    ENGINE_TRANSFORMERS: 'transformers',
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
        engine=ENGINE_TRANSFORMERS,
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
    'repo': 'facebook/mms-300m-1130-forced-aligner',
    'label': 'MMS Forced Aligner (word timing)',
    'size_gb': 1.2,
    'notes': ('Supplies precise per-word start/end times for models that do not '
              'report their own, and tightens the approximate timings that '
              "Whisper derives from cross-attention. Recommended for captions."),
}


def is_apple_silicon():
    return platform.system() == 'Darwin' and platform.machine() in ('arm64', 'aarch64')


def engine_available(engine):
    """Whether the runtime package for an engine is importable."""
    module = {
        ENGINE_MLX_WHISPER: 'mlx_whisper',
        ENGINE_MLX_PARAKEET: 'parakeet_mlx',
        ENGINE_MLX_QWEN3: 'mlx_qwen3_asr',
        ENGINE_TRANSFORMERS: 'transformers',
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
