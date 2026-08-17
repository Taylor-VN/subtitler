# Taylor's Transcriber

A Premiere Pro–style captions editor whose point of difference is the export:
captions render straight to **Apple ProRes 4444 with a real alpha channel**, so
they drop onto a track above your footage and composite cleanly — no keying, no
burned-in text.

## Running it

There is nothing to install first.

| Platform | Launch |
| --- | --- |
| macOS | `./run_subtitler.sh`, or double-click **Taylor's Transcriber.command** |
| Linux | `./run_subtitler.sh` |
| Windows | double-click **run_subtitler.bat** |

On the first run the app creates its own virtual environment and installs its
base dependencies there. Later runs skip straight to launching. **Nothing is
installed into your system Python** — which also sidesteps the
`externally-managed-environment` refusal (PEP 668) that Homebrew and Debian
Python give when you pip-install globally.

Everything heavier — the speech runtimes and the word-timing aligner — installs
on a button click in **Settings**, into that same private environment. You never
need a terminal.

Only Python 3.9+ is required on the machine. If it is missing, the launcher tells
you how to get it.

### Where the environment lives

Not next to the project. It goes in your per-user application-support directory
on the **boot volume**, keyed by a hash of the project path:

| Platform | Location |
| --- | --- |
| macOS | `~/Library/Application Support/TaylorsTranscriber/venv-<hash>` |
| Linux | `~/.local/share/taylors-transcriber/venv-<hash>` |
| Windows | `%LOCALAPPDATA%\TaylorsTranscriber\venv-<hash>` |

This is deliberate, not tidiness. **macOS refuses to load native libraries from
external and network volumes** — you get `library load disallowed by system
policy`. Editing projects normally live on big external drives, and an
environment sitting beside one cannot load PyObjC, which leaves pywebview with no
GUI backend and the app unable to open a window at all. Keeping the environment
on the boot volume avoids that entirely, while the project itself can live
wherever you like.

Override it with `TRANSCRIBER_VENV=/path/to/env` if you need to. If you have an
old in-project `.venv` from an earlier version, the launcher will tell you it is
no longer used and can be deleted.

### If the window will not open

The app never dies with a stack trace over this. If no native GUI backend can be
loaded it prints the reason and **falls back to your default browser**, serving
the interface from `127.0.0.1`. Exporting and transcription still work in that
mode — the backend is exposed over a localhost bridge that requires a
per-launch token — the only difference is that text exports download through the
browser instead of using a native save dialog.

Force that mode with `./run_subtitler.sh --browser`.

### macOS: "cannot be opened because it is from an unidentified developer"

Gatekeeper blocks double-clicking an unsigned `.command` file. Either:

- **right-click** the file → **Open** → **Open** (the sanctioned one-time
  override), or
- run it from Terminal with `./run_subtitler.sh`, which is not subject to that
  check, or
- clear the quarantine flag on your own copy:
  `xattr -d com.apple.quarantine "Taylor's Transcriber.command"`

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
open-source model running **entirely on your own machine** — the audio is never
uploaded anywhere. Models are installed and removed from **Settings** (`,`).

### Pick the runtime before the model

On Apple Silicon this matters more than the model choice. CTranslate2 — what
`faster-whisper` is built on — has **no Metal backend**, so it runs on CPU cores
only and leaves the GPU idle. The MLX runtimes use the Apple GPU:

| Runtime | Download | Use it for |
| --- | --- | --- |
| MLX Whisper | 90 MB | Whisper family, Apple GPU |
| Parakeet MLX | 90 MB | Fastest accurate English, Apple GPU |
| Qwen3-ASR MLX | 90 MB | Strongest multilingual, Apple GPU |
| Transformers + PyTorch | 2.5 GB | Cohere Transcribe, Granite Speech |
| faster-whisper | 150 MB | NVIDIA GPUs, generic CPU |

Install these from **Settings → Speech Runtimes**. "Install recommended setup"
picks the right set for the machine it is running on — the GPU runtimes plus the
aligner on Apple Silicon. Settings also warns you if the only runtime present is
the CPU-bound one, and only offers runtimes that exist for your platform.

### Choosing a model

| Model | Strength | Timings |
| --- | --- | --- |
| Qwen3-ASR 1.7B | SOTA multilingual; clearly ahead on Mandarin, noisy and accented speech | needs aligner |
| IBM Granite Speech 4.1 2B | Lowest reported English WER of those listed | needs aligner |
| Cohere Transcribe 2B | Apache 2.0; topped Open ASR for English, strong across 13 more languages | needs aligner |
| NVIDIA Parakeet TDT 0.6B v2 | Very strong English, by far the fastest accurate option on Apple Silicon | own timings |
| Whisper large-v3 / turbo | 99 languages, solid baseline; turbo is ~8× faster | own timings |

WER figures shown in Settings are reported English averages from the Hugging
Face Open ASR Leaderboard. The top of that board is separated by well under one
WER point and moves monthly, so treat them as a tier guide, not a ranking to
optimise against.

### Word timings are a separate problem

The strongest models are LLM-backbone designs that emit text with **no usable
word times** — fine for a transcript, useless for captions. Whisper does report
word times, but infers them from cross-attention rather than measuring them, and
they drift.

So recognition and timing are decoupled. A CTC **forced aligner** (`MMS`, 1000+
languages) pins each word to the audio after recognition. That makes the
accuracy-tier models usable for subtitling at all, and tightens Whisper's
timings too. Install it from **Settings → Word Timing Aligner** (it needs PyTorch, which
Settings installs for you). The Transcribe dialog then lets you choose
*automatic* (align when the model needs it), *always*, or *never*.

### Segmentation

Whisper-style output is long transcript runs, not subtitles. Word timings are
re-cut into broadcast-style captions: a character budget per line, a line budget
per caption, max/min on-screen duration, breaks preferred at sentence then
clause punctuation, a forced break on a pause, a reading-speed ceiling, and
widow prevention so no caption is left as one stranded word. The sliders re-cut
the **stored** transcription instantly — changing them does not re-run the model.

Audio is decoded, downmixed and resampled to 16 kHz mono in the browser before
reaching the model, which is exactly what these models expect — so transcription
needs no ffmpeg.

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

## Interface

The toolbar groups its actions into two menus — **Import** (media, subtitles,
Premiere presets) and **Export** (ProRes + alpha, SRT, VTT, sequence XML, style
preset) — with Transcribe, Settings and Help alongside. Every action keeps its
keyboard shortcut.

One accent colour marks anything actionable. Cyan is reserved for the timeline,
so cyan always means "time": the playhead, the waveform and every timecode
readout. Green, amber and red appear only as status, never as button fills.

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
| `,` | Settings — manage models |
| `E` | ProRes + alpha export |
| `1`–`4` | Aspect ratio |
| `+` / `-` | Zoom timeline |
| `?` | Shortcuts |

## Project layout

```
bootstrap.py              creates/enters the app's private venv, installs runtimes,
                          diagnoses GUI backends
app.py                    desktop shell, local static server, browser fallback,
                          token-authenticated API bridge
transcriber.py            job lifecycle, model install/removal, alignment orchestration
js/videoPlayer.js         transport + the canvas renderer (shared by preview and export)
js/exporter.js            alpha frame rendering, ffmpeg handoff, PNG-sequence fallback
js/transcription.js       audio decode/resample/WAV, chunked upload, progress polling
js/bridge.js              picks the backend transport (native shell or HTTP bridge)
js/menu.js                header dropdown menus
js/settings.js            model + runtime manager UI (install/remove, warnings)
js/captionSegmenter.js    word timings -> broadcast-style captions
model_registry.py         model + runtime metadata, install-state detection
engines.py                MLX/transformers/CTranslate2 adapters + forced aligner
js/subtitleManager.js     caption store, timecodes, SRT/VTT/XML
js/timeline.js            ruler, waveform, draggable clips, snapping
js/presetParser.js        Premiere preset import/export
js/app.js                 UI wiring
```
