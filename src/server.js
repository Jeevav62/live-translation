import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import http from 'node:http';
import express from 'express';
import { WebSocketServer } from 'ws';
import { handleConnection } from './signaling.js';
import { log } from './log.js';
import { snapshot } from './metrics.js';
import { costSnapshot } from './cost.js';
import { qrPng } from './qr.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();

// Health check for the platform/proxy (Easypanel, Traefik, etc.).
app.get('/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.use(express.static(join(__dirname, '..', 'public')));

// Live latency aggregates (avg/p50/p95/min/max per room+language) for the
// translated path. Handy during the demo: open in a tab or curl it.
app.get('/metrics', (_req, res) => res.json(snapshot()));

// Estimated Sarvam cost: exact usage (audio seconds / chars) x configurable rates.
app.get('/cost', (_req, res) => res.json(costSnapshot()));

// QR code (PNG) for a room join link. e.g. /api/qr?data=https://host/listener.html?room=abc123
app.get('/api/qr', async (req, res) => {
  const data = req.query.data;
  if (!data || typeof data !== 'string') return res.status(400).send('missing ?data=');
  try {
    const png = await qrPng(data);
    res.type('png').set('Cache-Control', 'no-store').send(png);
  } catch (e) {
    log.error(`qr: ${e.message}`);
    res.status(500).send('qr generation failed');
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', handleConnection);

// Heartbeat: drop dead sockets so rooms don't keep ghost connections.
const HEARTBEAT_MS = 30000;
const interval = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);
wss.on('close', () => clearInterval(interval));

const keyState = process.env.SARVAM_API_KEY && process.env.SARVAM_API_KEY !== 'PASTE_YOUR_KEY_HERE'
  ? 'loaded'
  : 'MISSING (translation disabled — relay still works)';

server.listen(PORT, () => {
  log.info(`listening on http://localhost:${PORT}`);
  log.info(`Sarvam API key: ${keyState}`);
  log.info(`Speaker:  http://localhost:${PORT}/speaker.html?room=main`);
  log.info(`Listener: http://localhost:${PORT}/listener.html?room=main`);
  log.info(`Metrics:  http://localhost:${PORT}/metrics`);
  log.info(`Cost:     http://localhost:${PORT}/cost`);
});
