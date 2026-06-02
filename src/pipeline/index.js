// Translation routing + per-language pipeline lifecycle.
//
// Core efficiency rule: at most ONE pipeline per distinct listener-language per
// room, regardless of how many listeners want that language. Output is fanned
// out to all listeners of that language.

import { createSTT, createTTS, translateText } from './provider.js';
import { createOpenAITranslator } from './openaiRealtime.js';
import { createTTS as cartesiaTTS } from './cartesiaTTS.js';
import { sendToLang, sendControlToLang } from '../relay.js';
import { log } from '../log.js';
import { recordUtterance } from '../metrics.js';
import {
  recordSttAudio, recordTtsChars, recordTranslateChars, costLine,
  recordOpenAiAudio, openaiCostLine, flushCost,
} from '../cost.js';
import { currentKey, hasKeys, isKeyError, rotate } from '../sarvamKeys.js';
import * as oaKeys from '../openaiKeys.js';
import { cartesia as cartesiaPool } from '../labKeys.js';

const MAX_KEY_RESTARTS = 4; // cap auto-restarts when a key fails, to avoid loops

export const LISTENER_SAMPLE_RATE = 16000; // PCM16 rate listeners play (relay + TTS)

const LANG_NAME = { hi: 'Hindi', en: 'English' };
const langName = (l) => LANG_NAME[l] || l;

// PCM16 peak amplitude above which a frame counts as speech (not near-silence).
// Used to mark "end of speech" so we can measure true end-to-end latency.
const VOICE_THRESHOLD = 600;
function hasVoice(pcm) {
  const len = pcm.length - (pcm.length % 2);
  for (let i = 0; i < len; i += 2) {
    const s = pcm.readInt16LE(i);
    if (s > VOICE_THRESHOLD || s < -VOICE_THRESHOLD) return true;
  }
  return false;
}

// Sarvam streaming feels "batchy" because Saaras only emits a transcript after
// its own (longish) silence timeout. We force finalization ourselves: flush
// after a short micro-pause, and flush periodically during nonstop speech so a
// long run still produces continuous output. Both windows are env-tunable.
const num = (v, d) => (v != null && !Number.isNaN(parseFloat(v)) ? parseFloat(v) : d);
const SILENCE_FLUSH_MS = num(process.env.SARVAM_SILENCE_FLUSH_MS, 350);
const MAX_SEGMENT_MS = num(process.env.SARVAM_MAX_SEGMENT_MS, 4000);

// Decide the processing path for a (speaker, listener) language pair.
export function routePath(speakerLang, listenerLang) {
  if (speakerLang === listenerLang) return 'relay';
  // Saaras translate mode: any Indic speech -> English text in one call.
  if (listenerLang === 'en') return 'stt_translate';
  // English speaker -> Hindi listener: transcribe English, then translate text.
  return 'stt_transcribe_translate';
}

class TranslationPipeline {
  constructor(room, speakerLang, targetLang) {
    this.room = room;
    this.speakerLang = speakerLang;
    this.targetLang = targetLang;
    this.apiKey = null; // resolved from the key pool at start()
    this.path = routePath(speakerLang, targetLang);
    this.scope = `${room.id} ${speakerLang}->${targetLang}`;
    this.metricKey = `${room.id}|${speakerLang}->${targetLang}`;
    this.stt = null;
    this.tts = null;
    this.utterances = 0;
    this.restarts = 0; // key-failure restarts so far
    this.stopped = false;
    this.lastVoiceAt = null; // timestamp of the most recent speech frame fed (end-of-speech marker)
    this.awaitingAudio = null; // timing context while waiting on the TTS first chunk
    this.segmentStartedAt = null; // when the current spoken segment began (for max-segment flush)
    this.flushedForSilence = false; // already forced a flush for the current pause?
  }

  // A failed Sarvam key (auth/quota/rate) rotates to the next key and rebuilds
  // the STT/TTS sockets; other errors are just logged.
  handleError(e) {
    log.error(`[pipe ${this.scope}] ${e.message}`);
    if (this.stopped || !isKeyError(e)) return;
    if (this.restarts >= MAX_KEY_RESTARTS) {
      log.warn(`[pipe ${this.scope}] key restarts exhausted — giving up`);
      return;
    }
    if (!rotate(this.apiKey, e.message)) return; // no other key to try
    this.restarts += 1;
    this.stt?.close();
    this.tts?.close();
    this.start();
  }

  start() {
    this.apiKey = currentKey();
    const onError = (e) => this.handleError(e);

    this.tts = createTTS({
      apiKey: this.apiKey,
      targetLang: this.targetLang,
      sampleRate: LISTENER_SAMPLE_RATE,
      label: this.scope,
      onAudio: (pcm) => this.onAudio(pcm),
      onError,
    });

    const mode = this.path === 'stt_translate' ? 'translate' : 'transcribe';
    this.stt = createSTT({
      apiKey: this.apiKey,
      mode,
      sampleRate: LISTENER_SAMPLE_RATE,
      label: this.scope,
      onTranscript: (text) => this.onTranscript(text),
      onError,
    });

    log.pipe(
      this.scope,
      `STARTED ${langName(this.speakerLang)}->${langName(this.targetLang)} ` +
        `(STT mode=${mode}${this.path === 'stt_transcribe_translate' ? ' + text-translate' : ''})`
    );
  }

  onTranscript(text) {
    if (!text) return;
    this.utterances += 1;
    const transcriptAt = Date.now();
    // Snapshot + reset end-of-speech marker so the next utterance measures fresh.
    const voiceEndAt = this.lastVoiceAt;
    this.lastVoiceAt = null;
    this.segmentStartedAt = null; // segment closed; next voiced frame opens a fresh one
    this.flushedForSilence = false;
    const stt_ms = voiceEndAt ? transcriptAt - voiceEndAt : null;
    log.stt(this.scope, `heard: "${text}"${stt_ms != null ? ` (recognize +${stt_ms}ms)` : ''}`);

    if (this.path === 'stt_transcribe_translate') {
      // English text -> target-language text -> speak.
      const t0 = Date.now();
      recordTranslateChars(this.metricKey, text.length);
      translateText({ apiKey: this.apiKey, text, from: this.speakerLang, to: this.targetLang })
        .then((translated) => {
          const translate_ms = Date.now() - t0;
          log.xlate(
            this.scope,
            `${langName(this.speakerLang)}->${langName(this.targetLang)} (${translate_ms}ms): "${translated}"`
          );
          this.speak(translated, { transcriptAt, voiceEndAt, stt_ms, translate_ms });
        })
        .catch((e) => log.error(`[xlate ${this.scope}] ${e.message}`));
    } else {
      // translate mode already produced target-language (English) text.
      this.speak(text, { transcriptAt, voiceEndAt, stt_ms, translate_ms: null });
    }
  }

  speak(text, timing) {
    if (!text) return;
    recordTtsChars(this.metricKey, text.length);
    this.awaitingAudio = { spokeAt: Date.now(), ...timing };
    log.tts(this.scope, `speaking: "${text}"`);
    // Live caption: the target-language line this listener-group is about to hear.
    sendControlToLang(this.room, this.targetLang, { type: 'caption', text, final: true });
    this.tts.sendText(text);
  }

  onAudio(pcm) {
    if (this.awaitingAudio) {
      const a = this.awaitingAudio;
      this.awaitingAudio = null;
      const now = Date.now();
      const tts_ms = now - a.spokeAt;
      const e2e_ms = a.voiceEndAt ? now - a.voiceEndAt : now - a.transcriptAt;
      log.tts(
        this.scope,
        `first audio out (+${tts_ms}ms TTS · +${now - a.transcriptAt}ms transcript->audio)`
      );
      const e2e = recordUtterance(this.metricKey, this.scope, {
        stt_ms: a.stt_ms,
        translate_ms: a.translate_ms,
        tts_ms,
        e2e_ms,
      });
      // Push the latency readout to this language's listeners.
      sendControlToLang(this.room, this.targetLang, {
        type: 'latency',
        last: e2e_ms,
        p50: e2e.p50,
        p95: e2e.p95,
        count: e2e.count,
      });
    }
    sendToLang(this.room, this.targetLang, pcm);
  }

  feed(pcm) {
    const now = Date.now();
    if (hasVoice(pcm)) {
      this.lastVoiceAt = now;
      if (this.segmentStartedAt == null) this.segmentStartedAt = now;
      this.flushedForSilence = false;
    } else if (this.lastVoiceAt && !this.flushedForSilence && now - this.lastVoiceAt >= SILENCE_FLUSH_MS) {
      this.stt?.flush(); // brief pause between clauses -> finalize now, don't wait out Saaras's timeout
      this.flushedForSilence = true;
    }
    if (this.segmentStartedAt && now - this.segmentStartedAt >= MAX_SEGMENT_MS) {
      this.stt?.flush(); // nonstop speech -> force periodic output so listeners aren't left silent
      this.segmentStartedAt = now;
    }
    // Every frame sent to STT is billable audio: bytes / 2 = samples, / rate = seconds.
    recordSttAudio(this.metricKey, pcm.length / 2 / LISTENER_SAMPLE_RATE);
    this.stt?.sendAudio(pcm);
  }

  stop() {
    this.stopped = true;
    this.stt?.close();
    this.tts?.close();
    log.pipe(this.scope, `STOPPED (handled ${this.utterances} utterance${this.utterances === 1 ? '' : 's'})`);
    log.metric(this.scope, `est. cost: ${costLine(this.metricKey)}`);
    flushCost(this.metricKey, 'sarvam');
  }
}

// OpenAI gpt-realtime-translate engine: ONE speech-to-speech socket per target
// language. Streams translated audio while the speaker talks. Implements the
// same feed()/stop() interface as TranslationPipeline so the room manager treats
// them identically. Latency is measured as TTFB: first translated audio of a
// segment minus the first spoken-voice frame of that segment.
class OpenAIRealtimePipeline {
  constructor(room, speakerLang, targetLang) {
    this.room = room;
    this.speakerLang = speakerLang;
    this.targetLang = targetLang;
    this.scope = `${room.id} ${speakerLang}->${targetLang} [gpt]`;
    this.metricKey = `${room.id}|${speakerLang}->${targetLang}`;
    this.apiKey = null;
    this.translator = null;
    this.utterances = 0;
    this.restarts = 0;
    this.stopped = false;
    this.segmentStart = null; // first voiced frame of the current segment
    this.awaitingFirstAudio = false;
  }

  start() {
    this.apiKey = oaKeys.currentKey();
    this.translator = createOpenAITranslator({
      targetLang: this.targetLang,
      label: this.scope,
      onAudio: (pcm) => this.onAudio(pcm),
      onCaption: (text, final) => sendControlToLang(this.room, this.targetLang, { type: 'caption', text, final }),
      onSegmentDone: () => this.onTranscriptDone(),
      onError: (e) => this.handleError(e),
    });
    log.pipe(this.scope, `STARTED gpt-realtime-translate -> ${langName(this.targetLang)}`);
  }

  handleError(e) {
    log.error(`[pipe ${this.scope}] ${e.message}`);
    if (this.stopped || !oaKeys.isKeyError(e)) return;
    if (this.restarts >= MAX_KEY_RESTARTS) {
      log.warn(`[pipe ${this.scope}] key restarts exhausted — giving up`);
      return;
    }
    if (!oaKeys.rotate(this.apiKey, e.message)) return;
    this.restarts += 1;
    this.translator?.close();
    this.start();
  }

  feed(pcm) {
    if (hasVoice(pcm) && this.segmentStart == null) {
      this.segmentStart = Date.now();
      this.awaitingFirstAudio = true;
    }
    recordOpenAiAudio(this.metricKey, pcm.length / 2 / LISTENER_SAMPLE_RATE, 0);
    this.translator?.feed(pcm);
  }

  onAudio(pcm) {
    if (this.awaitingFirstAudio && this.segmentStart != null) {
      this.awaitingFirstAudio = false;
      const e2e_ms = Date.now() - this.segmentStart;
      const e2e = recordUtterance(this.metricKey, this.scope, {
        stt_ms: null, translate_ms: null, tts_ms: null, e2e_ms,
      });
      sendControlToLang(this.room, this.targetLang, {
        type: 'latency', last: e2e_ms, p50: e2e.p50, p95: e2e.p95, count: e2e.count,
      });
    }
    recordOpenAiAudio(this.metricKey, 0, pcm.length / 2 / LISTENER_SAMPLE_RATE);
    sendToLang(this.room, this.targetLang, pcm);
  }

  onTranscriptDone() {
    this.utterances += 1;
    this.segmentStart = null; // next voiced frame opens a fresh segment
    this.awaitingFirstAudio = false;
  }

  stop() {
    this.stopped = true;
    this.translator?.close();
    log.pipe(this.scope, `STOPPED (handled ${this.utterances} segment${this.utterances === 1 ? '' : 's'})`);
    log.metric(this.scope, `est. cost: ${openaiCostLine(this.metricKey)}`);
    flushCost(this.metricKey, 'openai');
  }
}


// Sarvam STT + Sarvam translate + Cartesia TTS — fastest confirmed combo (511ms p50).
// Same accuracy as the default Sarvam chain (Saaras STT unchanged), only TTS swapped.
class CartesiaPipeline extends TranslationPipeline {
  start() {
    this.apiKey = currentKey();
    const onError = (e) => this.handleError(e);

    this.tts = cartesiaTTS({
      apiKey: cartesiaPool.currentKey(),
      targetLang: this.targetLang,
      sampleRate: LISTENER_SAMPLE_RATE,
      label: this.scope,
      onAudio: (pcm) => this.onAudio(pcm),
      onError,
    });

    const mode = this.path === 'stt_translate' ? 'translate' : 'transcribe';
    this.stt = createSTT({
      apiKey: this.apiKey,
      mode,
      sampleRate: LISTENER_SAMPLE_RATE,
      label: this.scope,
      onTranscript: (text) => this.onTranscript(text),
      onError,
    });

    log.pipe(
      this.scope,
      `STARTED ${langName(this.speakerLang)}->${langName(this.targetLang)} ` +
        `(STT mode=${mode}${this.path === 'stt_transcribe_translate' ? ' + text-translate' : ''} · TTS=Cartesia)`
    );
  }
}

// Reconcile a room's live pipelines with current listener languages.
// At most ONE pipeline per target language exists at any time; listeners of an
// already-covered language reuse the running pipeline (no new one is created).
export function syncPipelines(room) {
  if (!room.pipelines) room.pipelines = new Map();

  const desired =
    room.speaker && room.live && room.speakerLang ? room.translatedLangs() : new Set();

  let changed = false;

  // Create missing pipelines, picking the engine the speaker chose for the room.
  for (const lang of desired) {
    if (room.pipelines.has(lang)) continue; // language already covered — reuse it

    let useOpenAI = room.provider === 'openai';
    let useCartesia = room.provider === 'cartesia';

    if (useOpenAI && !oaKeys.hasKeys()) {
      log.warn(`[${room.id}] OPENAI_API_KEY missing — falling back to Sarvam for ${langName(lang)}`);
      useOpenAI = false;
    }
    if (useCartesia && !cartesiaPool.hasKeys()) {
      log.warn(`[${room.id}] CARTESIA_API_KEY missing — falling back to Sarvam for ${langName(lang)}`);
      useCartesia = false;
    }
    if (!useOpenAI && !hasKeys()) {
      log.warn(`[${room.id}] SARVAM_API_KEY missing — cannot translate to ${langName(lang)}`);
      continue;
    }

    const p = useOpenAI
      ? new OpenAIRealtimePipeline(room, room.speakerLang, lang)
      : useCartesia
        ? new CartesiaPipeline(room, room.speakerLang, lang)
        : new TranslationPipeline(room, room.speakerLang, lang);
    p.start();
    room.pipelines.set(lang, p);
    changed = true;
  }

  // Tear down pipelines no longer needed.
  for (const [lang, p] of room.pipelines) {
    if (!desired.has(lang)) {
      p.stop();
      room.pipelines.delete(lang);
      changed = true;
    }
  }

  if (changed) {
    const groups = room.listenersByLang();
    const summary = [...room.pipelines.keys()]
      .map((l) => `${langName(l)}(${groups.get(l)?.size || 0} listener${(groups.get(l)?.size || 0) === 1 ? '' : 's'})`)
      .join(', ');
    log.pipe(
      room.id,
      `active translation pipelines: ${room.pipelines.size === 0 ? 'none' : summary} ` +
        `· speaker=${langName(room.speakerLang)}`
    );
  }
}

// Forward a speaker PCM frame into every active pipeline.
export function feedAudio(room, pcm) {
  if (!room.pipelines) return;
  for (const p of room.pipelines.values()) p.feed(pcm);
}

export function destroyPipelines(room) {
  if (!room.pipelines) return;
  for (const p of room.pipelines.values()) p.stop();
  room.pipelines.clear();
}
