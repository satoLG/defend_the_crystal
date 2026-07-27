import {
  ENEMIES, ENEMY, WAVES, SUBBOSS, BOSS, BOSSES, BOSS_ORDER, SCALING, scaleFor,
  SUBBOSSES, SUBBOSS_ESCORT, SUBBOSS_ESCORT_COUNT, PHASES, HORDE, TIERS, TIER_PLAN,
} from '../config.js';

// ============================================================
// Wave composition: which enemies spawn, when, and how strong.
// ============================================================

// Waves 1..CYCLE are authored; after that the arc repeats with tougher
// enemies. `wave` is the position inside the arc (what decides the
// composition, the boss and the volume), `lap` how many full runs are
// already behind us (what decides the extra punch).
export function cycleOf(wave) {
  const n = WAVES.CYCLE;
  return { wave: ((wave - 1) % n) + 1, lap: Math.floor((wave - 1) / n) };
}

// the authored mix for this point of the arc — the last PHASES entry
// whose `from` we've reached
function phaseMix(cycleWave) {
  let mix = PHASES[0].mix;
  for (const p of PHASES) {
    if (cycleWave < p.from) break;
    mix = p.mix;
  }
  return mix;
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
// `classes` lists the classes of the heroes in the match — only the
// Sombra needs it, to field one shade per class in play.
export function buildWavePlan(wave, playerCount, classes = []) {
  // everything below reads the position inside the authored arc, so a
  // lap-2 wave 105 fields exactly what wave 5 fields — just meaner
  const { wave: cw } = cycleOf(wave);
  const window = Math.min(
    WAVES.SPAWN_WINDOW_MAX,
    WAVES.SPAWN_WINDOW_BASE + cw * WAVES.SPAWN_WINDOW_PER_WAVE
  );
  const isBossWave = cw % WAVES.CHECKPOINT_EVERY === 0;
  const isSubBossWave = !isBossWave && cw % WAVES.SUBBOSS_EVERY === 0;

  const plan = isBossWave ? bossWave(cw, playerCount, window, classes)
    : isSubBossWave ? subBossWave(cw, playerCount, window)
      : mixedWave(cw, playerCount, window);

  plan.sort((a, b) => a.at - b.at);
  return plan;
}

// spread a list of {kind, n, tier} entries over the spawn window
function spread(entries, window, playerCount, from = 0.5) {
  const out = [];
  const scale = scaleFor(SCALING.enemyCount, playerCount);
  for (const e of entries) {
    const n = Math.max(1, Math.round((e.n ?? 1) * scale));
    for (let i = 0; i < n; i++) out.push({ ...e, n: undefined, kind: e.kind, boss: 0, tier: e.tier || 1 });
  }
  out.forEach((s, i) => {
    s.at = from + (window * i) / Math.max(out.length, 1) + Math.random() * 0.4;
  });
  return out;
}

// an ordinary wave: the phase's mix, rolled per spawn, with the stage-2
// and stage-3 giants trickling in as the arc goes on
function mixedWave(cw, playerCount, window) {
  const weights = phaseMix(cw);
  const count = Math.max(3, Math.round(
    (WAVES.BASE_COUNT + cw * WAVES.COUNT_PER_WAVE) * scaleFor(SCALING.enemyCount, playerCount)
  ));
  const t2p = cw < TIER_PLAN.T2_FROM ? 0
    : Math.min((cw - TIER_PLAN.T2_FROM + 1) * TIER_PLAN.T2_RAMP, TIER_PLAN.T2_MAX);
  const t3p = cw < TIER_PLAN.T3_FROM ? 0
    : Math.min((cw - TIER_PLAN.T3_FROM + 1) * TIER_PLAN.T3_RAMP, TIER_PLAN.T3_MAX);
  let t3left = cw < TIER_PLAN.T3_FROM ? 0 : cw < TIER_PLAN.T3_CAP_1 ? 1 : 2;

  const plan = [];
  for (let i = 0; i < count; i++) {
    let tier = 1;
    if (t3left > 0 && Math.random() < t3p) { tier = 3; t3left -= 1; }
    else if (Math.random() < t2p) tier = 2;
    plan.push({
      kind: pickWeighted(weights),
      at: 0.5 + (window * i) / count + Math.random() * 0.4,
      boss: 0, tier,
    });
  }
  return plan;
}

// a sub-boss wave fields only the squad's own kin, so the fight reads as
// "the blue zombie and his zombies" rather than as a mixed crowd
function subBossWave(cw, playerCount, window) {
  const squad = SUBBOSSES[cw] || [];
  const escort = SUBBOSS_ESCORT[cw]
    || squad.map((s) => ({ kind: s.kind, n: SUBBOSS_ESCORT_COUNT / squad.length }));
  const plan = spread(escort, window, playerCount);
  squad.forEach((s, i) => {
    plan.push({ ...s, at: window * 0.6 + i * 1.2, boss: 1 });
  });
  return plan;
}

// a boss wave is the boss plus its own authored escort — never the
// phase mix, so the checkpoint reads as that boss's fight
function bossWave(cw, playerCount, window, classes) {
  const variant = BOSS_ORDER[(cw / WAVES.CHECKPOINT_EVERY - 1) % BOSS_ORDER.length];
  const def = BOSSES[variant];

  if (def.horde) {
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
      kind: def.kind, boss: 0, variant, horde: tint || 'green',
      at: 1 + (HORDE.WINDOW * i) / troops.length + Math.random() * 0.3,
    }));
    hordePlan.sort((a, b) => a.at - b.at);
    hordePlan[0].announce = variant; // banner on first spawn (localized client-side)
    return hordePlan;
  }

  const plan = spread(def.escort || [], window, playerCount);

  // the Sombra's escort is built from who is actually playing: one
  // small shade wearing each class in the party
  if (def.shades) {
    const seen = [...new Set(classes)];
    for (const cls of seen) {
      for (let i = 0; i < def.shades.n; i++) {
        plan.push({ kind: def.kind, boss: 0, variant, shade: cls, at: window * 0.5 + i * 0.8 });
      }
    }
  }

  plan.push({ kind: def.kind, at: window * 0.7, boss: 2, variant });
  return plan;
}

// Concrete stats for one spawned enemy. `horde` marks a Zombie Horde
// trooper ('green' | 'blue' | 'red'): weaker individually, and the
// blue/red ones rise again after falling. `tier` (2|3) marks the
// mid/large power stages regular enemies grow into on later waves.
export function enemyStats(kind, boss, wave, playerCount, variant, horde = null, tier = 1, opts = null) {
  const def = ENEMIES[kind];
  const hpMult = waveHpMult(wave, playerCount);
  const speed = def.speed * (1 + ENEMY.SPEED_PER_WAVE * (wave - 1));
  // HP already climbs with the raw wave number forever; damage is flat,
  // so each completed lap of the authored arc adds its own bite
  const dmgMult = 1 + WAVES.LAP_DMG * cycleOf(wave).lap;
  if (horde) {
    return {
      hp: def.hp * hpMult * HORDE.hpMult,
      dmg: def.dmg * HORDE.dmgMult * dmgMult,
      speed: speed * HORDE.speedMult,
      pts: Math.max(1, Math.round(def.pts * HORDE.ptsMult)),
      xp: Math.max(1, Math.round(def.xp * HORDE.xpMult)),
      scale: HORDE.SCALE[horde] || 1, breach: 1,
      revives: HORDE.REVIVES[horde] || 0,
      tier: horde === 'blue' ? 2 : horde === 'red' ? 3 : 1,
    };
  }
  if (boss === 2) {
    const v = BOSSES[variant] || {};
    return {
      hp: def.hp * hpMult * (v.hpMult || 1),
      dmg: def.dmg * (v.dmgMult || 1) * dmgMult,
      speed: speed * (v.speedMult || 1),
      pts: BOSS.pts, xp: BOSS.xp, breach: BOSS.breach,
      // a few bosses need more presence than the shared boss size gives
      // them (the spider is squat, the dragon reads small in the air)
      scale: BOSS.scale * (v.scale || 1),
      armor: v.armor || 0, // flat damage reduction on every hit
    };
  }
  // one of the Sombra's shades: a small, weak echo of a hero class
  if (opts?.shade) {
    const s = BOSSES.sombra.shades;
    return {
      hp: def.hp * hpMult * (BOSSES.sombra.hpMult || 1) * s.hpMult,
      dmg: def.dmg * (BOSSES.sombra.dmgMult || 1) * s.dmgMult * dmgMult,
      speed, pts: def.pts * 3, xp: def.xp * 3,
      scale: s.scale, breach: 1, tier: 1,
    };
  }
  if (boss === 1) {
    // a wave's SUBBOSSES entry may dial the size down (the grey archer,
    // the three gravediggers) or hand out extra lives (the red zombie)
    return {
      hp: def.hp * hpMult * SUBBOSS.hpMult,
      dmg: def.dmg * SUBBOSS.dmgMult * dmgMult,
      speed: speed * 0.85,
      pts: def.pts * SUBBOSS.ptsMult, xp: def.xp * SUBBOSS.xpMult,
      scale: opts?.scale || SUBBOSS.scale, breach: SUBBOSS.breach,
      revives: opts?.revives || 0,
    };
  }
  const t = TIERS[tier];
  if (t) {
    return {
      hp: def.hp * hpMult * t.hp,
      dmg: def.dmg * t.dmg * dmgMult,
      speed: speed * (t.speedMult || 1),
      pts: def.pts * t.pts, xp: def.xp * t.xp,
      scale: t.scale, breach: 1, tier,
    };
  }
  return {
    hp: def.hp * hpMult, dmg: def.dmg * dmgMult, speed,
    pts: def.pts, xp: def.xp, scale: 1, breach: 1, tier: 1,
  };
}
