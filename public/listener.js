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
  latency: document.getElementById('latency'),
  error: document.getElementById('error'),
};
els.room.innerHTML = `<option>${roomId}</option>`;

let ws = null;
let audioCtx = null;
let nextTime = 0;
let listening = false;
let speakerLang = null; // learned from server; lets us show "raw relay" vs translated

els.join.addEventListener('click', () => (listening ? stop() : start()));

// Switch the language you hear, mid-session, without rejoining.
els.lang.addEventListener('change', () => {
  if (!listening || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'set-lang', lang: els.lang.value }));
  nextTime = 0; // reset playback schedule for the new stream
  updateLatencyLabel();
});

// Show "raw relay" when we want the speaker's own language (no AI), otherwise
// wait for the server to push real translated-path latency numbers.
function updateLatencyLabel() {
  if (!listening) { els.latency.textContent = '—'; return; }
  if (speakerLang && els.lang.value === speakerLang) {
    els.latency.textContent = 'raw relay (~instant)';
  } else {
    els.latency.textContent = 'measuring…';
  }
}

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
  updateLatencyLabel();
}

function handleControl(msg) {
  if (msg.type === 'joined') {
    els.conn.textContent = 'connected';
    speakerLang = msg.speakerLang || speakerLang;
    updateLatencyLabel();
  } else if (msg.type === 'audio-format') {
    incomingRate = msg.sampleRate || 16000;
  } else if (msg.type === 'speaker-status') {
    speakerLang = msg.speakerLang || speakerLang;
    els.speaker.textContent = msg.live ? `live (${msg.speakerLang || '?'})` : 'not live';
    updateLatencyLabel();
  } else if (msg.type === 'latency') {
    // Translated path: server pushes per-utterance E2E + running median.
    els.latency.textContent = `${(msg.last / 1000).toFixed(1)}s · median ${(msg.p50 / 1000).toFixed(1)}s (n=${msg.count})`;
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
  els.conn.textContent = 'idle';
  els.speaker.textContent = '—';
  els.latency.textContent = '—';
  speakerLang = null;
  if (ws) { ws.close(); ws = null; }
  if (audioCtx) { audioCtx.close(); audioCtx = null; }
}
