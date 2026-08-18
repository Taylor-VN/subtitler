"""
Speaker separation — who spoke when, and which words are theirs.

A caption that puts two people on one line is wrong even when every word in it
is right: the reader cannot tell where one voice stops and the next begins.
This module answers "whose word is this", so the segmenter can force a caption
break at every speaker change and label the result.

The approach is embedding clustering rather than an end-to-end diarisation
pipeline:

  1. Words — already timed by the recogniser or the forced aligner — are
     grouped into short spans, split at pauses and at the ends of sentences.
     Working from the word times rather than a fixed window grid means every
     span edge is a real boundary between words, which is where a voice change
     actually happens; a grid buries changes in the middle of a window and
     blurs the boundary.
  2. Each span is encoded to a speaker embedding (ECAPA-TDNN), a vector that
     describes the voice rather than the words.
  3. Those embeddings are clustered. With the speaker count known, clustering
     stops at that many; otherwise it stops once the closest remaining pair is
     further apart than two spans of one voice normally are.
  4. Labels are smoothed, changes that fall where no speaker could have changed
     are dropped, and what is left is merged into turns.

pyannote's pipelines are the usual answer here and are deliberately not used:
their weights sit behind a licence acceptance and an access token, which does
not fit an app whose every other model installs on a button click. The trade is
overlapping speech — when two people talk at once, one of them wins the span.

Nothing here ever raises: a missing speaker label must not cost the operator an
otherwise good transcript.
"""

import os
import wave

import model_registry as registry

# A span shorter than this holds too little voice for a stable embedding, and
# one longer risks covering a speaker change.
MIN_SPAN_SEC = 1.0
MAX_SPAN_SEC = 3.0

# A gap at least this long always ends a span. Cheap insurance: a change of
# speaker nearly always happens across a pause, so cutting here keeps the two
# voices out of the same embedding.
SPLIT_PAUSE_SEC = 0.4

# The end of a sentence also ends a span, however little silence follows it.
# Dialogue is handed over on a full stop far more often than mid-clause, and it
# is regularly handed over with no measurable pause at all — "...wrong room."
# "In here," is two people inside a fifth of a second. Without this cut the two
# of them share one embedding, one label, and one caption.
SENTENCE_END_CHARS = '.!?…。！？'
CLOSING_CHARS = '"\'”’)]}»'

# Neither side of a sentence cut is worth making if it is shorter than this:
# below a third of a second there is not enough voice to place at all, and a
# wrong label is worse than a missing boundary.
LEXICAL_MIN_SEC = 0.3

# Audio pulled in either side of a span, so a short one still gives the encoder
# something to work with. Never more than half the silence next to it, since
# past the halfway mark the nearest voice is the neighbour's, not this one's —
# and after a sentence cut there is often no silence to take.
CONTEXT_SEC = 0.15

# Cosine distance between two ECAPA embeddings, above which they are treated as
# different people. Measured on this app's own spans — one to three seconds,
# clustered by average linkage — the two populations sit well apart: the last
# merge within one voice lands around 0.35 even when the delivery, pace and
# level vary across the recording, while the first merge between two people is
# 0.65 or above, and that holds for same-gender pairs, which are the hard case.
# Halfway between the two leaves room for material noisier than anything tested.
MERGE_THRESHOLD = 0.55

# Auto mode never invents more than this many people. Material with more voices
# than this is a panel show, not a promo, and the count is worth setting by hand.
MAX_SPEAKERS = 8

# A span this short, mid-flow and with agreeing neighbours, is a clustering
# wobble. See _smooth for why the pauses around it are what settles that.
SMOOTH_MAX_SEC = 0.6

BATCH_SPANS = 16

# Ceiling on the spans clustered at once, which is what sets the peak memory of
# the distance matrix. Around two hours of continuous dialogue.
MAX_CLUSTER_SPANS = 3000


def available():
    """Whether the speaker-separation runtime is importable."""
    try:
        import numpy  # noqa: F401
        import torch  # noqa: F401
        import speechbrain  # noqa: F401
        return True
    except Exception:
        return False


def model_installed():
    return registry.is_installed(registry.DIARIZER_MODEL['repo'])


def describe():
    """Registry entry plus live state, for the Settings panel."""
    return dict(registry.DIARIZER_MODEL,
                installed=model_installed(),
                available=available())


def diarize_words(wav_path, words, speakers='auto', progress_cb=None):
    """
    Label every word with the person who said it.

    The word dicts are labelled in place, so a caller holding the same list
    sees the speakers without reading the return value.

    @param words    [{word, start, end}, ...] in time order
    @param speakers 'auto', or a known speaker count
    @returns {'words': [...], 'turns': [...], 'count': int} — words carry a
             'speaker' key — or None when separation could not run at all.
    """
    try:
        return _diarize(wav_path, words, speakers, progress_cb)
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------

def _diarize(wav_path, words, speakers, progress_cb):
    import numpy as np

    words = [w for w in (words or []) if w.get('start') is not None]
    if not words:
        return None

    wanted = _speaker_count(speakers)
    spans = _spans(words)
    if not spans:
        return None

    # One span, or a fixed count of one, needs no model at all.
    if wanted == 1 or len(spans) < 2:
        return _single_speaker(words)

    samples, rate = _read_wav(wav_path)
    if samples is None or not len(samples):
        return None

    if progress_cb:
        progress_cb(0.05, 'Loading the speaker model…')
    encoder, device = _load_encoder()

    embeddings = _embed(encoder, device, samples, rate, spans, progress_cb)
    if embeddings is None:
        return None

    # Short spans are clustered *against* the result rather than being allowed
    # to shape it: a 0.4s embedding is noisy enough to open a cluster of its
    # own, which would show up as a speaker who says two words in an hour.
    strong = [i for i, s in enumerate(spans) if (s['end'] - s['start']) >= MIN_SPAN_SEC]
    if len(strong) < 2:
        strong = list(range(len(spans)))

    # Clustering holds a full distance matrix, so a feature-length interview
    # would ask for gigabytes. Past the cap the voices are found from an evenly
    # spread sample instead — every span is still labelled afterwards, against
    # the clusters that sample produced.
    if len(strong) > MAX_CLUSTER_SPANS:
        step = len(strong) / float(MAX_CLUSTER_SPANS)
        strong = [strong[int(i * step)] for i in range(MAX_CLUSTER_SPANS)]

    labels = _cluster(embeddings[strong], k=wanted)
    if labels is None:
        return None
    if labels.max() == 0 and wanted is None:
        return _single_speaker(words)

    centroids = _centroids(embeddings[strong], labels)
    assigned = _nearest(embeddings, centroids)
    _smooth(spans, assigned)
    _settle(words, spans, assigned)

    order = _rename_in_first_appearance_order(spans, assigned)
    for span, label in zip(spans, assigned):
        span['speaker'] = order[int(label)]

    for span in spans:
        for i in span['words']:
            words[i]['speaker'] = span['speaker']

    turns = _turns(spans)
    return {'words': words, 'turns': turns,
            'count': len(set(t['speaker'] for t in turns))}


def _speaker_count(speakers):
    """'auto' (or anything unparseable) means decide from the audio."""
    if speakers in (None, '', 'auto'):
        return None
    try:
        count = int(speakers)
    except (TypeError, ValueError):
        return None
    return max(1, min(MAX_SPEAKERS, count)) if count > 0 else None


def _single_speaker(words):
    for w in words:
        w['speaker'] = 'Speaker 1'
    return {'words': words,
            'turns': [{'start': float(words[0]['start']),
                       'end': float(words[-1].get('end', words[-1]['start'])),
                       'speaker': 'Speaker 1'}],
            'count': 1}


def _spans(words):
    """
    Group words into spans that plausibly hold a single voice.

    A long pause ends a span even when the span is short — correctness at the
    boundary matters more than embedding quality, and short spans are handled
    later by assigning them to an existing cluster rather than seeding one.

    Every span is then cut again wherever a sentence ends inside it, for the
    same reason: a boundary the audio does not announce is still a boundary.
    """
    spans = []
    current = None

    for i, w in enumerate(words):
        start = float(w.get('start') or 0.0)
        end = float(w.get('end') or start)
        if end < start:
            end = start

        if current is None:
            current = {'start': start, 'end': end, 'words': [i]}
            continue

        gap = start - current['end']
        if gap >= SPLIT_PAUSE_SEC or (end - current['start']) > MAX_SPAN_SEC:
            spans.append(current)
            current = {'start': start, 'end': end, 'words': [i]}
        else:
            current['end'] = max(current['end'], end)
            current['words'].append(i)

    if current:
        spans.append(current)

    out = []
    for span in spans:
        out.extend(_split_at_sentences(span, words))
    return out


def _ends_sentence(word):
    """Whether a word closes a sentence, ignoring any quote or bracket after it."""
    text = str(word.get('word') or word.get('text') or '').strip()
    while text and text[-1] in CLOSING_CHARS:
        text = text[:-1]
    return bool(text) and text[-1] in SENTENCE_END_CHARS


def _bounds(words, indexes):
    """Start and end of a run of words, tolerant of times that step backwards."""
    start = float(words[indexes[0]].get('start') or 0.0)
    end = start
    for i in indexes:
        w = words[i]
        end = max(end, float(w.get('end') or w.get('start') or start))
    return start, end


def _split_at_sentences(span, words):
    """
    Cut one span wherever a sentence ends part-way through it.

    Costless when the speaker does not in fact change: both pieces land in the
    same cluster and _turns joins them straight back up. When the speaker does
    change, this is the only place the change can still be seen — the pause that
    would otherwise have marked it is not there.

    A cut that would leave either side too short to embed is not made: the piece
    stays where it is, mislabelled at worst as it was before.
    """
    indexes = span['words']
    if len(indexes) < 2:
        return [span]

    pieces = []
    head = 0

    for k in range(len(indexes) - 1):
        if not _ends_sentence(words[indexes[k]]):
            continue
        head_start, head_end = _bounds(words, indexes[head:k + 1])
        tail_start, tail_end = _bounds(words, indexes[k + 1:])
        if (head_end - head_start) < LEXICAL_MIN_SEC:
            continue
        if (tail_end - tail_start) < LEXICAL_MIN_SEC:
            continue
        pieces.append({'start': head_start, 'end': head_end,
                       'words': indexes[head:k + 1]})
        head = k + 1

    if not pieces:
        return [span]

    start, end = _bounds(words, indexes[head:])
    pieces.append({'start': start, 'end': max(end, span['end']),
                   'words': indexes[head:]})
    return pieces


def _read_wav(path):
    """The front-end always sends 16 kHz mono PCM, so this stays simple."""
    import numpy as np
    try:
        with wave.open(path, 'rb') as w:
            if w.getnchannels() != 1 or w.getsampwidth() != 2:
                return None, 0
            raw = w.readframes(w.getnframes())
            rate = w.getframerate()
    except Exception:
        return None, 0
    return np.frombuffer(raw, dtype='<i2').astype('float32') / 32768.0, rate


def _pick_device():
    import torch
    if torch.cuda.is_available():
        return 'cuda'
    if getattr(torch.backends, 'mps', None) and torch.backends.mps.is_available():
        return 'mps'
    return 'cpu'


def _load_encoder(device=None):
    """
    @returns (encoder, device) — the device may not be the one asked for.

    SpeechBrain 1.1 maps only 'cpu' and 'cuda' to an autocast device type, so
    asking it for MPS raises before the model is even built. Rather than pinning
    Apple Silicon to the CPU for good — a later release may well handle it — the
    accelerator is tried and the CPU is used if it is refused. ECAPA is a small
    model, so that fallback is a slower pass, not a failure.
    """
    try:
        from speechbrain.inference.speaker import EncoderClassifier
    except ImportError:  # speechbrain < 1.0
        from speechbrain.pretrained import EncoderClassifier

    repo = registry.DIARIZER_MODEL['repo']
    # SpeechBrain wants a working directory of its own for the checkpoint. It
    # fetches through huggingface_hub, so the download itself still lands in the
    # shared cache the Settings panel installs into and reports on.
    savedir = os.path.join(registry.hf_cache_dir(), 'speechbrain',
                           repo.replace('/', '--'))

    def build(dev):
        return EncoderClassifier.from_hparams(source=repo, savedir=savedir,
                                              run_opts={'device': dev})

    device = device or _pick_device()
    try:
        return build(device), device
    except Exception:
        if device == 'cpu':
            raise
        return build('cpu'), 'cpu'


def _embed(encoder, device, samples, rate, spans, progress_cb=None):
    """
    One embedding per span, batched.

    Falls back to the CPU once if the accelerator refuses an operation, rather
    than losing the whole pass — ECAPA is small enough that CPU is a slowdown,
    not a wall.
    """
    import numpy as np
    import torch

    total = len(spans)
    vectors = []
    margins = _context_margins(spans)

    for offset in range(0, total, BATCH_SPANS):
        batch = spans[offset:offset + BATCH_SPANS]
        clips = [_clip(samples, rate, s, margins[offset + i])
                 for i, s in enumerate(batch)]
        width = max(len(c) for c in clips)

        padded = np.zeros((len(clips), width), dtype='float32')
        lengths = np.zeros(len(clips), dtype='float32')
        for i, clip in enumerate(clips):
            padded[i, :len(clip)] = clip
            lengths[i] = len(clip) / float(width)

        wavs = torch.from_numpy(padded)
        lens = torch.from_numpy(lengths)

        try:
            with torch.no_grad():
                out = encoder.encode_batch(wavs.to(device), lens.to(device))
        except Exception:
            if device == 'cpu':
                raise
            encoder, device = _load_encoder('cpu')
            with torch.no_grad():
                out = encoder.encode_batch(wavs, lens)

        vectors.append(out.squeeze(1).float().cpu().numpy())

        if progress_cb:
            done = min(offset + len(batch), total)
            progress_cb(0.1 + 0.75 * done / total,
                        f'Separating speakers… {done}/{total} passages')

    return np.vstack(vectors) if vectors else None


def _context_margins(spans):
    """
    How far either side of each span the encoder may reach.

    Never past the middle of the silence next to it, and so never at all where a
    span was cut at a sentence with no silence to speak of. Half a second of
    "In here," preceded by 0.15s of the person who just stopped talking is a
    third of the clip in the wrong voice, which is enough to swing the label to
    them — the very handover the cut exists to catch.
    """
    out = []
    for i, span in enumerate(spans):
        lead = CONTEXT_SEC if i == 0 else \
            min(CONTEXT_SEC, max(0.0, span['start'] - spans[i - 1]['end']) / 2.0)
        tail = CONTEXT_SEC if i == len(spans) - 1 else \
            min(CONTEXT_SEC, max(0.0, spans[i + 1]['start'] - span['end']) / 2.0)
        out.append((lead, tail))
    return out


def _clip(samples, rate, span, margin=(CONTEXT_SEC, CONTEXT_SEC)):
    """The audio for one span, with whatever context is safely its own."""
    import numpy as np
    lead, tail = margin
    floor = max(1, int(0.2 * rate))
    start = int(max(0.0, span['start'] - lead) * rate)
    end = int(min(len(samples) / float(rate), span['end'] + tail) * rate)
    if end - start < floor:
        end = min(len(samples), start + floor)
    clip = samples[start:end]
    # A word timed past the end of the audio — alignment can do that on the last
    # word — would otherwise hand the encoder an empty batch row.
    if len(clip) == 0:
        return np.zeros(floor, dtype='float32')
    return clip


def _normalise(matrix):
    import numpy as np
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return matrix / norms


def _cluster(embeddings, k=None):
    """
    Average-linkage agglomerative clustering on cosine distance.

    Average linkage rather than single: one borderline pair of spans should not
    be able to chain two speakers into one cluster, which is exactly what single
    linkage does on voices recorded in the same room.

    @param k  a known speaker count, or None to stop at MERGE_THRESHOLD
    @returns  an array of cluster labels, 0..n-1 in merge order
    """
    import numpy as np

    n = len(embeddings)
    if n == 0:
        return None
    if n == 1:
        return np.zeros(1, dtype=int)

    X = _normalise(embeddings.astype('float64'))
    distances = 1.0 - (X @ X.T)
    np.fill_diagonal(distances, np.inf)

    sizes = np.ones(n)
    active = np.ones(n, dtype=bool)
    members = {i: [i] for i in range(n)}

    remaining = n
    while remaining > 1:
        # Rows and columns of merged-away clusters are set to infinity as they
        # go, so the whole matrix can be searched without masking it each pass.
        i, j = divmod(int(np.argmin(distances)), n)
        closest = distances[i, j]

        if k is None:
            # Past the threshold these are different people — unless there are
            # still more clusters than any plausible cast, in which case the
            # threshold has clearly been read too strictly for this recording.
            if closest > MERGE_THRESHOLD and remaining <= MAX_SPEAKERS:
                break
        elif remaining <= k:
            break

        # Lance-Williams update for average linkage. Distances to clusters that
        # are already gone stay infinite: inf * weight is still inf.
        merged = (sizes[i] * distances[i] + sizes[j] * distances[j]) / (sizes[i] + sizes[j])
        distances[i] = merged
        distances[:, i] = merged
        distances[i, i] = np.inf
        distances[j] = np.inf
        distances[:, j] = np.inf
        sizes[i] += sizes[j]
        active[j] = False
        remaining -= 1
        members[i].extend(members.pop(j))

    labels = np.zeros(n, dtype=int)
    for label, root in enumerate(i for i in range(n) if active[i]):
        for member in members[root]:
            labels[member] = label
    return labels


def _centroids(embeddings, labels):
    import numpy as np
    count = int(labels.max()) + 1
    out = np.zeros((count, embeddings.shape[1]), dtype='float64')
    normalised = _normalise(embeddings.astype('float64'))
    for label in range(count):
        rows = normalised[labels == label]
        if len(rows):
            out[label] = rows.mean(axis=0)
    return _normalise(out)


def _nearest(embeddings, centroids):
    """Every span — including the short ones held out of clustering — gets the
    closest voice, so no word is left without a speaker."""
    import numpy as np
    similarity = _normalise(embeddings.astype('float64')) @ centroids.T
    return np.argmax(similarity, axis=1)


def _smooth(spans, labels):
    """
    Flip a brief span sandwiched between two spans that agree with each other.

    Only inside an unbroken run of speech. A short span with a pause either side
    is somebody interrupting — "Good", "Exactly", "No" — and those one-word
    turns are precisely what speaker labelling exists to catch; a short span mid
    -flow, with no pause anywhere near it, is a clustering wobble.
    """
    for i in range(1, len(spans) - 1):
        if (spans[i]['end'] - spans[i]['start']) > SMOOTH_MAX_SEC:
            continue
        if (spans[i]['start'] - spans[i - 1]['end']) >= SPLIT_PAUSE_SEC:
            continue
        if (spans[i + 1]['start'] - spans[i]['end']) >= SPLIT_PAUSE_SEC:
            continue
        before, after = labels[i - 1], labels[i + 1]
        if before == after and labels[i] != before:
            labels[i] = before
    return labels


def _settle(words, spans, labels):
    """
    Drop a change of speaker that lands somewhere a speaker cannot change.

    Every span edge is a pause, the end of a sentence, or neither — the last
    kind being the arbitrary cut a span takes when it runs past MAX_SPAN_SEC,
    which falls mid-clause with no silence around it. Nobody hands over a line
    there. A label that changes across such an edge is the clustering drifting
    part-way through one person's sentence, and it costs the operator a word:
    the caption is split at the change, and the fragment left behind is too
    short to grow into anything readable — a few frames on screen, which reads
    as a dropped word rather than as a second speaker.

    So a change is kept only where the words allow one, and otherwise the run
    carries on with the voice it started in.
    """
    for i in range(1, len(spans)):
        if labels[i] == labels[i - 1]:
            continue
        if (spans[i]['start'] - spans[i - 1]['end']) >= SPLIT_PAUSE_SEC:
            continue
        if _ends_sentence(words[spans[i - 1]['words'][-1]]):
            continue
        labels[i] = labels[i - 1]
    return labels


def _rename_in_first_appearance_order(spans, labels):
    """Speaker 1 is whoever talks first, which is what an operator expects."""
    order = {}
    for span, label in zip(spans, labels):
        label = int(label)
        if label not in order:
            order[label] = f'Speaker {len(order) + 1}'
    return order


def _turns(spans):
    """Consecutive spans by the same person become one turn."""
    turns = []
    for span in spans:
        if turns and turns[-1]['speaker'] == span['speaker']:
            turns[-1]['end'] = float(span['end'])
        else:
            turns.append({'start': float(span['start']),
                          'end': float(span['end']),
                          'speaker': span['speaker']})
    return turns
