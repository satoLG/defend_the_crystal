// ============================================================
// Camera-tuning overlay — a lightweight in-game panel to try out
// new default framings for the two camera modes:
//   • Partida    – the fixed board view held during a wave
//   • Checkpoint – the follow-cam that tracks the hero between waves
// For each mode you nudge the tilt (Ângulo), swing (Rotação) and
// Zoom live; switching tabs previews that camera on the field, and
// the values persist in localStorage so a framing you like sticks
// across reloads (handy for settling on new defaults).
// ============================================================

const KEY = 'dtc-cam';
const DEG = 180 / Math.PI; // radians → degrees
const RAD = Math.PI / 180; // degrees → radians

// key, label, min, max, step, kind:
//   'deg'  slider shows degrees, stored as radians
//   'mult' slider + stored value are the same multiplier
//   'num'  slider + stored value are the same raw world units (pan)
const COMMON_FIELDS = [
  ['pitch', 'Ângulo',   25,   85,   1,    'deg'],
  ['yaw',   'Rotação', -60,   60,   1,    'deg'],
  ['zoom',  'Zoom',     0.5,  2.0,  0.05, 'mult'],
];
// partida only: shift the point the board camera orbits/looks at
const PAN_FIELDS = [
  ['panX', 'Pan X', -8, 8, 0.25, 'num'],
  ['panY', 'Pan Y', -8, 8, 0.25, 'num'],
  ['panZ', 'Pan Z', -8, 8, 0.25, 'num'],
];
const FIELDS_BY_MODE = {
  partida: [...COMMON_FIELDS, ...PAN_FIELDS],
  checkpoint: COMMON_FIELDS,
};
const KIND_OF = Object.fromEntries(
  [...COMMON_FIELDS, ...PAN_FIELDS].map(([key, , , , , kind]) => [key, kind])
);

const load = () => {
  try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch { return null; }
};
const save = (cfg) => {
  try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch { /* ok */ }
};

const fmt = (key, raw) => {
  const kind = KIND_OF[key];
  if (kind === 'deg') return `${Math.round(raw)}°`;
  if (kind === 'mult') return `${raw.toFixed(2)}×`;
  return raw.toFixed(2); // num (world units)
};
// slider value (deg / multiplier / world units) → stored config value
const toStored = (key, raw) => (KIND_OF[key] === 'deg' ? raw * RAD : raw);
// stored config value → slider value
const toSlider = (key, val) => (KIND_OF[key] === 'deg' ? val * DEG : val);

export function initCamTune(gs) {
  // capture the scene's original framing BEFORE restoring any saved one,
  // so Reset always returns to the true built-in defaults
  const DEFAULTS = gs.getCamCfg();
  const saved = load();
  if (saved) gs.applyCamCfg(saved);

  let mode = 'partida';

  // ---- open button, tucked into the HUD top bar ----
  const btn = document.createElement('button');
  btn.id = 'cam-tune-btn';
  btn.className = 'hud-chip subtle';
  btn.title = 'Camera tuning';
  btn.textContent = '📷';
  (document.getElementById('hud-top') || document.body).appendChild(btn);

  // ---- overlay panel (reuses the game's panel / tab / setting styles) ----
  const panel = document.createElement('div');
  panel.id = 'camtune-panel';
  panel.className = 'screen overlay hidden';
  panel.innerHTML = `
    <div class="panel center-panel">
      <button id="camtune-close" class="btn small corner-btn" title="Close">✕</button>
      <h2>📷 Câmera</h2>
      <div class="pet-tabs">
        <button class="pet-tab active" data-mode="partida">Partida</button>
        <button class="pet-tab" data-mode="checkpoint">Checkpoint</button>
      </div>
      <p id="camtune-hint" class="muted camtune-hint"></p>
      <div id="camtune-rows"></div>
      <div class="camtune-actions">
        <button id="camtune-reset" class="btn subtle">Reset</button>
        <button id="camtune-done" class="btn primary">Done</button>
      </div>
    </div>`;
  (document.getElementById('app') || document.body).appendChild(panel);

  const rowsBox = panel.querySelector('#camtune-rows');
  const hintEl = panel.querySelector('#camtune-hint');

  // fields differ per mode (partida also gets pan X/Y/Z), so the slider
  // rows are rebuilt whenever the active mode changes
  let rows = {};
  function buildRows() {
    rowsBox.innerHTML = '';
    rows = {};
    for (const [key, label, min, max, step] of FIELDS_BY_MODE[mode]) {
      const row = document.createElement('div');
      row.className = 'setting-row';
      row.innerHTML =
        `<label>${label}</label>` +
        `<input type="range" min="${min}" max="${max}" step="${step}" />` +
        `<span class="camtune-val muted"></span>`;
      const input = row.querySelector('input');
      const val = row.querySelector('.camtune-val');
      input.addEventListener('input', () => {
        const raw = Number(input.value);
        gs.setCamCfg(mode, key, toStored(key, raw));
        val.textContent = fmt(key, raw);
        save(gs.getCamCfg());
      });
      rowsBox.appendChild(row);
      rows[key] = { input, val };
    }
  }

  // reflect the active mode's config onto the sliders + tabs + hint
  function paint() {
    buildRows();
    const cfg = gs.getCamCfg()[mode];
    for (const [key] of FIELDS_BY_MODE[mode]) {
      const raw = toSlider(key, cfg[key]);
      rows[key].input.value = raw;
      rows[key].val.textContent = fmt(key, raw);
    }
    hintEl.textContent = mode === 'checkpoint'
      ? 'Segue o herói entre as waves — ângulo, rotação e zoom próprios.'
      : 'Enquadramento fixo do tabuleiro durante a wave — Pan X/Y/Z desloca o ponto observado.';
    for (const t of panel.querySelectorAll('.pet-tab'))
      t.classList.toggle('active', t.dataset.mode === mode);
  }

  // switching tabs previews that camera live on the field
  for (const t of panel.querySelectorAll('.pet-tab')) {
    t.addEventListener('click', () => {
      mode = t.dataset.mode;
      gs.followPreview = mode;
      paint();
    });
  }

  const open = () => { gs.followPreview = mode; paint(); panel.classList.remove('hidden'); };
  const close = () => { gs.followPreview = null; panel.classList.add('hidden'); };
  btn.addEventListener('click', open);
  panel.querySelector('#camtune-close').addEventListener('click', close);
  panel.querySelector('#camtune-done').addEventListener('click', close);
  panel.querySelector('#camtune-reset').addEventListener('click', () => {
    gs.applyCamCfg(DEFAULTS);
    save(gs.getCamCfg());
    paint();
  });
}
