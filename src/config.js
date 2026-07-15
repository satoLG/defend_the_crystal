// ============================================================
// All game balance & tuning in one place.
// ============================================================

export const GRID = {
  COLS: 9,
  ROWS: 15,
  CELL: 2,
  // enemies walk in from the top rows, the crystal sits near the bottom
  SPAWNS: [
    { c: 2, r: 0 },
    { c: 6, r: 0 },
  ],
  CRYSTAL: { c: 4, r: 13 },
  BUILD_ROW_MIN: 2,
  BUILD_ROW_MAX: 12,
};

export const CRYSTAL_BREACH_LIMIT = 10;

// keep hero names short so they never overflow the overhead labels
// (name + a separate level badge) or the roster/HUD chrome
export const NAME_MAX = 10;

// ---------- player classes ----------
// def = fraction of incoming damage absorbed.
export const CLASSES = {
  berserker: {
    name: 'Berserker', icon: 'axe',
    hp: 230, def: 0.25, atk: 36, range: 1.8, rate: 1.15, speed: 4.3,
    knockback: 1.8, model: 'char-berserker',
    weapon: 'Battle axe',
    blurb: 'A frontline bruiser who trades safety for devastating melee hits.',
  },
  tanker: {
    name: 'Tanker', icon: 'shield',
    hp: 340, def: 0.45, atk: 18, range: 1.8, rate: 1.0, speed: 3.4,
    knockback: 1.3, model: 'char-tanker',
    weapon: 'Sword & shield',
    blurb: 'An immovable wall that soaks damage and holds the line.',
  },
  archer: {
    name: 'Archer', icon: 'bow',
    hp: 150, def: 0.10, atk: 15, range: 7.0, rate: 2.3, speed: 5.3,
    knockback: 0.6, model: 'char-archer',
    weapon: 'Longbow',
    blurb: 'A nimble sharpshooter raining fast arrows from a safe distance.',
  },
  mage: {
    name: 'Mage', icon: 'orb',
    hp: 175, def: 0.22, atk: 16, range: 8.5, rate: 0.85, speed: 4.4,
    knockback: 0.8, aoe: 1.9, model: 'char-mage',
    weapon: 'Arcane staff',
    blurb: 'A ranged caster that melts whole clusters with area blasts.',
  },
};

// hop over exactly one blocked grid cell (tower/obstacle)
export const JUMP = { DUR: 0.55, HEIGHT: 1.4 };

// ---------- class special attacks (button next to jump) ----------
// Every class shares the same cooldown *length*, but the timer itself
// is per-character: each player's skill recharges on its own clock
// (see p.skillCd in the sim), never a single timer shared by the party.
export const SKILLS = {
  COOLDOWN: 30,
  berserker: { // dash forward, flinging everything on the path backward
    name: 'Rampage Dash', cells: 5, dur: 0.42, dmgMult: 3.2, kb: 4.5, width: 1.25,
  },
  tanker: { // "wall mode": zero knockback + doubled defense for a while
    name: 'Wall Mode', dur: 10, defMult: 2, defCap: 0.92,
  },
  archer: { // 3 quick volleys of 5 arrows at the nearest enemies
    name: 'Arrow Storm', arrows: 5, bursts: 3, gap: 0.32, rangeMult: 1.25, dmgMult: 1.0,
  },
  mage: { // giant arcane orb: much bigger blast, much more damage
    name: 'Arcane Orb', aoeMult: 2.6, dmgMult: 2.4, kbMult: 2.5, rangeMult: 1.2, flightT: 0.7,
  },
};

// XP/point orbs dropped by dying enemies. Orbs are per-player: every
// player gets their own orb from each kill, and only ever sees &
// collects their own (see spawnDrops / stepDrops).
//
// Collection is grid-based rather than a tight pickup circle. A
// character sweeps up its own orbs anywhere in the 3×3 block of cells
// it stands on (one grid cell to every side), and can even reach an orb
// two cells away when a single tower/obstacle sits between them — you
// shouldn't have to walk around your own wall to grab a drop. Anything
// farther has to be walked over.
export const DROPS = {
  TTL: 10,                  // seconds before an uncollected orb fades away
  COLLECT_CELLS: 1,         // auto-collect radius in grid cells (1 = 3×3 block)
  REACH_OVER_BLOCKER: true, // also reach 2 cells over one tower/obstacle
  ABSORB_RADIUS: 0.6,       // a claimed orb pops once it reaches its owner
  MAGNET_SPEED: 7.5,        // how fast a claimed orb flies to its owner
  MERGE_RADIUS: 1.6,        // nearby same-kind orbs merge to keep counts low
  MAX: 240,                 // hard cap on live orbs (oldest are culled)
};

export const PLAYER = {
  RADIUS: 0.45,
  REGEN_DELAY: 3.0,     // seconds without damage before regen kicks in
  REGEN_RATE: 0.04,     // fraction of max HP per second
  RESPAWN_BASE: 6,      // seconds
  RESPAWN_PER_WAVE: 0.4,
  RESPAWN_MAX: 15,
  LEVEL_HP_MULT: 1.06,  // per level
  LEVEL_ATK_MULT: 1.06,
  LEVEL_HEAL: 0.35,     // fraction of missing HP restored on level-up
  LEVEL_CAP: 60,
  XP_BASE: 50,          // xpNext = XP_BASE * lvl^1.35
  XP_POW: 1.35,
  KB_DECAY: 7,          // knockback impulse decay per second
};

// ---------- towers ----------
export const TOWERS = {
  ballista: {
    name: 'Ballista', icon: 'ballista', cost: 60,
    dmg: 14, range: 5.5, rate: 1.5, aoe: 0, projSpeed: 16,
    model: 'tower-ballista', ammo: 'arrow',
  },
  catapult: {
    name: 'Catapult', icon: 'catapult', cost: 140,
    dmg: 26, range: 8.5, minRange: 2.5, rate: 0.4, aoe: 1.4, projSpeed: 9,
    model: 'tower-catapult', ammo: 'boulder', lob: true,
  },
  cannon: {
    name: 'Cannon', icon: 'cannon', cost: 220,
    dmg: 45, range: 4.5, rate: 0.5, aoe: 1.8, projSpeed: 13,
    model: 'tower-cannon', ammo: 'cannonball',
  },
};
// 6 levels: grey → blue → green → red → purple → gold
export const TOWER_LEVEL_MAX = 6;
export const TOWER_UPGRADE = {
  dmgMult: 1.45, rangeAdd: 0.35, rateMult: 1.12,
  costMult: [0, 0.9, 1.4, 2.0, 2.8, 3.8], // upgrade cost = base * costMult[currentLvl]
  sellRefund: 0.6,
};

export const OBSTACLES = ['rocks', 'barrel']; // random cosmetic variety
export const OBSTACLE_STOCK_CAP = 10;

// ---------- enemies ----------
// archer: stops and fires arrows at characters instead of melee
export const ENEMIES = {
  skeleton:   { name: 'Skeleton', hp: 40,  speed: 2.3, dmg: 8,  pts: 4,  xp: 7,  fromWave: 1, model: 'enemy-skeleton' },
  zombie:     { name: 'Zombie',   hp: 95,  speed: 1.5, dmg: 14, pts: 6,  xp: 11, fromWave: 2, model: 'enemy-zombie' },
  ghost:      { name: 'Ghost',    hp: 33,  speed: 2.9, dmg: 6,  pts: 5,  xp: 9,  fromWave: 4, model: 'enemy-ghost', flying: true },
  skelarcher: { name: 'Skeleton Archer', hp: 55, speed: 2.1, dmg: 11, pts: 8, xp: 13, fromWave: 5, model: 'enemy-skeleton',
                archer: { range: 6.5, rate: 0.55, projSpeed: 13 } },
  orc:        { name: 'Orc',      hp: 190, speed: 1.9, dmg: 22, pts: 10, xp: 18, fromWave: 6, model: 'enemy-orc' },
  vampire:    { name: 'Vampire',  hp: 290, speed: 2.5, dmg: 30, pts: 16, xp: 30, fromWave: 9, model: 'enemy-vampire', jumper: true },
  keeper:     { name: 'Coveiro',  hp: 1150, speed: 1.6, dmg: 40, pts: 110, xp: 260, fromWave: 999, model: 'enemy-keeper', summoner: true }, // boss only
};

export const ENEMY = {
  RADIUS: 0.42,
  ATTACK_RANGE: 1.25,
  ATTACK_RATE: 0.8,      // attacks per second
  AGGRO_RADIUS: 3.2,     // notice characters this close
  LEASH_RADIUS: 8.0,     // give up chase beyond this
  KNOCKBACK_ON_PLAYER: 2.4,
  SEPARATION_WEIGHT: 1.4,
  BREACH_DIST: 1.0,      // how close to the crystal counts as a breach
  HP_PER_WAVE: 0.16,     // +16% HP per wave past the first
  SPEED_PER_WAVE: 0.006, // slight creep
  JUMP_EVERY: 10,        // seconds between vampire shortcut hops
  // flow-dist saved for a hop to count as a shortcut (an orthogonal
  // step costs 2 — going around a lone tower only saves 2, so single
  // towers never trigger hops, real wall lines do)
  JUMP_MIN_GAIN: 4,
};

// the gravedigger pulls tombs out of the ground that keep disgorging
// zombies & skeletons until the tomb is spent (or he dies)
export const SUMMON = {
  FIRST: 3.5,        // seconds after spawning until the first tomb
  EVERY: 8,          // seconds between tombs
  PER_GRAVE: 3,      // enemies each tomb spawns
  INTERVAL: 1.7,     // seconds between spawns out of one tomb
  RADIUS: 2,         // tombs rise within this many cells of the keeper
  MAX_ENEMIES: 42,   // stop summoning if the board is already flooded
  KINDS: ['zombie', 'skeleton'],
};

// scale is a visual multiplier on the (now uniform, native-sized)
// enemy model; bumped so bosses stay as imposing as before even though
// the shared character scale makes the base models a bit smaller
export const SUBBOSS = { hpMult: 7, dmgMult: 1.8, scale: 2.4, ptsMult: 6, xpMult: 6, breach: 3 };
export const BOSS = { scale: 3.0, breach: 5, pts: 110, xp: 260 };

// checkpoint-wave bosses (waves 10, 20, 30…), rotating in this order.
// Multipliers sit on top of the base kind's wave-scaled stats so every
// boss lands near the keeper's power budget.
export const BOSSES = {
  coveiro:  { kind: 'keeper', name: 'Coveiro' },
  tirocego: { kind: 'skelarcher', name: 'Tiro Cego',
              hpMult: 19, dmgMult: 2.6, speedMult: 0.85, multishot: true },
  zecaixao: { kind: 'vampire', name: 'Zé do Caixão',
              hpMult: 3.6, dmgMult: 1.5, speedMult: 0.9, jumps: 2 },
  abobrado: { kind: 'ghost', name: 'Abobrado',
              hpMult: 26, dmgMult: 1, speedMult: 0.72,
              pumpkin: { range: 7.5, rate: 0.4, dmg: 26, aoe: 1.7, projSpeed: 8 } },
};
export const BOSS_ORDER = ['coveiro', 'tirocego', 'zecaixao', 'abobrado'];

// ---------- waves ----------
export const WAVES = {
  BUILD_TIME: 25,          // seconds between waves
  CHECKPOINT_EVERY: 10,
  SUBBOSS_EVERY: 5,
  BASE_COUNT: 8,
  COUNT_PER_WAVE: 2.6,
  SPAWN_WINDOW_BASE: 8,    // seconds over which a wave trickles in
  SPAWN_WINDOW_PER_WAVE: 0.7,
  SPAWN_WINDOW_MAX: 24,
  CHECKPOINT_BONUS: 25,    // points * wave / 10 awarded at checkpoints
};

// ---------- 1..4 player scaling ----------
// index by playerCount-1
export const SCALING = {
  enemyHp:    [0.85, 1.0, 1.2, 1.4],
  enemyCount: [0.8, 1.0, 1.3, 1.55],
  points:     [1.4, 1.1, 0.95, 0.85],
  obstaclesPerWave: [4, 3, 2, 2],
  startPoints: [70, 60, 50, 45], // per match, shared pool
  startObstacles: [4, 3, 3, 2],
};

export function scaleFor(table, playerCount) {
  return table[Math.min(Math.max(playerCount, 1), 4) - 1];
}

// ---------- networking ----------
export const NET = {
  APP_ID: 'dtc-defend-the-crystal-v1',
  SNAP_HZ: 12,
  INPUT_HZ: 15,
  INTERP_DELAY: 0.13, // seconds clients render behind the newest snapshot
};

export const SIM_DT = 1 / 30;
