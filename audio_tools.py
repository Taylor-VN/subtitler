"""
Audio analysis and clean-up that runs before the model sees the waveform.

Two jobs here:

  * Voice activity. `vad_filter` only ever reached faster-whisper, so the option
    did nothing for the MLX engines — which are the ones worth using on Apple
    Silicon. The energy detector below works on the 16 kHz mono WAV the
    front-end already produces, so it applies to every engine equally, and its
    output is used to drop words that land in silence. Those are almost always
    hallucinations: models asked to transcribe a music bed or room tone will
    happily invent a line.

  * Music suppression. A dialogue track under a music bed is the single biggest
    accuracy problem on advertising and promo material. Where Demucs is
    installed, isolating the vocal stem first removes most of that. It is
    optional because it is a heavy dependency and a slow pass.

Only the standard library is used for VAD, so it works before any optional
runtime is installed.
"""

import array
import math
import os
import shutil
import subprocess
import sys
import tempfile
import wave

# Analysis window. 30 ms is long enough to be stable and short enough to catch
# the start of a word.
FRAME_MS = 30

# Speech is judged relative to the quietest part of this recording rather than
# an absolute level, because material arrives at wildly different levels.
NOISE_PERCENTILE = 0.20
SPEECH_OVER_NOISE_DB = 9.0
ABSOLUTE_FLOOR_DB = -55.0

# Padding either side of detected speech, so a detector edge never clips a word.
PAD_SEC = 0.25

# Gaps shorter than this are bridged; regions shorter than this are discarded.
MIN_GAP_SEC = 0.35
MIN_REGION_SEC = 0.12


def read_wav_mono(path):
    """Returns (samples as float -1..1, sample_rate). Expects 16-bit mono."""
    with wave.open(path, 'rb') as w:
        channels = w.getnchannels()
        width = w.getsampwidth()
        rate = w.getframerate()
        raw = w.readframes(w.getnframes())

    if width != 2:
        raise ValueError(f'expected 16-bit PCM, got {width * 8}-bit')

    data = array.array('h')
    data.frombytes(raw)

    if channels > 1:
        data = array.array('h', [
            int(sum(data[i:i + channels]) / channels)
            for i in range(0, len(data) - channels + 1, channels)
        ])

    scale = 1.0 / 32768.0
    return [s * scale for s in data], rate


def frame_levels(samples, rate, frame_ms=FRAME_MS):
    """RMS level per frame, in dBFS."""
    size = max(1, int(rate * frame_ms / 1000))
    levels = []
    for start in range(0, len(samples), size):
        chunk = samples[start:start + size]
        if not chunk:
            break
        total = 0.0
        for s in chunk:
            total += s * s
        rms = math.sqrt(total / len(chunk))
        levels.append(20 * math.log10(rms) if rms > 1e-9 else -120.0)
    return levels, size / rate


def speech_regions(path, frame_ms=FRAME_MS):
    """
    Detect speech as [(start, end), ...] in seconds.

    The threshold is set from this recording's own noise floor, so a quiet VO
    and a loud one are treated alike. Returns None when the audio cannot be
    analysed, which callers treat as "assume everything is speech" rather than
    discarding words on a guess.
    """
    try:
        samples, rate = read_wav_mono(path)
    except Exception:
        return None
    if not samples:
        return None

    levels, frame_sec = frame_levels(samples, rate, frame_ms)
    if not levels:
        return None

    ordered = sorted(levels)
    noise = ordered[min(len(ordered) - 1, int(len(ordered) * NOISE_PERCENTILE))]
    peak = ordered[-1]
    total_sec = len(levels) * frame_sec
    threshold = max(noise + SPEECH_OVER_NOISE_DB, ABSOLUTE_FLOOR_DB)

    # Nothing here rises above the floor, so it is room tone rather than quiet
    # speech. Report no speech so hallucinated lines can be dropped.
    if peak < ABSOLUTE_FLOOR_DB:
        return []

    # Loud but with no usable dynamic range to measure against — treat it all as
    # speech rather than cutting on an arbitrary threshold. Note this is checked
    # only after the silence case above, or uniform room tone would land here.
    if peak - noise < SPEECH_OVER_NOISE_DB:
        return [(0.0, total_sec)]

    regions = []
    start = None
    for i, level in enumerate(levels):
        if level >= threshold:
            if start is None:
                start = i
        elif start is not None:
            regions.append((start * frame_sec, i * frame_sec))
            start = None
    if start is not None:
        regions.append((start * frame_sec, len(levels) * frame_sec))

    return _tidy_regions(regions, total_sec)


def _tidy_regions(regions, total):
    """Bridge short gaps, drop specks, pad the edges."""
    if not regions:
        return []

    merged = [list(regions[0])]
    for start, end in regions[1:]:
        if start - merged[-1][1] <= MIN_GAP_SEC:
            merged[-1][1] = end
        else:
            merged.append([start, end])

    out = []
    for start, end in merged:
        if end - start < MIN_REGION_SEC:
            continue
        out.append((max(0.0, start - PAD_SEC), min(total, end + PAD_SEC)))

    # Padding can make neighbours touch; fold those together.
    tidy = []
    for region in out:
        if tidy and region[0] <= tidy[-1][1]:
            tidy[-1] = (tidy[-1][0], max(tidy[-1][1], region[1]))
        else:
            tidy.append(region)
    return tidy


def in_speech(regions, start, end):
    """Does [start, end] intersect any detected speech region?"""
    if regions is None:
        return True
    for r_start, r_end in regions:
        if end >= r_start and start <= r_end:
            return True
    return False


def drop_words_in_silence(words, regions):
    """
    Remove words that fall entirely outside detected speech.

    @returns (kept, dropped_count)
    """
    if regions is None or not words:
        return list(words), 0
    kept = [w for w in words
            if in_speech(regions, float(w.get('start', 0)), float(w.get('end', 0)))]
    return kept, len(words) - len(kept)


def speech_seconds(regions):
    if not regions:
        return 0.0
    return sum(end - start for start, end in regions)


# ---------------------------------------------------------------------------
# Music suppression
# ---------------------------------------------------------------------------

def demucs_available():
    try:
        import demucs  # noqa: F401
        return True
    except Exception:
        return False


def isolate_vocals(wav_path, progress_cb=None, model='htdemucs'):
    """
    Run Demucs and return the path to the vocal stem, or None on any failure.

    Invoked as a subprocess rather than through the Python API because the API
    has moved between releases while the CLI has stayed stable. Failure is never
    fatal: the caller falls back to the original audio, since a transcript from
    unseparated audio beats no transcript.
    """
    if not demucs_available():
        return None

    out_dir = tempfile.mkdtemp(prefix='subtitler_demucs_')
    try:
        if progress_cb:
            progress_cb(0.08, 'Isolating dialogue from the music bed…')

        cmd = [sys.executable, '-m', 'demucs',
               '--two-stems', 'vocals',
               '-n', model,
               '-o', out_dir,
               wav_path]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            return None

        stem = os.path.splitext(os.path.basename(wav_path))[0]
        for candidate in (
            os.path.join(out_dir, model, stem, 'vocals.wav'),
            os.path.join(out_dir, model, stem, 'vocals.mp3'),
        ):
            if os.path.isfile(candidate):
                return candidate

        # Layout varies by version; fall back to a search.
        for root, _dirs, files in os.walk(out_dir):
            for name in files:
                if name.startswith('vocals.'):
                    return os.path.join(root, name)
        return None
    except Exception:
        return None


def cleanup_dir_of(path):
    """Remove the temp tree a separated stem lives in."""
    if not path:
        return
    try:
        marker = os.sep + 'subtitler_demucs_'
        if marker in path:
            root = path
            while marker not in os.path.basename(root):
                parent = os.path.dirname(root)
                if parent == root:
                    return
                root = parent
            shutil.rmtree(root, ignore_errors=True)
    except Exception:
        pass
