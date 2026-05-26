// Sarvam Saaras v3 streaming speech-to-text-translate over WebSocket.
// PCM16 audio in -> text out. mode=translate gives English directly from any
// Indic language (one call); mode=transcribe gives same-language text.
//
// Docs: wss://api.sarvam.ai/speech-to-text-translate/ws (header: Api-Subscription-Key)

import WebSocket from 'ws';
import { log } from '../log.js';

const STT_URL = 'wss://api.sarvam.ai/speech-to-text-translate/ws';

export function createSTT({ apiKey, mode = 'translate', sampleRate = 16000, label = '', onTranscript, onError }) {
  const params = new URLSearchParams({
    model: 'saaras:v3',
    mode,
    sample_rate: String(sampleRate),
    input_audio_codec: 'pcm_s16le',
    vad_signals: 'true',
  });
  const ws = new WebSocket(`${STT_URL}?${params}`, { headers: { 'Api-Subscription-Key': apiKey } });

  let ready = false;
  const pending = []; // base64 audio queued before open

  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'config', prompt: '' }));
    ready = true;
    log.stt(label, `Saaras socket open (mode=${mode}), flushing ${pending.length} queued chunk(s)`);
    for (const b64 of pending.splice(0)) sendB64(b64);
  });

  ws.on('close', () => log.stt(label, 'Saaras socket closed'));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'data' && msg.data?.transcript) {
      onTranscript?.(msg.data.transcript.trim());
    } else if (msg.type === 'error') {
      onError?.(new Error(msg.data?.error || msg.data?.message || 'STT error'));
    }
  });

  ws.on('error', (e) => onError?.(e));

  function sendB64(b64) {
    // Codec is declared via the input_audio_codec query param; the per-message
    // `encoding` enum only accepts the literal "audio/wav" on this API build.
    ws.send(JSON.stringify({ audio: { data: b64, sample_rate: String(sampleRate), encoding: 'audio/wav' } }));
  }

  // pcm: Node Buffer of PCM16 LE samples.
  function sendAudio(pcm) {
    const b64 = Buffer.from(pcm).toString('base64');
    if (!ready || ws.readyState !== WebSocket.OPEN) { pending.push(b64); return; }
    sendB64(b64);
  }

  function flush() {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'flush' }));
  }

  function close() {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  }

  return { sendAudio, flush, close };
}
