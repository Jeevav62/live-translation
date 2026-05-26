import { TARGET_RATE, floatToInt16, downsample } from './audio-utils.js';

const params = new URLSearchParams(location.search);
const roomId = params.get('room') || 'main';

const els = {
  room: document.getElementById('room'),
  lang: document.getElementById('lang'),
  go: document.getElementById('go'),
  conn: document.getElementById('conn'),
  count: document.getElementById('count'),
  error: document.getElementById('error'),
};

els.room.innerHTML = `<option>${roomId}</option>`;

let ws = null;
let audioCtx = null;
let workletNode = null;
let mediaStream = null;
let live = false;

els.go.addEventListener('click', () => (live ? stop() : start()));

async function start() {
  els.error.textContent = '';
  try {
    await startMic();
  } catch (e) {
    els.error.textContent = 'Microphone access failed: ' + e.message;
    return;
  }
  connect();
}

function connect() {
  els.conn.textContent = 'connecting…';
  const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${wsProto}://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'join', room: roomId, role: 'speaker', lang: els.lang.value }));
  };

  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return;
    const msg = JSON.parse(ev.data);
    if (msg.type === 'joined') {
      els.conn.textContent = 'live';
      ws.send(JSON.stringify({ type: 'go-live' }));
      live = true;
      els.go.textContent = 'Stop';
      els.go.classList.add('live');
      els.lang.disabled = true;
    } else if (msg.type === 'listener-count') {
      els.count.textContent = msg.count;
    } else if (msg.type === 'error') {
      els.error.textContent = msg.message;
      stop();
    }
  };

  ws.onclose = () => {
    els.conn.textContent = 'disconnected';
    if (live) stop();
  };
}

async function startMic() {
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  audioCtx = new AudioContext({ sampleRate: TARGET_RATE });
  await audioCtx.audioWorklet.addModule('pcm-worklet.js');

  const source = audioCtx.createMediaStreamSource(mediaStream);
  workletNode = new AudioWorkletNode(audioCtx, 'pcm-capture');

  const ctxRate = audioCtx.sampleRate; // honored 16000 on most browsers; fallback otherwise
  workletNode.port.onmessage = (e) => {
    if (!live || !ws || ws.readyState !== WebSocket.OPEN) return;
    let float = e.data;
    if (ctxRate !== TARGET_RATE) float = downsample(float, ctxRate, TARGET_RATE);
    const pcm = floatToInt16(float);
    ws.send(pcm.buffer);
  };

  source.connect(workletNode);
  workletNode.connect(audioCtx.destination); // drives the graph; worklet emits silence
}

function stop() {
  live = false;
  els.go.textContent = 'Go Live';
  els.go.classList.remove('live');
  els.lang.disabled = false;
  els.conn.textContent = 'idle';
  if (ws) { ws.close(); ws = null; }
  if (workletNode) { workletNode.disconnect(); workletNode = null; }
  if (mediaStream) { mediaStream.getTracks().forEach((t) => t.stop()); mediaStream = null; }
  if (audioCtx) { audioCtx.close(); audioCtx = null; }
}
