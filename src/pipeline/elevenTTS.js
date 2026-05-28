// ElevenLabs Flash v2.5 streaming TTS over WebSocket (input streaming).
// Text in -> PCM16 audio chunks out at our system rate.
//
// Docs: wss://api.elevenlabs.io/v1/text-to-speech/{voice}/stream-input
//        ?model_id=eleven_flash_v2_5&output_format=pcm_16000&language_code=hi
//   open -> BOS {text:' ', voice_settings:{...}}
//   in   -> {text:'<utterance> ', flush:true}   (per utterance, socket stays open)
//   out  <- {audio:'<b64 pcm16>'} ... {isFinal:true}
//   close-> {text:''}  (EOS)

import WebSocket from 'ws';
import { log } from '../log.js';
import { eleven as pool } from '../labKeys.js';

const VOICE_ID = process.env.ELEVEN_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'; // Rachel (multilingual)
const MODEL_ID = process.env.ELEVEN_MODEL_ID || 'eleven_flash_v2_5';

export function createTTS({ apiKey, targetLang, sampleRate = 16000, model, label = '', onAudio, onError }) {
  const key = apiKey || pool.currentKey();
  const modelId = model || MODEL_ID;
  const params = new URLSearchParams({
    model_id: modelId,
    output_format: `pcm_${sampleRate}`,
    language_code: targetLang,
  });
  const url = `wss://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream-input?${params}`;
  const ws = new WebSocket(url, { headers: { 'xi-api-key': key } });

  let ready = false;
  const pending = [];

  ws.on('open', () => {
    ws.send(JSON.stringify({
      text: ' ',
      voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 1.0 },
    }));
    ready = true;
    log.tts(label, `ElevenLabs socket open (${modelId}, ${targetLang}, ${sampleRate}Hz), flushing ${pending.length} queued text(s)`);
    for (const t of pending.splice(0)) sendText(t);
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.audio) {
      onAudio?.(Buffer.from(msg.audio, 'base64')); // raw PCM16 LE at sampleRate
    } else if (msg.error || msg.message_type === 'error') {
      onError?.(new Error(msg.error || msg.message || 'ElevenLabs TTS error'));
    }
  });

  ws.on('error', (e) => onError?.(e));
  ws.on('close', () => log.tts(label, 'ElevenLabs socket closed'));

  function sendText(text) {
    if (!text || !text.trim()) return;
    if (!ready || ws.readyState !== WebSocket.OPEN) { pending.push(text); return; }
    ws.send(JSON.stringify({ text: text.endsWith(' ') ? text : text + ' ', flush: true }));
  }

  function close() {
    try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ text: '' })); } catch {}
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  }

  return { sendText, close, sampleRate };
}
