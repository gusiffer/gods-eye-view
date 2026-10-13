/**
 * Local voice audio: microphone voice-activity detection, WAV capture, and
 * speech in/out through the dev server's Open WebUI proxy.
 *
 * Why hand-rolled VAD: the OpenAI path gets semantic VAD server-side; the
 * local pipeline records in the browser. A simple RMS gate with hangover is
 * the durable baseline that works offline on every Chromium. The mic stream
 * runs the whole session so bar-in (speech while the assistant talks) is
 * possible without re-prompting for the microphone.
 *
 * Nothing here touches disk: utterances are Float32 slices in memory, encoded
 * to one WAV ArrayBuffer per turn, POSTed, and released.
 */

/** End-of-utterance hangover after energy drops below the gate. */
export const SPEECH_HANGOVER_MS = 700;
/** Ignore blips shorter than this (coughs, clicks). */
export const MIN_SPEECH_MS = 220;
/** Hard cap per utterance so a held-open gate cannot record forever. */
export const MAX_UTTERANCE_MS = 15_000;
/** RMS gate floor when the calibration window is too quiet to trust. */
export const MIN_RMS_GATE = 0.008;
/** Calibration window length (ambient noise sampling after start). */
export const CALIBRATION_MS = 600;
/** Recording sample rate for the uploaded clip (Whisper prefers 16 kHz). */
export const RECORD_SAMPLE_RATE = 16_000;

/**
 * One VAD decision. Pure so tests can pin the state machine.
 *
 * @param {{
 *   rms:number, gate:number, state:'idle'|'calibrating'|'listening'|'speaking',
 *   speechStart:number|null, now:number
 * }} input
 * @param {{hangoverMs?:number,minSpeechMs?:number,maxUtteranceMs?:number}} [options]
 * @returns {{state:'idle'|'listening'|'speaking', speechStart:number|null,
 *            event:'none'|'speech_start'|'speech_end', rms:number}}
 */
export function vadStep(input, options = {}) {
  const hangoverMs = options.hangoverMs ?? SPEECH_HANGOVER_MS;
  const minSpeechMs = options.minSpeechMs ?? MIN_SPEECH_MS;
  const maxUtteranceMs = options.maxUtteranceMs ?? MAX_UTTERANCE_MS;
  const above = input.rms > input.gate;
  let { state, speechStart } = input;
  let event = 'none';
  if (state === 'calibrating') {
    // The caller advances this out of calibration after its window; audio
    // during calibration never produces events.
    return { state, speechStart: null, event: 'none', rms: input.rms };
  }
  // From 'speaking' (a turn just ended) the gate re-arms like from idle: the
  // session owns barge-in separately, so the VAD only decides utterances.
  if (above && (state === 'speaking' || state === 'idle')) {
    state = 'listening';
    if (speechStart == null) {
      speechStart = input.now;
      event = 'speech_start';
    }
  }
  if (state === 'listening') {
    const duration = speechStart == null ? 0 : input.now - speechStart;
    if (above) {
      if (duration >= maxUtteranceMs) {
        event = 'speech_end';
        state = 'speaking';
        // 'speaking' re-arms on the next above-gate frame; speechStart resets.
        speechStart = null;
      }
    } else if (speechStart != null && input.now - speechStart >= hangoverMs) {
      // Below the gate for the full hangover: end the utterance when it was
      // real speech; a blip shorter than minSpeechMs never emits an event.
      if (input.now - speechStart >= minSpeechMs) {
        event = 'speech_end';
      }
      state = 'speaking';
      speechStart = null;
    }
  }
  return { state, speechStart, event, rms: input.rms };
}

/** RMS of a Float32 frame, 0..1 by design of full-scale sine ≈ 0.707. */
export function computeRms(frame) {
  if (!frame?.length) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / frame.length);
}

/**
 * Encode Float32 PCM as a 16-bit mono WAV ArrayBuffer.
 * Pure; exported for tests.
 *
 * @param {Float32Array} samples
 * @param {number} sampleRate
 * @returns {ArrayBuffer}
 */
export function encodeWav(samples, sampleRate = RECORD_SAMPLE_RATE) {
  const bytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + bytes);
  const view = new DataView(buffer);
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i++)
      view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + bytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, bytes, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return buffer;
}

/** Downmix (mono average) and naively downsample by integer factor. Pure. */
export function downsampleTo16k(chunks, sourceRate) {
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  if (!totalLength) return { samples: new Float32Array(0), rate: RECORD_SAMPLE_RATE };
  const mono = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    mono.set(chunk, offset);
    offset += chunk.length;
  }
  const factor = Math.max(1, Math.round(sourceRate / RECORD_SAMPLE_RATE));
  if (factor === 1 || sourceRate <= RECORD_SAMPLE_RATE)
    return { samples: mono, rate: sourceRate };
  const outLength = Math.floor(mono.length / factor);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    let sum = 0;
    for (let j = 0; j < factor; j++) sum += mono[i * factor + j];
    out[i] = sum / factor;
  }
  return { samples: out, rate: RECORD_SAMPLE_RATE };
}

/**
 * Own the microphone, the VAD loop and the speech requests.
 * Constructed per voice session; `stop()` releases everything.
 *
 * @param {object} options
 * @param {Function} options.onUtterance receives {samples, rate}.
 * @param {Function} [options.onSpeechStart] barge-in hook.
 * @param {Function} [options.onLevel] normalized mic level 0..1 per frame.
 * @param {Function} [options.fetchImpl] injectable for tests.
 * @param {typeof MediaStreamAudioSourceNode} — created internally, not injectable.
 */
export class LocalVoiceAudio {
  constructor({
    onUtterance,
    onSpeechStart,
    onLevel,
    fetchImpl = (...args) => fetch(...args),
    speakVoice,
  } = {}) {
    this.onUtterance = onUtterance;
    this.onSpeechStart = onSpeechStart;
    this.onLevel = onLevel;
    this.fetchImpl = fetchImpl;
    this.speakVoice = speakVoice;
    this.stream = null;
    this.context = null;
    this.processor = null;
    this.source = null;
    this.ttsAudio = null;
    this.ttsBlobUrl = null;
    this.state = 'idle';
    this.speechStart = null;
    this.calibratedAt = 0;
    this.ambientRms = 0;
    this.pending = [];
    this.speaking = false;
    this.stopped = false;
    this.gate = MIN_RMS_GATE;
  }

  async start() {
    if (this.stopped) return false;
    const AudioContextClass =
      globalThis.window?.AudioContext || globalThis.webkitAudioContext;
    if (!navigator?.mediaDevices?.getUserMedia || !AudioContextClass)
      throw new Error('Microphone capture is unavailable in this browser');
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
    if (this.stopped) {
      this.releaseStream();
      return false;
    }
    this.context = new AudioContextClass();
    await this.context.resume().catch(() => {});
    // 4096-sample frames ≈ 85 ms at 48 kHz: coarse enough to be cheap,
    // fine enough for utterance segmentation.
    this.processor = this.context.createScriptProcessor(4096, 1, 1);
    this.source = this.context.createMediaStreamSource(this.stream);
    this.source.connect(this.processor);
    // ScriptProcessor needs a destination to pump; a zero-gain node is silent.
    this.silentSink = this.context.createGain();
    this.silentSink.gain.value = 0;
    this.processor.connect(this.silentSink);
    this.silentSink.connect(this.context.destination);
    this.calibratedAt = Date.now();
    this.state = 'calibrating';
    this.processor.onaudioprocess = (event) => this.handleAudio(event);
    return true;
  }

  handleAudio(event) {
    if (this.stopped) return;
    const input = event.inputBuffer.getChannelData(0);
    const rms = computeRms(input);
    this.onLevel?.(Math.min(1, rms * 6));
    const now = Date.now();
    if (this.state === 'calibrating') {
      this.pending.push(input.slice());
      if (now - this.calibratedAt >= CALIBRATION_MS) {
        // Ambient noise estimate: median RMS of the calibration window.
        const frames = this.pending;
        this.pending = [];
        const levels = frames.map((f) => computeRms(f)).sort((a, b) => a - b);
        this.ambientRms = levels[Math.floor(levels.length / 2)] || 0;
        // Speech must clear the ambient floor by a healthy margin.
        this.gate = Math.max(MIN_RMS_GATE, this.ambientRms * 3.2);
        this.state = 'speaking';
        this.speechStart = null;
      }
      return;
    }
    const decision = vadStep({
      rms,
      gate: this.gate,
      state: this.state,
      speechStart: this.speechStart,
      now,
    });
    if (decision.event === 'speech_start') this.onSpeechStart?.();
    if (this.state !== 'speaking' || decision.state === 'listening')
      this.pending.push(input.slice());
    if (decision.event === 'speech_end') {
      const { samples, rate } = downsampleTo16k(
        this.pending,
        this.context.sampleRate,
      );
      this.pending = [];
      this.state = decision.state;
      this.speechStart = null;
      if (samples.length)
        this.onUtterance?.({ samples, rate, sourceRate: this.context.sampleRate });
      return;
    }
    this.state = decision.state;
    this.speechStart = decision.speechStart;
  }

  /**
   * Transcribe one utterance through the dev-server proxy.
   * @returns {Promise<string>} recognized text ('' when nothing recognized).
   */
  async transcribe({ samples, rate }) {
    const wav = encodeWav(samples, rate);
    const form = new FormData();
    form.append(
      'file',
      new Blob([wav], { type: 'audio/wav' }),
      'gev-utterance.wav',
    );
    const response = await this.fetchImpl('/api/llm/transcribe', {
      method: 'POST',
      body: form,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok)
      throw new Error(data?.error || `Transcription failed: HTTP ${response.status}`);
    return String(data?.text ?? '').trim();
  }

  /**
   * Speak one line through the Open WebUI TTS proxy. Resolves when playback
   * ends or `stopTts()` cut it; rejects only when the proxy refuses.
   */
  async speak(text) {
    const clean = String(text || '').trim();
    if (!clean) return;
    this.stopTts();
    const response = await this.fetchImpl('/api/llm/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: clean.slice(0, 2000),
        ...(this.speakVoice ? { voice: this.speakVoice } : {}),
      }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      throw new Error(data?.error || `Speech synthesis failed: HTTP ${response.status}`);
    }
    const blob = await response.blob();
    if (this.stopped) return;
    this.ttsBlobUrl = URL.createObjectURL(blob);
    this.ttsAudio = new Audio(this.ttsBlobUrl);
    const audio = this.ttsAudio;
    this.speaking = true;
    return new Promise((resolve) => {
      const done = () => {
        if (this.ttsAudio === audio) {
          this.ttsAudio = null;
          if (this.ttsBlobUrl) {
            URL.revokeObjectURL(this.ttsBlobUrl);
            this.ttsBlobUrl = null;
          }
          this.speaking = false;
        }
        resolve();
      };
      audio.addEventListener('ended', done, { once: true });
      audio.addEventListener('error', done, { once: true });
      audio.play().catch(() => done());
    });
  }

  /** Stop playback immediately (barge-in). */
  stopTts() {
    if (this.ttsAudio) {
      try {
        this.ttsAudio.pause();
        this.ttsAudio.src = '';
      } catch {
        /* releasing is best-effort */
      }
      this.ttsAudio = null;
    }
    if (this.ttsBlobUrl) {
      URL.revokeObjectURL(this.ttsBlobUrl);
      this.ttsBlobUrl = null;
    }
    this.speaking = false;
  }

  releaseStream() {
    try {
      this.stream?.getTracks().forEach((track) => track.stop());
    } catch {
      /* no-op */
    }
    this.stream = null;
  }

  /** Release the mic, the audio graph and playback. Idempotent. */
  stop() {
    this.stopped = true;
    this.stopTts();
    if (this.processor) {
      this.processor.onaudioprocess = null;
      try {
        this.processor.disconnect();
      } catch {
        /* no-op */
      }
      this.processor = null;
    }
    try {
      this.source?.disconnect();
    } catch {
      /* no-op */
    }
    this.source = null;
    try {
      this.silentSink?.disconnect();
    } catch {
      /* no-op */
    }
    this.silentSink = null;
    if (this.context) {
      this.context.close().catch(() => {});
      this.context = null;
    }
    this.releaseStream();
    this.pending = [];
    this.state = 'idle';
    this.speechStart = null;
  }
}