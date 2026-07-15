import { CLASSES, NAME_MAX, PETS, PET, petXpNext } from './config.js';

// ============================================================
// The player's saved characters (name + class + part colours +
// pets + gold coins), persisted in the browser so they survive
// reloads. The roster can hold several heroes; one is "active"
// and used to host/join. Pets and gold are PER CHARACTER and
// permanent: pet levels/XP carry across matches.
// ============================================================

const KEY = 'dtc-characters';     // JSON array of characters
const ACTIVE_KEY = 'dtc-active';  // id of the active character
const LEGACY_KEY = 'dtc-character'; // pre-roster single character

const DEFAULT_CLASS = 'berserker';

function uid() {
  return 'c' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
}

export function defaultCharacter() {
  return { id: uid(), name: '', cls: DEFAULT_CLASS, colors: {}, pets: {}, activePet: null, coins: 0 };
}

// owned pets: { [petId]: { lvl, xp, name } } — drop anything unknown
function sanitizePets(pets) {
  const out = {};
  if (!pets || typeof pets !== 'object') return out;
  for (const [id, p] of Object.entries(pets)) {
    if (!PETS[id] || !p || typeof p !== 'object') continue;
    const lvl = Math.min(Math.max(Math.round(Number(p.lvl) || 1), 1), PET.LEVEL_CAP);
    const xp = Math.max(Math.round(Number(p.xp) || 0), 0);
    const name = String(p.name || PETS[id].name).slice(0, PET.NAME_MAX);
    out[id] = { lvl, xp, name };
  }
  return out;
}

function sanitize(c) {
  if (!c || typeof c !== 'object') return defaultCharacter();
  const cls = CLASSES[c.cls] ? c.cls : DEFAULT_CLASS;
  const colors = (c.colors && typeof c.colors === 'object') ? c.colors : {};
  const id = (typeof c.id === 'string' && c.id) ? c.id : uid();
  const pets = sanitizePets(c.pets);
  const activePet = pets[c.activePet] ? c.activePet : (Object.keys(pets)[0] || null);
  const coins = Math.max(Math.round(Number(c.coins) || 0), 0);
  return { id, name: (c.name || '').slice(0, NAME_MAX), cls, colors, pets, activePet, coins };
}

// the equipped pet as the {id, lvl, name} reference the sim understands
export function petRefOf(c) {
  const owned = c?.activePet && c.pets?.[c.activePet];
  return owned ? { id: c.activePet, lvl: owned.lvl, name: owned.name } : null;
}

// Feed collected XP to a character's ACTIVE pet (mutates `c`), leveling
// it permanently. Returns the number of levels gained (0 when none).
export function grantPetXp(c, amount) {
  const pet = c?.activePet && c.pets?.[c.activePet];
  if (!pet || amount <= 0 || pet.lvl >= PET.LEVEL_CAP) return 0;
  pet.xp += amount;
  let gained = 0;
  while (pet.lvl < PET.LEVEL_CAP && pet.xp >= petXpNext(pet.lvl)) {
    pet.xp -= petXpNext(pet.lvl);
    pet.lvl += 1;
    gained += 1;
  }
  if (pet.lvl >= PET.LEVEL_CAP) pet.xp = 0;
  return gained;
}

// gather any pre-roster storage into a single-character list
function migrateLegacy() {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (raw) return [sanitize(JSON.parse(raw))];
  } catch { /* fall through */ }
  const name = localStorage.getItem('dtc-name');
  const cls = localStorage.getItem('dtc-class');
  if (name || cls) return [sanitize({ name: name || '', cls: cls || DEFAULT_CLASS, colors: {} })];
  return [];
}

// { chars: [...], activeId } — chars is never mutated in place by callers
export function loadRoster() {
  let chars = [];
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? JSON.parse(raw) : null;
    if (Array.isArray(arr)) chars = arr.map(sanitize);
  } catch { /* corrupt — rebuild below */ }
  if (!chars.length) chars = migrateLegacy();

  let activeId = null;
  try { activeId = localStorage.getItem(ACTIVE_KEY); } catch { /* ignore */ }
  if (!chars.find((c) => c.id === activeId)) activeId = chars[0]?.id || null;

  // persist the (possibly migrated) roster so the new format sticks
  if (chars.length) saveRoster(chars, activeId);
  return { chars, activeId };
}

export function saveRoster(chars, activeId) {
  const clean = chars.map(sanitize);
  const active = clean.find((c) => c.id === activeId) ? activeId : (clean[0]?.id || null);
  try {
    localStorage.setItem(KEY, JSON.stringify(clean));
    if (active) localStorage.setItem(ACTIVE_KEY, active);
    // keep legacy keys in sync with the active hero for older readers
    const a = clean.find((c) => c.id === active);
    if (a) {
      localStorage.setItem(LEGACY_KEY, JSON.stringify({ name: a.name, cls: a.cls, colors: a.colors }));
      localStorage.setItem('dtc-name', a.name);
      localStorage.setItem('dtc-class', a.cls);
    }
  } catch { /* ignore quota */ }
  return { chars: clean, activeId: active };
}

export function hasCharacter() {
  const { chars } = loadRoster();
  return chars.length > 0;
}

// the active hero (used to host/join). Falls back to a fresh draft.
export function loadCharacter() {
  const { chars, activeId } = loadRoster();
  return chars.find((c) => c.id === activeId) || chars[0] || defaultCharacter();
}
