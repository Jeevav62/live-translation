// Sarvam text translation (REST). Used for the English->Hindi path, where Saaras
// can only translate TO English, so we transcribe English then translate the text.
//
// Docs: POST https://api.sarvam.ai/translate (header: api-subscription-key)

import { currentKey, rotate, keyCount } from '../sarvamKeys.js';

const TRANSLATE_URL = 'https://api.sarvam.ai/translate';
const LANG_CODE = { hi: 'hi-IN', en: 'en-IN' };

// `apiKey` is accepted for compatibility but we use the key pool so a failed key
// (auth/quota/rate) automatically falls back to the next one.
export async function translateText({ apiKey, text, from, to }) {
  if (!text || !text.trim()) return '';
  const attempts = Math.max(1, keyCount());
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const key = currentKey() || apiKey;
    const res = await fetch(TRANSLATE_URL, {
      method: 'POST',
      headers: { 'api-subscription-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: text,
        source_language_code: LANG_CODE[from] || 'en-IN',
        target_language_code: LANG_CODE[to] || 'hi-IN',
        model: 'sarvam-translate:v1',
      }),
    });
    if (res.ok) return (await res.json()).translated_text || '';

    const body = await res.text();
    lastErr = new Error(`Translate failed: ${res.status} ${body}`);
    // Auth/quota/rate -> try the next key; other errors -> give up now.
    if ((res.status === 401 || res.status === 403 || res.status === 429) && rotate(key, `translate ${res.status}`)) {
      continue;
    }
    throw lastErr;
  }
  throw lastErr;
}
