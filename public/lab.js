import { TARGET_RATE, floatToInt16, int16ToFloat, downsample } from './audio-utils.js';

const STT_NAMES = { sarvam: 'Sarvam Saaras v3 (current)', deepgram: 'Deepgram', eleven: 'ElevenLabs Scribe v2' };
const TR_NAMES = { sarvam: 'Sarvam Translate (current)' };
const TTS_NAMES = { sarvam: 'Sarvam Bulbul v2 (current)', cartesia: 'Cartesia', eleven: 'ElevenLabs' };

// Per-provider model variants. Empty = no model picker shown.
const STT_MODELS = {
  deepgram: [{ v: 'nova-3', l: 'Nova-3' }, { v: 'flux', l: 'Flux (turn-based)' }],
};
const TTS_MODELS = {
  sarvam: [{ v: 'bulbul:v3', l: 'Bulbul v3 (latest)' }, { v: 'bulbul:v2', l: 'Bulbul v2 (current)' }],
  cartesia: [{ v: 'sonic-3.5', l: 'Sonic 3.5' }, { v: 'sonic-3', l: 'Sonic 3' }],
  eleven: [{ v: 'eleven_flash_v2_5', l: 'Flash v2.5' }, { v: 'eleven_turbo_v2_5', l: 'Turbo v2.5' }],
};

const els = {
  engine: document.getElementById('engine'),
  engnote: document.getElementById('engnote'),
  pipefields: document.getElementById('pipefields'),
  src: document.getElementById('src'),
  tgt: document.getElementById('tgt'),
  stt: document.getElementById('stt'),
  sttmodel: document.getElementById('sttmodel'),
  translate: document.getElementById('translate'),
  trnote: document.getElementById('trnote'),
  tts: document.getElementById('tts'),
  ttsmodel: document.getElementById('ttsmodel'),
  go: document.getElementById('go'),
  error: document.getElementById('error'),
  conn: document.getElementById('conn'),
  dot: document.getElementById('dot'),
  badge: document.getElementById('badge'),
  badgetxt: document.getElementById('badgetxt'),
  combo: document.getElementById('combo'),
  mStt: document.getElementById('m-stt'),
  mTr: document.getElementById('m-tr'),
  mTts: document.getElementById('m-tts'),
  mE2e: document.getElementById('m-e2e'),
  agg: document.getElementById('agg'),
  heard: document.getElementById('heard'),
  said: document.getElementById('said'),
  vol: document.getElementById('vol'),
  volout: document.getElementById('volout'),
};

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function fillSelect(sel, available, names) {
  sel.innerHTML = '';
  for (const [key, ok] of Object.entries(available)) {
    if (!ok) continue;
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = names[key] || key;
    sel.appendChild(opt);
  }
  if (!sel.options.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '(no key configured)';
    sel.appendChild(opt);
    sel.disabled = true;
  }
}

// Show/populate the per-provider model picker (e.g. Deepgram Nova-3 vs Flux).
function fillModelSelect(sel, models) {
  if (!models) { sel.style.display = 'none'; sel.innerHTML = ''; return; }
  sel.style.display = '';
  sel.innerHTML = '';
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.v; opt.textContent = m.l;
    sel.appendChild(opt);
  }
}
function updateModelSelects() {
  fillModelSelect(els.sttmodel, STT_MODELS[els.stt.value]);
  fillModelSelect(els.ttsmodel, TTS_MODELS[els.tts.value]);
}

// GPT engine is a single speech-to-speech socket — no STT/Translate/TTS chain.
function isGpt() { return els.engine.value === 'gpt'; }
function updateEngineMode() {
  if (isGpt()) {
    els.pipefields.style.display = 'none';
    els.engnote.textContent = 'OpenAI gpt-realtime-translate: one speech-to-speech model (no separate STT/translate/TTS). The current GPT engine.';
  } else {
    els.pipefields.style.display = '';
    els.engnote.textContent = 'Build a chain from any STT + Translator + TTS. All-Sarvam = our current Saaras production path.';
  }
}

// Populate dropdowns from configured keys.
fetch('/api/config').then((r) => r.json()).then((cfg) => {
  const lab = cfg.lab || { stt: {}, translate: {}, tts: {} };
  fillSelect(els.stt, lab.stt, STT_NAMES);
  fillSelect(els.translate, lab.translate, TR_NAMES);
  fillSelect(els.tts, lab.tts, TTS_NAMES);
  // Engine options: custom pipeline always; GPT only if an OpenAI key is set.
  const engines = [{ v: 'pipeline', l: 'Custom pipeline (STT + Translate + TTS)' }];
  if (cfg.providers?.openai) engines.push({ v: 'gpt', l: 'GPT Realtime — speech-to-speech (current)' });
  els.engine.innerHTML = '';
  for (const e of engines) { const o = document.createElement('option'); o.value = e.v; o.textContent = e.l; els.engine.appendChild(o); }
  updateEngineMode();
  updateModelSelects();
  updateTrNote();
}).catch(() => { els.error.textContent = 'Could not load provider config.'; });

function sameLang() { return els.src.value === els.tgt.value; }
function usesSaaras() { return els.stt.value === 'sarvam' && els.tgt.value === 'en'; }
function updateTrNote() {
  if (sameLang()) {
    els.translate.disabled = true;
    els.trnote.textContent = 'Same language — no translation (STT → TTS re-voice).';
  } else if (usesSaaras()) {
    els.translate.disabled = true;
    els.trnote.textContent = 'Sarvam Saaras translates Indic→English in one call — no separate translator used.';
  } else {
    els.translate.disabled = false;
    els.trnote.textContent = 'A separate translator step is used for this direction.';
  }
}

els.vol.addEventListener('input', () => {
  els.volout.textContent = els.vol.value + '%';
  if (gainNode) gainNode.gain.value = els.vol.value / 100;
});

let ws = null, audioCtx = null, workletNode = null, mediaStream = null;
let playCtx = null, nextTime = 0, gainNode = null;
let running = false, labReady = false, incomingRate = 16000;

function setConn(text, on) { els.conn.textContent = text; els.dot.className = 'dot' + (on ? ' on' : ''); }
function setBadge(on, text) { els.badge.className = 'pill ' + (on ? 'on' : 'idle'); els.badgetxt.textContent = text; }

function joinMsg() {
  return {
    type: 'lab-join',
    engine: els.engine.value,
    sttProvider: els.stt.value,
    translateProvider: els.translate.value,
    ttsProvider: els.tts.value,
    sttModel: els.sttmodel.style.display !== 'none' ? els.sttmodel.value : null,
    ttsModel: els.ttsmodel.style.display !== 'none' ? els.ttsmodel.value : null,
    speakerLang: els.src.value,
    targetLang: els.tgt.value,
  };
}

// Switching any selector mid-run re-applies the combo without dropping the mic.
function reapply() {
  if (running && ws && ws.readyState === WebSocket.OPEN) {
    labReady = false;
    resetReadouts();
    ws.send(JSON.stringify(joinMsg()));
  }
}
// Engine change toggles the pipeline fields, then re-applies.
els.engine.addEventListener('change', () => { updateEngineMode(); reapply(); });
// Provider/lang changes rebuild the model picker, then re-apply.
for (const sel of [els.src, els.tgt, els.stt, els.translate, els.tts]) {
  sel.addEventListener('change', () => { updateModelSelects(); updateTrNote(); reapply(); });
}
// Model changes just re-apply (don't rebuild the list, which would reset the pick).
for (const sel of [els.sttmodel, els.ttsmodel]) {
  sel.addEventListener('change', reapply);
}

els.go.addEventListener('click', () => (running ? stop() : start()));

async function start() {
  els.error.textContent = '';
  if (!isGpt() && (!els.stt.value || !els.tts.value)) { els.error.textContent = 'Pick providers that have keys.'; return; }
  try { await startMic(); } catch (e) { els.error.textContent = 'Mic access failed: ' + e.message; return; }
  running = true;
  els.go.textContent = 'Stop';
  els.go.classList.add('live');
  setBadge(true, 'Running');
  resetReadouts();
  connect();
}

function connect() {
  setConn('connecting…', false);
  const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${wsProto}://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => ws.send(JSON.stringify(joinMsg()));
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') { playFrame(ev.data); return; }
    handleControl(JSON.parse(ev.data));
  };
  ws.onclose = () => { if (running) setConn('disconnected', false); };
}

function handleControl(msg) {
  if (msg.type === 'lab-joined') {
    labReady = true;
    incomingRate = msg.sampleRate || 16000;
    els.combo.textContent = msg.combo || '—';
    setConn('live', true);
  } else if (msg.type === 'transcript') {
    els.heard.innerHTML = `<div class="cap-line">${escapeHtml(msg.text)}</div>`;
  } else if (msg.type === 'caption') {
    els.said.innerHTML = `<div class="cap-line">${escapeHtml(msg.text)}</div>`;
  } else if (msg.type === 'latency') {
    els.mStt.textContent = msg.stt_ms != null ? msg.stt_ms + 'ms' : '—';
    els.mTr.textContent = msg.translate_ms != null ? msg.translate_ms + 'ms' : 'n/a';
    els.mTts.textContent = msg.tts_ms != null ? msg.tts_ms + 'ms' : '—';
    els.mE2e.textContent = msg.last != null ? (msg.last / 1000).toFixed(2) + 's' : '—';
    els.agg.textContent = `median ${(msg.p50 / 1000).toFixed(2)}s · p95 ${(msg.p95 / 1000).toFixed(2)}s · ${msg.count} sample${msg.count === 1 ? '' : 's'}`;
  } else if (msg.type === 'error') {
    els.error.textContent = msg.message;
  }
}

async function startMic() {
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  audioCtx = new AudioContext({ sampleRate: TARGET_RATE });
  await audioCtx.resume();
  await audioCtx.audioWorklet.addModule('pcm-worklet.js');
  const source = audioCtx.createMediaStreamSource(mediaStream);
  workletNode = new AudioWorkletNode(audioCtx, 'pcm-capture');
  const ctxRate = audioCtx.sampleRate;
  workletNode.port.onmessage = (e) => {
    if (!running || !labReady || !ws || ws.readyState !== WebSocket.OPEN) return;
    let f = e.data;
    if (ctxRate !== TARGET_RATE) f = downsample(f, ctxRate, TARGET_RATE);
    ws.send(floatToInt16(f).buffer);
  };
  source.connect(workletNode);
  workletNode.connect(audioCtx.destination);

  // Separate context for playback so capture rate doesn't constrain output.
  playCtx = new AudioContext();
  await playCtx.resume();
  gainNode = playCtx.createGain();
  gainNode.gain.value = els.vol.value / 100;
  gainNode.connect(playCtx.destination);
  nextTime = 0;
}

function playFrame(arrayBuffer) {
  if (!playCtx) return;
  const float = int16ToFloat(new Int16Array(arrayBuffer));
  const buffer = playCtx.createBuffer(1, float.length, incomingRate);
  buffer.getChannelData(0).set(float);
  const now = playCtx.currentTime;
  if (nextTime < now + 0.02) nextTime = now + 0.15;
  const src = playCtx.createBufferSource();
  src.buffer = buffer;
  src.connect(gainNode);
  src.start(nextTime);
  nextTime += buffer.duration;
}

function resetReadouts() {
  els.mStt.textContent = els.mTr.textContent = els.mTts.textContent = els.mE2e.textContent = '—';
  els.agg.textContent = 'median —';
  els.heard.innerHTML = '<span class="cap-empty">Your recognized speech appears here…</span>';
  els.said.innerHTML = '<span class="cap-empty">The translated text appears here…</span>';
}

// ---- past runs comparison table ----
async function loadHistory() {
  const el = document.getElementById('histtable');
  try {
    const data = await (await fetch('/metrics/history')).json();
    const dirs = Object.entries(data.byDirection || {});
    if (!dirs.length) { el.innerHTML = '<span class="cap-empty">No runs yet.</span>'; return; }
    dirs.sort((a, b) => (a[1].e2e_ms.p50 || 9999) - (b[1].e2e_ms.p50 || 9999));
    const rows = dirs.map(([combo, d], i) => {
      const p50 = d.e2e_ms.p50; const n = d.e2e_ms.count;
      const stt = d.stt_ms.count ? d.stt_ms.avg + 'ms' : '—';
      const tr = d.translate_ms.count ? d.translate_ms.avg + 'ms' : '—';
      const tts = d.tts_ms.count ? d.tts_ms.avg + 'ms' : '—';
      const cls = p50 < 600 ? 'good' : p50 < 1200 ? 'ok' : 'bad';
      const medal = i === 0 ? '🥇 ' : i === 1 ? '🥈 ' : i === 2 ? '🥉 ' : '';
      return `<tr>
        <td>${medal}<strong>${escapeHtml(combo)}</strong></td>
        <td><span class="lat ${cls}">${(p50/1000).toFixed(2)}s</span></td>
        <td style="color:var(--muted-ink)">${n}</td>
        <td style="color:var(--muted-ink);font-size:0.8rem">${stt} · ${tr} · ${tts}</td>
      </tr>`;
    }).join('');
    el.innerHTML = `<table class="hist-table"><thead><tr><th>Combo</th><th>E2E p50</th><th>n</th><th>STT · TR · TTS (avg)</th></tr></thead><tbody>${rows}</tbody></table>`;
  } catch { el.innerHTML = '<span class="cap-empty">Could not load history.</span>'; }
}
loadHistory();
document.getElementById('refreshhist').addEventListener('click', loadHistory);

function stop() {
  running = false; labReady = false;
  setTimeout(loadHistory, 800); // refresh table after pipeline flushes metrics
  els.go.textContent = 'Go';
  els.go.classList.remove('live');
  setBadge(false, 'Idle');
  setConn('idle', false);
  els.combo.textContent = '—';
  try { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'lab-stop' })); } catch {}
  if (ws) { ws.close(); ws = null; }
  if (workletNode) { workletNode.disconnect(); workletNode = null; }
  if (mediaStream) { mediaStream.getTracks().forEach((t) => t.stop()); mediaStream = null; }
  if (audioCtx) { audioCtx.close(); audioCtx = null; }
  if (playCtx) { playCtx.close(); playCtx = null; }
  gainNode = null;
}
