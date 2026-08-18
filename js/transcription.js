/**
 * AI Transcription (front-end half)
 *
 * The media file lives in the page as a File object, so rather than asking the
 * backend to find and demux it, the browser does the audio prep itself:
 * decode -> downmix to mono -> resample to 16 kHz -> 16-bit PCM WAV. That is
 * precisely Whisper's expected input, so the Python side needs no ffmpeg, and
 * it works identically for video and audio files.
 *
 * The WAV is then streamed to the backend in chunks over the pywebview bridge,
 * the model runs on a worker thread, and this polls for progress.
 */

const TARGET_SAMPLE_RATE = 16000;
const UPLOAD_CHUNK_BYTES = 512 * 1024; // 512 KB per bridge call

// These models are trained on roughly normalised speech, so a quiet VO sitting
// under a loud music bed measurably underperforms. Level is matched to a target
// RMS with a peak ceiling rather than simply peak-normalised, because a single
// loud transient would otherwise leave the dialogue as quiet as it started.
const TARGET_RMS_DBFS = -20;
const PEAK_CEILING = 0.97;
const MAX_GAIN = 12;

// Rumble, traffic and handling noise sit below speech and only cost the model
// headroom, so they are filtered out before it sees the waveform.
const HIGHPASS_HZ = 85;

class TranscriptionController {
  constructor() {
    this.cancelled = false;
    this.jobId = null;
    this.currentFile = null;
  }

  hasBackend() {
    return !!(window.pywebview && window.pywebview.api && window.pywebview.api.transcribe_begin);
  }

  async probe() {
    if (!this.hasBackend()) {
      return { ok: true, available: false, engines: [], reason: 'no-backend' };
    }
    try {
      return await window.pywebview.api.transcribe_probe();
    } catch (e) {
      return { ok: false, available: false, engines: [], error: String(e) };
    }
  }

  setFile(file) {
    this.currentFile = file || null;
  }

  cancel() {
    this.cancelled = true;
    if (this.jobId && this.hasBackend()) {
      window.pywebview.api.transcribe_cancel(this.jobId).catch(() => {});
    }
  }

  /**
   * Decode whatever the user loaded into 16 kHz mono PCM.
   * @returns {Promise<{wav: Uint8Array, duration: number, sampleRate: number}>}
   */
  async extractAudio(file, onProgress, opts = {}) {
    if (!file) throw new Error('Load a video or audio file first.');

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) throw new Error('This browser cannot decode audio.');

    if (onProgress) onProgress(0.05, 'Reading file…');
    const arrayBuffer = await file.arrayBuffer();

    if (onProgress) onProgress(0.15, 'Decoding audio…');
    const decodeCtx = new AudioCtx();
    let decoded;
    try {
      decoded = await decodeCtx.decodeAudioData(arrayBuffer);
    } catch (e) {
      throw new Error(
        `No decodable audio track was found in "${file.name}". ` +
        'Whisper needs an audio stream to transcribe.'
      );
    } finally {
      decodeCtx.close();
    }

    if (decoded.duration <= 0) throw new Error('The audio track is empty.');

    if (onProgress) onProgress(0.3, 'Resampling to 16 kHz mono…');
    const mono = await this.toMono16k(decoded, opts.channel || 'mix');

    let prepared = mono;
    if (opts.normalise !== false) {
      if (onProgress) onProgress(0.45, 'Matching level…');
      prepared = this.normalise(prepared);
    }
    // Unconditional, because resampling overshoots: a file that arrives at
    // -0.1 dBFS comes out of the decode-to-44.1k / render-to-16k pair peaking
    // around +1.5 dBFS, and encodeWav would hard-clip every one of those
    // samples. normalise() already respects the ceiling, so this only bites
    // when the operator has turned level matching off — where clipping would
    // otherwise be the one thing they did not ask for.
    prepared = this.limitPeak(prepared);

    if (onProgress) onProgress(0.55, 'Encoding WAV…');
    const wav = this.encodeWav(prepared, TARGET_SAMPLE_RATE);

    return {
      wav,
      duration: decoded.duration,
      sampleRate: TARGET_SAMPLE_RATE,
      channels: decoded.numberOfChannels,
    };
  }

  /**
   * Match the level these models expect.
   *
   * Gain is computed from RMS, then reduced if it would push the peak into
   * clipping — clipped dialogue transcribes worse than quiet dialogue.
   */
  normalise(samples) {
    let sumSquares = 0;
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
      const v = samples[i];
      sumSquares += v * v;
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
    if (!samples.length || peak === 0) return samples;

    const rms = Math.sqrt(sumSquares / samples.length);
    if (rms < 1e-7) return samples;

    const targetRms = Math.pow(10, TARGET_RMS_DBFS / 20);
    let gain = Math.min(targetRms / rms, MAX_GAIN);
    gain = Math.min(gain, PEAK_CEILING / peak);
    if (gain <= 1.001 && gain >= 0.999) return samples;

    const out = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const v = samples[i] * gain;
      out[i] = v > 1 ? 1 : (v < -1 ? -1 : v);
    }
    return out;
  }

  /**
   * Scale down so nothing exceeds the peak ceiling. A no-op for material that
   * already has headroom, so it never alters a level the operator chose.
   */
  limitPeak(samples) {
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
      const a = Math.abs(samples[i]);
      if (a > peak) peak = a;
    }
    if (peak <= PEAK_CEILING || peak === 0) return samples;

    const gain = PEAK_CEILING / peak;
    const out = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) out[i] = samples[i] * gain;
    return out;
  }

  /**
   * Downmix (or pick a channel), high-pass and resample, using an offline graph.
   *
   * @param channel 'mix' | 'left' | 'right' | 'centre' | number
   *
   * Picking a single channel matters for post deliverables: dialogue is often
   * centre-panned or on its own channel, and downmixing it together with a
   * stereo music bed throws away the very separation that makes it legible.
   */
  async toMono16k(audioBuffer, channel = 'mix') {
    const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const frames = Math.max(1, Math.ceil(audioBuffer.duration * TARGET_SAMPLE_RATE));
    // Always hand the graph a mono buffer. Letting a multi-channel source be
    // downmixed implicitly is not safe: the Web Audio speaker downmix *sums*
    // its inputs, so dual-mono dialogue at -3 dBFS — or any hot 5.1 mix — comes
    // out hard-clipped, and clipped dialogue transcribes badly. It also
    // disagreed with manualResample, which averages, so the same file gave two
    // different levels depending on which path ran.
    const source = this.downmixToMono(this.selectChannel(audioBuffer, channel));

    if (OfflineCtx) {
      try {
        const offline = new OfflineCtx(1, frames, TARGET_SAMPLE_RATE);
        const src = offline.createBufferSource();
        src.buffer = source;

        const highpass = offline.createBiquadFilter();
        highpass.type = 'highpass';
        highpass.frequency.value = HIGHPASS_HZ;
        // Butterworth. The default Q of 1 is resonant, which puts a small gain
        // bump immediately above the corner — the rumble region this filter
        // exists to suppress — and worsens the start-up overshoot.
        highpass.Q.value = Math.SQRT1_2;

        src.connect(highpass);
        highpass.connect(offline.destination);
        src.start(0);
        const rendered = await offline.startRendering();
        return rendered.getChannelData(0);
      } catch (e) {
        // Some engines refuse unusual sample rates; fall through to manual.
      }
    }
    return this.manualResample(source, frames);
  }

  /**
   * Returns a buffer containing just the requested channel, or the original
   * buffer for 'mix'. 'centre' is channel 2 in the WAVE/5.1 ordering
   * (L, R, C, LFE, Ls, Rs), which is where dialogue usually lives.
   */
  selectChannel(audioBuffer, channel) {
    const count = audioBuffer.numberOfChannels;
    if (channel === 'mix' || count <= 1) return audioBuffer;

    const index = channel === 'left' ? 0
      : channel === 'right' ? 1
      : channel === 'centre' ? 2
      : Number(channel);

    if (!Number.isInteger(index) || index < 0 || index >= count) {
      return audioBuffer; // asked for a channel this file does not have
    }

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const single = new AudioCtx().createBuffer(1, audioBuffer.length, audioBuffer.sampleRate);
    single.copyToChannel(audioBuffer.getChannelData(index), 0);
    return single;
  }

  /**
   * Fold a multi-channel buffer down to one channel without ever exceeding the
   * input's peak.
   *
   * Weights follow ITU-R BS.775 for a 5.1 layout (L, R, C, LFE, Ls, Rs): the
   * centre channel carries the dialogue so it keeps full weight, the surrounds
   * are attenuated, and the LFE is dropped entirely — it holds no speech and
   * only adds rumble the high-pass would have to remove anyway. Anything that
   * is not a recognised layout is averaged. Dividing through by the total
   * weight is what guarantees no clipping.
   */
  downmixToMono(audioBuffer) {
    const count = audioBuffer.numberOfChannels;
    if (count <= 1) return audioBuffer;

    // Index-aligned with the WAVE channel order.
    const weights = count >= 6
      ? [0.707, 0.707, 1.0, 0.0, 0.5, 0.5]
      : new Array(count).fill(1);
    while (weights.length < count) weights.push(0.5);

    const total = weights.slice(0, count).reduce((a, w) => a + w, 0) || 1;
    const data = [];
    for (let c = 0; c < count; c++) data.push(audioBuffer.getChannelData(c));

    const out = new Float32Array(audioBuffer.length);
    for (let i = 0; i < out.length; i++) {
      let sum = 0;
      for (let c = 0; c < count; c++) {
        if (weights[c]) sum += data[c][i] * weights[c];
      }
      out[i] = sum / total;
    }

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const mono = new AudioCtx().createBuffer(1, audioBuffer.length, audioBuffer.sampleRate);
    mono.copyToChannel(out, 0);
    return mono;
  }

  /** Linear-interpolation fallback when OfflineAudioContext is unavailable. */
  manualResample(audioBuffer, frames) {
    const channels = audioBuffer.numberOfChannels;
    const data = [];
    for (let c = 0; c < channels; c++) data.push(audioBuffer.getChannelData(c));

    const ratio = audioBuffer.sampleRate / TARGET_SAMPLE_RATE;
    const out = new Float32Array(frames);

    for (let i = 0; i < frames; i++) {
      const pos = i * ratio;
      const i0 = Math.floor(pos);
      const i1 = Math.min(i0 + 1, audioBuffer.length - 1);
      const frac = pos - i0;
      let sum = 0;
      for (let c = 0; c < channels; c++) {
        sum += data[c][i0] * (1 - frac) + data[c][i1] * frac;
      }
      out[i] = sum / channels;
    }
    return out;
  }

  /** 16-bit signed PCM WAV (RIFF), mono. */
  encodeWav(samples, sampleRate) {
    const dataBytes = samples.length * 2;
    const buffer = new ArrayBuffer(44 + dataBytes);
    const view = new DataView(buffer);

    const writeStr = (offset, str) => {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataBytes, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);          // PCM chunk size
    view.setUint16(20, 1, true);           // format = PCM
    view.setUint16(22, 1, true);           // channels = mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // byte rate
    view.setUint16(32, 2, true);           // block align
    view.setUint16(34, 16, true);          // bits per sample
    writeStr(36, 'data');
    view.setUint32(40, dataBytes, true);

    let offset = 44;
    for (let i = 0; i < samples.length; i++) {
      let s = samples[i];
      if (s > 1) s = 1; else if (s < -1) s = -1;
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      offset += 2;
    }
    return new Uint8Array(buffer);
  }

  /**
   * Full run: extract audio, upload, transcribe, return raw segments/words.
   * @param {Object} opts model/language/task settings + onProgress(fraction, message)
   */
  async transcribe(opts = {}) {
    this.cancelled = false;
    this.jobId = null;

    const report = (frac, msg) => {
      if (opts.onProgress) opts.onProgress(Math.max(0, Math.min(1, frac)), msg);
    };

    if (!this.hasBackend()) {
      throw new Error(
        "AI transcription needs the desktop backend. Launch Taylor's Transcriber with "
        + 'run_subtitler.sh (or "python3 app.py") rather than opening index.html in a browser.'
      );
    }

    // A separate dialogue stem, when the operator has one, is free accuracy:
    // no processing and no model change, just cleaner input.
    const file = opts.audioFile || opts.file || this.currentFile;
    const audio = await this.extractAudio(file, report, opts);
    if (this.cancelled) throw new Error('Cancelled.');

    report(0.6, 'Starting transcription job…');
    const begun = await window.pywebview.api.transcribe_begin({
      model: opts.model,
      custom_model: opts.customModel,
      language: opts.language,
      task: opts.task,
      device: opts.device,
      vad: opts.vad !== false,
      keep_uncertain: !!opts.keepUncertain,
      beam_size: opts.beamSize || 5,
      engine: opts.engine || 'auto',
      align: opts.align === undefined ? 'auto' : opts.align,
      vocabulary: opts.vocabulary || '',
      suppress_music: !!opts.suppressMusic,
      carry_context: !!opts.carryContext,
      diarize: !!opts.diarize,
      speakers: opts.speakers || 'auto',
    });
    if (!begun || !begun.ok) throw new Error((begun && begun.error) || 'Could not start transcription.');
    this.jobId = begun.job_id;

    try {
      // Stream the WAV across the bridge.
      const total = audio.wav.length;
      for (let offset = 0; offset < total; offset += UPLOAD_CHUNK_BYTES) {
        if (this.cancelled) throw new Error('Cancelled.');
        const slice = audio.wav.subarray(offset, Math.min(offset + UPLOAD_CHUNK_BYTES, total));
        const res = await window.pywebview.api.transcribe_push_audio(this.jobId, this.bytesToBase64(slice));
        if (!res || !res.ok) throw new Error((res && res.error) || 'Audio upload failed.');
        report(0.6 + 0.15 * ((offset + slice.length) / total), 'Sending audio to the model…');
      }

      const started = await window.pywebview.api.transcribe_finish_audio(this.jobId);
      if (!started || !started.ok) throw new Error((started && started.error) || 'Could not run the model.');

      // Poll until the worker thread finishes.
      let lastMessage = '';
      for (;;) {
        if (this.cancelled) throw new Error('Cancelled.');
        await new Promise(r => setTimeout(r, 400));

        const st = await window.pywebview.api.transcribe_status(this.jobId);
        if (!st || !st.ok) throw new Error((st && st.error) || 'Lost track of the transcription job.');

        if (st.message && st.message !== lastMessage) lastMessage = st.message;
        report(0.75 + 0.25 * (st.progress || 0), lastMessage || 'Transcribing…');

        if (st.state === 'done') {
          return st.result;
        }
        if (st.state === 'error') {
          throw new Error(st.error || st.message || 'Transcription failed.');
        }
        if (st.state === 'cancelled') {
          throw new Error('Cancelled.');
        }
      }
    } finally {
      if (this.jobId) {
        window.pywebview.api.transcribe_cleanup(this.jobId).catch(() => {});
        this.jobId = null;
      }
    }
  }

  /** Chunked so a large buffer cannot blow the argument limit of apply(). */
  bytesToBase64(bytes) {
    let binary = '';
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
    }
    return btoa(binary);
  }

  /** Flattens the backend's segments into one word list for the segmenter. */
  collectWords(result) {
    const words = [];
    (result && result.segments || []).forEach(seg => {
      (seg.words || []).forEach(w => words.push(w));
    });
    return words;
  }
}

window.TranscriptionController = TranscriptionController;
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TranscriptionController };
}
