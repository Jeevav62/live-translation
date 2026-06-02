// Key pools for the experimental Lab providers (Deepgram, ElevenLabs, Cartesia).
// Each env var may hold ONE key or several comma-separated keys, with the same
// round-robin + auto-fallback behavior as Sarvam/OpenAI (see src/keyPool.js).
//
//   DEEPGRAM_API_KEY=...
//   ELEVENLABS_API_KEY=...
//   CARTESIA_API_KEY=...

import { createKeyPool, isKeyError } from './keyPool.js';

export const deepgram = createKeyPool(process.env.DEEPGRAM_API_KEY, 'Deepgram');
export const eleven = createKeyPool(process.env.ELEVENLABS_API_KEY, 'ElevenLabs');
export const cartesia = createKeyPool(process.env.CARTESIA_API_KEY, 'Cartesia');

export { isKeyError };

// Snapshot of which providers have at least one key — drives the lab UI dropdowns
// (a provider with no key is hidden) and the startup banner.
export function labKeyCounts() {
  return {
    deepgram: deepgram.keyCount(),
    eleven: eleven.keyCount(),
    cartesia: cartesia.keyCount(),
  };
}
