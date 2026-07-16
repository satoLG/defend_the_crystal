// Renders one transparent 128×128 PNG per purchasable weapon into
// public/img/weapons/ (the shop cards & character sheet use them, the
// same way pet cards use the Kenney preview renders).
//
//   node scripts/gen-weapon-previews.mjs
//
// Needs a chromium for playwright-core; set CHROMIUM_PATH to override
// the default /opt/pw-browsers/chromium.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const PORT = 5199;
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';

const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
  cwd: new URL('..', import.meta.url).pathname,
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve, reject) => {
  vite.stdout.on('data', (d) => { if (String(d).includes('Local:')) resolve(); });
  vite.on('exit', (code) => reject(new Error(`vite exited (${code})`)));
  setTimeout(() => reject(new Error('vite start timeout')), 30000);
});

try {
  const browser = await chromium.launch({ executablePath: CHROMIUM });
  const page = await browser.newPage({ viewport: { width: 220, height: 220 }, deviceScaleFactor: 1 });
  page.on('pageerror', (err) => { throw err; });
  await page.goto(`http://localhost:${PORT}/scripts/weapon-previews.html`);
  await page.waitForFunction('window.__ready === true', null, { timeout: 90000 });

  const ids = await page.evaluate('window.__ids');
  mkdirSync('public/img/weapons', { recursive: true });
  // one image per weapon per upgrade tier: base id.png, gold id-g.png,
  // crystal id-c.png — the shop/arsenal/stats UI picks by the owned tier
  const suffix = ['', '-g', '-c'];
  for (const id of ids) {
    for (let tier = 0; tier < 3; tier++) {
      const ok = await page.evaluate(`window.__show(${JSON.stringify(id)}, ${tier})`);
      if (!ok) throw new Error(`no prop spec for weapon "${id}"`);
      const buf = await page.locator('#c').screenshot({ omitBackground: true });
      writeFileSync(`public/img/weapons/${id}${suffix[tier]}.png`, buf);
      console.log(`✓ ${id}${suffix[tier]}.png`);
    }
  }
  await browser.close();
} finally {
  vite.kill('SIGKILL');
}
process.exit(0); // vite's piped stdio can otherwise keep the loop alive
