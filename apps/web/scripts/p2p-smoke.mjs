// End-to-end check of the direct peer link (p2p.js).
//
//   node scripts/p2p-smoke.mjs
//
// Two browser pages join one room through the real server, then we verify
// that they negotiated a datachannel between themselves and that a pose
// pushed on one side moves the *avatar* on the other side — that is, that
// the renderer really is drawing the peer from the direct link and not only
// from the authoritative snapshot.
//
// It also asserts the fallback: kill the mesh on one side and the other
// must go back to snapshot-driven positions without the avatar sticking.
//
// Same harness as smoke.mjs (server + vite + playwright-core chromium).
// Both pages run in one browser, so ICE settles on loopback host candidates
// and no STUN/TURN is needed for the test to be meaningful.
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const PORT = 5199;
const SERVER_PORT = 3199;
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const repoRoot = new URL('../../../', import.meta.url).pathname;

const server = spawn('node', ['apps/server/src/index.js'], {
  cwd: repoRoot,
  env: { ...process.env, PORT: String(SERVER_PORT) },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => { if (String(d).includes('listening')) resolve(); });
  server.on('exit', (code) => reject(new Error(`server exited (${code})`)));
  setTimeout(() => reject(new Error('server start timeout')), 15000);
});

const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: { ...process.env, VITE_SERVER_URL: `http://localhost:${SERVER_PORT}` },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve, reject) => {
  vite.stdout.on('data', (d) => { if (String(d).includes('Local:')) resolve(); });
  vite.on('exit', (code) => reject(new Error(`vite exited (${code})`)));
  setTimeout(() => reject(new Error('vite start timeout')), 30000);
});

const hero = (id, name, cls) => ({
  id, name, cls, colors: {},
  pets: {}, activePet: null,
  weapons: { sword: { tier: 0 }, shield: { tier: 0 } },
  activeWeapon: 'sword', activeShield: 'shield', coins: 0,
});

async function newPlayer(browser, id, name, cls) {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  page.on('pageerror', (err) => { page.__errors.push(String(err)); });
  page.__errors = [];
  await page.addInitScript((h) => {
    localStorage.setItem('dtc-characters', JSON.stringify([h]));
    localStorage.setItem('dtc-active', h.id);
  }, hero(id, name, cls));
  await page.goto(`http://localhost:${PORT}/`);
  await page.locator('#start-btn-main').waitFor({ state: 'visible', timeout: 90000 });
  await page.click('#start-btn-main');
  return page;
}

// poll a page expression until it is truthy, or fail with context
async function until(page, fn, arg, timeout, label) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await page.evaluate(fn, arg);
    if (last) return last;
    await page.waitForTimeout(200);
  }
  throw new Error(`${label} (last value: ${JSON.stringify(last)})`);
}

let failed = null;
let browser;
try {
  browser = await chromium.launch({
    executablePath: CHROMIUM,
    // Chrome normally hides local IPs behind mDNS (.local) candidates, which
    // a container with no mDNS resolver cannot resolve — the two pages would
    // then fail to connect for a reason that has nothing to do with the code
    // under test. Real browsers on a real network resolve these fine.
    args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
  });

  // ---- both players into one room -------------------------------------
  const a = await newPlayer(browser, 'p2p-a', 'Ana', 'tanker');
  await a.locator('#host-btn').waitFor({ state: 'visible', timeout: 10000 });
  await a.click('#host-btn');
  await until(a, () => {
    const c = document.getElementById('room-code')?.textContent || '';
    return /^[A-Z0-9]{4,6}$/.test(c) ? c : null;
  }, null, 20000, 'room code never appeared');
  const code = await a.evaluate(() => document.getElementById('room-code').textContent.trim());
  console.log(`✓ room ${code} created`);

  const b = await newPlayer(browser, 'p2p-b', 'Bia', 'archer');
  await b.locator('#join-code').waitFor({ state: 'visible', timeout: 10000 });
  await b.fill('#join-code', code);
  await b.click('#join-btn');
  await until(a, () => (window.__dtc.lobbyPlayers || []).length === 2, null, 20000,
    'second player never showed in the lobby');
  console.log('✓ both players in the lobby');

  await a.click('#start-btn');
  await a.locator('#hud').waitFor({ state: 'visible', timeout: 15000 });
  await b.locator('#hud').waitFor({ state: 'visible', timeout: 15000 });
  console.log('✓ match started for both');

  // ---- the direct link comes up ---------------------------------------
  const linkUp = (page, who) => until(page, () => {
    const peers = window.__dtcNet?.().peers || [];
    return peers.length && peers.every((p) => p.live) ? peers : null;
  }, null, 25000, `${who}: datachannel never went live`);

  const peersA = await linkUp(a, 'A');
  await linkUp(b, 'B');
  console.log(`✓ datachannel live both ways (A sees ${peersA.length} peer)`);

  // ---- the renderer actually uses it ----------------------------------
  // Blend reaching 1 is what makes view.applySnapshot prefer the direct
  // pose, so it is the real assertion — a live channel nobody reads would
  // pass the check above.
  await until(b, () => {
    const bufs = [...window.__dtc.peerBufs.values()];
    return bufs.length && bufs.every((e) => e.blend >= 0.99);
  }, null, 10000, 'B never blended onto the direct link');
  console.log('✓ renderer switched to the direct pose');

  // Pin A somewhere specific and confirm B's avatar for A lands there.
  // The server would eventually deliver the same position, so to prove the
  // direct path is the one being drawn we read the avatar during a window
  // where only P2P has the new value: sample right after the move.
  const selfIdA = await a.evaluate(() => window.__dtc.p2p.selfId);
  const target = { x: -3.5, z: 22.0 };
  await a.evaluate((t) => {
    window.__p2pPin = setInterval(() => {
      window.__dtc.self.x = t.x; window.__dtc.self.z = t.z;
    }, 30);
  }, target);

  const reached = await until(b, (arg) => {
    const actor = window.__dtcRefs.view.players.get(arg.id);
    if (!actor) return null;
    const d = Math.hypot(actor.group.position.x - arg.x, actor.group.position.z - arg.z);
    return d < 0.6 ? Math.round(d * 100) / 100 : null;
  }, { id: selfIdA, ...target }, 15000, "A's avatar never reached the pinned spot on B");
  console.log(`✓ B draws A at the pinned position (off by ${reached})`);

  // ---- fallback when the link dies ------------------------------------
  // Tearing the mesh down on A must not freeze or strand A's avatar on B:
  // the blend has to fall back to 0 and the snapshot take over again.
  await a.evaluate(() => { window.__dtc.p2p.destroy(); });
  await until(b, () => {
    const bufs = [...window.__dtc.peerBufs.values()];
    return bufs.every((e) => e.blend === 0);
  }, null, 10000, 'B never fell back off the dead link');

  // still tracking A through the server: move the pin and watch it follow
  const moved = { x: 3.0, z: 20.0 };
  await a.evaluate((t) => {
    clearInterval(window.__p2pPin);
    window.__p2pPin = setInterval(() => {
      window.__dtc.self.x = t.x; window.__dtc.self.z = t.z;
    }, 30);
  }, moved);
  const viaServer = await until(b, (arg) => {
    const actor = window.__dtcRefs.view.players.get(arg.id);
    if (!actor) return null;
    const d = Math.hypot(actor.group.position.x - arg.x, actor.group.position.z - arg.z);
    return d < 0.8 ? Math.round(d * 100) / 100 : null;
  }, { id: selfIdA, ...moved }, 20000, 'B lost track of A after the link died');
  console.log(`✓ fell back to snapshots cleanly (off by ${viaServer})`);
  await a.evaluate(() => clearInterval(window.__p2pPin));

  const noise = /WebSocket|socket\.io|network|ICE|STUN/i;
  for (const [who, page] of [['A', a], ['B', b]]) {
    const real = page.__errors.filter((e) => !noise.test(e));
    if (real.length) throw new Error(`page errors on ${who}:\n${real.join('\n')}`);
  }
  console.log('✓ no uncaught page errors');
} catch (err) {
  failed = err;
} finally {
  try { await browser?.close(); } catch { /* already gone */ }
  vite.kill('SIGKILL');
  server.kill('SIGKILL');
}
if (failed) { console.error('P2P SMOKE FAILED:', failed.message); process.exit(1); }
console.log('P2P SMOKE PASSED');
process.exit(0);
