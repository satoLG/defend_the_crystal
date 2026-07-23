import * as THREE from 'three';
import { getTemplate } from './assets.js';

// ============================================================
// Per-character colour customization.
//
// Kenney mini-characters are two skinned meshes (body + head) that
// share one "colormap" palette texture — there are no separate hair
// / shirt / shoe objects to grab. So we derive the parts ourselves,
// reliably, from two things that ARE in the file:
//
//   1. The atlas is segmented into connected colour CELLS. Each cell
//      is one material swatch (a flat colour or a smooth gradient),
//      bounded by the hard colour jumps between swatches. Recolouring
//      a whole cell repaints the entire part — gradient tip included —
//      so nothing is ever left half-painted (no stray bands).
//   2. Every vertex is skinned to a bone (head / torso / arms / legs).
//      Mapping the cells each region samples gives honest labels and a
//      dependable skin test: skin is the warm swatch that shows up
//      across several body regions (face + hands + legs), so it's never
//      confused with a same-region cap or tunic.
//
// The weapons are separate objects with their own texture and are
// never touched.
// ============================================================

const cache = new Map(); // modelKey -> analysis

const STEP_TOL = 16;   // atlas flood step: within-cell gradient vs a new swatch
const DEDUP_DIST = 58; // merge cells of near-identical colour into one slot
const MAX_PARTS = 5;   // non-skin slots (plus an optional Skin slot)
const MIN_VERTS = 12;  // a cell must be sampled this much to be a real part
const MIN_CELLPX = 80; // …and be a real region in the atlas, not a sliver

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const colorDist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
const lumOf = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const hex2 = (n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
const toHex = (r, g, b) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;
const hexToRgb = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

const isCharMesh = (o) => {
  if (!(o.isMesh || o.isSkinnedMesh)) return false;
  const n = (o.name || '').toLowerCase();
  return n.includes('body') || n.includes('head');
};

// skin: a warm flesh tone (excludes reds, oranges, greys, browns-of-cloth
// by keeping green in a mid band and red-blue spread moderate)
function isSkinTone(c) {
  const [r, g, b] = c;
  return r > g && g >= b && r >= 105 &&
    (r - b) >= 15 && (r - b) <= 150 &&
    g >= 0.40 * r && g <= 0.88 * r;
}

function region(boneName) {
  const n = boneName || '';
  if (n.includes('head')) return 'head';
  if (n.includes('leg')) return 'legs';
  return 'body'; // torso, arms, root
}

// dominant bone (region) of every vertex in a skinned mesh
function vertexRegions(mesh) {
  const si = mesh.geometry.attributes.skinIndex;
  const sw = mesh.geometry.attributes.skinWeight;
  const bones = mesh.skeleton && mesh.skeleton.bones;
  const n = mesh.geometry.attributes.position.count;
  const out = new Array(n);
  if (!si || !sw || !bones) { out.fill('body'); return out; }
  const comp = ['getX', 'getY', 'getZ', 'getW'];
  for (let i = 0; i < n; i++) {
    let bw = -1, bj = 0;
    for (let k = 0; k < 4; k++) {
      const w = sw[comp[k]](i);
      if (w > bw) { bw = w; bj = si[comp[k]](i); }
    }
    out[i] = region(bones[bj] ? bones[bj].name : '');
  }
  return out;
}

function analyzeModel(modelKey) {
  if (cache.has(modelKey)) return cache.get(modelKey);
  const result = { slots: [], map: null, image: null, W: 0, H: 0 };
  cache.set(modelKey, result);

  const tpl = getTemplate(modelKey);
  let body = null, head = null, map = null;
  tpl.group.traverse((o) => {
    if (!isCharMesh(o)) return;
    const nm = (o.name || '').toLowerCase();
    if (nm.includes('body') && !body) body = o;
    if (nm.includes('head') && !head) head = o;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    if (!map && m && m.map && m.map.image) map = m.map;
  });
  if (!map || !map.image) return result;

  const W = map.image.width, H = map.image.height, N = W * H;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(map.image, 0, 0);
  const data = ctx.getImageData(0, 0, W, H).data;

  // --- 1. segment the atlas into connected colour cells
  const cellOf = new Int32Array(N).fill(-1);
  const cells = []; // { pixels:[idx], color:[r,g,b], lum }
  const stack = [];
  for (let s = 0; s < N; s++) {
    if (cellOf[s] !== -1 || data[s * 4 + 3] < 8) continue;
    const id = cells.length;
    const pixels = [];
    let sr = 0, sg = 0, sb = 0;
    stack.length = 0; stack.push(s); cellOf[s] = id;
    while (stack.length) {
      const p = stack.pop();
      pixels.push(p);
      const pr = data[p * 4], pg = data[p * 4 + 1], pb = data[p * 4 + 2];
      sr += pr; sg += pg; sb += pb;
      const x = p % W, y = (p / W) | 0;
      const nb = [];
      if (x > 0) nb.push(p - 1);
      if (x < W - 1) nb.push(p + 1);
      if (y > 0) nb.push(p - W);
      if (y < H - 1) nb.push(p + W);
      for (const q of nb) {
        if (cellOf[q] !== -1 || data[q * 4 + 3] < 8) continue;
        if (Math.abs(data[q * 4] - pr) + Math.abs(data[q * 4 + 1] - pg) + Math.abs(data[q * 4 + 2] - pb) < STEP_TOL) {
          cellOf[q] = id; stack.push(q);
        }
      }
    }
    const k = pixels.length;
    cells.push({ pixels, color: [sr / k, sg / k, sb / k], lum: lumOf(sr / k, sg / k, sb / k) });
  }

  // --- 2. tally which cells the character samples, and from which regions
  let yMin = Infinity, yMax = -Infinity;
  for (const m of [body, head]) {
    if (!m) continue;
    const p = m.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) { const y = p.getY(i); if (y < yMin) yMin = y; if (y > yMax) yMax = y; }
  }
  const ySpan = Math.max(yMax - yMin, 1e-4);

  const info = new Map(); // cellId -> { verts, regions:{}, nySum }
  for (const m of [body, head]) {
    if (!m) continue;
    const pos = m.geometry.attributes.position;
    const uv = m.geometry.attributes.uv;
    if (!uv) continue;
    const regions = vertexRegions(m);
    for (let i = 0; i < pos.count; i++) {
      const x = clamp(Math.round(uv.getX(i) * W), 0, W - 1);
      const y = clamp(Math.round(uv.getY(i) * H), 0, H - 1);
      const id = cellOf[y * W + x];
      if (id < 0) continue;
      let f = info.get(id);
      if (!f) { f = { verts: 0, regions: {}, nySum: 0 }; info.set(id, f); }
      f.verts += 1;
      f.regions[regions[i]] = (f.regions[regions[i]] || 0) + 1;
      f.nySum += (pos.getY(i) - yMin) / ySpan;
    }
  }

  const sampled = [];
  for (const [id, f] of info) {
    if (f.verts < MIN_VERTS || cells[id].pixels.length < MIN_CELLPX) continue;
    const spread = Object.keys(f.regions).length;
    let dom = 'body', domN = -1;
    for (const [rg, c] of Object.entries(f.regions)) if (c > domN) { domN = c; dom = rg; }
    sampled.push({ id, color: cells[id].color, lum: cells[id].lum, pixels: cells[id].pixels, verts: f.verts, ny: f.nySum / f.verts, spread, dom });
  }
  sampled.sort((a, b) => b.verts - a.verts);

  // --- 3. skin = warm swatches seen across several body regions
  const skinCells = sampled.filter((c) => isSkinTone(c.color) && c.spread >= 2);
  const isSkin = new Set(skinCells.map((c) => c.id));

  // --- 4. build slots: distinct non-skin parts, then one Skin slot
  const labelCount = {};
  const label = (dom, ny) => {
    let base = dom === 'head' ? (ny >= 0.72 ? 'Hair' : 'Head')
      : dom === 'legs' ? (ny < 0.14 ? 'Shoes' : 'Legs')
        : 'Outfit';
    labelCount[base] = (labelCount[base] || 0) + 1;
    return labelCount[base] > 1 ? `${base} ${labelCount[base]}` : base;
  };

  const slots = [];
  for (const c of sampled) {
    if (isSkin.has(c.id)) continue;
    const dup = slots.find((s) => colorDist(s.color, c.color) < DEDUP_DIST);
    if (dup) { dup.pixels = dup.pixels.concat(c.pixels); continue; } // same material, another cell
    if (slots.length >= MAX_PARTS) continue;
    slots.push({ color: c.color, lum: c.lum, pixels: c.pixels.slice(), dom: c.dom, ny: c.ny });
  }
  slots.sort((a, b) => b.ny - a.ny);

  result.slots = slots.map((s, i) => ({
    id: 'slot' + i,
    label: label(s.dom, s.ny),
    base: toHex(s.color[0], s.color[1], s.color[2]),
    lum: Math.max(s.lum, 1),
    pixels: Int32Array.from(s.pixels),
  }));

  if (skinCells.length) {
    let px = [];
    for (const c of skinCells) px = px.concat(c.pixels);
    const sk = skinCells[0];
    result.slots.push({
      id: 'skin', label: 'Skin',
      base: toHex(sk.color[0], sk.color[1], sk.color[2]),
      lum: Math.max(sk.lum, 1),
      pixels: Int32Array.from(px),
    });
  }

  result.map = map; result.image = map.image; result.W = W; result.H = H;
  return result;
}

export function getSlots(modelKey) {
  return analyzeModel(modelKey).slots.map((s) => ({ id: s.id, label: s.label, base: s.base }));
}

// A palette-atlas texture recoloured for the given per-slot colours.
// Each slot repaints its whole cell(s), keeping the original shading
// (per-pixel luminance) so gradients survive. Returns null when nothing
// is customized.
export function buildTexture(modelKey, colors) {
  const info = analyzeModel(modelKey);
  if (!info.image || !colors) return null;
  const active = info.slots.filter((s) => colors[s.id] && colors[s.id].toLowerCase() !== s.base.toLowerCase());
  if (!active.length) return null;

  const cv = document.createElement('canvas');
  cv.width = info.W; cv.height = info.H;
  const ctx = cv.getContext('2d');
  ctx.drawImage(info.image, 0, 0);
  const imgData = ctx.getImageData(0, 0, info.W, info.H);
  const d = imgData.data;
  for (const slot of active) {
    const [nr, ng, nb] = hexToRgb(colors[slot.id]);
    const sl = slot.lum;
    const px = slot.pixels;
    for (let k = 0; k < px.length; k++) {
      const i = px[k] * 4;
      const f = lumOf(d[i], d[i + 1], d[i + 2]) / sl;
      d[i] = clamp(nr * f, 0, 255);
      d[i + 1] = clamp(ng * f, 0, 255);
      d[i + 2] = clamp(nb * f, 0, 255);
    }
  }
  ctx.putImageData(imgData, 0, 0);

  const tex = new THREE.CanvasTexture(cv);
  const src = info.map;
  tex.flipY = src.flipY;
  tex.colorSpace = src.colorSpace;
  tex.wrapS = src.wrapS; tex.wrapT = src.wrapT;
  tex.magFilter = src.magFilter; tex.minFilter = src.minFilter;
  tex.generateMipmaps = src.generateMipmaps;
  tex.needsUpdate = true;
  return tex;
}

// Swap the recoloured atlas onto a character's body/head materials only —
// never the attached weapons. Pass tex=null to restore the original look.
export function applyTexture(group, modelKey, tex) {
  const next = tex || analyzeModel(modelKey).map;
  if (!next) return;
  group.traverse((o) => {
    if (!isCharMesh(o) || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!('map' in m) || !m.map) continue;
      m.map = next;
      m.needsUpdate = true;
    }
  });
}
