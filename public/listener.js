import { int16ToFloat } from './audio-utils.js';

let incomingRate = 16000; // updated by server 'audio-format' message; relay + TTS are 16kHz PCM16
const JITTER_LEAD = 0.15; // seconds of buffer before playback to absorb network jitter

const params = new URLSearchParams(location.search);
const roomId = params.get('room') || 'main';

const els = {
  room: document.getElementById('room'),
  lang: document.getElementById('lang'),
  join: document.getElementById('join'),
  conn: document.getElementById('conn'),
  speaker: document.getElementById('speaker'),
  error: document.getElementById('error'),
};
els.room.innerHTML = `<option>${roomId}</option>`;

let ws = null;
let audioCtx = null;
let nextTime = 0;
let listening = false;

els.join.addEventListener('click', () => (listening ? stop() : start()));

async function start() {
  els.error.textContent = '';
  // AudioContext must be created/resumed from a user gesture.
  audioCtx = new AudioContext();
  await audioCtx.resume();
  nextTime = 0;
  connect();
}

function connect() {
  els.conn.textContent = 'connecting…';
  const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${wsProto}://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'join', room: roomId, role: 'listener', lang: els.lang.value }));
  };

  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') {
      handleControl(JSON.parse(ev.data));
    } else {
      playFrame(ev.data);
    }
  };

  ws.onclose = () => {
    els.conn.textContent = 'disconnected';
    if (listening) stop();
  };

  listening = true;
  els.join.textContent = 'Stop';
  els.join.classList.add('stop');
  els.lang.disabled = true;
}

function handleControl(msg) {
  if (msg.type === 'joined') {
    els.conn.textContent = 'connected';
  } else if (msg.type === 'audio-format') {
    incomingRate = msg.sampleRate || 16000;
  } else if (msg.type === 'speaker-status') {
    els.speaker.textContent = msg.live
      ? `live (${msg.speakerLang || '?'})`
      : 'not live';
  } else if (msg.type === 'error') {
    els.error.textContent = msg.message;
  }
}

function playFrame(arrayBuffer) {
  const float = int16ToFloat(new Int16Array(arrayBuffer));
  const buffer = audioCtx.createBuffer(1, float.length, incomingRate);
  buffer.getChannelData(0).set(float);

  const now = audioCtx.currentTime;
  // On startup or after an underrun, rebuild the schedule with a small lead.
  if (nextTime < now + 0.02) nextTime = now + JITTER_LEAD;

  const src = audioCtx.createBufferSource();
  src.buffer = buffer;
  src.connect(audioCtx.destination);
  src.start(nextTime);
  nextTime += buffer.duration;
}

function stop() {
  listening = false;
  els.join.textContent = 'Listen';
  els.join.classList.remove('stop');
  els.lang.disabled = false;
  els.conn.textContent = 'idle';
  els.speaker.textContent = '—';
  if (ws) { ws.close(); ws = null; }
  if (audioCtx) { audioCtx.close(); audioCtx = null; }
}
