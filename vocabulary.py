"""
Vocabulary biasing.

Brand names, product terms and presenter names are the errors an operator ends
up fixing by hand, because they are exactly what a general model has least
reason to predict. Two mechanisms, used together:

  1. Native prompting, where the engine supports it. Whisper-family models take
     an `initial_prompt`; faster-whisper also takes `hotwords`. Biasing the model
     itself is always preferable to editing its output.

  2. A correction pass over the returned words. CTC and TDT models — Parakeet
     among them — cannot be prompted at all, so for those the only lever is to
     recognise near-misses after the fact. "smart metre" becomes "Smart Meter",
     "bright spark" becomes "Bright Spark", and casing is normalised to the way
     the term was written in the list.

The correction pass is deliberately conservative: it only fires on a close
match, it never rewrites a word that is already correct, and it will not merge
across a long pause. Over-correcting a transcript is worse than leaving a
typo, because the operator stops trusting it.
"""

import re
import unicodedata

# Similarity a candidate must reach before it is rewritten. Chosen so that
# "metre"/"meter" (0.8) corrects but "meter"/"better" (0.4) does not.
DEFAULT_THRESHOLD = 0.78

# A gap longer than this means the words belong to different phrases, so a
# multi-word term is not allowed to span it.
MAX_PHRASE_GAP_SEC = 0.9


def parse_terms(raw):
    """
    Read a user's term list.

    Accepts newlines, commas or semicolons as separators, since people paste
    from all three. Order is preserved and duplicates dropped, longest first so
    a multi-word term wins over one of its own words.
    """
    if not raw:
        return []
    parts = re.split(r'[\n,;]+', str(raw))
    seen = set()
    terms = []
    for part in parts:
        term = ' '.join(part.split())
        if not term:
            continue
        key = term.casefold()
        if key in seen:
            continue
        seen.add(key)
        terms.append(term)
    terms.sort(key=lambda t: len(t.split()), reverse=True)
    return terms


def build_prompt(terms, limit_chars=880):
    """
    An initial_prompt for Whisper-style models.

    Whisper conditions on this as if it were preceding transcript text, so a
    plain comma-separated run of the terms works and reads naturally. Kept well
    inside the 224-token prompt window.
    """
    if not terms:
        return ''
    out = []
    total = 0
    for term in terms:
        piece = term if not out else f', {term}'
        if total + len(piece) > limit_chars:
            break
        out.append(piece)
        total += len(piece)
    return ''.join(out) + '.'


def _norm(text):
    """Casefolded, unaccented, punctuation-free form used for comparison only."""
    stripped = unicodedata.normalize('NFKD', str(text))
    stripped = ''.join(c for c in stripped if not unicodedata.combining(c))
    return re.sub(r"[^\w']+", '', stripped).casefold()


def similarity(a, b):
    """
    Ratio in 0..1 from a bounded edit distance.

    Uses difflib's ratio, which is close enough for single words and cheap. An
    empty pair scores 0 rather than raising.
    """
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    import difflib
    return difflib.SequenceMatcher(None, a, b).ratio()


def _split_affixes(word):
    """Separate leading/trailing punctuation so it survives a replacement."""
    match = re.match(r'^([^\w]*)(.*?)([^\w]*)$', word, re.DOTALL)
    if not match:
        return '', word, ''
    return match.group(1), match.group(2), match.group(3)


def apply_terms(words, terms, threshold=DEFAULT_THRESHOLD):
    """
    Rewrite near-misses in `words` to the spelling given in `terms`.

    @param words list of {word, start, end, ...}; not mutated
    @returns (new_words, corrections) where corrections is a list of
             {from, to, start} describing what changed
    """
    if not words or not terms:
        return list(words), []

    result = [dict(w) for w in words]
    corrections = []
    consumed = [False] * len(result)

    for term in terms:
        term_words = term.split()
        span = len(term_words)
        term_norm = _norm(term)
        if not term_norm:
            continue

        for i in range(len(result) - span + 1):
            if any(consumed[i:i + span]):
                continue

            window = result[i:i + span]

            # A multi-word term must not be stitched across a pause.
            if span > 1:
                gapped = False
                for a, b in zip(window, window[1:]):
                    try:
                        if float(b.get('start', 0)) - float(a.get('end', 0)) > MAX_PHRASE_GAP_SEC:
                            gapped = True
                            break
                    except (TypeError, ValueError):
                        pass
                if gapped:
                    continue

            pieces = [_split_affixes(w.get('word', '')) for w in window]
            cores = [p[1] for p in pieces]
            candidate_norm = _norm(''.join(cores))
            if not candidate_norm:
                continue

            score = similarity(candidate_norm, term_norm)
            if score < threshold:
                continue

            already = ' '.join(cores) == term
            if already:
                # Right spelling already; claim the span so a shorter term does
                # not come along and mangle part of it.
                for k in range(i, i + span):
                    consumed[k] = True
                continue

            lead = pieces[0][0]
            trail = pieces[-1][2]

            # Collapse the window onto the first word, keeping the span's
            # overall timing so caption boundaries stay put.
            first = result[i]
            corrections.append({
                'from': ' '.join(cores),
                'to': term,
                'start': first.get('start'),
                'score': round(score, 3),
            })
            first['word'] = f'{lead}{term}{trail}'
            first['end'] = window[-1].get('end', first.get('end'))
            first['corrected'] = True

            for k in range(i, i + span):
                consumed[k] = True
            for k in range(i + 1, i + span):
                result[k] = None

    new_words = [w for w in result if w is not None]
    return new_words, corrections


def engine_prompt_kwargs(engine_id, terms):
    """
    Native biasing arguments for an engine, or {} where it cannot be prompted.

    Parakeet is a TDT model with no text conditioning at all, so it relies
    entirely on the correction pass.
    """
    if not terms:
        return {}

    prompt = build_prompt(terms)
    if engine_id in ('mlx-whisper',):
        return {'initial_prompt': prompt}
    if engine_id in ('faster-whisper',):
        # hotwords biases the decoder directly and is stronger than a prompt;
        # older releases ignore the argument, which is why it is filtered
        # against the callee's signature before use.
        return {'initial_prompt': prompt, 'hotwords': ' '.join(terms)}
    if engine_id in ('mlx-qwen3-asr',):
        return {'context': prompt}
    return {}
