// Provider-agnostic interface. Each role (STT / TTS / translate) can be served by
// any provider, selected either by env default (the main rooms) or by an explicit
// `provider` argument (the experiment lab). New adapters conform to the same
// interface, so pipeline code never changes:
//   STT:       createSTT(opts) -> { sendAudio(pcm16), flush(), close() } + onTranscript
//   TTS:       createTTS(opts) -> { sendText(text), close() } + onAudio(pcm16_16k)
//   translate: translateText(opts) -> Promise<string>

import { createSTT as sarvamSTT } from './sarvamSTT.js';
import { createTTS as sarvamTTS } from './sarvamTTS.js';
import { translateText as sarvamTranslate } from './sarvamTranslate.js';
import { createSTT as deepgramSTT } from './deepgramSTT.js';
import { createSTT as elevenSTT } from './elevenSTT.js';
import { createTTS as cartesiaTTS } from './cartesiaTTS.js';
import { createTTS as elevenTTS } from './elevenTTS.js';

const STT_PROVIDER = process.env.STT_PROVIDER || 'sarvam';
const TTS_PROVIDER = process.env.TTS_PROVIDER || 'sarvam';
const TRANSLATE_PROVIDER = process.env.TRANSLATE_PROVIDER || 'sarvam';

export function createSTT(opts) {
  switch (opts.provider || STT_PROVIDER) {
    case 'deepgram':
      return deepgramSTT(opts);
    case 'eleven':
      return elevenSTT(opts);
    case 'sarvam':
    default:
      return sarvamSTT(opts);
  }
}

export function createTTS(opts) {
  switch (opts.provider || TTS_PROVIDER) {
    case 'cartesia':
      return cartesiaTTS(opts);
    case 'eleven':
      return elevenTTS(opts);
    case 'sarvam':
    default:
      return sarvamTTS(opts);
  }
}

export function translateText(opts) {
  switch (opts.provider || TRANSLATE_PROVIDER) {
    case 'sarvam':
    default:
      return sarvamTranslate(opts);
  }
}
