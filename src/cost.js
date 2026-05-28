// Cost calculator for the translated path. Usage counts are EXACT (measured
// from real pipeline traffic); the per-unit rates are configurable placeholders
// you confirm against your Sarvam billing dashboard (https://www.sarvam.ai).
//
// Billable units per provider:
//   STT (Saaras)   — audio duration sent to the recognizer  (per minute)
//   TTS (Bulbul)   — characters synthesized                 (per 1000 chars)
//   Translate      — characters translated                  (per 1000 chars)
//   Relay (same-language) — free, no API call.
//
// Override rates via env (no redeploy of code needed):
//   SARVAM_CURRENCY=INR
//   SARVAM_STT_RATE_PER_MIN=0.5
//   SARVAM_TTS_RATE_PER_1K_CHARS=1.5
//   SARVAM_TRANSLATE_RATE_PER_1K_CHARS=0.4

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const num = (v, d) => (v != null && !Number.isNaN(parseFloat(v)) ? parseFloat(v) : d);

// Defaults reflect Sarvam's published list pricing (Jan 2026). Confirm against
// your own dashboard tier and override via env if needed.
//   STT Saaras   ₹30/hour       => ₹0.5 / min
//   TTS Bulbul   ₹15–30/10K ch  => ₹1.5–3.0 / 1K chars (default low tier 1.5)
//   Translate    ₹20/10K chars  => ₹2.0 / 1K chars
export const RATES = {
  currency: process.env.SARVAM_CURRENCY || 'INR',
  sttPerMin: num(process.env.SARVAM_STT_RATE_PER_MIN, 0.5),
  ttsPer1kChars: num(process.env.SARVAM_TTS_RATE_PER_1K_CHARS, 1.5),
  translatePer1kChars: num(process.env.SARVAM_TRANSLATE_RATE_PER_1K_CHARS, 2.0),
};

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;

const usage = new Map(); // key "room|en->hi" -> { sttSeconds, ttsChars, translateChars, translateRequests }
function u(key) {
  let x = usage.get(key);
  if (!x) {
    x = { sttSeconds: 0, ttsChars: 0, translateChars: 0, translateRequests: 0 };
    usage.set(key, x);
  }
  return x;
}

export function recordSttAudio(key, seconds) {
  u(key).sttSeconds += seconds;
}
export function recordTtsChars(key, chars) {
  u(key).ttsChars += chars;
}
export function recordTranslateChars(key, chars) {
  const x = u(key);
  x.translateChars += chars;
  x.translateRequests += 1;
}

function costOf(x) {
  const stt = (x.sttSeconds / 60) * RATES.sttPerMin;
  const tts = (x.ttsChars / 1000) * RATES.ttsPer1kChars;
  const translate = (x.translateChars / 1000) * RATES.translatePer1kChars;
  return {
    stt: round2(stt),
    tts: round2(tts),
    translate: round2(translate),
    total: round2(stt + tts + translate),
  };
}

function fmtUsage(x) {
  return {
    sttSeconds: round1(x.sttSeconds),
    sttMinutes: round2(x.sttSeconds / 60),
    ttsChars: x.ttsChars,
    translateChars: x.translateChars,
    translateRequests: x.translateRequests,
  };
}

// Compact summary for a single pipeline (used in the stop-time log line).
export function costLine(key) {
  const x = usage.get(key);
  if (!x) return 'no billable usage';
  const c = costOf(x);
  return `${RATES.currency} ${c.total} (STT ${round1(x.sttSeconds)}s=${c.stt} · TTS ${x.ttsChars}ch=${c.tts} · translate ${x.translateChars}ch=${c.translate})`;
}

// Full breakdown for the /cost endpoint.
export function costSnapshot() {
  const perPipeline = {};
  const totals = { sttSeconds: 0, ttsChars: 0, translateChars: 0, translateRequests: 0 };
  for (const [key, x] of usage) {
    perPipeline[key] = { usage: fmtUsage(x), cost: costOf(x) };
    totals.sttSeconds += x.sttSeconds;
    totals.ttsChars += x.ttsChars;
    totals.translateChars += x.translateChars;
    totals.translateRequests += x.translateRequests;
  }
  return {
    currency: RATES.currency,
    rates: RATES,
    ratesNote: 'Rates are configurable placeholders — set the real values via env vars from your Sarvam dashboard. Usage counts are exact.',
    perPipeline,
    total: { usage: fmtUsage(totals), cost: costOf(totals) },
    openai: openaiSnapshot(),
    lifetime: { ...lifetime, note: 'Cumulative across restarts (from logs/cost-lifetime.json). Sarvam in INR, OpenAI in USD.' },
    labReference: LAB_RATES,
  };
}

// ── OpenAI gpt-realtime-translate cost (per audio minute, USD) ──────────────
// Billed by AUDIO DURATION, not tokens: ~$0.034 / minute of audio processed.
// We bill on input (speaker) audio minutes — what's sent for translation. The
// audio minutes are measured exactly; confirm the rate at openai.com/pricing.
//   OPENAI_RATE_PER_MIN=0.034
export const OPENAI_RATES = {
  currency: 'USD',
  perMin: num(process.env.OPENAI_RATE_PER_MIN, 0.034),
};

const round6 = (n) => Math.round(n * 1e6) / 1e6;
const oaUsage = new Map(); // key -> { inSeconds, outSeconds }
function ou(key) {
  let x = oaUsage.get(key);
  if (!x) { x = { inSeconds: 0, outSeconds: 0 }; oaUsage.set(key, x); }
  return x;
}

export function recordOpenAiAudio(key, inSeconds = 0, outSeconds = 0) {
  const x = ou(key);
  x.inSeconds += inSeconds;
  x.outSeconds += outSeconds;
}

function oaCostOf(x) {
  const minutes = x.inSeconds / 60;
  return {
    inSeconds: round1(x.inSeconds),
    outSeconds: round1(x.outSeconds),
    minutes: round2(minutes),
    total: round6(minutes * OPENAI_RATES.perMin),
  };
}

export function openaiCostLine(key) {
  const x = oaUsage.get(key);
  if (!x) return 'no billable usage';
  const c = oaCostOf(x);
  return `USD ${c.total} (${c.minutes} min audio)`;
}

function openaiSnapshot() {
  const perPipeline = {};
  const totals = { inSeconds: 0, outSeconds: 0 };
  for (const [key, x] of oaUsage) {
    perPipeline[key] = { cost: oaCostOf(x) };
    totals.inSeconds += x.inSeconds;
    totals.outSeconds += x.outSeconds;
  }
  return {
    currency: OPENAI_RATES.currency,
    rates: OPENAI_RATES,
    ratesNote: 'gpt-realtime-translate is billed per audio minute (~$0.034/min). Audio minutes are exact; confirm the rate at openai.com/pricing.',
    perPipeline,
    total: { cost: oaCostOf(totals) },
  };
}

// ── Per-room view + durable lifetime log ────────────────────────────────────
// Live per-room/project numbers come from the in-memory maps above. We also
// flush each pipeline's cost (as deltas, no double-count) to a JSONL audit log
// and a small lifetime totals file, so "total spent on this project" survives
// restarts without a database.
const LOG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'logs');
const EVENTS_FILE = join(LOG_DIR, 'cost-events.jsonl');
const LIFETIME_FILE = join(LOG_DIR, 'cost-lifetime.json');

let lifetime = { sarvamINR: 0, openaiUSD: 0 };
try { lifetime = { ...lifetime, ...JSON.parse(fs.readFileSync(LIFETIME_FILE, 'utf8')) }; } catch {}
const loggedSarvam = new Map(); // metricKey -> cost already flushed to lifetime
const loggedOpenai = new Map();

function persistLifetime() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(LIFETIME_FILE, JSON.stringify({ ...lifetime, updatedAt: new Date().toISOString() }, null, 2));
  } catch { /* best-effort */ }
}
function appendEvent(rec) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(EVENTS_FILE, JSON.stringify(rec) + '\n');
  } catch { /* best-effort */ }
}

// Called when a pipeline is torn down: flush its cost delta to the durable log.
export function flushCost(metricKey, provider) {
  const [roomId, pair] = metricKey.split('|');
  if (provider === 'openai') {
    const x = oaUsage.get(metricKey);
    if (!x) return;
    const total = oaCostOf(x).total;
    const delta = round6(total - (loggedOpenai.get(metricKey) || 0));
    if (delta <= 0) return;
    loggedOpenai.set(metricKey, total);
    lifetime.openaiUSD = round6(lifetime.openaiUSD + delta);
    appendEvent({ ts: new Date().toISOString(), roomId, pair, provider: 'openai', currency: 'USD', cost: delta });
    persistLifetime();
  } else {
    const x = usage.get(metricKey);
    if (!x) return;
    const total = costOf(x).total;
    const delta = round2(total - (loggedSarvam.get(metricKey) || 0));
    if (delta <= 0) return;
    loggedSarvam.set(metricKey, total);
    lifetime.sarvamINR = round2(lifetime.sarvamINR + delta);
    appendEvent({ ts: new Date().toISOString(), roomId, pair, provider: 'sarvam', currency: 'INR', cost: delta });
    persistLifetime();
  }
}

// Live cost for one room (sum across its language pipelines), split by provider
// since the currencies differ (Sarvam INR vs OpenAI USD).
export function roomCost(roomId) {
  const prefix = roomId + '|';
  const s = { sttSeconds: 0, ttsChars: 0, translateChars: 0, translateRequests: 0 };
  for (const [k, x] of usage) if (k.startsWith(prefix)) {
    s.sttSeconds += x.sttSeconds; s.ttsChars += x.ttsChars;
    s.translateChars += x.translateChars; s.translateRequests += x.translateRequests;
  }
  const o = { inSeconds: 0, outSeconds: 0 };
  for (const [k, x] of oaUsage) if (k.startsWith(prefix)) { o.inSeconds += x.inSeconds; o.outSeconds += x.outSeconds; }
  return {
    roomId,
    sarvam: { currency: RATES.currency, usage: fmtUsage(s), cost: costOf(s) },
    openai: { currency: 'USD', cost: oaCostOf(o) },
  };
}

export function lifetimeCost() {
  return { ...lifetime };
}

// ── Lab provider reference rates (indicative, USD) ──────────────────────────
// Published list prices for the experiment-lab providers, surfaced at /cost so
// you can weigh latency vs cost when picking a combo. Indicative only — confirm
// against each provider's dashboard; override via env.
export const LAB_RATES = {
  currency: 'USD',
  deepgram: { unit: 'per audio min', rate: num(process.env.DEEPGRAM_RATE_PER_MIN, 0.0077) },
  elevenSTT: { unit: 'per audio min', rate: num(process.env.ELEVEN_STT_RATE_PER_MIN, 0.006) },
  elevenTTS: { unit: 'per 1k chars', rate: num(process.env.ELEVEN_TTS_RATE_PER_1K, 0.10) },
  cartesia: { unit: 'per 1k chars', rate: num(process.env.CARTESIA_RATE_PER_1K, 0.025) },
  note: 'Indicative list prices for the Provider Lab — confirm on each dashboard. Lab runs are tiny.',
};

export function resetCost() {
  usage.clear();
  oaUsage.clear();
}
