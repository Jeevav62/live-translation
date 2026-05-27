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
  meter: document.getElementById('meter'),
  badge: document.getElementById('badge'),
  badgetxt: document.getElementById('badgetxt'),
  resume: document.getElementById('resume'),
  engine: document.getElementById('engine'),
  enginewrap: document.getElementById('enginewrap'),
};

// Show the engine picker only if the server has an OpenAI key configured.
fetch('/api/config').then((r) => r.json()).then((cfg) => {
  if (cfg?.providers?.openai) els.enginewrap.style.display = 'block';
}).catch(() => {});

// Remember across a page refresh that we were broadcasting this room, so we can
// offer a one-tap resume (the mic needs a user gesture, browser rule).
const LIVE_KEY = 'lt-live-room';
const wasLive = sessionStorage.getItem(LIVE_KEY) === roomId;

function setBadge(onAir) {
  els.badge.className = 'pill ' + (onAir ? 'air' : 'idle');
  els.badgetxt.textContent = onAir ? 'On air' : 'Off air';
}

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
  if (navigator.share) { try { await navigator.share({ title: 'Live Translation', url: joinUrl }); return; } catch {} }
  try {
    await navigator.clipboard.writeText(joinUrl);
    els.copy.textContent = 'Copied ✓';
    setTimeout(() => (els.copy.textContent = '📋 Copy join link'), 1500);
  } catch { els.copy.textContent = joinUrl; }
});

function setConn(text, on) {
  els.conn.textContent = text;
  els.dot.className = 'dot' + (on ? ' on' : '');
}

// ---- mic level meter ----
const bars = [...els.meter.querySelectorAll('.bar')];
const levels = new Array(bars.length).fill(0);
function pushLevel(float) {
  let sum = 0;
  for (let i = 0; i < float.length; i++) sum += float[i] * float[i];
  const level = Math.min(1, Math.sqrt(sum / float.length) * 4.5); // gain for visibility
  levels.push(level); levels.shift();
  els.meter.classList.toggle('active', level > 0.02);
  for (let i = 0; i < bars.length; i++) bars[i].style.height = (8 + levels[i] * 92) + '%';
}
function resetMeter() {
  els.meter.classList.remove('active');
  levels.fill(0);
  for (const b of bars) b.style.height = '18%';
}

let ws = null;
let audioCtx = null;
let workletNode = null;
let mediaStream = null;
let live = false;
let intentional = false;
let reconnectTimer = null;
let attempts = 0;

els.go.addEventListener('click', () => (live ? stop() : start()));

async function start() {
  els.error.textContent = '';
  els.resume.classList.remove('show');
  intentional = false;
  attempts = 0;
  try {
    await startMic();
  } catch (e) {
    els.error.textContent = 'Microphone access failed: ' + e.message;
    return;
  }
  live = true;
  els.go.textContent = 'Stop';
  els.go.classList.add('live');
  els.lang.disabled = true;
  els.engine.disabled = true;
  connect();
}

function connect() {
  setConn(attempts ? 'reconnecting…' : 'connecting…', false);
  const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${wsProto}://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'join', room: roomId, role: 'speaker', lang: els.lang.value, provider: els.engine.value, clientId }));
  };

  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return;
    const msg = JSON.parse(ev.data);
    if (msg.type === 'joined') {
      setConn('live', true);
      setBadge(true);
      sessionStorage.setItem(LIVE_KEY, roomId); // survive a refresh
      attempts = 0;
      ws.send(JSON.stringify({ type: 'go-live' }));
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
    if (intentional) { setConn('idle', false); return; }
    if (live) scheduleReconnect(); // keep the mic open, just re-establish the socket
  };
}

function scheduleReconnect() {
  setConn('reconnecting…', false);
  attempts += 1;
  const delay = Math.min(8000, 400 * 2 ** attempts);
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => { if (live && !intentional) connect(); }, delay);
}

async function startMic() {
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  audioCtx = new AudioContext({ sampleRate: TARGET_RATE });
  await audioCtx.resume(); // ensure the graph runs (autoplay policy)
  await audioCtx.audioWorklet.addModule('pcm-worklet.js');

  const source = audioCtx.createMediaStreamSource(mediaStream);
  workletNode = new AudioWorkletNode(audioCtx, 'pcm-capture');

  const ctxRate = audioCtx.sampleRate; // honored 16000 on most browsers; fallback otherwise
  workletNode.port.onmessage = (e) => {
    const float = e.data;
    pushLevel(float); // drive the meter regardless of connection state
    if (!live || !ws || ws.readyState !== WebSocket.OPEN) return;
    let f = float;
    if (ctxRate !== TARGET_RATE) f = downsample(f, ctxRate, TARGET_RATE);
    ws.send(floatToInt16(f).buffer);
  };

  source.connect(workletNode);
  workletNode.connect(audioCtx.destination); // drives the graph; worklet emits silence
}

function stop() {
  live = false;
  intentional = true;
  clearTimeout(reconnectTimer);
  sessionStorage.removeItem(LIVE_KEY); // intentional stop — don't offer resume
  els.resume.classList.remove('show');
  els.go.textContent = 'Go Live';
  els.go.classList.remove('live');
  els.lang.disabled = false;
  els.engine.disabled = false;
  setConn('idle', false);
  setBadge(false);
  els.count.textContent = '0';
  resetMeter();
  if (ws) { ws.close(); ws = null; }
  if (workletNode) { workletNode.disconnect(); workletNode = null; }
  if (mediaStream) { mediaStream.getTracks().forEach((t) => t.stop()); mediaStream = null; }
  if (audioCtx) { audioCtx.close(); audioCtx = null; }
}

// Refreshed mid-broadcast? Offer a one-tap resume (mic needs the tap by browser
// rule; the server lets this same browser reclaim its speaker slot instantly).
if (wasLive) {
  els.go.textContent = '▶ Resume broadcast';
  els.resume.classList.add('show');
}
