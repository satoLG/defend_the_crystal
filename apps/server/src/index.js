import http from 'node:http';
import { Server } from 'socket.io';
import { attachHub } from './hub.js';

// ============================================================
// Defend the Crystal — authoritative multiplayer server.
//
// A plain HTTP server (for /health, used by Render's health check
// and the client's cold-start prewarm ping) with Socket.IO attached
// for the realtime game traffic. All gameplay logic lives in the
// shared Sim, driven per-room in room.js.
// ============================================================

const PORT = process.env.PORT || 3001;

// Which browser origins may open a socket. localhost (any port) and every
// *.vercel.app deploy (production + PR previews) are allowed by default;
// add exact extra origins via CLIENT_ORIGINS (comma-separated).
const EXTRA_ORIGINS = (process.env.CLIENT_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

function originAllowed(origin) {
  if (!origin) return true; // same-origin / non-browser clients (curl, health)
  if (EXTRA_ORIGINS.includes(origin)) return true;
  let host;
  try { host = new URL(origin).hostname; } catch { return false; }
  if (host === 'localhost' || host === '127.0.0.1') return true;
  if (host === 'vercel.app' || host.endsWith('.vercel.app')) return true;
  return false;
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
    res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
    res.end('ok');
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

const io = new Server(server, {
  cors: {
    origin: (origin, cb) => cb(originAllowed(origin) ? null : new Error('origin not allowed'), originAllowed(origin)),
    methods: ['GET', 'POST'],
  },
  // reconnect quickly after a flaky drop
  pingInterval: 20000,
  pingTimeout: 20000,
});

attachHub(io);

server.listen(PORT, () => {
  console.log(`[dtc-server] listening on :${PORT}`);
});
