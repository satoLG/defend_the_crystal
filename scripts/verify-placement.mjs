// E2E verification of the two placement flows:
//  1. drag & drop a card onto the grid (mouse + touch)
//  2. sticky mode: tap card, click a tile (desktop) / two-tap (touch)
// Run from repo root: node scripts/verify-placement.mjs
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const PORT = 5199;
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const SHOTS = process.env.SHOTS_DIR || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
  cwd: process.cwd(), stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve, reject) => {
  vite.stdout.on('data', (d) => { if (String(d).includes('Local:')) resolve(); });
  vite.on('exit', (code) => reject(new Error(`vite exited (${code})`)));
  setTimeout(() => reject(new Error('vite start timeout')), 60000);
});

let failed = null;
try {
  const browser = await chromium.launch({ executablePath: CHROMIUM });
  const page = await browser.newPage({
    viewport: { width: 900, height: 720 }, hasTouch: true,
  });
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));

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
  await page.waitForTimeout(1500);
  console.log('✓ match started');

  // plenty of points so tower costs never block the test
  await page.evaluate(() => { window.__dtc.sim.points = 9999; });

  // Find the screen position of a grid cell by raycast-probing screen
  // points through the game's own pointerToGround path (GRID is 9x15,
  // CELL=2 → worldToCell: c = x/2 + 4, r = z/2 + 7).
  const findCellScreen = async (wantC, wantR) => {
    return page.evaluate(([wantC, wantR]) => {
      const { gs } = window.__dtcRefs;
      for (let y = 80; y < 660; y += 5) {
        for (let x = 40; x < 880; x += 5) {
          const p = gs.pointerToGround(x, y);
          if (!p) continue;
          const c = Math.round(p.x / 2 + 4);
          const r = Math.round(p.z / 2 + 7);
          if (c === wantC && r === wantR) return { x, y };
        }
      }
      return null;
    }, [wantC, wantR]);
  };

  // read grid dims from config through the page (validate assumptions)
  const dims = await page.evaluate(() => {
    const g = window.__dtc.sim.grid;
    return { cells: g.blocked.length };
  });
  console.log('grid cells:', dims.cells);

  const countTowers = () => page.evaluate(() => {
    let n = 0; for (const _ of window.__dtc.sim.towers) n++; return n;
  });

  // ---- 1. mouse drag & drop a ballista onto a buildable cell ----
  const t0 = await countTowers();
  const target = await findCellScreen(2, 6);
  if (!target) throw new Error('no screen point found for cell 2,6');
  const card = await page.locator('[data-item="ballista"]').boundingBox();
  await page.mouse.move(card.x + card.width / 2, card.y + card.height / 2);
  await page.mouse.down();
  await page.mouse.move(card.x + card.width / 2, card.y - 60, { steps: 4 });
  // mid-drag: grid overlay must be visible and ghost present
  const midDrag = await page.evaluate(() => ({
    grid: window.__dtcRefs.gs.buildGrid.visible,
    ghost: !!window.__dtcRefs.view.ghost,
    dragging: !!document.querySelector('.build-card.dragging'),
    hint: !document.getElementById('build-hint').classList.contains('hidden'),
  }));
  await page.mouse.move(target.x, target.y, { steps: 8 });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/drag-mid.png` });
  const midDrag2 = await page.evaluate(() => ({
    ghost: !!window.__dtcRefs.view.ghost,
    range: window.__dtcRefs.gs.rangeGroup.visible,
    cellHl: window.__dtcRefs.gs.cellHighlight.visible,
  }));
  await page.mouse.up();
  await page.waitForTimeout(300);
  const t1 = await countTowers();
  if (!midDrag.grid || !midDrag.dragging || !midDrag.hint) {
    throw new Error('drag start state wrong: ' + JSON.stringify(midDrag));
  }
  if (!midDrag2.ghost || !midDrag2.range || !midDrag2.cellHl) {
    throw new Error('drag over-board state wrong: ' + JSON.stringify(midDrag2));
  }
  if (t1 !== t0 + 1) throw new Error(`mouse drag&drop did not place (towers ${t0} -> ${t1})`);
  const afterDrop = await page.evaluate(() => ({
    grid: window.__dtcRefs.gs.buildGrid.visible,
    ghost: !!window.__dtcRefs.view.ghost,
    selected: !!document.querySelector('.build-card.selected'),
  }));
  if (afterDrop.grid || afterDrop.ghost || afterDrop.selected) {
    throw new Error('drag did not end cleanly: ' + JSON.stringify(afterDrop));
  }
  console.log('✓ mouse drag & drop places one tower and exits build mode');

  // ---- 2. desktop sticky mode: click card, hover, click tile ----
  const t2 = await countTowers();
  await page.click('[data-item="cannon"]');
  const stickyState = await page.evaluate(() => ({
    grid: window.__dtcRefs.gs.buildGrid.visible,
    hint: !document.getElementById('build-hint').classList.contains('hidden'),
    hintText: document.getElementById('build-hint').textContent,
  }));
  if (!stickyState.grid || !stickyState.hint) {
    throw new Error('sticky select state wrong: ' + JSON.stringify(stickyState));
  }
  const target2 = await findCellScreen(8, 6);
  if (!target2) throw new Error('no screen point for cell 8,6');
  await page.mouse.move(target2.x, target2.y, { steps: 5 });
  const hoverState = await page.evaluate(() => ({
    ghost: !!window.__dtcRefs.view.ghost,
    range: window.__dtcRefs.gs.rangeGroup.visible,
  }));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/sticky-hover.png` });
  if (!hoverState.ghost || !hoverState.range) {
    throw new Error('sticky hover state wrong: ' + JSON.stringify(hoverState));
  }
  await page.mouse.click(target2.x, target2.y);
  await page.waitForTimeout(300);
  const t3 = await countTowers();
  if (t3 !== t2 + 1) throw new Error(`sticky click did not place (towers ${t2} -> ${t3})`);
  const afterSticky = await page.evaluate(() => ({
    grid: window.__dtcRefs.gs.buildGrid.visible,
    selected: !!document.querySelector('.build-card.selected'),
  }));
  if (afterSticky.grid || afterSticky.selected) {
    throw new Error('sticky mode did not end after placing: ' + JSON.stringify(afterSticky));
  }
  console.log('✓ sticky click mode places one tower and deselects');

  // ---- 3. touch two-tap flow ----
  const t4 = await countTowers();
  const cardBox = await page.locator('[data-item="ballista"]').boundingBox();
  await page.touchscreen.tap(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
  // the synthesized click can lag the tap by ~1s on a busy main thread —
  // wait it out so the two-tap flow below starts from a settled state
  await page.waitForTimeout(1500);
  const touchSel = await page.evaluate(() => ({
    grid: window.__dtcRefs.gs.buildGrid.visible,
    selectedItem: window.__dtcRefs.ui.selectedItem,
    hintText: document.getElementById('build-hint').textContent,
  }));
  if (!touchSel.grid) throw new Error('touch select did not enter build mode: ' + JSON.stringify(touchSel));
  const target3 = await findCellScreen(4, 5);
  if (!target3) throw new Error('no screen point for cell 4,5');
  await page.touchscreen.tap(target3.x, target3.y); // first tap = preview
  await page.waitForTimeout(150);
  const preview = await page.evaluate(() => ({
    ghost: !!window.__dtcRefs.view.ghost,
    range: window.__dtcRefs.gs.rangeGroup.visible,
    towers: (() => { let n = 0; for (const _ of window.__dtc.sim.towers) n++; return n; })(),
  }));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/touch-preview.png` });
  if (!preview.ghost || !preview.range) throw new Error('two-tap preview missing: ' + JSON.stringify(preview));
  if (preview.towers !== t4) throw new Error('first tap must not place');
  await page.touchscreen.tap(target3.x, target3.y); // second tap = confirm
  await page.waitForTimeout(300);
  const t5 = await countTowers();
  if (t5 !== t4 + 1) throw new Error(`two-tap did not place (towers ${t4} -> ${t5})`);
  const afterTouch = await page.evaluate(() => ({
    grid: window.__dtcRefs.gs.buildGrid.visible,
    selected: !!document.querySelector('.build-card.selected'),
  }));
  if (afterTouch.grid || afterTouch.selected) {
    throw new Error('touch mode did not end after placing: ' + JSON.stringify(afterTouch));
  }
  console.log('✓ touch two-tap places one tower and deselects');

  // ---- 4. touch drag & drop (block card, no range ring) ----
  const b0 = await page.evaluate(() => {
    let n = 0; for (const _ of window.__dtc.sim.obstacles) n++; return n;
  });
  const target4 = await findCellScreen(6, 5);
  if (!target4) throw new Error('no screen point for cell 6,5');
  const blockBox = await page.locator('[data-item="obstacle"]').boundingBox();
  const cx = blockBox.x + blockBox.width / 2, cy = blockBox.y + blockBox.height / 2;
  // synthesize a touch drag via CDP (playwright's touchscreen has no drag)
  const cdp = await page.context().newCDPSession(page);
  const seg = 14;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart', touchPoints: [{ x: cx, y: cy, id: 1 }],
  });
  for (let i = 1; i <= seg; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: cx + ((target4.x - cx) * i) / seg, y: cy + ((target4.y - cy) * i) / seg, id: 1 }],
    });
    await page.waitForTimeout(16);
  }
  const midTouchDrag = await page.evaluate(() => ({
    grid: window.__dtcRefs.gs.buildGrid.visible,
    ghost: !!window.__dtcRefs.view.ghost,
    range: window.__dtcRefs.gs.rangeGroup.visible,
  }));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/touch-drag.png` });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd', touchPoints: [{ x: target4.x, y: target4.y, id: 1 }],
  });
  await page.waitForTimeout(300);
  const b1 = await page.evaluate(() => {
    let n = 0; for (const _ of window.__dtc.sim.obstacles) n++; return n;
  });
  if (!midTouchDrag.grid || !midTouchDrag.ghost) {
    throw new Error('touch drag state wrong: ' + JSON.stringify(midTouchDrag));
  }
  if (midTouchDrag.range) throw new Error('block drag must not show a range ring');
  if (b1 !== b0 + 1) throw new Error(`touch drag&drop block failed (obstacles ${b0} -> ${b1})`);
  console.log('✓ touch drag & drop places a block (no range ring)');

  // ---- 5. invalid drop (over HUD) cancels silently ----
  const t6 = await countTowers();
  const card5 = await page.locator('[data-item="cannon"]').boundingBox();
  await page.mouse.move(card5.x + card5.width / 2, card5.y + card5.height / 2);
  await page.mouse.down();
  await page.mouse.move(card5.x + card5.width / 2, card5.y - 80, { steps: 4 });
  await page.mouse.move(card5.x + 40, card5.y + 10, { steps: 4 }); // back over the HUD row
  await page.mouse.up();
  await page.waitForTimeout(200);
  const t7 = await countTowers();
  if (t7 !== t6) throw new Error('drop over HUD must not place');
  const cancelled = await page.evaluate(() => ({
    grid: window.__dtcRefs.gs.buildGrid.visible,
    ghost: !!window.__dtcRefs.view.ghost,
  }));
  if (cancelled.grid || cancelled.ghost) throw new Error('cancelled drag left state behind');
  console.log('✓ dropping over the HUD cancels cleanly');

  // ---- 6. Escape cancels sticky mode ----
  await page.click('[data-item="ballista"]');
  await page.keyboard.press('Escape');
  const esc = await page.evaluate(() => window.__dtcRefs.gs.buildGrid.visible);
  if (esc) throw new Error('Escape did not exit build mode');
  console.log('✓ Escape cancels');

  const real = errors.filter((e) => !/WebSocket|network|mqtt|torrent|ICE/i.test(e));
  if (real.length) throw new Error('page errors:\n' + real.join('\n'));
  console.log('✓ no uncaught page errors');
  await browser.close();
} catch (err) {
  failed = err;
} finally {
  vite.kill('SIGKILL');
}
if (failed) { console.error('VERIFY FAILED:', failed); process.exit(1); }
console.log('VERIFY PASSED');
process.exit(0);
