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
  // NOTE: base atk is deliberately a bit below the pre-weapon value —
  // the class's free STARTER weapon carries the rest (base × starter
  // multiplier ≈ the old atk), so a starter loadout performs the same
  // as before while every weapon shows a real, non-zero damage number.
  berserker: {
    name: 'Berserker', icon: 'axe',
    hp: 230, def: 0.25, atk: 28, range: 1.8, rate: 1.15, speed: 4.3,
    knockback: 1.8, model: 'char-berserker',
    weapon: 'Battle axe',
    blurb: 'A frontline bruiser who trades safety for devastating melee hits.',
  },
  tanker: {
    name: 'Tanker', icon: 'shield',
    hp: 340, def: 0.45, atk: 16, range: 1.8, rate: 1.0, speed: 3.4,
    knockback: 1.3, model: 'char-tanker',
    weapon: 'Sword & shield',
    blurb: 'An immovable wall that soaks damage and always holds the line.',
  },
  archer: {
    name: 'Archer', icon: 'bow',
    hp: 150, def: 0.10, atk: 13, range: 7.0, rate: 2.3, speed: 5.3,
    knockback: 0.6, model: 'char-archer',
    weapon: 'Longbow',
    blurb: 'A nimble sharpshooter raining fast arrows from a safe distance.',
  },
  mage: {
    name: 'Mage', icon: 'orb',
    hp: 175, def: 0.22, atk: 13, range: 8.5, rate: 0.85, speed: 4.4,
    knockback: 0.8, aoe: 1.9, model: 'char-mage',
    weapon: 'Arcane staff',
    blurb: 'A ranged caster that melts whole clusters with area blasts.',
  },
};

// hop over exactly one blocked grid cell (tower/obstacle) — the monkey
// pet stretches that to several cells in a row (see PETS.monkey)
export const JUMP = { DUR: 0.55, HEIGHT: 1.4 };

// longer vaults (monkey pet) take proportionally longer in the air;
// used by the sim, the owning client's prediction and the animation
export function jumpDurFor(span) {
  return JUMP.DUR * (1 + 0.35 * (Math.max(span, 1) - 1));
}

// ---------- pets ----------
// Every character owns pets (persisted in the browser, per character)
// and can keep ONE at its side. Pets level up permanently — their XP
// mirrors the XP orbs their owner collects — and their effect grows a
// tiny bit with every level, up to level 50.
export const PET = {
  LEVEL_CAP: 50,
  // xpNext = XP_BASE * lvl^XP_POW (persists across matches). Levels are
  // permanent, so they're meant to be a slow burn — each level needs
  // roughly twice the XP a player level does.
  XP_BASE: 50,
  XP_POW: 1.3,
  // fraction of the owner's collected XP that feeds the companion. Pets
  // are a long-haul progression, so by default they crawl up at half the
  // rate the XP orbs would otherwise grant.
  XP_GAIN: 0.5,
  NAME_MAX: 10,  // pet names render on overhead labels, keep them short
  CRIT_MULT: 2,  // tiger crits deal double damage
  DEF_CAP: 0.85, // total defense can never absorb more than this
};

// price = gold coins at the sanctuary pet vendor. The four starters are
// also the free pick every new character gets (one of them, for free).
export const PETS = {
  dog: {
    name: 'Dog', starter: true, price: 2, model: 'pet-dog',
    blurb: 'A loyal friend — slightly boosts all your base stats.',
  },
  cat: {
    name: 'Cat', starter: true, price: 2, model: 'pet-cat',
    blurb: 'Quick paws — you move faster.',
  },
  pig: {
    name: 'Pig', starter: true, price: 2, model: 'pet-pig',
    blurb: 'A lucky snout — you earn more points.',
  },
  crab: {
    name: 'Crab', starter: true, price: 2, model: 'pet-crab',
    blurb: 'Hard shell — you take less damage.',
  },
  bunny: {
    name: 'Bunny', price: 3, model: 'pet-bunny',
    blurb: 'Drop luck — chance to double the gold coins you find.',
  },
  giraffe: {
    name: 'Giraffe', price: 3, model: 'pet-giraffe',
    blurb: 'Long neck — collects orbs and items from farther away.',
  },
  elephant: {
    name: 'Elephant', price: 4, model: 'pet-elephant',
    blurb: 'Heavy stance — you resist knockback.',
  },
  fox: {
    name: 'Fox', price: 4, model: 'pet-fox',
    blurb: 'Sharp reflexes — you attack faster.',
  },
  panda: {
    name: 'Panda', price: 4, model: 'pet-panda',
    blurb: 'Calm spirit — your health regenerates faster.',
  },
  hog: {
    name: 'Hog', price: 5, model: 'pet-hog',
    blurb: 'Wild charge — your attacks knock enemies back.',
  },
  monkey: {
    name: 'Monkey', price: 5, model: 'pet-monkey',
    blurb: 'Acrobat — jump over more blocks in a row (up to 5).',
  },
  tiger: {
    name: 'Tiger', price: 6, model: 'pet-tiger',
    blurb: 'Killer instinct — chance to land critical hits.',
  },
  lion: {
    name: 'Lion', price: 6, model: 'pet-lion',
    blurb: 'King’s roar — you deal more damage.',
  },
};

// Concrete effect numbers for a pet at a given level. Defaults are the
// identity so the sim can apply the whole struct unconditionally.
export function petEffects(petId, lvl) {
  const fx = {
    hp: 1, atk: 1, spd: 1, rate: 1, def: 0,   // base-stat multipliers / def add
    kbMult: 1, kbDealt: 0, kbResist: 0,       // knockback dealt / taken
    crit: 0, luck: 0, pts: 1,                 // crit chance, gold luck, points mult
    collect: 0, jump: 1, regen: 1,            // extra collect cells, jump cells, regen mult
  };
  if (!PETS[petId]) return fx;
  const L = clampLvl(lvl);
  const g = L - 1; // growth steps past level 1
  switch (petId) {
    case 'dog': {
      const all = 1.04 + 0.0022 * g; // +4% → +15% at 50
      fx.hp = all; fx.atk = all; fx.spd = all; fx.rate = all;
      fx.def = 0.02 + 0.0006 * g;
      break;
    }
    case 'cat': fx.spd = 1.08 + 0.0045 * g; break;      // +8% → +30%
    case 'pig': fx.pts = 1.10 + 0.008 * g; break;       // +10% → +49%
    case 'crab': fx.def = 0.06 + 0.0029 * g; break;     // +6% → +20% absorb
    case 'bunny': fx.luck = 0.10 + 0.01 * g; break;     // 10% → 59% double gold
    case 'fox': fx.rate = 1.08 + 0.0055 * g; break;     // +8% → +35%
    case 'lion': fx.atk = 1.10 + 0.006 * g; break;      // +10% → +39%
    case 'tiger': fx.crit = 0.06 + 0.005 * g; break;    // 6% → 30.5% crit
    case 'giraffe': fx.collect = 1 + Math.floor(L / 25); break; // +1/+2/+3 cells
    case 'elephant': fx.kbResist = 0.30 + 0.0102 * g; break;    // -30% → -80% kb
    case 'hog': {
      fx.kbDealt = 0.35 + 0.0135 * g; // ranged attacks gain this much kb…
      fx.kbMult = 1 + fx.kbDealt;     // …and melee/blast kb is multiplied
      break;
    }
    case 'monkey': fx.jump = Math.min(2 + Math.floor(L / 10), 5); break; // +1 cell / 10 lvls
    case 'panda': fx.regen = 1.35 + 0.0235 * g; break;  // +35% → +150% regen
  }
  return fx;
}

const clampLvl = (lvl) =>
  Math.min(Math.max(Math.round(Number(lvl) || 1), 1), PET.LEVEL_CAP);

export function petXpNext(lvl) {
  return Math.round(PET.XP_BASE * Math.pow(clampLvl(lvl), PET.XP_POW));
}

// (petEffectText moved to i18n.js so its wording can be localized)

// validate a {id, lvl, name} pet reference coming over the wire or from
// storage; returns null when it isn't a real pet
export function sanitizePetRef(pet) {
  if (!pet || typeof pet !== 'object' || !PETS[pet.id]) return null;
  const lvl = clampLvl(pet.lvl);
  const name = String(pet.name || PETS[pet.id].name).slice(0, PET.NAME_MAX);
  return { id: pet.id, lvl, name };
}

// ---------- weapons & shields ----------
// Bought with gold coins at the sanctuary weapon smith (opposite side
// of the plaza from the pet vendor) and PERMANENT per character, like
// pets. Every weapon carries its own stats which stack multiplicatively
// (or additively where noted) on top of the class base + pet bonus:
//   atk    damage multiplier (magic power for mage weapons)
//   rate   attack-speed multiplier
//   crit   critical-hit chance ADDED (physical weapons only)
//   range  attack range ADDED (world units)
//   move   move-speed multiplier — big heavy weapons slow you slightly
//   aoe    blast-area multiplier (magic weapons)
//   def    damage absorption ADDED (shields)
//   block  chance to fully block a hit (shields)
// Starting weapons are (near-)neutral so current class performance
// barely moves; everything else is priced in gold coins.
export const WEAPON_TIER_NAMES = ['Normal', 'Gold', 'Crystal'];
export const WEAPON_TIER_MAX = 2; // 0 normal → 1 gold → 2 crystal

// per-tier growth applied on top of a weapon's base stats
export const WEAPON_TIER_FX = [
  { atk: 1,    rate: 1,    crit: 0,    range: 0,   def: 0,    block: 0,    bonus: 1 },
  { atk: 1.14, rate: 1.05, crit: 0.03, range: 0.2, def: 0.03, block: 0.04, bonus: 1.5 },
  { atk: 1.30, rate: 1.10, crit: 0.06, range: 0.4, def: 0.06, block: 0.08, bonus: 2 },
];

export const STUN = { DUR: 1.1, BOSS_MULT: 0.4 }; // hammer bonus
export const ORB = { BOLT_MULT: 0.45 };           // damage per guided bolt

// Damage multipliers are all comfortably above 1: the STANDARD weapon of
// each family (sword / bow / staff) already grants a real damage bonus
// (~+15%), and the class base atk was lowered to match, so nothing ever
// reads "0% damage". Heavier weapons climb from there.
export const WEAPONS = {
  // ---- melee (physical): atk, rate, crit, range, move ----
  axe: {
    name: 'Axe', slot: 'weapon', kind: 'melee', price: 4,
    classes: ['berserker', 'tanker'], starterFor: ['berserker'],
    atk: 1.28, rate: 0.92, crit: 0.08,
    blurb: 'Hits harder than a sword and bites deep on crits, but swings slower.',
  },
  greataxe: {
    name: 'Great Axe', slot: 'weapon', kind: 'melee', price: 8,
    classes: ['berserker'],
    atk: 1.5, rate: 0.8, crit: 0.08, range: 0.4, move: 0.96,
    blurb: 'A monstrous axe — huge damage and reach, slow swings, heavy to carry.',
  },
  hammer: {
    name: 'War Hammer', slot: 'weapon', kind: 'melee', price: 6,
    classes: ['berserker'],
    atk: 1.28, rate: 0.86, crit: 0.08, move: 0.98, stun: 0.10,
    blurb: 'Axe-grade damage a touch slower — and skulls ring: chance to stun.',
    bonusText: (v) => `${Math.round(v * 100)}% chance to stun enemies`,
  },
  spear: {
    name: 'Spear', slot: 'weapon', kind: 'melee', price: 5,
    classes: ['tanker'],
    atk: 1.08, rate: 1.0, crit: 0.03, range: 0.8,
    blurb: 'A touch lighter than a sword, but the longest reach of any melee weapon.',
  },
  sword: {
    name: 'Sword', slot: 'weapon', kind: 'melee', price: 3,
    classes: ['tanker'], starterFor: ['tanker'],
    atk: 1.15, rate: 1.0, crit: 0.05,
    blurb: 'The all-rounder blade every other weapon is measured against.',
  },
  greatsword: {
    name: 'Great Sword', slot: 'weapon', kind: 'melee', price: 8,
    classes: ['berserker'],
    atk: 1.36, rate: 0.9, crit: 0.05, range: 0.4, move: 0.98,
    blurb: 'A two-hander: more damage and reach than a sword, slightly slower.',
  },
  // ---- shields (tanker off-hand): def, block, move ----
  shield: {
    name: 'Shield', slot: 'shield', kind: 'shield', price: 3,
    classes: ['tanker'], starterFor: ['tanker'],
    block: 0.05,
    blurb: 'A trusty round shield — every so often it blocks a hit outright.',
  },
  greatshield: {
    name: 'Great Shield', slot: 'shield', kind: 'shield', price: 6,
    classes: ['tanker'],
    def: 0.06, block: 0.12, move: 0.94,
    blurb: 'A wall of a shield: more absorption, more blocks, a heavier stride.',
  },
  // ---- bows (physical, ranged) ----
  bow: {
    name: 'Bow', slot: 'weapon', kind: 'bow', price: 3,
    classes: ['archer'], starterFor: ['archer'],
    atk: 1.15, rate: 1.0, crit: 0.05,
    blurb: 'The trusty longbow — balanced damage, range and speed.',
  },
  greatbow: {
    name: 'Great Bow', slot: 'weapon', kind: 'bow', price: 7,
    classes: ['archer'],
    atk: 1.38, rate: 0.85, crit: 0.05, range: 1.2, move: 0.97,
    blurb: 'A towering warbow: harder hits from farther away, slower to draw.',
  },
  crossbow: {
    name: 'Crossbow', slot: 'weapon', kind: 'bow', price: 5,
    classes: ['archer'],
    atk: 1.02, rate: 1.25, crit: 0.05,
    blurb: 'Lighter bolts but a rapid trigger — the fastest shooter of the bows.',
  },
  // ---- magic (mage): atk = magic power, aoe = blast-area multiplier ----
  staff: {
    name: 'Arcane Staff', slot: 'weapon', kind: 'magic', price: 3,
    classes: ['mage'], starterFor: ['mage'],
    atk: 1.2, rate: 1.0, aoe: 1.0,
    blurb: 'The full-size caster staff — the strongest single blast a mage can throw.',
  },
  wand: {
    name: 'Wand', slot: 'weapon', kind: 'magic', price: 5,
    classes: ['mage'],
    atk: 1.04, rate: 1.18, aoe: 0.75,
    blurb: 'A short red-crystal wand: quicker casts, smaller blasts.',
  },
  orb: {
    name: 'Arcane Orb', slot: 'weapon', kind: 'magic', price: 7,
    classes: ['mage'],
    atk: 0.95, rate: 1.22, aoe: 0, bolts: 3,
    blurb: 'No blast at all — instead it launches guided bolts at several enemies.',
    bonusText: (v) => `${v} guided bolts per cast`,
  },
};

// which weapons each class may buy/equip (derived once)
export const CLASS_WEAPONS = {};
for (const [id, def] of Object.entries(WEAPONS)) {
  for (const cls of def.classes) (CLASS_WEAPONS[cls] ??= []).push(id);
}

export function classStarterWeapons(cls) {
  return Object.entries(WEAPONS)
    .filter(([, d]) => d.starterFor?.includes(cls))
    .map(([id]) => id);
}

const clampTier = (t) => Math.min(Math.max(Math.round(Number(t) || 0), 0), WEAPON_TIER_MAX);

// Resolved stats for a weapon at a tier — every field present so the
// sim can apply the whole struct unconditionally (identity defaults).
export function weaponEffects(id, tier) {
  const fx = {
    atk: 1, rate: 1, crit: 0, range: 0, move: 1,
    aoe: 1, def: 0, block: 0, stun: 0, bolts: 0,
  };
  const def = WEAPONS[id];
  if (!def) return fx;
  const t = WEAPON_TIER_FX[clampTier(tier)];
  fx.atk = (def.atk ?? 1) * t.atk;
  fx.rate = (def.rate ?? 1) * t.rate;
  fx.crit = def.crit ? def.crit + t.crit : 0;
  fx.range = (def.range || 0) + (def.slot === 'weapon' && def.kind !== 'shield' ? t.range : 0);
  fx.move = def.move ?? 1;
  fx.aoe = def.aoe ?? 1;
  fx.def = (def.def || 0) + (def.slot === 'shield' ? t.def : 0);
  fx.block = def.block ? def.block + t.block : 0;
  fx.stun = def.stun ? Math.min(def.stun * t.bonus, 0.35) : 0;
  fx.bolts = def.bolts ? def.bolts + clampTier(tier) : 0; // 3 → 4 → 5
  return fx;
}

// upgrade to the NEXT tier costs this many gold coins
export function weaponUpgradeCost(id, tier) {
  const def = WEAPONS[id];
  if (!def || clampTier(tier) >= WEAPON_TIER_MAX) return 0;
  return Math.max(2, Math.round(def.price * (clampTier(tier) === 0 ? 1 : 1.6)));
}

// (weaponStatText moved to i18n.js so its wording can be localized)

// validate a {id, tier} weapon reference (wire / storage); `slot`
// restricts to weapon-or-shield, `cls` to that class's arsenal
export function sanitizeWeaponRef(ref, cls, slot) {
  if (!ref || typeof ref !== 'object') return null;
  const def = WEAPONS[ref.id];
  if (!def || def.slot !== slot) return null;
  if (cls && !def.classes.includes(cls)) return null;
  return { id: ref.id, tier: clampTier(ref.tier) };
}

// ---------- gold coins ----------
// Permanent currency for sanctuary vendors. Only (mini-)bosses drop
// them, one orb PER PLAYER (like all drops), so everyone earns the same.
export const GOLD = {
  SUBBOSS: 1, // coins per player from a mini-boss
  BOSS: 2,    // coins per player from a checkpoint boss
  TTL: 25,    // gold is precious — it lingers longer than other orbs
};

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
  // pulses a mage-style blast on every enemy in the tiles around it;
  // upgrades grow damage & rate as usual AND the pulse radius (aoeAdd)
  crystal: {
    name: 'Crystal', icon: 'crystal', cost: 190,
    dmg: 22, range: 3.1, rate: 0.45, aoe: 3.1, projSpeed: 99,
    model: 'tower-crystal', pulse: true, aoeGrow: 0.3, img: 'tower-crystal',
  },
  // sprays a burning jet at its target: modest impact damage plus a
  // fire DoT that keeps ticking on everything the jet washes over
  flame: {
    name: 'Flamethrower', icon: 'flame', cost: 320,
    dmg: 9, range: 4.2, rate: 1.1, aoe: 1.1, projSpeed: 99,
    model: 'tower-flame', jet: true, burnDps: 11, burnDur: 2.4, img: 'tower-flame',
  },
};
// 6 levels: grey → blue → green → red → purple → gold
export const TOWER_LEVEL_MAX = 6;
export const TOWER_UPGRADE = {
  dmgMult: 1.45, rangeAdd: 0.35, rateMult: 1.12,
  costMult: [0, 0.9, 1.4, 2.0, 2.8, 3.8], // upgrade cost = base * costMult[currentLvl]
  sellRefund: 0.6,
};

// ---------- tower special effects (bonus upgrades) ----------
// One-time purchases layered ON TOP of the normal level upgrades —
// they never replace them. Each tower picks at most ONE special,
// permanently. Where a tower offers two, they are exclusive paths.
export const TOWER_SPECIALS = {
  ballista: {
    triple: { name: 'Triple Shot', cost: 170,
              desc: 'Looses 3 arrows per volley at up to 3 different targets.' },
    pierce: { name: 'Piercing Bolts', cost: 170,
              desc: 'Bolts punch through, hitting every enemy along their line.' },
  },
  catapult: {
    scatter: { name: 'Scatter Shot', cost: 210, balls: 5, dmgMult: 0.4, spread: 1.6,
               desc: 'Hurls 5 spreading metal balls — together, double the damage.' },
  },
  cannon: {
    napalm: { name: 'Burning Ground', cost: 250, dur: 3.5, dps: 10,
              desc: 'Shells leave the ground burning where they land.' },
  },
  crystal: {
    ice: { name: 'Ice Crystal', cost: 230, slowF: 0.5, slowDur: 2.2,
           desc: 'Pulses chill enemies, slowing them for a few seconds.' },
    storm: { name: 'Storm Crystal', cost: 230, chainR: 1.7, chainMult: 0.55,
             desc: 'Damage arcs between enemies bunched close together.' },
  },
  flame: {
    venom: { name: 'Venom Thrower', cost: 480, dpsMult: 1.25, durMult: 2.2, aoeMult: 1.5,
             desc: 'Spits spreading poison that drains life far longer.' },
  },
};

// status-effect tuning shared by sim & view
export const STATUS = {
  SLOW_F: 0.5,        // default speed multiplier while chilled
  DOT_TICK: 0.45,     // seconds between burn/poison damage ticks
  FIRE_KIND: 1,       // dot kinds (for stacking rules)
  POISON_KIND: 2,
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
  // Aggro only ever sticks when the enemy has a CLEAR straight path to
  // the character (no tower/obstacle cell between them), and never when
  // the crystal is closer to the enemy than the character is — the
  // crystal always outranks the bait.
  // Anti-kiting: while chasing, walking the enemy BACK toward its spawn
  // (away from its closest-yet approach to the crystal) charges a drag
  // timer; past DRAG_TIME it shrugs the chase off and won't re-aggro
  // for AGGRO_REFRACT seconds, so it genuinely returns to the path.
  DRAG_SLACK: 1.2,       // world units of pull-back tolerated freely
  DRAG_TIME: 2.6,        // seconds being dragged backward before giving up
  AGGRO_REFRACT: 5,      // seconds of aggro immunity after giving up
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
  // not one boss but an infestation: 100 zombies flooding in at a
  // brutal spawn rate. Green ones die normally, blue ones rise again
  // twice, red ones three times (see HORDE below).
  horda:    { kind: 'zombie', name: 'A Horda Zumbi', horde: true },
  // Brutus hauls a great shield & great axe: by far the toughest boss
  // on the field (heavy armor on top of a huge HP pool) — and by far
  // the slowest march you'll ever get to prepare for.
  brutus:   { kind: 'orc', name: 'Brutus',
              hpMult: 6.5, dmgMult: 2.4, speedMult: 0.55, armor: 0.35 },
};
export const BOSS_ORDER = ['coveiro', 'tirocego', 'horda', 'zecaixao', 'brutus', 'abobrado'];

// the zombie horde's composition & balance: per-zombie stats shrink so
// a hundred of them stays beatable, and the spawn window is short so
// the flood genuinely reads as a horde
export const HORDE = {
  GREEN: 50, BLUE: 35, RED: 15,   // blue revives ×2, red revives ×3
  REVIVES: { blue: 2, red: 3 },
  hpMult: 0.32, dmgMult: 0.8, speedMult: 1.15,
  WINDOW: 42,      // seconds over which all 100 pour in
  ptsMult: 0.5, xpMult: 0.5, // per-zombie loot halves (×100 zombies!)
  // blue/red troopers wear the stage-2/3 look; sizes stay a notch under
  // the regular tiers so a hundred of them still fit the lanes
  SCALE: { green: 1, blue: 1.45, red: 1.9 },
};

// sub-bosses rotate through EVERY mob kind, never repeating until the
// list wraps (waves 5, 15, 25, … — ordered so each kind is already a
// familiar sight by the time its pumped-up version struts in)
export const SUBBOSS_ORDER = ['zombie', 'skelarcher', 'orc', 'ghost', 'vampire', 'skeleton'];

// ---------- enemy tiers (visual power stages) ----------
// As waves march on, regular enemies start showing up in stronger,
// clearly-marked stages: stage 2 is mid-sized (mini-boss build) with a
// recolored hide, stage 3 is boss-sized but nowhere near boss HP.
// The mix grows GRADUALLY: nothing above stage 1 before wave 11, then
// stage-2 odds ramp up slowly, and stage 3 trickles in hard-capped per
// wave (1 at first, never more than 2) so a wave is never a wall of
// giants.
export const TIERS = {
  2: { hp: 2.2, dmg: 1.4, pts: 2, xp: 2, scale: 1.7 },
  3: { hp: 4.2, dmg: 1.8, pts: 4, xp: 4, scale: 2.5, speedMult: 0.92 },
};
export const TIER_PLAN = {
  T2_FROM: 11,        // first wave that can roll stage-2 enemies
  T2_RAMP: 0.035,     // stage-2 chance grows this much per wave past T2_FROM
  T2_MAX: 0.45,       // …up to at most this share of a wave
  T3_FROM: 16,        // first wave that can roll a stage-3 enemy
  T3_RAMP: 0.012,     // stage-3 chance per enemy past T3_FROM
  T3_MAX: 0.12,
  T3_CAP_1: 26,       // waves below this allow 1 stage-3; from here on, 2
};

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
  // host -> clients position rate. Raised now that per-tick snapshots omit
  // the static geometry (towers/obstacles/graves), which the client caches
  // and re-merges — so more frequent snapshots cost little extra bandwidth.
  SNAP_HZ: 18,
  INPUT_HZ: 15,
  // how often the host includes the static geometry collections in a
  // snapshot; between these the payload carries only moving state.
  STATIC_INTERVAL: 0.5,
  // seconds rendered behind the newest snapshot. ~2 snapshot intervals
  // (1/SNAP_HZ) so a late/jittered packet still has a buffered point to
  // interpolate toward instead of freezing.
  INTERP_DELAY: 0.12,
  // alpha clamp ceiling: >1 lets a remote briefly extrapolate along its
  // last known heading when the next snapshot is late, softening the
  // hitch into a short over-shoot that snaps back on arrival.
  INTERP_MAX: 1.25,
};

export const SIM_DT = 1 / 30;
