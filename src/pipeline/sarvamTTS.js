// Sarvam Bulbul streaming TTS over WebSocket.
// Supports bulbul:v2 (16kHz, legacy) and bulbul:v3 (24kHz default, better voices).
// v3 audio is resampled 24->16kHz so the rest of the system stays at 16kHz.
//
// Docs: wss://api.sarvam.ai/text-to-speech/ws  (header: Api-Subscription-Key)

import WebSocket from 'ws';
import { log } from '../log.js';
import { resamplePcm16 } from './resample.js';

const TTS_URL = 'wss://api.sarvam.ai/text-to-speech/ws';
const LANG_CODE = { hi: 'hi-IN', en: 'en-IN' };

const V2_SPEAKER = 'anushka';
const V3_SPEAKER = 'aditya'; // v3 default speaker

// v3 always synthesizes at 24kHz; we resample down to our system rate (16kHz).
const V3_SYNTH_RATE = 24000;
const SYSTEM_RATE = 16000;

export function createTTS({ apiKey, targetLang, sampleRate = 16000, model, speaker, label = '', onAudio, onError }) {
  const modelId = model || process.env.SARVAM_TTS_MODEL || 'bulbul:v2';
  const isV3 = modelId === 'bulbul:v3';
  const synthRate = isV3 ? V3_SYNTH_RATE : sampleRate;
  const defaultSpeaker = isV3 ? V3_SPEAKER : V2_SPEAKER;
  const spk = speaker || defaultSpeaker;

  const url = `${TTS_URL}?model=${modelId}`;
  const ws = new WebSocket(url, { headers: { 'Api-Subscription-Key': apiKey } });

  let ready = false;
  const pending = [];
  let pingTimer = null;

  ws.on('open', () => {
    const cfg = {
      target_language_code: LANG_CODE[targetLang] || 'en-IN',
      speaker: spk,
      output_audio_codec: 'linear16',
      speech_sample_rate: synthRate,
      pace: 1.0,
    };
    if (isV3) cfg.temperature = 0.6;
    ws.send(JSON.stringify({ type: 'config', data: cfg }));
    ready = true;
    log.tts(label, `Bulbul socket open (${modelId}, ${LANG_CODE[targetLang] || 'en-IN'}, ${synthRate}Hz${isV3 ? '→16kHz' : ''}), flushing ${pending.length} queued text(s)`);
    for (const t of pending.splice(0)) sendText(t);
    pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
    }, 30000);
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'audio' && msg.data?.audio) {
      let pcm = Buffer.from(msg.data.audio, 'base64');
      // v3 outputs at 24kHz — downsample to 16kHz before handing off.
      if (isV3 && synthRate !== SYSTEM_RATE) pcm = resamplePcm16(pcm, synthRate, SYSTEM_RATE);
      onAudio?.(pcm);
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

  // Always report 16kHz to the pipeline/lab (output is normalized).
  return { sendText, close, sampleRate: SYSTEM_RATE };
}
