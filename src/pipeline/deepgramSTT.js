// Deepgram streaming speech-to-text over WebSocket. Two model families:
//   - nova-3 (default): /v1/listen, emits {type:'Results', channel.alternatives[0]}
//   - flux:             /v2/listen, turn-based, emits {type:'TurnInfo', event, transcript}
// Transcribe ONLY (no translation), so the lab pipeline pairs it with translate.
//
// Docs: developers.deepgram.com  (header: Authorization: Token <key>)

import WebSocket from 'ws';
import { log } from '../log.js';
import { deepgram as pool } from '../labKeys.js';

const DG_LANG = { hi: 'hi', en: 'en' };

export function createSTT({ apiKey, model = 'nova-3', sampleRate = 16000, srcLang = 'en', label = '', onTranscript, onError }) {
  const key = apiKey || pool.currentKey();
  const isFlux = model.startsWith('flux');

  let url;
  if (isFlux) {
    // Flux: turn-based, multilingual model handles Hindi; en variant for English.
    const fluxModel = srcLang === 'en' ? 'flux-general-en' : 'flux-general-multi';
    const params = new URLSearchParams({ model: fluxModel, encoding: 'linear16', sample_rate: String(sampleRate) });
    url = `wss://api.deepgram.com/v2/listen?${params}`;
  } else {
    const params = new URLSearchParams({
      model, // nova-3 / nova-2
      language: DG_LANG[srcLang] || 'multi',
      encoding: 'linear16',
      sample_rate: String(sampleRate),
      channels: '1',
      interim_results: 'true',
      smart_format: 'true',
      endpointing: '300', // ms of silence -> finalize
    });
    url = `wss://api.deepgram.com/v1/listen?${params}`;
  }

  const ws = new WebSocket(url, { headers: { Authorization: `Token ${key}` } });
  let ready = false;
  const pending = [];

  ws.on('open', () => {
    ready = true;
    log.stt(label, `Deepgram socket open (${model}${isFlux ? '' : ', ' + (DG_LANG[srcLang] || 'multi')}), flushing ${pending.length} queued chunk(s)`);
    for (const buf of pending.splice(0)) ws.send(buf);
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (isFlux) {
      // Flux turn-based: emit the transcript when a turn ends.
      if (msg.type === 'TurnInfo' && msg.event === 'EndOfTurn') {
        const text = (msg.transcript || '').trim();
        if (text) onTranscript?.(text);
      } else if (msg.type === 'Error' || msg.error) {
        onError?.(new Error(msg.description || msg.message || msg.error || 'Deepgram Flux error'));
      }
    } else {
      if (msg.type === 'Results') {
        const text = msg.channel?.alternatives?.[0]?.transcript?.trim();
        if (text && (msg.is_final || msg.speech_final)) onTranscript?.(text);
      } else if (msg.type === 'Error' || msg.error) {
        onError?.(new Error(msg.description || msg.message || msg.error || 'Deepgram STT error'));
      }
    }
  });

  ws.on('error', (e) => onError?.(e));
  ws.on('close', () => log.stt(label, 'Deepgram socket closed'));

  function sendAudio(pcm) {
    if (!ready || ws.readyState !== WebSocket.OPEN) { pending.push(pcm); return; }
    ws.send(pcm); // raw binary PCM16 LE
  }

  function flush() {
    // Nova: force an endpoint. Flux detects turns itself, so flushing is a no-op.
    if (!isFlux && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'Finalize' }));
  }

  function close() {
    try { if (!isFlux && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'CloseStream' })); } catch {}
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  }

  return { sendAudio, flush, close };
}
