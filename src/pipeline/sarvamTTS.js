// Sarvam Bulbul streaming TTS over WebSocket.
// Text in -> PCM16 audio chunks out (so listeners share one PCM player).
//
// Docs: wss://api.sarvam.ai/text-to-speech/ws  (header: Api-Subscription-Key)

import WebSocket from 'ws';
import { log } from '../log.js';

const TTS_URL = 'wss://api.sarvam.ai/text-to-speech/ws';
const LANG_CODE = { hi: 'hi-IN', en: 'en-IN' };
const DEFAULT_SPEAKER = 'anushka'; // bulbul:v2, multilingual

export function createTTS({ apiKey, targetLang, sampleRate = 16000, speaker = DEFAULT_SPEAKER, label = '', onAudio, onError }) {
  const url = `${TTS_URL}?model=bulbul:v2`;
  const ws = new WebSocket(url, { headers: { 'Api-Subscription-Key': apiKey } });

  let ready = false;
  const pending = []; // text queued before config-ack / open
  let pingTimer = null;

  ws.on('open', () => {
    ws.send(JSON.stringify({
      type: 'config',
      data: {
        target_language_code: LANG_CODE[targetLang] || 'en-IN',
        speaker,
        output_audio_codec: 'linear16', // raw PCM16 LE, matches relay format (no header)
        speech_sample_rate: sampleRate, // honored by the API (number)
        pace: 1.0,
      },
    }));
    ready = true;
    log.tts(label, `Bulbul socket open (${LANG_CODE[targetLang] || 'en-IN'}, ${sampleRate}Hz), flushing ${pending.length} queued text(s)`);
    for (const t of pending.splice(0)) sendText(t);
    pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
    }, 30000);
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'audio' && msg.data?.audio) {
      onAudio?.(Buffer.from(msg.data.audio, 'base64')); // raw PCM16 LE
    } else if (msg.type === 'error') {
      onError?.(new Error(msg.data?.message || 'TTS error'));
    }
  });

  ws.on('error', (e) => onError?.(e));
  ws.on('close', () => { if (pingTimer) clearInterval(pingTimer); log.tts(label, 'Bulbul socket closed'); });

  function sendText(text) {
    if (!text || !text.trim()) return;
    if (!ready || ws.readyState !== WebSocket.OPEN) { pending.push(text); return; }
    ws.send(JSON.stringify({ type: 'text', data: { text } }));
    ws.send(JSON.stringify({ type: 'flush' }));
  }

  function close() {
    if (pingTimer) clearInterval(pingTimer);
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  }

  return { sendText, close, sampleRate };
}
