import {
  ENEMIES, ENEMY, WAVES, SUBBOSS, BOSS, BOSSES, BOSS_ORDER, SCALING, scaleFor,
  SUBBOSS_ORDER, HORDE,
} from '../config.js';

// ============================================================
// Wave composition: which enemies spawn, when, and how strong.
// ============================================================

// deterministic-ish weighting: newer ranks get more common as waves go by
function rankWeights(wave) {
  const w = {};
  for (const [kind, def] of Object.entries(ENEMIES)) {
    if (kind === 'keeper' || wave < def.fromWave) continue;
    const age = wave - def.fromWave; // waves since this rank appeared
    w[kind] = 1 + Math.min(age * 0.35, 3);
  }
  return w;
}

function pickWeighted(weights) {
  let total = 0;
  for (const v of Object.values(weights)) total += v;
  let roll = Math.random() * total;
  for (const [k, v] of Object.entries(weights)) {
    roll -= v;
    if (roll <= 0) return k;
  }
  return Object.keys(weights)[0];
}

export function waveHpMult(wave, playerCount) {
  return (1 + ENEMY.HP_PER_WAVE * (wave - 1)) * scaleFor(SCALING.enemyHp, playerCount);
}

// Returns a spawn plan: [{kind, at, boss}] sorted by spawn time (seconds
// from wave start). boss: 0 normal, 1 sub-boss, 2 boss.
export function buildWavePlan(wave, playerCount) {
  const weights = rankWeights(wave);
  const count = Math.max(3, Math.round(
    (WAVES.BASE_COUNT + wave * WAVES.COUNT_PER_WAVE) * scaleFor(SCALING.enemyCount, playerCount)
  ));
  const window = Math.min(
    WAVES.SPAWN_WINDOW_MAX,
    WAVES.SPAWN_WINDOW_BASE + wave * WAVES.SPAWN_WINDOW_PER_WAVE
  );

  const plan = [];
  for (let i = 0; i < count; i++) {
    plan.push({
      kind: pickWeighted(weights),
      at: 0.5 + (window * i) / count + Math.random() * 0.4,
      boss: 0,
    });
  }

  const isBossWave = wave % WAVES.CHECKPOINT_EVERY === 0;
  const isSubBossWave = !isBossWave && wave % WAVES.SUBBOSS_EVERY === 0;
  if (isSubBossWave) {
    // fixed rotation over EVERY mob kind (waves 5, 15, 25, …): no
    // repeats until the whole roster has had its turn
    const nth = Math.floor(wave / WAVES.SUBBOSS_EVERY / 2); // 5→0, 15→1, 25→2…
    plan.push({ kind: SUBBOSS_ORDER[nth % SUBBOSS_ORDER.length], at: window * 0.6, boss: 1 });
  }
  if (isBossWave) {
    // checkpoint bosses rotate through BOSS_ORDER
    const variant = BOSS_ORDER[(wave / WAVES.CHECKPOINT_EVERY - 1) % BOSS_ORDER.length];
    if (BOSSES[variant].horde) {
      // the Zombie Horde replaces the whole wave: 100 zombies pouring
      // in over a short window. Colors: green (plain), blue (revives
      // twice), red (revives three times), shuffled together.
      const troops = [];
      for (let i = 0; i < HORDE.GREEN; i++) troops.push(null);
      for (let i = 0; i < HORDE.BLUE; i++) troops.push('blue');
      for (let i = 0; i < HORDE.RED; i++) troops.push('red');
      for (let i = troops.length - 1; i > 0; i--) {
        const j = (Math.random() * (i + 1)) | 0;
        [troops[i], troops[j]] = [troops[j], troops[i]];
      }
      const hordePlan = troops.map((tint, i) => ({
        kind: BOSSES[variant].kind, boss: 0, variant, horde: tint || 'green',
        at: 1 + (HORDE.WINDOW * i) / troops.length + Math.random() * 0.3,
      }));
      hordePlan.sort((a, b) => a.at - b.at);
      hordePlan[0].announce = BOSSES[variant].name; // banner on first spawn
      return hordePlan;
    }
    plan.push({ kind: BOSSES[variant].kind, at: window * 0.7, boss: 2, variant });
  }

  plan.sort((a, b) => a.at - b.at);
  return plan;
}

// Concrete stats for one spawned enemy. `horde` marks a Zombie Horde
// trooper ('green' | 'blue' | 'red'): weaker individually, and the
// blue/red ones rise again after falling.
export function enemyStats(kind, boss, wave, playerCount, variant, horde = null) {
  const def = ENEMIES[kind];
  const hpMult = waveHpMult(wave, playerCount);
  const speed = def.speed * (1 + ENEMY.SPEED_PER_WAVE * (wave - 1));
  if (horde) {
    return {
      hp: def.hp * hpMult * HORDE.hpMult,
      dmg: def.dmg * HORDE.dmgMult,
      speed: speed * HORDE.speedMult,
      pts: Math.max(1, Math.round(def.pts * HORDE.ptsMult)),
      xp: Math.max(1, Math.round(def.xp * HORDE.xpMult)),
      scale: 1, breach: 1,
      revives: HORDE.REVIVES[horde] || 0,
    };
  }
  if (boss === 2) {
    const v = BOSSES[variant] || {};
    return {
      hp: def.hp * hpMult * (v.hpMult || 1),
      dmg: def.dmg * (v.dmgMult || 1),
      speed: speed * (v.speedMult || 1),
      pts: BOSS.pts, xp: BOSS.xp, scale: BOSS.scale, breach: BOSS.breach,
      armor: v.armor || 0, // Brutus: flat damage reduction on every hit
    };
  }
  if (boss === 1) {
    return {
      hp: def.hp * hpMult * SUBBOSS.hpMult, dmg: def.dmg * SUBBOSS.dmgMult, speed: speed * 0.85,
      pts: def.pts * SUBBOSS.ptsMult, xp: def.xp * SUBBOSS.xpMult,
      scale: SUBBOSS.scale, breach: SUBBOSS.breach,
    };
  }
  return { hp: def.hp * hpMult, dmg: def.dmg, speed, pts: def.pts, xp: def.xp, scale: 1, breach: 1 };
}
