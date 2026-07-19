// ============================================================
// Localization (PT-BR / EN-US).
//
// The whole UI must read in ONE language. On first run we pick the
// player's browser/system language automatically; once they choose a
// language explicitly (start screen or settings) that choice is stored
// and overrides the auto-detection from then on.
//
// Dictionary lookup falls back  current-lang -> english -> config data
// -> the raw key, so a missing string is always harmless. Entity NAMES
// and BLURBS live in config.js in English; here we mostly only override
// the Portuguese wording (and the bosses, whose config names are already
// Portuguese, get an English override instead).
// ============================================================

import {
  PETS, PET, WEAPONS, CLASSES, TOWERS, TOWER_SPECIALS, BOSSES, SKILLS,
  ENEMIES, petEffects, weaponEffects,
} from './config.js';

const LANG_KEY = 'dtc-lang';       // last language in effect
const CHOSEN_KEY = 'dtc-lang-set'; // '1' once the player picked one by hand
const SUPPORTED = ['en', 'pt'];

// pick pt for any Portuguese locale, otherwise english
function detectLang() {
  const list = (navigator.languages && navigator.languages.length)
    ? navigator.languages
    : [navigator.language || 'en'];
  for (const l of list) {
    const s = String(l).toLowerCase();
    if (s.startsWith('pt')) return 'pt';
    if (s.startsWith('en')) return 'en';
  }
  return 'en';
}

let current = 'en';
try {
  const chosen = localStorage.getItem(CHOSEN_KEY) === '1';
  const saved = localStorage.getItem(LANG_KEY);
  current = (chosen && SUPPORTED.includes(saved)) ? saved : detectLang();
} catch { current = detectLang(); }

const listeners = new Set();

export function getLang() { return current; }
export function onLangChange(fn) { listeners.add(fn); }

// byUser=true marks the choice as explicit (overrides auto-detect for good)
export function setLang(lang, byUser = true) {
  if (!SUPPORTED.includes(lang)) return;
  const changed = lang !== current;
  current = lang;
  try {
    localStorage.setItem(LANG_KEY, lang);
    if (byUser) localStorage.setItem(CHOSEN_KEY, '1');
  } catch { /* ignore quota */ }
  if (changed) for (const fn of listeners) fn(lang);
}

// ---------------- core lookup ----------------

function walk(obj, key) {
  let cur = obj;
  for (const part of key.split('.')) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return typeof cur === 'string' ? cur : undefined;
}

function raw(key) {
  return walk(STRINGS[current], key) ?? walk(STRINGS.en, key);
}

function interp(str, params) {
  return str.replace(/\{(\w+)\}/g, (m, k) => (params[k] != null ? String(params[k]) : m));
}

export function t(key, params) {
  const s = raw(key) ?? key;
  return params ? interp(s, params) : s;
}

// swap every [data-i18n*] element's text/html/placeholder/title in a tree
export function applyStaticI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
  for (const el of root.querySelectorAll('[data-i18n-ph]')) el.setAttribute('placeholder', t(el.dataset.i18nPh));
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.setAttribute('title', t(el.dataset.i18nTitle));
}

// ---------------- localized entity getters ----------------
// each falls back to the English data baked into config.js

export const className = (id) => raw(`entity.class.${id}.name`) ?? CLASSES[id]?.name ?? id;
export const classBlurb = (id) => raw(`entity.class.${id}.blurb`) ?? CLASSES[id]?.blurb ?? '';
export const classWeaponName = (id) => raw(`entity.class.${id}.weapon`) ?? CLASSES[id]?.weapon ?? '';

export const powerName = (cls) => raw(`power.${cls}.name`) ?? SKILLS[cls]?.name ?? t('char.special');
export const powerDesc = (cls) => raw(`power.${cls}.desc`) ?? '';

export const petName = (id) => raw(`entity.pet.${id}.name`) ?? PETS[id]?.name ?? id;
export const petBlurb = (id) => raw(`entity.pet.${id}.blurb`) ?? PETS[id]?.blurb ?? '';

export const weaponName = (id) => raw(`entity.weapon.${id}.name`) ?? WEAPONS[id]?.name ?? id;
export const weaponBlurb = (id) => raw(`entity.weapon.${id}.blurb`) ?? WEAPONS[id]?.blurb ?? '';
export const tierName = (tier) => raw(`entity.tier.${tier}`) ?? ['Normal', 'Gold', 'Crystal'][tier] ?? 'Normal';

export const towerName = (id) => raw(`entity.tower.${id}.name`) ?? TOWERS[id]?.name ?? id;
export const towerSpecName = (kind, id) => raw(`entity.towerspec.${kind}.${id}.name`) ?? TOWER_SPECIALS[kind]?.[id]?.name ?? id;
export const towerSpecDesc = (kind, id) => raw(`entity.towerspec.${kind}.${id}.desc`) ?? TOWER_SPECIALS[kind]?.[id]?.desc ?? '';

export const bossName = (variant) => raw(`entity.boss.${variant}.name`) ?? BOSSES[variant]?.name ?? variant;
export const bossFlavor = (variant) => raw(`entity.boss.${variant}.flavor`) ?? t('boss.defaultFlavor');
export const enemyName = (kind) => raw(`entity.enemy.${kind}`) ?? ENEMIES[kind]?.name ?? kind;

// map an enemy KIND back to the boss that uses it (for the 3D overhead label)
const KIND_TO_BOSS = {};
for (const [variant, def] of Object.entries(BOSSES)) KIND_TO_BOSS[def.kind] = variant;
export const bossNameByKind = (kind) =>
  KIND_TO_BOSS[kind] ? bossName(KIND_TO_BOSS[kind]) : enemyName(kind);

// ---------------- localized composed stat lines ----------------

// short human line for the pet's CURRENT effect (was config.petEffectText)
export function petEffectText(petId, lvl) {
  const fx = petEffects(petId, lvl);
  const pc = (v) => `${Math.round((v - 1) * 100)}%`;
  switch (petId) {
    case 'dog': return t('petfx.dog', { v: pc(fx.hp) });
    case 'cat': return t('petfx.cat', { v: pc(fx.spd) });
    case 'pig': return t('petfx.pig', { v: pc(fx.pts) });
    case 'crab': return t('petfx.crab', { v: Math.round(fx.def * 100) });
    case 'bunny': return t('petfx.bunny', { v: Math.round(fx.luck * 100) });
    case 'fox': return t('petfx.fox', { v: pc(fx.rate) });
    case 'lion': return t('petfx.lion', { v: pc(fx.atk) });
    case 'tiger': return t('petfx.tiger', { v: Math.round(fx.crit * 100), m: PET.CRIT_MULT });
    case 'giraffe': return t('petfx.giraffe', { v: fx.collect });
    case 'elephant': return t('petfx.elephant', { v: Math.round(fx.kbResist * 100) });
    case 'hog': return t('petfx.hog', { v: Math.round(fx.kbDealt * 100) });
    case 'monkey': return t('petfx.monkey', { v: fx.jump });
    case 'panda': return t('petfx.panda', { v: pc(fx.regen) });
    default: return '';
  }
}

// short human stat line for a weapon/shield (was config.weaponStatText)
export function weaponStatText(id, tier) {
  const def = WEAPONS[id];
  if (!def) return '';
  const fx = weaponEffects(id, tier);
  const pc = (v) => `${v > 1 ? '+' : ''}${Math.round((v - 1) * 100)}%`;
  const parts = [];
  if (def.slot === 'shield') {
    if (fx.def) parts.push(t('wpnstat.defense', { v: Math.round(fx.def * 100) }));
    parts.push(t('wpnstat.block', { v: Math.round(fx.block * 100) }));
  } else {
    if (fx.atk !== 1) parts.push(`${pc(fx.atk)} ${def.kind === 'magic' ? t('wpnstat.magicPower') : t('wpnstat.damage')}`);
    if (fx.rate !== 1) parts.push(`${pc(fx.rate)} ${t('wpnstat.atkSpeed')}`);
    if (fx.crit) parts.push(t('wpnstat.crit', { v: Math.round(fx.crit * 100) }));
    if (fx.range) parts.push(t('wpnstat.range', { v: fx.range.toFixed(1) }));
    if (def.kind === 'magic' && !def.bolts && fx.aoe !== 1) parts.push(`${pc(fx.aoe)} ${t('wpnstat.blastArea')}`);
  }
  if (fx.move !== 1) parts.push(`${pc(fx.move)} ${t('wpnstat.moveSpeed')}`);
  if (def.stun) parts.push(t('wpnstat.stun', { v: Math.round(fx.stun * 100) }));
  else if (def.bolts) parts.push(t('wpnstat.bolts', { v: fx.bolts }));
  return parts.join(' · ');
}

// ============================================================
// Dictionaries. STRINGS.en is the base; STRINGS.pt overrides it.
// For entity name/blurb the base is config.js, so en.entity is only
// populated where config's data ISN'T already English (the bosses).
// ============================================================

const STRINGS = {
  en: {
    common: {
      back: 'Back', close: 'Close', settings: 'Settings', done: 'Done',
      hero: 'Hero', yourHero: 'Your hero', level: 'Level', lvAbbr: 'Lv',
      max: 'MAX', host: 'Host', you: 'You',
    },
    brand: { title: '<span class="t-grp">Defend</span><span class="t-grp"><span class="t-the">the</span> Crystal</span>' },
    lang: { label: 'Language', pt: 'Português', en: 'English' },
    start: {
      play: 'Play', summoning: 'Summoning models…', ready: 'Ready!',
    },
    invite: {
      joiningMatch: "You're joining a specific match",
      openedLink: 'You opened a link to a specific match',
      room: 'Room', pickHeroJoin: '— pick a hero and join',
    },
    char: {
      yourHero: 'Your hero', weapon: 'Weapon', special: 'Special',
      heroNamePh: 'Hero name', saveContinue: 'Save & continue', drag: 'drag',
    },
    pp: {
      firstPet: 'Your first pet',
      intro: 'Every hero brings one companion along.<br/>Pick a starter and give it a name — it levels up permanently and follows you into battle.',
      petNamePh: 'Pet name', nameYour: 'Name your {name}',
      confirmPet: 'Confirm pet',
      needsCompanion: '{name} needs a companion!<br/>Pick a starter pet and give it a name before you head out — it levels up permanently.',
    },
    menu: {
      yourHeroes: 'Your heroes', hostMatch: 'Host a match',
      friendCode: "Have a friend's room code?", enterCode: 'ENTER CODE',
      joinMatch: 'Join match', joinThisMatch: 'Join this match',
      newHero: 'New hero', createCharacter: 'Create a character',
      bestRun: 'Best run: wave {n}', enterRoomCode: 'Enter the 5-letter room code',
    },
    lobby: {
      warCamp: 'War camp', shareCode: 'Share this code with your allies',
      startDefense: 'Start the defense', leave: 'Leave',
      alliesMidBattle: 'Allies can also drop in mid-battle with this code.',
      waitingHostStart: 'Waiting for the host to start…',
      lookingForHost: 'Looking for the host…',
      nobodyHere: 'Nobody here yet — check the code, or keep waiting.',
      defenders: '{n}/4 defenders — difficulty scales with party size',
      codeCopied: 'Code copied!', inviteCopied: 'Invite link copied!',
      shareText: 'Join my defense! Code: {code}',
    },
    hud: {
      waveLeft: '{w} · {left} left', waveNext: '{n} next',
      startWave: 'Start<br/>wave', startIn: 'Start<br/>{t}s',
      waveIn: 'Wave in<br/>{t}s', waitingHost: 'Waiting<br/>host…',
      waveBang: 'Wave {n}!', keepGoing: 'Keep going ➜',
      waitingAllies: 'Waiting for allies…', ready: '{ready}/{total} ready',
      placeBlockHint: 'Place a block — tap here to cancel',
      placeTowerHint: 'Place {name} ({cost}) — tap here to cancel',
      miniBoss: '⚠ MINI-BOSS ⚠', bossIncoming: '☠ BOSS ☠',
      petShop: 'Pet Shop', weaponSmith: 'Weapon Smith',
    },
    tip: {
      points: 'Crystal points — fragments from slain foes, spent on towers',
      crystalHp: 'Crystal health',
      room: 'Room code — allies can join mid-match',
      settings: 'Settings', gold: 'Gold coins — spend them at the sanctuary pet vendor',
      stats: 'View character stats', petDetails: 'Pet details',
      jump: 'Jump over the block ahead (J / Space)',
      skill: 'Class special attack (K)',
      copyCode: 'Copy code', shareLink: 'Share link', rename: 'Rename',
      muteMusic: 'Mute music', muteSfx: 'Mute sound effects',
      randomize: 'Randomize colours',
    },
    card: {
      obstacle: 'Block', ballista: 'Ballista', catapult: 'Catapult',
      cannon: 'Cannon', crystal: 'Crystal', flame: 'Flamer',
    },
    upg: {
      tower: 'Tower', upgrade: 'Upgrade', sell: 'Sell', remove: 'Remove',
      block: 'Block', reclaimBlock: 'Reclaim it to get a block back in your stock.',
      towerLevel: '{name} — level {lvl}', maxLevel: 'Max level',
      upgradeCost: 'Upgrade {cost}',
      damage: 'Damage', range: 'Range', pulseArea: 'Pulse area',
      speed: 'Speed', area: 'Area',
    },
    respawn: { youFell: 'You fell…' },
    settings: {
      music: 'Music', sfx: 'Sound effects', cameraShake: 'Camera shake',
      shadows: 'Shadows',
    },
    stat: {
      health: 'Health', attack: 'Attack', magicPower: 'Magic power',
      defense: 'Defense', range: 'Range', atkSpeed: 'Attack speed',
      moveSpeed: 'Move speed', knockback: 'Knockback', critChance: 'Crit chance',
      blockChance: 'Block chance', stunChance: 'Stun chance',
      guidedBolts: 'Guided bolts', blastArea: 'Blast area',
      experience: 'Experience', kills: 'Kills',
      critValue: '{v}% (×{m} damage)', boltsValue: '{v} per cast',
      subLevel: '{cls} · Level {lvl}',
    },
    statbar: { atk: 'ATK', def: 'DEF', rng: 'RNG', spd: 'SPD' },
    petfx: {
      dog: '+{v} all base stats', cat: '+{v} move speed', pig: '+{v} points earned',
      crab: '+{v}% damage absorbed', bunny: '{v}% chance to double gold',
      fox: '+{v} attack speed', lion: '+{v} damage',
      tiger: '{v}% crit chance (×{m} damage)', giraffe: '+{v} collect radius (cells)',
      elephant: '-{v}% knockback taken', hog: 'attacks knock back (+{v}%)',
      monkey: 'jump over {v} blocks', panda: '+{v} health regen',
    },
    wpnstat: {
      damage: 'damage', magicPower: 'magic power', atkSpeed: 'atk speed',
      crit: '{v}% crit', range: '+{v} range', blastArea: 'blast area',
      moveSpeed: 'move speed', defense: '+{v}% defense', block: '{v}% block',
      stun: '{v}% chance to stun enemies', bolts: '{v} guided bolts per cast',
    },
    petd: {
      hint: "Visit Tonho's stall in the sanctuary to switch or buy pets.",
      xpToLevel: '{xp} / {next} XP to level {lvl}', maxedOut: 'Maxed out',
    },
    petp: {
      pets: 'Pets', goldCoins: 'gold coins', myPets: 'My pets', shop: 'Shop',
      shopHint: 'Gold coins drop from mini-bosses and bosses.<br/>Visit Tonho\'s stall in the sanctuary plaza to buy.',
      noPetsYet: "No pets yet — buy one at Tonho's stall in the sanctuary.",
      withYou: 'With you', equip: 'Equip', owned: 'Owned', starter: 'STARTER',
      lvToLv: 'Lv 1: {a} → Lv {cap}: {b}',
    },
    wpnp: {
      weapons: 'Weapons', myArsenal: 'My arsenal',
      shopHint: 'Gold coins drop from mini-bosses and bosses.<br/>Visit Baru\'s smithy in the sanctuary plaza to buy &amp; upgrade.',
      equipped: 'Equipped', fullyForged: 'Fully forged — Crystal is the final tier.',
      next: 'Next ({tier}): {stat}',
    },
    cp: {
      checkpoint: 'Checkpoint', wavePrefix: 'Wave',
      waveSuffix: 'cleared — everyone is healed.',
      stroll: 'Stroll the sanctuary behind the crystal, then push on.',
    },
    over: {
      crystalShattered: 'The crystal shattered', tryAgain: 'Try again',
      backToMenu: 'Back to menu', waitingHostRestart: 'Waiting for the host to restart…',
      survivedToWave: 'Survived to wave {n}', newBest: ' — new best!',
      killsLine: '{name} — {kills} kills · level {lvl}',
    },
    hostlost: {
      connectionLost: 'Connection lost', hostLeft: 'The host has left the realm.',
    },
    boss: {
      defaultFlavor: 'The ground trembles…',
      subbossFlavor: 'A monstrous champion joins the wave!',
    },
    npc: { greeting: 'Hi!', pets: 'Pets!', weapons: 'Weapons!' },
    toast: {
      joined: '{name} joined the defense!', left: '{name} left.',
      noBlocks: 'No blocks left — earn more each wave',
      notEnoughCrystals: 'Not enough crystals', spotTaken: 'That spot is taken',
      cantBuildThere: "Can't build there", cantBlockPath: "You can't fully block the path!",
      someoneStanding: 'Someone is standing there', alreadyMaxLevel: 'Already at max level',
      towerHasSpecial: 'This tower already has its special',
      noEnemiesInRange: 'No enemies in range',
      checkpointHeal: 'Checkpoint! +{bonus} crystals, everyone healed',
      crystalHit: 'The crystal was hit!', defenderFallen: 'A defender has fallen!',
      bossDefeated: 'Boss defeated!', levelUp: 'Level {n}!',
      petLevel: '{name} reached level {lvl}!',
      coinsOne: '+{amt} gold coin!', coinsMany: '+{amt} gold coins!',
      newDefense: 'New defense begins!',
      petJoined: '{name} joined your team — name it!',
      weaponAdded: '{name} added to your arsenal!',
      weaponForged: '{name} forged to {tier}!',
      onlyTonhoSwitch: "Only at Tonho's stall can you switch pets",
      visitTonhoBuy: "Visit Tonho's stall in the sanctuary to buy",
      notEnoughGold: 'Not enough gold coins',
      onlyBaruSwitch: "Only at Baru's smithy can you switch weapons",
      visitBaruBuy: "Visit Baru's smithy in the sanctuary to buy",
      visitBaruUpgrade: "Visit Baru's smithy in the sanctuary to upgrade",
    },
    entity: {
      // class names double as static [data-i18n] labels on the cc-cards,
      // so english needs explicit entries here (data-i18n has no config
      // fallback, unlike the className() getter)
      class: {
        berserker: { name: 'Berserker' }, tanker: { name: 'Tanker' },
        archer: { name: 'Archer' }, mage: { name: 'Mage' },
      },
      boss: {
        coveiro: { name: 'Gravedigger', flavor: 'He digs your graves in advance!' },
        tirocego: { name: 'Blind Shot', flavor: 'Nobody escapes the volley — NOBODY!' },
        zecaixao: { name: 'Coffin Joe', flavor: 'Walls mean NOTHING to him!' },
        abobrado: { name: 'Pumpkinhead', flavor: 'Take cover — pumpkins incoming!' },
        horda: { name: 'The Zombie Horde', flavor: 'A hundred zombies flood the field!' },
        brutus: { name: 'Brutus', flavor: 'The slowest, toughest brute of them all.' },
      },
      enemy: { keeper: 'Gravedigger' },
    },
    power: {
      berserker: { name: 'Rampage Dash', desc: 'Rampage Dash — charge through the horde, hurling enemies aside.' },
      tanker: { name: 'Wall Mode', desc: 'Wall Mode — become immovable with doubled defense for a while.' },
      archer: { name: 'Arrow Storm', desc: 'Arrow Storm — unleash rapid volleys at the nearest foes.' },
      mage: { name: 'Arcane Orb', desc: 'Arcane Orb — a giant blast dealing massive area damage.' },
    },
  },

  pt: {
    common: {
      back: 'Voltar', close: 'Fechar', settings: 'Configurações', done: 'Concluir',
      hero: 'Herói', yourHero: 'Seu herói', level: 'Nível', lvAbbr: 'Nv',
      max: 'MÁX', host: 'Anfitrião', you: 'Você',
    },
    brand: { title: '<span class="t-grp">Defenda</span><span class="t-grp"><span class="t-the">o</span> Cristal</span>' },
    lang: { label: 'Idioma', pt: 'Português', en: 'English' },
    start: {
      play: 'Jogar', summoning: 'Invocando modelos…', ready: 'Pronto!',
    },
    invite: {
      joiningMatch: 'Você está entrando em uma partida específica',
      openedLink: 'Você abriu um link para uma partida específica',
      room: 'Sala', pickHeroJoin: '— escolha um herói e entre',
    },
    char: {
      yourHero: 'Seu herói', weapon: 'Arma', special: 'Especial',
      heroNamePh: 'Nome do herói', saveContinue: 'Salvar & continuar', drag: 'arraste',
    },
    pp: {
      firstPet: 'Seu primeiro pet',
      intro: 'Todo herói leva um companheiro consigo.<br/>Escolha um inicial e dê um nome — ele sobe de nível permanentemente e te acompanha na batalha.',
      petNamePh: 'Nome do pet', nameYour: 'Dê um nome ao seu {name}',
      confirmPet: 'Confirmar pet',
      needsCompanion: '{name} precisa de um companheiro!<br/>Escolha um pet inicial e dê um nome antes de partir — ele sobe de nível permanentemente.',
    },
    menu: {
      yourHeroes: 'Seus heróis', hostMatch: 'Criar uma partida',
      friendCode: 'Tem o código da sala de um amigo?', enterCode: 'DIGITE O CÓDIGO',
      joinMatch: 'Entrar na partida', joinThisMatch: 'Entrar nesta partida',
      newHero: 'Novo herói', createCharacter: 'Criar um personagem',
      bestRun: 'Melhor rodada: onda {n}', enterRoomCode: 'Digite o código de 5 letras da sala',
    },
    lobby: {
      warCamp: 'Acampamento de guerra', shareCode: 'Compartilhe este código com seus aliados',
      startDefense: 'Iniciar a defesa', leave: 'Sair',
      alliesMidBattle: 'Aliados também podem entrar no meio da batalha com este código.',
      waitingHostStart: 'Aguardando o anfitrião iniciar…',
      lookingForHost: 'Procurando o anfitrião…',
      nobodyHere: 'Ninguém aqui ainda — confira o código ou continue aguardando.',
      defenders: '{n}/4 defensores — a dificuldade escala com o tamanho do grupo',
      codeCopied: 'Código copiado!', inviteCopied: 'Link de convite copiado!',
      shareText: 'Entre na minha defesa! Código: {code}',
    },
    hud: {
      waveLeft: '{w} · faltam {left}', waveNext: 'próxima {n}',
      startWave: 'Iniciar<br/>onda', startIn: 'Iniciar<br/>{t}s',
      waveIn: 'Onda em<br/>{t}s', waitingHost: 'Aguardando<br/>anfitrião…',
      waveBang: 'Onda {n}!', keepGoing: 'Continuar ➜',
      waitingAllies: 'Aguardando aliados…', ready: '{ready}/{total} prontos',
      placeBlockHint: 'Coloque um bloco — toque aqui para cancelar',
      placeTowerHint: 'Coloque {name} ({cost}) — toque aqui para cancelar',
      miniBoss: '⚠ MINICHEFE ⚠', bossIncoming: '☠ CHEFE ☠',
      petShop: 'Loja de Pets', weaponSmith: 'Ferreiro',
    },
    tip: {
      points: 'Pontos de cristal — fragmentos dos inimigos abatidos, gastos em torres',
      crystalHp: 'Vida do cristal',
      room: 'Código da sala — aliados podem entrar durante a partida',
      settings: 'Configurações', gold: 'Moedas de ouro — gaste-as no vendedor de pets do santuário',
      stats: 'Ver atributos do personagem', petDetails: 'Detalhes do pet',
      jump: 'Pule sobre o bloco à frente (J / Espaço)',
      skill: 'Ataque especial da classe (K)',
      copyCode: 'Copiar código', shareLink: 'Compartilhar link', rename: 'Renomear',
      muteMusic: 'Silenciar música', muteSfx: 'Silenciar efeitos sonoros',
      randomize: 'Cores aleatórias',
    },
    card: {
      obstacle: 'Bloco', ballista: 'Balista', catapult: 'Catapulta',
      cannon: 'Canhão', crystal: 'Cristal', flame: 'Chamas',
    },
    upg: {
      tower: 'Torre', upgrade: 'Melhorar', sell: 'Vender', remove: 'Remover',
      block: 'Bloco', reclaimBlock: 'Recupere-o para ter um bloco de volta no estoque.',
      towerLevel: '{name} — nível {lvl}', maxLevel: 'Nível máximo',
      upgradeCost: 'Melhorar {cost}',
      damage: 'Dano', range: 'Alcance', pulseArea: 'Área do pulso',
      speed: 'Velocidade', area: 'Área',
    },
    respawn: { youFell: 'Você caiu…' },
    settings: {
      music: 'Música', sfx: 'Efeitos sonoros', cameraShake: 'Tremor de câmera',
      shadows: 'Sombras',
    },
    stat: {
      health: 'Vida', attack: 'Ataque', magicPower: 'Poder mágico',
      defense: 'Defesa', range: 'Alcance', atkSpeed: 'Vel. de ataque',
      moveSpeed: 'Vel. de movimento', knockback: 'Recuo', critChance: 'Chance de crítico',
      blockChance: 'Chance de bloqueio', stunChance: 'Chance de atordoar',
      guidedBolts: 'Projéteis guiados', blastArea: 'Área de explosão',
      experience: 'Experiência', kills: 'Abates',
      critValue: '{v}% (×{m} de dano)', boltsValue: '{v} por lançamento',
      subLevel: '{cls} · Nível {lvl}',
    },
    statbar: { atk: 'ATQ', def: 'DEF', rng: 'ALC', spd: 'VEL' },
    petfx: {
      dog: '+{v} em todos os atributos base', cat: '+{v} velocidade de movimento',
      pig: '+{v} pontos ganhos', crab: '+{v}% de dano absorvido',
      bunny: '{v}% de chance de dobrar o ouro', fox: '+{v} velocidade de ataque',
      lion: '+{v} de dano', tiger: '{v}% de chance de crítico (×{m} de dano)',
      giraffe: '+{v} de raio de coleta (células)', elephant: '-{v}% de recuo sofrido',
      hog: 'ataques causam recuo (+{v}%)', monkey: 'pula sobre {v} blocos',
      panda: '+{v} de regeneração de vida',
    },
    wpnstat: {
      damage: 'de dano', magicPower: 'de poder mágico', atkSpeed: 'de vel. de ataque',
      crit: '{v}% de crítico', range: '+{v} de alcance', blastArea: 'de área de explosão',
      moveSpeed: 'de vel. de movimento', defense: '+{v}% de defesa', block: '{v}% de bloqueio',
      stun: '{v}% de chance de atordoar inimigos', bolts: '{v} projéteis guiados por lançamento',
    },
    petd: {
      hint: 'Visite a barraca do Tonho no santuário para trocar ou comprar pets.',
      xpToLevel: '{xp} / {next} XP para o nível {lvl}', maxedOut: 'No nível máximo',
    },
    petp: {
      pets: 'Pets', goldCoins: 'moedas de ouro', myPets: 'Meus pets', shop: 'Loja',
      shopHint: 'Moedas de ouro caem de minichefes e chefes.<br/>Visite a barraca do Tonho na praça do santuário para comprar.',
      noPetsYet: 'Nenhum pet ainda — compre um na barraca do Tonho no santuário.',
      withYou: 'Com você', equip: 'Equipar', owned: 'Adquirido', starter: 'INICIAL',
      lvToLv: 'Nv 1: {a} → Nv {cap}: {b}',
    },
    wpnp: {
      weapons: 'Armas', myArsenal: 'Meu arsenal',
      shopHint: 'Moedas de ouro caem de minichefes e chefes.<br/>Visite a ferraria do Baru na praça do santuário para comprar &amp; melhorar.',
      equipped: 'Equipado', fullyForged: 'Totalmente forjada — Cristal é o nível final.',
      next: 'Próx. ({tier}): {stat}',
    },
    cp: {
      checkpoint: 'Checkpoint', wavePrefix: 'Onda',
      waveSuffix: 'concluída — todos foram curados.',
      stroll: 'Passeie pelo santuário atrás do cristal e depois avance.',
    },
    over: {
      crystalShattered: 'O cristal se estilhaçou', tryAgain: 'Tentar de novo',
      backToMenu: 'Voltar ao menu', waitingHostRestart: 'Aguardando o anfitrião reiniciar…',
      survivedToWave: 'Sobreviveu até a onda {n}', newBest: ' — novo recorde!',
      killsLine: '{name} — {kills} abates · nível {lvl}',
    },
    hostlost: {
      connectionLost: 'Conexão perdida', hostLeft: 'O anfitrião deixou o reino.',
    },
    boss: {
      defaultFlavor: 'O chão treme…',
      subbossFlavor: 'Um campeão monstruoso entra na onda!',
    },
    npc: { greeting: 'Oi!', pets: 'Pets!', weapons: 'Armas!' },
    toast: {
      joined: '{name} entrou na defesa!', left: '{name} saiu.',
      noBlocks: 'Sem blocos — ganhe mais a cada onda',
      notEnoughCrystals: 'Cristais insuficientes', spotTaken: 'Esse lugar já está ocupado',
      cantBuildThere: 'Não dá para construir aí', cantBlockPath: 'Você não pode bloquear todo o caminho!',
      someoneStanding: 'Alguém está parado aí', alreadyMaxLevel: 'Já está no nível máximo',
      towerHasSpecial: 'Esta torre já tem seu especial',
      noEnemiesInRange: 'Nenhum inimigo no alcance',
      checkpointHeal: 'Checkpoint! +{bonus} cristais, todos curados',
      crystalHit: 'O cristal foi atingido!', defenderFallen: 'Um defensor caiu!',
      bossDefeated: 'Chefe derrotado!', levelUp: 'Nível {n}!',
      petLevel: '{name} alcançou o nível {lvl}!',
      coinsOne: '+{amt} moeda de ouro!', coinsMany: '+{amt} moedas de ouro!',
      newDefense: 'Nova defesa começa!',
      petJoined: '{name} entrou no seu time — dê um nome!',
      weaponAdded: '{name} adicionada ao seu arsenal!',
      weaponForged: '{name} forjada para {tier}!',
      onlyTonhoSwitch: 'Só na barraca do Tonho você pode trocar de pet',
      visitTonhoBuy: 'Visite a barraca do Tonho no santuário para comprar',
      notEnoughGold: 'Moedas de ouro insuficientes',
      onlyBaruSwitch: 'Só na ferraria do Baru você pode trocar de arma',
      visitBaruBuy: 'Visite a ferraria do Baru no santuário para comprar',
      visitBaruUpgrade: 'Visite a ferraria do Baru no santuário para melhorar',
    },
    entity: {
      class: {
        berserker: {
          name: 'Berserker', weapon: 'Machado de guerra',
          blurb: 'Um brigão da linha de frente que troca defesa por golpes brutais.',
        },
        tanker: {
          name: 'Tanque', weapon: 'Espada e escudo',
          blurb: 'Uma muralha imóvel que absorve dano e sempre segura a linha.',
        },
        archer: {
          name: 'Arqueiro', weapon: 'Arco longo',
          blurb: 'Um atirador ágil que chove flechas a uma distância segura.',
        },
        mage: {
          name: 'Mago', weapon: 'Cajado arcano',
          blurb: 'Um conjurador que derrete grupos inteiros com explosões em área.',
        },
      },
      tower: {
        ballista: { name: 'Balista' }, catapult: { name: 'Catapulta' },
        cannon: { name: 'Canhão' }, crystal: { name: 'Cristal' },
        flame: { name: 'Lança-chamas' },
      },
      towerspec: {
        ballista: {
          triple: { name: 'Tiro Triplo', desc: 'Dispara 3 flechas por rajada em até 3 alvos diferentes.' },
          pierce: { name: 'Virotes Perfurantes', desc: 'Os virotes atravessam, atingindo todos os inimigos na linha.' },
        },
        catapult: {
          scatter: { name: 'Tiro Disperso', desc: 'Arremessa 5 bolas de metal que se espalham — juntas, o dobro do dano.' },
        },
        cannon: {
          napalm: { name: 'Chão em Chamas', desc: 'As balas deixam o chão em chamas onde caem.' },
        },
        crystal: {
          ice: { name: 'Cristal de Gelo', desc: 'Os pulsos congelam os inimigos, deixando-os lentos por alguns segundos.' },
          storm: { name: 'Cristal de Tempestade', desc: 'O dano salta entre inimigos amontoados.' },
        },
        flame: {
          venom: { name: 'Lança-Veneno', desc: 'Cospe veneno que se espalha e drena a vida por muito mais tempo.' },
        },
      },
      pet: {
        dog: { name: 'Cachorro', blurb: 'Um amigo leal — melhora levemente todos os seus atributos base.' },
        cat: { name: 'Gato', blurb: 'Patas rápidas — você se move mais rápido.' },
        pig: { name: 'Porco', blurb: 'Um focinho de sorte — você ganha mais pontos.' },
        crab: { name: 'Caranguejo', blurb: 'Casco duro — você sofre menos dano.' },
        bunny: { name: 'Coelho', blurb: 'Sorte de saque — chance de dobrar as moedas de ouro que encontra.' },
        giraffe: { name: 'Girafa', blurb: 'Pescoço longo — coleta orbes e itens de mais longe.' },
        elephant: { name: 'Elefante', blurb: 'Postura pesada — você resiste ao recuo.' },
        fox: { name: 'Raposa', blurb: 'Reflexos afiados — você ataca mais rápido.' },
        panda: { name: 'Panda', blurb: 'Espírito calmo — sua vida regenera mais rápido.' },
        hog: { name: 'Javali', blurb: 'Investida selvagem — seus ataques empurram os inimigos.' },
        monkey: { name: 'Macaco', blurb: 'Acrobata — pule sobre mais blocos seguidos (até 5).' },
        tiger: { name: 'Tigre', blurb: 'Instinto assassino — chance de acertar golpes críticos.' },
        lion: { name: 'Leão', blurb: 'Rugido do rei — você causa mais dano.' },
      },
      weapon: {
        axe: { name: 'Machado', blurb: 'Bate mais forte que a espada e crava fundo nos críticos, mas ataca mais devagar.' },
        greataxe: { name: 'Machado Grande', blurb: 'Um machado monstruoso — dano e alcance enormes, golpes lentos, pesado de carregar.' },
        hammer: { name: 'Martelo de Guerra', blurb: 'Dano de machado um pouco mais lento — e os crânios ecoam: chance de atordoar.' },
        spear: { name: 'Lança', blurb: 'Um pouco mais leve que a espada, mas o maior alcance entre as armas corpo a corpo.' },
        sword: { name: 'Espada', blurb: 'A lâmina versátil pela qual todas as outras armas são medidas.' },
        greatsword: { name: 'Espada Grande', blurb: 'Uma arma de duas mãos: mais dano e alcance que a espada, um pouco mais lenta.' },
        shield: { name: 'Escudo', blurb: 'Um escudo redondo confiável — de vez em quando bloqueia um golpe por completo.' },
        greatshield: { name: 'Escudo Grande', blurb: 'Um escudo-muralha: mais absorção, mais bloqueios, um passo mais pesado.' },
        bow: { name: 'Arco', blurb: 'O arco longo confiável — dano, alcance e velocidade equilibrados.' },
        greatbow: { name: 'Arco Grande', blurb: 'Um arco de guerra imponente: golpes mais fortes de mais longe, mais lento para armar.' },
        crossbow: { name: 'Besta', blurb: 'Virotes mais leves, mas gatilho rápido — o atirador mais veloz dos arcos.' },
        staff: { name: 'Cajado Arcano', blurb: 'O cajado de conjurador completo — a explosão única mais forte que um mago pode lançar.' },
        wand: { name: 'Varinha', blurb: 'Uma varinha curta de cristal vermelho: lançamentos mais rápidos, explosões menores.' },
        orb: { name: 'Orbe Arcano', blurb: 'Sem explosão alguma — em vez disso lança projéteis guiados em vários inimigos.' },
      },
      tier: { 0: 'Normal', 1: 'Ouro', 2: 'Cristal' },
      enemy: {
        skeleton: 'Esqueleto', zombie: 'Zumbi', ghost: 'Fantasma',
        skelarcher: 'Arqueiro Esqueleto', orc: 'Orc', vampire: 'Vampiro',
        keeper: 'Coveiro',
      },
      // config boss names are already Portuguese, but they must be
      // repeated here: the lookup falls through pt -> en BEFORE the config
      // fallback, so without these the English override would win in pt
      boss: {
        coveiro: { name: 'Coveiro', flavor: 'Ele cava suas covas antecipadamente!' },
        tirocego: { name: 'Tiro Cego', flavor: 'Ninguém escapa da saraivada — NINGUÉM!' },
        zecaixao: { name: 'Zé do Caixão', flavor: 'Paredes não significam NADA para ele!' },
        abobrado: { name: 'Abobrado', flavor: 'Cuidado — abóboras chegando!' },
        horda: { name: 'A Horda Zumbi', flavor: 'Cem zumbis inundam o campo!' },
        brutus: { name: 'Brutus', flavor: 'O bruto mais lento e resistente de todos.' },
      },
    },
    power: {
      berserker: { name: 'Investida Furiosa', desc: 'Investida Furiosa — atravesse a horda empurrando inimigos.' },
      tanker: { name: 'Modo Muralha', desc: 'Modo Muralha — fique imóvel com defesa dobrada por um tempo.' },
      archer: { name: 'Tempestade de Flechas', desc: 'Tempestade de Flechas — rajadas rápidas nos alvos próximos.' },
      mage: { name: 'Orbe Arcano', desc: 'Orbe Arcano — explosão gigante com dano em área massivo.' },
    },
  },
};
