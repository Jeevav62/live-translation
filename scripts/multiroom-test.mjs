// Phase 4 verification — multi-room isolation + QR endpoint (no browser/audio).
// Proves that audio in one room never leaks into another, and that the QR
// endpoint serves a PNG. Requires the server running on :3000.
import WebSocket from 'ws';

const WS_URL = 'ws://localhost:3000/ws';
const HTTP = 'http://localhost:3000';
const results = [];
const log = (ok, name) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}`); };

function client() {
  const ws = new WebSocket(WS_URL);
  ws.binaryType = 'arraybuffer';
  ws.binaries = [];
  ws.on('message', (data, isBinary) => { if (isBinary) ws.binaries.push(data); });
  return ws;
}
const open = (ws) => new Promise((r) => ws.on('open', r));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const join = (ws, room, role, lang) =>
  ws.send(JSON.stringify({ type: 'join', room, role, lang }));

async function run() {
  // Two independent rooms, same language (hi) so relay fires without any AI.
  const spkA = client();
  const lisA = client();
  const spkB = client();
  const lisB = client();
  await Promise.all([open(spkA), open(lisA), open(spkB), open(lisB)]);

  join(spkA, 'roomA', 'speaker', 'hi');
  join(lisA, 'roomA', 'listener', 'hi');
  join(spkB, 'roomB', 'speaker', 'hi');
  join(lisB, 'roomB', 'listener', 'hi');
  await wait(150);

  spkA.send(JSON.stringify({ type: 'go-live' }));
  spkB.send(JSON.stringify({ type: 'go-live' }));
  await wait(100);

  // Speaker A talks; only room A's listener should hear it.
  spkA.send(new Int16Array([10, 20, 30]).buffer);
  await wait(200);

  log(lisA.binaries.length === 1, 'room A listener hears room A speaker');
  log(lisB.binaries.length === 0, 'room B listener does NOT hear room A speaker (isolated)');

  // Now speaker B talks; only room B's listener should hear it.
  spkB.send(new Int16Array([40, 50, 60]).buffer);
  await wait(200);

  log(lisB.binaries.length === 1, 'room B listener hears room B speaker');
  log(lisA.binaries.length === 1, 'room A listener unaffected by room B (still 1 frame)');

  // QR endpoint returns a PNG.
  const res = await fetch(`${HTTP}/api/qr?data=${encodeURIComponent(HTTP + '/listener.html?room=roomA')}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  log(res.status === 200 && isPng, `QR endpoint returns a PNG (${buf.length} bytes)`);

  [spkA, lisA, spkB, lisB].forEach((w) => w.close());
  await wait(100);

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
}
run();
