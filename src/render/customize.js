import * as THREE from 'three';
import { getTemplate } from './assets.js';

// ============================================================
// Per-character colour customization.
//
// Kenney mini-characters are painted from a single "colormap"
// palette texture: every surface samples one flat swatch out of
// that atlas. A body part is therefore one solid colour in the
// atlas, and recolouring it means replacing *that colour* wherever
// it appears — not painting a region by pixel position (which bled
// across neighbouring swatches and produced stripes).
//
// analyzeModel() walks the character's body/head geometry, groups
// the swatches it samples into a handful of distinct, well-used
// colour regions (small speckles — outlines, seams, tiny accents —
// are ignored so they can never be half-painted), and exposes each
// as a slot. buildTexture() clones the atlas and swaps every pixel
// of a slot's colours for the chosen one, so the whole region turns
// uniformly and nothing else — skin, face detail, and especially
// the weapons — is touched.
// ============================================================

const cache = new Map(); // modelKey -> analysis

const MERGE_DIST = 52;   // atlas colours closer than this are one region
const DEDUP_DIST = 46;   // two exposed slots must differ by at least this
const MATCH_TOL = 12;    // pixel<->slot colour match tolerance when repainting
const MAX_SLOTS = 6;

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const colorDist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
const hex2 = (n) => Math.round(n).toString(16).padStart(2, '0');
const toHex = (r, g, b) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;

// only the character's own skinned meshes carry the palette; props
// (weapons) are separate objects and must never be recoloured
const isCharMesh = (o) => {
  if (!(o.isMesh || o.isSkinnedMesh)) return false;
  const n = (o.name || '').toLowerCase();
  return n.includes('body') || n.includes('head');
};

function meshesOf(group) {
  let body = null, head = null, map = null;
  group.traverse((o) => {
    if (!isCharMesh(o)) return;
    const n = (o.name || '').toLowerCase();
    if (n.includes('body') && !body) body = o;
    if (n.includes('head') && !head) head = o;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    if (!map && m && m.map && m.map.image) map = m.map;
  });
  return { body, head, map };
}

// gather the flat swatch texels a mesh samples: {x,y,color,n,nySum}
function gatherTexels(mesh, W, H, yMin, ySpan, colorAt, out) {
  const pos = mesh.geometry.attributes.position;
  const uv = mesh.geometry.attributes.uv;
  if (!pos || !uv) return;
  for (let i = 0; i < pos.count; i++) {
    const x = clamp(Math.round(uv.getX(i) * W), 0, W - 1);
    const y = clamp(Math.round(uv.getY(i) * H), 0, H - 1);
    const key = x + ',' + y;
    let t = out.get(key);
    if (!t) { t = { x, y, color: colorAt(x, y), n: 0, nySum: 0 }; out.set(key, t); }
    t.n += 1;
    t.nySum += (pos.getY(i) - yMin) / ySpan; // 0 = feet … 1 = head top
  }
}

function analyzeModel(modelKey) {
  if (cache.has(modelKey)) return cache.get(modelKey);

  const tpl = getTemplate(modelKey);
  const { body, head, map } = meshesOf(tpl.group);
  const result = { slots: [], map: null, image: null, W: 0, H: 0 };
  cache.set(modelKey, result);
  if (!map || !map.image) return result;

  const W = map.image.width, H = map.image.height;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(map.image, 0, 0);
  const px = ctx.getImageData(0, 0, W, H).data;
  const colorAt = (x, y) => { const i = (y * W + x) * 4; return [px[i], px[i + 1], px[i + 2]]; };

  // shared height range so zones line up across both meshes
  let yMin = Infinity, yMax = -Infinity;
  for (const m of [body, head]) {
    if (!m) continue;
    const p = m.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) { const y = p.getY(i); if (y < yMin) yMin = y; if (y > yMax) yMax = y; }
  }
  const ySpan = Math.max(yMax - yMin, 1e-4);

  const texMap = new Map();
  if (body) gatherTexels(body, W, H, yMin, ySpan, colorAt, texMap);
  if (head) gatherTexels(head, W, H, yMin, ySpan, colorAt, texMap);

  const texels = [...texMap.values()].filter((t) => t.n >= 5).sort((a, b) => b.n - a.n);
  let total = 0;
  for (const t of texels) total += t.n;

  // cluster swatches by colour (dominant-seeded so region colours are stable)
  const clusters = [];
  for (const t of texels) {
    let cl = null;
    for (const c of clusters) { if (colorDist(c.color, t.color) < MERGE_DIST) { cl = c; break; } }
    if (!cl) { cl = { color: t.color, n: 0, nySum: 0, members: [] }; clusters.push(cl); }
    cl.n += t.n;
    cl.nySum += t.nySum;
    cl.members.push(t.color);
  }

  // keep only substantial, clearly-separated regions (skip speckle:
  // outlines, seams, tiny accents — the stuff that used to stripe)
  const minVerts = Math.max(45, total * 0.045);
  const kept = [];
  for (const c of clusters.sort((a, b) => b.n - a.n)) {
    if (c.n < minVerts) continue;
    if (kept.some((k) => colorDist(k.color, c.color) < DEDUP_DIST)) continue;
    kept.push(c);
    if (kept.length >= MAX_SLOTS) break;
  }

  // Semantic labels aren't reliable on these detailed textures (a
  // brown swatch could be hair or a tunic), so number the regions
  // top-to-bottom and let the live preview show which is which as the
  // player tweaks it — honest, and never mislabels a part.
  kept.sort((a, b) => (b.nySum / b.n) - (a.nySum / a.n));
  result.slots = kept.map((c, i) => {
    // dedup the member colours for the repaint match list
    const match = [];
    for (const m of c.members) if (!match.some((x) => colorDist(x, m) < 6)) match.push(m);
    return { id: 'slot' + i, label: 'Colour ' + (i + 1), base: toHex(c.color[0], c.color[1], c.color[2]), match };
  });
  result.map = map;
  result.image = map.image;
  result.W = W; result.H = H;
  return result;
}

export function getSlots(modelKey) {
  return analyzeModel(modelKey).slots;
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// A palette-atlas texture recoloured for the given per-slot colours by
// swapping each slot's swatch colours wholesale. Returns null when
// nothing is customized (keep the original atlas).
export function buildTexture(modelKey, colors) {
  const info = analyzeModel(modelKey);
  if (!info.image || !colors) return null;
  const active = info.slots
    .filter((s) => colors[s.id] && colors[s.id].toLowerCase() !== s.base.toLowerCase())
    .map((s) => ({ match: s.match, to: hexToRgb(colors[s.id]) }));
  if (!active.length) return null;

  const cv = document.createElement('canvas');
  cv.width = info.W; cv.height = info.H;
  const ctx = cv.getContext('2d');
  ctx.drawImage(info.image, 0, 0);
  const imgData = ctx.getImageData(0, 0, info.W, info.H);
  const d = imgData.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    let best = null, bestD = MATCH_TOL;
    for (const s of active) {
      for (const m of s.match) {
        const dist = Math.abs(r - m[0]) + Math.abs(g - m[1]) + Math.abs(b - m[2]);
        if (dist < bestD) { bestD = dist; best = s; }
      }
    }
    if (best) { d[i] = best.to[0]; d[i + 1] = best.to[1]; d[i + 2] = best.to[2]; }
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
