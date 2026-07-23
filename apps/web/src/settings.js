// ============================================================
// Player preferences, persisted in localStorage.
// Applying a change notifies subscribers (audio / renderer).
// ============================================================

const KEY = 'dtc-settings';

const DEFAULTS = {
  musicVol: 0.5,      // 0..1
  sfxVol: 0.7,        // 0..1
  musicMuted: false,
  sfxMuted: false,
  shake: true,        // camera shake on breaches / hits
  shadows: false,     // realtime shadows
};

let state = { ...DEFAULTS };
try {
  state = { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY)) || {}) };
} catch { /* keep defaults */ }

const listeners = new Set();

export const settings = {
  get: (k) => state[k],
  all: () => ({ ...state }),
  set(k, v) {
    state[k] = v;
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* ok */ }
    for (const fn of listeners) fn(k, v);
  },
  onChange(fn) { listeners.add(fn); },
};
