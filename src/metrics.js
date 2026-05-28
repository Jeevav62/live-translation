// Latency metrics for the translated path. Records per-utterance stage timings
// and keeps running aggregates (count/avg/p50/p95/min/max) per room+language,
// so we can quote real numbers instead of guessing.
//
// Stages:
//   stt_ms       end-of-speech -> transcript        (Saaras recognize latency)
//   translate_ms transcript -> translated text      (text-translate REST; En->Hi only)
//   tts_ms       text sent -> first audio chunk out  (Bulbul synthesis latency)
//   e2e_ms       end-of-speech -> first audio out    (what the listener actually feels)

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { log } from './log.js';

// Durable per-utterance latency log (survives restarts; no DB). One JSON line
// per measured utterance so real demo traffic builds a permanent record of
// stage timings we can quote later instead of scrolling the console.
const LOG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'logs');
const LATENCY_FILE = join(LOG_DIR, 'latency.jsonl');
function appendLatency(rec) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LATENCY_FILE, JSON.stringify(rec) + '\n');
  } catch { /* best-effort */ }
}

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
// meta (optional): { combo } — a provider-combo label for lab runs, so the durable
// history can group/compare combos instead of just provider+direction.
export function recordUtterance(key, scope, sample, meta = {}) {
  const t = trackFor(key);
  t.stt.add(sample.stt_ms);
  t.translate.add(sample.translate_ms);
  t.tts.add(sample.tts_ms);
  t.e2e.add(sample.e2e_ms);

  // Persist the raw sample so the evidence outlives this process. Provider is
  // inferred from the scope tag the pipeline passes ("[gpt]" => OpenAI).
  const [roomId, pair] = key.split('|');
  appendLatency({
    ts: new Date().toISOString(),
    roomId,
    pair,
    provider: scope.includes('[gpt]') ? 'openai' : 'sarvam',
    combo: meta.combo || null,
    stt_ms: sample.stt_ms,
    translate_ms: sample.translate_ms,
    tts_ms: sample.tts_ms,
    e2e_ms: sample.e2e_ms,
  });

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
  return e; // E2E aggregate summary, so callers can surface it (e.g. to listeners)
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

// Aggregate the durable latency log by direction (and provider), so we can quote
// real numbers from ALL past sessions, not just the current process. Backs the
// /metrics/history endpoint.
export function latencyHistory() {
  let lines;
  try {
    lines = fs.readFileSync(LATENCY_FILE, 'utf8').split('\n').filter(Boolean);
  } catch {
    return { samples: 0, byDirection: {}, note: 'No latency log yet — run some translated traffic.' };
  }
  const groups = new Map(); // "sarvam hi->en" -> { stt, translate, tts, e2e }
  let total = 0;
  for (const line of lines) {
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    total += 1;
    // Lab runs group by their provider-combo so combos are comparable; main-room
    // runs group by provider+direction (aggregates across rooms).
    const gkey = r.combo ? `${r.combo} ${r.pair}` : `${r.provider || 'sarvam'} ${r.pair}`;
    let g = groups.get(gkey);
    if (!g) { g = { stt: new Stat(), translate: new Stat(), tts: new Stat(), e2e: new Stat() }; groups.set(gkey, g); }
    g.stt.add(r.stt_ms); g.translate.add(r.translate_ms); g.tts.add(r.tts_ms); g.e2e.add(r.e2e_ms);
  }
  const byDirection = {};
  for (const [gkey, g] of groups) {
    byDirection[gkey] = {
      stt_ms: g.stt.summary(),
      translate_ms: g.translate.summary(),
      tts_ms: g.tts.summary(),
      e2e_ms: g.e2e.summary(),
    };
  }
  return { samples: total, byDirection };
}
