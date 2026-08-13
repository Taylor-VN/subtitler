/**
 * Video Player & Canvas Subtitle Renderer Engine
 * Handles video transport, frame stepping (@ 25 FPS), playhead callbacks, and canvas text rendering
 */

class VideoPlayerController {
  constructor(videoElement, canvasElement, subtitleManager, presetParser, fps = 25) {
    this.video = videoElement;
    this.canvas = canvasElement;
    this.ctx = this.canvas.getContext('2d');
    this.subManager = subtitleManager;
    this.presetParser = presetParser;
    this.fps = fps;

    this.activePreset = this.presetParser.getPreset('classic_yellow');
    this.onTimeUpdateCallbacks = [];
    this.isPlaying = false;

    this.initEvents();
  }

  initEvents() {
    this.video.addEventListener('timeupdate', () => {
      this.renderOverlay();
      this.onTimeUpdateCallbacks.forEach(cb => cb(this.video.currentTime, this.video.duration));
    });

    this.video.addEventListener('play', () => {
      this.isPlaying = true;
      this.startRenderLoop();
    });

    this.video.addEventListener('pause', () => {
      this.isPlaying = false;
      this.renderOverlay();
    });

    this.video.addEventListener('loadedmetadata', () => {
      this.resizeCanvas();
      this.renderOverlay();
    });

    window.addEventListener('resize', () => this.resizeCanvas());
  }

  resizeCanvas() {
    const rect = this.video.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      this.canvas.width = rect.width;
      this.canvas.height = rect.height;
    }
  }

  loadMedia(file, objectUrl) {
    this.pause();
    this.video.srcObject = null; // Clear synthetic stream so HTML5 video element uses src URL
    this.video.src = objectUrl;
    this.video.load();
    this.syntheticTime = 0;
    this.renderOverlay();
  }

  onTimeUpdate(cb) {
    this.onTimeUpdateCallbacks.push(cb);
  }

  // --- Transport Controls ---
  togglePlay() {
    if (this.isPlaying) {
      this.pause();
    } else {
      this.play();
    }
  }

  play() {
    this.isPlaying = true;
    this.lastFrameTime = performance.now();
    this.video.play().catch(() => {});
    this.startRenderLoop();
  }

  pause() {
    this.isPlaying = false;
    this.lastFrameTime = null;
    this.video.pause();
    this.renderOverlay();
  }

  getCurrentTime() {
    if (this.video.srcObject) {
      return this.syntheticTime || 0;
    }
    return this.video.currentTime || 0;
  }

  getDuration() {
    if (this.video.srcObject) {
      return 30.0; // 30 seconds demo duration
    }
    return this.video.duration || 60.0;
  }

  seek(seconds) {
    const dur = this.getDuration();
    const targetSec = Math.max(0, Math.min(dur, seconds));
    if (this.video.srcObject) {
      this.syntheticTime = targetSec;
    } else {
      this.video.currentTime = targetSec;
    }
    const curr = this.getCurrentTime();
    this.renderOverlay();
    this.onTimeUpdateCallbacks.forEach(cb => cb(curr, dur));
  }

  stepFrame(framesCount = 1) {
    this.pause();
    const frameTime = 1 / this.fps; // 0.04s for 25 FPS
    this.seek(this.getCurrentTime() + (framesCount * frameTime));
  }

  jumpToPrevSubtitle() {
    const curr = this.getCurrentTime();
    const subs = this.subManager.getSubtitles();
    const prev = [...subs].reverse().find(s => s.start < curr - 0.2);
    if (prev) {
      this.subManager.selectSubtitle(prev.id);
      this.seek(prev.start);
    } else if (subs.length > 0) {
      this.seek(subs[0].start);
    }
  }

  jumpToNextSubtitle() {
    const curr = this.getCurrentTime();
    const subs = this.subManager.getSubtitles();
    const next = subs.find(s => s.start > curr + 0.2);
    if (next) {
      this.subManager.selectSubtitle(next.id);
      this.seek(next.start);
    }
  }

  toggleLoopRegion() {
    this.isLoopingRegion = !this.isLoopingRegion;
    return this.isLoopingRegion;
  }

  toggleMute() {
    this.video.muted = !this.video.muted;
    return this.video.muted;
  }

  toggleOverlayHide() {
    this.isOverlayHidden = !this.isOverlayHidden;
    this.renderOverlay();
    return this.isOverlayHidden;
  }

  toggleFullscreen() {
    const container = document.getElementById('viewportContainer');
    if (!document.fullscreenElement) {
      container.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }

  startRenderLoop() {
    if (!this.isPlaying) return;

    const now = performance.now();
    if (this.lastFrameTime) {
      const deltaSec = (now - this.lastFrameTime) / 1000;
      if (this.video.srcObject && deltaSec > 0) {
        this.syntheticTime = (this.syntheticTime || 0) + (deltaSec * (this.playbackSpeed || 1.0));
        if (this.syntheticTime >= this.getDuration()) {
          this.syntheticTime = 0; // loop
        }
      }
    }
    this.lastFrameTime = now;

    // Region Looping logic
    const curr = this.getCurrentTime();
    if (this.isLoopingRegion && this.subManager.selectedId) {
      const activeSub = this.subManager.getSubtitles().find(s => s.id === this.subManager.selectedId);
      if (activeSub && curr >= activeSub.end) {
        this.seek(activeSub.start);
      }
    }

    this.renderOverlay();

    const dur = this.getDuration();
    this.onTimeUpdateCallbacks.forEach(cb => cb(curr, dur));

    requestAnimationFrame(() => this.startRenderLoop());
  }
    const activeSub = this.subManager.getActiveSubtitleAt(currentTime);

    if (!activeSub || !activeSub.text.trim()) return;

    const preset = this.activePreset;
    let text = activeSub.text.trim();
    if (preset.textUppercase) text = text.toUpperCase();

    // Scale font size based on canvas height (reference 1080p canvas)
    const scaleFactor = h / 720;
    const fontSize = Math.round((preset.fontSize || 42) * scaleFactor);
    const fontStyle = preset.fontStyleItalic ? 'italic ' : '';
    const fontWeight = preset.fontWeightBold ? 'bold ' : 'normal ';
    ctx.font = `${fontStyle}${fontWeight}${fontSize}px "${preset.fontFamily}", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Calculate line wraps
    const maxTextWidth = w * 0.85;
    const lines = this.wrapText(ctx, text, maxTextWidth);
    const lineHeight = fontSize * 1.3;
    const totalTextHeight = lines.length * lineHeight;

    // Alignment & Position Math
    let posX = w / 2;
    let posY = h - (preset.bottomMargin * scaleFactor) - (totalTextHeight / 2);

    const align = preset.align || 'bottom-center';
    if (align.includes('left')) {
      posX = w * 0.1;
      ctx.textAlign = 'left';
    } else if (align.includes('right')) {
      posX = w * 0.9;
      ctx.textAlign = 'right';
    }

    if (align.includes('top')) {
      posY = (preset.bottomMargin * scaleFactor) + (totalTextHeight / 2);
    } else if (align.includes('center') && !align.includes('bottom') && !align.includes('top')) {
      posY = h / 2;
    }

    // Animation effects: Fade / Pop / Karaoke
    let animAlpha = 1.0;
    let animScale = 1.0;

    if (preset.animationPreset === 'fade') {
      const fadeIn = Math.min(1.0, (currentTime - activeSub.start) / 0.2);
      const fadeOut = Math.min(1.0, (activeSub.end - currentTime) / 0.2);
      animAlpha = Math.max(0, Math.min(fadeIn, fadeOut));
    } else if (preset.animationPreset === 'pop') {
      const elapsed = currentTime - activeSub.start;
      if (elapsed < 0.15) {
        animScale = 0.8 + (elapsed / 0.15) * 0.2;
      }
    }

    ctx.save();
    ctx.globalAlpha = animAlpha;

    if (animScale !== 1.0) {
      ctx.translate(posX, posY);
      ctx.scale(animScale, animScale);
      ctx.translate(-posX, -posY);
    }

    // Render Background Box
    if (preset.enableBgBox) {
      const padding = (preset.bgBoxPadding || 12) * scaleFactor;
      let maxLineWidth = 0;
      lines.forEach(l => {
        const mw = ctx.measureText(l).width;
        if (mw > maxLineWidth) maxLineWidth = mw;
      });

      const boxWidth = maxLineWidth + (padding * 2);
      const boxHeight = totalTextHeight + (padding * 2);

      let boxX = posX - (boxWidth / 2);
      if (ctx.textAlign === 'left') boxX = posX - padding;
      if (ctx.textAlign === 'right') boxX = posX - maxLineWidth - padding;

      const boxY = posY - (totalTextHeight / 2) - padding;

      ctx.fillStyle = this.hexToRgba(preset.bgBoxColor, (preset.bgBoxOpacity || 75) / 100);
      this.drawRoundedRect(ctx, boxX, boxY, boxWidth, boxHeight, 6 * scaleFactor);
      ctx.fill();
    }

    // Render Each Line of Text
    lines.forEach((lineStr, lineIndex) => {
      const lineY = posY - (totalTextHeight / 2) + (lineIndex * lineHeight) + (lineHeight / 2);

      // Drop Shadow
      if (preset.enableShadow) {
        ctx.shadowColor = preset.shadowColor || 'rgba(0,0,0,0.8)';
        ctx.shadowBlur = (preset.shadowBlur || 8) * scaleFactor;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = (preset.shadowOffsetY || 4) * scaleFactor;
      } else {
        ctx.shadowColor = 'transparent';
      }

      // Stroke / Outline
      if (preset.enableStroke && preset.strokeWidth > 0) {
        ctx.strokeStyle = preset.strokeColor || '#000000';
        ctx.lineWidth = (preset.strokeWidth || 6) * scaleFactor;
        ctx.lineJoin = 'round';
        ctx.strokeText(lineStr, posX, lineY);
      }

      // Fill Text
      if (preset.animationPreset === 'karaoke') {
        this.renderKaraokeLine(ctx, lineStr, posX, lineY, activeSub, currentTime, preset, scaleFactor);
      } else {
        ctx.fillStyle = preset.fillColor || '#ffffff';
        ctx.fillText(lineStr, posX, lineY);
      }
    });

    ctx.restore();
  }

  renderKaraokeLine(ctx, lineStr, posX, lineY, activeSub, currentTime, preset, scaleFactor) {
    const words = lineStr.split(' ');
    const duration = activeSub.end - activeSub.start;
    const progress = Math.min(1.0, Math.max(0, (currentTime - activeSub.start) / duration));
    const activeWordIdx = Math.floor(progress * words.length);

    let currentX = posX;
    if (ctx.textAlign === 'center') {
      const fullWidth = ctx.measureText(lineStr).width;
      currentX = posX - (fullWidth / 2);
    } else if (ctx.textAlign === 'right') {
      const fullWidth = ctx.measureText(lineStr).width;
      currentX = posX - fullWidth;
    }

    ctx.textAlign = 'left';
    words.forEach((word, wIdx) => {
      const wordStr = word + (wIdx < words.length - 1 ? ' ' : '');
      if (wIdx === activeWordIdx) {
        ctx.fillStyle = '#00ffff';
        ctx.shadowColor = '#00ffff';
        ctx.shadowBlur = 12 * scaleFactor;
      } else {
        ctx.fillStyle = preset.fillColor || '#ffffff';
        ctx.shadowColor = preset.shadowColor || 'transparent';
      }
      ctx.fillText(wordStr, currentX, lineY);
      currentX += ctx.measureText(wordStr).width;
    });
  }

  wrapText(ctx, text, maxWidth) {
    const words = text.split(' ');
    const lines = [];
    let currentLine = words[0] || '';

    for (let i = 1; i < words.length; i++) {
      const word = words[i];
      const width = ctx.measureText(currentLine + ' ' + word).width;
      if (width < maxWidth) {
        currentLine += ' ' + word;
      } else {
        lines.push(currentLine);
        currentLine = word;
      }
    }
    lines.push(currentLine);
    return lines;
  }

  drawRoundedRect(ctx, x, y, width, height, radius) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
  }

  hexToRgba(hex, alpha = 1) {
    if (!hex) return `rgba(0, 0, 0, ${alpha})`;
    let c = hex.replace('#', '');
    if (c.length === 3) c = c.split('').map(x => x + x).join('');
    const num = parseInt(c, 16);
    const r = (num >> 16) & 255;
    const g = (num >> 8) & 255;
    const b = num & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
}

window.VideoPlayerController = VideoPlayerController;
