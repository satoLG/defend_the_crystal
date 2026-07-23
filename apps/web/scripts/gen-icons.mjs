// Generate the PNG app icons from the crystal logo.
//
//   node scripts/gen-icons.mjs
//
// iOS/Android home-screen icons must be opaque, square PNGs in standard
// sizes — a large transparent PNG makes iOS fall back to a letter tile.
// We render the crystal centred on the dark start-screen background at
// each target size (plus padded "maskable" variants whose art stays
// inside the Android adaptive-icon safe zone). Uses the Chromium that
// ships for playwright-core; set CHROMIUM_PATH to override.
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const root = new URL('..', import.meta.url).pathname;
const srcB64 = readFileSync(`${root}public/img/crystal-logo.png`).toString('base64');
const dataUri = `data:image/png;base64,${srcB64}`;

// pad = fraction of the icon kept empty on EACH side. Maskable needs the
// crystal (whose side gems reach the edges) well inside the safe circle.
const targets = [
  { file: 'public/apple-touch-icon.png', size: 180, pad: 0.10, maskable: false },
  { file: 'public/icon-192.png',         size: 192, pad: 0.08, maskable: false },
  { file: 'public/icon-512.png',         size: 512, pad: 0.08, maskable: false },
  { file: 'public/icon-192-maskable.png', size: 192, pad: 0.16, maskable: true },
  { file: 'public/icon-512-maskable.png', size: 512, pad: 0.16, maskable: true },
];

const browser = await chromium.launch({ executablePath: CHROMIUM });
const page = await browser.newPage();

for (const t of targets) {
  const b64 = await page.evaluate(async ({ dataUri, size, pad }) => {
    const img = new Image();
    img.src = dataUri;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    // dark gradient plate matching the start screen / theme colour
    const g = ctx.createLinearGradient(0, 0, 0, size);
    g.addColorStop(0, '#1b1533');
    g.addColorStop(1, '#0e0a1a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    // draw the crystal centred, preserving aspect, within the padding
    const avail = size * (1 - pad * 2);
    const scale = Math.min(avail / img.width, avail / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
    return c.toDataURL('image/png').split(',')[1];
  }, { dataUri, size: t.size, pad: t.pad });
  writeFileSync(`${root}${t.file}`, Buffer.from(b64, 'base64'));
  console.log('wrote', t.file, `(${t.size}x${t.size})`);
}

await browser.close();
