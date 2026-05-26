// Sarvam text translation (REST). Used for the English->Hindi path, where Saaras
// can only translate TO English, so we transcribe English then translate the text.
//
// Docs: POST https://api.sarvam.ai/translate (header: api-subscription-key)

const TRANSLATE_URL = 'https://api.sarvam.ai/translate';
const LANG_CODE = { hi: 'hi-IN', en: 'en-IN' };

export async function translateText({ apiKey, text, from, to }) {
  if (!text || !text.trim()) return '';
  const res = await fetch(TRANSLATE_URL, {
    method: 'POST',
    headers: {
      'api-subscription-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      input: text,
      source_language_code: LANG_CODE[from] || 'en-IN',
      target_language_code: LANG_CODE[to] || 'hi-IN',
      model: 'sarvam-translate:v1',
    }),
  });
  if (!res.ok) {
    throw new Error(`Translate failed: ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  return json.translated_text || '';
}
