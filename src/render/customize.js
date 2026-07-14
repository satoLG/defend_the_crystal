import * as THREE from 'three';
import { getTemplate } from './assets.js';

// ============================================================
// Per-character colour customization.
//
// Kenney mini-characters are painted from a single "colormap"
// palette texture: every surface (skin, hair, outfit, shoes…)
// samples one flat swatch out of that atlas. So recolouring a
// body part just means repainting the handful of texels that the
// part's vertices sample.
//
// analyzeModel() walks a model's body/head geometry once, groups
// the swatches it uses into a few height-based slots (hair,
// outfit, trim, shoes) and remembers the exact texels + a safe
// paint radius for each. buildTexture() then clones the palette
// and stamps the chosen colours over those texels, yielding a
// per-player CanvasTexture that leaves every other swatch — and
// every animation — untouched.
// ============================================================

const cache = new Map(); // modelKey -> analysis

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

function meshesOf(group) {
  let body = null, head = null, map = null;
  group.traverse((o) => {
    if (!(o.isMesh || o.isSkinnedMesh)) return;
    const n = (o.name || '').toLowerCase();
    if (n.includes('body') && !body) body = o;
    if (n.includes('head') && !head) head = o;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    if (!map && m && m.map && m.map.image) map = m.map;
  });
  return { body, head, map };
}

// pull the palette atlas into a canvas so we can read/repaint pixels
function paletteCanvas(image) {
  const W = image.width, H = image.height;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0);
  return { cv, ctx, W, H };
}

const hex2 = (n) => n.toString(16).padStart(2, '0');
const toHex = (r, g, b) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;
const colorDist = (a, b) =>
  Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);

// collect the swatch texels a mesh samples, with a vertex count and
// the average world-height of the vertices that land on each texel
function gatherTexels(mesh, W, H, yMin, ySpan, out) {
  const pos = mesh.geometry.attributes.position;
  const uv = mesh.geometry.attributes.uv;
  if (!pos || !uv) return;
  for (let i = 0; i < pos.count; i++) {
    const x = clamp(Math.round(uv.getX(i) * W), 0, W - 1);
    const y = clamp(Math.round(uv.getY(i) * H), 0, H - 1);
    const key = x + ',' + y;
    let t = out.get(key);
    if (!t) { t = { x, y, n: 0, ySum: 0 }; out.set(key, t); }
    t.n += 1;
    t.ySum += (pos.getY(i) - yMin) / ySpan; // 0 = feet … 1 = head top
  }
}

function analyzeModel(modelKey) {
  if (cache.has(modelKey)) return cache.get(modelKey);

  const tpl = getTemplate(modelKey);
  const { body, head, map } = meshesOf(tpl.group);
  const result = { slots: [], map: null, image: null, W: 0, H: 0 };
  cache.set(modelKey, result);
  if (!map || !map.image) return result;

  const { ctx, W, H } = paletteCanvas(map.image);
  const px = ctx.getImageData(0, 0, W, H).data;
  const colorAt = (x, y) => { const i = (y * W + x) * 4; return [px[i], px[i + 1], px[i + 2]]; };

  // shared height range across both meshes so zones line up
  let yMin = Infinity, yMax = -Infinity;
  for (const m of [body, head]) {
    if (!m) continue;
    const p = m.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) { const y = p.getY(i); if (y < yMin) yMin = y; if (y > yMax) yMax = y; }
  }
  const ySpan = Math.max(yMax - yMin, 1e-4);

  const bodyTex = new Map(), headTex = new Map();
  if (body) gatherTexels(body, W, H, yMin, ySpan, bodyTex);
  if (head) gatherTexels(head, W, H, yMin, ySpan, headTex);

  const finalize = (t) => ({ x: t.x, y: t.y, n: t.n, ny: t.ySum / t.n, color: colorAt(t.x, t.y) });
  const bodyArr = [...bodyTex.values()].map(finalize).filter((t) => t.n >= 5);
  const headArr = [...headTex.values()].map(finalize).filter((t) => t.n >= 5);

  // dominant face tone (mid head) — used to tell hair/helmet apart from skin
  const faceCand = headArr.filter((t) => t.ny < 0.85).sort((a, b) => b.n - a.n)[0];
  const faceColor = faceCand ? faceCand.color : [0, 0, 0];

  // ---- hair / head-top: distinct-from-face swatches near the crown
  const hairTexels = headArr.filter((t) => t.ny >= 0.82 && colorDist(t.color, faceColor) > 60);

  // ---- shoes: lowest body band
  const shoeTexels = bodyArr.filter((t) => t.ny < 0.24);
  // ---- outfit + trim: the rest of the body, split by colour into two groups
  const torso = bodyArr.filter((t) => t.ny >= 0.24).sort((a, b) => b.n - a.n);
  const outfitTexels = [], trimTexels = [];
  if (torso.length) {
    const primary = torso[0].color;
    for (const t of torso) (colorDist(t.color, primary) <= 70 ? outfitTexels : trimTexels).push(t);
  }

  const slotDefs = [
    { id: 'hair', label: 'Hair', texels: hairTexels },
    { id: 'outfit', label: 'Outfit', texels: outfitTexels },
    { id: 'trim', label: 'Trim', texels: trimTexels },
    { id: 'shoes', label: 'Shoes', texels: shoeTexels },
  ].filter((s) => s.texels.length);

  // Tag every sampled swatch with its slot (or null for parts we leave
  // alone, e.g. skin/face). A stamp's paint radius is half the distance
  // to the nearest swatch of *any other* colour group, so a recolour can
  // never bleed onto the face or a neighbouring part.
  const slotOf = new Map();
  for (const s of slotDefs) for (const t of s.texels) slotOf.set(t, s.id);
  const sampled = [...bodyArr, ...headArr];
  for (const s of slotDefs) {
    for (const t of s.texels) {
      let nearest = Infinity;
      for (const o of sampled) {
        if (o === t || slotOf.get(o) === s.id) continue; // same swatch or same slot
        const d = Math.hypot(o.x - t.x, o.y - t.y);
        if (d < nearest) nearest = d;
      }
      t.r = clamp(Math.floor(nearest / 2) - 1, 1, 14);
    }
  }

  result.slots = slotDefs.map((s) => {
    const dom = s.texels.slice().sort((a, b) => b.n - a.n)[0];
    return {
      id: s.id, label: s.label,
      base: toHex(dom.color[0], dom.color[1], dom.color[2]),
      texels: s.texels.map((t) => ({ x: t.x, y: t.y, r: t.r })),
    };
  });
  result.map = map;
  result.image = map.image;
  result.W = W; result.H = H;
  return result;
}

export function getSlots(modelKey) {
  return analyzeModel(modelKey).slots;
}

// A palette-atlas texture recoloured for the given per-slot hex colours.
// Returns null when nothing is customized (keep the original texture).
export function buildTexture(modelKey, colors) {
  const info = analyzeModel(modelKey);
  if (!info.image || !colors) return null;
  const active = info.slots.filter((s) => colors[s.id] && colors[s.id] !== s.base);
  if (!active.length) return null;

  const cv = document.createElement('canvas');
  cv.width = info.W; cv.height = info.H;
  const ctx = cv.getContext('2d');
  ctx.drawImage(info.image, 0, 0);
  for (const slot of active) {
    ctx.fillStyle = colors[slot.id];
    for (const t of slot.texels) ctx.fillRect(t.x - t.r, t.y - t.r, t.r * 2 + 1, t.r * 2 + 1);
  }

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

// Swap the recoloured atlas onto an actor's (already cloned) materials.
// Pass tex=null to restore the model's original look.
export function applyTexture(group, modelKey, tex) {
  const next = tex || analyzeModel(modelKey).map;
  if (!next) return; // never strip a working texture if analysis came up empty
  group.traverse((o) => {
    if (!(o.isMesh || o.isSkinnedMesh) || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!('map' in m) || !m.map) continue; // only meshes that were textured
      m.map = next;
      m.needsUpdate = true;
    }
  });
}
