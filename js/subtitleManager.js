/**
 * Subtitle Manager
 * Handles subtitles data store, 25 FPS timecode utilities, SRT/VTT parsing and export
 */

class SubtitleManager {
  constructor(fps = 25) {
    this.fps = fps;
    this.subtitles = [];
    this.selectedId = null;
    this.listeners = [];
  }

  onChange(callback) {
    this.listeners.push(callback);
  }

  notify() {
    this.listeners.forEach(cb => cb(this.subtitles, this.selectedId));
  }

  // --- Timecode Helpers (25 FPS Default) ---
  secondsToTimecode(seconds, fps = this.fps) {
    if (isNaN(seconds) || seconds < 0) seconds = 0;
    const totalFrames = Math.floor(seconds * fps);
    const frames = totalFrames % fps;
    const totalSeconds = Math.floor(totalFrames / fps);
    const secs = totalSeconds % 60;
    const totalMinutes = Math.floor(totalSeconds / 60);
    const mins = totalMinutes % 60;
    const hrs = Math.floor(totalMinutes / 60);

    const pad = (n) => n.toString().padStart(2, '0');
    return `${pad(hrs)}:${pad(mins)}:${pad(secs)}:${pad(frames)}`;
  }

  timecodeToSeconds(tc, fps = this.fps) {
    if (!tc) return 0;
    // Format HH:MM:SS:FF or HH:MM:SS,mmm or MM:SS.mmm
    const cleanTc = tc.trim().replace(',', '.');
    const parts = cleanTc.split(':');
    
    if (parts.length === 4) {
      const hrs = parseFloat(parts[0]) || 0;
      const mins = parseFloat(parts[1]) || 0;
      const secs = parseFloat(parts[2]) || 0;
      const frames = parseFloat(parts[3]) || 0;
      return hrs * 3600 + mins * 60 + secs + (frames / fps);
    } else if (parts.length === 3) {
      const hrs = parseFloat(parts[0]) || 0;
      const mins = parseFloat(parts[1]) || 0;
      const secs = parseFloat(parts[2]) || 0;
      return hrs * 3600 + mins * 60 + secs;
    } else if (parts.length === 2) {
      const mins = parseFloat(parts[0]) || 0;
      const secs = parseFloat(parts[1]) || 0;
      return mins * 60 + secs;
    }
    return parseFloat(cleanTc) || 0;
  }

  // --- Subtitle CRUD ---
  getSubtitles() {
    return this.subtitles;
  }

  setSubtitles(newSubs) {
    this.subtitles = newSubs.map((sub, i) => ({
      id: sub.id || 'sub_' + Date.now() + '_' + i,
      start: typeof sub.start === 'number' ? sub.start : this.timecodeToSeconds(sub.start),
      end: typeof sub.end === 'number' ? sub.end : this.timecodeToSeconds(sub.end),
      text: sub.text || '',
      speaker: sub.speaker || '',
      // Carried through from transcription so the review UI can point at the
      // words the model was unsure about. Absent for hand-authored captions.
      words: Array.isArray(sub.words) ? sub.words : undefined,
      uncertain: Array.isArray(sub.uncertain) ? sub.uncertain : undefined
    })).sort((a, b) => a.start - b.start);
    this.notify();
  }

  /** Captions carrying at least one word the model was unsure about. */
  uncertainSubtitles() {
    return this.subtitles.filter(s => s.uncertain && s.uncertain.length);
  }

  addSubtitle(startSec, endSec, text = 'New Caption Line', speaker = '') {
    const newSub = {
      id: 'sub_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      start: startSec,
      end: endSec > startSec ? endSec : startSec + 2.0,
      text: text,
      speaker: speaker
    };
    this.subtitles.push(newSub);
    this.subtitles.sort((a, b) => a.start - b.start);
    this.selectedId = newSub.id;
    this.notify();
    return newSub;
  }

  /**
   * @param {Object} opts  { silent: true } updates the model without firing a
   *   re-render — used while typing in the caption box so the textarea is not
   *   torn down and rebuilt on every keystroke.
   */
  updateSubtitle(id, updates, opts = {}) {
    const sub = this.subtitles.find(s => s.id === id);
    if (!sub) return false;

    if (updates.start !== undefined && !isNaN(updates.start)) sub.start = Math.max(0, updates.start);
    if (updates.end !== undefined && !isNaN(updates.end)) sub.end = Math.max(sub.start + 0.1, updates.end);
    if (updates.text !== undefined) sub.text = updates.text;
    if (updates.speaker !== undefined) sub.speaker = updates.speaker;

    this.subtitles.sort((a, b) => a.start - b.start);
    if (!opts.silent) this.notify();
    return true;
  }

  deleteSubtitle(id) {
    this.subtitles = this.subtitles.filter(s => s.id !== id);
    if (this.selectedId === id) this.selectedId = null;
    this.notify();
  }

  selectSubtitle(id) {
    // Re-selecting the same line must not fire a change: listeners re-render the
    // list, and a re-render that restores focus would call back in here forever.
    if (this.selectedId === id) return false;
    this.selectedId = id;
    this.notify();
    return true;
  }

  /**
   * The caption on screen at `timeSec`.
   *
   * Where two captions overlap the later-starting one wins. Returning the first
   * match instead meant an overlapping caption was silently never displayed —
   * and never exported — which is a confusing way to lose a line.
   */
  getActiveSubtitleAt(timeSec) {
    let active = null;
    for (const sub of this.subtitles) {
      if (timeSec >= sub.start && timeSec <= sub.end) {
        if (!active || sub.start >= active.start) active = sub;
      }
    }
    return active;
  }

  /** Pairs of captions whose spans intersect. Empty when the track is clean. */
  findOverlaps() {
    const out = [];
    for (let i = 0; i < this.subtitles.length; i++) {
      for (let j = i + 1; j < this.subtitles.length; j++) {
        if (this.subtitles[j].start >= this.subtitles[i].end) break;
        out.push([this.subtitles[i].id, this.subtitles[j].id]);
      }
    }
    return out;
  }

  splitSubtitleAt(id, timeSec) {
    const sub = this.subtitles.find(s => s.id === id);
    if (!sub || timeSec <= sub.start || timeSec >= sub.end) return false;

    const originalEnd = sub.end;
    const words = sub.text.trim().split(/\s+/);
    const midIndex = Math.max(1, Math.floor(words.length / 2));
    const text1 = words.slice(0, midIndex).join(' ') || sub.text;
    const text2 = words.slice(midIndex).join(' ') || '...';

    sub.end = timeSec;
    sub.text = text1;

    this.addSubtitle(timeSec + (1 / this.fps), originalEnd, text2, sub.speaker);
    return true;
  }

  mergeSubtitle(id) {
    const idx = this.subtitles.findIndex(s => s.id === id);
    if (idx === -1 || idx >= this.subtitles.length - 1) return false;

    const currentSub = this.subtitles[idx];
    const nextSub = this.subtitles[idx + 1];

    currentSub.end = nextSub.end;
    currentSub.text = (currentSub.text.trim() + ' ' + nextSub.text.trim()).trim();

    this.subtitles.splice(idx + 1, 1);
    this.notify();
    return true;
  }

  rippleDeleteSubtitle(id) {
    const idx = this.subtitles.findIndex(s => s.id === id);
    if (idx === -1) return;

    const sub = this.subtitles[idx];
    const duration = sub.end - sub.start;

    // Shift all subsequent subtitles back by duration
    for (let i = idx + 1; i < this.subtitles.length; i++) {
      this.subtitles[i].start = Math.max(0, this.subtitles[i].start - duration);
      this.subtitles[i].end = Math.max(0.1, this.subtitles[i].end - duration);
    }

    this.subtitles.splice(idx, 1);
    if (this.selectedId === id) this.selectedId = null;
    this.notify();
  }

  shiftAllTimecodes(offsetSec) {
    if (isNaN(offsetSec) || offsetSec === 0) return;
    this.subtitles.forEach(sub => {
      sub.start = Math.max(0, sub.start + offsetSec);
      sub.end = Math.max(sub.start + 0.1, sub.end + offsetSec);
    });
    this.notify();
  }

  clearAll() {
    this.subtitles = [];
    this.selectedId = null;
    this.notify();
  }

  // --- Premiere Pro Sequence XML (FCP7 xmeml) Export ---
  /**
   * Emits a well-formed xmeml v4 sequence. Note this uses <clipitem>, the
   * element Premiere actually reads — <trackitem> is not part of the schema and
   * imports as an empty sequence.
   */
  exportPremiereXml(project = { width: 1920, height: 1080 }) {
    const fps = this.fps;
    const esc = (s) => String(s || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

    const lastEnd = this.subtitles.length
      ? Math.max(...this.subtitles.map(s => s.end))
      : 0;
    const sequenceDuration = Math.max(1, Math.ceil(lastEnd * fps));

    const rate = `<rate><timebase>${fps}</timebase><ntsc>FALSE</ntsc></rate>`;

    const clipNodes = this.subtitles.map((sub, i) => {
      const inFrame = Math.round(sub.start * fps);
      const outFrame = Math.max(inFrame + 1, Math.round(sub.end * fps));
      const label = esc((sub.text || '').replace(/\s+/g, ' ').trim().slice(0, 80) || `Caption ${i + 1}`);
      return `          <clipitem id="clipitem-${i + 1}">
            <name>${label}</name>
            <enabled>TRUE</enabled>
            <duration>${outFrame - inFrame}</duration>
            ${rate}
            <start>${inFrame}</start>
            <end>${outFrame}</end>
            <in>0</in>
            <out>${outFrame - inFrame}</out>
            <comments><mastercomment1>${label}</mastercomment1></comments>
          </clipitem>`;
    }).join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
  <sequence id="subtitler-sequence">
    <name>Subtitled Sequence (${fps} FPS)</name>
    <duration>${sequenceDuration}</duration>
    ${rate}
    <media>
      <video>
        <format>
          <samplecharacteristics>
            ${rate}
            <width>${project.width}</width>
            <height>${project.height}</height>
            <pixelaspectratio>square</pixelaspectratio>
          </samplecharacteristics>
        </format>
        <track>
${clipNodes}
        </track>
      </video>
    </media>
  </sequence>
</xmeml>`;
  }

  // --- SRT & WebVTT Import/Export ---
  parseSRT(srtText) {
    // Strip a UTF-8 BOM and any WEBVTT header/NOTE blocks so the same parser
    // handles .srt and .vtt.
    const cleaned = String(srtText || '')
      .replace(/^﻿/, '')
      .replace(/^WEBVTT[^\n]*\n(?:[^\n]*\n)*?(?=\n)/i, '')
      .replace(/^NOTE[^\n]*(?:\n[^\n]+)*\n?/gim, '');

    // NOTE: the lookahead must end on a real end-of-input (`$`), not a literal
    // "$", otherwise the final cue in a file with no trailing blank line is
    // silently dropped.
    const pattern = /(\d+)?\s*\r?\n?(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}|\d{1,2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}|\d{1,2}:\d{2}[,.]\d{1,3})[^\n]*\r?\n([\s\S]*?)(?=\r?\n\s*\r?\n|\s*$)/g;
    const subs = [];
    let match;
    let idx = 0;

    while ((match = pattern.exec(cleaned)) !== null) {
      const text = match[4].replace(/<[^>]*>/g, '').trim();
      if (!match[2] || !match[3]) continue;
      subs.push({
        id: 'sub_srt_' + (idx++),
        start: this.timecodeToSeconds(match[2]),
        end: this.timecodeToSeconds(match[3]),
        text: text
      });
    }

    if (subs.length === 0) {
      // Fallback simpler regex parser
      const blocks = cleaned.trim().split(/\r?\n\r?\n/);
      blocks.forEach((block, idx) => {
        const lines = block.split(/\r?\n/);
        if (lines.length >= 2) {
          const tcLine = lines.find(l => l.includes('-->'));
          if (tcLine) {
            const [startStr, endStr] = tcLine.split('-->');
            const textLines = lines.slice(lines.indexOf(tcLine) + 1).join('\n');
            subs.push({
              id: 'sub_srt_' + idx,
              start: this.timecodeToSeconds(startStr),
              end: this.timecodeToSeconds(endStr),
              text: textLines.trim()
            });
          }
        }
      });
    }

    this.setSubtitles(subs);
  }

  exportSRT() {
    return this.subtitles.map((sub, i) => {
      const startSrt = this.secondsToSrtTimecode(sub.start);
      const endSrt = this.secondsToSrtTimecode(sub.end);
      return `${i + 1}\n${startSrt} --> ${endSrt}\n${sub.text}\n`;
    }).join('\n');
  }

  exportVTT() {
    const body = this.subtitles.map((sub, i) => {
      const startVtt = this.secondsToSrtTimecode(sub.start).replace(',', '.');
      const endVtt = this.secondsToSrtTimecode(sub.end).replace(',', '.');
      return `${i + 1}\n${startVtt} --> ${endVtt}\n${sub.text}\n`;
    }).join('\n');
    return `WEBVTT\n\n${body}`;
  }

  secondsToSrtTimecode(sec) {
    if (isNaN(sec) || sec < 0) sec = 0;
    const hrs = Math.floor(sec / 3600);
    const mins = Math.floor((sec % 3600) / 60);
    const secs = Math.floor(sec % 60);
    const ms = Math.floor((sec % 1) * 1000);
    const pad = (n, len = 2) => n.toString().padStart(len, '0');
    return `${pad(hrs)}:${pad(mins)}:${pad(secs)},${pad(ms, 3)}`;
  }
}

window.SubtitleManager = SubtitleManager;
