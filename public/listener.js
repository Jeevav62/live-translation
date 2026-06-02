import { int16ToFloat } from './audio-utils.js';

let incomingRate = 16000; // updated by server 'audio-format' message; relay + TTS are 16kHz PCM16
const JITTER_LEAD = 0.15; // seconds of buffer before playback to absorb network jitter
const LANG_NAME = { hi: 'Hindi', en: 'English' };

const params = new URLSearchParams(location.search);
const roomId = params.get('room') || 'main';

const els = {
  lang: document.getElementById('lang'),
  join: document.getElementById('join'),
  conn: document.getElementById('conn'),
  dot: document.getElementById('dot'),
  speaker: document.getElementById('speaker'),
  latency: document.getElementById('latency'),
  error: document.getElementById('error'),
  roomtag: document.getElementById('roomtag'),
  eq: document.getElementById('eq'),
  waiting: document.getElementById('waiting'),
  latsub: document.getElementById('latsub'),
  latbox: document.getElementById('latbox'),
  badge: document.getElementById('badge'),
  badgetxt: document.getElementById('badgetxt'),
  resume: document.getElementById('resume'),
  vol: document.getElementById('vol'),
  volout: document.getElementById('volout'),
  capbody: document.getElementById('capbody'),
  capeq: document.getElementById('capeq'),
};
els.roomtag.textContent = roomId;

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Remember across a refresh that we were listening to this room, so we can offer
// a one-tap resume (audio playback needs a user gesture, browser rule).
const LISTEN_KEY = 'lt-listen-room';
const wasListening = sessionStorage.getItem(LISTEN_KEY) === roomId;

function setBadge(on, text) {
  els.badge.className = 'pill ' + (on ? 'on' : 'idle');
  els.badgetxt.textContent = text;
}

// Preselect language passed from the join page (?lang=hi|en).
const preLang = params.get('lang');
if (preLang === 'hi' || preLang === 'en') els.lang.value = preLang;

// Stable per-browser id so the server can enforce one-room-per-listener.
const clientId = (() => {
  let id = localStorage.getItem('lt-client-id');
  if (!id) { id = Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('lt-client-id', id); }
  return id;
})();

function setConn(text, on) {
  els.conn.textContent = text;
  els.dot.className = 'dot' + (on ? ' on' : '');
}

let ws = null;
let audioCtx = null;
let nextTime = 0;
let listening = false;
let speakerLang = null;
let speakerLive = false;
let engine = null; // translation engine the room uses ('sarvam' | 'openai')
let intentional = false;
let reconnectTimer = null;
let attempts = 0;
let eqTimer = null;
let gainNode = null;
let capHistory = [];
let capCurrent = '';

els.join.addEventListener('click', () => (listening ? stop() : start()));

// Switch the language you hear, mid-session, without rejoining.
els.lang.addEventListener('change', () => {
  resetCaptions(); // captions are language-specific
  if (!listening || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'set-lang', lang: els.lang.value }));
  nextTime = 0;
  updateLatency();
});

// ---- volume ----
els.vol.addEventListener('input', () => {
  els.volout.textContent = els.vol.value + '%';
  if (gainNode) gainNode.gain.value = els.vol.value / 100;
});

// ---- live captions ----
function resetCaptions() {
  capHistory = []; capCurrent = '';
  els.capbody.innerHTML = '<span class="cap-empty">Captions appear here once the speaker is translating…</span>';
}
function renderCaptions() {
  const lines = capCurrent ? [...capHistory, capCurrent] : [...capHistory];
  if (!lines.length) return resetCaptions();
  els.capbody.innerHTML = lines
    .map((l, i) => `<div class="cap-line${capCurrent && i === lines.length - 1 ? ' cap-live' : ''}">${escapeHtml(l)}</div>`)
    .join('');
  els.capbody.scrollTop = els.capbody.scrollHeight;
}
function handleCaption(msg) {
  if (msg.final) {
    if (msg.text) capHistory.push(msg.text);
    if (capHistory.length > 6) capHistory.shift();
    capCurrent = '';
  } else {
    capCurrent = msg.text || '';
  }
  renderCaptions();
}

// ---- latency hero metric ----
function setMetric(cls, big, sub) {
  els.latbox.className = 'metric ' + cls;
  els.latency.textContent = big;
  els.latsub.textContent = sub;
}
function updateLatency() {
  if (!listening) { setMetric('', '—', 'Tap Listen to start'); return; }
  if (speakerLang && els.lang.value === speakerLang) {
    setMetric('relay', 'Live', 'Playing in real time · same language');
  } else {
    setMetric('', '⏳', 'Measuring latency…');
  }
}
function showMeasuredLatency(last, p50, count) {
  const s = (last / 1000).toFixed(1);
  const med = (p50 / 1000).toFixed(1);
  const cls = p50 < 1500 ? 'good' : p50 < 3000 ? 'ok' : 'bad';
  setMetric(cls, `${s}s`, `behind live · median ${med}s · ${count} sample${count === 1 ? '' : 's'}`);
}

// ---- waiting / speaker state ----
function refreshSpeaker() {
  if (!listening) { els.speaker.textContent = '—'; els.waiting.classList.remove('show'); return; }
  if (speakerLive) {
    const translated = speakerLang && els.lang.value !== speakerLang;
    const engLabel = engine === 'openai' ? 'GPT' : engine === 'cartesia' ? 'Sarvam+Cartesia ⚡' : 'Sarvam';
    const eng = translated && engine ? ` · via ${engLabel}` : '';
    els.speaker.textContent = `Live · ${LANG_NAME[speakerLang] || speakerLang || '?'}${eng}`;
    els.waiting.classList.remove('show');
  } else {
    els.speaker.textContent = 'not live yet';
    els.waiting.classList.add('show');
  }
}

// ---- playing indicator ----
function pingEq() {
  els.eq.classList.add('on');
  els.capeq.classList.add('on');
  els.latbox.classList.add('pulse');
  clearTimeout(eqTimer);
  eqTimer = setTimeout(() => {
    els.eq.classList.remove('on');
    els.capeq.classList.remove('on');
    els.latbox.classList.remove('pulse');
  }, 450);
}

async function start() {
  els.error.textContent = '';
  els.resume.classList.remove('show');
  intentional = false;
  attempts = 0;
  audioCtx = new AudioContext();
  await audioCtx.resume();
  gainNode = audioCtx.createGain();
  gainNode.gain.value = els.vol.value / 100;
  gainNode.connect(audioCtx.destination);
  resetCaptions();
  nextTime = 0;
  listening = true;
  els.join.textContent = 'Stop';
  els.join.classList.add('stop');
  updateLatency();
  connect();
}

function connect() {
  setConn(attempts ? 'reconnecting…' : 'connecting…', false);
  const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${wsProto}://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'join', room: roomId, role: 'listener', lang: els.lang.value, clientId }));
  };

  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') handleControl(JSON.parse(ev.data));
    else playFrame(ev.data);
  };

  ws.onclose = () => {
    if (intentional) { setConn('idle', false); return; }
    if (listening) scheduleReconnect();
  };
}

function scheduleReconnect() {
  setConn('reconnecting…', false);
  attempts += 1;
  const delay = Math.min(8000, 400 * 2 ** attempts);
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => { if (listening && !intentional) connect(); }, delay);
}

function handleControl(msg) {
  if (msg.type === 'joined') {
    setConn('connected', true);
    setBadge(true, 'Listening');
    sessionStorage.setItem(LISTEN_KEY, roomId); // survive a refresh
    attempts = 0;
    speakerLang = msg.speakerLang || speakerLang;
    speakerLive = !!msg.live;
    engine = msg.provider || engine;
    updateLatency();
    refreshSpeaker();
  } else if (msg.type === 'audio-format') {
    incomingRate = msg.sampleRate || 16000;
  } else if (msg.type === 'speaker-status') {
    speakerLang = msg.speakerLang || speakerLang;
    speakerLive = !!msg.live;
    engine = msg.provider || engine;
    updateLatency();
    refreshSpeaker();
  } else if (msg.type === 'caption') {
    handleCaption(msg);
  } else if (msg.type === 'latency') {
    showMeasuredLatency(msg.last, msg.p50, msg.count);
  } else if (msg.type === 'evicted' || msg.type === 'room-closed') {
    els.error.textContent = msg.message;
    intentional = true;
    stop();
  } else if (msg.type === 'error') {
    els.error.textContent = msg.message;
  }
}

function playFrame(arrayBuffer) {
  if (!audioCtx) return;
  const float = int16ToFloat(new Int16Array(arrayBuffer));
  const buffer = audioCtx.createBuffer(1, float.length, incomingRate);
  buffer.getChannelData(0).set(float);

  const now = audioCtx.currentTime;
  if (nextTime < now + 0.02) nextTime = now + JITTER_LEAD;

  const src = audioCtx.createBufferSource();
  src.buffer = buffer;
  src.connect(gainNode || audioCtx.destination);
  src.start(nextTime);
  nextTime += buffer.duration;
  pingEq();
}

function stop() {
  listening = false;
  intentional = true;
  clearTimeout(reconnectTimer);
  sessionStorage.removeItem(LISTEN_KEY); // intentional stop — don't offer resume
  els.resume.classList.remove('show');
  els.join.textContent = 'Listen';
  els.join.classList.remove('stop');
  setConn('idle', false);
  setBadge(false, 'Idle');
  speakerLang = null;
  speakerLive = false;
  engine = null;
  setMetric('', '—', 'Tap Listen to start');
  els.eq.classList.remove('on');
  els.capeq.classList.remove('on');
  resetCaptions();
  refreshSpeaker();
  if (ws) { ws.close(); ws = null; }
  gainNode = null;
  if (audioCtx) { audioCtx.close(); audioCtx = null; }
}

// Refreshed mid-session? Offer a one-tap resume (audio playback needs the tap).
if (wasListening) {
  els.join.textContent = '▶ Resume listening';
  els.resume.classList.add('show');
}
