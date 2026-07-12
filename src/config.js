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

// ---------- player classes ----------
// def = fraction of incoming damage absorbed.
export const CLASSES = {
  berserker: {
    name: 'Berserker', icon: 'axe',
    hp: 230, def: 0.25, atk: 36, range: 1.8, rate: 1.15, speed: 4.3,
    knockback: 1.8, model: 'char-berserker',
  },
  tanker: {
    name: 'Tanker', icon: 'shield',
    hp: 340, def: 0.45, atk: 18, range: 1.8, rate: 1.0, speed: 3.4,
    knockback: 1.3, model: 'char-tanker',
  },
  archer: {
    name: 'Archer', icon: 'bow',
    hp: 150, def: 0.10, atk: 15, range: 7.0, rate: 2.3, speed: 5.3,
    knockback: 0.6, model: 'char-archer',
  },
  mage: {
    name: 'Mage', icon: 'orb',
    hp: 175, def: 0.22, atk: 16, range: 8.5, rate: 0.85, speed: 4.4,
    knockback: 0.8, aoe: 1.9, model: 'char-mage',
  },
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
export const TOWER_LEVEL_MAX = 3;
export const TOWER_UPGRADE = {
  dmgMult: 1.55, rangeAdd: 0.4, rateMult: 1.15,
  costMult: [0, 0.9, 1.5],  // upgrade to lvl2 = cost*0.9, to lvl3 = cost*1.5
  sellRefund: 0.6,
};

export const OBSTACLES = ['rocks', 'barrel']; // random cosmetic variety
export const OBSTACLE_STOCK_CAP = 10;

// ---------- enemies ----------
export const ENEMIES = {
  skeleton: { hp: 32,  speed: 2.3, dmg: 8,  pts: 10, xp: 8,  fromWave: 1, model: 'enemy-skeleton' },
  zombie:   { hp: 78,  speed: 1.5, dmg: 14, pts: 16, xp: 13, fromWave: 2, model: 'enemy-zombie' },
  ghost:    { hp: 26,  speed: 2.9, dmg: 6,  pts: 14, xp: 11, fromWave: 4, model: 'enemy-ghost', flying: true },
  orc:      { hp: 155, speed: 1.9, dmg: 22, pts: 28, xp: 22, fromWave: 6, model: 'enemy-orc' },
  vampire:  { hp: 235, speed: 2.5, dmg: 30, pts: 48, xp: 36, fromWave: 9, model: 'enemy-vampire' },
  keeper:   { hp: 900, speed: 1.6, dmg: 40, pts: 400, xp: 300, fromWave: 999, model: 'enemy-keeper' }, // boss only
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
};

export const SUBBOSS = { hpMult: 7, dmgMult: 1.8, scale: 1.65, ptsMult: 6, xpMult: 6, breach: 3 };
export const BOSS = { scale: 2.1, breach: 5 };

// ---------- waves ----------
export const WAVES = {
  BUILD_TIME: 25,          // seconds between waves
  CHECKPOINT_EVERY: 10,
  SUBBOSS_EVERY: 5,
  BASE_COUNT: 5,
  COUNT_PER_WAVE: 2.0,
  SPAWN_WINDOW_BASE: 8,    // seconds over which a wave trickles in
  SPAWN_WINDOW_PER_WAVE: 0.7,
  SPAWN_WINDOW_MAX: 22,
  CHECKPOINT_BONUS: 60,    // points * wave / 10 awarded at checkpoints
};

// ---------- 1..4 player scaling ----------
// index by playerCount-1
export const SCALING = {
  enemyHp:    [0.85, 1.0, 1.2, 1.4],
  enemyCount: [0.8, 1.0, 1.3, 1.55],
  points:     [1.7, 1.3, 1.15, 1.0],
  obstaclesPerWave: [4, 3, 2, 2],
  startPoints: [140, 110, 90, 80], // per match, shared pool
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
