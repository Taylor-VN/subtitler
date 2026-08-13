# Subtitler Pro

A Premiere Pro–style captions editor whose point of difference is the export:
captions render straight to **Apple ProRes 4444 with a real alpha channel**, so
they drop onto a track above your footage and composite cleanly — no keying, no
burned-in text.

## Running it

```bash
pip install -r requirements.txt
./run_subtitler.sh          # or: python3 app.py
```

The app opens in its own desktop window. Launching it this way (rather than
opening `index.html` in a browser) is what enables the ProRes export and the
AI transcription — both need the Python backend.

### ffmpeg (for the ProRes export)

The alpha export shells out to `ffmpeg`, which is a system binary rather than a
Python package:

| Platform | Command |
| --- | --- |
| macOS | `brew install ffmpeg` |
| Debian/Ubuntu | `sudo apt install ffmpeg` |
| Windows | https://www.gyan.dev/ffmpeg/builds/ |

Without it the export still works, but falls back to a ZIP'd transparent PNG
sequence plus the exact ffmpeg command to convert it yourself.

## Aspect ratios

| Ratio | Resolution | |
| --- | --- | --- |
| 16:9 | 1920 × 1080 | key `1` |
| 1:1 | 1080 × 1080 | key `2` |
| 4:5 | 1080 × 1350 | key `3` |
| 9:16 | 1080 × 1920 | key `4` |

Everything is drawn at the project resolution and the preview is a scaled copy
of it, so the Program Monitor is pixel-for-pixel what gets exported. Preset
style values (font size, margins, stroke, shadow) are referenced to a
1080-pixel-tall frame and scaled, so a preset looks proportionally the same in
every ratio.

## AI transcription

Press **Transcribe** (or `T`) to auto-caption the loaded media with an
open-source Whisper model running **entirely on your own machine** — the audio
is never uploaded anywhere.

- **Engine.** [faster-whisper](https://github.com/SYSTRAN/faster-whisper)
  (CTranslate2) by default: several times quicker than the reference model on
  CPU, far lighter on memory, and it reports the word-level timestamps used to
  cut captions accurately. Installing `transformers` + `torch` as well (both
  commented out in `requirements.txt`) adds a fallback engine that can run any
  Whisper-architecture checkpoint from the Hub.
- **Models.** Pick a size preset (tiny → large-v3, plus distil-large-v3), or
  choose *Custom* and enter any Hugging Face repo id — e.g.
  `Systran/faster-whisper-large-v3` — or the path to a model folder you already
  have on disk. Models download on first use and are cached under
  `~/.cache/huggingface`, after which everything runs offline. The dialog tells
  you how many Whisper models are already cached.
- **Languages.** Auto-detect or pick from the list; *Translate to English* is
  also available.
- **Segmentation.** Whisper returns long transcript runs, not subtitles, so
  word timings are re-cut into broadcast-style captions: a character budget per
  line, a line budget per caption, max/min on-screen duration, breaks preferred
  at sentence then clause punctuation, a forced break on a pause, a
  reading-speed ceiling, and widow prevention so no caption is left as one
  stranded word. The sliders re-cut the **stored** transcription instantly —
  changing them does not re-run the model.

Audio is decoded, downmixed and resampled to 16 kHz mono in the browser before
being handed to the model, which is exactly Whisper's expected input — so
transcription needs no ffmpeg.

## Exports

| Format | Notes |
| --- | --- |
| ProRes 4444 / 4444 XQ | QuickTime `.mov`, `yuva444p10le`, 16-bit alpha |
| PNG sequence | Fallback when ffmpeg is absent; transparent RGBA frames + the ffmpeg command |
| SRT / VTT | Standard subtitle interchange |
| Premiere sequence XML | FCP7 `xmeml` v4 |
| Style preset | `.prfpset`, round-trips back through the importer |

## Premiere presets

Import `.prfpset` / `.prtextstyle` / XML / JSON. The parser looks for values by
tag name, by `<Parameter Name="…">` node, and by attribute, falling back to a
raw-text scan, and understands Premiere's colour encodings (`#rgb`, `#rrggbb`,
`#aarrggbb`, `0x…`, `r,g,b`, normalised floats, packed ARGB).

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Space` | Play / pause |
| `←` / `→` | Step one frame (`Shift` for one second) |
| `C` | Split selected caption at the playhead |
| `K` / `L` | Previous / next caption |
| `R` | Loop the selected caption |
| `F` | Fullscreen program monitor |
| `G` | Title / action safe guides |
| `M` / `S` | Mute / solo audio |
| `T` | Auto-transcribe |
| `E` | ProRes + alpha export |
| `1`–`4` | Aspect ratio |
| `+` / `-` | Zoom timeline |
| `?` | Shortcuts |

## Project layout

```
app.py                    desktop shell, local static server, export + transcribe bridge
transcriber.py            Whisper engines, model resolution, job lifecycle
js/videoPlayer.js         transport + the canvas renderer (shared by preview and export)
js/exporter.js            alpha frame rendering, ffmpeg handoff, PNG-sequence fallback
js/transcription.js       audio decode/resample/WAV, chunked upload, progress polling
js/captionSegmenter.js    word timings -> broadcast-style captions
js/subtitleManager.js     caption store, timecodes, SRT/VTT/XML
js/timeline.js            ruler, waveform, draggable clips, snapping
js/presetParser.js        Premiere preset import/export
js/app.js                 UI wiring
```
