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
    this.subManager.onChange(() => this.renderClips());

    this.player.onTimeUpdate((currentTime, duration) => {
      if (duration && duration > 0) this.duration = Math.max(30, duration);
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
  }

  resizeAndDraw() {
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
    this.updatePlayheadPosition(this.player.video.currentTime || 0);
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

    const stepSec = this.zoomLevel < 30 ? 5 : (this.zoomLevel < 80 ? 1 : 0.5);

    for (let sec = 0; sec <= this.duration; sec += stepSec) {
      const x = sec * this.zoomLevel;
      ctx.beginPath();
      ctx.moveTo(x, h - 10);
      ctx.lineTo(x, h);
      ctx.stroke();

      const tc = this.subManager.secondsToTimecode(sec, this.fps);
      ctx.fillText(tc, x + 4, 12);

      // Minor frame tick marks @ 25 FPS if zoomed in
      if (this.zoomLevel >= 80) {
        const frameStep = 1 / 25; // 0.04s per frame
        for (let f = 1; f < 25; f++) {
          const fx = (sec + (f * frameStep)) * this.zoomLevel;
          ctx.beginPath();
          ctx.moveTo(fx, h - (f % 5 === 0 ? 6 : 3));
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

    ctx.fillStyle = 'rgba(0, 210, 255, 0.25)';
    ctx.strokeStyle = 'rgba(0, 210, 255, 0.6)';
    ctx.lineWidth = 1;

    // Draw stylized audio waveform bars
    const barWidth = 3;
    const gap = 1;
    const totalBars = Math.floor(w / (barWidth + gap));

    ctx.beginPath();
    for (let i = 0; i < totalBars; i++) {
      const x = i * (barWidth + gap);
      // Pseudo waveform pattern
      const amp = Math.abs(Math.sin(i * 0.15) * Math.cos(i * 0.04) * (h * 0.4)) + (Math.random() * 4);
      const y1 = (h / 2) - amp;
      const y2 = (h / 2) + amp;

      ctx.moveTo(x, y1);
      ctx.lineTo(x, y2);
    }
    ctx.stroke();
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

  handleClipDragMove(e) {
    if (!this.draggedClipInfo) return;
    const { id, mode, startX, initialStart, initialEnd, initialDuration } = this.draggedClipInfo;
    const deltaPx = e.clientX - startX;
    const deltaSec = deltaPx / this.zoomLevel;

    const snapEnabled = document.getElementById('snapToGrid')?.checked !== false;
    const playheadTime = this.player.video.currentTime || 0;

    let newStart = initialStart;
    let newEnd = initialEnd;

    if (mode === 'move') {
      newStart = Math.max(0, initialStart + deltaSec);
      // Snapping to playhead
      if (snapEnabled && Math.abs(newStart - playheadTime) < 0.12) {
        newStart = playheadTime;
      }
      newEnd = newStart + initialDuration;
    } else if (mode === 'trim-left') {
      newStart = Math.max(0, Math.min(initialEnd - 0.1, initialStart + deltaSec));
      if (snapEnabled && Math.abs(newStart - playheadTime) < 0.12) {
        newStart = playheadTime;
      }
    } else if (mode === 'trim-right') {
      newEnd = Math.max(initialStart + 0.1, initialEnd + deltaSec);
      if (snapEnabled && Math.abs(newEnd - playheadTime) < 0.12) {
        newEnd = playheadTime;
      }
    }

    this.subManager.updateSubtitle(id, { start: newStart, end: newEnd });
  }
}

window.TimelineController = TimelineController;
