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

const num = (v, d) => (v != null && !Number.isNaN(parseFloat(v)) ? parseFloat(v) : d);

export const RATES = {
  currency: process.env.SARVAM_CURRENCY || 'INR',
  sttPerMin: num(process.env.SARVAM_STT_RATE_PER_MIN, 0.5), // PLACEHOLDER — confirm on dashboard
  ttsPer1kChars: num(process.env.SARVAM_TTS_RATE_PER_1K_CHARS, 1.5), // PLACEHOLDER
  translatePer1kChars: num(process.env.SARVAM_TRANSLATE_RATE_PER_1K_CHARS, 0.4), // PLACEHOLDER
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
  };
}

export function resetCost() {
  usage.clear();
}
