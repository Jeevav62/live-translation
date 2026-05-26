// Provider-agnostic interface. Swap Sarvam for Bhashini (or a local model) here
// without touching routing/pipeline code. Selected via STT/TTS provider env vars.

import { createSTT as sarvamSTT } from './sarvamSTT.js';
import { createTTS as sarvamTTS } from './sarvamTTS.js';
import { translateText as sarvamTranslate } from './sarvamTranslate.js';

const STT_PROVIDER = process.env.STT_PROVIDER || 'sarvam';
const TTS_PROVIDER = process.env.TTS_PROVIDER || 'sarvam';

export function createSTT(opts) {
  switch (STT_PROVIDER) {
    case 'sarvam':
    default:
      return sarvamSTT(opts);
  }
}

export function createTTS(opts) {
  switch (TTS_PROVIDER) {
    case 'sarvam':
    default:
      return sarvamTTS(opts);
  }
}

// Text translation (used by the English->Hindi path in Phase 3).
export function translateText(opts) {
  return sarvamTranslate(opts);
}
