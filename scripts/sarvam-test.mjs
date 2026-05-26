// Live Sarvam validation (no mic needed):
//   1) Bulbul TTS: Hindi text -> PCM16 @16k  (saved to scripts/out-hindi.wav)
//   2) Saaras STT translate mode: that PCM -> English text
// Exercises both WS protocols and the full Hindi->English pipeline path.
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createTTS } from '../src/pipeline/sarvamTTS.js';
import { createSTT } from '../src/pipeline/sarvamSTT.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const key = process.env.SARVAM_API_KEY;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function wavHeader(dataLen, rate) {
  const b = Buffer.alloc(44);
  b.write('RIFF', 0); b.writeUInt32LE(36 + dataLen, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(dataLen, 40);
  return b;
}

async function main() {
  if (!key || key === 'PASTE_YOUR_KEY_HERE') { console.error('No SARVAM_API_KEY'); process.exit(1); }

  // --- 1) TTS Hindi ---
  console.log('1) TTS: synthesizing Hindi...');
  const chunks = [];
  let ttsErr = null;
  const tts = createTTS({
    apiKey: key, targetLang: 'hi', sampleRate: 16000,
    onAudio: (pcm) => chunks.push(pcm),
    onError: (e) => { ttsErr = e; console.error('   TTS error:', e.message); },
  });
  tts.sendText('नमस्ते, यह एक छोटा परीक्षण है। आज मौसम बहुत अच्छा है।');
  await wait(9000);
  tts.close();

  const pcm = Buffer.concat(chunks);
  console.log(`   TTS PCM bytes: ${pcm.length}${ttsErr ? ' (with error)' : ''}`);
  if (pcm.length === 0) { console.error('   FAIL: no audio from TTS'); process.exit(1); }
  const wavPath = join(__dirname, 'out-hindi.wav');
  writeFileSync(wavPath, Buffer.concat([wavHeader(pcm.length, 16000), pcm]));
  console.log(`   Saved ${wavPath} (play it to verify Hindi speech)`);

  // --- 2) STT translate (Hindi PCM -> English text) ---
  console.log('2) STT translate: feeding Hindi PCM back in...');
  let transcript = '';
  const stt = createSTT({
    apiKey: key, mode: 'translate', sampleRate: 16000,
    onTranscript: (t) => { transcript += ' ' + t; console.log('   STT:', t); },
    onError: (e) => console.error('   STT error:', e.message),
  });
  const CHUNK = 3200; // 1600 samples = 100ms @16k
  for (let i = 0; i < pcm.length; i += CHUNK) {
    stt.sendAudio(pcm.subarray(i, i + CHUNK));
    await wait(80);
  }
  stt.flush();
  await wait(6000);
  stt.close();

  console.log('\nFinal English transcript (expect ~"Hello, this is a small test. The weather is very nice today."):');
  console.log('  >', transcript.trim() || '(empty)');
  process.exit(transcript.trim() ? 0 : 2);
}
main();
