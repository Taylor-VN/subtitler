/**
 * Subtitler Main Application
 * Premiere Pro Style Subtitling Tool Entry Point
 */

document.addEventListener('DOMContentLoaded', () => {
  const FPS = 25;

  // Initialize Core Modules (25 FPS Default)
  const presetParser = new PresetParser();
  const subManager = new SubtitleManager(FPS);

  const videoEl = document.getElementById('videoPlayer');
  const canvasEl = document.getElementById('subtitleCanvas');
  const playerController = new VideoPlayerController(videoEl, canvasEl, subManager, presetParser, FPS);

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
    FPS
  );

  const exporter = new AlphaExporter(playerController, subManager, FPS);

  // Exposed for debugging and for the automated UI tests.
  window.__player = playerController;
  window.__subs = subManager;
  window.__timeline = timelineController;
  window.__exporter = exporter;
  window.__presets = presetParser;

  // --- Toast notifications (non-blocking replacement for alert()) ---
  const toastStack = document.createElement('div');
  toastStack.className = 'toast-stack';
  document.body.appendChild(toastStack);

  function toast(message, kind = 'info', durationMs = 4200) {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = message;
    toastStack.appendChild(el);
    setTimeout(() => el.remove(), durationMs);
  }

  // --- UI Element Binding ---
  // Bind first: the panels subscribe to subManager.onChange here, so loading
  // the starter captions before this point would leave the list empty on boot.
  bindHeaderControls();
  bindAspectRatioControls();
  bindCaptionsListUI();
  bindStyleInspectorUI();
  bindTimelineToolbar();
  bindExportModal();
  bindKeyboardShortcuts();

  applyPresetToUI(playerController.activePreset);

  // --- Initial Demo Setup ---
  initSampleMediaAndSubtitles();

  function initSampleMediaAndSubtitles() {
    setupDemoPicture();

    const starterSubs = [
      { start: 1.0, end: 4.5, text: "Welcome to Subtitler Pro!", speaker: "Host" },
      { start: 5.0, end: 9.2, text: "Designed with Premiere Pro workflows in mind.", speaker: "Host" },
      { start: 10.0, end: 14.0, text: "Drag subtitles on the timeline or edit timestamps on the left.", speaker: "Editor" },
      { start: 14.8, end: 19.5, text: "Import your .prfpset preset files to customize style presets!", speaker: "Editor" },
      { start: 20.0, end: 24.5, text: "Export to ProRes 4444 with alpha, in any aspect ratio.", speaker: "Host" }
    ];

    subManager.setSubtitles(starterSubs);
    timelineController.resizeAndDraw();
    playerController.renderOverlay();

    // Web fonts arrive after first paint; repaint so the preview shows the real
    // typeface rather than the fallback.
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => {
        playerController.fitProgramFrame();
        playerController.renderOverlay();
      });
    }
  }

  // --- Header File Operations ---
  function bindHeaderControls() {
    // Media Upload Buttons
    const mediaInput = document.getElementById('mediaFileInput');
    document.getElementById('btnTriggerLoadMedia').addEventListener('click', () => {
      mediaInput.click();
    });

    mediaInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) handleMediaFile(file);
      e.target.value = ''; // allow re-selecting the same file
    });

    // Subtitle File Import (.srt / .vtt / .json)
    const subInput = document.getElementById('subFileInput');
    document.getElementById('btnTriggerImportSubs').addEventListener('click', () => {
      subInput.click();
    });

    subInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (evt) => {
        const content = evt.target.result;
        try {
          if (file.name.toLowerCase().endsWith('.json')) {
            const parsed = JSON.parse(content);
            const list = Array.isArray(parsed) ? parsed : parsed.subtitles;
            if (!Array.isArray(list)) throw new Error('JSON must be an array of subtitles.');
            subManager.setSubtitles(list);
          } else {
            subManager.parseSRT(content); // handles both SRT and VTT
          }
          const count = subManager.getSubtitles().length;
          if (count === 0) {
            toast(`No captions could be read from "${file.name}".`, 'warn');
          } else {
            toast(`Imported ${count} caption${count === 1 ? '' : 's'} from "${file.name}".`, 'success');
          }
        } catch (err) {
          toast(`Could not read "${file.name}": ${err.message}`, 'error', 6000);
        }
        timelineController.resizeAndDraw();
      };
      reader.onerror = () => toast(`Could not read "${file.name}".`, 'error');
      reader.readAsText(file);
      e.target.value = '';
    });

    // Premiere Preset Import (.prfpset / .prtextstyle / .xml / .json)
    const presetInput = document.getElementById('presetFileInput');
    document.getElementById('btnTriggerImportPreset').addEventListener('click', () => {
      presetInput.click();
    });

    presetInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      readPresetFile(file);
      e.target.value = '';
    });

    // Exports
    document.getElementById('btnExportSrt').addEventListener('click', () => {
      if (!requireCaptions()) return;
      saveTextFile(subManager.exportSRT(), 'subtitles.srt', 'text/plain');
    });

    document.getElementById('btnExportVtt').addEventListener('click', () => {
      if (!requireCaptions()) return;
      saveTextFile(subManager.exportVTT(), 'subtitles.vtt', 'text/vtt');
    });

    document.getElementById('btnExportXml').addEventListener('click', () => {
      if (!requireCaptions()) return;
      saveTextFile(subManager.exportPremiereXml(playerController.project), 'sequence_subtitles.xml', 'application/xml');
    });

    document.getElementById('btnExportPreset').addEventListener('click', () => {
      const preset = playerController.activePreset;
      const xmlStr = presetParser.exportPresetToXml(preset);
      const safeName = (preset.name || 'style').replace(/[^\w\-. ]+/g, '_');
      saveTextFile(xmlStr, `${safeName}.prfpset`, 'application/xml');
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
      updatePlayIcons();
    });

    document.getElementById('btnStepForward').addEventListener('click', () => {
      playerController.stepFrame(1);
      updatePlayIcons();
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
      if (isLooping && !subManager.selectedId) {
        toast('Loop is armed — select a caption to loop over its region.', 'warn');
      }
    });

    const safeBtn = document.getElementById('btnSafeGuides');
    safeBtn.addEventListener('click', () => toggleSafeGuides());

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
      if (!files || !files[0]) return;

      const file = files[0];
      const lower = file.name.toLowerCase();
      if (/\.(srt|vtt)$/.test(lower)) {
        const reader = new FileReader();
        reader.onload = (evt) => {
          subManager.parseSRT(evt.target.result);
          timelineController.resizeAndDraw();
          toast(`Imported ${subManager.getSubtitles().length} captions from "${file.name}".`, 'success');
        };
        reader.readAsText(file);
      } else if (/\.(prfpset|prtextstyle|xml)$/.test(lower)) {
        readPresetFile(file);
      } else {
        handleMediaFile(file);
      }
    });

    // Sync Playhead Timecodes
    playerController.onTimeUpdate((curr, dur) => {
      const tc = subManager.secondsToTimecode(curr, FPS);
      const durTc = subManager.secondsToTimecode(dur || 0, FPS);

      document.getElementById('headerTimecode').textContent = tc;
      document.getElementById('currentTimecode').textContent = tc;
      document.getElementById('durationTimecode').textContent = durTc;
      updatePlayIcons();
      highlightActiveCaption(curr);
    });
  }

  function handleMediaFile(file) {
    const objectUrl = URL.createObjectURL(file);
    playerController.loadMedia(file, objectUrl);
    document.getElementById('mediaInfoLabel').textContent = file.name;
    document.getElementById('programFrame').classList.add('has-media');
    timelineController.loadAudioWaveform(file);
    toast(`Loaded "${file.name}".`, 'success');
  }

  function readPresetFile(file) {
    const reader = new FileReader();
    reader.onload = (evt) => {
      const presetObj = presetParser.parsePresetFile(evt.target.result, file.name);
      presetParser.addPreset(presetObj);
      addPresetOption(presetObj, true);
      applyPresetToUI(presetObj);
      playerController.setPreset(presetObj);
      toast(`Imported Premiere preset "${presetObj.name}".`, 'success');
    };
    reader.onerror = () => toast(`Could not read "${file.name}".`, 'error');
    reader.readAsText(file);
  }

  function requireCaptions() {
    if (subManager.getSubtitles().length === 0) {
      toast('There are no captions to export yet.', 'warn');
      return false;
    }
    return true;
  }

  function updatePlayIcons() {
    const playIcon = document.getElementById('playIcon');
    const pauseIcon = document.getElementById('pauseIcon');
    playIcon.classList.toggle('hidden', playerController.isPlaying);
    pauseIcon.classList.toggle('hidden', !playerController.isPlaying);
  }

  function toggleSafeGuides() {
    const guides = document.getElementById('safeGuides');
    const btn = document.getElementById('btnSafeGuides');
    const nowVisible = guides.classList.toggle('hidden') === false;
    btn.classList.toggle('active', nowVisible);
    return nowVisible;
  }

  // --- Aspect Ratio Switching ---
  function bindAspectRatioControls() {
    const buttons = document.querySelectorAll('.aspect-btn');

    buttons.forEach(btn => {
      btn.addEventListener('click', () => setAspect(btn.dataset.aspect));
    });

    playerController.onProjectChange((project) => {
      document.getElementById('projectResLabel').textContent = `${project.width}×${project.height}`;
      const info = document.getElementById('exportResInfo');
      if (info) info.textContent = `${project.width} × ${project.height} (${project.label})`;
      buttons.forEach(b => b.classList.toggle('active', b.dataset.aspect === project.id));
    });

    // Publish the initial state through the same path
    setAspect('16x9');
  }

  function setAspect(aspectId) {
    const project = playerController.setAspectRatio(aspectId);
    return project;
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
      const sub = subManager.addSubtitle(curr, curr + 3.0, 'New Caption Line');
      // Drop focus straight into the new line's text box
      requestAnimationFrame(() => {
        const ta = listContainer.querySelector(`.caption-item[data-id="${sub.id}"] .caption-textarea`);
        if (ta) { ta.focus(); ta.select(); }
      });
    });

    document.getElementById('btnSplitSubtitle').addEventListener('click', () => {
      if (!subManager.selectedId) {
        toast('Select a caption first, then park the playhead where it should split.', 'warn');
        return;
      }
      const ok = subManager.splitSubtitleAt(subManager.selectedId, playerController.getCurrentTime());
      if (!ok) toast('Move the playhead inside the selected caption to split it.', 'warn');
    });

    document.getElementById('btnMergeSubtitle').addEventListener('click', () => {
      if (!subManager.selectedId) {
        toast('Select a caption line to merge it with the next one.', 'warn');
        return;
      }
      const ok = subManager.mergeSubtitle(subManager.selectedId);
      if (!ok) toast('The last caption has nothing after it to merge with.', 'warn');
    });

    document.getElementById('btnRippleDelete').addEventListener('click', () => {
      if (!subManager.selectedId) {
        toast('Select a caption line to ripple delete it.', 'warn');
        return;
      }
      subManager.rippleDeleteSubtitle(subManager.selectedId);
    });

    document.getElementById('btnShiftTimecodes').addEventListener('click', () => {
      const val = prompt('Shift all subtitle timecodes by (seconds, e.g. +1.5 or -0.5):', '+1.0');
      if (val === null) return;
      const offsetSec = parseFloat(val);
      if (isNaN(offsetSec)) {
        toast(`"${val}" is not a number of seconds.`, 'error');
        return;
      }
      subManager.shiftAllTimecodes(offsetSec);
      toast(`Shifted all captions by ${offsetSec > 0 ? '+' : ''}${offsetSec}s.`, 'success');
    });

    document.getElementById('btnClearAll').addEventListener('click', () => {
      if (subManager.getSubtitles().length === 0) {
        toast('There are no captions to clear.', 'warn');
        return;
      }
      if (confirm('Are you sure you want to clear all captions?')) {
        subManager.clearAll();
        toast('All captions cleared.', 'success');
      }
    });

    searchInput.addEventListener('input', () => {
      renderCaptionsList(subManager.getSubtitles(), subManager.selectedId);
    });

    let isRestoringFocus = false;

    function renderCaptionsList(subs, selectedId) {
      // Preserve focus/caret across re-renders so typing is not interrupted.
      const active = document.activeElement;
      const focusInfo = active && active.closest && active.closest('.caption-item') ? {
        id: active.closest('.caption-item').dataset.id,
        cls: active.className,
        selStart: active.selectionStart,
        selEnd: active.selectionEnd
      } : null;

      listContainer.innerHTML = '';
      const filterTerm = searchInput.value.toLowerCase().trim();
      const filtered = subs.filter(s =>
        s.text.toLowerCase().includes(filterTerm) ||
        (s.speaker && s.speaker.toLowerCase().includes(filterTerm)));

      countBadge.textContent = `${filtered.length} line${filtered.length === 1 ? '' : 's'}`;

      filtered.forEach((sub) => {
        const trueIndex = subs.indexOf(sub);
        const itemEl = document.createElement('div');
        itemEl.className = `caption-item ${sub.id === selectedId ? 'active' : ''}`;
        itemEl.dataset.id = sub.id;

        const startTc = subManager.secondsToTimecode(sub.start, FPS);
        const endTc = subManager.secondsToTimecode(sub.end, FPS);

        itemEl.innerHTML = `
          <div class="caption-meta">
            <span class="caption-index">#${trueIndex + 1}</span>
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
          if (!['INPUT', 'TEXTAREA', 'BUTTON'].includes(e.target.tagName)) {
            subManager.selectSubtitle(sub.id);
            playerController.seek(sub.start);
          }
        });

        // Timecode Edits
        const startInput = itemEl.querySelector('.start-tc');
        const endInput = itemEl.querySelector('.end-tc');
        startInput.addEventListener('change', () => {
          const newStart = subManager.timecodeToSeconds(startInput.value, FPS);
          subManager.updateSubtitle(sub.id, { start: newStart });
        });
        endInput.addEventListener('change', () => {
          const newEnd = subManager.timecodeToSeconds(endInput.value, FPS);
          subManager.updateSubtitle(sub.id, { end: newEnd });
        });

        // Text Edit — update the model without re-rendering the whole list
        const textarea = itemEl.querySelector('.caption-textarea');
        textarea.addEventListener('input', () => {
          subManager.updateSubtitle(sub.id, { text: textarea.value }, { silent: true });
          playerController.renderOverlay();
          const clip = subtitleTrackContent.querySelector(`.subtitle-clip[data-id="${sub.id}"] .clip-text`);
          if (clip) clip.textContent = textarea.value || '(empty)';
        });
        textarea.addEventListener('focus', () => {
          if (isRestoringFocus) return; // programmatic re-focus, not a user action
          subManager.selectSubtitle(sub.id);
        });

        // Delete
        itemEl.querySelector('.caption-delete-btn').addEventListener('click', (e) => {
          e.stopPropagation();
          subManager.deleteSubtitle(sub.id);
        });

        listContainer.appendChild(itemEl);
      });

      if (focusInfo) {
        const restored = listContainer.querySelector(
          `.caption-item[data-id="${focusInfo.id}"] .${focusInfo.cls.split(' ').join('.')}`);
        if (restored) {
          isRestoringFocus = true;
          restored.focus();
          try { restored.setSelectionRange(focusInfo.selStart, focusInfo.selEnd); } catch (e) { /* not a text field */ }
          isRestoringFocus = false;
        }
      }
    }
  }

  /** Highlights the caption currently on screen (Premiere-style follow). */
  let lastHighlightedId = null;
  function highlightActiveCaption(currentTime) {
    const active = subManager.getActiveSubtitleAt(currentTime);
    const id = active ? active.id : null;
    if (id === lastHighlightedId) return;
    lastHighlightedId = id;

    document.querySelectorAll('.caption-item').forEach(el => {
      el.classList.toggle('playing', el.dataset.id === id);
    });
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
      const presetObj = presetParser.getPreset(presetSelect.value);
      applyPresetToUI(presetObj);
      playerController.setPreset(presetObj);
      toast(`Reset to "${presetObj.name}".`, 'success');
    });

    document.getElementById('btnSaveCustomPreset').addEventListener('click', () => {
      const name = prompt('Enter a name for your custom preset:', 'My Premiere Style');
      if (!name) return;
      const customObj = {
        ...playerController.activePreset,
        id: 'custom_' + Date.now(),
        name: name
      };
      presetParser.addPreset(customObj);
      addPresetOption(customObj, true);
      playerController.setPreset(customObj);
      toast(`Saved preset "${name}".`, 'success');
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
    inputs.strokeWidth.addEventListener('input', (e) => document.getElementById('strokeWidthVal').textContent = `${e.target.value}px`);
    inputs.bgBoxOpacity.addEventListener('input', (e) => document.getElementById('bgBoxOpacityVal').textContent = `${e.target.value}%`);
    inputs.bgBoxPadding.addEventListener('input', (e) => document.getElementById('bgBoxPaddingVal').textContent = `${e.target.value}px`);
    inputs.bottomMargin.addEventListener('input', (e) => document.getElementById('bottomMarginVal').textContent = `${e.target.value}px`);

    // Alignment buttons
    const alignBtns = document.querySelectorAll('.align-btn');
    alignBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        alignBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        readAndApplyInspectorChanges();
      });
    });

    Object.values(inputs).forEach(inputEl => {
      if (!inputEl) return;
      inputEl.addEventListener('input', readAndApplyInspectorChanges);
      inputEl.addEventListener('change', readAndApplyInspectorChanges);
    });

    function readAndApplyInspectorChanges() {
      const activeAlignBtn = document.querySelector('.align-btn.active');
      playerController.setPreset({
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
        bgBoxOpacity: parseInt(inputs.bgBoxOpacity.value, 10) || 0,
        bgBoxPadding: parseInt(inputs.bgBoxPadding.value, 10) || 0,
        enableShadow: inputs.enableShadow.checked,
        shadowColor: inputs.shadowColor.value,
        shadowBlur: parseInt(inputs.shadowBlur.value, 10) || 0,
        shadowOffsetY: parseInt(inputs.shadowOffsetY.value, 10) || 0,
        align: activeAlignBtn ? activeAlignBtn.dataset.align : 'bottom-center',
        bottomMargin: parseInt(inputs.bottomMargin.value, 10) || 0,
        animationPreset: inputs.animationPreset.value
      });
    }
  }

  function addPresetOption(preset, select = false) {
    const presetSelect = document.getElementById('presetSelect');
    let opt = presetSelect.querySelector(`option[value="${preset.id}"]`);
    if (!opt) {
      opt = document.createElement('option');
      opt.value = preset.id;
      presetSelect.appendChild(opt);
    }
    opt.textContent = `${preset.name} (Custom)`;
    if (select) presetSelect.value = preset.id;
  }

  function applyPresetToUI(preset) {
    const set = (id, value) => { const el = document.getElementById(id); if (el) el.value = value; };
    const check = (id, value) => { const el = document.getElementById(id); if (el) el.checked = !!value; };

    set('fontFamily', preset.fontFamily || 'Inter');
    set('fontSize', preset.fontSize || 42);
    check('fontWeightBold', preset.fontWeightBold);
    check('fontStyleItalic', preset.fontStyleItalic);
    check('textUppercase', preset.textUppercase);
    set('fillColor', preset.fillColor || '#ffea00');
    check('enableStroke', preset.enableStroke);
    set('strokeColor', preset.strokeColor || '#000000');
    set('strokeWidth', preset.strokeWidth !== undefined ? preset.strokeWidth : 5);
    check('enableBgBox', preset.enableBgBox);
    set('bgBoxColor', preset.bgBoxColor || '#000000');
    set('bgBoxOpacity', preset.bgBoxOpacity !== undefined ? preset.bgBoxOpacity : 75);
    set('bgBoxPadding', preset.bgBoxPadding !== undefined ? preset.bgBoxPadding : 18);
    check('enableShadow', preset.enableShadow);
    // <input type="color"> cannot hold rgba(), so normalise first.
    set('shadowColor', /^#[0-9a-f]{6}$/i.test(preset.shadowColor || '') ? preset.shadowColor : '#000000');
    set('shadowBlur', preset.shadowBlur !== undefined ? preset.shadowBlur : 12);
    set('shadowOffsetY', preset.shadowOffsetY !== undefined ? preset.shadowOffsetY : 6);
    set('bottomMargin', preset.bottomMargin !== undefined ? preset.bottomMargin : 75);
    set('animationPreset', preset.animationPreset || 'none');

    document.getElementById('strokeWidthVal').textContent = `${preset.strokeWidth !== undefined ? preset.strokeWidth : 5}px`;
    document.getElementById('bgBoxOpacityVal').textContent = `${preset.bgBoxOpacity !== undefined ? preset.bgBoxOpacity : 75}%`;
    document.getElementById('bgBoxPaddingVal').textContent = `${preset.bgBoxPadding !== undefined ? preset.bgBoxPadding : 18}px`;
    document.getElementById('bottomMarginVal').textContent = `${preset.bottomMargin !== undefined ? preset.bottomMargin : 75}px`;

    document.querySelectorAll('.align-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.align === (preset.align || 'bottom-center'));
    });
  }

  // --- Timeline Controls ---
  function bindTimelineToolbar() {
    const zoomSlider = document.getElementById('timelineZoom');
    zoomSlider.addEventListener('input', (e) => {
      timelineController.setZoom(parseFloat(e.target.value));
    });

    document.getElementById('btnZoomOut').addEventListener('click', () => zoomBy(-15));
    document.getElementById('btnZoomIn').addEventListener('click', () => zoomBy(15));

    // Track Toggles
    const muteBtn = document.getElementById('btnAudioMute');
    muteBtn.addEventListener('click', () => {
      const isMuted = playerController.toggleMute();
      muteBtn.classList.toggle('active', isMuted);
    });

    const soloBtn = document.getElementById('btnAudioSolo');
    soloBtn.addEventListener('click', () => {
      const isSolo = playerController.toggleSolo();
      soloBtn.classList.toggle('active', isSolo);
      if (isSolo && playerController.video.muted) {
        // Soloing audio while muted makes no sense — unmute for the user.
        playerController.toggleMute();
        muteBtn.classList.remove('active');
      }
    });

    const hideBtn = document.getElementById('btnSubHide');
    hideBtn.addEventListener('click', () => {
      const isHidden = playerController.toggleOverlayHide();
      hideBtn.classList.toggle('active', isHidden);
    });

    const lockBtn = document.getElementById('btnSubLock');
    lockBtn.addEventListener('click', () => {
      const locked = lockBtn.classList.toggle('active');
      subtitleTrackContent.style.pointerEvents = locked ? 'none' : 'auto';
      subtitleTrackContent.style.opacity = locked ? '0.6' : '1.0';
    });

    document.getElementById('snapToGrid').addEventListener('change', (e) => {
      toast(e.target.checked ? 'Snapping on.' : 'Snapping off.', 'info', 1600);
    });
  }

  function zoomBy(delta) {
    const zoomSlider = document.getElementById('timelineZoom');
    const next = Math.max(10, Math.min(200, parseFloat(zoomSlider.value) + delta));
    zoomSlider.value = next;
    timelineController.setZoom(next);
  }

  // --- ProRes / Alpha Export ---
  function bindExportModal() {
    const modal = document.getElementById('exportModal');
    const rangeSelect = document.getElementById('exportRangeSelect');
    const profileSelect = document.getElementById('exportProfileSelect');
    const startBtn = document.getElementById('btnStartExport');
    const cancelBtn = document.getElementById('btnCancelExport');
    const progressWrap = document.getElementById('exportProgressWrap');
    const progressBar = document.getElementById('exportProgressBar');
    const progressText = document.getElementById('exportProgressText');
    const note = document.getElementById('exportBackendNote');
    let running = false;

    function updateEstimate() {
      const estimate = document.getElementById('exportFrameEstimate');
      let span;
      if (rangeSelect.value === 'captions') {
        const r = exporter.getCaptionRange();
        span = Math.max(0, r.end - r.start);
      } else {
        span = playerController.getDuration();
      }
      const frames = Math.ceil(span * FPS);
      estimate.textContent = frames > 0
        ? `${frames} frames (${span.toFixed(2)}s)`
        : 'No captions to render';
      startBtn.disabled = frames <= 0;
    }

    function updateBackendNote() {
      if (exporter.hasNativeBackend()) {
        note.className = 'export-note';
        note.textContent = 'Native backend detected — ffmpeg will write a ProRes 4444 .mov with a real alpha channel.';
      } else {
        note.className = 'export-note warn';
        note.textContent =
          'Running without the desktop backend, so a ProRes .mov cannot be written directly. '
          + 'A ZIP of the transparent PNG sequence will be downloaded instead, together with the exact '
          + 'ffmpeg command to turn it into ProRes 4444. Launch via run_subtitler.sh for the one-click .mov export.';
      }
    }

    function openModal() {
      updateEstimate();
      updateBackendNote();
      progressWrap.classList.add('hidden');
      progressBar.style.width = '0%';
      modal.classList.remove('hidden');
    }

    function closeModal() {
      if (running) {
        exporter.cancel();
        running = false;
      }
      modal.classList.add('hidden');
    }

    document.getElementById('btnExportAlpha').addEventListener('click', openModal);
    document.getElementById('btnCloseExportModal').addEventListener('click', closeModal);
    cancelBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
    rangeSelect.addEventListener('change', updateEstimate);
    playerController.onProjectChange(updateEstimate);
    subManager.onChange(() => { if (!modal.classList.contains('hidden')) updateEstimate(); });

    startBtn.addEventListener('click', async () => {
      if (running) return;
      running = true;
      playerController.pause();
      startBtn.disabled = true;
      progressWrap.classList.remove('hidden');
      progressBar.style.width = '0%';
      progressText.textContent = 'Preparing…';

      try {
        const result = await exporter.export({
          rangeMode: rangeSelect.value,
          profile: parseInt(profileSelect.value, 10),
          padStart: 0.5,
          filename: 'subtitles_alpha.mov',
          onFontWarning: (missing) => {
            toast(`"${missing.join(', ')}" is not available — the export will use the fallback typeface.`, 'warn', 7000);
          },
          onProgress: (done, total, phase) => {
            const pct = total ? Math.round((done / total) * 100) : 0;
            progressBar.style.width = `${pct}%`;
            progressText.textContent = `${phase} — ${done}/${total} (${pct}%)`;
          }
        });

        if (result.mode === 'prores') {
          toast(`ProRes 4444 with alpha written to:\n${result.path}`, 'success', 9000);
        } else {
          toast(`Exported ${result.frames} transparent PNG frames as a ZIP.\nSee ENCODE_TO_PRORES.txt inside for the ffmpeg command.`, 'success', 9000);
        }
        modal.classList.add('hidden');
      } catch (err) {
        progressText.textContent = err.message;
        note.className = 'export-note err';
        note.textContent = err.message;
        toast(`Export failed: ${err.message}`, 'error', 8000);
      } finally {
        running = false;
        startBtn.disabled = false;
        playerController.renderOverlay();
      }
    });
  }

  // --- Keyboard Shortcuts ---
  function bindKeyboardShortcuts() {
    window.addEventListener('keydown', (e) => {
      // Ignore when typing in inputs/textareas
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
      if (e.target.isContentEditable) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const exportOpen = !document.getElementById('exportModal').classList.contains('hidden');

      if (e.key === 'Escape') {
        document.getElementById('shortcutsModal').classList.add('hidden');
        document.getElementById('exportModal').classList.add('hidden');
        return;
      }
      if (exportOpen) return; // don't drive the editor while the export dialog is up

      switch (e.code) {
        case 'Space':
          e.preventDefault();
          playerController.togglePlay();
          updatePlayIcons();
          return;
        case 'ArrowLeft':
          e.preventDefault();
          if (e.shiftKey) playerController.seek(playerController.getCurrentTime() - 1.0);
          else playerController.stepFrame(-1);
          updatePlayIcons();
          return;
        case 'ArrowRight':
          e.preventDefault();
          if (e.shiftKey) playerController.seek(playerController.getCurrentTime() + 1.0);
          else playerController.stepFrame(1);
          updatePlayIcons();
          return;
      }

      switch (e.key.toLowerCase()) {
        case 'c':
          if (subManager.selectedId) {
            subManager.splitSubtitleAt(subManager.selectedId, playerController.getCurrentTime());
          }
          break;
        case 'k':
          playerController.jumpToPrevSubtitle();
          break;
        case 'l':
          playerController.jumpToNextSubtitle();
          break;
        case 'r': {
          const isLooping = playerController.toggleLoopRegion();
          document.getElementById('btnLoopRegion').classList.toggle('active', isLooping);
          break;
        }
        case 'f':
          playerController.toggleFullscreen();
          break;
        case 'g':
          toggleSafeGuides();
          break;
        case 'e':
          document.getElementById('btnExportAlpha').click();
          break;
        case 'm': {
          const isMuted = playerController.toggleMute();
          document.getElementById('btnAudioMute').classList.toggle('active', isMuted);
          break;
        }
        case 's': {
          const isSolo = playerController.toggleSolo();
          document.getElementById('btnAudioSolo').classList.toggle('active', isSolo);
          break;
        }
        case '?':
          document.getElementById('shortcutsModal').classList.toggle('hidden');
          break;
        case '1': setAspect('16x9'); break;
        case '2': setAspect('1x1'); break;
        case '3': setAspect('4x5'); break;
        case '4': setAspect('9x16'); break;
        case '+':
        case '=': zoomBy(15); break;
        case '-':
        case '_': zoomBy(-15); break;
        case 'delete':
        case 'backspace':
          e.preventDefault();
          if (subManager.selectedId) subManager.deleteSubtitle(subManager.selectedId);
          break;
      }
    });
  }

  // --- Helpers ---
  function escapeHtml(str) {
    return (str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** Uses the desktop save dialog when available, otherwise a browser download. */
  async function saveTextFile(content, fileName, mimeType) {
    if (window.pywebview && window.pywebview.api && window.pywebview.api.save_text_file) {
      try {
        const res = await window.pywebview.api.save_text_file(fileName, content);
        if (res && res.ok) {
          toast(`Saved to ${res.path}`, 'success', 6000);
          return;
        }
        if (res && res.error && res.error !== 'Save cancelled.') {
          toast(res.error, 'error');
          return;
        }
        return; // user cancelled
      } catch (e) {
        // fall through to the browser download
      }
    }
    downloadFile(content, fileName, mimeType);
    toast(`Downloaded ${fileName}.`, 'success');
  }

  function downloadFile(content, fileName, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /**
   * Built-in demo picture. Unlike a live captureStream this is a pure function
   * of time, so the playhead can be scrubbed, stepped and looped before any
   * real media has been loaded.
   */
  function setupDemoPicture() {
    const demoCanvas = document.getElementById('demoCanvas');
    const dctx = demoCanvas.getContext('2d');

    playerController.onFrameRender((timeSec, project) => {
      if (playerController.hasMedia) return;

      if (demoCanvas.width !== project.width || demoCanvas.height !== project.height) {
        demoCanvas.width = project.width;
        demoCanvas.height = project.height;
      }

      const w = demoCanvas.width;
      const h = demoCanvas.height;
      const s = h / 1080;

      dctx.fillStyle = '#0a0a14';
      dctx.fillRect(0, 0, w, h);

      dctx.strokeStyle = '#1e1e32';
      dctx.lineWidth = 1;
      const gridStep = 90 * s;
      for (let x = 0; x < w; x += gridStep) {
        dctx.beginPath(); dctx.moveTo(x, 0); dctx.lineTo(x, h); dctx.stroke();
      }
      for (let y = 0; y < h; y += gridStep) {
        dctx.beginPath(); dctx.moveTo(0, y); dctx.lineTo(w, y); dctx.stroke();
      }

      const angle = timeSec * 0.9;
      const cx = (w / 2) + Math.cos(angle) * (w * 0.16);
      const cy = (h / 2) + Math.sin(angle * 1.5) * (h * 0.14);
      const radius = Math.min(w, h) * 0.42;

      const grad = dctx.createRadialGradient(cx, cy, radius * 0.06, cx, cy, radius);
      grad.addColorStop(0, '#1473e6');
      grad.addColorStop(0.5, '#00d2ff');
      grad.addColorStop(1, 'rgba(0, 210, 255, 0)');
      dctx.fillStyle = grad;
      dctx.beginPath(); dctx.arc(cx, cy, radius, 0, Math.PI * 2); dctx.fill();

      dctx.fillStyle = '#ffffff';
      dctx.font = `bold ${Math.round(46 * s)}px sans-serif`;
      dctx.textAlign = 'center';
      dctx.textBaseline = 'middle';
      dctx.fillText('SUBTITLER PRO DEMO', w / 2, h * 0.32);

      dctx.font = `${Math.round(30 * s)}px "Roboto Mono", monospace`;
      dctx.fillStyle = '#8fa8c8';
      dctx.fillText(`${project.label}  •  ${w}×${h}  •  25 FPS`, w / 2, h * 0.4);
    });
  }
});
