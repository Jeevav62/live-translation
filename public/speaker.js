import { TARGET_RATE, floatToInt16, downsample } from './audio-utils.js';

const params = new URLSearchParams(location.search);
const roomId = params.get('room') || 'main';

const els = {
  lang: document.getElementById('lang'),
  go: document.getElementById('go'),
  conn: document.getElementById('conn'),
  dot: document.getElementById('dot'),
  count: document.getElementById('count'),
  error: document.getElementById('error'),
  roomtag: document.getElementById('roomtag'),
  roomcode: document.getElementById('roomcode'),
  qr: document.getElementById('qr'),
  copy: document.getElementById('copy'),
};

// Preselect language passed from the join page (?lang=hi|en).
const preLang = params.get('lang');
if (preLang === 'hi' || preLang === 'en') els.lang.value = preLang;

const clientId = (() => {
  let id = localStorage.getItem('lt-client-id');
  if (!id) { id = Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('lt-client-id', id); }
  return id;
})();

els.roomtag.textContent = roomId;
els.roomcode.textContent = roomId;

// The QR encodes the unified join link — everyone scans the SAME code and then
// chooses Speaker or Listener on join.html.
const joinUrl = `${location.origin}/join.html?room=${encodeURIComponent(roomId)}`;
els.qr.src = `/api/qr?data=${encodeURIComponent(joinUrl)}`;
els.copy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(joinUrl);
    els.copy.textContent = 'Copied ✓';
    setTimeout(() => (els.copy.textContent = 'Copy join link'), 1500);
  } catch {
    els.copy.textContent = joinUrl;
  }
});

function setConn(text, on) {
  els.conn.textContent = text;
  els.dot.className = 'dot' + (on ? ' on' : '');
}

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
  setConn('connecting…', false);
  const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${wsProto}://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'join', room: roomId, role: 'speaker', lang: els.lang.value, clientId }));
  };

  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return;
    const msg = JSON.parse(ev.data);
    if (msg.type === 'joined') {
      setConn('live', true);
      ws.send(JSON.stringify({ type: 'go-live' }));
      live = true;
      els.go.textContent = 'Stop';
      els.go.classList.add('live');
      els.lang.disabled = true;
    } else if (msg.type === 'listener-count') {
      els.count.textContent = msg.count;
    } else if (msg.type === 'room-closed') {
      els.error.textContent = msg.message;
      stop();
    } else if (msg.type === 'error') {
      els.error.textContent = msg.message;
      stop();
    }
  };

  ws.onclose = () => {
    setConn('disconnected', false);
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
  setConn('idle', false);
  if (ws) { ws.close(); ws = null; }
  if (workletNode) { workletNode.disconnect(); workletNode = null; }
  if (mediaStream) { mediaStream.getTracks().forEach((t) => t.stop()); mediaStream = null; }
  if (audioCtx) { audioCtx.close(); audioCtx = null; }
}
