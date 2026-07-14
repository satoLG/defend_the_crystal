import { CLASSES } from './config.js';

// ============================================================
// The player's saved characters (name + class + part colours),
// persisted in the browser. Several can be kept; one is "active"
// at a time and is the one taken into a match.
// ============================================================

const KEY = 'dtc-characters';
const DEFAULT_CLASS = 'berserker';
export const NAME_MAX = 10;

const newId = () => 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

export function defaultCharacter() {
  return { id: newId(), name: '', cls: DEFAULT_CLASS, colors: {} };
}

function sanitize(c) {
  if (!c || typeof c !== 'object') return null;
  const cls = CLASSES[c.cls] ? c.cls : DEFAULT_CLASS;
  const colors = (c.colors && typeof c.colors === 'object') ? c.colors : {};
  return { id: c.id || newId(), name: (c.name || '').slice(0, NAME_MAX), cls, colors };
}

function persist(roster) {
  try { localStorage.setItem(KEY, JSON.stringify(roster)); } catch { /* quota */ }
}

export function loadRoster() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const d = JSON.parse(raw);
      const chars = (d.chars || []).map(sanitize).filter(Boolean);
      const activeId = chars.some((c) => c.id === d.activeId) ? d.activeId : (chars[0]?.id || null);
      return { chars, activeId };
    }
  } catch { /* fall through */ }
  // migrate a single legacy character, if any
  try {
    const old = localStorage.getItem('dtc-character');
    if (old) {
      const c = sanitize(JSON.parse(old));
      if (c) { const r = { chars: [c], activeId: c.id }; persist(r); return r; }
    }
  } catch { /* ignore */ }
  const name = localStorage.getItem('dtc-name') || '';
  if (name) {
    const c = sanitize({ name, cls: localStorage.getItem('dtc-class') || DEFAULT_CLASS, colors: {} });
    const r = { chars: [c], activeId: c.id };
    persist(r);
    return r;
  }
  return { chars: [], activeId: null };
}

export function getActiveCharacter() {
  const r = loadRoster();
  return r.chars.find((c) => c.id === r.activeId) || r.chars[0] || null;
}

// add or update a character, and make it the active one
export function upsertCharacter(char) {
  const r = loadRoster();
  const c = sanitize(char);
  const i = r.chars.findIndex((x) => x.id === c.id);
  if (i >= 0) r.chars[i] = c; else r.chars.push(c);
  r.activeId = c.id;
  persist(r);
  try { localStorage.setItem('dtc-name', c.name); localStorage.setItem('dtc-class', c.cls); } catch { /* ignore */ }
  return c;
}

export function deleteCharacter(id) {
  const r = loadRoster();
  r.chars = r.chars.filter((c) => c.id !== id);
  if (r.activeId === id) r.activeId = r.chars[0]?.id || null;
  persist(r);
  return r;
}

export function setActive(id) {
  const r = loadRoster();
  if (r.chars.some((c) => c.id === id)) { r.activeId = id; persist(r); }
  return r;
}
