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

# What the front-end sends and what every engine here is built around.
TARGET_RATE = 16000

# Analysis window. 30 ms is long enough to be stable and short enough to catch
# the start of a word.
FRAME_MS = 30

# Speech is judged relative to the quietest part of this recording rather than
# an absolute level, because material arrives at wildly different levels.
NOISE_PERCENTILE = 0.20
SPEECH_OVER_NOISE_DB = 9.0
ABSOLUTE_FLOOR_DB = -55.0

# The floor is measured again over blocks this long, because one figure for a
# whole programme does not survive a cut. See _local_thresholds.
BLOCK_SEC = 5.0

# A block is short enough to be mostly speech, so the quietest twentieth of it —
# rather than the quietest fifth, which over a whole programme is reliably room
# tone — is the part still likely to *be* the room. Measured any higher and a
# block of unbroken dialogue reports its own speech as the noise floor.
BLOCK_NOISE_PERCENTILE = 0.05

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
    noise = _percentile(ordered, NOISE_PERCENTILE)
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

    local = _local_thresholds(levels, frame_sec, threshold)

    regions = []
    start = None
    for i, level in enumerate(levels):
        if level >= local[i]:
            if start is None:
                start = i
        elif start is not None:
            regions.append((start * frame_sec, i * frame_sec))
            start = None
    if start is not None:
        regions.append((start * frame_sec, len(levels) * frame_sec))

    return _tidy_regions(regions, total_sec)


def _percentile(ordered, fraction):
    return ordered[min(len(ordered) - 1, int(len(ordered) * fraction))]


def _local_thresholds(levels, frame_sec, ceiling):
    """
    A threshold per frame, measured in blocks and never above the file-wide one.

    One figure for a whole programme does not survive an abrupt cut. The noise
    floor is the quietest fifth of the material, so in a piece that is mostly
    loud — a music bed, a scene mixed hot — that fifth can sit *above* the level
    of the dialogue in a quiet passage somewhere else. Every word there then
    reads as silence and is thrown away, which is not a caption the operator can
    see is missing; it is simply not there. Measuring the floor over blocks lets
    each passage be judged against its own room.

    Downwards only. A block that is wall-to-wall speech holds no silence to
    measure, so its floor *is* the speech: letting that raise the threshold
    would cut the very words it was measured from. The file-wide threshold stays
    the ceiling, so this can admit speech that was being discarded and can never
    discard speech that was being kept.
    """
    size = max(1, int(round(BLOCK_SEC / frame_sec)))
    out = []

    for start in range(0, len(levels), size):
        block = sorted(levels[start:start + size])
        floor = _percentile(block, BLOCK_NOISE_PERCENTILE)
        if block[-1] - floor < SPEECH_OVER_NOISE_DB:
            # Flat: unbroken speech, or unbroken tone, and there is nothing in
            # the block that separates the two. Fall back to the absolute floor,
            # which keeps quiet dialogue and still discards room tone.
            value = ABSOLUTE_FLOOR_DB
        else:
            value = max(floor + SPEECH_OVER_NOISE_DB, ABSOLUTE_FLOOR_DB)
        out.extend([min(ceiling, value)] * len(block))

    return out


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

    The stem is conformed back to 16 kHz mono before it is handed back. Demucs
    resamples to its own 44.1 kHz stereo working rate whatever it is given, and
    that stem then goes to the model in place of the front-end's audio — so
    without this step it silently breaks the one thing every engine here is
    entitled to assume about its input.
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

        stem = _find_stem(out_dir, model, wav_path)
        return conform_to_mono16k(stem) if stem else None
    except Exception:
        return None


def _find_stem(out_dir, model, wav_path):
    """Locate the vocal stem Demucs just wrote."""
    name = os.path.splitext(os.path.basename(wav_path))[0]
    for candidate in (
        os.path.join(out_dir, model, name, 'vocals.wav'),
        os.path.join(out_dir, model, name, 'vocals.mp3'),
    ):
        if os.path.isfile(candidate):
            return candidate

    # Layout varies by version; fall back to a search.
    for root, _dirs, files in os.walk(out_dir):
        for found in files:
            if found.startswith('vocals.'):
                return os.path.join(root, found)
    return None


def conform_to_mono16k(path):
    """
    Rewrite a WAV as the 16 kHz mono 16-bit PCM the engines expect.

    @returns the new path, `path` itself when it already conforms, or None when
    it cannot be read — a caller that has no conforming audio is better off
    falling back to the original mix than passing a surprise format on.

    The new file is written beside the old one so it is removed with the same
    temp tree.
    """
    try:
        with wave.open(path, 'rb') as w:
            channels = w.getnchannels()
            width = w.getsampwidth()
            rate = w.getframerate()
            if (channels, width, rate) == (1, 2, TARGET_RATE):
                return path
            if width != 2:
                return None
            raw = w.readframes(w.getnframes())
    except Exception:
        return None

    try:
        frames = _to_mono16k_frames(raw, channels, rate)
        out_path = os.path.splitext(path)[0] + '.16k.wav'
        with wave.open(out_path, 'wb') as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(TARGET_RATE)
            w.writeframes(frames)
        return out_path
    except Exception:
        return None


def _to_mono16k_frames(raw, channels, rate):
    """Downmix and resample 16-bit PCM frames, returning 16 kHz mono frames."""
    try:
        import numpy as np
    except ImportError:
        return _to_mono16k_frames_py(raw, channels, rate)

    data = np.frombuffer(raw, dtype='<i2').astype(np.float32)
    if channels > 1:
        usable = len(data) - (len(data) % channels)
        data = data[:usable].reshape(-1, channels).mean(axis=1)
    if rate != TARGET_RATE:
        data = _resample(np, data, rate)
    return np.clip(np.rint(data), -32768, 32767).astype('<i2').tobytes()


def _resample(np, data, rate):
    """
    Down to 16 kHz, band-limited where torchaudio is installed.

    Anti-aliasing is the point: everything above 8 kHz folds back into the
    speech band otherwise, and a vocal stem carries plenty of sibilance up
    there. torchaudio is a dependency of Demucs, so its windowed-sinc resampler
    is available on every machine that can reach this code at all; the box
    filter below is a floor, not the expected path.
    """
    try:
        import torch
        import torchaudio
        tensor = torch.from_numpy(np.ascontiguousarray(data)).unsqueeze(0)
        return torchaudio.functional.resample(tensor, rate, TARGET_RATE)[0].numpy()
    except Exception:
        pass

    ratio = rate / float(TARGET_RATE)
    taps = max(1, int(round(ratio)))
    if taps > 1:
        data = np.convolve(data, np.ones(taps, dtype=np.float32) / taps, mode='same')
    source = np.arange(len(data), dtype=np.float32)
    wanted = np.arange(int(len(data) / ratio), dtype=np.float32) * ratio
    return np.interp(wanted, source, data)


def _to_mono16k_frames_py(raw, channels, rate):
    """Standard-library fallback for _to_mono16k_frames()."""
    data = array.array('h')
    data.frombytes(raw)

    if channels > 1:
        data = array.array('h', [
            int(sum(data[i:i + channels]) / channels)
            for i in range(0, len(data) - channels + 1, channels)
        ])

    if rate != TARGET_RATE and data:
        ratio = rate / float(TARGET_RATE)
        taps = max(1, int(round(ratio)))
        last = len(data) - 1
        out = array.array('h', bytes(2 * int(len(data) / ratio)))
        for i in range(len(out)):
            base = int(i * ratio)
            total = 0
            for t in range(taps):
                total += data[min(base + t, last)]
            out[i] = int(total / taps)
        data = out

    return data.tobytes()


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
