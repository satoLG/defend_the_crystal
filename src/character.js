import { CLASSES } from './config.js';

// ============================================================
// The player's saved character (name + class + part colours),
// persisted in the browser so it survives reloads. Chosen once,
// up front, before hosting or joining a match.
// ============================================================

const KEY = 'dtc-character';

const DEFAULT_CLASS = 'berserker';

export function defaultCharacter() {
  return { name: '', cls: DEFAULT_CLASS, colors: {} };
}

function sanitize(c) {
  if (!c || typeof c !== 'object') return defaultCharacter();
  const cls = CLASSES[c.cls] ? c.cls : DEFAULT_CLASS;
  const colors = (c.colors && typeof c.colors === 'object') ? c.colors : {};
  return { name: (c.name || '').slice(0, 12), cls, colors };
}

export function loadCharacter() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return sanitize(JSON.parse(raw));
  } catch { /* fall through to migration */ }
  // migrate from the old separate name/class keys, if present
  const name = localStorage.getItem('dtc-name') || '';
  const cls = localStorage.getItem('dtc-class') || DEFAULT_CLASS;
  return sanitize({ name, cls, colors: {} });
}

export function hasCharacter() {
  try { return !!localStorage.getItem(KEY); } catch { return false; }
}

export function saveCharacter(c) {
  const clean = sanitize(c);
  try { localStorage.setItem(KEY, JSON.stringify(clean)); } catch { /* ignore quota */ }
  // keep the legacy keys in sync so other bits of UI still read them
  try {
    localStorage.setItem('dtc-name', clean.name);
    localStorage.setItem('dtc-class', clean.cls);
  } catch { /* ignore */ }
  return clean;
}
