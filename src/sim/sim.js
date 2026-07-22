import { World } from 'miniplex';
import { EntityManager, Vehicle, SeekBehavior, SeparationBehavior } from 'yuka';
import {
  CLASSES, PLAYER, TOWERS, TOWER_LEVEL_MAX, TOWER_UPGRADE, OBSTACLES,
  OBSTACLE_STOCK_CAP, ENEMIES, ENEMY, WAVES, SCALING, scaleFor,
  CRYSTAL_BREACH_LIMIT, GRID, JUMP, DROPS, SUMMON, BOSSES, SKILLS, NAME_MAX,
  PET, GOLD, petEffects, sanitizePetRef, jumpDurFor,
  WEAPONS, STUN, ORB, weaponEffects, sanitizeWeaponRef, classStarterWeapons,
  TOWER_SPECIALS, STATUS,
} from '../config.js';
import {
  Grid, cellToWorld, worldToCell, canJumpFrom, enemyJumpShortcut, idx, inBounds,
  computeDashEnd, CRYSTAL_POS, HALF_W, HALF_H,
} from './grid.js';
import { PORTAL, CROSS_Z, NPCS, DUMMIES, TRAIN } from '../sanctuary.js';
import { buildWavePlan, enemyStats } from './waves.js';
import { clamp, dist2d, nextId } from '../utils.js';

const rnd2 = (v) => Math.round(v * 100) / 100;

// A knockback vector of magnitude `mag` that pushes a body at `pos` straight
// away from the origin (fx,fz) the hit came from — i.e. BACKWARD along the
// direction the blow travelled. Returns [kx, kz].
function kbAway(fx, fz, pos, mag) {
  if (mag <= 0) return [0, 0];
  const dx = pos.x - fx, dz = pos.z - fz;
  const d = Math.hypot(dx, dz) || 1;
  return [(dx / d) * mag, (dz / d) * mag];
}

// ============================================================
// Host-authoritative simulation. Runs only on the host; clients
// receive snapshots + events. Movement of each character is
// client-authoritative (the owning client integrates it), the
// host owns everything else: combat, waves, economy, building.
// ============================================================
export class Sim {
  constructor() {
    this.world = new World();
    this.players = this.world.with('player');
    this.enemies = this.world.with('enemy');
    this.towers = this.world.with('tower');
    this.obstacles = this.world.with('obstacle');

    this.grid = new Grid();
    this.ai = new EntityManager();

    this.time = 0;
    this.phase = 'lobby'; // lobby | build | combat | checkpoint | over
    this.wave = 0;
    this.points = 0;
    this.breaches = 0;
    this.buildT = 0;
    this.buildTimerOn = false;
    this.spawnQueue = [];   // [{kind, at(abs time), boss, variant, horde}]
    this.spawnIdx = 0;
    this.graves = [];       // tombs raised by the gravedigger, still spawning
    this.fires = [];        // burning ground patches (cannon napalm special)
    this.drops = [];        // XP/point orbs on the ground, per-player
    this.pending = [];      // scheduled callbacks [{at, fn}]
    this.events = [];
    this.contReady = new Set();
    this.trainers = new Set(); // players currently in training mode
    this.waveStartCount = 1; // player count captured at wave start
  }

  emit(ev) { this.events.push(ev); }
  drainEvents() { const e = this.events; this.events = []; return e; }
  playerCount() { return this.players.entities.length; }

  // ---------------- players ----------------

  addPlayer(id, name, cls, colors, pet = null, loadout = null) {
    if (this.getPlayer(id)) return;
    if (!CLASSES[cls]) cls = 'berserker';
    const base = CLASSES[cls];
    const spawn = this.playerSpawnPos();
    // fall back to the class's free starter weapon/shield when the
    // client sent nothing (or something that isn't in this class's arsenal)
    const starterRef = (slot) => {
      const wid = classStarterWeapons(cls).find((w) => WEAPONS[w].slot === slot);
      return wid ? { id: wid, tier: 0 } : null;
    };
    const p = this.world.add({
      player: true, id, name: (name || 'Hero').slice(0, NAME_MAX), cls,
      colors: colors || {},
      x: spawn.x, z: spawn.z, yaw: Math.PI, moving: false,
      hp: base.hp, maxHp: base.hp, atk: base.atk, def: base.def,
      range: base.range, rate: base.rate, speed: base.speed,
      aoe: base.aoe || 0, kbPower: base.knockback,
      // raw = class base grown by hero level-ups only; pet + weapon
      // bonuses are layered on top by applyStats so both can be
      // swapped mid-match
      rawMaxHp: base.hp, rawAtk: base.atk,
      pet: sanitizePetRef(pet),
      weapon: sanitizeWeaponRef(loadout?.weapon, cls, 'weapon') || starterRef('weapon'),
      shield: sanitizeWeaponRef(loadout?.shield, cls, 'shield') || starterRef('shield'),
      lvl: 1, xp: 0, xpNext: this.xpNext(1),
      dead: false, respawnT: 0, atkCd: 0, lastDmg: -99, invT: 0, jumpT: 0,
      skillCd: 0, wallT: 0, dashT: 0,
      kills: 0, obst: 0, lastInputT: this.time,
    });
    this.applyStats(p);
    p.hp = p.maxHp;
    if (this.phase !== 'lobby') {
      // late joiner: give them the starting obstacle stock
      p.obst = scaleFor(SCALING.startObstacles, this.playerCount());
      this.emit({ t: 'toast', k: 'toast.joined', pr: { name: p.name } });
    }
    return p;
  }

  removePlayer(id) {
    const p = this.getPlayer(id);
    if (!p) return;
    this.world.remove(p);
    this.contReady.delete(id);
    this.exitTraining(id);
    if (this.phase !== 'lobby') this.emit({ t: 'toast', k: 'toast.left', pr: { name: p.name } });
    this.checkContinue();
  }

  getPlayer(id) {
    return this.players.entities.find((p) => p.id === id);
  }

  // free-roam phases: the sanctuary is open (players may stroll down
  // the stairs, spawn at the portal, meet the NPCs). Everywhere else —
  // combat and the build pauses of a running match — it is locked.
  freeRoamPhase() {
    return this.phase === 'lobby' || this.phase === 'checkpoint' ||
      this.phase === 'over' || (this.phase === 'build' && this.wave === 0);
  }

  playerSpawnPos() {
    const n = this.playerCount();
    // while the sanctuary is open, heroes arrive through the portal at
    // its far end (facing the crystal all the way up the plaza); joiners
    // mid-combat drop straight onto the field like before
    if (this.freeRoamPhase()) {
      return {
        x: PORTAL.x + ((n % 3) - 1) * 1.2,
        z: PORTAL.z - 0.3 - Math.floor(n / 3) * 1.0,
      };
    }
    const a = Math.PI * (0.35 + 0.3 * (n % 4));
    return {
      x: clamp(CRYSTAL_POS.x + Math.cos(a) * 2.2, -HALF_W + 1, HALF_W - 1),
      z: clamp(CRYSTAL_POS.z - Math.abs(Math.sin(a)) * 2.2 - 0.6, -HALF_H + 1, HALF_H - 1),
    };
  }

  // has every hero climbed the stairs and crossed past the crystal to
  // the battlefield side? Required before the first wave can start.
  allCrossed() {
    return this.players.entities.every((p) => p.dead || p.z < CROSS_Z);
  }

  xpNext(lvl) { return Math.round(PLAYER.XP_BASE * Math.pow(lvl, PLAYER.XP_POW)); }

  // (Re)derive every stat from the raw (hero-level-scaled) values +
  // the equipped pet's effects + the equipped weapon & shield. Safe to
  // call at any time: on join, on every hero level-up and whenever the
  // pet or the loadout is swapped.
  applyStats(p) {
    const base = CLASSES[p.cls];
    const fx = petEffects(p.pet?.id, p.pet?.lvl);
    const wfx = weaponEffects(p.weapon?.id, p.weapon?.tier);
    const sfx = weaponEffects(p.shield?.id, p.shield?.tier);
    p.maxHp = Math.round(p.rawMaxHp * fx.hp);
    p.atk = p.rawAtk * fx.atk * wfx.atk;
    p.def = Math.min(base.def + fx.def + sfx.def, PET.DEF_CAP);
    // big heavy weapons (and the great shield) weigh the stride down a bit
    p.speed = base.speed * fx.spd * wfx.move * sfx.move;
    p.rate = base.rate * fx.rate * wfx.rate;
    p.range = base.range + wfx.range;
    p.aoe = (base.aoe || 0) * wfx.aoe;
    p.kbPower = base.knockback * fx.kbMult;
    p.critCh = fx.crit + wfx.crit;
    p.blockCh = sfx.block;  // shield: chance to fully block a hit
    p.stunCh = wfx.stun;    // war hammer: chance to stun on hit
    p.bolts = wfx.bolts;    // arcane orb: guided bolts instead of a blast
    p.luck = fx.luck;
    p.ptsMult = fx.pts;
    p.collectCells = DROPS.COLLECT_CELLS + fx.collect;
    p.kbResist = fx.kbResist;
    p.kbDealt = fx.kbDealt;
    p.jumpCells = fx.jump;
    p.regenMult = fx.regen;
    p.hp = Math.min(p.hp, p.maxHp);
  }

  // swap (or unequip) the companion pet — allowed at any moment; the
  // owning client already validated ownership, the host only sanity-
  // checks the reference and re-derives the stats
  trySetPet(p, act) {
    const pet = sanitizePetRef(act?.pet);
    const changed = p.pet?.id !== pet?.id;
    p.pet = pet;
    this.applyStats(p);
    if (changed && this.phase !== 'lobby') this.emit({ t: 'petswap', id: p.id });
  }

  // swap the equipped weapon/shield — the owning client already
  // validated ownership & tier, the host only sanity-checks the refs
  // against the class arsenal and re-derives the stats
  trySetLoadout(p, act) {
    const weapon = sanitizeWeaponRef(act?.weapon, p.cls, 'weapon');
    const shield = sanitizeWeaponRef(act?.shield, p.cls, 'shield');
    const changed =
      (weapon && (p.weapon?.id !== weapon.id || p.weapon?.tier !== weapon.tier)) ||
      p.shield?.id !== shield?.id || p.shield?.tier !== shield?.tier;
    if (weapon) p.weapon = weapon; // the main weapon can never be unequipped
    p.shield = shield;
    this.applyStats(p);
    if (changed && this.phase !== 'lobby') this.emit({ t: 'wswap', id: p.id });
  }

  // client-authoritative position, sanity-clamped by the host
  setInput(id, { x, z, yaw, m }) {
    const p = this.getPlayer(id);
    if (!p || p.dead) return;
    const dt = Math.max(this.time - p.lastInputT, 0.01);
    p.lastInputT = this.time;
    // mid-dash the character legitimately covers ground far faster
    // than its walk speed, so the anti-teleport clamp opens up
    const speed = p.dashT > 0
      ? (SKILLS.berserker.cells * GRID.CELL) / SKILLS.berserker.dur
      : p.speed;
    const maxStep = speed * dt * 1.8 + 0.6;
    const d = dist2d(p.x, p.z, x, z);
    if (d > maxStep) {
      const f = maxStep / d;
      x = p.x + (x - p.x) * f;
      z = p.z + (z - p.z) * f;
    }
    // mid-jump the character sails over blocked cells, so skip the
    // cell collision resolve (bounds are still enforced). The sanctuary
    // only opens during free-roam phases — once a match is running,
    // there's no walking back down until the next checkpoint.
    const fixed = p.jumpT > 0
      ? { x: clamp(x, -HALF_W + 0.3, HALF_W - 0.3), z: clamp(z, -HALF_H + 0.3, HALF_H - 0.3) }
      : this.grid.resolveCircle(x, z, PLAYER.RADIUS, this.freeRoamPhase());
    p.x = fixed.x; p.z = fixed.z;
    p.moving = !!m;
    if (typeof yaw === 'number') p.yaw = yaw;
  }

  // ---------------- match flow ----------------

  start() {
    const n = this.playerCount();
    this.points = scaleFor(SCALING.startPoints, n);
    const stock = scaleFor(SCALING.startObstacles, n);
    for (const p of this.players) p.obst = stock;
    this.phase = 'build';
    this.wave = 0;
    this.buildTimerOn = false; // first wave starts on demand
    this.emit({ t: 'phase', ph: 'build', n: 1 });
  }

  restart() {
    // wipe entities, keep the roster
    const roster = this.players.entities.map((p) => ({
      id: p.id, name: p.name, cls: p.cls, colors: p.colors, pet: p.pet,
      loadout: { weapon: p.weapon, shield: p.shield },
    }));
    for (const e of [...this.enemies.entities]) this.removeEnemy(e);
    for (const t of [...this.towers.entities]) this.world.remove(t);
    for (const o of [...this.obstacles.entities]) this.world.remove(o);
    for (const p of [...this.players.entities]) this.world.remove(p);
    this.grid = new Grid();
    this.breaches = 0;
    this.spawnQueue = [];
    this.graves = [];
    this.fires = [];
    this.pending = [];
    this.drops = [];
    this.contReady.clear();
    this.trainers.clear();
    // back to a free-roam phase BEFORE re-adding the roster, so every
    // hero of the fresh defense arrives through the portal again
    this.phase = 'lobby';
    for (const r of roster) this.addPlayer(r.id, r.name, r.cls, r.colors, r.pet, r.loadout);
    this.start();
    this.emit({ t: 'restart' });
  }

  startWave() {
    if (this.phase !== 'build' && this.phase !== 'checkpoint') return;
    // the first wave only starts once EVERY hero has walked up from the
    // sanctuary and crossed past the crystal onto the battlefield
    if (this.wave === 0 && !this.allCrossed()) {
      this.emit({ t: 'toast', k: 'toast.crossFirst', kind: 'error' });
      return;
    }
    // training ends the moment a wave marches in
    for (const id of [...this.trainers]) this.exitTraining(id);
    this.wave += 1;
    this.phase = 'combat';
    this.waveStartCount = this.playerCount();
    const plan = buildWavePlan(this.wave, this.waveStartCount);
    this.spawnQueue = plan.map((s) => ({ ...s, at: this.time + s.at }));
    this.emit({ t: 'wave', n: this.wave });
    this.emit({ t: 'phase', ph: 'combat', n: this.wave });
  }

  onWaveCleared() {
    const grant = scaleFor(SCALING.obstaclesPerWave, this.playerCount());
    for (const p of this.players) p.obst = Math.min(p.obst + grant, OBSTACLE_STOCK_CAP);

    if (this.wave % WAVES.CHECKPOINT_EVERY === 0) {
      this.phase = 'checkpoint';
      this.contReady.clear();
      const bonus = Math.round(WAVES.CHECKPOINT_BONUS * this.wave / 10) * this.playerCount();
      this.points += bonus;
      for (const p of this.players) {
        if (p.dead) this.respawnPlayer(p);
        p.hp = p.maxHp;
      }
      this.emit({ t: 'phase', ph: 'checkpoint', n: this.wave });
      this.emit({ t: 'heal', bonus });
    } else {
      this.phase = 'build';
      this.buildT = WAVES.BUILD_TIME;
      this.buildTimerOn = true;
      this.emit({ t: 'phase', ph: 'build', n: this.wave + 1 });
    }
  }

  setContinue(id) {
    if (this.phase !== 'checkpoint') return;
    this.contReady.add(id);
    this.checkContinue();
  }

  checkContinue() {
    if (this.phase !== 'checkpoint') return;
    const all = this.players.entities.every((p) => this.contReady.has(p.id));
    if (all && this.playerCount() > 0) {
      this.phase = 'build';
      this.buildT = WAVES.BUILD_TIME;
      this.buildTimerOn = true;
      this.contReady.clear();
      this.emit({ t: 'phase', ph: 'build', n: this.wave + 1 });
    }
  }

  gameOver() {
    this.phase = 'over';
    this.spawnQueue = [];
    const kills = {};
    for (const p of this.players) kills[p.id] = { name: p.name, kills: p.kills, lvl: p.lvl };
    this.emit({ t: 'over', wave: this.wave, kills });
  }

  // ---------------- building ----------------

  handleAction(id, act) {
    const p = this.getPlayer(id);
    if (!p) return;
    switch (act.t) {
      case 'place': return this.tryPlace(p, act);
      case 'remove': return this.tryRemove(p, act);
      case 'upg': return this.tryUpgrade(p, act);
      case 'spec': return this.trySpecial(p, act);
      case 'sell': return this.trySell(p, act);
      case 'jump': return this.tryJump(p, act);
      case 'skill': return this.trySkill(p, act);
      case 'train': return this.tryTrain(p, act);
      case 'pet': return this.trySetPet(p, act);
      case 'loadout': return this.trySetLoadout(p, act);
      case 'start': if (this.phase === 'build') this.startWave(); return;
      case 'cont': return this.setContinue(id);
      case 'restart': if (this.phase === 'over') this.restart(); return;
    }
  }

  // `key` is an i18n toast key; clients translate it into their own
  // language so the host's language never leaks across the wire
  deny(p, key) { this.emit({ t: 'toast', k: key, to: p.id, kind: 'error' }); }

  cellContents(c, r) {
    for (const t of this.towers) if (t.c === c && t.r === r) return { tower: t };
    for (const o of this.obstacles) if (o.c === c && o.r === r) return { obstacle: o };
    return null;
  }

  enemyCells() {
    return this.enemies.entities
      .filter((e) => !e.flying)
      .map((e) => worldToCell(e.vehicle.position.x, e.vehicle.position.z));
  }

  tryPlace(p, { item, c, r }) {
    if (this.phase === 'over' || this.phase === 'lobby') return;
    const isObstacle = item === 'obstacle';
    if (!isObstacle && !TOWERS[item]) return;
    if (isObstacle && p.obst < 1) return this.deny(p, 'toast.noBlocks');
    const towerDef = TOWERS[item];
    if (towerDef && this.points < towerDef.cost) return this.deny(p, 'toast.notEnoughCrystals');
    if (this.cellContents(c, r)) return this.deny(p, 'toast.spotTaken');
    if (!this.grid.isBuildable(c, r)) return this.deny(p, 'toast.cantBuildThere');
    if (!this.grid.canPlaceAt(c, r, this.enemyCells())) {
      return this.deny(p, 'toast.cantBlockPath');
    }
    // don't build on top of a character
    for (const q of this.players) {
      if (!q.dead) {
        const w = cellToWorld(c, r);
        if (Math.abs(q.x - w.x) < 1 + PLAYER.RADIUS && Math.abs(q.z - w.z) < 1 + PLAYER.RADIUS) {
          return this.deny(p, 'toast.someoneStanding');
        }
      }
    }

    this.grid.setBlocked(c, r, true);
    if (isObstacle) {
      p.obst -= 1;
      const kind = OBSTACLES[(Math.random() * OBSTACLES.length) | 0];
      this.world.add({ obstacle: true, id: nextId(), kind, c, r, owner: p.id });
    } else {
      this.points -= towerDef.cost;
      this.world.add({
        tower: true, id: nextId(), kind: item, c, r, lvl: 1,
        rot: Math.PI, cd: 0.5, invested: towerDef.cost, spec: null,
      });
    }
    this.emit({ t: 'place', c, r, item, by: p.id });
  }

  tryRemove(p, { c, r }) {
    const found = this.cellContents(c, r);
    if (!found?.obstacle) return;
    this.world.remove(found.obstacle);
    this.grid.setBlocked(c, r, false);
    if (found.obstacle.owner === p.id && p.obst < OBSTACLE_STOCK_CAP) p.obst += 1;
    this.emit({ t: 'unplace', c, r });
  }

  tryUpgrade(p, { c, r }) {
    const found = this.cellContents(c, r);
    if (!found?.tower) return;
    const t = found.tower;
    if (t.lvl >= TOWER_LEVEL_MAX) return this.deny(p, 'toast.alreadyMaxLevel');
    const cost = Math.round(TOWERS[t.kind].cost * TOWER_UPGRADE.costMult[t.lvl]);
    if (this.points < cost) return this.deny(p, 'toast.notEnoughCrystals');
    this.points -= cost;
    t.lvl += 1;
    t.invested += cost;
    this.emit({ t: 'upgrade', c, r, lvl: t.lvl });
  }

  // buy a tower's special effect (bonus upgrade). One per tower, ever —
  // where a tower offers two paths, picking one locks the other out.
  trySpecial(p, { c, r, spec }) {
    const found = this.cellContents(c, r);
    if (!found?.tower) return;
    const t = found.tower;
    const def = TOWER_SPECIALS[t.kind]?.[spec];
    if (!def) return;
    if (t.spec) return this.deny(p, 'toast.towerHasSpecial');
    if (this.points < def.cost) return this.deny(p, 'toast.notEnoughCrystals');
    this.points -= def.cost;
    t.spec = spec;
    t.invested += def.cost;
    this.emit({ t: 'spec', c, r, spec });
  }

  trySell(p, { c, r }) {
    const found = this.cellContents(c, r);
    if (!found?.tower) return;
    const refund = Math.round(found.tower.invested * TOWER_UPGRADE.sellRefund);
    this.points += refund;
    this.world.remove(found.tower);
    this.grid.setBlocked(c, r, false);
    this.emit({ t: 'unplace', c, r, refund });
  }

  // hop over the single blocked cell the character is facing; the
  // owning client animates the arc, the host just opens the collision
  // window and tells everyone so they can animate it too
  tryJump(p, act) {
    if (p.dead || p.jumpT > 0 || p.dashT > 0 || this.phase === 'over') return;
    // the hop direction (jyaw) is chosen from proximity to a wall, not
    // the character's gaze — so leave p.yaw untouched (it may be locked
    // onto a foe). Fall back to yaw/facing for older clients.
    const heading = typeof act?.jyaw === 'number' ? act.jyaw
      : typeof act?.yaw === 'number' ? act.yaw : p.yaw;
    const info = canJumpFrom(this.grid, p.x, p.z, heading, p.jumpCells || 1);
    if (!info) return;
    const dur = jumpDurFor(info.span);
    p.jumpT = dur;
    this.emit({ t: 'jump', id: p.id, dur });
  }

  // ---------------- training mode ----------------

  // talk to the drill master while the sanctuary is open to spar with
  // his target dummies: they become real (attackable) enemies until the
  // last trainer leaves — by button, by distance or when a wave starts
  tryTrain(p, act) {
    if (act?.on) {
      if (!this.freeRoamPhase() || this.phase === 'over') return;
      if (this.trainers.has(p.id)) return;
      this.trainers.add(p.id);
      this.ensureDummies();
      this.emit({ t: 'train', id: p.id, on: 1 });
    } else {
      this.exitTraining(p.id);
    }
  }

  exitTraining(id) {
    if (!this.trainers.delete(id)) return;
    this.emit({ t: 'train', id, on: 0 });
    if (this.trainers.size === 0) this.removeDummies();
  }

  ensureDummies() {
    if (this.enemies.entities.some((e) => e.dummy)) return;
    for (const d of DUMMIES) this.spawnDummy(d.x, d.z);
  }

  removeDummies() {
    for (const e of [...this.enemies.entities]) {
      if (e.dummy) this.removeEnemy(e);
    }
  }

  // a stationary, harmless enemy entity standing exactly where the
  // static yard props are — full HP pool, no drops, springs back to
  // full whenever depleted (see damageEnemy)
  spawnDummy(x, z) {
    const vehicle = new Vehicle();
    vehicle.position.set(x, 0, z);
    vehicle.maxSpeed = 0;
    vehicle.updateOrientation = false;
    this.ai.add(vehicle);
    const e = this.world.add({
      enemy: true, dummy: true, id: nextId(), kind: 'dummy', vehicle,
      hp: 600, maxHp: 600, dmg: 0, speed: 0, pts: 0, xp: 0,
      scale: 1, breach: 0, boss: 0, flying: false, state: 'path', targetId: null,
      atkCd: 0, kbx: 0, kbz: 0, yaw: -Math.PI / 2, stunT: 0,
      aggroCd: 0, chaseBestD: 0, dragT: 0,
      slowT: 0, slowF: 1, burnT: 0, burnDps: 0, poisonT: 0, poisonDps: 0,
      dotTick: 0, armor: 0, revives: 0, horde: null, variant: null, vr: 0,
      archer: null, jumper: false, jump: null, jumpCd: 9999,
      chainJumps: 0, chainLeft: 0, chainT: 0,
      summoner: false, summonCd: 9999, pumpkin: null, movingFlag: false,
    });
    this.emit({ t: 'spawn', id: e.id, kind: 'dummy', boss: 0 });
    return e;
  }

  // ---------------- class special attacks ----------------

  // each character has its own cooldown timer (p.skillCd); a skill that
  // finds no valid target refuses to fire (and refuses to burn it)
  trySkill(p, act) {
    if (p.dead || p.skillCd > 0 || p.jumpT > 0 || p.dashT > 0) return;
    if (this.phase === 'over' || this.phase === 'lobby') return;
    if (typeof act?.yaw === 'number') p.yaw = act.yaw;
    const cast = {
      berserker: () => this.skillBerserker(p),
      tanker: () => this.skillTanker(p),
      archer: () => this.skillArcher(p),
      mage: () => this.skillMage(p),
    }[p.cls];
    if (!cast || cast() === false) return;
    p.skillCd = SKILLS.COOLDOWN;
  }

  // dash up to N cells forward; every enemy along the line is hit the
  // moment the berserker reaches it and flung backward. Movement stays
  // client-authoritative (the owning client predicts the same dash);
  // dashT just opens the speed clamp, like jumpT does for hops.
  skillBerserker(p) {
    const S = SKILLS.berserker;
    const end = computeDashEnd(this.grid, p.x, p.z, p.yaw, S.cells);
    const fx = p.x, fz = p.z;
    const dx = end.x - fx, dz = end.z - fz;
    const len2 = dx * dx + dz * dz;
    p.dashT = S.dur;
    const dmg = p.atk * S.dmgMult;
    for (const e of this.enemies) {
      const ep = e.vehicle.position;
      const t = len2 > 0.001
        ? clamp(((ep.x - fx) * dx + (ep.z - fz) * dz) / len2, 0, 1)
        : 0;
      if (dist2d(fx + dx * t, fz + dz * t, ep.x, ep.z) > S.width + ENEMY.RADIUS) continue;
      const id = e.id, pid = p.id;
      // flung along the charge, whichever way it was aimed
      const dl = Math.sqrt(len2) || 1;
      const kx = (dx / dl) * S.kb, kz = (dz / dl) * S.kb;
      this.pending.push({ at: this.time + S.dur * t, fn: () => {
        const hit = this.enemies.entities.find((n) => n.id === id);
        if (hit) this.damageEnemy(hit, dmg, kx, kz, pid);
      }});
    }
    this.emit({
      t: 'skill', cls: 'berserker', id: p.id,
      x: rnd2(fx), z: rnd2(fz), tx: rnd2(end.x), tz: rnd2(end.z), dur: S.dur,
    });
  }

  // wall mode: no knockback + doubled defense, applied in damagePlayer
  skillTanker(p) {
    p.wallT = SKILLS.tanker.dur;
    this.emit({ t: 'skill', cls: 'tanker', id: p.id, dur: SKILLS.tanker.dur });
  }

  skillArcher(p) {
    const S = SKILLS.archer;
    if (!this.archerVolley(p)) return false; // needs a target in range
    for (let b = 1; b < S.bursts; b++) {
      const pid = p.id;
      this.pending.push({ at: this.time + b * S.gap, fn: () => {
        const q = this.getPlayer(pid);
        if (q && !q.dead && this.phase !== 'over') this.archerVolley(q);
      }});
    }
    this.emit({ t: 'skill', cls: 'archer', id: p.id });
    return true;
  }

  // one volley: 5 arrows split across the nearest enemies in range
  // (cycling over them when fewer than 5 remain)
  archerVolley(p) {
    const S = SKILLS.archer;
    const range = p.range * S.rangeMult;
    const foes = [];
    for (const e of this.enemies) {
      const ep = e.vehicle.position;
      const d = dist2d(p.x, p.z, ep.x, ep.z);
      if (d <= range + ENEMY.RADIUS) foes.push({ e, d });
    }
    if (!foes.length) {
      if (p.skillCd <= 0) this.deny(p, 'toast.noEnemiesInRange');
      return false;
    }
    foes.sort((a, b) => a.d - b.d);
    const targets = foes.slice(0, S.arrows);
    const aim = targets[0].e.vehicle.position;
    p.yaw = Math.atan2(aim.x - p.x, aim.z - p.z);
    this.emit({ t: 'atk', id: p.id, tx: rnd2(aim.x), tz: rnd2(aim.z) });
    for (let i = 0; i < S.arrows; i++) {
      const f = targets[i % targets.length];
      const tp = f.e.vehicle.position;
      const ft = Math.max(f.d / 18, 0.06);
      this.emit({
        t: 'shoot', k: 'arrow',
        f: [rnd2(p.x), 1.0, rnd2(p.z)], to: [rnd2(tp.x), 0.7, rnd2(tp.z)], ft: rnd2(ft),
      });
      const id = f.e.id, dmg = p.atk * S.dmgMult, pid = p.id, ox = p.x, oz = p.z;
      const kb = 0.4 + (p.kbDealt || 0);
      this.pending.push({ at: this.time + ft, fn: () => {
        const e = this.enemies.entities.find((n) => n.id === id);
        if (!e) return;
        const [kx, kz] = kbAway(ox, oz, e.vehicle.position, kb);
        this.damageEnemy(e, dmg, kx, kz, pid);
      }});
    }
    return true;
  }

  // giant arcane orb lobbed at the nearest enemy: blast area and
  // damage far beyond the mage's normal attack
  skillMage(p) {
    const S = SKILLS.mage;
    let best = null, bestD = Infinity;
    for (const e of this.enemies) {
      const d = dist2d(p.x, p.z, e.vehicle.position.x, e.vehicle.position.z);
      if (d < bestD) { bestD = d; best = e; }
    }
    if (!best || bestD > p.range * S.rangeMult + ENEMY.RADIUS) {
      this.deny(p, 'toast.noEnemiesInRange');
      return false;
    }
    const tp = best.vehicle.position;
    const cx = tp.x, cz = tp.z;
    // the Arcane Orb skill is a big blast even for the orb weapon (whose
    // normal attack has no area at all, p.aoe === 0) — floor the radius
    // to the class's base area so the skill never collapses to nothing
    const baseAoe = Math.max(p.aoe || 0, CLASSES[p.cls].aoe || 1.9);
    const r = baseAoe * S.aoeMult, dmg = p.atk * S.dmgMult, kb = p.kbPower * S.kbMult;
    const ft = S.flightT;
    const wt = p.weapon?.tier || 0;
    p.yaw = Math.atan2(cx - p.x, cz - p.z);
    this.emit({ t: 'atk', id: p.id, tx: rnd2(cx), tz: rnd2(cz), wt });
    this.emit({
      t: 'shoot', k: 'magic', big: 1, wt,
      f: [rnd2(p.x), 1.3, rnd2(p.z)], to: [rnd2(cx), 0.5, rnd2(cz)], ft,
    });
    this.emit({ t: 'aoe', x: rnd2(cx), z: rnd2(cz), r: rnd2(r), k: 'mage', ft, big: 1, wt });
    const pid = p.id;
    this.pending.push({ at: this.time + ft, fn: () => {
      for (const e of [...this.enemies.entities]) {
        const ep = e.vehicle.position;
        const d = dist2d(cx, cz, ep.x, ep.z);
        if (d <= r + ENEMY.RADIUS) {
          const n = Math.max(d, 0.2);
          this.damageEnemy(e, dmg, ((ep.x - cx) / n) * kb, ((ep.z - cz) / n) * kb, pid);
        }
      }
    }});
    this.emit({ t: 'skill', cls: 'mage', id: p.id });
  }

  towerStats(t) {
    const def = TOWERS[t.kind];
    const m = t.lvl - 1;
    // the crystal's pulse radius grows with every level (aoeGrow);
    // its range is always the same as the pulse so "in range" == "hit"
    const aoe = def.aoe + (def.aoeGrow || 0) * m;
    return {
      dmg: def.dmg * Math.pow(TOWER_UPGRADE.dmgMult, m),
      range: def.pulse ? aoe : def.range + TOWER_UPGRADE.rangeAdd * m,
      rate: def.rate * Math.pow(TOWER_UPGRADE.rateMult, m),
      aoe, minRange: def.minRange || 0, projSpeed: def.projSpeed, lob: def.lob,
      ammo: def.ammo, pulse: def.pulse, jet: def.jet,
      burnDps: def.burnDps ? def.burnDps * Math.pow(TOWER_UPGRADE.dmgMult, m) : 0,
      burnDur: def.burnDur || 0,
    };
  }

  // ---------------- enemies ----------------

  // `at` (optional {x,z}) drops the enemy mid-board — used by the
  // gravedigger's tombs; otherwise it walks in from a top spawn pad.
  // `horde` marks a Zombie Horde trooper color ('green'|'blue'|'red');
  // `tier` (2|3) the mid/large power stages of later waves.
  spawnEnemy(kind, boss, variant = null, at = null, horde = null, tier = 1) {
    const def = ENEMIES[kind];
    const s = GRID.SPAWNS[this.spawnIdx++ % GRID.SPAWNS.length];
    const w = at || cellToWorld(s.c, s.r);
    // walk-in spawns start hidden inside the dark woods north of the
    // board and march down out of the penumbra
    if (!at) w.z = -HALF_H - 2.5 - Math.random() * 2.5;
    const stats = enemyStats(kind, boss, this.wave, this.waveStartCount, variant, horde, tier);
    const bossDef = boss === 2 ? BOSSES[variant] : null;

    const vehicle = new Vehicle();
    vehicle.position.set(w.x + (Math.random() - 0.5) * 0.8, 0, w.z + (Math.random() - 0.5) * 0.5);
    vehicle.maxSpeed = stats.speed;
    vehicle.maxForce = 24;
    vehicle.updateNeighborhood = true;
    vehicle.neighborhoodRadius = 1.6;
    vehicle.boundingRadius = ENEMY.RADIUS;
    vehicle.updateOrientation = false;

    const seek = new SeekBehavior(vehicle.position.clone());
    seek.target.z += 2;
    const sep = new SeparationBehavior();
    sep.weight = ENEMY.SEPARATION_WEIGHT;
    vehicle.steering.add(seek);
    vehicle.steering.add(sep);
    this.ai.add(vehicle);

    // ranged skeletons; the boss variant looses a volley at everyone
    let archer = def.archer ? { ...def.archer } : null;
    if (archer && bossDef?.multishot) {
      archer.range += 1.5;
      archer.multishot = true;
    }

    const e = this.world.add({
      enemy: true, id: nextId(), kind, vehicle, seek,
      hp: stats.hp, maxHp: stats.hp, dmg: stats.dmg, speed: stats.speed,
      pts: stats.pts, xp: stats.xp, scale: stats.scale, breach: stats.breach,
      boss, flying: !!def.flying, state: 'path', targetId: null,
      atkCd: 0, kbx: 0, kbz: 0, yaw: 0, stunT: 0,
      aggroCd: 0, chaseBestD: 0, dragT: 0,
      // status effects (towers): chill slow, fire / poison DoTs
      slowT: 0, slowF: 1, burnT: 0, burnDps: 0, poisonT: 0, poisonDps: 0,
      dotTick: 0,
      // toughness & second lives
      armor: stats.armor || 0,
      revives: stats.revives || 0,
      horde, // 'green' | 'blue' | 'red' | null
      variant: boss === 2 ? variant : null,
      // visual-variant code for the snapshot: 1 stage-2 look, 2 stage-3
      // look (recolored hide + size), 3 Brutus (props); 0 plain
      vr: boss === 2
        ? (variant === 'brutus' ? 3 : 0)
        : (stats.tier === 2 ? 1 : stats.tier === 3 ? 2 : 0),
      // special powers
      archer,
      jumper: !!def.jumper && !def.flying,
      jump: null,
      jumpCd: ENEMY.JUMP_EVERY * (0.4 + Math.random() * 0.6),
      chainJumps: bossDef?.jumps || 1,
      chainLeft: 0, chainT: 0,
      summoner: !!def.summoner, summonCd: SUMMON.FIRST,
      pumpkin: bossDef?.pumpkin || null,
    });
    const ev = { t: 'spawn', id: e.id, kind, boss };
    if (at) { ev.g = 1; ev.x = rnd2(w.x); ev.z = rnd2(w.z); } // rose from a tomb
    this.emit(ev);
    // carry the boss VARIANT / enemy KIND so clients localize the name &
    // flavor themselves (name kept as a fallback for older clients)
    if (boss === 2) this.emit({ t: 'boss', variant, kind, name: bossDef?.name || def.name || kind });
    else if (boss === 1) this.emit({ t: 'subboss', kind, name: def.name || kind });
    return e;
  }

  removeEnemy(e) {
    this.ai.remove(e.vehicle);
    this.world.remove(e);
    // the gravedigger's tombs crumble with him
    if (e.summoner && this.graves.length) {
      this.graves = this.graves.filter((g) => g.owner !== e.id);
    }
  }

  damageEnemy(e, dmg, kbx, kbz, killerId) {
    if (e.hp <= 0) return;
    const killer = killerId ? this.getPlayer(killerId) : null;
    // critical hits (tiger pet): player-dealt damage only, never towers
    if (killer && killer.critCh > 0 && Math.random() < killer.critCh) {
      dmg *= PET.CRIT_MULT;
      const pos = e.vehicle.position;
      this.emit({ t: 'crit', x: rnd2(pos.x), z: rnd2(pos.z) });
    }
    // heavy armor (Brutus): flat reduction on every hit, any source
    if (e.armor > 0) dmg *= 1 - e.armor;
    e.hp -= dmg;
    // training dummies never die (or aggro, or get knocked around):
    // on depletion they spring straight back to full
    if (e.dummy) {
      this.emit({ t: 'hit', id: e.id });
      if (e.hp <= 0) {
        e.hp = e.maxHp;
        const pos = e.vehicle.position;
        this.emit({ t: 'dreset', x: rnd2(pos.x), z: rnd2(pos.z) });
      }
      return;
    }
    // knockback shoves the enemy BACKWARD along the direction the hit
    // travelled — away from whoever landed it, whatever side that is (a
    // stab in the back sends it forward, not blindly away from the crystal).
    // Only player-dealt blows knock back: tower attacks and DoT ticks pass
    // no killer and deal damage only, their stun/slow/etc. coming from
    // their own specials — never a default shove.
    if (killer && (kbx || kbz)) {
      e.kbx += kbx;
      e.kbz += kbz;
      // clamp the accumulated impulse so a pile-up of simultaneous hits
      // can't fling the enemy across the board (or through a wall)
      const acc = Math.hypot(e.kbx, e.kbz);
      if (acc > ENEMY.KB_MAX) {
        const s = ENEMY.KB_MAX / acc;
        e.kbx *= s; e.kbz *= s;
      }
    }
    this.emit({ t: 'hit', id: e.id });
    // getting shot/blasted pulls aggro — but only under the same rules
    // as proximity: clear line to the attacker and crystal not closer
    if (e.hp > 0 && killer && !killer.dead && e.state !== 'chase') {
      const pos = e.vehicle.position;
      const d = dist2d(pos.x, pos.z, killer.x, killer.z);
      if (d <= ENEMY.LEASH_RADIUS && this.canAggro(e, killer, d)) {
        this.startChase(e, killer);
      }
    }
    // war hammer bonus: chance to stun (bosses shrug most of it off)
    if (e.hp > 0 && killer && killer.stunCh > 0 && Math.random() < killer.stunCh) {
      const dur = e.boss ? STUN.DUR * STUN.BOSS_MULT : STUN.DUR;
      if (dur > (e.stunT || 0)) e.stunT = dur;
      const pos = e.vehicle.position;
      this.emit({ t: 'stun', id: e.id, x: rnd2(pos.x), z: rnd2(pos.z) });
    }
    if (e.hp <= 0) {
      const pos = e.vehicle.position;
      // blue/red horde zombies claw back up instead of dying — no drops
      // until the LAST life goes; status effects are washed off
      if (e.revives > 0) {
        e.revives -= 1;
        e.hp = e.maxHp;
        e.kbx = 0; e.kbz = 0;
        e.burnT = 0; e.poisonT = 0; e.slowT = 0;
        e.stunT = Math.max(e.stunT, 0.9); // a beat on the ground before rising
        this.emit({ t: 'revive', id: e.id, x: rnd2(pos.x), z: rnd2(pos.z) });
        return;
      }
      this.emit({ t: 'die', id: e.id, kind: e.kind, x: rnd2(pos.x), z: rnd2(pos.z), boss: e.boss });
      if (killer) killer.kills += 1;
      // nothing is granted on the kill itself — the enemy drops XP and
      // point orbs that each player has to walk over to collect
      this.spawnDrops(e);
      this.removeEnemy(e);
      this.checkWaveCleared();
    }
  }

  // ---------------- aggro rules ----------------

  // clear straight path over the grid between two world points: no
  // tower/obstacle cell may sit between them. Cells outside the board
  // (the spawn woods) never block. Flying enemies skip this entirely.
  hasLos(x1, z1, x2, z2) {
    const steps = Math.ceil(dist2d(x1, z1, x2, z2) / (GRID.CELL * 0.35));
    for (let i = 1; i < steps; i++) {
      const k = i / steps;
      const { c, r } = worldToCell(x1 + (x2 - x1) * k, z1 + (z2 - z1) * k);
      if (inBounds(c, r) && this.grid.blocked[idx(c, r)] === 1) return false;
    }
    return true;
  }

  // may enemy `e` take the bait `p` standing `d` away? The crystal
  // always outranks the character when it's the closer of the two.
  canAggro(e, p, d) {
    if ((e.aggroCd || 0) > 0) return false;
    const pos = e.vehicle.position;
    if (dist2d(pos.x, pos.z, CRYSTAL_POS.x, CRYSTAL_POS.z) <= d) return false;
    return e.flying || this.hasLos(pos.x, pos.z, p.x, p.z);
  }

  startChase(e, p) {
    const pos = e.vehicle.position;
    e.state = 'chase';
    e.targetId = p.id;
    // closest-yet approach to the crystal — the anti-kiting reference
    e.chaseBestD = dist2d(pos.x, pos.z, CRYSTAL_POS.x, CRYSTAL_POS.z);
    e.dragT = 0;
  }

  // ---------------- status effects (tower specials) ----------------

  applySlow(e, factor, dur) {
    e.slowF = Math.min(factor, e.boss === 2 ? 0.75 : factor); // bosses resist chill
    e.slowT = Math.max(e.slowT, dur);
  }

  applyDot(e, kind, dps, dur) {
    // fire and poison are separate channels; re-applying refreshes the
    // stronger of the two rather than stacking endlessly
    if (kind === STATUS.POISON_KIND) {
      e.poisonDps = Math.max(e.poisonDps * (e.poisonT > 0 ? 1 : 0), dps);
      e.poisonT = Math.max(e.poisonT, dur);
    } else {
      e.burnDps = Math.max(e.burnDps * (e.burnT > 0 ? 1 : 0), dps);
      e.burnT = Math.max(e.burnT, dur);
    }
  }

  // burn/poison tick on a shared clock per enemy so the 'hit' flash
  // doesn't spam every single frame
  stepStatus(e, dt) {
    if (e.slowT > 0) e.slowT = Math.max(e.slowT - dt, 0);
    const burning = e.burnT > 0, poisoned = e.poisonT > 0;
    if (!burning && !poisoned) return;
    if (burning) e.burnT = Math.max(e.burnT - dt, 0);
    if (poisoned) e.poisonT = Math.max(e.poisonT - dt, 0);
    e.dotTick -= dt;
    if (e.dotTick <= 0) {
      e.dotTick = STATUS.DOT_TICK;
      const dps = (burning ? e.burnDps : 0) + (poisoned ? e.poisonDps : 0);
      if (dps > 0) this.damageEnemy(e, dps * STATUS.DOT_TICK, 0, 0, null);
    }
  }

  // ---------------- burning ground (cannon napalm) ----------------

  stepFires(dt) {
    if (!this.fires.length) return;
    this.fires = this.fires.filter((f) => f.until > this.time);
    for (const f of this.fires) {
      for (const e of this.enemies) {
        if (e.flying) continue; // ghosts drift above the flames
        const ep = e.vehicle.position;
        if (dist2d(f.x, f.z, ep.x, ep.z) <= f.r + ENEMY.RADIUS) {
          this.applyDot(e, STATUS.FIRE_KIND, f.dps, 1.0);
        }
      }
    }
  }

  // ---------------- drops (XP / point orbs) ----------------

  spawnDrops(e) {
    const pos = e.vehicle.position;
    const n = Math.max(this.playerCount(), 1);
    // the shared point pool only grows when orbs are picked up, so each
    // player's orb carries their slice of the kill's value
    const ptsBase = (e.pts * scaleFor(SCALING.points, n)) / n;
    // (mini-)bosses also drop permanent gold coins — one orb for EVERY
    // player, so the whole party earns the same; the bunny pet's luck
    // can double an individual player's coins
    const gold = e.boss === 2 ? GOLD.BOSS : e.boss === 1 ? GOLD.SUBBOSS : 0;
    for (const p of this.players) {
      this.addDrop(p.id, 'xp', e.xp, pos.x, pos.z);
      // the pig pet fattens its owner's share of the points
      this.addDrop(p.id, 'pts', Math.max(1, Math.round(ptsBase * (p.ptsMult || 1))), pos.x, pos.z);
      if (gold > 0) {
        // the bunny pet's luck can double the haul
        const coins = p.luck > 0 && Math.random() < p.luck ? gold * 2 : gold;
        // one physical coin per unit — gold never merges, so 2/3/4 coins
        // really are 2/3/4 pickups scattered on the ground
        for (let i = 0; i < coins; i++) this.addDrop(p.id, 'gold', 1, pos.x, pos.z);
      }
    }
  }

  addDrop(owner, kind, amount, x, z) {
    const ttl = kind === 'gold' ? GOLD.TTL : DROPS.TTL;
    // deaths cluster around chokepoints — merge nearby same-kind orbs so
    // the ground (and the snapshot) never floods. Gold is the exception:
    // every coin is its own physical pickup, so it never merges.
    if (kind !== 'gold') {
      for (const d of this.drops) {
        if (d.owner === owner && d.kind === kind &&
            dist2d(d.x, d.z, x, z) < DROPS.MERGE_RADIUS) {
          d.amount += amount;
          d.until = this.time + ttl;
          return;
        }
      }
    }
    // gold coins spread out a bit wider so a boss's stack reads as several
    const spread = kind === 'gold' ? 1.5 : 0.9;
    const jit = () => (Math.random() - 0.5) * spread;
    const fixed = this.grid.resolveCircle(x + jit(), z + jit(), 0.3);
    this.drops.push({
      id: nextId(), owner, kind, amount,
      x: fixed.x, z: fixed.z, until: this.time + ttl,
    });
    if (this.drops.length > DROPS.MAX) this.drops.shift();
  }

  stepDrops(dt) {
    if (!this.drops.length) return;
    const keep = [];
    for (const d of this.drops) {
      if (d.until <= this.time) continue;
      const p = this.getPlayer(d.owner);
      if (!p) continue; // owner left the match
      // an orb the owner can reach (see collectRange) is "claimed": it
      // rushes toward them and pops the instant it arrives
      if (!p.dead && this.collectRange(p, d)) {
        const dist = dist2d(d.x, d.z, p.x, p.z);
        if (dist <= DROPS.ABSORB_RADIUS) {
          if (d.kind === 'xp') this.grantXp(p, d.amount);
          else if (d.kind === 'pts') this.points += d.amount;
          // gold is permanent per-character currency: the sim only
          // announces the pickup — the owning client banks it locally
          this.emit({ t: 'pickup', id: p.id, k: d.kind, amt: d.amount });
          continue;
        }
        const pull = Math.min((DROPS.MAGNET_SPEED * dt) / Math.max(dist, 0.001), 1);
        d.x += (p.x - d.x) * pull;
        d.z += (p.z - d.z) * pull;
      }
      keep.push(d);
    }
    this.drops = keep;
  }

  // Can player `p` reach its orb `d` from where it currently stands?
  // Grid-based, not a plain radius: an orb anywhere in the 3×3 block of
  // cells around the character (one cell to every side) is reachable,
  // and so is one exactly two cells away along a straight line whose
  // single middle cell is a tower/obstacle — reaching over a lone wall.
  // Anything else means the character has to move closer.
  collectRange(p, d) {
    const pc = worldToCell(p.x, p.z);
    const oc = worldToCell(d.x, d.z);
    const dc = oc.c - pc.c, dr = oc.r - pc.r;
    const ac = Math.abs(dc), ar = Math.abs(dr);
    // the giraffe pet stretches the base 3×3 sweep a cell at a time
    if (Math.max(ac, ar) <= (p.collectCells || DROPS.COLLECT_CELLS)) return true;
    // two cells out (orthogonal or diagonal) over exactly one blocked cell
    if (DROPS.REACH_OVER_BLOCKER &&
        (ac === 0 || ac === 2) && (ar === 0 || ar === 2) &&
        Math.max(ac, ar) === 2) {
      return this.grid.isBlocked(pc.c + dc / 2, pc.r + dr / 2);
    }
    return false;
  }

  grantXp(p, xp) {
    if (p.lvl >= PLAYER.LEVEL_CAP) return;
    p.xp += xp;
    while (p.xp >= p.xpNext && p.lvl < PLAYER.LEVEL_CAP) {
      p.xp -= p.xpNext;
      p.lvl += 1;
      p.xpNext = this.xpNext(p.lvl);
      // grow the raw stats, then re-layer the pet + weapon bonuses on top
      p.rawMaxHp = Math.round(p.rawMaxHp * PLAYER.LEVEL_HP_MULT);
      p.rawAtk *= PLAYER.LEVEL_ATK_MULT;
      this.applyStats(p);
      p.hp = Math.min(p.maxHp, p.hp + (p.maxHp - p.hp) * PLAYER.LEVEL_HEAL);
      this.emit({ t: 'lvl', id: p.id, lvl: p.lvl });
    }
  }

  damagePlayer(p, rawDmg, kbx, kbz) {
    if (p.dead) return;
    // invulnerability frames: a brief window after any hit lands during
    // which the character simply can't be hurt again. This is the hard
    // guarantee that HP can NEVER drain in a rapid loop — no matter how
    // many enemies pile onto the same spot (or get shoved into a wall on
    // top of you), you take at most one hit per window. Legitimate combat
    // is unaffected: a lone enemy swings far slower than this.
    if (p.invT > 0) return;
    // shields can block a hit outright — no damage, no knockback
    if (p.blockCh > 0 && Math.random() < p.blockCh) {
      this.emit({ t: 'block', id: p.id, x: rnd2(p.x), z: rnd2(p.z) });
      return;
    }
    // wall mode (tanker skill): doubled defense, immune to knockback
    const wall = p.wallT > 0;
    const def = wall ? Math.min(p.def * SKILLS.tanker.defMult, SKILLS.tanker.defCap) : p.def;
    if (wall) { kbx = 0; kbz = 0; }
    // the elephant pet plants its owner's feet: knockback taken shrinks
    if (p.kbResist > 0) { kbx *= 1 - p.kbResist; kbz *= 1 - p.kbResist; }
    const dmg = rawDmg * (1 - def);
    p.hp -= dmg;
    p.lastDmg = this.time;
    p.invT = PLAYER.HIT_IFRAME; // open the i-frame window
    this.emit({ t: 'hit', id: p.id });
    if (kbx || kbz) this.emit({ t: 'kb', id: p.id, dx: rnd2(kbx), dz: rnd2(kbz) });
    if (p.hp <= 0) {
      p.hp = 0;
      p.dead = true;
      p.moving = false;
      p.respawnT = Math.min(
        PLAYER.RESPAWN_BASE + PLAYER.RESPAWN_PER_WAVE * this.wave,
        PLAYER.RESPAWN_MAX
      );
      this.emit({ t: 'die', id: p.id, player: true });
      // enemies chasing this player go back to the path
      for (const e of this.enemies) {
        if (e.targetId === p.id) { e.state = 'path'; e.targetId = null; }
      }
    }
  }

  respawnPlayer(p) {
    const s = this.playerSpawnPos();
    p.dead = false;
    p.hp = p.maxHp;
    p.x = s.x; p.z = s.z;
    p.lastDmg = -99;
    p.invT = 0;
    this.emit({ t: 'respawn', id: p.id, x: rnd2(s.x), z: rnd2(s.z) });
  }

  checkWaveCleared() {
    if (this.phase !== 'combat') return;
    if (this.spawnQueue.length === 0 && this.enemies.entities.length === 0 &&
        this.graves.length === 0) {
      this.onWaveCleared();
    }
  }

  // ---------------- gravedigger tombs ----------------

  // a tomb bursts out of the ground on a free cell near the keeper and
  // keeps disgorging zombies/skeletons until it is spent
  raiseGrave(e) {
    const pos = e.vehicle.position;
    const { c, r } = worldToCell(pos.x, pos.z);
    const options = [];
    for (let dc = -SUMMON.RADIUS; dc <= SUMMON.RADIUS; dc++) {
      for (let dr = -SUMMON.RADIUS; dr <= SUMMON.RADIUS; dr++) {
        const nc = c + dc, nr = r + dr;
        if (!this.grid.isWalkable(nc, nr)) continue;
        if (this.grid.dist[idx(nc, nr)] === -1) continue; // sealed pocket
        const w = cellToWorld(nc, nr);
        // not right at the crystal's feet
        if (dist2d(w.x, w.z, CRYSTAL_POS.x, CRYSTAL_POS.z) < 3) continue;
        options.push(w);
      }
    }
    if (!options.length) return;
    const w = options[(Math.random() * options.length) | 0];
    const g = {
      id: nextId(), owner: e.id, x: w.x, z: w.z,
      spawnsLeft: SUMMON.PER_GRAVE, nextAt: this.time + SUMMON.INTERVAL,
    };
    this.graves.push(g);
    this.emit({ t: 'grave', id: g.id, x: rnd2(w.x), z: rnd2(w.z) });
  }

  stepGraves() {
    if (!this.graves.length) return;
    const keep = [];
    for (const g of this.graves) {
      if (this.time >= g.nextAt) {
        g.nextAt = this.time + SUMMON.INTERVAL;
        g.spawnsLeft -= 1;
        const kind = SUMMON.KINDS[(Math.random() * SUMMON.KINDS.length) | 0];
        this.spawnEnemy(kind, 0, null, {
          x: g.x + (Math.random() - 0.5) * 0.6,
          z: g.z + (Math.random() - 0.5) * 0.6,
        });
      }
      if (g.spawnsLeft > 0) keep.push(g);
    }
    this.graves = keep;
  }

  // ---------------- enemy ranged attacks ----------------

  // arrow at one character: telegraphed flight, damage on impact
  shootArrowAt(e, p, dist) {
    const pos = e.vehicle.position;
    const ft = Math.max(dist / e.archer.projSpeed, 0.08);
    this.emit({
      t: 'shoot', k: 'arrow',
      f: [rnd2(pos.x), 1.1, rnd2(pos.z)], to: [rnd2(p.x), 0.8, rnd2(p.z)], ft: rnd2(ft),
    });
    const id = p.id, dmg = e.dmg, fx = pos.x, fz = pos.z;
    this.pending.push({ at: this.time + ft, fn: () => {
      const q = this.getPlayer(id);
      if (!q || q.dead) return;
      const n = Math.max(dist2d(fx, fz, q.x, q.z), 0.2);
      this.damagePlayer(q, dmg, ((q.x - fx) / n) * 1.1, ((q.z - fz) / n) * 1.1);
    }});
  }

  // lobbed pumpkin: area damage on every character near the impact
  throwPumpkinAt(e, p, dist) {
    const pos = e.vehicle.position;
    const pk = e.pumpkin;
    const ft = Math.max(dist / pk.projSpeed, 0.3);
    const cx = p.x, cz = p.z;
    this.emit({
      t: 'shoot', k: 'pumpkin', lob: 1,
      f: [rnd2(pos.x), 1.5, rnd2(pos.z)], to: [rnd2(cx), 0.3, rnd2(cz)], ft: rnd2(ft),
    });
    this.emit({ t: 'aoe', x: rnd2(cx), z: rnd2(cz), r: pk.aoe, k: 'pumpkin', ft: rnd2(ft) });
    this.pending.push({ at: this.time + ft, fn: () => {
      for (const q of this.players) {
        if (q.dead) continue;
        const d = dist2d(cx, cz, q.x, q.z);
        if (d > pk.aoe + PLAYER.RADIUS) continue;
        const n = Math.max(d, 0.2);
        this.damagePlayer(q, pk.dmg, ((q.x - cx) / n) * 2.2, ((q.z - cz) / n) * 2.2);
      }
    }});
  }

  // ---------------- main tick ----------------

  step(dt) {
    this.time += dt;

    // scheduled impacts / delayed damage
    if (this.pending.length) {
      const due = this.pending.filter((s) => s.at <= this.time);
      if (due.length) {
        this.pending = this.pending.filter((s) => s.at > this.time);
        for (const s of due) s.fn();
      }
    }

    if (this.phase === 'build' && this.buildTimerOn) {
      this.buildT -= dt;
      if (this.buildT <= 0) this.startWave();
    }

    if (this.phase === 'combat' && this.spawnQueue.length) {
      while (this.spawnQueue.length && this.spawnQueue[0].at <= this.time) {
        const s = this.spawnQueue.shift();
        // the Zombie Horde announces itself once, on its first spawn
        if (s.announce) this.emit({ t: 'boss', variant: s.announce });
        this.spawnEnemy(s.kind, s.boss, s.variant, null, s.horde || null, s.tier || 1);
      }
    }

    // training mode ends on its own when a trainer strays too far from
    // the drill master's yard (or falls, or leaves)
    if (this.trainers.size) {
      for (const id of [...this.trainers]) {
        const p = this.getPlayer(id);
        if (!p || p.dead ||
            dist2d(p.x, p.z, NPCS.treino.x, NPCS.treino.z) > TRAIN.RADIUS) {
          this.exitTraining(id);
        }
      }
    }

    this.stepPlayers(dt);
    this.stepDrops(dt);
    this.stepGraves();
    this.stepFires(dt);
    this.stepEnemies(dt);
    this.stepTowers(dt);

    this.ai.update(dt);
    this.postAiFixup(dt);

    if (this.phase === 'combat') this.checkWaveCleared();
  }

  stepPlayers(dt) {
    for (const p of this.players) {
      if (p.skillCd > 0) p.skillCd = Math.max(p.skillCd - dt, 0);
      if (p.wallT > 0) p.wallT = Math.max(p.wallT - dt, 0);
      if (p.invT > 0) p.invT = Math.max(p.invT - dt, 0);
      if (p.dead) {
        p.respawnT -= dt;
        if (p.respawnT <= 0 && this.phase !== 'over') this.respawnPlayer(p);
        continue;
      }
      // regen (the panda pet speeds it up)
      if (this.time - p.lastDmg > PLAYER.REGEN_DELAY && p.hp < p.maxHp) {
        p.hp = Math.min(p.maxHp, p.hp + p.maxHp * PLAYER.REGEN_RATE * (p.regenMult || 1) * dt);
      }
      // no attacking mid-air or mid-dash
      if (p.jumpT > 0) { p.jumpT = Math.max(p.jumpT - dt, 0); continue; }
      if (p.dashT > 0) { p.dashT = Math.max(p.dashT - dt, 0); continue; }
      // auto-attack nearest enemy (attacks pass through walls by design)
      p.atkCd -= dt;
      if (p.atkCd > 0 || this.phase === 'over') continue;
      let best = null, bestD = Infinity;
      for (const e of this.enemies) {
        const d = dist2d(p.x, p.z, e.vehicle.position.x, e.vehicle.position.z);
        if (d < bestD) { bestD = d; best = e; }
      }
      if (!best || bestD > p.range + ENEMY.RADIUS) continue;
      p.atkCd = 1 / p.rate;
      const tp = best.vehicle.position;
      p.yaw = Math.atan2(tp.x - p.x, tp.z - p.z);
      // weapon tier tints the swing/projectile; weapon id lets the view
      // pick the right melee flourish (spear stab / hammer bash)
      const wt = p.weapon?.tier || 0, wid = p.weapon?.id;
      this.emit({ t: 'atk', id: p.id, tx: rnd2(tp.x), tz: rnd2(tp.z), wt, wid });

      if (p.cls === 'archer') {
        const ft = bestD / 16;
        this.emit({
          t: 'shoot', k: 'arrow', wt,
          f: [rnd2(p.x), 1.0, rnd2(p.z)], to: [rnd2(tp.x), 0.7, rnd2(tp.z)], ft: rnd2(ft),
        });
        // with the hog pet even arrows carry a punch
        const kb = p.kbDealt || 0;
        const id = best.id, dmg = p.atk, pid = p.id, ox = p.x, oz = p.z;
        this.pending.push({ at: this.time + ft, fn: () => {
          const e = this.enemies.entities.find((n) => n.id === id);
          if (!e) return;
          const [kx, kz] = kbAway(ox, oz, e.vehicle.position, kb);
          this.damageEnemy(e, dmg, kx, kz, pid);
        }});
      } else if (p.cls === 'mage' && p.bolts > 0) {
        // arcane orb: no blast — several guided bolts split across the
        // nearest enemies in range (cycling when there are fewer foes)
        const foes = [];
        for (const e of this.enemies) {
          const ep = e.vehicle.position;
          const d = dist2d(p.x, p.z, ep.x, ep.z);
          if (d <= p.range + ENEMY.RADIUS) foes.push({ e, d });
        }
        foes.sort((a, b) => a.d - b.d);
        const targets = foes.slice(0, p.bolts);
        for (let i = 0; i < p.bolts; i++) {
          const f = targets[i % targets.length];
          const bp = f.e.vehicle.position;
          const ft = Math.max(f.d / 14, 0.12) + i * 0.05; // staggered volley
          this.emit({
            t: 'shoot', k: 'magic', wt,
            f: [rnd2(p.x), 1.15, rnd2(p.z)], to: [rnd2(bp.x), 0.6, rnd2(bp.z)], ft: rnd2(ft),
          });
          const id = f.e.id, dmg = p.atk * ORB.BOLT_MULT, pid = p.id, ox = p.x, oz = p.z;
          this.pending.push({ at: this.time + ft, fn: () => {
            const e = this.enemies.entities.find((n) => n.id === id);
            if (!e) return;
            const [kx, kz] = kbAway(ox, oz, e.vehicle.position, 0.5);
            this.damageEnemy(e, dmg, kx, kz, pid);
          }});
        }
      } else if (p.cls === 'mage') {
        const cx = tp.x, cz = tp.z, dmg = p.atk, r = p.aoe, pid = p.id, kb = p.kbPower;
        this.emit({
          t: 'shoot', k: 'magic', wt,
          f: [rnd2(p.x), 1.15, rnd2(p.z)], to: [rnd2(cx), 0.5, rnd2(cz)], ft: 0.35,
        });
        this.emit({ t: 'aoe', x: rnd2(cx), z: rnd2(cz), r, k: 'mage', ft: 0.35, wt });
        this.pending.push({ at: this.time + 0.35, fn: () => {
          for (const e of [...this.enemies.entities]) {
            const ep = e.vehicle.position;
            const d = dist2d(cx, cz, ep.x, ep.z);
            if (d <= r + ENEMY.RADIUS) {
              const n = Math.max(d, 0.2);
              this.damageEnemy(e, dmg, ((ep.x - cx) / n) * kb, ((ep.z - cz) / n) * kb, pid);
            }
          }
        }});
      } else {
        // melee: berserker / tanker — instant hit + knockback
        const n = Math.max(bestD, 0.2);
        const kx = ((tp.x - p.x) / n) * p.kbPower;
        const kz = ((tp.z - p.z) / n) * p.kbPower;
        this.damageEnemy(best, p.atk, kx, kz, p.id);
      }
    }
  }

  stepEnemies(dt) {
    const alive = this.players.entities.filter((p) => !p.dead);
    for (const e of this.enemies) {
      // training dummies just stand there soaking hits — no AI at all
      if (e.dummy) continue;
      const pos = e.vehicle.position;

      // status effects: burn/poison ticks + the chill slow, which
      // throttles the vehicle's own top speed while it lasts
      this.stepStatus(e, dt);
      e.vehicle.maxSpeed = e.slowT > 0 ? e.speed * e.slowF : e.speed;
      if (e.hp <= 0) continue; // a DoT tick just finished it off

      // mid-hop: sail along the arc over the vaulted cell, ignore
      // everything else (knockback keeps accumulating for the landing)
      if (e.jump) {
        const j = e.jump;
        j.t += dt;
        const k = Math.min(j.t / j.dur, 1);
        pos.x = j.fx + (j.tx - j.fx) * k;
        pos.z = j.fz + (j.tz - j.fz) * k;
        e.vehicle.velocity.set(0, 0, 0);
        e.seek.target.set(j.tx, 0, j.tz);
        e.yaw = Math.atan2(j.tx - j.fx, j.tz - j.fz);
        if (k >= 1) {
          e.jump = null;
          e.jumpCd = e.chainLeft > 0 ? 0.25 : ENEMY.JUMP_EVERY;
          if (e.chainLeft > 0) e.chainT = 1.6; // short window for the chained hop
        }
        continue;
      }

      // the gravedigger keeps pulling fresh tombs out of the ground
      if (e.summoner && this.phase === 'combat') {
        e.summonCd -= dt;
        if (e.summonCd <= 0) {
          e.summonCd = SUMMON.EVERY;
          if (this.enemies.entities.length < SUMMON.MAX_ENEMIES) this.raiseGrave(e);
        }
      }

      // vampires hunt for shortcuts: every so often they vault a single
      // blocked cell if the landing is meaningfully closer to the crystal
      if (e.jumper && e.state === 'path') {
        if (e.chainLeft > 0) {
          e.chainT -= dt;
          if (e.chainT <= 0) { // chained hop window expired unused
            e.chainLeft = 0;
            e.jumpCd = Math.max(e.jumpCd, ENEMY.JUMP_EVERY * 0.5);
          }
        }
        e.jumpCd -= dt;
        if (e.jumpCd <= 0) {
          const hop = enemyJumpShortcut(this.grid, pos.x, pos.z, ENEMY.JUMP_MIN_GAIN);
          if (hop) {
            if (e.chainLeft > 0) e.chainLeft -= 1;      // consuming a chained hop
            else e.chainLeft = e.chainJumps - 1;        // fresh hop arms the chain
            e.jump = { fx: pos.x, fz: pos.z, tx: hop.to.x, tz: hop.to.z, t: 0, dur: JUMP.DUR };
            this.emit({ t: 'ejump', id: e.id, dur: JUMP.DUR });
            continue;
          }
          e.jumpCd = 0.8; // nothing to vault right here — keep scanning
        }
      }

      // knockback impulses decay quickly; ground units can't be
      // pushed through walls/obstacles (ghosts fly over them). The slide
      // is integrated in short hops with a wall-resolve after each, so
      // even a hard knock never tunnels a body through an obstacle — the
      // worst case is being pinned flat against it.
      if (e.kbx || e.kbz) {
        const solid = !e.flying && pos.z > -HALF_H + 0.2;
        const dxTot = e.kbx * dt * 6, dzTot = e.kbz * dt * 6;
        const steps = Math.max(1, Math.ceil(Math.hypot(dxTot, dzTot) / PLAYER.KB_STEP));
        for (let i = 0; i < steps; i++) {
          pos.x += dxTot / steps;
          pos.z += dzTot / steps;
          if (solid) {
            const fixed = this.grid.resolveCircle(pos.x, pos.z, ENEMY.RADIUS);
            pos.x = fixed.x; pos.z = fixed.z;
          }
        }
        const decay = Math.exp(-PLAYER.KB_DECAY * dt);
        e.kbx *= decay; e.kbz *= decay;
        if (Math.abs(e.kbx) < 0.02) e.kbx = 0;
        if (Math.abs(e.kbz) < 0.02) e.kbz = 0;
      }

      // stunned (war hammer): rooted in place, can't attack or march —
      // knockback above still shoves the ragdoll around
      if (e.stunT > 0) {
        e.stunT = Math.max(e.stunT - dt, 0);
        e.seek.target.copy(pos);
        e.vehicle.velocity.set(0, 0, 0);
        continue;
      }

      // aggro refractory period ticks down while marching
      if (e.aggroCd > 0) e.aggroCd = Math.max(e.aggroCd - dt, 0);

      // acquire aggro: nearest character in radius that passes the
      // rules — clear straight path, and the crystal not closer
      if (e.state === 'path' && alive.length) {
        let best = null, bestD = Infinity;
        for (const p of alive) {
          const d = dist2d(pos.x, pos.z, p.x, p.z);
          if (d < bestD && d < ENEMY.AGGRO_RADIUS && this.canAggro(e, p, d)) {
            bestD = d; best = p;
          }
        }
        if (best) this.startChase(e, best);
      }

      let target = null;
      if (e.state === 'chase') {
        target = this.getPlayer(e.targetId);
        const td = target && !target.dead
          ? dist2d(pos.x, pos.z, target.x, target.z) : Infinity;
        // drop the chase when: target gone/dead, out of leash, or a
        // wall/tower got between us (ghosts fly over, so they keep it)
        let drop = !target || target.dead || td > ENEMY.LEASH_RADIUS ||
          (!e.flying && !this.hasLos(pos.x, pos.z, target.x, target.z));
        // anti-kiting: being walked back away from the crystal charges
        // the drag timer; hold long enough and the enemy shrugs it off
        if (!drop && target) {
          const cd = dist2d(pos.x, pos.z, CRYSTAL_POS.x, CRYSTAL_POS.z);
          if (cd < e.chaseBestD) e.chaseBestD = cd;
          if (cd > e.chaseBestD + ENEMY.DRAG_SLACK) {
            e.dragT = (e.dragT || 0) + dt;
            if (e.dragT >= ENEMY.DRAG_TIME) {
              drop = true;
              e.aggroCd = ENEMY.AGGRO_REFRACT; // commit to the path a while
            }
          } else if (e.dragT > 0) {
            e.dragT = Math.max(e.dragT - dt * 0.6, 0);
          }
        }
        if (drop) {
          e.state = 'path';
          e.targetId = null;
          target = null;
        }
      }

      e.atkCd -= dt;

      // ranged attackers (skeleton archers / the pumpkin boss) hold
      // position and fire as long as any character is inside range —
      // shots pass through walls, same as the characters' attacks do
      const ranged = e.archer || e.pumpkin;
      let engaged = false;
      if (ranged && alive.length && this.phase !== 'over') {
        const rng = ranged.range;
        const foes = [];
        for (const p of alive) {
          const d = dist2d(pos.x, pos.z, p.x, p.z);
          if (d <= rng) foes.push({ p, d });
        }
        if (foes.length) {
          engaged = true;
          foes.sort((a, b) => a.d - b.d);
          const aim = foes[0];
          e.seek.target.copy(pos);
          e.vehicle.velocity.multiplyScalar(0.6);
          e.yaw = Math.atan2(aim.p.x - pos.x, aim.p.z - pos.z);
          if (e.atkCd <= 0) {
            e.atkCd = 1 / ranged.rate;
            this.emit({ t: 'atk', id: e.id, tx: rnd2(aim.p.x), tz: rnd2(aim.p.z), r: 1 });
            if (e.pumpkin) {
              this.throwPumpkinAt(e, aim.p, aim.d);
            } else if (e.archer.multishot) {
              for (const f of foes) this.shootArrowAt(e, f.p, f.d); // volley at everyone
            } else {
              this.shootArrowAt(e, aim.p, aim.d);
            }
          }
        }
      }

      if (engaged) {
        // holding position to shoot — skip melee/marching
      } else if (target) {
        const d = dist2d(pos.x, pos.z, target.x, target.z);
        if (d <= ENEMY.ATTACK_RANGE + PLAYER.RADIUS) {
          // hold position and swing
          e.seek.target.copy(pos);
          e.vehicle.velocity.multiplyScalar(0.7);
          e.yaw = Math.atan2(target.x - pos.x, target.z - pos.z);
          if (e.atkCd <= 0) {
            e.atkCd = 1 / ENEMY.ATTACK_RATE;
            this.emit({ t: 'atk', id: e.id, tx: rnd2(target.x), tz: rnd2(target.z) });
            const n = Math.max(d, 0.2);
            this.damagePlayer(
              target, e.dmg,
              ((target.x - pos.x) / n) * ENEMY.KNOCKBACK_ON_PLAYER,
              ((target.z - pos.z) / n) * ENEMY.KNOCKBACK_ON_PLAYER
            );
          }
        } else {
          e.seek.target.set(target.x, 0, target.z);
        }
      } else {
        // march to the crystal
        const t = e.flying ? CRYSTAL_POS : this.grid.flowTarget(pos.x, pos.z);
        e.seek.target.set(t.x, 0, t.z);
      }

      // breach the crystal
      if (dist2d(pos.x, pos.z, CRYSTAL_POS.x, CRYSTAL_POS.z) < ENEMY.BREACH_DIST) {
        this.breaches += e.breach;
        this.emit({ t: 'breach', br: this.breaches, x: rnd2(pos.x), z: rnd2(pos.z) });
        this.removeEnemy(e);
        if (this.breaches >= CRYSTAL_BREACH_LIMIT) { this.gameOver(); return; }
        this.checkWaveCleared();
      }
    }
  }

  postAiFixup(dt) {
    // keep enemies on the board and compute their facing from velocity
    for (const e of this.enemies) {
      if (e.dummy) continue; // dummies live off-board, on the plaza floor
      const pos = e.vehicle.position;
      pos.x = clamp(pos.x, -HALF_W + 0.3, HALF_W - 0.3);
      // enemies may exist a little north of the board (the dark woods
      // they spawn hidden in) but never leave through the sides/south
      pos.z = clamp(pos.z, -HALF_H - 5.5, HALF_H - 0.3);
      pos.y = 0;
      // steering/separation can nudge ground units into blocked cells
      // (mid-jump the arc owns the position — it flies over the cell;
      // off-board in the woods there is nothing to collide with)
      if (!e.flying && !e.jump && pos.z > -HALF_H + 0.2) {
        const fixed = this.grid.resolveCircle(pos.x, pos.z, ENEMY.RADIUS * 0.8);
        pos.x = fixed.x; pos.z = fixed.z;
      }
      const v = e.vehicle.velocity;
      const sp = Math.hypot(v.x, v.z);
      if (sp > 0.25) e.yaw = Math.atan2(v.x, v.z);
      e.movingFlag = sp > 0.25;
    }
  }

  stepTowers(dt) {
    for (const t of this.towers) {
      t.cd -= dt;
      const st = this.towerStats(t);
      const w = cellToWorld(t.c, t.r);
      // target the enemy closest to the crystal that is inside range
      let best = null, bestScore = Infinity, bestD = 0;
      const inRange = []; // reused by the multi-target specials
      for (const e of this.enemies) {
        const ep = e.vehicle.position;
        const d = dist2d(w.x, w.z, ep.x, ep.z);
        if (d > st.range + (st.pulse ? ENEMY.RADIUS : 0) || d < st.minRange) continue;
        inRange.push({ e, d });
        const score = dist2d(ep.x, ep.z, CRYSTAL_POS.x, CRYSTAL_POS.z);
        if (score < bestScore) { bestScore = score; best = e; bestD = d; }
      }
      if (!best) continue;

      // ---- crystal: pulse a blast centred on the tower itself ----
      if (st.pulse) {
        if (t.cd > 0) continue;
        t.cd = 1 / st.rate;
        this.crystalPulse(t, st, w, inRange);
        continue;
      }

      const bp = best.vehicle.position;
      t.rot = Math.atan2(bp.x - w.x, bp.z - w.z);
      if (t.cd > 0) continue;
      t.cd = 1 / st.rate;

      // ---- flamethrower: instant jet + burning/poison DoT ----
      if (st.jet) {
        this.flameJet(t, st, w, best, bestD);
        continue;
      }

      // ---- ballista specials ----
      if (t.kind === 'ballista' && t.spec === 'triple') {
        // 3 arrows at up to 3 different targets (closest to the crystal)
        inRange.sort((a, b) =>
          dist2d(a.e.vehicle.position.x, a.e.vehicle.position.z, CRYSTAL_POS.x, CRYSTAL_POS.z) -
          dist2d(b.e.vehicle.position.x, b.e.vehicle.position.z, CRYSTAL_POS.x, CRYSTAL_POS.z));
        for (let i = 0; i < 3; i++) {
          const f = inRange[i % inRange.length];
          this.shootBolt(t, st, w, f.e, f.d);
        }
        continue;
      }
      if (t.kind === 'ballista' && t.spec === 'pierce') {
        this.shootPiercing(t, st, w, best, bestD);
        continue;
      }

      const ft = bestD / st.projSpeed;
      // lead the target a bit so slow shells still connect
      const bv = best.vehicle.velocity;
      const tx = bp.x + bv.x * ft * 0.7;
      const tz = bp.z + bv.z * ft * 0.7;

      // ---- catapult scatter: 5 spreading metal balls ----
      if (t.kind === 'catapult' && t.spec === 'scatter') {
        const S = TOWER_SPECIALS.catapult.scatter;
        for (let i = 0; i < S.balls; i++) {
          const ang = Math.random() * Math.PI * 2;
          const rad = i === 0 ? 0 : Math.random() * S.spread;
          const ix = tx + Math.cos(ang) * rad, iz = tz + Math.sin(ang) * rad;
          const fti = ft * (0.9 + Math.random() * 0.25);
          this.emit({
            t: 'shoot', k: 'cannonball', lob: 1, small: 1,
            f: [rnd2(w.x), 1.1, rnd2(w.z)], to: [rnd2(ix), 0.4, rnd2(iz)], ft: rnd2(fti),
          });
          this.aoeAt(ix, iz, st.aoe * 0.75, st.dmg * S.dmgMult, 'cannonball', fti, t);
        }
        continue;
      }

      this.emit({
        t: 'shoot', k: st.ammo, lob: st.lob ? 1 : 0,
        f: [rnd2(w.x), 1.1, rnd2(w.z)], to: [rnd2(tx), 0.4, rnd2(tz)], ft: rnd2(ft),
      });

      if (st.aoe > 0) {
        this.aoeAt(tx, tz, st.aoe, st.dmg, st.ammo, ft, t);
      } else {
        const id = best.id, dmg = st.dmg;
        this.pending.push({ at: this.time + ft, fn: () => {
          const e = this.enemies.entities.find((n) => n.id === id);
          if (e) this.damageEnemy(e, dmg, 0, 0, null);
        }});
      }
    }
  }

  // area blast at a point after `ft` seconds; cannon napalm leaves the
  // ground burning where the shell lands
  aoeAt(cx, cz, r, dmg, kind, ft, t) {
    const napalm = t.kind === 'cannon' && t.spec === 'napalm'
      ? TOWER_SPECIALS.cannon.napalm : null;
    this.pending.push({ at: this.time + ft, fn: () => {
      this.emit({ t: 'aoe', x: rnd2(cx), z: rnd2(cz), r, k: kind, ft: 0 });
      for (const e of [...this.enemies.entities]) {
        const ep = e.vehicle.position;
        const d = dist2d(cx, cz, ep.x, ep.z);
        if (d <= r + ENEMY.RADIUS) {
          // tower blast: damage only, no default knockback
          this.damageEnemy(e, dmg, 0, 0, null);
        }
      }
      if (napalm) {
        this.fires.push({ x: cx, z: cz, r: r * 0.85, dps: napalm.dps, until: this.time + napalm.dur });
        this.emit({ t: 'gfire', x: rnd2(cx), z: rnd2(cz), r: rnd2(r * 0.85), dur: napalm.dur });
      }
    }});
  }

  // single ballista bolt (also each arrow of the triple volley)
  shootBolt(t, st, w, target, dist) {
    const ft = dist / st.projSpeed;
    const tp = target.vehicle.position;
    const tv = target.vehicle.velocity;
    const tx = tp.x + tv.x * ft * 0.7, tz = tp.z + tv.z * ft * 0.7;
    this.emit({
      t: 'shoot', k: st.ammo, lob: 0,
      f: [rnd2(w.x), 1.1, rnd2(w.z)], to: [rnd2(tx), 0.4, rnd2(tz)], ft: rnd2(ft),
    });
    const id = target.id, dmg = st.dmg;
    this.pending.push({ at: this.time + ft, fn: () => {
      const e = this.enemies.entities.find((n) => n.id === id);
      if (e) this.damageEnemy(e, dmg, 0, 0, null);
    }});
  }

  // piercing bolt: flies the full range along the target's direction,
  // damaging EVERY enemy near that line
  shootPiercing(t, st, w, target, dist) {
    const tp = target.vehicle.position;
    const n = Math.max(dist, 0.2);
    const dx = (tp.x - w.x) / n, dz = (tp.z - w.z) / n;
    const ex = w.x + dx * st.range, ez = w.z + dz * st.range;
    const ft = st.range / st.projSpeed;
    this.emit({
      t: 'shoot', k: st.ammo, lob: 0, pierce: 1,
      f: [rnd2(w.x), 1.1, rnd2(w.z)], to: [rnd2(ex), 0.6, rnd2(ez)], ft: rnd2(ft),
    });
    const dmg = st.dmg;
    // each enemy near the line is hit when the bolt reaches its distance
    for (const e of this.enemies) {
      const ep = e.vehicle.position;
      const along = (ep.x - w.x) * dx + (ep.z - w.z) * dz;
      if (along < 0 || along > st.range) continue;
      const off = Math.hypot(ep.x - (w.x + dx * along), ep.z - (w.z + dz * along));
      if (off > ENEMY.RADIUS + 0.35) continue;
      const id = e.id;
      this.pending.push({ at: this.time + (along / st.range) * ft, fn: () => {
        const hit = this.enemies.entities.find((q) => q.id === id);
        if (hit) this.damageEnemy(hit, dmg, 0, 0, null);
      }});
    }
  }

  // crystal tower pulse: mage-style blast centred on the tower. Ice
  // spec chills everything hit; storm spec arcs damage between enemies
  // that are bunched close together.
  crystalPulse(t, st, w, inRange) {
    const spec = t.spec ? TOWER_SPECIALS.crystal[t.spec] : null;
    const kind = t.spec === 'ice' ? 'ice' : t.spec === 'storm' ? 'storm' : 'crystal';
    this.emit({ t: 'aoe', x: rnd2(w.x), z: rnd2(w.z), r: rnd2(st.aoe), k: kind, ft: 0 });
    const hitIds = new Set();
    for (const { e } of inRange) {
      // crystal pulse: damage only (its ice/storm specs add slow/arc, not a shove)
      this.damageEnemy(e, st.dmg, 0, 0, null);
      hitIds.add(e.id);
      if (t.spec === 'ice') {
        this.applySlow(e, spec.slowF, spec.slowDur);
      }
    }
    if (t.spec === 'storm') {
      // arcs: every enemy OUTSIDE the pulse that hugs someone inside it
      // takes a share of the damage (one arc each, no chain reactions)
      for (const { e } of inRange) {
        if (e.hp <= 0) continue;
        const ep = e.vehicle.position;
        for (const o of [...this.enemies.entities]) {
          if (hitIds.has(o.id) || o.hp <= 0) continue;
          const op = o.vehicle.position;
          if (dist2d(ep.x, ep.z, op.x, op.z) <= spec.chainR) {
            hitIds.add(o.id);
            this.emit({
              t: 'zap', x1: rnd2(ep.x), z1: rnd2(ep.z), x2: rnd2(op.x), z2: rnd2(op.z),
            });
            this.damageEnemy(o, st.dmg * spec.chainMult, 0, 0, null);
          }
        }
      }
    }
  }

  // flamethrower jet: cone toward the target — impact damage plus a
  // fire (or venom) DoT on everything the spray washes over
  flameJet(t, st, w, target, dist) {
    const venom = t.spec === 'venom' ? TOWER_SPECIALS.flame.venom : null;
    const tp = target.vehicle.position;
    const n = Math.max(dist, 0.2);
    const dx = (tp.x - w.x) / n, dz = (tp.z - w.z) / n;
    const reach = st.range, halfW = st.aoe * (venom ? venom.aoeMult : 1) * 0.5;
    const dur = st.burnDur * (venom ? venom.durMult : 1);
    const dps = st.burnDps * (venom ? venom.dpsMult : 1);
    this.emit({
      t: 'flame', x: rnd2(w.x), z: rnd2(w.z),
      tx: rnd2(w.x + dx * reach), tz: rnd2(w.z + dz * reach),
      v: venom ? 1 : 0,
    });
    for (const e of this.enemies) {
      const ep = e.vehicle.position;
      const along = (ep.x - w.x) * dx + (ep.z - w.z) * dz;
      if (along < 0 || along > reach + ENEMY.RADIUS) continue;
      const off = Math.hypot(ep.x - (w.x + dx * along), ep.z - (w.z + dz * along));
      if (off > halfW + ENEMY.RADIUS) continue;
      this.damageEnemy(e, st.dmg, 0, 0, null);
      if (e.hp > 0) this.applyDot(e, venom ? STATUS.POISON_KIND : STATUS.FIRE_KIND, dps, dur);
    }
  }

  // ---------------- snapshots ----------------

  buildSnapshot() {
    return {
      w: this.wave,
      ph: this.phase,
      bt: this.buildTimerOn ? rnd2(Math.max(this.buildT, 0)) : -1,
      pts: Math.round(this.points),
      br: this.breaches,
      left: this.spawnQueue.length + this.enemies.entities.length +
        this.graves.reduce((s, g) => s + g.spawnsLeft, 0),
      cont: [...this.contReady],
      pl: this.players.entities.map((p) => [
        p.id, p.cls, rnd2(p.x), rnd2(p.z), rnd2(p.yaw),
        Math.ceil(p.hp), p.maxHp, p.lvl, Math.round(p.xp), p.xpNext,
        p.moving ? 1 : 0, p.dead ? 1 : 0, rnd2(Math.max(p.respawnT, 0)),
        p.obst, p.kills, p.name, rnd2(Math.max(p.skillCd, 0)), p.wallT > 0 ? 1 : 0,
        Math.round(p.atk),
        // pet-affected move speed (clients predict with it) + the
        // companion itself, so every peer can render & label it
        rnd2(p.speed), p.pet?.id || '', p.pet?.name || '', p.pet?.lvl || 0,
        // equipped weapon & shield (+ tiers) so every peer renders the
        // right prop with the right gold/crystal finish
        p.weapon?.id || '', p.weapon?.tier || 0,
        p.shield?.id || '', p.shield?.tier || 0,
        // attack range (index 27) — the owning client turns to face any
        // foe inside it, so it needs the wave/weapon-adjusted value
        rnd2(p.range),
      ]),
      en: this.enemies.entities.map((e) => [
        e.id, e.kind, rnd2(e.vehicle.position.x), rnd2(e.vehicle.position.z),
        rnd2(e.yaw), Math.ceil(e.hp), Math.ceil(e.maxHp), e.scale, e.boss,
        e.movingFlag ? 1 : 0,
        // status flags bitmask (slow|burn|poison|stun) for client FX
        (e.slowT > 0 ? 1 : 0) | (e.burnT > 0 ? 2 : 0) |
        (e.poisonT > 0 ? 4 : 0) | (e.stunT > 0 ? 8 : 0),
        // visual variant (stage-2/3 look, Brutus props) — see spawnEnemy
        e.vr,
      ]),
      tw: this.towers.entities.map((t) => [t.id, t.kind, t.c, t.r, t.lvl, rnd2(t.rot), t.spec || 0]),
      ob: this.obstacles.entities.map((o) => [o.id, o.kind, o.c, o.r]),
      gr: this.graves.map((g) => [g.id, rnd2(g.x), rnd2(g.z)]),
      dr: this.drops.map((d) => [
        d.id, d.owner, d.kind === 'xp' ? 0 : d.kind === 'pts' ? 1 : 2, rnd2(d.x), rnd2(d.z),
      ]),
    };
  }
}
