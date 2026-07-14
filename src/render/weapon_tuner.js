// ============================================================
// DEV-ONLY weapon tuner.
//
// A floating overlay on the character-creation screen that nudges the
// position / rotation / scale of the weapons a class holds — live, on
// the 3D turntable — so we can eyeball the right transforms instead of
// guessing numbers. Once the values are dialed in, hit "Copy" to grab a
// ready-to-paste CLASS_PROPS block, drop it into src/render/view.js as
// the new defaults, and delete this file + its one import in main.js.
//
// Self-contained on purpose (own DOM + CSS, no build-time wiring) so
// removing it later is a two-line cleanup.
// ============================================================

const RANGES = {
  pos: { min: -0.6, max: 0.6, step: 0.005 },
  rot: { min: -3.15, max: 3.15, step: 0.01 },
  scale: { min: 0.05, max: 3, step: 0.01 },
};
const AXES = ['x', 'y', 'z'];

// Per-class working state, seeded from the code defaults the first time a
// class is opened and then persisted across class switches for the whole
// session (so flipping berserker→tanker→berserker keeps your edits).
const edits = {}; // cls -> [{ pos:[3], rot:[3], scale }]  (live-edited transforms)
const meta = {};  // cls -> [{ label, bone, source, crystalTip }]  (static, for code)

let preview = null;
let panel = null;
let bodyEl = null;
let titleEl = null;
let curCls = null;

export function initWeaponTuner(previewInstance) {
  preview = previewInstance;
  injectStyles();
  buildShell();

  // rebuild the controls whenever the preview swaps class/weapons, and
  // re-apply any edits we already made for that class
  preview.onPropsChanged = (cls) => {
    curCls = cls;
    const defs = preview.getProps();
    meta[cls] = defs.map((d) => ({ label: d.label, bone: d.bone, source: d.source, crystalTip: d.crystalTip }));
    if (!edits[cls]) {
      edits[cls] = defs.map((d) => ({ pos: [...d.pos], rot: [...d.rot], scale: d.scale }));
    } else {
      // re-apply stored edits onto the freshly-built holders
      edits[cls].forEach((e, i) => preview.setPropTransform(i, e));
    }
    if (panel.classList.contains('open')) renderControls(defs);
  };

  // the toggle button + panel only make sense on the character screen
  const charScreen = document.getElementById('character');
  const sync = () => {
    const on = charScreen && !charScreen.classList.contains('hidden');
    panel.parentElement.classList.toggle('wt-hidden', !on);
    if (!on) panel.classList.remove('open');
  };
  if (charScreen) {
    new MutationObserver(sync).observe(charScreen, { attributes: true, attributeFilter: ['class'] });
  }
  sync();
}

// ---- DOM -----------------------------------------------------

function buildShell() {
  const root = document.createElement('div');
  root.id = 'wt-root';

  const toggle = document.createElement('button');
  toggle.id = 'wt-toggle';
  toggle.type = 'button';
  toggle.title = 'Weapon tuner';
  toggle.textContent = '🔧';

  panel = document.createElement('div');
  panel.id = 'wt-panel';
  panel.innerHTML = `
    <div class="wt-head">
      <span id="wt-title">Weapon tuner</span>
      <button type="button" id="wt-close" title="Close">✕</button>
    </div>
    <div id="wt-body"></div>
    <div class="wt-foot">
      <button type="button" id="wt-copy" class="wt-btn wt-primary">Copy this class</button>
      <button type="button" id="wt-copy-all" class="wt-btn">Copy all</button>
      <button type="button" id="wt-reset" class="wt-btn">Reset class</button>
    </div>
    <div id="wt-msg" class="wt-msg"></div>`;

  root.appendChild(toggle);
  root.appendChild(panel);
  document.body.appendChild(root);

  titleEl = panel.querySelector('#wt-title');
  bodyEl = panel.querySelector('#wt-body');

  toggle.addEventListener('click', () => {
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) renderControls(preview.getProps());
  });
  panel.querySelector('#wt-close').addEventListener('click', () => panel.classList.remove('open'));
  panel.querySelector('#wt-copy').addEventListener('click', () => copy(codeForClass(curCls), 'Copied ' + curCls));
  panel.querySelector('#wt-copy-all').addEventListener('click', () => copy(codeForAll(), 'Copied all classes'));
  panel.querySelector('#wt-reset').addEventListener('click', resetClass);
}

function renderControls(defs) {
  titleEl.textContent = `Weapons · ${curCls || '—'}`;
  bodyEl.innerHTML = '';
  if (!defs.length) {
    bodyEl.innerHTML = '<div class="wt-empty">This class has no weapons.</div>';
    return;
  }
  const state = edits[curCls];
  defs.forEach((d, i) => {
    const e = state[i];
    const card = document.createElement('div');
    card.className = 'wt-card';
    const warn = d.available ? '' : ' <span class="wt-warn">(bone missing)</span>';
    card.innerHTML = `<div class="wt-card-title">${d.label}${warn}</div>`;

    for (const kind of ['pos', 'rot', 'scale']) {
      if (kind === 'scale') {
        card.appendChild(sliderRow(i, 'scale', null, e.scale, (v) => {
          e.scale = v; preview.setPropTransform(i, { scale: v });
        }));
      } else {
        AXES.forEach((ax, a) => {
          card.appendChild(sliderRow(i, kind, ax, e[kind][a], (v) => {
            e[kind][a] = v; preview.setPropTransform(i, { [kind]: e[kind] });
          }));
        });
      }
    }
    bodyEl.appendChild(card);
  });
}

// one label + range + number row, kept in sync
function sliderRow(i, kind, axis, value, onInput) {
  const cfg = RANGES[kind];
  const row = document.createElement('label');
  row.className = 'wt-row';
  const name = kind === 'scale' ? 'scale' : `${kind}.${axis}`;

  const label = document.createElement('span');
  label.className = 'wt-lbl';
  label.textContent = name;

  const range = document.createElement('input');
  range.type = 'range';
  range.min = cfg.min; range.max = cfg.max; range.step = cfg.step;
  range.value = clampRange(value, cfg);

  const num = document.createElement('input');
  num.type = 'number';
  num.step = cfg.step;
  num.value = round(value);
  num.className = 'wt-num';

  range.addEventListener('input', () => {
    const v = parseFloat(range.value);
    num.value = round(v);
    onInput(v);
  });
  num.addEventListener('input', () => {
    const v = parseFloat(num.value);
    if (Number.isNaN(v)) return;
    range.value = clampRange(v, cfg);
    onInput(v);
  });

  row.appendChild(label);
  row.appendChild(range);
  row.appendChild(num);
  return row;
}

// ---- code emission -------------------------------------------

function codeForClass(cls) {
  const defs = meta[cls];
  const state = edits[cls];
  if (!defs || !state) return `// ${cls}: no data (open the class first)`;
  const lines = defs.map((d, i) => specLine(d, state[i]));
  return `${cls}: [\n${lines.join('\n')}\n],`;
}

function codeForAll() {
  return Object.keys(edits).map(codeForClass).join('\n');
}

function specLine(d, e) {
  const src = d.source.startsWith('gen:')
    ? `gen: ${d.source.slice(4)}`
    : `key: '${d.source.slice(4)}'`;
  const p = e.pos.map(round).join(', ');
  const r = e.rot.map(round).join(', ');
  const tip = d.crystalTip ? ', crystalTip: true' : '';
  return `  { ${src}, label: '${d.label}', bone: '${d.bone}', pos: [${p}], rot: [${r}], scale: ${round(e.scale)}${tip} },`;
}

// ---- actions -------------------------------------------------

function resetClass() {
  const defs = preview.getProps();
  edits[curCls] = defs.map((d) => ({ pos: [...d.pos], rot: [...d.rot], scale: d.scale }));
  edits[curCls].forEach((e, i) => preview.setPropTransform(i, e));
  renderControls(defs);
  flash('Reset to code defaults');
}

async function copy(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
    flash(okMsg);
  } catch {
    // clipboard blocked — drop it in the message box to select manually
    flash('Clipboard blocked — value logged to console');
    console.log(text); // eslint-disable-line no-console
  }
}

let msgTimer = null;
function flash(msg) {
  const el = panel.querySelector('#wt-msg');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

// ---- helpers -------------------------------------------------

const round = (v) => Math.round(v * 1000) / 1000;
const clampRange = (v, cfg) => Math.min(Math.max(v, cfg.min), cfg.max);

// ---- styles --------------------------------------------------

function injectStyles() {
  if (document.getElementById('wt-styles')) return;
  const css = `
#wt-root { position: fixed; right: 12px; bottom: 12px; z-index: 9999; font: 12px/1.4 system-ui, sans-serif; }
#wt-root.wt-hidden { display: none; }
#wt-toggle { width: 42px; height: 42px; border-radius: 50%; border: none; cursor: pointer;
  background: #2a2440; color: #fff; font-size: 20px; box-shadow: 0 4px 14px rgba(0,0,0,.5); }
#wt-toggle:hover { background: #3a3358; }
#wt-panel { position: absolute; right: 0; bottom: 52px; width: 300px; max-height: 78vh;
  display: none; flex-direction: column; background: rgba(20,16,33,.97); color: #e8e4f5;
  border: 1px solid #3a3358; border-radius: 12px; box-shadow: 0 10px 40px rgba(0,0,0,.6); overflow: hidden; }
#wt-panel.open { display: flex; }
.wt-head { display: flex; align-items: center; justify-content: space-between;
  padding: 10px 12px; border-bottom: 1px solid #3a3358; font-weight: 600; }
#wt-close { background: none; border: none; color: #aaa; cursor: pointer; font-size: 14px; }
#wt-close:hover { color: #fff; }
#wt-body { overflow-y: auto; padding: 8px 10px; }
.wt-card { background: rgba(255,255,255,.04); border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; }
.wt-card-title { font-weight: 600; margin-bottom: 6px; color: #c9b6ff; }
.wt-warn { color: #ff9a6a; font-weight: 400; font-size: 11px; }
.wt-row { display: grid; grid-template-columns: 44px 1fr 58px; align-items: center; gap: 6px; margin: 3px 0; }
.wt-lbl { color: #9a92b8; font-variant-numeric: tabular-nums; }
.wt-row input[type=range] { width: 100%; accent-color: #8a6aff; }
.wt-num { width: 100%; background: #14101f; border: 1px solid #3a3358; color: #e8e4f5;
  border-radius: 5px; padding: 2px 4px; font: inherit; }
.wt-foot { display: flex; gap: 6px; padding: 8px 10px; border-top: 1px solid #3a3358; flex-wrap: wrap; }
.wt-btn { flex: 1; min-width: 80px; padding: 6px 8px; border-radius: 6px; cursor: pointer;
  border: 1px solid #3a3358; background: #221c38; color: #e8e4f5; font: inherit; }
.wt-btn:hover { background: #322a4e; }
.wt-primary { background: #6a4ae0; border-color: #6a4ae0; }
.wt-primary:hover { background: #7d5bf0; }
.wt-empty, .wt-msg { color: #9a92b8; padding: 6px 12px; }
.wt-msg { min-height: 0; height: 0; opacity: 0; transition: opacity .2s; }
.wt-msg.show { height: auto; opacity: 1; padding-bottom: 8px; color: #7de87d; }
`;
  const style = document.createElement('style');
  style.id = 'wt-styles';
  style.textContent = css;
  document.head.appendChild(style);
}
