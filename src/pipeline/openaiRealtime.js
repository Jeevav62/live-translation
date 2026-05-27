// OpenAI gpt-realtime-translate — single speech-to-speech WebSocket.
//
// One socket per target language. We send the speaker's audio and receive
// translated audio for that language, streamed WHILE the speaker talks (no
// silence gating). The model auto-detects the source language; we only set the
// output language.
//
// Protocol (docs):
//   wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate
//   open  -> {type:'session.update', session:{audio:{output:{language:'<lang>'}}}}
//   in    -> {type:'session.input_audio_buffer.append', audio:<base64 24kHz PCM16>}
//   out   <- {type:'session.output_audio.delta', delta:<base64 24kHz PCM16>}
//            {type:'session.output_transcript.delta'|'.done', delta:'...'}
//            {type:'session.input_transcript.delta'|'.done', delta:'...'}
//            {type:'session.closed'} / {type:'error', error:{message}}
//   close -> {type:'session.close'}
//
// Our system runs at 16 kHz; OpenAI uses 24 kHz, so we resample at the edges.

import WebSocket from 'ws';
import { log } from '../log.js';
import { resamplePcm16 } from './resample.js';
import { currentKey } from '../openaiKeys.js';

const URL = 'wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate';
const SYSTEM_RATE = 16000; // the rest of our pipeline
const OPENAI_RATE = 24000; // gpt-realtime-translate audio rate

// NOTE: the translations endpoint does NOT expose turn_detection (the API
// rejects it as unknown) — the model decides phrase boundaries itself and waits
// for a brief pause. We can only set the output language + noise reduction.

export function createOpenAITranslator({ targetLang, label = '', onAudio, onTranscriptDone, onError }) {
  const apiKey = currentKey();
  const ws = new WebSocket(URL, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'OpenAI-Safety-Identifier': 'live-translation-room',
    },
  });

  let ready = false;
  const pending = []; // 24kHz base64 chunks queued before the socket opens

  ws.on('open', () => {
    ws.send(JSON.stringify({
      type: 'session.update',
      session: {
        audio: {
          input: { noise_reduction: { type: 'near_field' } },
          output: { language: targetLang },
        },
      },
    }));
    ready = true;
    log.tts(label, `OpenAI realtime socket open (output ${targetLang})`);
    for (const b64 of pending.splice(0)) sendB64(b64);
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    switch (msg.type) {
      case 'session.output_audio.delta':
        if (msg.delta) {
          const at24 = Buffer.from(msg.delta, 'base64');
          onAudio?.(resamplePcm16(at24, OPENAI_RATE, SYSTEM_RATE)); // -> 16kHz for the rest of the system
        }
        break;
      case 'session.output_transcript.done':
      case 'session.input_transcript.done':
        onTranscriptDone?.();
        break;
      case 'session.closed':
        log.tts(label, 'OpenAI realtime socket closed by server');
        break;
      case 'error': {
        const m = msg.error?.message || JSON.stringify(msg.error || msg);
        const err = new Error(m);
        err.status = msg.error?.code;
        onError?.(err);
        break;
      }
    }
  });

  ws.on('error', (e) => onError?.(e));
  ws.on('close', () => log.tts(label, 'OpenAI realtime socket closed'));

  function sendB64(b64) {
    ws.send(JSON.stringify({ type: 'session.input_audio_buffer.append', audio: b64 }));
  }

  // pcm: Node Buffer of 16 kHz PCM16 LE (speaker audio).
  function feed(pcm) {
    const at24 = resamplePcm16(pcm, SYSTEM_RATE, OPENAI_RATE);
    const b64 = at24.toString('base64');
    if (!ready || ws.readyState !== WebSocket.OPEN) { pending.push(b64); return; }
    sendB64(b64);
  }

  function close() {
    try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'session.close' })); } catch {}
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  }

  return { feed, close };
}
