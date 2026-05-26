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
import { log } from './log.js';

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
    default:
      sendControl(ws, { type: 'error', message: `Unknown message type: ${msg.type}` });
  }
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
    log.room(`#${ws.connId} joined "${room.id}" as SPEAKER, speaking ${lang(msg.lang)}`);
  } else {
    const path = room.speakerLang ? routePath(room.speakerLang, msg.lang) : 'pending-speaker';
    log.room(
      `#${ws.connId} joined "${room.id}" as LISTENER, wants ${lang(msg.lang)} ` +
        `[path: ${describePath(path)}] (${room.listeners.size} listener${room.listeners.size === 1 ? '' : 's'})`
    );
  }

  sendControl(ws, {
    type: 'joined',
    role,
    lang: msg.lang,
    room: room.id,
    speakerLang: room.speakerLang,
    live: room.live,
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

function notifyRoomState(room) {
  broadcastControl(room, {
    type: 'speaker-status',
    live: room.live,
    speakerLang: room.speakerLang,
  });
  broadcastControl(room, { type: 'listener-count', count: room.listeners.size });
}
