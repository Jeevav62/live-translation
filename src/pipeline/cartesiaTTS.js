// Cartesia Sonic streaming TTS over WebSocket.
// Text in -> PCM16 audio chunks out (raw pcm_s16le at our system rate).
//
// Docs: wss://api.cartesia.ai/tts/websocket  (header: X-API-Key, Cartesia-Version)
//   in  -> {model_id, transcript, voice:{mode:'id',id}, language, output_format:
//           {container:'raw', encoding:'pcm_s16le', sample_rate}, context_id, continue:false}
//   out <- {type:'chunk', data:'<b64 pcm16>', done:false} ... {type:'done'}

import WebSocket from 'ws';
import { log } from '../log.js';
import { cartesia as pool } from '../labKeys.js';

const TTS_URL = 'wss://api.cartesia.ai/tts/websocket';
const VERSION = process.env.CARTESIA_VERSION || '2024-11-13';
const MODEL_ID = process.env.CARTESIA_MODEL_ID || 'sonic-3';
const VOICE_ID = process.env.CARTESIA_VOICE_ID || 'a0e99841-438c-4a64-b679-ae501e7d6091';
const CART_LANG = { hi: 'hi', en: 'en' };

export function createTTS({ apiKey, targetLang, sampleRate = 16000, model, label = '', onAudio, onError }) {
  const key = apiKey || pool.currentKey();
  const modelId = model || MODEL_ID;
  const ws = new WebSocket(TTS_URL, { headers: { 'X-API-Key': key, 'Cartesia-Version': VERSION } });

  let ready = false;
  const pending = [];
  let seq = 0;

  ws.on('open', () => {
    ready = true;
    log.tts(label, `Cartesia socket open (${modelId}, ${CART_LANG[targetLang] || 'en'}, ${sampleRate}Hz), flushing ${pending.length} queued text(s)`);
    for (const t of pending.splice(0)) sendText(t);
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'chunk' && msg.data) {
      onAudio?.(Buffer.from(msg.data, 'base64')); // raw PCM16 LE at sampleRate
    } else if (msg.type === 'error') {
      onError?.(new Error(msg.error || msg.message || 'Cartesia TTS error'));
    }
  });

  ws.on('error', (e) => onError?.(e));
  ws.on('close', () => log.tts(label, 'Cartesia socket closed'));

  function sendText(text) {
    if (!text || !text.trim()) return;
    if (!ready || ws.readyState !== WebSocket.OPEN) { pending.push(text); return; }
    ws.send(JSON.stringify({
      model_id: modelId,
      transcript: text,
      voice: { mode: 'id', id: VOICE_ID },
      language: CART_LANG[targetLang] || 'en',
      output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: sampleRate },
      context_id: `lab-${Date.now()}-${seq++}`,
      continue: false,
    }));
  }

  function close() {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  }

  return { sendText, close, sampleRate };
}
