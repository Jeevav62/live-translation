// Phase 3 verification — exercises the FULL English->Hindi routing path through
// the real pipeline code (no browser needed):
//
//   1. routePath() returns the right path for all 4 language pairs.
//   2. Synthesize English speech (Bulbul TTS) to use as fake "speaker audio".
//   3. Build a real room: English speaker + Hindi listener.
//   4. syncPipelines() must create exactly ONE en->hi pipeline.
//   5. Feed the English PCM in; the pipeline transcribes (Saaras) -> translates
//      text (REST) -> speaks Hindi (Bulbul) -> fans audio to the Hindi listener.
//   6. Assert the Hindi listener actually received PCM audio.
//
// Run: node scripts/phase3-test.mjs   (needs SARVAM_API_KEY in .env)

import 'dotenv/config';
import { createTTS } from '../src/pipeline/sarvamTTS.js';
import { routePath, syncPipelines, feedAudio, destroyPipelines } from '../src/pipeline/index.js';
import { getOrCreateRoom, joinAsSpeaker, joinAsListener } from '../src/rooms.js';
import { snapshot } from '../src/metrics.js';

const SR = 16000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('  PASS:', msg);
}

// A stand-in for a browser WebSocket: records the audio bytes "sent" to it.
function fakeWs(lang, role) {
  return {
    meta: { lang, role },
    readyState: 1, // OPEN
    received: 0,
    frames: 0,
    send(data) {
      if (typeof data !== 'string') {
        this.frames += 1;
        this.received += data.length ?? data.byteLength ?? 0;
      }
    },
  };
}

// Synthesize English speech into one PCM16 buffer to act as speaker mic audio.
function synthEnglish(text) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const tts = createTTS({
      apiKey: process.env.SARVAM_API_KEY,
      targetLang: 'en',
      sampleRate: SR,
      label: 'test-synth',
      onAudio: (pcm) => chunks.push(pcm),
      onError: reject,
    });
    tts.sendText(text);
    // Give Bulbul time to stream the full utterance back, then close.
    setTimeout(() => {
      tts.close();
      const buf = Buffer.concat(chunks);
      buf.length ? resolve(buf) : reject(new Error('no audio synthesized'));
    }, 6000);
  });
}

async function main() {
  console.log('\n=== routePath (all 4 cases) ===');
  assert(routePath('hi', 'hi') === 'relay', 'Hindi->Hindi  = relay');
  assert(routePath('en', 'en') === 'relay', 'English->English = relay');
  assert(routePath('hi', 'en') === 'stt_translate', 'Hindi->English = stt_translate');
  assert(
    routePath('en', 'hi') === 'stt_transcribe_translate',
    'English->Hindi = stt_transcribe_translate'
  );

  if (!process.env.SARVAM_API_KEY || process.env.SARVAM_API_KEY === 'PASTE_YOUR_KEY_HERE') {
    console.log('\nNo SARVAM_API_KEY — skipping live En->Hi pipeline test.');
    return;
  }

  console.log('\n=== synthesize English speaker audio ===');
  const englishText = 'Good morning everyone, welcome to the presentation. Today we will discuss our results.';
  const pcm = await synthEnglish(englishText);
  console.log(`  synthesized ${(pcm.length / 1024).toFixed(0)}KB PCM (~${(pcm.length / 2 / SR).toFixed(1)}s) for: "${englishText}"`);

  console.log('\n=== build room: English speaker + Hindi listener ===');
  const room = getOrCreateRoom('phase3-test');
  const speaker = fakeWs('en', 'speaker');
  const listener = fakeWs('hi', 'listener');
  joinAsSpeaker(room, speaker, 'en');
  joinAsListener(room, listener, 'hi');
  room.live = true;

  syncPipelines(room);
  assert(room.pipelines.size === 1, 'exactly ONE pipeline created');
  assert(room.pipelines.has('hi'), 'pipeline targets Hindi');
  assert(room.pipelines.get('hi').path === 'stt_transcribe_translate', 'pipeline uses transcribe->translate path');

  // A second Hindi listener must REUSE the same pipeline (the core optimization).
  const listener2 = fakeWs('hi', 'listener');
  joinAsListener(room, listener2, 'hi');
  syncPipelines(room);
  assert(room.pipelines.size === 1, 'second Hindi listener REUSES pipeline (still 1)');

  console.log('\n=== feed English audio through the pipeline ===');
  // Stream as ~100ms frames like the browser, then ~1.2s of silence so Saaras
  // VAD detects end-of-utterance and emits the transcript.
  const FRAME = SR * 0.1 * 2; // 100ms of PCM16 bytes
  for (let i = 0; i < pcm.length; i += FRAME) {
    feedAudio(room, pcm.subarray(i, i + FRAME));
    await sleep(40);
  }
  const silence = Buffer.alloc(FRAME);
  for (let i = 0; i < 12; i++) {
    feedAudio(room, silence);
    await sleep(40);
  }

  console.log('  waiting for transcript -> translate -> Hindi TTS ...');
  const deadline = Date.now() + 18000;
  while (listener.received === 0 && Date.now() < deadline) await sleep(250);

  console.log(`\n=== result ===`);
  assert(listener.received > 0, `Hindi listener received audio (${(listener.received / 1024).toFixed(0)}KB, ${listener.frames} frames)`);
  assert(listener2.received > 0, `2nd Hindi listener also received audio (${(listener2.received / 1024).toFixed(0)}KB) — fan-out works`);
  assert(speaker.received === 0, 'speaker received no audio back (correct)');

  console.log('\n=== metrics ===');
  const snap = snapshot();
  const key = 'phase3-test|en->hi';
  assert(snap[key], 'metrics recorded for en->hi');
  assert(snap[key].e2e_ms.count >= 1, `e2e latency captured (n=${snap[key].e2e_ms.count})`);
  assert(snap[key].tts_ms.count >= 1, 'tts latency captured');
  console.log('  snapshot:', JSON.stringify(snap[key], null, 2).replace(/\n/g, '\n  '));

  destroyPipelines(room);
  console.log('\nAll Phase 3 checks passed. ✅');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('\n' + e.message);
    process.exit(1);
  });
