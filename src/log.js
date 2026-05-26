// One tagged, timestamped logger so every module's output reads the same while
// running the demo. Colors degrade gracefully (plain text) on terminals that
// don't grok ANSI. Keep audio-frame logging OUT of hot paths — log lifecycle
// events, transcripts, translations and latency, not every 100ms chunk.

const C = {
  reset: '\x1b[0m',
  gray: '\x1b[90m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

const ts = () => new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm

function emit(stream, color, scope, msg) {
  stream(`${C.gray}${ts()}${C.reset} ${color}${scope.padEnd(18)}${C.reset} ${msg}`);
}

export const log = {
  conn: (m) => emit(console.log, C.blue, 'conn', m),
  room: (m) => emit(console.log, C.cyan, 'room', m),
  relay: (m) => emit(console.log, C.dim + C.gray, 'relay', m),
  pipe: (scope, m) => emit(console.log, C.magenta, `pipe ${scope}`, m),
  stt: (scope, m) => emit(console.log, C.green, `stt ${scope}`, m),
  xlate: (scope, m) => emit(console.log, C.yellow, `xlate ${scope}`, m),
  tts: (scope, m) => emit(console.log, C.cyan, `tts ${scope}`, m),
  metric: (scope, m) => emit(console.log, C.green + '\x1b[1m', `metric ${scope}`, m),
  warn: (m) => emit(console.warn, C.yellow, 'warn', m),
  error: (m) => emit(console.error, C.red, 'error', m),
  info: (m) => emit(console.log, C.reset, 'server', m),
};
