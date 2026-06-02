# Live Translation — Real-Time Multilingual Audio for Presentation Rooms

Real-time speech translation for live presentations. A **speaker** talks in one
language; each **listener** hears it in the language *they* choose — with
interpreter-style latency. Each room has **one QR code that everyone scans** —
speaker and audience alike — then each person picks their role and language.
One speaker per room, unlimited listeners.

- **Same language** (e.g. Hindi → Hindi): audio is relayed raw — no AI, lowest latency (~100–150ms).
- **Different language** (e.g. English → Hindi): `Speech-to-Text → (Translate) → Text-to-Speech`.
- **Top priorities:** accuracy and latency.

Powered by [Sarvam AI](https://www.sarvam.ai) (Saaras STT, Bulbul TTS, text-translate),
behind a provider-agnostic layer. The **speaker can pick the translation engine per room**:
**Sarvam** (STT → translate → TTS) or **OpenAI `gpt-realtime-translate`** (one speech-to-speech
socket that streams translation while you talk). The GPT option appears only when an
`OPENAI_API_KEY` is configured.

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

Open http://localhost:3000 — the **room dashboard**. Click **Create** to mint a
room (unique code + QR); you're taken to its QR screen (`host.html`). Everyone
scans the same QR → `join.html` → pick **Speaker** or **Listener** + a language.
Rename or delete rooms from the dashboard; deleting disconnects everyone in it.
A listener is kept to **one room per browser** (joining another evicts the first).

For quick local testing you can also jump straight in:

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
  index.html             room dashboard: create / list / rename / delete + per-room QR
  host.html              projector screen: one room QR everyone scans
  join.html              role picker after scan (Speaker / Listener + language)
  speaker.html / .js     mic capture → 16kHz PCM16 → WebSocket
  listener.html / .js    receive audio frames → jitter buffer → playback
  app.css                shared stylesheet for all pages
  audio-utils.js         Float32 ↔ Int16, downsampling
  pcm-worklet.js         AudioWorklet mic capture
scripts/
  ws-test.mjs            relay smoke test (no API)
  sarvam-test.mjs        Sarvam STT/TTS round-trip self-test
  phase3-test.mjs        full English→Hindi pipeline + metrics + cost verification
  multiroom-test.mjs     multi-room isolation + QR endpoint verification
```

---

## Observability

| Endpoint | What it gives you |
|----------|-------------------|
| `GET /health` | liveness check (`{ ok, uptime }`) |
| `GET /metrics` | per-stage latency aggregates (avg / p50 / p95 / min / max) per room+language (in-memory, current process) |
| `GET /metrics/history` | durable latency aggregates from `logs/latency.jsonl` — survives restarts; groups by direction and by lab combo |
| `GET /cost` | exact billable usage (STT seconds, TTS/translate chars) × configurable rates |

### Provider Lab (`/lab.html`)

An experiment page to **mix and match providers** — pick a STT, Translator, and TTS
independently, speak, and hear the result looped back with **per-stage latency** shown live.
Use it to find the lowest-latency combo that still sounds good in Hindi, then wire the winner
into the main rooms. Providers appear once their key is set in `.env`:

- **STT:** Sarvam Saaras · Deepgram Nova-3 · ElevenLabs Scribe v2
- **Translate:** Sarvam
- **TTS:** Sarvam Bulbul · Cartesia Sonic · ElevenLabs Flash v2.5

Every lab run is logged to `logs/latency.jsonl`; compare combos at `/metrics/history`.

Cost rates are placeholders — set the real Sarvam values via env (no redeploy):
`SARVAM_STT_RATE_PER_MIN`, `SARVAM_TTS_RATE_PER_1K_CHARS`, `SARVAM_TRANSLATE_RATE_PER_1K_CHARS`, `SARVAM_CURRENCY`.

---

## Deployment (Easypanel / Docker)

The repo ships a `Dockerfile`. HTTPS is **required** in production (browsers block
microphone access without it) — the client auto-uses `wss://` when served over HTTPS.

**On Easypanel:**
1. Create an app from this GitHub repo, branch `phase-4-qr-multiroom` (or your deploy branch).
2. Build method: **Dockerfile**. App port: **3000**.
3. Add environment variables:
   - `SARVAM_API_KEY` = your key (required for translation; the repo never contains it)
   - optionally the `SARVAM_*_RATE_*` cost vars above
4. Attach your domain — Easypanel provisions HTTPS automatically. WebSockets pass
   through its proxy by default; the app's 30s heartbeat keeps them alive.
5. Open the domain → **Host a room** → share the QR with your audience.

---

## Status / roadmap

- [x] **Phase 1** — Same-language relay end-to-end
- [x] **Phase 2** — Hindi → English translation pipeline
- [x] **Phase 3** — English → Hindi + full routing + latency metrics
- [x] **Phase 4** — QR codes, multi-room landing page, listener-side latency readout, mid-session language switching
