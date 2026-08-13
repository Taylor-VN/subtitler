/**
 * Subtitler Main Application
 * Premiere Pro Style Subtitling Tool Entry Point
 */

document.addEventListener('DOMContentLoaded', () => {
  // Initialize Core Modules (25 FPS Default)
  const presetParser = new PresetParser();
  const subManager = new SubtitleManager(25);
  
  const videoEl = document.getElementById('videoPlayer');
  const canvasEl = document.getElementById('subtitleCanvas');
  const playerController = new VideoPlayerController(videoEl, canvasEl, subManager, presetParser, 25);

  const rulerCanvas = document.getElementById('rulerCanvas');
  const waveformCanvas = document.getElementById('waveformCanvas');
  const subtitleTrackContent = document.getElementById('subtitleTrackContent');
  const playheadEl = document.getElementById('playheadScrubber');

  const timelineController = new TimelineController(
    rulerCanvas,
    waveformCanvas,
    subtitleTrackContent,
    playheadEl,
    subManager,
    playerController,
    25
  );

  // --- Initial Demo Setup ---
  initSampleMediaAndSubtitles();

  function initSampleMediaAndSubtitles() {
    // Generate synthetic video stream so player works out of the box
    createSyntheticVideoStream(videoEl);

    // Initial starter subtitles (25 FPS timecodes)
    const starterSubs = [
      { start: 1.0, end: 4.5, text: "Welcome to Subtitler Pro!", speaker: "Host" },
      { start: 5.0, end: 9.2, text: "Designed with Premiere Pro workflows in mind.", speaker: "Host" },
      { start: 10.0, end: 14.0, text: "Drag subtitles on the timeline or edit timestamps on the left.", speaker: "Editor" },
      { start: 14.8, end: 19.5, text: "Import your .prfpset preset files to customize style presets!", speaker: "Editor" },
      { start: 20.0, end: 24.5, text: "Supports frame-accurate 25 FPS timing & instant SRT/VTT exports.", speaker: "Host" }
    ];

    subManager.setSubtitles(starterSubs);
    timelineController.resizeAndDraw();
  }

  // --- UI Element Binding ---
  bindHeaderControls();
  bindCaptionsListUI();
  bindStyleInspectorUI();
  bindTimelineToolbar();
  bindKeyboardShortcuts();

  // --- Header File Operations ---
  function bindHeaderControls() {
    // Media Upload Buttons
    const mediaInput = document.getElementById('mediaFileInput');
    document.getElementById('btnTriggerLoadMedia').addEventListener('click', () => {
      mediaInput.click();
    });

    mediaInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        const objectUrl = URL.createObjectURL(file);
        playerController.loadMedia(file, objectUrl);
        document.getElementById('mediaInfoLabel').textContent = file.name;
      }
    });

    // Subtitle File Import (.srt / .vtt / .json)
    const subInput = document.getElementById('subFileInput');
    document.getElementById('btnTriggerImportSubs').addEventListener('click', () => {
      subInput.click();
    });

    subInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (evt) => {
          const content = evt.target.result;
          if (file.name.endsWith('.vtt')) {
            subManager.parseSRT(content);
          } else if (file.name.endsWith('.json')) {
            try {
              subManager.setSubtitles(JSON.parse(content));
            } catch (err) {
              alert('Invalid JSON subtitle file format');
            }
          } else {
            subManager.parseSRT(content); // Default SRT parser
          }
          timelineController.resizeAndDraw();
        };
        reader.readAsText(file);
      }
    });

    // Premiere Preset Import (.prfpset / .prtextstyle / .xml / .json)
    const presetInput = document.getElementById('presetFileInput');
    document.getElementById('btnTriggerImportPreset').addEventListener('click', () => {
      presetInput.click();
    });

    presetInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (evt) => {
          const presetObj = presetParser.parsePresetFile(evt.target.result, file.name);
          applyPresetToUI(presetObj);
          playerController.setPreset(presetObj);
          alert(`Successfully imported Premiere preset: "${presetObj.name}"`);
        };
        reader.readAsText(file);
      }
    });

    // Exports
    document.getElementById('btnExportSrt').addEventListener('click', () => {
      downloadFile(subManager.exportSRT(), 'subtitles.srt', 'text/plain');
    });

    document.getElementById('btnExportVtt').addEventListener('click', () => {
      downloadFile(subManager.exportVTT(), 'subtitles.vtt', 'text/vtt');
    });

    document.getElementById('btnExportXml').addEventListener('click', () => {
      downloadFile(subManager.exportPremiereXml(), 'sequence_subtitles.xml', 'application/xml');
    });

    document.getElementById('btnExportPreset').addEventListener('click', () => {
      const xmlStr = presetParser.exportPresetToXml(playerController.activePreset);
      downloadFile(xmlStr, `${playerController.activePreset.name || 'style'}.prfpset`, 'application/xml');
    });

    // Shortcuts Modal Toggle
    const shortcutsModal = document.getElementById('shortcutsModal');
    document.getElementById('btnShortcuts').addEventListener('click', () => {
      shortcutsModal.classList.remove('hidden');
    });
    document.getElementById('btnCloseModal').addEventListener('click', () => {
      shortcutsModal.classList.add('hidden');
    });
    shortcutsModal.addEventListener('click', (e) => {
      if (e.target === shortcutsModal) shortcutsModal.classList.add('hidden');
    });

    // Transport Bar & Extended Navigation
    document.getElementById('btnPlayPause').addEventListener('click', () => {
      playerController.togglePlay();
      updatePlayIcons();
    });

    document.getElementById('btnStepBack').addEventListener('click', () => {
      playerController.stepFrame(-1);
    });

    document.getElementById('btnStepForward').addEventListener('click', () => {
      playerController.stepFrame(1);
    });

    document.getElementById('btnPrevSub').addEventListener('click', () => {
      playerController.jumpToPrevSubtitle();
    });

    document.getElementById('btnNextSub').addEventListener('click', () => {
      playerController.jumpToNextSubtitle();
    });

    const loopBtn = document.getElementById('btnLoopRegion');
    loopBtn.addEventListener('click', () => {
      const isLooping = playerController.toggleLoopRegion();
      loopBtn.classList.toggle('active', isLooping);
    });

    document.getElementById('btnFullscreen').addEventListener('click', () => {
      playerController.toggleFullscreen();
    });

    document.getElementById('playbackSpeedSelect').addEventListener('change', (e) => {
      playerController.setSpeed(e.target.value);
    });

    // Viewport Drag & Drop Media Upload
    const viewport = document.getElementById('viewportContainer');
    const dropzone = document.getElementById('dropzoneOverlay');

    viewport.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.remove('hidden');
    });

    viewport.addEventListener('dragleave', (e) => {
      if (!viewport.contains(e.relatedTarget)) {
        dropzone.classList.add('hidden');
      }
    });

    viewport.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.add('hidden');
      const files = e.dataTransfer.files;
      if (files && files[0]) {
        const file = files[0];
        const objectUrl = URL.createObjectURL(file);
        playerController.loadMedia(file, objectUrl);
        document.getElementById('mediaInfoLabel').textContent = file.name;
      }
    });

    // Sync Playhead Timecodes
    playerController.onTimeUpdate((curr, dur) => {
      const tc = subManager.secondsToTimecode(curr, 25);
      const durTc = subManager.secondsToTimecode(dur || 0, 25);

      document.getElementById('headerTimecode').textContent = tc;
      document.getElementById('currentTimecode').textContent = tc;
      document.getElementById('durationTimecode').textContent = durTc;
      updatePlayIcons();
    });
  }

  function updatePlayIcons() {
    const playIcon = document.getElementById('playIcon');
    const pauseIcon = document.getElementById('pauseIcon');
    if (!playerController.isPlaying) {
      playIcon.classList.remove('hidden');
      pauseIcon.classList.add('hidden');
    } else {
      playIcon.classList.add('hidden');
      pauseIcon.classList.remove('hidden');
    }
  }

  // --- Left Captions Sidebar ---
  function bindCaptionsListUI() {
    const listContainer = document.getElementById('captionsList');
    const countBadge = document.getElementById('subCountBadge');
    const searchInput = document.getElementById('subSearchInput');

    subManager.onChange((subs, selectedId) => {
      renderCaptionsList(subs, selectedId);
    });

    document.getElementById('btnAddSubtitle').addEventListener('click', () => {
      const curr = playerController.getCurrentTime();
      subManager.addSubtitle(curr, curr + 3.0, "New Caption Line");
    });

    document.getElementById('btnSplitSubtitle').addEventListener('click', () => {
      if (subManager.selectedId) {
        subManager.splitSubtitleAt(subManager.selectedId, playerController.getCurrentTime());
      }
    });

    document.getElementById('btnMergeSubtitle').addEventListener('click', () => {
      if (subManager.selectedId) {
        subManager.mergeSubtitle(subManager.selectedId);
      } else {
        alert('Please select a subtitle line to merge with the next line.');
      }
    });

    document.getElementById('btnRippleDelete').addEventListener('click', () => {
      if (subManager.selectedId) {
        subManager.rippleDeleteSubtitle(subManager.selectedId);
      } else {
        alert('Please select a subtitle line to ripple delete.');
      }
    });

    document.getElementById('btnShiftTimecodes').addEventListener('click', () => {
      const val = prompt('Shift all subtitle timecodes by (seconds, e.g. +1.5 or -0.5):', '+1.0');
      if (val !== null) {
        const offsetSec = parseFloat(val);
        if (!isNaN(offsetSec)) {
          subManager.shiftAllTimecodes(offsetSec);
        }
      }
    });

    document.getElementById('btnClearAll').addEventListener('click', () => {
      if (confirm('Are you sure you want to clear all captions?')) {
        subManager.clearAll();
      }
    });

    searchInput.addEventListener('input', () => {
      renderCaptionsList(subManager.getSubtitles(), subManager.selectedId);
    });

    function renderCaptionsList(subs, selectedId) {
      listContainer.innerHTML = '';
      const filterTerm = searchInput.value.toLowerCase().trim();
      const filtered = subs.filter(s => s.text.toLowerCase().includes(filterTerm) || (s.speaker && s.speaker.toLowerCase().includes(filterTerm)));

      countBadge.textContent = `${filtered.length} lines`;

      filtered.forEach((sub, idx) => {
        const itemEl = document.createElement('div');
        itemEl.className = `caption-item ${sub.id === selectedId ? 'active' : ''}`;
        itemEl.dataset.id = sub.id;

        const startTc = subManager.secondsToTimecode(sub.start, 25);
        const endTc = subManager.secondsToTimecode(sub.end, 25);

        itemEl.innerHTML = `
          <div class="caption-meta">
            <span class="caption-index">#${idx + 1}</span>
            <div class="caption-tc-inputs">
              <input type="text" class="tc-input start-tc" value="${startTc}" title="In Point (HH:MM:SS:FF)">
              <span>→</span>
              <input type="text" class="tc-input end-tc" value="${endTc}" title="Out Point (HH:MM:SS:FF)">
            </div>
            <button class="caption-delete-btn" title="Delete Line">✕</button>
          </div>
          <textarea class="caption-textarea" placeholder="Caption text...">${escapeHtml(sub.text)}</textarea>
        `;

        // Click to select & jump video
        itemEl.addEventListener('click', (e) => {
          if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON') {
            subManager.selectSubtitle(sub.id);
            playerController.seek(sub.start);
          }
        });

        // Timecode Edits
        const startInput = itemEl.querySelector('.start-tc');
        const endInput = itemEl.querySelector('.end-tc');
        startInput.addEventListener('change', () => {
          const newStart = subManager.timecodeToSeconds(startInput.value, 25);
          subManager.updateSubtitle(sub.id, { start: newStart });
        });
        endInput.addEventListener('change', () => {
          const newEnd = subManager.timecodeToSeconds(endInput.value, 25);
          subManager.updateSubtitle(sub.id, { end: newEnd });
        });

        // Text Edit
        const textarea = itemEl.querySelector('.caption-textarea');
        textarea.addEventListener('input', () => {
          subManager.updateSubtitle(sub.id, { text: textarea.value });
        });

        // Delete
        itemEl.querySelector('.caption-delete-btn').addEventListener('click', (e) => {
          e.stopPropagation();
          subManager.deleteSubtitle(sub.id);
        });

        listContainer.appendChild(itemEl);
      });
    }
  }

  // --- Right Style & Preset Inspector ---
  function bindStyleInspectorUI() {
    const presetSelect = document.getElementById('presetSelect');
    presetSelect.addEventListener('change', (e) => {
      const presetObj = presetParser.getPreset(e.target.value);
      applyPresetToUI(presetObj);
      playerController.setPreset(presetObj);
    });

    document.getElementById('btnResetStyle').addEventListener('click', () => {
      const currentPresetKey = presetSelect.value;
      const presetObj = presetParser.getPreset(currentPresetKey);
      applyPresetToUI(presetObj);
      playerController.setPreset(presetObj);
    });

    document.getElementById('btnSaveCustomPreset').addEventListener('click', () => {
      const name = prompt('Enter a name for your custom preset:', 'My Premiere Style');
      if (name) {
        const customObj = {
          ...playerController.activePreset,
          id: 'custom_' + Date.now(),
          name: name
        };
        presetParser.defaultPresets[customObj.id] = customObj;
        
        const opt = document.createElement('option');
        opt.value = customObj.id;
        opt.textContent = `${name} (Custom)`;
        presetSelect.appendChild(opt);
        presetSelect.value = customObj.id;
        
        playerController.setPreset(customObj);
        alert(`Saved preset "${name}"!`);
      }
    });

    const inputs = {
      fontFamily: document.getElementById('fontFamily'),
      fontSize: document.getElementById('fontSize'),
      fontWeightBold: document.getElementById('fontWeightBold'),
      fontStyleItalic: document.getElementById('fontStyleItalic'),
      textUppercase: document.getElementById('textUppercase'),
      fillColor: document.getElementById('fillColor'),
      enableStroke: document.getElementById('enableStroke'),
      strokeColor: document.getElementById('strokeColor'),
      strokeWidth: document.getElementById('strokeWidth'),
      enableBgBox: document.getElementById('enableBgBox'),
      bgBoxColor: document.getElementById('bgBoxColor'),
      bgBoxOpacity: document.getElementById('bgBoxOpacity'),
      bgBoxPadding: document.getElementById('bgBoxPadding'),
      enableShadow: document.getElementById('enableShadow'),
      shadowColor: document.getElementById('shadowColor'),
      shadowBlur: document.getElementById('shadowBlur'),
      shadowOffsetY: document.getElementById('shadowOffsetY'),
      bottomMargin: document.getElementById('bottomMargin'),
      animationPreset: document.getElementById('animationPreset')
    };

    // Range display text sync
    document.getElementById('strokeWidth').addEventListener('input', (e) => document.getElementById('strokeWidthVal').textContent = `${e.target.value}px`);
    document.getElementById('bgBoxOpacity').addEventListener('input', (e) => document.getElementById('bgBoxOpacityVal').textContent = `${e.target.value}%`);
    document.getElementById('bgBoxPadding').addEventListener('input', (e) => document.getElementById('bgBoxPaddingVal').textContent = `${e.target.value}px`);
    document.getElementById('bottomMargin').addEventListener('input', (e) => document.getElementById('bottomMarginVal').textContent = `${e.target.value}px`);

    // Alignment buttons
    const alignBtns = document.querySelectorAll('.align-btn');
    alignBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        alignBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        readAndApplyInspectorChanges();
      });
    });

    // Read changes from inspector controls
    Object.values(inputs).forEach(inputEl => {
      if (inputEl) {
        inputEl.addEventListener('input', readAndApplyInspectorChanges);
        inputEl.addEventListener('change', readAndApplyInspectorChanges);
      }
    });

    function readAndApplyInspectorChanges() {
      const activeAlignBtn = document.querySelector('.align-btn.active');
      const updatedPreset = {
        name: playerController.activePreset.name || 'Custom Style',
        fontFamily: inputs.fontFamily.value,
        fontSize: parseInt(inputs.fontSize.value, 10) || 42,
        fontWeightBold: inputs.fontWeightBold.checked,
        fontStyleItalic: inputs.fontStyleItalic.checked,
        textUppercase: inputs.textUppercase.checked,
        fillColor: inputs.fillColor.value,
        enableStroke: inputs.enableStroke.checked,
        strokeColor: inputs.strokeColor.value,
        strokeWidth: parseInt(inputs.strokeWidth.value, 10) || 0,
        enableBgBox: inputs.enableBgBox.checked,
        bgBoxColor: inputs.bgBoxColor.value,
        bgBoxOpacity: parseInt(inputs.bgBoxOpacity.value, 10) || 75,
        bgBoxPadding: parseInt(inputs.bgBoxPadding.value, 10) || 12,
        enableShadow: inputs.enableShadow.checked,
        shadowColor: inputs.shadowColor.value,
        shadowBlur: parseInt(inputs.shadowBlur.value, 10) || 0,
        shadowOffsetY: parseInt(inputs.shadowOffsetY.value, 10) || 0,
        align: activeAlignBtn ? activeAlignBtn.dataset.align : 'bottom-center',
        bottomMargin: parseInt(inputs.bottomMargin.value, 10) || 50,
        animationPreset: inputs.animationPreset.value
      };
      playerController.setPreset(updatedPreset);
    }
  }

  function applyPresetToUI(preset) {
    document.getElementById('fontFamily').value = preset.fontFamily || 'Inter';
    document.getElementById('fontSize').value = preset.fontSize || 42;
    document.getElementById('fontWeightBold').checked = !!preset.fontWeightBold;
    document.getElementById('fontStyleItalic').checked = !!preset.fontStyleItalic;
    document.getElementById('textUppercase').checked = !!preset.textUppercase;
    document.getElementById('fillColor').value = preset.fillColor || '#ffea00';
    document.getElementById('enableStroke').checked = !!preset.enableStroke;
    document.getElementById('strokeColor').value = preset.strokeColor || '#000000';
    document.getElementById('strokeWidth').value = preset.strokeWidth || 6;
    document.getElementById('enableBgBox').checked = !!preset.enableBgBox;
    document.getElementById('bgBoxColor').value = preset.bgBoxColor || '#000000';
    document.getElementById('bgBoxOpacity').value = preset.bgBoxOpacity !== undefined ? preset.bgBoxOpacity : 75;
    document.getElementById('bgBoxPadding').value = preset.bgBoxPadding || 12;
    document.getElementById('enableShadow').checked = !!preset.enableShadow;
    document.getElementById('shadowColor').value = preset.shadowColor || '#000000';
    document.getElementById('shadowBlur').value = preset.shadowBlur || 8;
    document.getElementById('shadowOffsetY').value = preset.shadowOffsetY || 4;
    document.getElementById('bottomMargin').value = preset.bottomMargin || 50;
    document.getElementById('animationPreset').value = preset.animationPreset || 'none';

    document.getElementById('strokeWidthVal').textContent = `${preset.strokeWidth || 6}px`;
    document.getElementById('bgBoxOpacityVal').textContent = `${preset.bgBoxOpacity || 75}%`;
    document.getElementById('bgBoxPaddingVal').textContent = `${preset.bgBoxPadding || 12}px`;
    document.getElementById('bottomMarginVal').textContent = `${preset.bottomMargin || 50}px`;

    const alignBtns = document.querySelectorAll('.align-btn');
    alignBtns.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.align === (preset.align || 'bottom-center'));
    });
  }

  // --- Timeline Controls ---
  function bindTimelineToolbar() {
    const zoomSlider = document.getElementById('timelineZoom');
    zoomSlider.addEventListener('input', (e) => {
      timelineController.setZoom(parseFloat(e.target.value));
    });

    document.getElementById('btnZoomOut').addEventListener('click', () => {
      zoomSlider.value = Math.max(10, parseFloat(zoomSlider.value) - 15);
      timelineController.setZoom(parseFloat(zoomSlider.value));
    });

    document.getElementById('btnZoomIn').addEventListener('click', () => {
      zoomSlider.value = Math.min(200, parseFloat(zoomSlider.value) + 15);
      timelineController.setZoom(parseFloat(zoomSlider.value));
    });

    // Track Toggles
    const muteBtn = document.getElementById('btnAudioMute');
    muteBtn.addEventListener('click', () => {
      const isMuted = playerController.toggleMute();
      muteBtn.classList.toggle('active', isMuted);
    });

    const hideBtn = document.getElementById('btnSubHide');
    hideBtn.addEventListener('click', () => {
      const isHidden = playerController.toggleOverlayHide();
      hideBtn.classList.toggle('active', isHidden);
    });

    const lockBtn = document.getElementById('btnSubLock');
    lockBtn.addEventListener('click', () => {
      lockBtn.classList.toggle('active');
      const subtitleTrackContent = document.getElementById('subtitleTrackContent');
      subtitleTrackContent.style.pointerEvents = lockBtn.classList.contains('active') ? 'none' : 'auto';
      subtitleTrackContent.style.opacity = lockBtn.classList.contains('active') ? '0.6' : '1.0';
    });
  }

  // --- Keyboard Shortcuts ---
  function bindKeyboardShortcuts() {
    window.addEventListener('keydown', (e) => {
      // Ignore when typing in inputs/textareas
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;

      if (e.code === 'Space') {
        e.preventDefault();
        playerController.togglePlay();
        updatePlayIcons();
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        if (e.shiftKey) {
          playerController.seek(playerController.getCurrentTime() - 1.0);
        } else {
          playerController.stepFrame(-1);
        }
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        if (e.shiftKey) {
          playerController.seek(playerController.getCurrentTime() + 1.0);
        } else {
          playerController.stepFrame(1);
        }
      } else if (e.key === 'c' || e.key === 'C') {
        if (subManager.selectedId) {
          subManager.splitSubtitleAt(subManager.selectedId, playerController.getCurrentTime());
        }
      } else if (e.key === 'k' || e.key === 'K') {
        playerController.jumpToPrevSubtitle();
      } else if (e.key === 'l' || e.key === 'L') {
        playerController.jumpToNextSubtitle();
      } else if (e.key === 'r' || e.key === 'R') {
        const isLooping = playerController.toggleLoopRegion();
        document.getElementById('btnLoopRegion').classList.toggle('active', isLooping);
      } else if (e.key === 'f' || e.key === 'F') {
        playerController.toggleFullscreen();
      } else if (e.key === 'm' || e.key === 'M') {
        const isMuted = playerController.toggleMute();
        document.getElementById('btnAudioMute').classList.toggle('active', isMuted);
      } else if (e.key === '?') {
        document.getElementById('shortcutsModal').classList.toggle('hidden');
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (subManager.selectedId) {
          subManager.deleteSubtitle(subManager.selectedId);
        }
      }
    });
  }

  // Helper functions
  function escapeHtml(str) {
    return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function downloadFile(content, fileName, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Synthetic Video Stream Generator
  function createSyntheticVideoStream(videoElement) {
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext('2d');

    let angle = 0;
    function drawFrame() {
      ctx.fillStyle = '#0a0a14';
      ctx.fillRect(0, 0, 1280, 720);

      // Draw grid lines
      ctx.strokeStyle = '#1e1e32';
      ctx.lineWidth = 1;
      for (let x = 0; x < 1280; x += 60) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 720); ctx.stroke();
      }

      // Animated colorful elements
      angle += 0.03;
      const cx = 640 + Math.cos(angle) * 200;
      const cy = 360 + Math.sin(angle * 1.5) * 100;

      const grad = ctx.createRadialGradient(cx, cy, 20, cx, cy, 300);
      grad.addColorStop(0, '#1473e6');
      grad.addColorStop(0.5, '#00d2ff');
      grad.addColorStop(1, 'transparent');
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(cx, cy, 300, 0, Math.PI * 2); ctx.fill();

      // Center title text on demo video
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 36px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('SUBTITLER PRO DEMO VIDEO (25 FPS)', 640, 320);

      requestAnimationFrame(drawFrame);
    }
    drawFrame();

    const stream = canvas.captureStream(25); // 25 FPS stream
    videoElement.srcObject = stream;
    videoElement.play().catch(() => {});
  }
});
