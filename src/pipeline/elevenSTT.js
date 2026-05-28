// ElevenLabs Scribe v2 Realtime speech-to-text over WebSocket.
// PCM16 16kHz audio in -> transcript out. Transcribe ONLY (no translation); the
// lab pipeline pairs it with a separate translate step.
//
// Docs: wss://api.elevenlabs.io/v1/speech-to-text/realtime  (header: xi-api-key)
//   in   -> {message_type:'input_audio_chunk', audio_base_64:'<b64 pcm16>'}
//   out  <- {message_type:'partial_transcript'|'committed_transcript', text}
//   commit_strategy=vad: the model auto-commits on a pause (we emit committed only).

import WebSocket from 'ws';
import { log } from '../log.js';
import { eleven as pool } from '../labKeys.js';

const STT_URL = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';

export function createSTT({ apiKey, sampleRate = 16000, srcLang = 'en', label = '', onTranscript, onError }) {
  const key = apiKey || pool.currentKey();
  const params = new URLSearchParams({
    model_id: 'scribe_v2_realtime',
    audio_format: `pcm_${sampleRate}`,
    language_code: srcLang,
    commit_strategy: 'vad', // auto-finalize on a natural pause
  });
  const ws = new WebSocket(`${STT_URL}?${params}`, { headers: { 'xi-api-key': key } });

  let ready = false;
  const pending = [];

  ws.on('open', () => {
    ready = true;
    log.stt(label, `ElevenLabs Scribe socket open (${srcLang}), flushing ${pending.length} queued chunk(s)`);
    for (const b64 of pending.splice(0)) sendB64(b64);
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const t = msg.message_type;
    if (t === 'committed_transcript' || t === 'committed_transcript_with_timestamps') {
      const text = (msg.text || '').trim();
      if (text) onTranscript?.(text);
    } else if (t === 'error' || msg.error) {
      onError?.(new Error(msg.message || msg.error || 'ElevenLabs STT error'));
    }
  });

  ws.on('error', (e) => onError?.(e));
  ws.on('close', () => log.stt(label, 'ElevenLabs Scribe socket closed'));

  function sendB64(b64) {
    ws.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: b64 }));
  }

  function sendAudio(pcm) {
    const b64 = Buffer.from(pcm).toString('base64');
    if (!ready || ws.readyState !== WebSocket.OPEN) { pending.push(b64); return; }
    sendB64(b64);
  }

  function flush() {
    // Force a commit of the current buffer (in case VAD hasn't fired yet).
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: '', commit: true }));
    }
  }

  function close() {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  }

  return { sendAudio, flush, close };
}
