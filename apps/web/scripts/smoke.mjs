// Minimal end-to-end smoke test (kept deliberately small):
//   boot → menu → create room → start match → HUD up → walk to Baru's smithy
//   → weapon panel opens with cards → no uncaught page errors.
//
//   node scripts/smoke.mjs
//
// Spawns the authoritative server (apps/server) AND the Vite dev server, and
// points the client at the local server via VITE_SERVER_URL.
//
// Needs a chromium for playwright-core; set CHROMIUM_PATH to override
// the default /opt/pw-browsers/chromium. Writes debug screenshots to
// the directory given in SMOKE_SHOTS_DIR (skipped when unset).
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const PORT = 5198;
const SERVER_PORT = 3198;
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const SHOTS = process.env.SMOKE_SHOTS_DIR || '';
const repoRoot = new URL('../../../', import.meta.url).pathname;

// 1) authoritative game server
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

// 2) Vite dev server, told which server the client should connect to
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

let failed = null;
try {
  const browser = await chromium.launch({ executablePath: CHROMIUM });
  const page = await browser.newPage({ viewport: { width: 900, height: 720 } });
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));

  // seed a saved hero so the flow skips character creation
  await page.addInitScript(() => {
    const hero = {
      id: 'smoke1', name: 'Testy', cls: 'tanker', colors: {},
      pets: { dog: { lvl: 1, xp: 0, name: 'Rex' } }, activePet: 'dog',
      weapons: { sword: { tier: 0 }, shield: { tier: 0 } },
      activeWeapon: 'sword', activeShield: 'shield', coins: 50,
    };
    localStorage.setItem('dtc-characters', JSON.stringify([hero]));
    localStorage.setItem('dtc-active', 'smoke1');
  });

  await page.goto(`http://localhost:${PORT}/`);
  await page.locator('#start-btn-main').waitFor({ state: 'visible', timeout: 90000 });
  await page.click('#start-btn-main');
  await page.locator('#host-btn').waitFor({ state: 'visible', timeout: 10000 });
  await page.click('#host-btn');
  await page.locator('#start-btn').waitFor({ state: 'visible', timeout: 10000 });
  await page.click('#start-btn');
  await page.locator('#hud').waitFor({ state: 'visible', timeout: 10000 });
  console.log('✓ match started, HUD visible');

  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${SHOTS}/board.png` });
  }

  // stroll to the weapon smith (pre-wave-1 build phase = free roam). The
  // server is authoritative and reconciles our position, so we PIN the target
  // each frame until the prompt shows instead of teleporting once.
  await page.evaluate((t) => {
    window.__smokePin = setInterval(() => {
      window.__dtc.self.x = t.x; window.__dtc.self.z = t.z;
    }, 40);
  }, { x: -4.3, z: 24.9 });
  await page.locator('#weaponshop-prompt').waitFor({ state: 'visible', timeout: 15000 });
  await page.evaluate(() => clearInterval(window.__smokePin));
  await page.waitForTimeout(2500); // let the follow-cam glide over
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/smithy.png` });
  await page.click('#weaponshop-prompt');
  await page.locator('#weapon-panel').waitFor({ state: 'visible', timeout: 5000 });
  const mine = await page.locator('#weapon-list .pet-card').count();
  if (mine < 2) throw new Error(`expected the tanker's starter sword+shield, got ${mine} cards`);
  console.log(`✓ weapon panel open with ${mine} owned cards`);
  await page.click('#weapon-tab-shop');
  const shop = await page.locator('#weapon-list .pet-card').count();
  if (shop !== 5) throw new Error(`expected 5 tanker weapons in the shop, got ${shop}`);
  console.log(`✓ shop lists ${shop} weapons for the tanker`);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/weapon-shop.png` });

  // ignore benign socket transport noise
  const real = errors.filter((e) => !/WebSocket|socket\.io|network/i.test(e));
  if (real.length) throw new Error('page errors:\n' + real.join('\n'));
  console.log('✓ no uncaught page errors');
  await browser.close();
} catch (err) {
  failed = err;
} finally {
  vite.kill('SIGKILL'); // piped stdio can otherwise keep the loop alive
  server.kill('SIGKILL');
}
if (failed) { console.error('SMOKE FAILED:', failed.message); process.exit(1); }
console.log('SMOKE PASSED');
process.exit(0);
