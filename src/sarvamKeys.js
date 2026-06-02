// Sarvam API key pool with automatic fallback.
//
// SARVAM_API_KEY may hold ONE key or several comma-separated keys:
//   SARVAM_API_KEY=key_a,key_b,key_c
// We round-robin and fall back to the next key on auth/quota/rate errors.
// See src/keyPool.js for the mechanism.

import { createKeyPool, isKeyError } from './keyPool.js';

const pool = createKeyPool(process.env.SARVAM_API_KEY, 'Sarvam');

export const hasKeys = pool.hasKeys;
export const keyCount = pool.keyCount;
export const currentKey = pool.currentKey;
export const rotate = pool.rotate;
export const keyState = pool.keyState;
export { isKeyError };
