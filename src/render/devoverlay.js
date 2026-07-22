// ============================================================
// A tiny in-game tuning overlay for the training dummies and the
// target board strapped to each. Opt-in only: append ?dev to the URL
// (or press the backtick key ` ) to toggle it. Nothing here ships into
// normal play — it just live-mutates the local scene and prints the
// current numbers so they can be pasted back into the source.
// ============================================================

export function initDummyDevOverlay(view) {
  let panel = null;
  let state = null;

  const rows = [
    { group: 'Dummy 1 (offset from Rocha)', path: ['dummies', 0], fields: [
      ['dx', -8, 8, 0.1], ['dz', -8, 8, 0.1], ['yaw', -3.2, 3.2, 0.02], ['scale', 0.3, 3, 0.05],
    ] },
    { group: 'Dummy 2 (offset from Rocha)', path: ['dummies', 1], fields: [
      ['dx', -8, 8, 0.1], ['dz', -8, 8, 0.1], ['yaw', -3.2, 3.2, 0.02], ['scale', 0.3, 3, 0.05],
    ] },
    { group: 'Target (on every dummy)', path: ['target'], fields: [
      ['px', -1, 1, 0.01], ['py', 0, 2, 0.01], ['pz', -1, 1, 0.01],
      ['rx', -3.2, 3.2, 0.02], ['ry', -3.2, 3.2, 0.02], ['rz', -3.2, 3.2, 0.02],
      ['scale', 0.2, 3, 0.05],
    ] },
  ];

  const at = (path) => path.reduce((o, k) => o[k], state);

  function build() {
    state = view.dummyEditState();
    panel = document.createElement('div');
    panel.id = 'dummy-dev';
    panel.innerHTML = '<div class="dd-title">Dummy editor <span class="dd-hint">` to hide</span></div>';
    for (const row of rows) {
      const box = document.createElement('div');
      box.className = 'dd-group';
      box.innerHTML = `<div class="dd-gname">${row.group}</div>`;
      const obj = at(row.path);
      for (const [key, min, max, step] of row.fields) {
        const line = document.createElement('label');
        line.className = 'dd-row';
        const val = document.createElement('span');
        val.className = 'dd-val';
        val.textContent = obj[key];
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = min; slider.max = max; slider.step = step;
        slider.value = obj[key];
        slider.addEventListener('input', () => {
          obj[key] = +slider.value;
          val.textContent = obj[key].toFixed(2);
          view.applyDummyEdit(state);
        });
        line.append(Object.assign(document.createElement('span'), { className: 'dd-key', textContent: key }), slider, val);
        box.appendChild(line);
      }
      panel.appendChild(box);
    }
    const out = document.createElement('button');
    out.className = 'dd-print';
    out.textContent = 'Print values to console';
    out.addEventListener('click', () => {
      // console.log is intentional here — it's a dev-only tuning tool
      console.log('[dummy editor]', JSON.stringify(state, null, 2)); // eslint-disable-line no-console
    });
    panel.appendChild(out);
    document.body.appendChild(panel);
  }

  function toggle() {
    if (panel) { panel.remove(); panel = null; return; }
    build();
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === '`' || e.key === '~') { e.preventDefault(); toggle(); }
  });
  if (new URLSearchParams(location.search).has('dev')) build();
}
