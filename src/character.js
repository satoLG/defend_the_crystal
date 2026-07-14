import { CLASSES, NAME_MAX } from './config.js';

// ============================================================
// The player's saved characters (name + class + part colours),
// persisted in the browser so they survive reloads. The roster
// can hold several heroes; one is "active" and used to host/join.
// ============================================================

const KEY = 'dtc-characters';     // JSON array of characters
const ACTIVE_KEY = 'dtc-active';  // id of the active character
const LEGACY_KEY = 'dtc-character'; // pre-roster single character

const DEFAULT_CLASS = 'berserker';

function uid() {
  return 'c' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
}

export function defaultCharacter() {
  return { id: uid(), name: '', cls: DEFAULT_CLASS, colors: {} };
}

function sanitize(c) {
  if (!c || typeof c !== 'object') return defaultCharacter();
  const cls = CLASSES[c.cls] ? c.cls : DEFAULT_CLASS;
  const colors = (c.colors && typeof c.colors === 'object') ? c.colors : {};
  const id = (typeof c.id === 'string' && c.id) ? c.id : uid();
  return { id, name: (c.name || '').slice(0, NAME_MAX), cls, colors };
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
