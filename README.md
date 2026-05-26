# Live Translation — Real-Time Multilingual Audio for Presentation Rooms

Real-time speech translation for live presentations. A **speaker** talks in one
language; each **listener** hears it in the language *they* choose — with
interpreter-style latency. Each room is shareable via a link (QR code in
progress), with one speaker and any number of listeners.

- **Same language** (e.g. Hindi → Hindi): audio is relayed raw — no AI, lowest latency (~100–150ms).
- **Different language** (e.g. English → Hindi): `Speech-to-Text → (Translate) → Text-to-Speech`.
- **Top priorities:** accuracy and latency.

Powered by [Sarvam AI](https://www.sarvam.ai) (Saaras STT, Bulbul TTS, text-translate),
behind a provider-agnostic layer so other engines (e.g. Bhashini) can be swapped in later.

---

## How it works

The server is a thin **WebSocket relay**. Browsers capture mic audio, downsample
to 16kHz PCM16, and stream binary frames. The server fans audio out to listeners
and orchestrates translation pipelines.

**Core efficiency rule:** at most **one** translation pipeline runs per distinct
listener-language per room — its output is fanned out to *every* listener of that
language, regardless of how many there are. 100 Hindi listeners = 1 pipeline.

### Routing (4 cases)

| Speaker | Listener | Path |
|---------|----------|------|
| Hindi   | Hindi    | Raw WebSocket relay, no AI |
| English | English  | Raw WebSocket relay, no AI |
| Hindi   | English  | Saaras STT `translate` → Bulbul TTS |
| English | Hindi    | Saaras STT `transcribe` → text-translate → Bulbul TTS |

> Rule: a non-English Indic speaker → Saaras `translate` gives target English in
> one call. An English speaker → transcribe, then text-translate to the target.
> Every translated path ends at Bulbul TTS, so all listeners share one PCM16 player.

---

## Measured latency

Real numbers from a local English → Hindi demo (16 utterances, `GET /metrics`):

| Stage | What it measures | median (p50) | p95 |
|-------|------------------|-------------:|----:|
| STT | you stop talking → transcript | 455 ms | 1245 ms |
| Translate | English text → Hindi text | 172 ms | 367 ms |
| TTS | Hindi text → first audio chunk | 434 ms | 587 ms |
| **End-to-end** | **you stop talking → listener hears Hindi** | **1087 ms** | **1855 ms** |

Same-language relay is ~100–150ms. Numbers are from a single laptop (localhost);
real networks add ~100–300ms.

---

## Tech stack

| | |
|---|---|
| Backend | Node.js, `express` (static hosting), `ws` (WebSocket server) |
| STT | Sarvam Saaras v3 streaming WebSocket |
| Translate | Sarvam text-translate REST (English → Hindi) |
| TTS | Sarvam Bulbul v2 streaming WebSocket |
| Frontend | Plain HTML + JS, Web Audio API (capture / resample / playback) |
| State | In-memory room registry (no database) |
| Config | `.env` (`SARVAM_API_KEY`) via `dotenv` |

---

## Getting started

### Prerequisites
- Node.js 18+ (developed on v25)
- A Sarvam AI API key — sign up at [sarvam.ai](https://www.sarvam.ai) (₹1000 free credits)

### Setup
```bash
npm install
cp .env.example .env      # then paste your key into SARVAM_API_KEY
```

`.env`:
```
SARVAM_API_KEY=your_key_here
PORT=3000
```

### Run
```bash
npm start        # or: npm run dev  (auto-restart on file changes)
```

Open two tabs:
- **Speaker:**  http://localhost:3000/speaker.html?room=main
- **Listener:** http://localhost:3000/listener.html?room=main
- **Metrics:**  http://localhost:3000/metrics

Pick a language in each tab, **Go Live** on the speaker, **Listen** on the
listener. For translation, choose *different* languages in the two tabs.

> **On one machine, use headphones** on the listener tab — otherwise the speaker
> mic picks up the playback. Across separate devices this isn't an issue.

---

## Project structure

```
src/
  server.js              express + ws bootstrap, static hosting, /metrics
  rooms.js               in-memory room registry (1-speaker rule, listener sets)
  signaling.js           WebSocket protocol: join, go-live, lang switch, audio frames
  relay.js               same-language raw fan-out
  log.js                 tagged, timestamped console logger
  metrics.js             per-stage latency metrics + p50/p95 aggregates
  pipeline/
    index.js             routing + per-language pipeline lifecycle
    sarvamSTT.js         Saaras streaming STT client
    sarvamTranslate.js   text-translate REST client
    sarvamTTS.js         Bulbul streaming TTS client
    provider.js          provider-agnostic interface (Sarvam now, others later)
public/
  speaker.html / .js     mic capture → 16kHz PCM16 → WebSocket
  listener.html / .js    receive audio frames → jitter buffer → playback
  audio-utils.js         Float32 ↔ Int16, downsampling
  pcm-worklet.js         AudioWorklet mic capture
scripts/
  ws-test.mjs            relay smoke test (no API)
  sarvam-test.mjs        Sarvam STT/TTS round-trip self-test
  phase3-test.mjs        full English→Hindi pipeline + metrics verification
```

---

## Status / roadmap

- [x] **Phase 1** — Same-language relay end-to-end
- [x] **Phase 2** — Hindi → English translation pipeline
- [x] **Phase 3** — English → Hindi + full routing + latency metrics
- [ ] **Phase 4** — QR codes, multi-room landing page, listener-side latency readout, robustness
