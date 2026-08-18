/**
 * Project & Film model.
 *
 * A *project* is one job — a client deliverable, a campaign, an episode. Inside
 * it sits a list of *films*: separate edits, each with its own media, captions,
 * caption style and aspect ratio. The aspect ratio stays a per-film property,
 * exactly as it was when the app held a single film; a film is not a "render of
 * another film at a different ratio", it is its own edit with its own audio.
 *
 * This class owns only serialisable state. The live File handles, object URLs
 * and decoded waveforms are session-only and live beside it in app.js, keyed by
 * film id — a project file has to stay a few hundred kilobytes of text, not a
 * copy of the rushes.
 */

const PROJECT_FORMAT = 'taylors-transcriber-project';
const PROJECT_VERSION = 1;
const PROJECT_EXT = '.ttproj';

function projectUid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

class ProjectManager {
  /**
   * @param {Object} opts
   * @param {number} opts.fps
   * @param {Object} opts.defaultPreset  style a brand-new film starts from
   */
  constructor(opts = {}) {
    this.fps = opts.fps || 25;
    this.defaultPreset = opts.defaultPreset || {};
    this.listeners = [];
    this.reset({ silent: true });
  }

  // --- change notification ---------------------------------------------
  onChange(cb) {
    this.listeners.push(cb);
  }

  notify() {
    this.listeners.forEach(cb => cb(this));
  }

  markDirty() {
    if (this.dirty) return;
    this.dirty = true;
    this.notify();
  }

  markSaved(path) {
    this.dirty = false;
    if (path !== undefined) this.path = path || '';
    this.savedAt = new Date().toISOString();
    this.notify();
  }

  // --- lifecycle --------------------------------------------------------
  reset(opts = {}) {
    this.name = opts.name || 'Untitled Project';
    this.path = '';
    this.createdAt = new Date().toISOString();
    this.savedAt = null;
    this.films = [];
    this.activeId = null;

    const first = this.makeFilm({ name: 'Film 1' });
    this.films.push(first);
    this.activeId = first.id;
    this.dirty = false;

    if (!opts.silent) this.notify();
    return this;
  }

  /** A blank film record. Everything a film owns is on this object. */
  makeFilm(init = {}) {
    return {
      id: init.id || projectUid('film'),
      name: init.name || `Film ${this.films.length + 1}`,
      aspectId: init.aspectId || '16x9',
      preset: init.preset ? { ...init.preset } : { ...this.defaultPreset },
      subtitles: Array.isArray(init.subtitles) ? init.subtitles.map(s => ({ ...s })) : [],
      selectedId: init.selectedId || null,
      // Descriptor only — the File itself cannot live in a text project file,
      // so re-opening a project asks for the media to be relinked.
      media: init.media ? { ...init.media } : null,
      // The raw transcription, kept so the segmentation sliders can re-cut it
      // in a later session without paying for another model run.
      transcription: init.transcription || null,
      segment: {
        maxCharsPerLine: 42,
        maxLines: 2,
        maxDurationSec: 6,
        ...(init.segment || {})
      },
      zoom: init.zoom || 50,
      playhead: init.playhead || 0
    };
  }

  // --- film CRUD --------------------------------------------------------
  getFilms() {
    return this.films;
  }

  getFilm(id) {
    return this.films.find(f => f.id === id) || null;
  }

  getActive() {
    return this.getFilm(this.activeId) || this.films[0] || null;
  }

  activeIndex() {
    return Math.max(0, this.films.findIndex(f => f.id === this.activeId));
  }

  addFilm(init = {}) {
    const film = this.makeFilm(init);
    this.films.push(film);
    this.dirty = true;
    this.notify();
    return film;
  }

  /**
   * A full copy, captions included. This is the cheap route to "same dialogue,
   * different ratio" without pretending a film owns a set of ratios: you get a
   * second, independent edit that happens to start identical to the first.
   */
  duplicateFilm(id) {
    const src = this.getFilm(id);
    if (!src) return null;

    const copy = this.makeFilm({
      ...src,
      id: null,
      name: this.uniqueName(`${src.name} copy`),
      // Fresh caption ids: two films must never share one, or selecting a line
      // in one would highlight a line in the other.
      subtitles: src.subtitles.map((s, i) => ({ ...s, id: `sub_${projectUid('c')}_${i}` })),
      selectedId: null
    });

    this.films.splice(this.films.indexOf(src) + 1, 0, copy);
    this.dirty = true;
    this.notify();
    return copy;
  }

  removeFilm(id) {
    if (this.films.length <= 1) return false; // a project always holds one film
    const idx = this.films.findIndex(f => f.id === id);
    if (idx === -1) return false;

    this.films.splice(idx, 1);
    if (this.activeId === id) {
      this.activeId = this.films[Math.min(idx, this.films.length - 1)].id;
    }
    this.dirty = true;
    this.notify();
    return true;
  }

  renameFilm(id, name) {
    const film = this.getFilm(id);
    const clean = String(name || '').trim();
    if (!film || !clean || clean === film.name) return false;
    film.name = this.uniqueName(clean, id);
    this.dirty = true;
    this.notify();
    return true;
  }

  /** Tab strips are unreadable when two tabs carry the same word. */
  uniqueName(wanted, exceptId) {
    const taken = new Set(this.films.filter(f => f.id !== exceptId).map(f => f.name));
    if (!taken.has(wanted)) return wanted;
    let n = 2;
    while (taken.has(`${wanted} ${n}`)) n++;
    return `${wanted} ${n}`;
  }

  setActive(id) {
    if (!this.getFilm(id) || id === this.activeId) return false;
    this.activeId = id;
    this.notify();
    return true;
  }

  /** Step through the tab strip. Wraps, so `]` on the last film lands on the first. */
  stepActive(delta) {
    if (this.films.length < 2) return null;
    const next = (this.activeIndex() + delta + this.films.length) % this.films.length;
    const film = this.films[next];
    this.setActive(film.id);
    return film;
  }

  moveFilm(id, delta) {
    const idx = this.films.findIndex(f => f.id === id);
    const target = idx + delta;
    if (idx === -1 || target < 0 || target >= this.films.length) return false;
    const [film] = this.films.splice(idx, 1);
    this.films.splice(target, 0, film);
    this.dirty = true;
    this.notify();
    return true;
  }

  setName(name) {
    const clean = String(name || '').trim();
    if (!clean || clean === this.name) return false;
    this.name = clean;
    this.dirty = true;
    this.notify();
    return true;
  }

  /** Films whose media descriptor has no live file attached in this session. */
  unlinkedFilms(hasFile) {
    return this.films.filter(f => f.media && f.media.name && !hasFile(f.id));
  }

  // --- serialisation ----------------------------------------------------
  /**
   * Per-caption `words` arrays are dropped: they are re-derivable from the
   * stored transcription and would multiply the file size for no gain. The
   * `uncertain` list the review filter reads is small, so it stays.
   */
  toJSON() {
    return {
      format: PROJECT_FORMAT,
      version: PROJECT_VERSION,
      name: this.name,
      fps: this.fps,
      createdAt: this.createdAt,
      savedAt: new Date().toISOString(),
      activeFilmId: this.activeId,
      films: this.films.map(f => ({
        id: f.id,
        name: f.name,
        aspectId: f.aspectId,
        preset: f.preset,
        media: f.media,
        segment: f.segment,
        zoom: f.zoom,
        playhead: f.playhead,
        selectedId: f.selectedId,
        transcription: f.transcription,
        subtitles: f.subtitles.map(s => ({
          id: s.id,
          start: s.start,
          end: s.end,
          text: s.text,
          speaker: s.speaker || '',
          uncertain: s.uncertain && s.uncertain.length ? s.uncertain : undefined
        }))
      }))
    };
  }

  serialize() {
    return JSON.stringify(this.toJSON(), null, 2);
  }

  /**
   * Replaces the whole project from parsed JSON. Throws with a readable message
   * rather than half-loading something that is not one of our files.
   */
  load(data) {
    if (!data || typeof data !== 'object') {
      throw new Error('That file is not a Taylor\'s Transcriber project.');
    }
    if (data.format !== PROJECT_FORMAT) {
      throw new Error('That file is not a Taylor\'s Transcriber project.');
    }
    if (Number(data.version) > PROJECT_VERSION) {
      throw new Error(
        `This project was written by a newer version of the app (format ${data.version}). Update before opening it.`);
    }
    if (!Array.isArray(data.films) || data.films.length === 0) {
      throw new Error('That project file contains no films.');
    }

    this.name = data.name || 'Untitled Project';
    this.createdAt = data.createdAt || new Date().toISOString();
    this.savedAt = data.savedAt || null;
    this.films = [];
    data.films.forEach(f => this.films.push(this.makeFilm(f)));

    this.activeId = this.getFilm(data.activeFilmId) ? data.activeFilmId : this.films[0].id;
    this.dirty = false;
    this.notify();
    return this;
  }

  /** Filesystem-safe stem for the project file and for export filenames. */
  static slug(text, fallback = 'untitled') {
    const clean = String(text || '')
      .trim()
      .replace(/[^\w\-. ]+/g, '')
      .replace(/\s+/g, '_')
      .replace(/_{2,}/g, '_')
      .replace(/^[._]+|[._]+$/g, '');
    return clean || fallback;
  }
}

window.ProjectManager = ProjectManager;
window.PROJECT_EXT = PROJECT_EXT;
window.PROJECT_FORMAT = PROJECT_FORMAT;
