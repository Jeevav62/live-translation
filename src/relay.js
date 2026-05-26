// Same-language audio fan-out. Raw speaker PCM is forwarded untouched to every
// listener who wants the SAME language as the speaker. No AI, lowest latency.

const OPEN = 1; // ws.readyState OPEN

// Forward a binary audio frame from the speaker to same-language listeners.
export function relaySameLang(room, frame) {
  if (!room.speakerLang) return;
  for (const ws of room.listeners) {
    if (ws.meta.lang === room.speakerLang && ws.readyState === OPEN) {
      ws.send(frame);
    }
  }
}

// Send a binary audio frame to all listeners who want a specific language.
// Used by translation pipelines to fan their output to one language group.
export function sendToLang(room, lang, frame) {
  for (const ws of room.listeners) {
    if (ws.meta.lang === lang && ws.readyState === OPEN) {
      ws.send(frame);
    }
  }
}

// Broadcast a JSON control message to everyone in the room (speaker + listeners).
export function broadcastControl(room, obj) {
  const msg = JSON.stringify(obj);
  if (room.speaker && room.speaker.readyState === OPEN) room.speaker.send(msg);
  for (const ws of room.listeners) {
    if (ws.readyState === OPEN) ws.send(msg);
  }
}

// Send a JSON control message to a single connection.
export function sendControl(ws, obj) {
  if (ws.readyState === OPEN) ws.send(JSON.stringify(obj));
}
