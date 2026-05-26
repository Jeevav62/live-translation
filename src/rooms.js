// In-memory room registry. One speaker per room, unbounded listeners.
// No DB — state lives for the process lifetime.

const rooms = new Map(); // roomId -> Room

export class Room {
  constructor(id) {
    this.id = id;
    this.speaker = null; // ws of the speaker, or null
    this.speakerLang = null; // 'hi' | 'en'
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

export function getOrCreateRoom(id) {
  let room = rooms.get(id);
  if (!room) {
    room = new Room(id);
    rooms.set(id, room);
  }
  return room;
}

export function getRoom(id) {
  return rooms.get(id);
}

// Returns { ok, error } — rejects a second speaker.
export function joinAsSpeaker(room, ws, lang) {
  if (room.speaker && room.speaker !== ws && room.speaker.readyState === 1) {
    return { ok: false, error: 'Room already has a speaker' };
  }
  ws.meta = { role: 'speaker', lang, roomId: room.id };
  room.speaker = ws;
  room.speakerLang = lang;
  return { ok: true };
}

export function joinAsListener(room, ws, lang) {
  ws.meta = { role: 'listener', lang, roomId: room.id };
  room.listeners.add(ws);
  return { ok: true };
}

// Remove a ws from whatever room it's in. Returns the affected room (or null).
export function leave(ws) {
  if (!ws.meta) return null;
  const room = rooms.get(ws.meta.roomId);
  if (!room) return null;

  if (ws.meta.role === 'speaker' && room.speaker === ws) {
    room.speaker = null;
    room.live = false;
  } else {
    room.listeners.delete(ws);
  }

  if (room.isEmpty()) rooms.delete(room.id);
  return room;
}

export function listRooms() {
  return [...rooms.values()].map((r) => ({
    id: r.id,
    speakerLang: r.speakerLang,
    live: r.live,
    listeners: r.listeners.size,
  }));
}
