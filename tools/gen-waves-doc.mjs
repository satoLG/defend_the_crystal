// Generates docs/waves.md straight from the live config + planner, so
// the document can never drift from what the game actually does.
import {
  PHASES, ENEMIES, BOSSES, BOSS_ORDER, SUBBOSSES, SUBBOSS_ESCORT,
  SUBBOSS_ESCORT_COUNT, WAVES, ENEMY, TIERS, TIER_PLAN, SUBBOSS, BOSS,
  SCALING, HORDE, BLOOD_COURT, scaleFor,
} from '../packages/shared/src/config.js';
import { buildWavePlan, waveHpMult, enemyStats, cycleOf }
  from '../packages/shared/src/sim/waves.js';

const NAMES = {
  skeleton: 'Esqueleto', zombie: 'Zumbi', ghost: 'Fantasma', bat: 'Morcego',
  skelarcher: 'Arqueiro Esq.', bonethrower: 'Lança-Osso', orc: 'Orc',
  vampire: 'Vampiro', keeper: 'Coveiro', spider: 'Aranha', dragon: 'Dragão',
};
const N = (k) => NAMES[k] || k;
const pct = (v) => `${Math.round(v * 100)}%`;
const r1 = (v) => Math.round(v * 10) / 10;

const out = [];
const P = (s = '') => out.push(s);

P('# Waves 1–100 — quem aparece, quanto, e como escala');
P();
P('> Gerado de `packages/shared/src/config.js` + `sim/waves.js`.');
P('> Regenerar: `node tools/gen-waves-doc.mjs`. Não editar à mão.');
P();

// ---------------------------------------------------------------- scaling
P('## Como a força escala');
P();
P('Três coisas crescem de forma independente:');
P();
P('**1. HP de todo inimigo, por wave** — `ENEMY.HP_PER_WAVE`');
P();
P('```');
P(`hp = hp_base × (1 + ${ENEMY.HP_PER_WAVE} × (wave - 1)) × fator_jogadores`);
P('```');
P();
P('| wave | multiplicador de HP (1 jogador) |');
P('| --- | --- |');
for (const w of [1, 10, 25, 50, 75, 100]) {
  P(`| ${w} | ×${r1(waveHpMult(w, 1))} |`);
}
P();
P('**2. Velocidade** — `ENEMY.SPEED_PER_WAVE` = ' + ENEMY.SPEED_PER_WAVE
  + ` por wave (na wave 100 ≈ +${Math.round(ENEMY.SPEED_PER_WAVE * 99 * 100)}%).`);
P();
P('**3. Dano** — NÃO cresce dentro do ciclo 1–100. Só sobe a cada volta:');
P(`\`+${Math.round(WAVES.LAP_DMG * 100)}%\` por volta completa (wave 101+ = volta 1, 201+ = volta 2…).`);
P();
P('### Estágios (tier) — inimigos comuns crescem de porte');
P();
P('| estágio | HP | dano | pontos | xp | escala | aparece de |');
P('| --- | --- | --- | --- | --- | --- | --- |');
P(`| 1 (normal) | ×1 | ×1 | ×1 | ×1 | ×1 | sempre |`);
for (const t of [2, 3]) {
  const T = TIERS[t];
  const from = t === 2 ? TIER_PLAN.T2_FROM : TIER_PLAN.T3_FROM;
  P(`| ${t} | ×${T.hp} | ×${T.dmg} | ×${T.pts} | ×${T.xp} | ×${T.scale} | wave ${from} |`);
}
P();
P('A chance de um spawn sair em estágio 2 ou 3:');
P();
P('| wave | chance estágio 2 | chance estágio 3 | teto de estágio 3 na wave |');
P('| --- | --- | --- | --- |');
for (const w of [10, 15, 20, 30, 40, 60, 80, 100]) {
  const t2 = w < TIER_PLAN.T2_FROM ? 0
    : Math.min((w - TIER_PLAN.T2_FROM + 1) * TIER_PLAN.T2_RAMP, TIER_PLAN.T2_MAX);
  const t3 = w < TIER_PLAN.T3_FROM ? 0
    : Math.min((w - TIER_PLAN.T3_FROM + 1) * TIER_PLAN.T3_RAMP, TIER_PLAN.T3_MAX);
  const cap = w < TIER_PLAN.T3_FROM ? 0 : w < TIER_PLAN.T3_CAP_1 ? 1 : 2;
  P(`| ${w} | ${pct(t2)} | ${pct(t3)} | ${cap} |`);
}
P();
P(`> Tetos: estágio 2 no máximo ${pct(TIER_PLAN.T2_MAX)} da wave, estágio 3 ${pct(TIER_PLAN.T3_MAX)}.`);
P();
P('### Mini-boss e boss');
P();
P(`- **Mini-boss** (waves 5, 15, … 95): HP ×${SUBBOSS.hpMult}, dano ×${SUBBOSS.dmgMult}, `
  + `escala ×${SUBBOSS.scale}, vale ${SUBBOSS.ptsMult}× pontos, conta ${SUBBOSS.breach} brechas.`);
P(`- **Boss** (waves 10, 20, … 100): escala ×${BOSS.scale} (alguns multiplicam por cima), `
  + `${BOSS.pts} pontos, ${BOSS.xp} xp, conta ${BOSS.breach} brechas. `
  + 'HP/dano/armadura são por boss — ver a tabela deles abaixo.');
P();
P('### Número de jogadores');
P();
P('| jogadores | HP dos inimigos | quantidade | pontos ganhos |');
P('| --- | --- | --- | --- |');
for (let i = 1; i <= 4; i++) {
  P(`| ${i} | ×${SCALING.enemyHp[i - 1]} | ×${SCALING.enemyCount[i - 1]} | ×${SCALING.points[i - 1]} |`);
}
P();

// ---------------------------------------------------------------- roster
P('## Inimigos base (antes de qualquer multiplicador)');
P();
P('| inimigo | HP | vel | dano | pts | xp | notas |');
P('| --- | --- | --- | --- | --- | --- | --- |');
for (const [k, d] of Object.entries(ENEMIES)) {
  const notes = [];
  if (d.flying) notes.push('voa (ignora o labirinto)');
  if (d.archer) notes.push(`ataca à distância ${d.archer.range}`);
  if (d.jumper) notes.push('pula muros');
  if (d.summoner) notes.push('invoca');
  if (d.bossOnly) notes.push('**só como boss**');
  P(`| ${N(k)} | ${d.hp} | ${d.speed} | ${d.dmg} | ${d.pts} | ${d.xp} | ${notes.join(', ') || '—'} |`);
}
P();
P(`> Vampiros a partir da wave ${BLOOD_COURT.fromWave} ganham magia de sangue fraca `
  + `(dano ${BLOOD_COURT.dmg}, alcance ${BLOOD_COURT.range}, cura ${pct(BLOOD_COURT.leech)} do dano).`);
P();

// ---------------------------------------------------------------- phases
P('## Composição por fase');
P();
P('Waves normais sorteiam da mistura da fase. Os números são **pesos**:');
P('peso 4 aparece 4× mais que peso 1.');
P();
for (let i = 0; i < PHASES.length; i++) {
  const ph = PHASES[i];
  const until = i + 1 < PHASES.length ? PHASES[i + 1].from - 1 : 100;
  const total = Object.values(ph.mix).reduce((a, b) => a + b, 0);
  const parts = Object.entries(ph.mix)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${N(k)} ${pct(v / total)}`);
  P(`**Waves ${ph.from}–${until}** — ${parts.join(', ')}`);
  P();
}

// ------------------------------------------------------------ wave by wave
P('## Wave a wave');
P();
P('`qtd` é o total de mobs comuns com 1 jogador '
  + `(fórmula: ${WAVES.BASE_COUNT} + wave × ${WAVES.COUNT_PER_WAVE}, × fator de jogadores).`);
P();
P('| wave | tipo | qtd | quem vem | estágios |');
P('| --- | --- | --- | --- | --- |');

const SAMPLES = 400;
for (let w = 1; w <= 100; w++) {
  const isBoss = w % WAVES.CHECKPOINT_EVERY === 0;
  const isSub = !isBoss && w % WAVES.SUBBOSS_EVERY === 0;

  if (isBoss) {
    const variant = BOSS_ORDER[(w / WAVES.CHECKPOINT_EVERY - 1) % BOSS_ORDER.length];
    const def = BOSSES[variant];
    if (def.horde) {
      P(`| **${w}** | BOSS | ${HORDE.GREEN + HORDE.BLUE + HORDE.RED} | `
        + `**${def.name}** — ${HORDE.GREEN} verdes, ${HORDE.BLUE} azuis (revivem ${HORDE.REVIVES.blue}×), `
        + `${HORDE.RED} vermelhos (revivem ${HORDE.REVIVES.red}×) | — |`);
      continue;
    }
    const esc = (def.escort || []).map((e) =>
      `${e.n}× ${N(e.kind)}${e.tier > 1 ? ` (est. ${e.tier})` : ''}`);
    if (def.shades) esc.push('1 sombra menor por classe presente');
    const n = (def.escort || []).reduce((a, e) => a + (e.n || 1), 0) + (def.shades ? 1 : 0);
    P(`| **${w}** | BOSS | ${n} | **${def.name}** + ${esc.join(', ') || '_sozinho_'} | fixo |`);
    continue;
  }

  if (isSub) {
    const squad = SUBBOSSES[w] || [];
    const esc = SUBBOSS_ESCORT[w]
      || squad.map((s) => ({ kind: s.kind, n: SUBBOSS_ESCORT_COUNT / squad.length }));
    const who = squad.map((s) =>
      `${N(s.kind)}${s.vr === 1 ? ' azul' : s.vr === 2 ? ' vermelho' : ''}`
      + `${s.revives ? ` (revive ${s.revives}×)` : ''}`).join(' + ');
    const escTxt = esc.map((e) => `${Math.round(e.n)}× ${N(e.kind)}`).join(', ');
    P(`| **${w}** | mini | ${SUBBOSS_ESCORT_COUNT} | **${who}** + ${escTxt} | fixo |`);
    continue;
  }

  // normal wave: sample the planner for the real distribution
  // aggregate by KIND; the stage split is its own column, otherwise a
  // late wave prints two dozen near-zero entries and reads as noise
  const counts = {};
  const tiers = { 1: 0, 2: 0, 3: 0 };
  let total = 0;
  for (let s = 0; s < SAMPLES; s++) {
    for (const e of buildWavePlan(w, 1)) {
      if (e.boss !== 0) continue;
      counts[e.kind] = (counts[e.kind] || 0) + 1;
      tiers[e.tier || 1]++;
      total++;
    }
  }
  const n = Math.round(total / SAMPLES);
  const mix = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${N(k)} ${pct(v / total)}`)
    .join(', ');
  const stage = [
    `1: ${pct(tiers[1] / total)}`,
    tiers[2] ? `2: ${pct(tiers[2] / total)}` : null,
    tiers[3] ? `3: ${pct(tiers[3] / total)}` : null,
  ].filter(Boolean).join(' · ');
  P(`| ${w} | normal | ${n} | ${mix} | ${stage} |`);
}
P();

// ---------------------------------------------------------------- bosses
P('## Bosses — força');
P();
P('Multiplicadores sobre o corpo que cada um usa, já com o HP da wave por cima.');
P();
P('| wave | boss | corpo | ×HP | ×dano | armadura | escala | poder |');
P('| --- | --- | --- | --- | --- | --- | --- | --- |');
for (let i = 0; i < BOSS_ORDER.length; i++) {
  const v = BOSS_ORDER[i];
  const d = BOSSES[v];
  const powers = [];
  if (d.multishot) powers.push('acerta todos com flechas');
  if (d.jumps) powers.push(`${d.jumps} pulos encadeados`);
  if (d.pumpkin) powers.push('abóbora em área');
  if (d.blood) powers.push(d.blood.allTargets ? 'magia de sangue em TODOS' : 'magia de sangue');
  if (d.venom) powers.push('veneno');
  if (d.web) powers.push('teias que lentificam');
  if (d.breath) powers.push('sopro de fogo');
  if (d.mirrorsHero) powers.push('copia o herói + skill dele a cada ' + d.skillCd + 's');
  if (d.horde) powers.push('100 zumbis');
  if (d.summoner) powers.push('invoca túmulos');
  P(`| ${(i + 1) * 10} | **${d.name}** | ${N(d.kind)} | ${d.hpMult || 1} | ${d.dmgMult || 1} `
    + `| ${d.armor ? pct(d.armor) : '—'} | ×${(d.scale || 1) * BOSS.scale} | ${powers.join(', ')} |`);
}
P();
P('### Efeito real, com o HP da wave aplicado (1 jogador)');
P();
P('| wave | boss | HP final | dano |');
P('| --- | --- | --- | --- |');
for (let i = 0; i < BOSS_ORDER.length; i++) {
  const v = BOSS_ORDER[i];
  const d = BOSSES[v];
  if (d.horde) { P(`| ${(i + 1) * 10} | ${d.name} | _100 zumbis fracos_ | — |`); continue; }
  const w = (i + 1) * 10;
  const st = enemyStats(d.kind, 2, w, 1, v);
  const hp = d.mirrorsHero ? '≈ 60s do dano do herói' : Math.round(st.hp).toLocaleString('pt-BR');
  P(`| ${w} | ${d.name} | ${hp} | ${Math.round(st.dmg)} |`);
}
P();
P('## Depois da wave 100');
P();
P(`O arco 1–${WAVES.CYCLE} recomeça: wave 101 = composição da wave 1, wave 110 = Coveiro de novo. `
  + 'A quantidade de mobs e o ritmo seguem a posição **dentro do ciclo** (senão a wave 200 tentaria '
  + `colocar 500 inimigos). A dificuldade extra vem do HP, que cresce sem teto com o número bruto da wave, `
  + `mais +${Math.round(WAVES.LAP_DMG * 100)}% de dano por volta.`);
P();

console.log(out.join('\n'));
