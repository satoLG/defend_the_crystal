import { loadAssets } from './render/assets.js';
import { GameScene } from './render/scene.js';
import { GameView } from './render/view.js';
import { CharacterPreview } from './render/preview.js';
import { hasCharacter } from './character.js';
import { Sim } from './sim/sim.js';
import { Grid, worldToCell, cellToWorld, canJumpFrom, computeDashEnd } from './sim/grid.js';
import { Net, selfId } from './net.js';
import { Input } from './input.js';
import { UI } from './ui.js';
import { armAudioOnFirstGesture, bindAudioLifecycle, sfx, setSfxVolume } from './audio.js';
import { CLASSES, PLAYER, NET, SIM_DT, TOWERS, TOWER_UPGRADE, GRID, JUMP, SKILLS } from './config.js';
import { makeRoomCode, clamp, lerp, dist2d } from './utils.js';
import { settings } from './settings.js';
import { music } from './music.js';

// ============================================================
// Bootstraps everything and runs the two game loops:
//   host   — authoritative Sim + broadcast snapshots/events
//   client — send inputs, interpolate snapshots
// Both predict their own character's movement locally so
// controls always feel instant.
// ============================================================

const state = {
  role: null,          // 'host' | 'client'
  net: null,
  sim: null,
  hostId: null,
  started: false,
  over: false,
  // client-side snapshot interpolation
  snapPrev: null, snapNext: null, snapPrevT: 0, snapNextT: 0,
  // local self-prediction (jump = in-flight hop over a grid cell,
  // dash = the berserker's special sprint)
  self: { x: 0, z: 4, yaw: Math.PI, moving: false, kbx: 0, kbz: 0, dead: false, speed: 4, jump: null, dash: null },
  selfInit: false,
  clientGrid: new Grid(),
  blockedKey: '',
  lobbyPlayers: [],
  lastInputSend: 0,
  lastSnapSend: 0,
};

let gs, view, ui, input;

// ---------------------------------------------------------
// boot
// ---------------------------------------------------------

const effectiveVolumes = () => ({
  music: settings.get('musicMuted') ? 0 : settings.get('musicVol'),
  sfx: settings.get('sfxMuted') ? 0 : settings.get('sfxVol'),
});

async function boot() {
  // every user gesture (re)applies volumes and unlocks/resumes the
  // audio contexts — required on iOS, harmless elsewhere
  armAudioOnFirstGesture(() => {
    const v = effectiveVolumes();
    setSfxVolume(v.sfx);
    music.setVolume(v.music);
  });
  bindAudioLifecycle();
  setSfxVolume(effectiveVolumes().sfx);

  const canvas = document.getElementById('game-canvas');

  ui = new UI({
    onHost: hostGame,
    onJoin: joinGame,
    onStartMatch: startMatch,
    onAction: sendAction,
    onJump: () => doJump(),
    onSkill: () => doSkill(),
    onBuildMode: (on) => { gs.setBuildMode(on); if (!on) view.clearGhost(); },
    onPanelClose: () => gs.hideRange(),
    onExit: () => location.reload(),
  });

  input = new Input(canvas);
  input.buildModeCheck = () => !!ui.selectedItem;
  input.onTap = onCanvasTap;
  input.onHover = onCanvasHover;
  input.onKeyAction = onKeyAction;

  await loadAssets((f) => ui.loadProgress(f));
  gs = new GameScene(canvas);
  gs.shakeEnabled = settings.get('shake');
  gs.setShadows(settings.get('shadows'));
  settings.onChange((k, v) => {
    if (k === 'shake') gs.shakeEnabled = v;
    if (k === 'shadows') gs.setShadows(v);
  });
  view = new GameView(gs);

  // live 3D turntable for the character-creation screen
  const preview = new CharacterPreview(document.getElementById('preview-canvas'));
  ui.attachPreview(preview);

  // must pick/create a character before anything else; returning
  // players already have one saved, so they land on the menu
  if (hasCharacter()) ui.showMenu();
  else ui.showCharacter();
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------
// hosting / joining
// ---------------------------------------------------------

function hostGame(character) {
  state.role = 'host';
  state.hostId = selfId;
  const code = makeRoomCode();
  state.net = new Net(code);
  state.sim = new Sim();
  state.sim.addPlayer(selfId, character.name, character.cls, character.colors);
  syncSelfFromSim();

  state.net.on('hello', (data, peerId) => {
    if (!state.sim.getPlayer(peerId)) {
      state.sim.addPlayer(peerId, data?.name, data?.cls, data?.colors);
    }
    broadcastLobby();
  });
  state.net.on('input', (data, peerId) => state.sim.setInput(peerId, data));
  state.net.on('act', (data, peerId) => state.sim.handleAction(peerId, data));
  state.net.onPeerJoin = () => broadcastLobby();
  state.net.onPeerLeave = (peerId) => {
    state.sim.removePlayer(peerId);
    broadcastLobby();
  };

  ui.showLobby(code, true);
  broadcastLobby();
}

function broadcastLobby() {
  if (state.role !== 'host') return;
  const players = state.sim.players.entities.map((p) => ({
    id: p.id, name: p.name, cls: p.cls, colors: p.colors, host: p.id === selfId,
  }));
  state.lobbyPlayers = players;
  const payload = { host: selfId, code: state.net.code, players, started: state.started };
  state.net.send('lobby', payload);
  ui.updateLobby(players, selfId);
  view.setCosmetics(players);
}

function joinGame(code, character) {
  state.role = 'client';
  state.net = new Net(code);
  ui.showLobby(code, false);
  $status('Looking for the host…');

  const hello = () => state.net.send('hello', {
    name: character.name, cls: character.cls, colors: character.colors,
  });
  state.net.onPeerJoin = () => hello();

  state.net.on('lobby', (data) => {
    state.hostId = data.host;
    state.lobbyPlayers = data.players || [];
    ui.updateLobby(state.lobbyPlayers, selfId);
    view.setCosmetics(state.lobbyPlayers);
    $status('');
    if (data.started && !state.started) enterGame();
  });
  state.net.on('snap', (snap) => {
    state.snapPrev = state.snapNext;
    state.snapPrevT = state.snapNextT;
    state.snapNext = snap;
    state.snapNextT = performance.now() / 1000;
    if (!state.started) enterGame();
    syncClientGrid(snap);
    reconcileSelf(snap);
  });
  state.net.on('ev', (events) => {
    for (const ev of events) handleEvent(ev);
  });
  state.net.onPeerLeave = (peerId) => {
    if (peerId === state.hostId) ui.showHostLost();
  };

  // if we never hear from a host, tell the player
  setTimeout(() => {
    if (!state.hostId && !state.started) {
      $status('Nobody here yet — check the code, or keep waiting.');
    }
  }, 12000);
}

function $status(msg) {
  const el = document.getElementById('lobby-status');
  if (msg) el.textContent = msg;
}

function startMatch() {
  if (state.role !== 'host' || state.started) return;
  state.sim.start();
  state.started = true;
  broadcastLobby();
  enterGame();
}

function enterGame() {
  state.started = true;
  state.over = false;
  ui.showHud();
  sfx.notify();
}

function sendAction(act) {
  if (!state.started) return;
  if (state.role === 'host') state.sim.handleAction(selfId, act);
  else state.net.send('act', act, state.hostId);
}

// ---------------------------------------------------------
// build-mode pointer handling
// ---------------------------------------------------------

function snapForUi() {
  return state.role === 'host'
    ? (state.sim && state.started ? state.sim.buildSnapshot() : null)
    : state.snapNext;
}

function cellFromPointer(x, y) {
  const p = gs.pointerToGround(x, y);
  if (!p) return null;
  return worldToCell(p.x, p.z);
}

function canPlaceLocal(item, c, r) {
  const g = clientGridRef();
  if (!g.isBuildable(c, r)) return false;
  if (!g.canPlaceAt(c, r, state.role === 'host' ? state.sim.enemyCells() : [])) return false;
  return true;
}

function clientGridRef() {
  return state.role === 'host' ? state.sim.grid : state.clientGrid;
}

function onCanvasHover(x, y) {
  if (!state.started || !ui.selectedItem) return;
  const cell = cellFromPointer(x, y);
  if (!cell) return view.clearGhost();
  view.setGhost(ui.selectedItem, cell.c, cell.r, canPlaceLocal(ui.selectedItem, cell.c, cell.r));
}

function onCanvasTap(x, y, pointerType, button) {
  if (!state.started) return;
  if (button === 2) return; // right-click cancels via contextmenu
  const cell = cellFromPointer(x, y);
  const offBoard = !cell ||
    cell.c < 0 || cell.c >= GRID.COLS || cell.r < 0 || cell.r >= GRID.ROWS;

  if (ui.selectedItem) {
    if (offBoard) { ui.selectItem(null); return; }
    const ok = canPlaceLocal(ui.selectedItem, cell.c, cell.r);
    if (pointerType === 'touch') {
      // two-tap confirm so fat fingers don't waste points
      if (ui.pendingCell && ui.pendingCell.c === cell.c && ui.pendingCell.r === cell.r) {
        if (ok) {
          sendAction({ t: 'place', item: ui.selectedItem, c: cell.c, r: cell.r });
          ui.pendingCell = null;
          view.clearGhost();
        } else {
          sfx.error();
        }
      } else {
        ui.pendingCell = cell;
        view.setGhost(ui.selectedItem, cell.c, cell.r, ok);
      }
    } else {
      if (ok) sendAction({ t: 'place', item: ui.selectedItem, c: cell.c, r: cell.r });
      else sfx.error();
    }
    return;
  }

  // no build card selected: tap a structure to manage it
  if (offBoard) { ui.closePanel(); gs.hideRange(); return; }
  const snap = snapForUi();
  if (!snap) return;
  const tower = snap.tw.find((t) => t[2] === cell.c && t[3] === cell.r);
  if (tower) {
    sfx.click();
    const w = cellToWorld(cell.c, cell.r);
    gs.showRange(w.x, w.z, towerRangeOf(tower));
    return ui.openPanel({ type: 'tower', kind: tower[1], lvl: tower[4], c: cell.c, r: cell.r });
  }
  const obst = snap.ob.find((o) => o[2] === cell.c && o[3] === cell.r);
  if (obst) {
    sfx.click();
    return ui.openPanel({ type: 'obstacle', c: cell.c, r: cell.r });
  }
  ui.closePanel();
  gs.hideRange();
}

function towerRangeOf(row) {
  const def = TOWERS[row[1]];
  return def ? def.range + TOWER_UPGRADE.rangeAdd * (row[4] - 1) : 5;
}

function onKeyAction(action) {
  if (!state.started) return;
  switch (action) {
    case 'build': ui.selectItem(ui.selectedItem ? null : 'obstacle'); break;
    case 'card0': ui.selectCardByIndex(0); break;
    case 'card1': ui.selectCardByIndex(1); break;
    case 'card2': ui.selectCardByIndex(2); break;
    case 'card3': ui.selectCardByIndex(3); break;
    case 'cancel':
      ui.selectItem(null);
      ui.closePanel();
      gs.hideRange();
      break;
    case 'jump': doJump(); break;
    case 'skill': doSkill(); break;
    case 'startwave':
      // Space jumps when a jump is possible; otherwise it keeps its
      // old job of starting the next wave (host only)
      if (!doJump() && state.role === 'host') sendAction({ t: 'start' });
      break;
  }
}

// ---------------------------------------------------------
// jumping over grid towers / obstacles
// ---------------------------------------------------------

function doJump() {
  const s = state.self;
  if (!state.started || state.over || s.dead || s.jump || s.dash) return false;
  if (state.role === 'client' && !state.selfInit) return false;
  const info = canJumpFrom(clientGridRef(), s.x, s.z, s.yaw);
  if (!info) return false;
  s.jump = { fx: s.x, fz: s.z, tx: info.to.x, tz: info.to.z, t: 0, dur: JUMP.DUR };
  view.startJump(selfId, JUMP.DUR);
  sfx.jump();
  sendAction({ t: 'jump', yaw: Math.round(s.yaw * 100) / 100 });
  return true;
}

let jumpWasEnabled = null;
function updateJumpButton() {
  const s = state.self;
  const ok = state.started && !state.over && !s.dead && !s.jump && !s.dash &&
    (state.role === 'host' || state.selfInit) &&
    !!canJumpFrom(clientGridRef(), s.x, s.z, s.yaw);
  if (ok !== jumpWasEnabled) {
    jumpWasEnabled = ok;
    ui.setJumpEnabled(ok);
  }
}

// ---------------------------------------------------------
// class special attacks
// ---------------------------------------------------------

function doSkill() {
  const s = state.self;
  if (!state.started || state.over || s.dead || s.jump || s.dash) return;
  if (state.role === 'client' && !state.selfInit) return;
  if (!ui.skillReady) return;
  // the berserker's dash moves the character, and movement is
  // client-authoritative — predict it locally, like jumps
  if (ui.myCls === 'berserker') {
    const end = computeDashEnd(clientGridRef(), s.x, s.z, s.yaw, SKILLS.berserker.cells);
    s.dash = { fx: s.x, fz: s.z, tx: end.x, tz: end.z, t: 0, dur: SKILLS.berserker.dur };
  }
  sendAction({ t: 'skill', yaw: Math.round(s.yaw * 100) / 100 });
}

// ---------------------------------------------------------
// events from the sim (host: direct, client: over the wire)
// ---------------------------------------------------------

// sensationalist one-liners for the checkpoint bosses
const BOSS_FLAVOR = {
  'Coveiro': 'He digs your graves in advance!',
  'Tiro Cego': 'Nobody escapes the volley — NOBODY!',
  'Zé do Caixão': 'Walls mean NOTHING to him!',
  'Abobrado': 'Take cover — pumpkins incoming!',
};

function handleEvent(ev) {
  view.handleEvent(ev);
  switch (ev.t) {
    case 'toast':
      if (!ev.to || ev.to === selfId) ui.toast(ev.msg, ev.kind || '');
      break;
    case 'wave':
      ui.toast(`Wave ${ev.n}!`, 'gold');
      sfx.wave();
      break;
    case 'boss':
      ui.showBossBanner(ev.name, BOSS_FLAVOR[ev.name] || 'The ground trembles…');
      music.bossJingle();
      gs.addShake(0.55);
      break;
    case 'subboss':
      ui.showBossBanner(ev.name, 'A monstrous champion joins the wave!', true);
      music.miniJingle();
      break;
    case 'ejump': sfx.jump(); break;
    case 'skill':
      sfx.skill(ev.cls);
      if (ev.cls === 'berserker') gs.addShake(0.2);
      if (ev.cls === 'mage') setTimeout(() => gs.addShake(0.4), SKILLS.mage.flightT * 1000);
      break;
    case 'grave': sfx.boom(); break;
    case 'phase':
      if (ev.ph === 'build' && ev.n > 1) sfx.waveClear();
      break;
    case 'heal':
      ui.toast(`Checkpoint! +${ev.bonus} points, everyone healed`, 'gold');
      sfx.levelUp();
      break;
    case 'shoot': sfx.shoot(); break;
    case 'aoe': sfx.boom(); break;
    case 'hit': sfx.hit(); break;
    case 'die':
      if (ev.player) {
        if (ev.id === selfId) { sfx.hurt(); state.self.dead = true; }
        ui.toast('A defender has fallen!', 'error');
      } else if (ev.boss) {
        ui.toast('Boss defeated!', 'gold');
        sfx.success();
      }
      break;
    case 'respawn':
      if (ev.id === selfId) {
        state.self.x = ev.x; state.self.z = ev.z;
        state.self.dead = false;
        sfx.success();
      }
      break;
    case 'kb':
      if (ev.id === selfId) { state.self.kbx += ev.dx; state.self.kbz += ev.dz; }
      break;
    case 'lvl':
      if (ev.id === selfId) { ui.toast(`Level ${ev.lvl}!`, 'gold'); sfx.levelUp(); }
      break;
    case 'pickup':
      if (ev.id === selfId) (ev.k === 'pts' ? sfx.coin : sfx.xp)();
      break;
    case 'jump':
      // own jump is predicted locally in doJump()
      if (ev.id !== selfId) view.startJump(ev.id, ev.dur);
      break;
    case 'breach':
      sfx.breach();
      ui.toast('The crystal was hit!', 'error');
      break;
    case 'place':
      if (ev.item === 'obstacle') sfx.place();
      else sfx.placeTower();
      break;
    case 'upgrade': sfx.success(); break;
    case 'unplace': sfx.place(); break;
    case 'over':
      state.over = true;
      ui.selectItem(null);
      ui.showGameOver(ev, state.role === 'host');
      sfx.error();
      break;
    case 'restart':
      state.over = false;
      ui.hideGameOver();
      view.reset();
      syncSelfFromSim();
      ui.toast('New defense begins!', 'gold');
      break;
  }
}

// ---------------------------------------------------------
// self movement prediction (both roles)
// ---------------------------------------------------------

function syncSelfFromSim() {
  const p = state.sim?.getPlayer(selfId);
  if (p) {
    state.self.x = p.x; state.self.z = p.z; state.self.yaw = p.yaw;
    state.self.speed = p.speed;
    state.self.dead = p.dead;
    state.self.jump = null;
    state.self.dash = null;
    state.selfInit = true;
  }
}

function reconcileSelf(snap) {
  const me = snap.pl.find((r) => r[0] === selfId);
  if (!me) return;
  state.self.speed = CLASSES[me[1]]?.speed || 4;
  state.self.dead = me[11] === 1;
  // mid-dash the host briefly lags far behind the predicted position —
  // don't let that trip the teleport-back threshold
  if (state.self.dash) return;
  if (!state.selfInit || dist2d(state.self.x, state.self.z, me[2], me[3]) > 3) {
    state.self.x = me[2];
    state.self.z = me[3];
    state.selfInit = true;
  }
}

function syncClientGrid(snap) {
  // rebuild blocked cells only when the structure set changes
  const key = snap.tw.map((t) => `${t[2]},${t[3]}`).concat(snap.ob.map((o) => `${o[2]},${o[3]}`)).sort().join(';');
  if (key === state.blockedKey) return;
  state.blockedKey = key;
  state.clientGrid.blocked.fill(0);
  for (const t of snap.tw) state.clientGrid.blocked[t[3] * GRID.COLS + t[2]] = 1;
  for (const o of snap.ob) state.clientGrid.blocked[o[3] * GRID.COLS + o[2]] = 1;
  state.clientGrid.computeFlow();
}

function stepSelf(dt) {
  const s = state.self;
  if (s.dead) { s.moving = false; s.jump = null; s.dash = null; return; }
  // mid-jump: fly along the arc, ignoring input and cell collision
  if (s.jump) {
    const j = s.jump;
    j.t += dt;
    const k = Math.min(j.t / j.dur, 1);
    s.x = lerp(j.fx, j.tx, k);
    s.z = lerp(j.fz, j.tz, k);
    s.moving = false;
    if (k >= 1) s.jump = null;
    return;
  }
  // mid-dash (berserker skill): sprint along the line, ignoring input
  if (s.dash) {
    const d = s.dash;
    d.t += dt;
    const k = Math.min(d.t / d.dur, 1);
    s.x = lerp(d.fx, d.tx, k);
    s.z = lerp(d.fz, d.tz, k);
    if (Math.hypot(d.tx - d.fx, d.tz - d.fz) > 0.05) {
      s.yaw = Math.atan2(d.tx - d.fx, d.tz - d.fz);
    }
    s.moving = true;
    if (k >= 1) { s.dash = null; s.moving = false; }
    return;
  }
  const dir = input.moveDir();
  const mag = Math.hypot(dir.x, dir.z);
  s.moving = mag > 0.15;
  let vx = 0, vz = 0;
  if (s.moving) {
    vx = dir.x * s.speed;
    vz = dir.z * s.speed;
    s.yaw = Math.atan2(dir.x, dir.z);
  }
  // knockback impulse
  vx += s.kbx * 6;
  vz += s.kbz * 6;
  const decay = Math.exp(-PLAYER.KB_DECAY * dt);
  s.kbx *= decay; s.kbz *= decay;

  const nx = s.x + vx * dt;
  const nz = s.z + vz * dt;
  const fixed = clientGridRef().resolveCircle(nx, nz, PLAYER.RADIUS, true);
  s.x = fixed.x; s.z = fixed.z;
}

// ---------------------------------------------------------
// main loop
// ---------------------------------------------------------

let lastT = 0;
let simAccum = 0;

function frame(t) {
  requestAnimationFrame(frame);
  const now = t / 1000;
  const dt = Math.min(now - (lastT || now), 0.1);
  lastT = now;

  if (state.started && !state.over) stepSelf(dt);
  updateJumpButton();

  if (state.role === 'host' && state.started) {
    // fixed-step authoritative sim
    simAccum = Math.min(simAccum + dt, 0.25);
    while (simAccum >= SIM_DT) {
      state.sim.setInput(selfId, {
        x: state.self.x, z: state.self.z, yaw: state.self.yaw, m: state.self.moving,
      });
      state.sim.step(SIM_DT);
      simAccum -= SIM_DT;
    }
    const events = state.sim.drainEvents();
    if (events.length) {
      for (const ev of events) handleEvent(ev);
      state.net.send('ev', events);
    }
    if (now - state.lastSnapSend > 1 / NET.SNAP_HZ) {
      state.lastSnapSend = now;
      state.net.send('snap', state.sim.buildSnapshot());
    }
    const snap = state.sim.buildSnapshot();
    view.applySnapshot(null, snap, 1, selfId, selfPose());
    ui.updateHud(snap, selfId);
  } else if (state.role === 'client' && state.started) {
    if (now - state.lastInputSend > 1 / NET.INPUT_HZ && state.selfInit) {
      state.lastInputSend = now;
      state.net.send('input', {
        x: Math.round(state.self.x * 100) / 100,
        z: Math.round(state.self.z * 100) / 100,
        yaw: Math.round(state.self.yaw * 100) / 100,
        m: state.self.moving,
      }, state.hostId);
    }
    if (state.snapNext) {
      let alpha = 1;
      if (state.snapPrev && state.snapNextT > state.snapPrevT) {
        const renderT = performance.now() / 1000 - NET.INTERP_DELAY;
        alpha = clamp((renderT - state.snapPrevT) / (state.snapNextT - state.snapPrevT), 0, 1.15);
      }
      view.applySnapshot(state.snapPrev, state.snapNext, alpha, selfId, selfPose());
      ui.updateHud(state.snapNext, selfId);
    }
  }

  // checkpoints are free time: the camera leaves the board framing and
  // follows the hero while they stroll (and rest) around the sanctuary.
  // The match start counts as the first checkpoint — the pre-wave-1
  // build phase gets the same free-roam camera.
  const phase = state.role === 'host' ? state.sim?.phase : state.snapNext?.ph;
  const waveN = state.role === 'host' ? state.sim?.wave : state.snapNext?.w;
  const freeRoam = phase === 'checkpoint' || (phase === 'build' && waveN === 0);
  if (state.started && !state.over && freeRoam &&
      (state.role === 'host' || state.selfInit) && !state.self.dead) {
    gs.setFollow(state.self.x, state.self.z);
  } else {
    gs.clearFollow();
  }

  gs.update(dt);
  if (view) view.update(dt, gs.camera, selfPose());
  gs.render();
}

function selfPose() {
  return state.selfInit
    ? { x: state.self.x, z: state.self.z, yaw: state.self.yaw, moving: state.self.moving }
    : null;
}

boot();

// dev/debug handle (also handy for automated testing)
window.__dtc = state;
