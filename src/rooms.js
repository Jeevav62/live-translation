// In-memory room registry. One speaker per room, unbounded listeners.
//
// `roomStore` is the single seam for persistence. Today it's an in-memory Map;
// to make rooms survive a server restart later, swap its guts for a JSON file
// or SQLite/Postgres WITHOUT touching any caller. Only room METADATA (id, name,
// managed, createdAt) would ever be persisted — live sockets and pipelines
// always stay in this process's memory and rebuild when clients reconnect.
// See memory/db-plan.md for the full plan.

const roomStore = {
  _rooms: new Map(), // id -> Room
  get: (id) => roomStore._rooms.get(id),
  has: (id) => roomStore._rooms.has(id),
  set: (room) => roomStore._rooms.set(room.id, room),
  delete: (id) => roomStore._rooms.delete(id),
  all: () => [...roomStore._rooms.values()],
};

// Readable, unambiguous ids (no 0/o/1/l/i). Must match the client alphabet.
const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
function genId() {
  let id = '';
  for (let i = 0; i < 6; i++) id += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  return id;
}
function uniqueId() {
  let id = genId();
  while (roomStore.has(id)) id = genId(); // guarantee no repetition
  return id;
}

export class Room {
  constructor(id) {
    this.id = id;
    this.name = id; // human label, editable; defaults to the id
    this.managed = false; // created from the dashboard -> not auto-deleted when empty
    this.createdAt = Date.now();
    this.speaker = null; // ws of the speaker, or null
    this.speakerLang = null; // 'hi' | 'en'
    this.provider = 'sarvam'; // translation engine the speaker chose: 'sarvam' | 'openai'
    this.live = false; // speaker has started streaming
    this.listeners = new Set(); // Set<ws>
  }

  // Listeners grouped by the language they want to HEAR.
  listenersByLang() {
    const groups = new Map();
    for (const ws of this.listeners) {
      const lang = ws.meta.lang;
      if (!groups.has(lang)) groups.set(lang, new Set());
      groups.get(lang).add(ws);
    }
    return groups;
  }

  // Distinct listener languages that differ from the speaker (need translation).
  translatedLangs() {
    const langs = new Set();
    for (const ws of this.listeners) {
      if (ws.meta.lang !== this.speakerLang) langs.add(ws.meta.lang);
    }
    return langs;
  }

  isEmpty() {
    return !this.speaker && this.listeners.size === 0;
  }
}

// Dashboard: create a named room with a fresh unique id. Persists (managed) so
// it stays listed even with nobody connected yet.
export function createRoom(name) {
  const room = new Room(uniqueId());
  const trimmed = (name || '').trim();
  if (trimmed) room.name = trimmed;
  room.managed = true;
  roomStore.set(room);
  return room;
}

export function renameRoom(id, name) {
  const room = roomStore.get(id);
  if (!room) return null;
  const trimmed = (name || '').trim();
  if (trimmed) room.name = trimmed;
  return room;
}

// Remove a room outright (dashboard delete). Caller is responsible for closing
// any live sockets and tearing down pipelines.
export function deleteRoom(id) {
  const room = roomStore.get(id);
  roomStore.delete(id);
  return room || null;
}

export function getOrCreateRoom(id) {
  let room = roomStore.get(id);
  if (!room) {
    room = new Room(id); // ad-hoc room (direct link); not managed -> auto-cleans when empty
    roomStore.set(room);
  }
  return room;
}

export function getRoom(id) {
  return roomStore.get(id);
}

// Returns { ok, error } — rejects a second speaker, but lets the SAME browser
// (clientId) take over its own stale socket so a speaker refresh/reconnect is
// seamless instead of being rejected as "room already has a speaker".
export function joinAsSpeaker(room, ws, lang) {
  if (room.speaker && room.speaker !== ws && room.speaker.readyState === 1) {
    if (ws.clientId && room.speaker.clientId === ws.clientId) {
      try { room.speaker.close(); } catch {} // drop the old tab/socket of the same speaker
    } else {
      return { ok: false, error: 'Room already has a speaker' };
    }
  }
  ws.meta = { ...ws.meta, role: 'speaker', lang, roomId: room.id };
  room.speaker = ws;
  room.speakerLang = lang;
  return { ok: true };
}

export function joinAsListener(room, ws, lang) {
  ws.meta = { ...ws.meta, role: 'listener', lang, roomId: room.id };
  room.listeners.add(ws);
  return { ok: true };
}

// One-room-per-listener (best-effort, by browser clientId): every listener
// connection currently held by this client, across all rooms. The caller evicts
// the stale ones so a single browser is only ever listening in one room.
export function listenerConnectionsForClient(clientId, exceptWs) {
  const found = [];
  if (!clientId) return found;
  for (const room of roomStore.all()) {
    for (const ws of room.listeners) {
      if (ws !== exceptWs && ws.clientId === clientId) found.push(ws);
    }
  }
  return found;
}

// Remove a ws from whatever room it's in. Returns the affected room (or null).
// Managed (dashboard) rooms are kept even when empty; ad-hoc rooms are dropped.
export function leave(ws) {
  if (!ws.meta) return null;
  const room = roomStore.get(ws.meta.roomId);
  if (!room) return null;

  if (ws.meta.role === 'speaker' && room.speaker === ws) {
    room.speaker = null;
    room.live = false;
  } else {
    room.listeners.delete(ws);
  }

  if (room.isEmpty() && !room.managed) roomStore.delete(room.id);
  return room;
}

export function listRooms() {
  return roomStore.all().map((r) => ({
    id: r.id,
    name: r.name,
    managed: r.managed,
    createdAt: r.createdAt,
    speakerLang: r.speakerLang,
    provider: r.provider,
    live: r.live,
    listeners: r.listeners.size,
  }));
}
