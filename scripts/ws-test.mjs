// Throwaway end-to-end test of the WS room/relay protocol (no browser/audio).
import WebSocket from 'ws';

const URL = 'ws://localhost:3000/ws';
const results = [];
const log = (ok, name) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}`); };

function client() {
  const ws = new WebSocket(URL);
  ws.binaryType = 'arraybuffer';
  ws.controls = [];
  ws.binaries = [];
  ws.on('message', (data, isBinary) => {
    if (isBinary) ws.binaries.push(data);
    else ws.controls.push(JSON.parse(data.toString()));
  });
  return ws;
}
const open = (ws) => new Promise((r) => ws.on('open', r));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  // Speaker joins (hi) + go live
  const speaker = client();
  await open(speaker);
  speaker.send(JSON.stringify({ type: 'join', room: 't1', role: 'speaker', lang: 'hi' }));
  await wait(100);
  speaker.send(JSON.stringify({ type: 'go-live' }));
  await wait(100);
  log(speaker.controls.some((m) => m.type === 'joined'), 'speaker receives joined');

  // Second speaker rejected
  const speaker2 = client();
  await open(speaker2);
  speaker2.send(JSON.stringify({ type: 'join', room: 't1', role: 'speaker', lang: 'hi' }));
  await wait(100);
  log(speaker2.controls.some((m) => m.type === 'error'), 'second speaker rejected');

  // Listener same lang (hi) + listener diff lang (en)
  const hiListener = client();
  const enListener = client();
  await open(hiListener); await open(enListener);
  hiListener.send(JSON.stringify({ type: 'join', room: 't1', role: 'listener', lang: 'hi' }));
  enListener.send(JSON.stringify({ type: 'join', room: 't1', role: 'listener', lang: 'en' }));
  await wait(150);

  // Speaker sends a binary audio frame
  const frame = new Int16Array([1, 2, 3, 4, 5]);
  speaker.send(frame.buffer);
  await wait(200);

  log(hiListener.binaries.length === 1, 'same-lang listener receives relayed audio');
  log(enListener.binaries.length === 0, 'diff-lang listener does NOT receive raw relay (Phase 1)');
  log(speaker.controls.some((m) => m.type === 'listener-count' && m.count >= 1), 'listener-count broadcast');

  [speaker, speaker2, hiListener, enListener].forEach((w) => w.close());
  await wait(100);

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
}
run();
