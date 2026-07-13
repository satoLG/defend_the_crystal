import {
  ENEMIES, ENEMY, WAVES, SUBBOSS, BOSS, BOSSES, BOSS_ORDER, SCALING, scaleFor,
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
    // strongest currently-available rank, pumped up
    const kinds = Object.keys(weights);
    plan.push({ kind: kinds[kinds.length - 1], at: window * 0.6, boss: 1 });
  }
  if (isBossWave) {
    // checkpoint bosses rotate: Coveiro, Tiro Cego, Zé do Caixão, Abobrado…
    const variant = BOSS_ORDER[(wave / WAVES.CHECKPOINT_EVERY - 1) % BOSS_ORDER.length];
    plan.push({ kind: BOSSES[variant].kind, at: window * 0.7, boss: 2, variant });
  }

  plan.sort((a, b) => a.at - b.at);
  return plan;
}

// Concrete stats for one spawned enemy.
export function enemyStats(kind, boss, wave, playerCount, variant) {
  const def = ENEMIES[kind];
  const hpMult = waveHpMult(wave, playerCount);
  const speed = def.speed * (1 + ENEMY.SPEED_PER_WAVE * (wave - 1));
  if (boss === 2) {
    const v = BOSSES[variant] || {};
    return {
      hp: def.hp * hpMult * (v.hpMult || 1),
      dmg: def.dmg * (v.dmgMult || 1),
      speed: speed * (v.speedMult || 1),
      pts: BOSS.pts, xp: BOSS.xp, scale: BOSS.scale, breach: BOSS.breach,
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
