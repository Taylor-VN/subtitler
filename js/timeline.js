/**
 * Timeline Controller & Renderer
 * Interactive Multi-track Timeline with Drag, Trim Handles, Snapping, 25 FPS Ruler, and Waveform
 */

class TimelineController {
  constructor(rulerCanvas, waveformCanvas, subtitleTrackContainer, playheadElement, subtitleManager, videoPlayer, fps = 25) {
    this.rulerCanvas = rulerCanvas;
    this.waveformCanvas = waveformCanvas;
    this.subtitleContainer = subtitleTrackContainer;
    this.playhead = playheadElement;
    this.subManager = subtitleManager;
    this.player = videoPlayer;
    this.fps = fps;

    this.zoomLevel = 50; // Pixels per second
    this.duration = 60;  // Timeline total duration in seconds (default 60s)
    this.isDraggingPlayhead = false;
    this.draggedClipInfo = null;

    this.rulerCtx = this.rulerCanvas.getContext('2d');
    this.waveformCtx = this.waveformCanvas.getContext('2d');

    this.initEvents();
  }

  initEvents() {
    this.subManager.onChange(() => {
      // Grow the timeline if captions now run past the end of it.
      const wanted = this.computeDuration(this.player.getDuration());
      if (Math.abs(wanted - this.duration) > 0.5) {
        this.duration = wanted;
        this.resizeAndDraw();
      } else {
        this.renderClips();
      }
    });

    this.player.onTimeUpdate((currentTime, duration) => {
      const wanted = this.computeDuration(duration);
      if (Math.abs(wanted - this.duration) > 0.5) {
        this.duration = wanted;
        this.resizeAndDraw();
      }
      this.updatePlayheadPosition(currentTime);
    });

    // Ruler & Playhead click / scrub
    this.rulerCanvas.addEventListener('mousedown', (e) => {
      this.isDraggingPlayhead = true;
      this.scrubPlayheadFromEvent(e);
    });

    if (this.playhead) {
      this.playhead.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        this.isDraggingPlayhead = true;
        document.body.style.cursor = 'ew-resize';
      });
    }

    const tracksWrapper = document.getElementById('tracksWrapper');
    if (tracksWrapper) {
      tracksWrapper.addEventListener('mousedown', (e) => {
        if (!e.target.classList.contains('subtitle-clip') && !e.target.classList.contains('clip-handle') && !e.target.classList.contains('clip-text')) {
          this.isDraggingPlayhead = true;
          this.scrubPlayheadFromEvent(e);
        }
      });
    }

    window.addEventListener('mousemove', (e) => {
      if (this.isDraggingPlayhead) {
        this.scrubPlayheadFromEvent(e);
      } else if (this.draggedClipInfo) {
        this.handleClipDragMove(e);
      }
    });

    window.addEventListener('mouseup', () => {
      this.isDraggingPlayhead = false;
      if (this.draggedClipInfo) {
        this.draggedClipInfo = null;
      }
      document.body.style.cursor = 'default';
    });

    window.addEventListener('resize', () => this.resizeAndDraw());
    setTimeout(() => this.resizeAndDraw(), 100);
  }

  setZoom(pxPerSec) {
    this.zoomLevel = Math.max(10, Math.min(300, pxPerSec));
    this.resizeAndDraw();
    return this.zoomLevel;
  }

  /** Timeline must always be long enough to hold the media AND every caption. */
  computeDuration(mediaDuration) {
    const subs = this.subManager.getSubtitles();
    const lastCaptionEnd = subs.length ? Math.max(...subs.map(s => s.end)) : 0;
    const media = (mediaDuration && isFinite(mediaDuration) && mediaDuration > 0)
      ? mediaDuration
      : this.player.getDuration();
    return Math.max(30, media, lastCaptionEnd + 5);
  }

  resizeAndDraw() {
    this.duration = this.computeDuration(this.player.getDuration());
    const totalWidth = Math.max(800, this.duration * this.zoomLevel);
    
    // Resize Canvas elements
    this.rulerCanvas.width = totalWidth;
    this.rulerCanvas.height = 24;

    this.waveformCanvas.width = totalWidth;
    this.waveformCanvas.height = 50;

    this.subtitleContainer.style.width = `${totalWidth}px`;

    this.drawRuler();
    this.drawWaveform();
    this.renderClips();
    this.updatePlayheadPosition(this.player.getCurrentTime());
  }

  // --- Draw 25 FPS Timeline Ruler ---
  drawRuler() {
    const ctx = this.rulerCtx;
    const w = this.rulerCanvas.width;
    const h = this.rulerCanvas.height;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = '#444444';
    ctx.fillStyle = '#9e9e9e';
    ctx.font = '10px "Roboto Mono", monospace';

    // Pick the tick spacing that keeps labels from colliding at this zoom.
    const labelWidth = ctx.measureText('00:00:00:00').width + 14;
    const candidates = [0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const majorStep = candidates.find(step => step * this.zoomLevel >= labelWidth)
      || candidates[candidates.length - 1];
    // Minor ticks subdivide the major step without ever going below one frame.
    const minorStep = Math.max(1 / this.fps, majorStep / 5);

    for (let sec = 0; sec <= this.duration + majorStep; sec += majorStep) {
      const x = sec * this.zoomLevel;

      ctx.beginPath();
      ctx.moveTo(x, h - 10);
      ctx.lineTo(x, h);
      ctx.stroke();

      ctx.fillText(this.subManager.secondsToTimecode(sec, this.fps), x + 4, 12);

      // Minor ticks between this label and the next
      for (let t = sec + minorStep; t < sec + majorStep - 1e-9; t += minorStep) {
        const mx = t * this.zoomLevel;
        ctx.beginPath();
        ctx.moveTo(mx, h - 4);
        ctx.lineTo(mx, h);
        ctx.stroke();
      }

      // Individual frame ticks only once a frame is comfortably wide
      if (this.zoomLevel / this.fps >= 4) {
        for (let f = 1; f < majorStep * this.fps; f++) {
          const fx = (sec + f / this.fps) * this.zoomLevel;
          ctx.beginPath();
          ctx.moveTo(fx, h - 2);
          ctx.lineTo(fx, h);
          ctx.stroke();
        }
      }
    }
  }

  // --- Draw Synthetic / Loaded Audio Waveform ---
  drawWaveform() {
    const ctx = this.waveformCtx;
    const w = this.waveformCanvas.width;
    const h = this.waveformCanvas.height;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#151515';
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(0, 210, 255, 0.6)';
    ctx.lineWidth = 1;

    const barWidth = 3;
    const gap = 1;
    const step = barWidth + gap;
    const totalBars = Math.floor(w / step);

    ctx.beginPath();
    for (let i = 0; i < totalBars; i++) {
      const x = i * step;
      const timeSec = x / this.zoomLevel;
      const amp = this.peaks
        ? this.peakAt(timeSec) * (h * 0.46)
        // Deterministic stand-in pattern — no Math.random(), so redraws are stable.
        : Math.abs(Math.sin(i * 0.15) * Math.cos(i * 0.04)) * (h * 0.4);

      ctx.moveTo(x, (h / 2) - amp);
      ctx.lineTo(x, (h / 2) + amp);
    }
    ctx.stroke();
  }

  /** Peak amplitude (0..1) at a given time, from the decoded peaks array. */
  peakAt(timeSec) {
    if (!this.peaks || !this.peaksDuration) return 0;
    const idx = Math.floor((timeSec / this.peaksDuration) * this.peaks.length);
    if (idx < 0 || idx >= this.peaks.length) return 0;
    return this.peaks[idx];
  }

  /** Decode the loaded media's audio and build a real peaks array. */
  async loadAudioWaveform(file) {
    this.peaks = null;
    this.peaksDuration = 0;
    this.drawWaveform();
    if (!file) return;

    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const arrayBuffer = await file.arrayBuffer();
      const audioCtx = new AudioCtx();
      const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

      const channel = audioBuffer.getChannelData(0);
      const bucketCount = 4000;
      const samplesPerBucket = Math.max(1, Math.floor(channel.length / bucketCount));
      const peaks = new Float32Array(bucketCount);

      for (let b = 0; b < bucketCount; b++) {
        const startIdx = b * samplesPerBucket;
        let peak = 0;
        for (let s = 0; s < samplesPerBucket; s++) {
          const v = Math.abs(channel[startIdx + s] || 0);
          if (v > peak) peak = v;
        }
        peaks[b] = peak;
      }

      this.peaks = peaks;
      this.peaksDuration = audioBuffer.duration;
      audioCtx.close();
      this.drawWaveform();
    } catch (e) {
      console.warn('Could not decode audio for the waveform:', e);
      this.peaks = null;
      this.drawWaveform();
    }
  }

  // --- Update Playhead Position ---
  updatePlayheadPosition(currentTimeSec) {
    const x = 90 + (currentTimeSec * this.zoomLevel); // 90px track header offset
    this.playhead.style.left = `${x}px`;
  }

  scrubPlayheadFromEvent(e) {
    const container = document.getElementById('timelineContainer');
    const rect = this.rulerCanvas.getBoundingClientRect();
    let clickX = e.clientX - rect.left;
    if (isNaN(clickX) || clickX < 0) clickX = 0;

    const targetSec = Math.max(0, clickX / this.zoomLevel);
    this.player.seek(targetSec);
  }

  // --- Subtitle Track Clips Rendering & Dragging ---
  renderClips() {
    this.subtitleContainer.innerHTML = '';
    const subs = this.subManager.getSubtitles();
    const selectedId = this.subManager.selectedId;

    subs.forEach(sub => {
      const clipEl = document.createElement('div');
      clipEl.className = `subtitle-clip ${sub.id === selectedId ? 'selected' : ''}`;
      
      const leftPx = sub.start * this.zoomLevel;
      const widthPx = Math.max(16, (sub.end - sub.start) * this.zoomLevel);

      clipEl.style.left = `${leftPx}px`;
      clipEl.style.width = `${widthPx}px`;
      clipEl.dataset.id = sub.id;

      // Left Trim Handle
      const leftHandle = document.createElement('div');
      leftHandle.className = 'clip-handle handle-left';
      leftHandle.title = 'Trim Start Point';
      leftHandle.addEventListener('mousedown', (e) => this.startClipDrag(e, sub.id, 'trim-left'));

      // Right Trim Handle
      const rightHandle = document.createElement('div');
      rightHandle.className = 'clip-handle handle-right';
      rightHandle.title = 'Trim End Point';
      rightHandle.addEventListener('mousedown', (e) => this.startClipDrag(e, sub.id, 'trim-right'));

      // Text Label
      const textEl = document.createElement('span');
      textEl.className = 'clip-text';
      textEl.textContent = sub.text || '(empty)';

      clipEl.appendChild(leftHandle);
      clipEl.appendChild(textEl);
      clipEl.appendChild(rightHandle);

      // Clip Body Drag
      clipEl.addEventListener('mousedown', (e) => {
        if (e.target.classList.contains('clip-handle')) return;
        this.subManager.selectSubtitle(sub.id);
        this.startClipDrag(e, sub.id, 'move');
      });

      clipEl.addEventListener('dblclick', () => {
        const itemEl = document.querySelector(`.caption-item[data-id="${sub.id}"] .caption-textarea`);
        if (itemEl) {
          itemEl.focus();
          itemEl.select();
        }
      });

      this.subtitleContainer.appendChild(clipEl);
    });
  }

  startClipDrag(e, subId, mode) {
    e.stopPropagation();
    e.preventDefault();
    const sub = this.subManager.getSubtitles().find(s => s.id === subId);
    if (!sub) return;

    this.draggedClipInfo = {
      id: subId,
      mode: mode, // 'move', 'trim-left', 'trim-right'
      startX: e.clientX,
      initialStart: sub.start,
      initialEnd: sub.end,
      initialDuration: sub.end - sub.start
    };

    document.body.style.cursor = mode === 'move' ? 'grabbing' : 'ew-resize';
  }

  /**
   * Candidate snap points: the playhead plus every *other* clip's in/out point.
   * The threshold is in pixels so snapping feels the same at any zoom level.
   */
  snapTime(timeSec, excludeId) {
    const snapEnabled = document.getElementById('snapToGrid')?.checked !== false;
    if (!snapEnabled) return timeSec;

    const thresholdSec = 8 / this.zoomLevel; // 8 screen pixels
    const candidates = [this.player.getCurrentTime(), 0];
    this.subManager.getSubtitles().forEach(s => {
      if (s.id === excludeId) return;
      candidates.push(s.start, s.end);
    });

    let best = timeSec;
    let bestDist = thresholdSec;
    candidates.forEach(c => {
      const dist = Math.abs(timeSec - c);
      if (dist < bestDist) {
        bestDist = dist;
        best = c;
      }
    });
    return best;
  }

  handleClipDragMove(e) {
    if (!this.draggedClipInfo) return;
    const { id, mode, startX, initialStart, initialEnd, initialDuration } = this.draggedClipInfo;
    const deltaPx = e.clientX - startX;
    const deltaSec = deltaPx / this.zoomLevel;

    let newStart = initialStart;
    let newEnd = initialEnd;

    if (mode === 'move') {
      newStart = Math.max(0, this.snapTime(initialStart + deltaSec, id));
      newEnd = newStart + initialDuration;
    } else if (mode === 'trim-left') {
      newStart = Math.max(0, Math.min(initialEnd - 0.1, this.snapTime(initialStart + deltaSec, id)));
      newEnd = initialEnd;
    } else if (mode === 'trim-right') {
      newEnd = Math.max(initialStart + 0.1, this.snapTime(initialEnd + deltaSec, id));
      newStart = initialStart;
    }

    this.subManager.updateSubtitle(id, { start: newStart, end: newEnd });
  }
}

window.TimelineController = TimelineController;
