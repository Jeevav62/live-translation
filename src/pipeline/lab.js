// Lab pipeline: a one-off translation chain for the experiment page. Lets you mix
// any STT / Translate / TTS provider, loops the translated audio back to the
// originating socket, and reports per-stage latency + transcript + translation so
// combos can be compared. Output is always 16 kHz PCM16 (resampled if needed).
//
// Routing:
//   - Sarvam STT to English: Saaras mode=translate gives English directly (no
//     separate translate step).
//   - Everything else: STT transcribes the source, then translateText() converts
//     source -> target, then TTS speaks it.

import { createSTT, createTTS, translateText } from './provider.js';
import { createOpenAITranslator } from './openaiRealtime.js';
import { resamplePcm16 } from './resample.js';
import { log } from '../log.js';
import { recordUtterance } from '../metrics.js';
import { currentKey as sarvamKey } from '../sarvamKeys.js';
import { deepgram, eleven, cartesia } from '../labKeys.js';

const LISTENER_SAMPLE_RATE = 16000;
const LANG_NAME = { hi: 'Hindi', en: 'English' };
const langName = (l) => LANG_NAME[l] || l;

const VOICE_THRESHOLD = 600;
function hasVoice(pcm) {
  const len = pcm.length - (pcm.length % 2);
  for (let i = 0; i < len; i += 2) {
    const s = pcm.readInt16LE(i);
    if (s > VOICE_THRESHOLD || s < -VOICE_THRESHOLD) return true;
  }
  return false;
}

const num = (v, d) => (v != null && !Number.isNaN(parseFloat(v)) ? parseFloat(v) : d);
const SILENCE_FLUSH_MS = num(process.env.SARVAM_SILENCE_FLUSH_MS, 350);
const MAX_SEGMENT_MS = num(process.env.SARVAM_MAX_SEGMENT_MS, 4000);

// Resolve an API key for a given role+provider from the right pool.
function keyFor(provider) {
  switch (provider) {
    case 'deepgram': return deepgram.currentKey();
    case 'eleven': return eleven.currentKey();
    case 'cartesia': return cartesia.currentKey();
    case 'sarvam':
    default: return sarvamKey();
  }
}

export class LabPipeline {
  constructor({ engine, sttProvider, translateProvider, ttsProvider, sttModel, ttsModel, speakerLang, targetLang, onAudio, onControl }) {
    this.engine = engine === 'gpt' ? 'gpt' : 'pipeline';
    this.stt = sttProvider || 'sarvam';
    this.tr = translateProvider || 'sarvam';
    this.ttsP = ttsProvider || 'sarvam';
    this.sttModel = sttModel || null;
    this.ttsModel = ttsModel || null;
    this.speakerLang = speakerLang;
    this.targetLang = targetLang;
    this.onAudio = onAudio;
    this.onControl = onControl;

    // Sarvam STT can translate Indic->English in one call; otherwise we transcribe
    // then translate as a separate step.
    this.usesSaarasTranslate = this.stt === 'sarvam' && this.targetLang === 'en';
    this.needsTranslate = !this.usesSaarasTranslate && this.speakerLang !== this.targetLang;

    this.combo = this.engine === 'gpt'
      ? 'gpt-realtime'
      : `${this.stt}+${this.needsTranslate ? this.tr : '—'}+${this.ttsP}`;
    this.scope = `lab ${this.combo} ${speakerLang}->${targetLang}`;
    this.metricKey = `lab|${speakerLang}->${targetLang}`;

    this.sttClient = null;
    this.ttsClient = null;
    this.translator = null;      // GPT engine
    this.segmentStart = null;    // GPT: first voiced frame of current segment
    this.awaitingFirstAudio = false;
    this.lastVoiceAt = null;
    this.segmentStartedAt = null;
    this.flushedForSilence = false;
    this.awaitingAudio = null;
    this.stopped = false;
  }

  start() {
    // Surface provider errors to the lab page (e.g. ElevenLabs payment_required),
    // not just the server log — but throttle so a failing socket can't spam.
    const onError = (e) => {
      log.error(`[lab ${this.scope}] ${e.message}`);
      const now = Date.now();
      if (now - (this._lastErrAt || 0) > 1500) {
        this._lastErrAt = now;
        this.onControl?.({ type: 'error', message: e.message });
      }
    };

    if (this.engine === 'gpt') {
      this.translator = createOpenAITranslator({
        targetLang: this.targetLang,
        label: this.scope,
        onAudio: (pcm) => this.handleGptAudio(pcm),
        onCaption: (text, final) => this.onControl?.({ type: 'caption', text, final }),
        onSegmentDone: () => { this.segmentStart = null; this.awaitingFirstAudio = false; },
        onError,
      });
      log.pipe(this.scope, `STARTED gpt-realtime-translate ${langName(this.speakerLang)}->${langName(this.targetLang)}`);
      return;
    }

    this.ttsClient = createTTS({
      provider: this.ttsP,
      apiKey: keyFor(this.ttsP),
      targetLang: this.targetLang,
      sampleRate: LISTENER_SAMPLE_RATE,
      model: this.ttsModel || undefined,
      label: this.scope,
      onAudio: (pcm) => this.handleAudio(pcm),
      onError,
    });

    this.sttClient = createSTT({
      provider: this.stt,
      apiKey: keyFor(this.stt),
      mode: this.usesSaarasTranslate ? 'translate' : 'transcribe', // Sarvam-only
      model: this.sttModel || undefined,
      srcLang: this.speakerLang, // Deepgram/ElevenLabs need the source language
      sampleRate: LISTENER_SAMPLE_RATE,
      label: this.scope,
      onTranscript: (text) => this.handleTranscript(text),
      onError,
    });

    log.pipe(this.scope, `STARTED ${langName(this.speakerLang)}->${langName(this.targetLang)} ` +
      `(STT=${this.stt}${this.needsTranslate ? ` · translate=${this.tr}` : ''} · TTS=${this.ttsP})`);
  }

  feed(pcm) {
    if (this.stopped) return;

    if (this.engine === 'gpt') {
      if (hasVoice(pcm) && this.segmentStart == null) {
        this.segmentStart = Date.now();
        this.awaitingFirstAudio = true;
      }
      this.translator?.feed(pcm);
      return;
    }

    const now = Date.now();
    if (hasVoice(pcm)) {
      this.lastVoiceAt = now;
      if (this.segmentStartedAt == null) this.segmentStartedAt = now;
      this.flushedForSilence = false;
    } else if (this.lastVoiceAt && !this.flushedForSilence && now - this.lastVoiceAt >= SILENCE_FLUSH_MS) {
      this.sttClient?.flush();
      this.flushedForSilence = true;
    }
    if (this.segmentStartedAt && now - this.segmentStartedAt >= MAX_SEGMENT_MS) {
      this.sttClient?.flush();
      this.segmentStartedAt = now;
    }
    this.sttClient?.sendAudio(pcm);
  }

  handleTranscript(text) {
    if (!text || this.stopped) return;
    const transcriptAt = Date.now();
    const voiceEndAt = this.lastVoiceAt;
    this.lastVoiceAt = null;
    this.segmentStartedAt = null;
    this.flushedForSilence = false;
    const stt_ms = voiceEndAt ? transcriptAt - voiceEndAt : null;
    log.stt(this.scope, `heard: "${text}"${stt_ms != null ? ` (recognize +${stt_ms}ms)` : ''}`);
    this.onControl?.({ type: 'transcript', text });

    if (this.needsTranslate) {
      const t0 = Date.now();
      translateText({ provider: this.tr, apiKey: keyFor(this.tr), text, from: this.speakerLang, to: this.targetLang })
        .then((translated) => {
          const translate_ms = Date.now() - t0;
          log.xlate(this.scope, `(${translate_ms}ms): "${translated}"`);
          this.speak(translated, { transcriptAt, voiceEndAt, stt_ms, translate_ms });
        })
        .catch((e) => log.error(`[lab xlate ${this.scope}] ${e.message}`));
    } else {
      this.speak(text, { transcriptAt, voiceEndAt, stt_ms, translate_ms: null });
    }
  }

  speak(text, timing) {
    if (!text || this.stopped) return;
    this.awaitingAudio = { spokeAt: Date.now(), ...timing };
    log.tts(this.scope, `speaking: "${text}"`);
    this.onControl?.({ type: 'caption', text, final: true });
    this.ttsClient?.sendText(text);
  }

  handleAudio(pcm) {
    if (this.stopped) return;
    // Normalize to 16 kHz in case a TTS provider streamed a different rate.
    const rate = this.ttsClient?.sampleRate || LISTENER_SAMPLE_RATE;
    const out = rate === LISTENER_SAMPLE_RATE ? pcm : resamplePcm16(pcm, rate, LISTENER_SAMPLE_RATE);

    if (this.awaitingAudio) {
      const a = this.awaitingAudio;
      this.awaitingAudio = null;
      const now = Date.now();
      const tts_ms = now - a.spokeAt;
      const e2e_ms = a.voiceEndAt ? now - a.voiceEndAt : now - a.transcriptAt;
      log.tts(this.scope, `first audio out (+${tts_ms}ms TTS · +${now - a.transcriptAt}ms transcript->audio)`);
      const e2e = recordUtterance(
        this.metricKey, this.scope,
        { stt_ms: a.stt_ms, translate_ms: a.translate_ms, tts_ms, e2e_ms },
        { combo: this.combo }
      );
      this.onControl?.({
        type: 'latency',
        last: e2e_ms, p50: e2e.p50, p95: e2e.p95, count: e2e.count,
        stt_ms: a.stt_ms, translate_ms: a.translate_ms, tts_ms,
      });
    }
    this.onAudio?.(out);
  }

  // GPT engine: translated audio arrives (already 16 kHz). Measure E2E as first
  // audio of a segment minus the first voiced frame of that segment.
  handleGptAudio(pcm) {
    if (this.stopped) return;
    if (this.awaitingFirstAudio && this.segmentStart != null) {
      this.awaitingFirstAudio = false;
      const e2e_ms = Date.now() - this.segmentStart;
      const e2e = recordUtterance(
        this.metricKey, this.scope,
        { stt_ms: null, translate_ms: null, tts_ms: null, e2e_ms },
        { combo: this.combo }
      );
      this.onControl?.({
        type: 'latency', last: e2e_ms, p50: e2e.p50, p95: e2e.p95, count: e2e.count,
        stt_ms: null, translate_ms: null, tts_ms: null,
      });
    }
    this.onAudio?.(pcm);
  }

  stop() {
    this.stopped = true;
    this.sttClient?.close();
    this.ttsClient?.close();
    this.translator?.close();
    log.pipe(this.scope, 'STOPPED');
  }
}
