// Generic API-key pool with automatic fallback. One env var may hold a single
// key or several comma-separated keys; we round-robin and, when a key fails with
// an auth/quota/rate error (401/403/429 or a quota message), we put it on a short
// cooldown and rotate to the next live key. Used by both Sarvam and OpenAI.

import { log } from './log.js';

const PLACEHOLDER = 'PASTE_YOUR_KEY_HERE';
const COOLDOWN_MS = 60_000;

export function createKeyPool(rawValue, providerName) {
  const keys = (rawValue || '')
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k && k !== PLACEHOLDER);

  let cursor = 0;
  const cooldownUntil = new Map();

  const label = (key) => {
    const i = keys.indexOf(key);
    return i >= 0 ? `${providerName} key #${i + 1}/${keys.length}` : `${providerName} key`;
  };

  function currentKey() {
    if (!keys.length) return null;
    const now = Date.now();
    for (let i = 0; i < keys.length; i++) {
      const k = keys[(cursor + i) % keys.length];
      if (!(cooldownUntil.get(k) > now)) {
        cursor = (cursor + i) % keys.length;
        return k;
      }
    }
    return keys[cursor];
  }

  function rotate(key, reason = '') {
    if (keys.length <= 1) {
      log.warn(`${label(key)} failed (${reason}) — no fallback key available`);
      return false;
    }
    cooldownUntil.set(key, Date.now() + COOLDOWN_MS);
    cursor = (keys.indexOf(key) + 1) % keys.length;
    log.warn(`${label(key)} failed (${reason}) — rotating to ${label(keys[cursor])}`);
    return true;
  }

  function keyState() {
    const now = Date.now();
    return {
      count: keys.length,
      active: keys.length ? keys.indexOf(currentKey()) + 1 : 0,
      cooling: [...cooldownUntil.values()].filter((t) => t > now).length,
    };
  }

  return {
    hasKeys: () => keys.length > 0,
    keyCount: () => keys.length,
    currentKey,
    rotate,
    keyState,
  };
}

// Does this error look like one another key could fix (auth/quota/rate)?
export function isKeyError(err) {
  const s = `${err?.status ?? ''} ${err?.code ?? ''} ${err?.message ?? ''}`.toLowerCase();
  return /\b(401|403|429)\b/.test(s) || /quota|rate.?limit|exceeded|unauthor|invalid.*key|insufficient|credit/.test(s);
}
