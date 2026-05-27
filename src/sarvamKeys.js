// Sarvam API key pool with automatic fallback.
//
// SARVAM_API_KEY may hold ONE key or several comma-separated keys:
//   SARVAM_API_KEY=key_a,key_b,key_c
// We round-robin across them and, when a key fails with an auth/quota/rate error
// (401/403/429 or a quota message), we put it on a short cooldown and rotate to
// the next live key. Great for testing: when one key's free credits run out or
// hits a rate limit, the next takes over without a redeploy.

import { log } from './log.js';

const PLACEHOLDER = 'PASTE_YOUR_KEY_HERE';
const COOLDOWN_MS = 60_000; // how long a failed key is skipped before retrying it

const keys = (process.env.SARVAM_API_KEY || '')
  .split(',')
  .map((k) => k.trim())
  .filter((k) => k && k !== PLACEHOLDER);

let cursor = 0;
const cooldownUntil = new Map(); // key -> epoch ms until which it's skipped

export function hasKeys() {
  return keys.length > 0;
}

export function keyCount() {
  return keys.length;
}

// A short, non-secret label for logs (never print the actual key).
function label(key) {
  const i = keys.indexOf(key);
  return i >= 0 ? `key #${i + 1}/${keys.length}` : 'key';
}

// The key to use right now: first one not on cooldown, starting at the cursor.
export function currentKey() {
  if (!keys.length) return null;
  const now = Date.now();
  for (let i = 0; i < keys.length; i++) {
    const k = keys[(cursor + i) % keys.length];
    if (!(cooldownUntil.get(k) > now)) {
      cursor = (cursor + i) % keys.length;
      return k;
    }
  }
  return keys[cursor]; // all cooling down — use current anyway rather than fail hard
}

// Does this error look like one that another key could fix (auth/quota/rate)?
export function isKeyError(err) {
  const s = `${err?.status ?? ''} ${err?.code ?? ''} ${err?.message ?? ''}`.toLowerCase();
  return /\b(401|403|429)\b/.test(s) || /quota|rate.?limit|exceeded|unauthor|invalid.*key|insufficient|credit/.test(s);
}

// Mark a key bad and advance the cursor. Returns true if another key is available.
export function rotate(key, reason = '') {
  if (keys.length <= 1) {
    log.warn(`Sarvam ${label(key)} failed (${reason}) — no fallback key available`);
    return false;
  }
  cooldownUntil.set(key, Date.now() + COOLDOWN_MS);
  cursor = (keys.indexOf(key) + 1) % keys.length;
  log.warn(`Sarvam ${label(key)} failed (${reason}) — rotating to ${label(keys[cursor])}`);
  return true;
}

export function keyState() {
  const now = Date.now();
  return {
    count: keys.length,
    active: keys.length ? keys.indexOf(currentKey()) + 1 : 0,
    cooling: [...cooldownUntil.entries()].filter(([, t]) => t > now).length,
  };
}
