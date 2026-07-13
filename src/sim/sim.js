import { World } from 'miniplex';
import { EntityManager, Vehicle, SeekBehavior, SeparationBehavior } from 'yuka';
import {
  CLASSES, PLAYER, TOWERS, TOWER_LEVEL_MAX, TOWER_UPGRADE, OBSTACLES,
  OBSTACLE_STOCK_CAP, ENEMIES, ENEMY, WAVES, SCALING, scaleFor,
  CRYSTAL_BREACH_LIMIT, GRID, JUMP, DROPS, SUMMON, BOSSES, SKILLS,
} from '../config.js';
import {
  Grid, cellToWorld, worldToCell, canJumpFrom, enemyJumpShortcut, idx,
  computeDashEnd, CRYSTAL_POS, HALF_W, HALF_H,
} from './grid.js';
import { buildWavePlan, enemyStats } from './waves.js';
import { clamp, dist2d, nextId } from '../utils.js';

const rnd2 = (v) => Math.round(v * 100) / 100;

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
    this.spawnQueue = [];   // [{kind, at(abs time), boss, variant}]
    this.spawnIdx = 0;
    this.graves = [];       // tombs raised by the gravedigger, still spawning
    this.drops = [];        // XP/point orbs on the ground, per-player
    this.pending = [];      // scheduled callbacks [{at, fn}]
    this.events = [];
    this.contReady = new Set();
    this.waveStartCount = 1; // player count captured at wave start
  }

  emit(ev) { this.events.push(ev); }
  drainEvents() { const e = this.events; this.events = []; return e; }
  playerCount() { return this.players.entities.length; }

  // ---------------- players ----------------

  addPlayer(id, name, cls) {
    if (this.getPlayer(id)) return;
    if (!CLASSES[cls]) cls = 'berserker';
    const base = CLASSES[cls];
    const spawn = this.playerSpawnPos();
    const p = this.world.add({
      player: true, id, name: (name || 'Hero').slice(0, 12), cls,
      x: spawn.x, z: spawn.z, yaw: Math.PI, moving: false,
      hp: base.hp, maxHp: base.hp, atk: base.atk, def: base.def,
      range: base.range, rate: base.rate, speed: base.speed,
      aoe: base.aoe || 0, kbPower: base.knockback,
      lvl: 1, xp: 0, xpNext: this.xpNext(1),
      dead: false, respawnT: 0, atkCd: 0, lastDmg: -99, jumpT: 0,
      skillCd: 0, wallT: 0, dashT: 0,
      kills: 0, obst: 0, lastInputT: this.time,
    });
    if (this.phase !== 'lobby') {
      // late joiner: give them the starting obstacle stock
      p.obst = scaleFor(SCALING.startObstacles, this.playerCount());
      this.emit({ t: 'toast', msg: `${p.name} joined the defense!` });
    }
    return p;
  }

  removePlayer(id) {
    const p = this.getPlayer(id);
    if (!p) return;
    this.world.remove(p);
    this.contReady.delete(id);
    if (this.phase !== 'lobby') this.emit({ t: 'toast', msg: `${p.name} left.` });
    this.checkContinue();
  }

  getPlayer(id) {
    return this.players.entities.find((p) => p.id === id);
  }

  playerSpawnPos() {
    const n = this.playerCount();
    const a = Math.PI * (0.35 + 0.3 * (n % 4));
    return {
      x: clamp(CRYSTAL_POS.x + Math.cos(a) * 2.2, -HALF_W + 1, HALF_W - 1),
      z: clamp(CRYSTAL_POS.z - Math.abs(Math.sin(a)) * 2.2 - 0.6, -HALF_H + 1, HALF_H - 1),
    };
  }

  xpNext(lvl) { return Math.round(PLAYER.XP_BASE * Math.pow(lvl, PLAYER.XP_POW)); }

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
    // cell collision resolve (bounds are still enforced)
    const fixed = p.jumpT > 0
      ? { x: clamp(x, -HALF_W + 0.3, HALF_W - 0.3), z: clamp(z, -HALF_H + 0.3, HALF_H - 0.3) }
      : this.grid.resolveCircle(x, z, PLAYER.RADIUS, true);
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
    const roster = this.players.entities.map((p) => ({ id: p.id, name: p.name, cls: p.cls }));
    for (const e of [...this.enemies.entities]) this.removeEnemy(e);
    for (const t of [...this.towers.entities]) this.world.remove(t);
    for (const o of [...this.obstacles.entities]) this.world.remove(o);
    for (const p of [...this.players.entities]) this.world.remove(p);
    this.grid = new Grid();
    this.breaches = 0;
    this.spawnQueue = [];
    this.graves = [];
    this.pending = [];
    this.drops = [];
    this.contReady.clear();
    for (const r of roster) this.addPlayer(r.id, r.name, r.cls);
    this.start();
    this.emit({ t: 'restart' });
  }

  startWave() {
    if (this.phase !== 'build' && this.phase !== 'checkpoint') return;
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
      case 'sell': return this.trySell(p, act);
      case 'jump': return this.tryJump(p, act);
      case 'skill': return this.trySkill(p, act);
      case 'start': if (this.phase === 'build') this.startWave(); return;
      case 'cont': return this.setContinue(id);
      case 'restart': if (this.phase === 'over') this.restart(); return;
    }
  }

  deny(p, msg) { this.emit({ t: 'toast', msg, to: p.id, kind: 'error' }); }

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
    if (isObstacle && p.obst < 1) return this.deny(p, 'No blocks left — earn more each wave');
    const towerDef = TOWERS[item];
    if (towerDef && this.points < towerDef.cost) return this.deny(p, 'Not enough points');
    if (this.cellContents(c, r)) return this.deny(p, 'That spot is taken');
    if (!this.grid.isBuildable(c, r)) return this.deny(p, "Can't build there");
    if (!this.grid.canPlaceAt(c, r, this.enemyCells())) {
      return this.deny(p, "You can't fully block the path!");
    }
    // don't build on top of a character
    for (const q of this.players) {
      if (!q.dead) {
        const w = cellToWorld(c, r);
        if (Math.abs(q.x - w.x) < 1 + PLAYER.RADIUS && Math.abs(q.z - w.z) < 1 + PLAYER.RADIUS) {
          return this.deny(p, 'Someone is standing there');
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
        rot: Math.PI, cd: 0.5, invested: towerDef.cost,
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
    if (t.lvl >= TOWER_LEVEL_MAX) return this.deny(p, 'Already at max level');
    const cost = Math.round(TOWERS[t.kind].cost * TOWER_UPGRADE.costMult[t.lvl]);
    if (this.points < cost) return this.deny(p, 'Not enough points');
    this.points -= cost;
    t.lvl += 1;
    t.invested += cost;
    this.emit({ t: 'upgrade', c, r, lvl: t.lvl });
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
    if (typeof act?.yaw === 'number') p.yaw = act.yaw;
    const info = canJumpFrom(this.grid, p.x, p.z, p.yaw);
    if (!info) return;
    p.jumpT = JUMP.DUR;
    this.emit({ t: 'jump', id: p.id, dur: JUMP.DUR });
  }

  // ---------------- class special attacks ----------------

  // one shared cooldown; a skill that finds no valid target refuses
  // to fire (and refuses to burn the cooldown)
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
      this.pending.push({ at: this.time + S.dur * t, fn: () => {
        const hit = this.enemies.entities.find((n) => n.id === id);
        if (hit) this.damageEnemy(hit, dmg, S.kb, 0, pid);
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
      if (p.skillCd <= 0) this.deny(p, 'No enemies in range');
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
      const id = f.e.id, dmg = p.atk * S.dmgMult, pid = p.id;
      this.pending.push({ at: this.time + ft, fn: () => {
        const e = this.enemies.entities.find((n) => n.id === id);
        if (e) this.damageEnemy(e, dmg, 0.4, 0, pid);
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
      this.deny(p, 'No enemies in range');
      return false;
    }
    const tp = best.vehicle.position;
    const cx = tp.x, cz = tp.z;
    const r = p.aoe * S.aoeMult, dmg = p.atk * S.dmgMult, kb = p.kbPower * S.kbMult;
    const ft = S.flightT;
    p.yaw = Math.atan2(cx - p.x, cz - p.z);
    this.emit({ t: 'atk', id: p.id, tx: rnd2(cx), tz: rnd2(cz) });
    this.emit({
      t: 'shoot', k: 'magic', big: 1,
      f: [rnd2(p.x), 1.3, rnd2(p.z)], to: [rnd2(cx), 0.5, rnd2(cz)], ft,
    });
    this.emit({ t: 'aoe', x: rnd2(cx), z: rnd2(cz), r: rnd2(r), k: 'mage', ft, big: 1 });
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
    return {
      dmg: def.dmg * Math.pow(TOWER_UPGRADE.dmgMult, m),
      range: def.range + TOWER_UPGRADE.rangeAdd * m,
      rate: def.rate * Math.pow(TOWER_UPGRADE.rateMult, m),
      aoe: def.aoe, minRange: def.minRange || 0, projSpeed: def.projSpeed, lob: def.lob,
      ammo: def.ammo,
    };
  }

  // ---------------- enemies ----------------

  // `at` (optional {x,z}) drops the enemy mid-board — used by the
  // gravedigger's tombs; otherwise it walks in from a top spawn pad
  spawnEnemy(kind, boss, variant = null, at = null) {
    const def = ENEMIES[kind];
    const s = GRID.SPAWNS[this.spawnIdx++ % GRID.SPAWNS.length];
    const w = at || cellToWorld(s.c, s.r);
    const stats = enemyStats(kind, boss, this.wave, this.waveStartCount, variant);
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
      atkCd: 0, kbx: 0, kbz: 0, yaw: 0,
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
    if (boss === 2) this.emit({ t: 'boss', name: bossDef?.name || def.name || kind });
    else if (boss === 1) this.emit({ t: 'subboss', name: def.name || kind });
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
    e.hp -= dmg;
    // knockback always throws enemies BACKWARD (away from the crystal),
    // never toward it — only the magnitude of the hit matters
    const mag = Math.hypot(kbx, kbz);
    if (mag > 0) {
      const pos = e.vehicle.position;
      const dx = pos.x - CRYSTAL_POS.x, dz = pos.z - CRYSTAL_POS.z;
      const d = Math.hypot(dx, dz) || 1;
      e.kbx += (dx / d) * mag;
      e.kbz += (dz / d) * mag;
    }
    this.emit({ t: 'hit', id: e.id });
    if (e.hp <= 0) {
      const pos = e.vehicle.position;
      this.emit({ t: 'die', id: e.id, kind: e.kind, x: rnd2(pos.x), z: rnd2(pos.z), boss: e.boss });
      const killer = killerId && this.getPlayer(killerId);
      if (killer) killer.kills += 1;
      // nothing is granted on the kill itself — the enemy drops XP and
      // point orbs that each player has to walk over to collect
      this.spawnDrops(e);
      this.removeEnemy(e);
      this.checkWaveCleared();
    }
  }

  // ---------------- drops (XP / point orbs) ----------------

  spawnDrops(e) {
    const pos = e.vehicle.position;
    const n = Math.max(this.playerCount(), 1);
    // the shared point pool only grows when orbs are picked up, so each
    // player's orb carries their slice of the kill's value
    const ptsAmt = Math.max(1, Math.round((e.pts * scaleFor(SCALING.points, n)) / n));
    for (const p of this.players) {
      this.addDrop(p.id, 'xp', e.xp, pos.x, pos.z);
      this.addDrop(p.id, 'pts', ptsAmt, pos.x, pos.z);
    }
  }

  addDrop(owner, kind, amount, x, z) {
    // deaths cluster around chokepoints — merge nearby same-kind orbs
    // so the ground (and the snapshot) never floods
    for (const d of this.drops) {
      if (d.owner === owner && d.kind === kind &&
          dist2d(d.x, d.z, x, z) < DROPS.MERGE_RADIUS) {
        d.amount += amount;
        d.until = this.time + DROPS.TTL;
        return;
      }
    }
    const jit = () => (Math.random() - 0.5) * 0.9;
    const fixed = this.grid.resolveCircle(x + jit(), z + jit(), 0.3);
    this.drops.push({
      id: nextId(), owner, kind, amount,
      x: fixed.x, z: fixed.z, until: this.time + DROPS.TTL,
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
      if (!p.dead) {
        const dist = dist2d(d.x, d.z, p.x, p.z);
        if (dist <= DROPS.PICKUP_RADIUS) {
          if (d.kind === 'xp') this.grantXp(p, d.amount);
          else this.points += d.amount;
          this.emit({ t: 'pickup', id: p.id, k: d.kind, amt: d.amount });
          continue;
        }
        if (dist <= DROPS.MAGNET_RADIUS) {
          const pull = Math.min((DROPS.MAGNET_SPEED * dt) / Math.max(dist, 0.001), 1);
          d.x += (p.x - d.x) * pull;
          d.z += (p.z - d.z) * pull;
        }
      }
      keep.push(d);
    }
    this.drops = keep;
  }

  grantXp(p, xp) {
    if (p.lvl >= PLAYER.LEVEL_CAP) return;
    p.xp += xp;
    while (p.xp >= p.xpNext && p.lvl < PLAYER.LEVEL_CAP) {
      p.xp -= p.xpNext;
      p.lvl += 1;
      p.xpNext = this.xpNext(p.lvl);
      p.maxHp = Math.round(p.maxHp * PLAYER.LEVEL_HP_MULT);
      p.atk *= PLAYER.LEVEL_ATK_MULT;
      p.hp = Math.min(p.maxHp, p.hp + (p.maxHp - p.hp) * PLAYER.LEVEL_HEAL);
      this.emit({ t: 'lvl', id: p.id, lvl: p.lvl });
    }
  }

  damagePlayer(p, rawDmg, kbx, kbz) {
    if (p.dead) return;
    // wall mode (tanker skill): doubled defense, immune to knockback
    const wall = p.wallT > 0;
    const def = wall ? Math.min(p.def * SKILLS.tanker.defMult, SKILLS.tanker.defCap) : p.def;
    if (wall) { kbx = 0; kbz = 0; }
    const dmg = rawDmg * (1 - def);
    p.hp -= dmg;
    p.lastDmg = this.time;
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
        this.spawnEnemy(s.kind, s.boss, s.variant);
      }
    }

    this.stepPlayers(dt);
    this.stepDrops(dt);
    this.stepGraves();
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
      if (p.dead) {
        p.respawnT -= dt;
        if (p.respawnT <= 0 && this.phase !== 'over') this.respawnPlayer(p);
        continue;
      }
      // regen
      if (this.time - p.lastDmg > PLAYER.REGEN_DELAY && p.hp < p.maxHp) {
        p.hp = Math.min(p.maxHp, p.hp + p.maxHp * PLAYER.REGEN_RATE * dt);
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
      this.emit({ t: 'atk', id: p.id, tx: rnd2(tp.x), tz: rnd2(tp.z) });

      if (p.cls === 'archer') {
        const ft = bestD / 16;
        this.emit({
          t: 'shoot', k: 'arrow',
          f: [rnd2(p.x), 1.0, rnd2(p.z)], to: [rnd2(tp.x), 0.7, rnd2(tp.z)], ft: rnd2(ft),
        });
        const id = best.id, dmg = p.atk, kx = 0, kz = 0, pid = p.id;
        this.pending.push({ at: this.time + ft, fn: () => {
          const e = this.enemies.entities.find((n) => n.id === id);
          if (e) this.damageEnemy(e, dmg, kx, kz, pid);
        }});
      } else if (p.cls === 'mage') {
        const cx = tp.x, cz = tp.z, dmg = p.atk, r = p.aoe, pid = p.id, kb = p.kbPower;
        this.emit({
          t: 'shoot', k: 'magic',
          f: [rnd2(p.x), 1.15, rnd2(p.z)], to: [rnd2(cx), 0.5, rnd2(cz)], ft: 0.35,
        });
        this.emit({ t: 'aoe', x: rnd2(cx), z: rnd2(cz), r, k: 'mage', ft: 0.35 });
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
      const pos = e.vehicle.position;

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
      // pushed through walls/obstacles (ghosts fly over them)
      if (e.kbx || e.kbz) {
        pos.x += e.kbx * dt * 6;
        pos.z += e.kbz * dt * 6;
        if (!e.flying) {
          const fixed = this.grid.resolveCircle(pos.x, pos.z, ENEMY.RADIUS);
          pos.x = fixed.x; pos.z = fixed.z;
        }
        const decay = Math.exp(-PLAYER.KB_DECAY * dt);
        e.kbx *= decay; e.kbz *= decay;
        if (Math.abs(e.kbx) < 0.02) e.kbx = 0;
        if (Math.abs(e.kbz) < 0.02) e.kbz = 0;
      }

      // acquire / drop aggro
      if (e.state === 'path' && alive.length) {
        let best = null, bestD = Infinity;
        for (const p of alive) {
          const d = dist2d(pos.x, pos.z, p.x, p.z);
          if (d < bestD) { bestD = d; best = p; }
        }
        if (best && bestD < ENEMY.AGGRO_RADIUS) {
          e.state = 'chase';
          e.targetId = best.id;
        }
      }

      let target = null;
      if (e.state === 'chase') {
        target = this.getPlayer(e.targetId);
        if (!target || target.dead ||
            dist2d(pos.x, pos.z, target.x, target.z) > ENEMY.LEASH_RADIUS) {
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
      const pos = e.vehicle.position;
      pos.x = clamp(pos.x, -HALF_W + 0.3, HALF_W - 0.3);
      pos.z = clamp(pos.z, -HALF_H + 0.3, HALF_H - 0.3);
      pos.y = 0;
      // steering/separation can nudge ground units into blocked cells
      // (mid-jump the arc owns the position — it flies over the cell)
      if (!e.flying && !e.jump) {
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
      for (const e of this.enemies) {
        const ep = e.vehicle.position;
        const d = dist2d(w.x, w.z, ep.x, ep.z);
        if (d > st.range || d < st.minRange) continue;
        const score = dist2d(ep.x, ep.z, CRYSTAL_POS.x, CRYSTAL_POS.z);
        if (score < bestScore) { bestScore = score; best = e; bestD = d; }
      }
      if (!best) continue;
      const bp = best.vehicle.position;
      t.rot = Math.atan2(bp.x - w.x, bp.z - w.z);
      if (t.cd > 0) continue;
      t.cd = 1 / st.rate;

      const ft = bestD / st.projSpeed;
      // lead the target a bit so slow shells still connect
      const bv = best.vehicle.velocity;
      const tx = bp.x + bv.x * ft * 0.7;
      const tz = bp.z + bv.z * ft * 0.7;
      this.emit({
        t: 'shoot', k: st.ammo, lob: st.lob ? 1 : 0,
        f: [rnd2(w.x), 1.1, rnd2(w.z)], to: [rnd2(tx), 0.4, rnd2(tz)], ft: rnd2(ft),
      });

      if (st.aoe > 0) {
        const cx = tx, cz = tz, dmg = st.dmg, r = st.aoe, kind = st.ammo;
        this.pending.push({ at: this.time + ft, fn: () => {
          this.emit({ t: 'aoe', x: rnd2(cx), z: rnd2(cz), r, k: kind, ft: 0 });
          for (const e of [...this.enemies.entities]) {
            const ep = e.vehicle.position;
            const d = dist2d(cx, cz, ep.x, ep.z);
            if (d <= r + ENEMY.RADIUS) {
              const n = Math.max(d, 0.2);
              this.damageEnemy(e, dmg, ((ep.x - cx) / n) * 1.2, ((ep.z - cz) / n) * 1.2, null);
            }
          }
        }});
      } else {
        const id = best.id, dmg = st.dmg;
        this.pending.push({ at: this.time + ft, fn: () => {
          const e = this.enemies.entities.find((n) => n.id === id);
          if (e) this.damageEnemy(e, dmg, 0, 0, null);
        }});
      }
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
      ]),
      en: this.enemies.entities.map((e) => [
        e.id, e.kind, rnd2(e.vehicle.position.x), rnd2(e.vehicle.position.z),
        rnd2(e.yaw), Math.ceil(e.hp), Math.ceil(e.maxHp), e.scale, e.boss,
        e.movingFlag ? 1 : 0,
      ]),
      tw: this.towers.entities.map((t) => [t.id, t.kind, t.c, t.r, t.lvl, rnd2(t.rot)]),
      ob: this.obstacles.entities.map((o) => [o.id, o.kind, o.c, o.r]),
      gr: this.graves.map((g) => [g.id, rnd2(g.x), rnd2(g.z)]),
      dr: this.drops.map((d) => [d.id, d.owner, d.kind === 'xp' ? 0 : 1, rnd2(d.x), rnd2(d.z)]),
    };
  }
}
