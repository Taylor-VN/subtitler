/**
 * Caption Segmenter
 *
 * Whisper returns long, loosely-punctuated segments — a 14-second run of text
 * is common. Those are transcript lines, not subtitles. This turns word-level
 * timings into broadcast-style captions using the conventions Premiere's own
 * caption tools follow:
 *
 *   - a hard character budget per line, and a line budget per caption
 *   - a maximum on-screen duration, and a minimum so captions do not flash
 *   - breaks preferred at sentence punctuation, then clause punctuation, then
 *     a plain word boundary
 *   - a forced break when the speaker pauses
 *   - a reading-speed ceiling, so dense captions are held longer
 *
 * It is a pure function of (words, settings), so the settings can be changed
 * and re-applied instantly without re-running the model.
 */

const DEFAULT_SEGMENT_SETTINGS = {
  maxCharsPerLine: 42,
  maxLines: 2,
  maxDurationSec: 6.0,
  minDurationSec: 1.0,
  gapBreakSec: 0.8,      // a pause at least this long forces a new caption
  maxCharsPerSec: 20,    // reading-speed ceiling
  framesGapBetweenCaptions: 1,
  fps: 25
};

const SENTENCE_END = /[.!?…。！？]["'”’)\]]?$/;
const CLAUSE_END = /[,;:、，；：]["'”’)\]]?$/;

class CaptionSegmenter {
  constructor(settings = {}) {
    this.settings = { ...DEFAULT_SEGMENT_SETTINGS, ...settings };
  }

  updateSettings(settings) {
    this.settings = { ...this.settings, ...settings };
    return this.settings;
  }

  /**
   * @param {Array} words [{ start, end, word }] — `word` may carry leading space
   * @returns {Array} [{ start, end, text }] caption-ready lines
   */
  segment(words) {
    const s = this.settings;
    const clean = this.normalizeWords(words);
    if (clean.length === 0) return [];

    const captions = [];
    let current = [];

    const flush = () => {
      if (current.length === 0) return;
      captions.push(this.buildCaption(current));
      current = [];
    };

    for (let i = 0; i < clean.length; i++) {
      const w = clean[i];
      const prev = current.length ? current[current.length - 1] : null;

      // A long pause always ends the caption, however short it is.
      if (prev && (w.start - prev.end) >= s.gapBreakSec) {
        flush();
      }

      const candidateText = this.joinWords([...current, w]);
      const candidateDur = current.length ? (w.end - current[0].start) : (w.end - w.start);

      const tooLong = !this.fitsCaption(candidateText);
      const tooSlow = candidateDur > s.maxDurationSec;

      if (current.length && (tooLong || tooSlow)) {
        // Prefer to end the caption at the most recent natural break rather
        // than mid-clause; only look back far enough to stay worthwhile.
        const breakIdx = this.findBreakPoint(current);
        if (breakIdx !== null && breakIdx < current.length - 1) {
          const head = current.slice(0, breakIdx + 1);
          const tail = current.slice(breakIdx + 1);
          captions.push(this.buildCaption(head));
          current = tail;
        } else {
          flush();
        }
      }

      current.push(w);

      // A completed sentence that already fills a reasonable caption ends here.
      if (SENTENCE_END.test(w.text)) {
        const text = this.joinWords(current);
        const dur = w.end - current[0].start;
        const halfBudget = s.maxCharsPerLine * s.maxLines * 0.5;
        if (text.length >= halfBudget || dur >= s.maxDurationSec * 0.5) {
          flush();
        }
      }
    }
    flush();

    return this.applyTiming(this.preventWidows(captions));
  }

  /**
   * Stops a caption ending up as one stranded word ("captions." on its own).
   * Merges it back if the combined text fits, otherwise drags words backwards
   * from the previous caption until both read reasonably.
   */
  preventWidows(captions) {
    const s = this.settings;
    const minChars = Math.max(8, Math.round(s.maxCharsPerLine * 0.4));

    for (let i = 1; i < captions.length; i++) {
      const prev = captions[i - 1];
      const curr = captions[i];
      if (!prev.words || !curr.words) continue;
      if (this.joinWords(curr.words).length >= minChars) continue;

      // Only rebalance across a continuous run of speech.
      const gap = curr.words[0].start - prev.words[prev.words.length - 1].end;
      if (gap >= s.gapBreakSec) continue;

      const merged = [...prev.words, ...curr.words];
      const mergedDur = merged[merged.length - 1].end - merged[0].start;
      if (this.fitsCaption(this.joinWords(merged)) && mergedDur <= s.maxDurationSec) {
        captions[i - 1] = this.buildCaption(merged);
        captions.splice(i, 1);
        i--;
        continue;
      }

      let prevWords = prev.words.slice();
      let currWords = curr.words.slice();
      while (prevWords.length > 1) {
        const candPrev = prevWords.slice(0, -1);
        const candCurr = [prevWords[prevWords.length - 1], ...currWords];
        if (!this.fitsCaption(this.joinWords(candCurr))) break;
        if (this.joinWords(candPrev).length < minChars) break;
        prevWords = candPrev;
        currWords = candCurr;
        if (this.joinWords(currWords).length >= minChars) break;
      }

      captions[i - 1] = this.buildCaption(prevWords);
      captions[i] = this.buildCaption(currWords);
    }
    return captions;
  }

  /** Strips empties and guarantees monotonically non-decreasing timings. */
  normalizeWords(words) {
    const out = [];
    let lastEnd = 0;
    (words || []).forEach(w => {
      const text = String(w.word !== undefined ? w.word : w.text || '').trim();
      if (!text) return;
      const confidence = typeof w.probability === 'number' ? w.probability : undefined;
      let start = Number(w.start);
      let end = Number(w.end);
      if (!isFinite(start)) start = lastEnd;
      if (!isFinite(end) || end <= start) end = start + 0.08;
      if (start < lastEnd) start = lastEnd;
      if (end <= start) end = start + 0.08;
      out.push({ text, start, end, confidence, corrected: !!w.corrected });
      lastEnd = end;
    });
    return out;
  }

  joinWords(words) {
    return words.map(w => w.text).join(' ');
  }

  /**
   * Index of the best word to end a caption on: latest sentence end, else
   * latest clause end, else null (meaning "no natural break, cut anywhere").
   */
  findBreakPoint(words) {
    for (let i = words.length - 1; i >= 0; i--) {
      if (SENTENCE_END.test(words[i].text)) return i;
    }
    for (let i = words.length - 1; i >= 0; i--) {
      if (CLAUSE_END.test(words[i].text)) return i;
    }
    return null;
  }

  buildCaption(words) {
    return {
      start: words[0].start,
      end: words[words.length - 1].end,
      text: this.wrapLines(this.joinWords(words)),
      words: words
    };
  }

  /**
   * Greedy line fill at maxCharsPerLine. A word longer than a whole line is
   * broken by character rather than being allowed to overflow.
   */
  layoutLines(text) {
    const s = this.settings;
    const words = String(text || '').split(' ').filter(Boolean);
    if (words.length === 0) return [];

    const lines = [];
    let line = '';

    const pushLine = () => {
      if (line) { lines.push(line); line = ''; }
    };

    words.forEach(w => {
      const candidate = line ? line + ' ' + w : w;
      if (candidate.length <= s.maxCharsPerLine) {
        line = candidate;
        return;
      }
      pushLine();
      if (w.length > s.maxCharsPerLine) {
        let chunk = '';
        for (const ch of w) {
          if (chunk.length + 1 > s.maxCharsPerLine) { lines.push(chunk); chunk = ch; }
          else chunk += ch;
        }
        line = chunk;
      } else {
        line = w;
      }
    });
    pushLine();
    return lines;
  }

  /**
   * Whether a caption fits the line budget. Note this asks the real layout
   * rather than comparing raw character counts: greedy wrapping leaves ragged
   * space, so maxCharsPerLine * maxLines characters do NOT always fit in
   * maxLines lines.
   */
  fitsCaption(text) {
    return this.layoutLines(text).length <= this.settings.maxLines;
  }

  /** Balances the caption across at most maxLines lines. */
  wrapLines(text) {
    const s = this.settings;
    if (!text) return '';
    if (text.length <= s.maxCharsPerLine) return text;

    const lines = this.layoutLines(text);
    if (lines.length === 2) {
      const balanced = this.balanceTwoLines(text.split(' ').filter(Boolean));
      if (balanced) return balanced.join('\n');
    }
    // Never re-join overflow onto a line — that would break the per-line
    // budget. segment() keeps captions inside maxLines; anything still over is
    // a single unbreakable token, which is better shown than silently dropped.
    return lines.join('\n');
  }

  /** Splits into two lines at the point that makes them most even. */
  balanceTwoLines(words) {
    const s = this.settings;
    let best = null;
    for (let i = 1; i < words.length; i++) {
      const a = words.slice(0, i).join(' ');
      const b = words.slice(i).join(' ');
      if (a.length > s.maxCharsPerLine || b.length > s.maxCharsPerLine) continue;
      const score = Math.abs(a.length - b.length);
      if (!best || score < best.score) best = { score, lines: [a, b] };
    }
    return best ? best.lines : null;
  }

  /**
   * Enforces minimum duration, the reading-speed ceiling, and a one-frame gap
   * so captions never share a frame with their neighbour.
   */
  applyTiming(captions) {
    const s = this.settings;
    const frame = 1 / (s.fps || 25);
    const gap = (s.framesGapBetweenCaptions || 0) * frame;

    const out = captions.map(c => ({ ...c }));

    out.forEach((c, i) => {
      const charCount = c.text.replace(/\n/g, ' ').length;
      const readingSec = charCount / s.maxCharsPerSec;
      const wanted = Math.max(s.minDurationSec, readingSec);

      if ((c.end - c.start) < wanted) {
        const next = out[i + 1];
        // Grow into the silence ahead, never over the next caption.
        const ceiling = next ? next.start - gap : c.start + wanted;
        c.end = Math.max(c.end, Math.min(c.start + wanted, ceiling));
      }
      if (c.end <= c.start) c.end = c.start + frame;
    });

    // Separate any captions that still touch or overlap.
    for (let i = 1; i < out.length; i++) {
      const prev = out[i - 1];
      const curr = out[i];
      if (curr.start < prev.end + gap) {
        const shifted = prev.end + gap;
        if (shifted < curr.end) {
          curr.start = shifted;
        } else {
          prev.end = Math.max(prev.start + frame, curr.start - gap);
        }
      }
    }

    return out.map(c => ({
      start: Math.max(0, c.start),
      end: Math.max(c.start + frame, c.end),
      text: c.text,
      // Retained so callers can report per-word confidence for this caption.
      words: c.words
    }));
  }

  /** Fallback when the model gives no word timings: split segments by text. */
  segmentFromSegments(segments) {
    const words = [];
    (segments || []).forEach(seg => {
      if (Array.isArray(seg.words) && seg.words.length) {
        seg.words.forEach(w => words.push(w));
        return;
      }
      // Distribute the segment's duration evenly across its words.
      const parts = String(seg.text || '').trim().split(/\s+/).filter(Boolean);
      if (!parts.length) return;
      const dur = Math.max(0.1, (seg.end - seg.start));
      const per = dur / parts.length;
      parts.forEach((p, i) => words.push({
        word: p,
        start: seg.start + i * per,
        end: seg.start + (i + 1) * per
      }));
    });
    return this.segment(words);
  }
}

window.CaptionSegmenter = CaptionSegmenter;
window.DEFAULT_SEGMENT_SETTINGS = DEFAULT_SEGMENT_SETTINGS;
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CaptionSegmenter, DEFAULT_SEGMENT_SETTINGS };
}
