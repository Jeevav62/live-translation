// WebSocket protocol: join (speaker/listener), go-live, language switch, audio frames.
//
// Client -> server:
//   {type:'join', room, role:'speaker'|'listener', lang:'hi'|'en'}
//   {type:'go-live'}                       (speaker, after mic ready)
//   {type:'set-lang', lang}                (listener switches language)
//   <binary frame>                         (speaker only: 16kHz mono PCM16)
//
// Server -> client:
//   {type:'joined', role, lang, room, speakerLang, live}
//   {type:'error', message}
//   {type:'speaker-status', live, speakerLang}
//   {type:'listener-count', count}
//   <binary frame>                         (listener: audio to play)

import {
  getOrCreateRoom,
  getRoom,
  joinAsSpeaker,
  joinAsListener,
  listenerConnectionsForClient,
  leave,
} from './rooms.js';
import { relaySameLang, broadcastControl, sendControl } from './relay.js';
import {
  syncPipelines,
  feedAudio,
  destroyPipelines,
  routePath,
  LISTENER_SAMPLE_RATE,
} from './pipeline/index.js';
import { LabPipeline } from './pipeline/lab.js';
import { hasKeys as openaiHasKeys } from './openaiKeys.js';
import { log } from './log.js';

const VALID_PROVIDERS = {
  stt: new Set(['sarvam', 'deepgram', 'eleven']),
  translate: new Set(['sarvam']),
  tts: new Set(['sarvam', 'cartesia', 'eleven']),
};

const VALID_LANGS = new Set(['hi', 'en']);
const LANG_NAME = { hi: 'Hindi', en: 'English' };
const lang = (l) => LANG_NAME[l] || l;

let connSeq = 0;

export function handleConnection(ws) {
  ws.connId = ++connSeq;
  log.conn(`#${ws.connId} connected`);
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      if (ws.lab) { ws.lab.feed(Buffer.isBuffer(data) ? data : Buffer.from(data)); return; }
      handleAudioFrame(ws, data);
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      sendControl(ws, { type: 'error', message: 'Invalid JSON message' });
      return;
    }
    handleControl(ws, msg);
  });

  ws.on('close', () => {
    if (ws.lab) { ws.lab.stop(); ws.lab = null; log.conn(`#${ws.connId} lab session ended`); }
    const roomId = ws.meta?.roomId;
    const role = ws.meta?.role;
    const room = leave(ws);
    if (room) {
      log.conn(`#${ws.connId} ${role || 'unjoined'} left room "${roomId}"`);
    } else {
      log.conn(`#${ws.connId} disconnected`);
    }
    if (!room) return;
    if (getRoom(roomId)) {
      syncPipelines(room); // speaker may have left (live=false) or a listener-lang emptied
      notifyRoomState(room);
    } else {
      log.room(`"${roomId}" empty — removed`);
      destroyPipelines(room); // room emptied and removed from registry
    }
  });

  ws.on('error', () => {
    /* socket-level errors surface as close; nothing to do here */
  });
}

function handleControl(ws, msg) {
  switch (msg.type) {
    case 'join':
      return doJoin(ws, msg);
    case 'go-live':
      return doGoLive(ws);
    case 'set-lang':
      return doSetLang(ws, msg);
    case 'lab-join':
      return doLabJoin(ws, msg);
    case 'lab-stop':
      if (ws.lab) { ws.lab.stop(); ws.lab = null; }
      return;
    default:
      sendControl(ws, { type: 'error', message: `Unknown message type: ${msg.type}` });
  }
}

// Experiment lab: a solo loopback chain with a chosen STT/Translate/TTS combo.
// Not part of any room — translated audio is streamed back to this same socket.
function doLabJoin(ws, msg) {
  if (ws.lab) { ws.lab.stop(); ws.lab = null; }
  if (ws.meta) return sendControl(ws, { type: 'error', message: 'This socket already joined a room' });
  if (!VALID_LANGS.has(msg.speakerLang) || !VALID_LANGS.has(msg.targetLang)) {
    return sendControl(ws, { type: 'error', message: 'Invalid speaker/target language' });
  }
  const engine = msg.engine === 'gpt' ? 'gpt' : 'pipeline';
  if (engine === 'gpt' && !openaiHasKeys()) {
    return sendControl(ws, { type: 'error', message: 'GPT Realtime needs an OPENAI_API_KEY' });
  }
  const stt = VALID_PROVIDERS.stt.has(msg.sttProvider) ? msg.sttProvider : 'sarvam';
  const translateProvider = VALID_PROVIDERS.translate.has(msg.translateProvider) ? msg.translateProvider : 'sarvam';
  const tts = VALID_PROVIDERS.tts.has(msg.ttsProvider) ? msg.ttsProvider : 'sarvam';

  ws.lab = new LabPipeline({
    engine,
    sttProvider: stt,
    translateProvider,
    ttsProvider: tts,
    sttModel: typeof msg.sttModel === 'string' ? msg.sttModel : null,
    ttsModel: typeof msg.ttsModel === 'string' ? msg.ttsModel : null,
    speakerLang: msg.speakerLang,
    targetLang: msg.targetLang,
    onAudio: (pcm) => { if (ws.readyState === ws.OPEN) ws.send(pcm); },
    onControl: (m) => sendControl(ws, m),
  });
  ws.lab.start();
  log.room(`#${ws.connId} LAB ${ws.lab.combo} ${lang(msg.speakerLang)}->${lang(msg.targetLang)}`);
  sendControl(ws, { type: 'lab-joined', sampleRate: LISTENER_SAMPLE_RATE, combo: ws.lab.combo });
}

function doJoin(ws, msg) {
  const { room: roomId, role } = msg;
  if (!roomId || typeof roomId !== 'string') {
    return sendControl(ws, { type: 'error', message: 'Missing room id' });
  }
  if (!VALID_LANGS.has(msg.lang)) {
    return sendControl(ws, { type: 'error', message: `Unsupported language: ${msg.lang}` });
  }
  if (ws.meta) {
    return sendControl(ws, { type: 'error', message: 'Already joined' });
  }

  // Best-effort browser identity for the one-room-per-listener rule.
  if (typeof msg.clientId === 'string') ws.clientId = msg.clientId;

  const room = getOrCreateRoom(roomId);
  const result =
    role === 'speaker'
      ? joinAsSpeaker(room, ws, msg.lang)
      : role === 'listener'
        ? joinAsListener(room, ws, msg.lang)
        : { ok: false, error: `Invalid role: ${role}` };

  if (!result.ok) {
    log.room(`#${ws.connId} rejected from "${roomId}" as ${role}: ${result.error}`);
    return sendControl(ws, { type: 'error', message: result.error });
  }

  if (role === 'speaker') {
    room.provider = msg.provider === 'openai' ? 'openai' : 'sarvam'; // engine for this room
    log.room(`#${ws.connId} joined "${room.id}" as SPEAKER, speaking ${lang(msg.lang)} via ${room.provider}`);
  } else {
    const path = room.speakerLang ? routePath(room.speakerLang, msg.lang) : 'pending-speaker';
    log.room(
      `#${ws.connId} joined "${room.id}" as LISTENER, wants ${lang(msg.lang)} ` +
        `[path: ${describePath(path)}] (${room.listeners.size} listener${room.listeners.size === 1 ? '' : 's'})`
    );
  }

  // One room per listener (best-effort, per browser): drop this client's other
  // listener sessions so a single browser only ever listens in one room.
  if (role === 'listener' && ws.clientId) {
    for (const old of listenerConnectionsForClient(ws.clientId, ws)) {
      sendControl(old, { type: 'evicted', message: 'You joined another room on this device.' });
      old.close();
      log.room(`#${ws.connId} evicted prior listener session #${old.connId} (same device)`);
    }
  }

  sendControl(ws, {
    type: 'joined',
    role,
    lang: msg.lang,
    room: room.id,
    speakerLang: room.speakerLang,
    live: room.live,
    provider: room.provider,
  });
  if (role === 'listener') {
    sendControl(ws, { type: 'audio-format', sampleRate: LISTENER_SAMPLE_RATE });
  }
  syncPipelines(room); // speaker may already be live when this listener joins
  notifyRoomState(room);
}

function doGoLive(ws) {
  if (!ws.meta || ws.meta.role !== 'speaker') {
    return sendControl(ws, { type: 'error', message: 'Only the speaker can go live' });
  }
  const room = getRoom(ws.meta.roomId);
  if (!room) return;
  room.live = true;
  log.room(`"${room.id}" GO LIVE — speaker streaming ${lang(room.speakerLang)}`);
  room._audioStats = { frames: 0, bytes: 0, since: Date.now() };
  syncPipelines(room);
  notifyRoomState(room);
}

function doSetLang(ws, msg) {
  if (!ws.meta || ws.meta.role !== 'listener') return;
  if (!VALID_LANGS.has(msg.lang)) {
    return sendControl(ws, { type: 'error', message: `Unsupported language: ${msg.lang}` });
  }
  const from = ws.meta.lang;
  ws.meta.lang = msg.lang;
  const room = getRoom(ws.meta.roomId);
  if (room) {
    const path = room.speakerLang ? routePath(room.speakerLang, msg.lang) : 'pending-speaker';
    log.room(
      `#${ws.connId} switched ${lang(from)} -> ${lang(msg.lang)} [path: ${describePath(path)}]`
    );
    syncPipelines(room);
    notifyRoomState(room);
  }
}

// Audio frames arrive ~10x/sec; log a rolled-up throughput line every ~5s
// instead of per-frame so the console stays readable during the demo.
const STATS_WINDOW_MS = 5000;

function handleAudioFrame(ws, frame) {
  if (!ws.meta || ws.meta.role !== 'speaker') return; // only speaker streams audio
  const room = getRoom(ws.meta.roomId);
  if (!room || !room.live) return;

  // Same-language listeners: raw relay (lowest latency).
  relaySameLang(room, frame);

  // Different-language listeners: feed each active translation pipeline.
  feedAudio(room, frame);

  const s = room._audioStats || (room._audioStats = { frames: 0, bytes: 0, since: Date.now() });
  s.frames += 1;
  s.bytes += frame.length ?? frame.byteLength ?? 0;
  const elapsed = Date.now() - s.since;
  if (elapsed >= STATS_WINDOW_MS) {
    const kbps = ((s.bytes / 1024 / elapsed) * 1000).toFixed(1);
    const pipes = room.pipelines?.size || 0;
    log.relay(
      `"${room.id}" speaker audio: ${s.frames} frames / ${(s.bytes / 1024).toFixed(0)}KB ` +
        `(${kbps} KB/s) in ${(elapsed / 1000).toFixed(0)}s · ${pipes} pipeline${pipes === 1 ? '' : 's'} active`
    );
    s.frames = 0;
    s.bytes = 0;
    s.since = Date.now();
  }
}

const PATH_DESC = {
  relay: 'raw relay, no AI',
  stt_translate: 'Saaras translate -> TTS',
  stt_transcribe_translate: 'Saaras transcribe -> text-translate -> TTS',
  'pending-speaker': 'waiting for speaker',
};
function describePath(path) {
  return PATH_DESC[path] || path;
}

// Dashboard deleted a room: notify and disconnect everyone, tear down pipelines.
export function closeRoomSockets(room, message) {
  destroyPipelines(room);
  const all = [room.speaker, ...room.listeners].filter(Boolean);
  for (const ws of all) {
    sendControl(ws, { type: 'room-closed', message: message || 'This room was closed.' });
    ws.close();
  }
  log.room(`"${room.id}" closed by host — ${all.length} connection(s) dropped`);
}

function notifyRoomState(room) {
  broadcastControl(room, {
    type: 'speaker-status',
    live: room.live,
    speakerLang: room.speakerLang,
    provider: room.provider,
  });
  const byLang = {};
  for (const [lang, set] of room.listenersByLang()) byLang[lang] = set.size;
  broadcastControl(room, { type: 'listener-count', count: room.listeners.size, byLang });
}
