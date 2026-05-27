// OpenAI API key pool with automatic fallback (for gpt-realtime-translate).
//
// OPENAI_API_KEY may hold ONE key or several comma-separated keys:
//   OPENAI_API_KEY=sk-aaa,sk-bbb
// Same round-robin + fallback mechanism as Sarvam (see src/keyPool.js).

import { createKeyPool, isKeyError } from './keyPool.js';

const pool = createKeyPool(process.env.OPENAI_API_KEY, 'OpenAI');

export const hasKeys = pool.hasKeys;
export const keyCount = pool.keyCount;
export const currentKey = pool.currentKey;
export const rotate = pool.rotate;
export const keyState = pool.keyState;
export { isKeyError };
