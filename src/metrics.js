// Latency metrics for the translated path. Records per-utterance stage timings
// and keeps running aggregates (count/avg/p50/p95/min/max) per room+language,
// so we can quote real numbers instead of guessing.
//
// Stages:
//   stt_ms       end-of-speech -> transcript        (Saaras recognize latency)
//   translate_ms transcript -> translated text      (text-translate REST; En->Hi only)
//   tts_ms       text sent -> first audio chunk out  (Bulbul synthesis latency)
//   e2e_ms       end-of-speech -> first audio out    (what the listener actually feels)

import { log } from './log.js';

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

class Stat {
  constructor() {
    this.samples = [];
  }
  add(v) {
    if (v != null && Number.isFinite(v)) this.samples.push(v);
  }
  summary() {
    const s = [...this.samples].sort((a, b) => a - b);
    const n = s.length;
    const sum = s.reduce((a, b) => a + b, 0);
    return {
      count: n,
      avg: n ? Math.round(sum / n) : 0,
      p50: Math.round(percentile(s, 50)),
      p95: Math.round(percentile(s, 95)),
      min: n ? s[0] : 0,
      max: n ? s[n - 1] : 0,
    };
  }
}

const tracks = new Map(); // key -> { stt, translate, tts, e2e }

function trackFor(key) {
  let t = tracks.get(key);
  if (!t) {
    t = { stt: new Stat(), translate: new Stat(), tts: new Stat(), e2e: new Stat() };
    tracks.set(key, t);
  }
  return t;
}

// sample: { stt_ms, translate_ms, tts_ms, e2e_ms } (any may be null)
export function recordUtterance(key, scope, sample) {
  const t = trackFor(key);
  t.stt.add(sample.stt_ms);
  t.translate.add(sample.translate_ms);
  t.tts.add(sample.tts_ms);
  t.e2e.add(sample.e2e_ms);

  const parts = [];
  if (sample.stt_ms != null) parts.push(`STT ${sample.stt_ms}ms`);
  if (sample.translate_ms != null) parts.push(`translate ${sample.translate_ms}ms`);
  if (sample.tts_ms != null) parts.push(`TTS ${sample.tts_ms}ms`);
  parts.push(`E2E ${sample.e2e_ms}ms`);

  const e = t.e2e.summary();
  log.metric(
    scope,
    `${parts.join(' · ')}  |  E2E avg ${e.avg} · p50 ${e.p50} · p95 ${e.p95}ms (n=${e.count})`
  );
}

// Full aggregate snapshot for the /metrics endpoint.
export function snapshot() {
  const out = {};
  for (const [key, t] of tracks) {
    out[key] = {
      stt_ms: t.stt.summary(),
      translate_ms: t.translate.summary(),
      tts_ms: t.tts.summary(),
      e2e_ms: t.e2e.summary(),
    };
  }
  return out;
}

export function resetMetrics() {
  tracks.clear();
}
