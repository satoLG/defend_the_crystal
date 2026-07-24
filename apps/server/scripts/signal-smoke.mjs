// Server-side checks for the two non-gameplay things the socket now
// carries: the latency probe, and the WebRTC signalling relay that lets two
// players in a room negotiate a direct datachannel (see apps/web/src/p2p.js).
//
//   node scripts/signal-smoke.mjs
//
// The relay is deliberately dumb — it forwards an opaque payload — so what
// matters is that it forwards to the right socket and only within a room,
// and that it stamps the sender itself rather than trusting the message.
// Those are the properties a client cannot enforce, so they are tested here.
//
// Pure Node: no browser, no WebRTC. The payloads are stand-ins for SDP/ICE,
// which is exactly how the server treats them.
import { spawn } from 'node:child_process';
import { io } from 'socket.io-client';
import { EV } from '@dtc/shared/protocol.js';

const PORT = 3196;
const repoRoot = new URL('../../../', import.meta.url).pathname;

const server = spawn('node', ['apps/server/src/index.js'], {
  cwd: repoRoot,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => { if (String(d).includes('listening')) resolve(); });
  server.on('exit', (code) => reject(new Error(`server exited (${code})`)));
  setTimeout(() => reject(new Error('server start timeout')), 15000);
});

const URL_ = `http://localhost:${PORT}`;
const clients = [];

function connect() {
  const socket = io(URL_, { transports: ['websocket'], reconnection: false });
  clients.push(socket);
  return socket;
}

// resolve on the next occurrence of `event`, or reject after `ms`
function once(socket, event, ms = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), ms);
    socket.once(event, (data) => { clearTimeout(timer); resolve(data); });
  });
}

// resolve to false if `event` does NOT arrive within `ms` (the expected
// outcome when the relay correctly refuses to route somewhere)
function never(socket, event, ms = 1200) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    socket.once(event, (data) => { clearTimeout(timer); resolve(data); });
  });
}

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

let failed = null;
try {
  // ---- one room with two players, plus a second room ------------------
  const a1 = connect();
  a1.emit(EV.CREATE, { character: { name: 'A1', cls: 'tanker' } });
  const w1 = await once(a1, EV.WELCOME);
  assert(w1.selfId && w1.code, 'welcome missing identity');

  const a2 = connect();
  a2.emit(EV.JOIN, { code: w1.code, character: { name: 'A2', cls: 'archer' } });
  const w2 = await once(a2, EV.WELCOME);
  assert(w2.selfId !== w1.selfId, 'two players got the same id');

  const b1 = connect();
  b1.emit(EV.CREATE, { character: { name: 'B1', cls: 'mage' } });
  const wb = await once(b1, EV.WELCOME);
  assert(wb.code !== w1.code, 'second room reused the first room code');
  console.log(`✓ rooms ${w1.code} (2 players) and ${wb.code} (1 player)`);

  // ---- the latency probe echoes exactly what it was given --------------
  const stamp = Date.now();
  a1.emit(EV.PING, { t: stamp });
  const pong = await once(a1, EV.PONG);
  assert(pong?.t === stamp, `pong did not echo the timestamp (${JSON.stringify(pong)})`);
  console.log('✓ ping/pong echoes the client timestamp untouched');

  // ---- signalling reaches the intended peer, stamped with the sender ---
  const offer = { sdp: { type: 'offer', sdp: 'v=0 (stand-in)' } };
  const inbox = once(a2, EV.SIGNAL);
  a1.emit(EV.SIGNAL, { to: w2.selfId, data: offer });
  const got = await inbox;
  assert(got.from === w1.selfId, `expected from=${w1.selfId}, got ${got.from}`);
  assert(got.data?.sdp?.sdp === offer.sdp.sdp, 'payload was altered in transit');
  console.log('✓ signalling relayed to the target, stamped with the real sender');

  // the sender cannot forge who it is: `from` is set server-side, so a
  // spoofed field in the message must not survive
  const spoofInbox = once(a2, EV.SIGNAL);
  a1.emit(EV.SIGNAL, { to: w2.selfId, from: 'someone-else', data: { ice: 'x' } });
  const spoofed = await spoofInbox;
  assert(spoofed.from === w1.selfId, `sender id was spoofable (${spoofed.from})`);
  console.log('✓ a forged sender id is overwritten by the server');

  // ---- a room is a boundary -------------------------------------------
  // B1 is in another match; A1 must not be able to signal into it even
  // holding a valid player id.
  const leaked = await never(b1, EV.SIGNAL);
  assert(leaked === false, 'signal leaked into another room before we even aimed at it');
  const aimed = never(b1, EV.SIGNAL);
  a1.emit(EV.SIGNAL, { to: wb.selfId, data: { sdp: 'cross-room' } });
  assert((await aimed) === false, 'signal crossed a room boundary');
  console.log('✓ signalling cannot cross into another room');

  // ---- a bad target is ignored rather than fatal ------------------------
  a1.emit(EV.SIGNAL, { to: 'no-such-player', data: { ice: 'x' } });
  a1.emit(EV.SIGNAL, {});                       // no target at all
  a1.emit(EV.SIGNAL, null);                     // no message at all
  a1.emit(EV.SIGNAL, { to: w1.selfId, data: {} }); // aimed at itself
  const selfEcho = await never(a1, EV.SIGNAL);
  assert(selfEcho === false, 'server echoed a signal back to its sender');
  // the connection has to still work after all of that
  a1.emit(EV.PING, { t: 7 });
  assert((await once(a1, EV.PONG))?.t === 7, 'socket broke after malformed signals');
  console.log('✓ malformed / unroutable signals are ignored, socket survives');
} catch (err) {
  failed = err;
} finally {
  for (const c of clients) { try { c.close(); } catch { /* already closed */ } }
  server.kill('SIGKILL');
}

if (failed) { console.error('SIGNAL SMOKE FAILED:', failed.message); process.exit(1); }
console.log('SIGNAL SMOKE PASSED');
process.exit(0);
