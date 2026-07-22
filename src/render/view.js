import * as THREE from 'three';
import { instantiate, getTemplate } from './assets.js';
import { buildTexture, applyTexture, getSlots } from './customize.js';
import { iconPaths } from '../icons.js';
import { CLASSES, TOWERS, JUMP, ENEMIES, BOSSES, PETS, WEAPONS, classStarterWeapons } from '../config.js';
import { t, bossNameByKind } from '../i18n.js';
import { cellToWorld, CRYSTAL_POS, HALF_H, PLAZA } from '../sim/grid.js';
import {
  ELEV, terrainY, NPCS, AMBIENT_NPCS, DUMMIES, PORTAL,
} from '../sanctuary.js';
import { lerp, angleLerp } from '../utils.js';
import { sfx } from '../audio.js';

// ============================================================
// Turns simulation snapshots + one-shot events into moving,
// animated, glowing things on screen. Pure visuals — no game
// rules live here.
// ============================================================

const PL = { ID: 0, CLS: 1, X: 2, Z: 3, YAW: 4, HP: 5, MHP: 6, LVL: 7, XP: 8, XPN: 9, MOV: 10, DEAD: 11, RESP: 12, OBST: 13, KILLS: 14, NAME: 15, SKCD: 16, WALL: 17, ATK: 18, SPD: 19, PET: 20, PETNAME: 21, PETLVL: 22, WPN: 23, WPNT: 24, SHD: 25, SHDT: 26 };
const EN = { ID: 0, KIND: 1, X: 2, Z: 3, YAW: 4, HP: 5, MHP: 6, SCALE: 7, BOSS: 8, MOV: 9, ST: 10, VR: 11 };

// EN.ST status bitmask (mirrors buildSnapshot): slow|burn|poison|stun
const ST_SLOW = 1, ST_BURN = 2, ST_POISON = 4, ST_STUN = 8;
// EN.VR visual variants: stage-2 / stage-3 power looks, Brutus props
const VR_T2 = 1, VR_T3 = 2, VR_BRUTUS = 3;

// ---- enemy power-stage looks --------------------------------------
// Stage-2/3 enemies swap in a recolored atlas where ONLY the matching
// pixels change (the zombie/orc's green skin, the skeleton's bone, the
// ghost's bright body) — clothes, eyes and mouths keep their colors,
// so it reads as a different creature, not a filter.
const TIER_LOOKS = {
  zombie: { match: 'green', colors: [0x4a7fd8, 0xd23b2e] },  // blue / red skin
  orc:    { match: 'green', colors: [0x4a7fd8, 0xd23b2e] },
  skeleton:   { match: 'bone', colors: [0x878d99, 0x2f333b] }, // grey / near-black
  skelarcher: { match: 'bone', colors: [0x878d99, 0x2f333b] },
  ghost:  { match: 'bright', colors: [0x6faaff, 0xe0503a] },  // blue / red body
  // vampire: no recolor — it only grows with its stage
};
const lumOf = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const TIER_MATCHERS = {
  green: (r, g, b) => g > r + 12 && g > b + 12,
  bone: (r, g, b) => lumOf(r, g, b) > 115 && Math.abs(r - g) < 30 && Math.abs(g - b) < 36,
  bright: (r, g, b) => lumOf(r, g, b) > 115,
};

// one recolored texture per (model, rule, stage) — shared by every
// enemy wearing that look
const tierTexCache = new Map();
function tierTexture(modelKey, kind, stage /* 0 = stage-2, 1 = stage-3 */) {
  const look = TIER_LOOKS[kind];
  if (!look) return null;
  const key = `${modelKey}:${look.match}:${stage}`;
  if (tierTexCache.has(key)) return tierTexCache.get(key);
  let src = null;
  getTemplate(modelKey).group.traverse((o) => {
    if (!src && (o.isMesh || o.isSkinnedMesh)) {
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      if (m?.map?.image) src = m.map;
    }
  });
  let tex = null;
  if (src) {
    const img = src.image;
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const imgData = ctx.getImageData(0, 0, cv.width, cv.height);
    const d = imgData.data;
    const match = TIER_MATCHERS[look.match];
    // average luminance of the matched region → per-pixel shading survives
    let lumSum = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 8 && match(d[i], d[i + 1], d[i + 2])) {
        lumSum += lumOf(d[i], d[i + 1], d[i + 2]); n += 1;
      }
    }
    if (n > 0) {
      const base = Math.max(lumSum / n, 1);
      const c = new THREE.Color(look.colors[stage]);
      const tr = c.r * 255, tg = c.g * 255, tb = c.b * 255;
      const cl = (v) => Math.min(Math.max(Math.round(v), 0), 255);
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] > 8 && match(d[i], d[i + 1], d[i + 2])) {
          const f = lumOf(d[i], d[i + 1], d[i + 2]) / base;
          d[i] = cl(tr * f); d[i + 1] = cl(tg * f); d[i + 2] = cl(tb * f);
        }
      }
      ctx.putImageData(imgData, 0, 0);
      tex = new THREE.CanvasTexture(cv);
      tex.flipY = src.flipY;
      tex.colorSpace = src.colorSpace;
      tex.wrapS = src.wrapS; tex.wrapT = src.wrapT;
      tex.magFilter = src.magFilter; tex.minFilter = src.minFilter;
      tex.generateMipmaps = src.generateMipmaps;
      tex.needsUpdate = true;
    }
  }
  tierTexCache.set(key, tex);
  return tex;
}

// Recolor a mini-character atlas by hue rule (currently only 'green' →
// a target colour), preserving per-pixel shading. Cached per model+rules
// and cloned so no other actor wearing the shared colormap is affected.
const npcHueCache = new Map();
function npcHueTexture(modelKey, rules) {
  const key = modelKey + '|' + rules.map((r) => r.match + r.to).join(',');
  if (npcHueCache.has(key)) return npcHueCache.get(key);
  let src = null;
  getTemplate(modelKey).group.traverse((o) => {
    if (!src && (o.isMesh || o.isSkinnedMesh)) {
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      if (m?.map?.image) src = m.map;
    }
  });
  let tex = null;
  if (src?.image) {
    const img = src.image;
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, cv.width, cv.height);
    const d = data.data;
    const cl = (v) => Math.min(Math.max(Math.round(v), 0), 255);
    for (const rule of rules) {
      if (rule.match !== 'green') continue;
      const to = new THREE.Color(rule.to);
      const tr = to.r * 255, tg = to.g * 255, tb = to.b * 255;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        if (d[i + 3] > 8 && g > r + 12 && g > b + 12) {
          const f = lumOf(r, g, b) / Math.max(lumOf(0, 200, 0), 1);
          d[i] = cl(tr * f); d[i + 1] = cl(tg * f); d[i + 2] = cl(tb * f);
        }
      }
    }
    ctx.putImageData(data, 0, 0);
    tex = new THREE.CanvasTexture(cv);
    tex.flipY = src.flipY;
    tex.colorSpace = src.colorSpace;
    tex.wrapS = src.wrapS; tex.wrapT = src.wrapT;
    tex.magFilter = src.magFilter; tex.minFilter = src.minFilter;
    tex.generateMipmaps = src.generateMipmaps;
    tex.needsUpdate = true;
  }
  npcHueCache.set(key, tex);
  return tex;
}

// Hand props live in BONE space: raw Kenney units, grip at the origin.
// The hand sits ~0.14 units down the arm bone; rot compensates the
// arm's resting tilt so weapons read upright and stay visible.
// Every weapon of a family shares its family's mount, so a swapped
// weapon lands exactly where the original one sat.
const MOUNTS = {
  axe: { bone: 'arm-right', pos: [-0.225, 0.01, 0.09], rot: [0.66, 0.6, -0.45] },
  sword: { bone: 'arm-right', pos: [-0.225, 0.065, 0.115], rot: [0.54, 1.09, 0.11] },
  shield: { bone: 'arm-left', pos: [0.175, 0.055, 0.195], rot: [-0.26, 0.29, -0.2] },
  // bow mount dialed in with the creation-screen bow tuner
  bow: { bone: 'arm-right', pos: [0.025, -0.155, 0.22], rot: [-0.862, 0.668, -1.962] },
  // the crossbow model carries its own base orientation, so it keeps
  // the original bow mount rather than the tuned longbow one
  crossbow: { bone: 'arm-right', pos: [0.02, -0.155, 0.255], rot: [-2.78, 0.23, -1] },
  staff: { bone: 'arm-right', pos: [-0.225, 0.29, 0.175], rot: [0, 0.35, 3.142] },
};

// one prop spec per purchasable weapon (see WEAPONS in config.js).
// tierMode decides how the gold/crystal upgrade finish is painted on:
//   'metal'  — only the grey metal of the weapon (blade/head), so wood
//              handles keep their look (melee weapons & shields)
//   'all'    — the whole model (bows)
//   'crystal'— only the separate crystal gem(s) (mage staff / wand)
//   'orb'    — the whole procedural orb
export const WEAPON_PROPS = {
  axe: { gen: makeAxe, ...MOUNTS.axe, scale: 1, tierMode: 'metal' },
  greataxe: { gen: makeGreatAxe, ...MOUNTS.axe, scale: 1, tierMode: 'metal' },
  hammer: { gen: makeHammer, ...MOUNTS.axe, scale: 1, tierMode: 'metal' },
  sword: { key: 'prop-sword', ...MOUNTS.sword, scale: 0.94, tierMode: 'metal' },
  greatsword: { gen: makeGreatSword, ...MOUNTS.sword, scale: 0.94, tierMode: 'metal' },
  spear: { gen: makeSpear, ...MOUNTS.sword, scale: 1, tierMode: 'metal' },
  shield: { key: 'prop-shield', ...MOUNTS.shield, scale: 1.32, tierMode: 'metal' },
  greatshield: { gen: makeGreatShield, ...MOUNTS.shield, scale: 1.32, tierMode: 'metal' },
  bow: { gen: makeBow, ...MOUNTS.bow, scale: 1.1, tierMode: 'all' },
  greatbow: { gen: () => makeBow(0.6), ...MOUNTS.bow, scale: 1.25, tierMode: 'all' },
  crossbow: { gen: makeCrossbow, ...MOUNTS.crossbow, scale: 1.4, tierMode: 'all' },
  staff: { key: 'prop-staff', ...MOUNTS.staff, scale: 1.32, crystalTip: 0x8a2be2, tierMode: 'crystal' },
  wand: { gen: makeWand, ...MOUNTS.staff, scale: 1.32, tierMode: 'crystal' },
  orb: { gen: makeOrbProp, bone: 'arm-right', pos: [-0.225, 0.06, 0.14], rot: [0, 0, 0], scale: 1, tierMode: 'orb' },
};

// per-tier accent colours reused by the finishes, projectiles and
// attack effects: index 0 normal (unused), 1 gold, 2 crystal
export const TIER_COLORS = [null, 0xffc41f, 0x7fe6ff];

// swap an effect's base colour for the weapon's tier accent (gold /
// crystal) so upgraded weapons throw upgraded-looking hits
function tierEffectColor(base, wt) {
  return wt > 0 && TIER_COLORS[wt] ? TIER_COLORS[wt] : base;
}

const QUIVER_SPEC = { gen: makeQuiver, bone: 'torso', pos: [-0.145, 0.055, -0.12], rot: [-0.02, -0.81, 0.41], scale: 1.03 };

// prop specs for a class holding a specific loadout ({id, tier} refs;
// null falls back to the class's starter weapons). The archer's quiver
// rides along whatever bow is equipped.
export function loadoutProps(cls, weapon = null, shield = null) {
  const specs = [];
  const starter = (slot) =>
    classStarterWeapons(cls).find((w) => WEAPONS[w].slot === slot);
  const wid = WEAPON_PROPS[weapon?.id] ? weapon.id : starter('weapon');
  if (wid) specs.push({ ...WEAPON_PROPS[wid], tier: weapon?.tier || 0 });
  const sid = WEAPON_PROPS[shield?.id] ? shield.id : starter('shield');
  if (sid) specs.push({ ...WEAPON_PROPS[sid], tier: shield?.tier || 0 });
  if (cls === 'archer') specs.push(QUIVER_SPEC);
  return specs;
}

// default (starter) props per class — used by the character-creation
// preview and by enemies that mirror a class (skeleton archers)
export const CLASS_PROPS = {
  berserker: loadoutProps('berserker'),
  tanker: loadoutProps('tanker'),
  archer: loadoutProps('archer'),
  mage: loadoutProps('mage'),
};

// The real bow model (bow.glb, mini-forest kit). Kit weapons are
// authored on their side with odd FBX2glTF node scales, so normalize at
// runtime: stand the long axis up (+Y), face the limbs forward (+Z),
// drop the grip on the origin and scale to a hand-prop height —
// matching the convention the archer's prop transform expects.
// `height` lets the Great Bow reuse this at a bigger size.
export function makeBow(height = 0.5) {
  const inner = instantiate('prop-bow', { shadows: false }).group;
  const pre = new THREE.Box3().setFromObject(inner);
  const s = pre.getSize(new THREE.Vector3());
  // whichever axis is longest is the bow's length — rotate it upright
  if (s.x >= s.y && s.x >= s.z) inner.rotation.z = Math.PI / 2;
  else if (s.z >= s.y && s.z >= s.x) inner.rotation.x = Math.PI / 2;
  inner.rotation.y = Math.PI / 2; // limbs bow toward +Z, thin across X

  const holder = new THREE.Group();
  holder.add(inner);
  const box = new THREE.Box3().setFromObject(holder);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  inner.position.sub(center);                        // grip (center) to origin
  holder.scale.setScalar(height / Math.max(size.y, 1e-3));
  return holder;
}

// Generic normalizer for long-handled kit weapons (axes, hammers,
// spears, swords from other Kenney kits whose units don't match bone
// space): stand the long axis (handle) upright, drop the grip on the
// origin — `gripBias` slides it down the handle so it reads as held —
// and scale to a hand-prop height.
function makeUprightProp(key, height, gripBias = 0.28, flip = false) {
  const raw = instantiate(key, { shadows: false }).group;
  const pre = new THREE.Box3().setFromObject(raw);
  const s = pre.getSize(new THREE.Vector3());
  // whichever axis is longest is the handle — rotate it upright (+Y)
  if (s.x >= s.y && s.x >= s.z) raw.rotation.z = Math.PI / 2;
  else if (s.z >= s.y && s.z >= s.x) raw.rotation.x = Math.PI / 2;

  // some kit models export blade-down — flip end-for-end so the grip
  // sits low in the hand and the business end points up (done on a
  // wrapper so the centering/grip-bias below still works unchanged)
  const inner = new THREE.Group();
  inner.add(raw);
  if (flip) inner.rotation.x = Math.PI;

  const holder = new THREE.Group();
  holder.add(inner);
  const box = new THREE.Box3().setFromObject(holder);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  inner.position.sub(center);                // center to origin…
  inner.position.y += size.y * gripBias;     // …then bias so the grip sits low
  holder.scale.setScalar(height / Math.max(size.y, 1e-3));
  return holder;
}

export function makeAxe() { return makeUprightProp('prop-axe', 0.6); }
// bigger, meaner versions of the melee family (sizes in bone space,
// relative to the 0.6-tall axe / the raw sword the classes start with)
export function makeGreatAxe() { return makeUprightProp('prop-axe-great', 0.85); }
export function makeHammer() { return makeUprightProp('prop-hammer', 0.8); }
export function makeSpear() { return makeUprightProp('prop-spear', 1.05, 0.1); }
// the great-sword kit model exports blade-down, so flip it upright
export function makeGreatSword() { return makeUprightProp('prop-sword-great', 0.78, 0.28, true); }
// the gravedigger's shovel (graveyard kit) exports the same way — flip
// it and normalize it like the axe so it grips the hand right-side up
export function makeShovel() { return makeUprightProp('prop-shovel', 0.7, 0.28, true); }

// the mini-dungeon rectangle shield, blown up relative to the round
// shield the tanker starts with (both kits share the mini scale)
export function makeGreatShield() {
  const holder = new THREE.Group();
  const inner = instantiate('prop-shield-great', { shadows: false }).group;
  holder.add(inner);
  const base = new THREE.Box3().setFromObject(instantiate('prop-shield', { shadows: false }).group);
  const own = new THREE.Box3().setFromObject(inner);
  const baseH = base.getSize(new THREE.Vector3()).y;
  const ownH = own.getSize(new THREE.Vector3()).y;
  const center = own.getCenter(new THREE.Vector3());
  inner.position.sub(center); // center on the grip like the round shield
  // a touch over the round shield — 1.5× dragged on the ground for
  // normal-size heroes (bosses still scale the whole model up on top)
  holder.scale.setScalar((baseH * 1.25) / Math.max(ownH, 1e-3));
  return holder;
}

// the crossbow borrows the ballista tower's raw weapon model for now,
// shrunk to hand size and aimed the way the bow mount expects
export function makeCrossbow() {
  const inner = instantiate('tower-ballista', { shadows: false }).group;
  const holder = new THREE.Group();
  holder.add(inner);
  const box = new THREE.Box3().setFromObject(holder);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  inner.position.sub(center);
  // stand it on end like a bow: stock down, prod (bow part) up
  inner.rotation.set(0, Math.PI, 0);
  holder.rotation.z = Math.PI / 2;
  holder.scale.setScalar(0.42 / Math.max(size.x, size.y, size.z, 1e-3));
  return holder;
}

// a shrunken staff with its crystal dyed red — the wand
export function makeWand() {
  const holder = new THREE.Group();
  const staff = instantiate('prop-staff', { shadows: false }).group;
  staff.scale.setScalar(0.62);
  holder.add(staff);
  const tip = instantiate('prop-crystal', { shadows: false, cloneMaterials: true }).group;
  tip.scale.setScalar(0.3);
  tip.position.set(0, 0.034, -0.003);
  tip.rotation.set(-3.15, 0.29, 0.05);
  tip.traverse((o) => {
    if (o.isMesh && o.material.emissive) {
      o.material.color.set(0xff5a4a);
      o.material.emissive.set(0xd42a1a);
      o.material.emissiveIntensity = 0.85;
      o.userData.isCrystal = true; // tier finish repaints only the gem
    }
  });
  holder.add(tip);
  return holder;
}

// a floating arcane sphere wreathed in a glowing halo + orbiting motes
export function makeOrbProp() {
  const holder = new THREE.Group();
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(0.085, 16, 16),
    new THREE.MeshStandardMaterial({
      color: 0xb488ff, emissive: 0x7a2be2, emissiveIntensity: 0.9,
      roughness: 0.25, metalness: 0.1,
    })
  );
  core.userData.orbCore = true;
  holder.add(core);
  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(0.13, 12, 12),
    new THREE.MeshBasicMaterial({
      color: 0xa050ff, transparent: true, opacity: 0.3,
      blending: THREE.AdditiveBlending, depthWrite: false,
    })
  );
  holder.add(halo);
  const moteMat = new THREE.MeshBasicMaterial({ color: 0xe6c4ff, toneMapped: false });
  for (let i = 0; i < 3; i++) {
    const mote = new THREE.Mesh(new THREE.SphereGeometry(0.016, 6, 6), moteMat);
    const a = (i / 3) * Math.PI * 2;
    mote.position.set(Math.cos(a) * 0.15, Math.sin(a * 2) * 0.04, Math.sin(a) * 0.15);
    holder.add(mote);
  }
  return holder;
}

// ---- gold / crystal upgrade finish -------------------------------
// Kenney weapons are a single textured mesh (one "colormap" atlas), so
// a flat material tint would gild the wooden handle too. Instead we
// recolour the ATLAS PIXELS: for melee weapons only the grey (metal)
// swatches turn gold/crystal; bows recolour the whole texture. The
// recoloured textures are cached and shared across every holder.
const skinCache = new Map();
const clamp255 = (v) => Math.max(0, Math.min(255, v | 0));

function tintTexture(map, tier, metalOnly) {
  const key = `${map.uuid}|${tier}|${metalOnly ? 'm' : 'a'}`;
  if (skinCache.has(key)) return skinCache.get(key);
  const img = map.image;
  const W = img.width, H = img.height;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, W, H);
  const d = data.data;
  const gold = tier === 1;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 8) continue;
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const sat = mx === 0 ? 0 : (mx - mn) / mx;
    // metal = a fairly unsaturated, not-too-dark swatch
    if (metalOnly && !(sat < 0.22 && mx > 55)) continue;
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    if (gold) {
      // bright, saturated gold (kept light — a dark map + metalness
      // reads brown, so the colour itself carries the shine)
      d[i] = clamp255(lum * 150 + 100);
      d[i + 1] = clamp255(lum * 130 + 78);
      d[i + 2] = clamp255(lum * 45 + 8);
    } else {
      d[i] = clamp255(lum * 120 + 25);
      d[i + 1] = clamp255(lum * 205 + 60);
      d[i + 2] = clamp255(lum * 205 + 95);
    }
  }
  ctx.putImageData(data, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.flipY = map.flipY;
  tex.colorSpace = map.colorSpace;
  tex.wrapS = map.wrapS; tex.wrapT = map.wrapT;
  tex.magFilter = map.magFilter; tex.minFilter = map.minFilter;
  tex.needsUpdate = true;
  skinCache.set(key, tex);
  return tex;
}

// paint the gold/crystal finish onto a built weapon holder per its mode
export function applyTierFinish(holder, tier, mode = 'metal') {
  if (!tier) return;
  const gold = tier === 1;
  const accent = new THREE.Color(gold ? 0xffb000 : 0x8fe0ff);
  const emiss = new THREE.Color(gold ? 0x5a3c00 : 0x1f7fa0);

  if (mode === 'crystal') {
    // mage staff / wand — repaint only the gem, keep it solid (this is
    // what used to break: the crystal turning translucent & invisible)
    holder.traverse((o) => {
      if (!o.isMesh || !o.material || !o.userData.isCrystal) return;
      o.material = o.material.clone();
      o.material.transparent = false; o.material.opacity = 1;
      o.material.color.set(gold ? 0xffcf3a : 0xbdefff);
      if (o.material.emissive) {
        o.material.emissive.set(gold ? 0xc98a00 : 0x39b6e0);
        o.material.emissiveIntensity = gold ? 0.6 : 0.95;
      }
    });
    return;
  }

  if (mode === 'orb') {
    // procedural orb — tint the core (solid) and recolour the halo/motes
    // WITHOUT touching their additive/transparent blend (that was the bug)
    holder.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      o.material = o.material.clone();
      if (o.userData.orbCore) {
        o.material.color.set(gold ? 0xffd66a : 0xcdf3ff);
        if (o.material.emissive) {
          o.material.emissive.set(gold ? 0xc98a00 : 0x39b6e0);
          o.material.emissiveIntensity = 1;
        }
      } else {
        o.material.color.set(gold ? 0xffc21a : 0x8fe0ff); // halo/motes only
      }
    });
    return;
  }

  // metal / all — recolour the atlas texture (metal-only for melee)
  const metalOnly = mode === 'metal';
  holder.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    o.material = o.material.clone();
    if (o.material.map && o.material.map.image) {
      o.material.map = tintTexture(o.material.map, tier, metalOnly);
      o.material.color.set(0xffffff);            // let the texture show true
      o.material.needsUpdate = true;
      // keep metalness LOW — without an env map a metallic surface just
      // renders dark (that's what made the gold read brown); a faint
      // emissive gives the shine instead. Non-metal (wood) pixels were
      // left untouched in the texture, so the glow tinting them slightly
      // is negligible.
      if ('metalness' in o.material) {
        o.material.metalness = 0.15;
        o.material.roughness = gold ? 0.45 : 0.3;
        o.material.emissive.set(gold ? 0x3a2600 : 0x0f3a48);
        o.material.emissiveIntensity = gold ? 0.35 : 0.45;
      }
    } else {
      // procedural fallback (no texture) — flat tint
      o.material.color.lerp(accent, 0.7);
      if (o.material.emissive) { o.material.emissive.copy(emiss); o.material.emissiveIntensity = 0.4; }
    }
  });
}

// back quiver with a couple of arrows peeking out
export function makeQuiver() {
  const g = new THREE.Group();
  const leather = new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: 1, flatShading: true });
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.038, 0.24, 7), leather);
  g.add(tube);
  const rim = new THREE.Mesh(
    new THREE.CylinderGeometry(0.049, 0.049, 0.03, 7),
    new THREE.MeshStandardMaterial({ color: 0x7a5433, roughness: 1, flatShading: true })
  );
  rim.position.y = 0.105;
  g.add(rim);
  for (const [dx, dz, tilt] of [[-0.014, 0, 0.09], [0.016, 0.008, -0.06]]) {
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.006, 0.006, 0.2, 4),
      new THREE.MeshStandardMaterial({ color: 0xcfa76a, roughness: 1 })
    );
    shaft.position.set(dx, 0.16, dz);
    shaft.rotation.z = tilt;
    g.add(shaft);
    const flet = new THREE.Mesh(
      new THREE.ConeGeometry(0.016, 0.045, 4),
      new THREE.MeshStandardMaterial({ color: 0xd85a4a, roughness: 1, flatShading: true })
    );
    flet.position.set(dx * 1.6, 0.245, dz);
    g.add(flet);
  }
  return g;
}

// Build the holder for one prop spec: the model (generator or key), an
// optional staff crystal tip, and its gold/crystal upgrade finish.
// Shared by the in-game actors, the creation preview and the offscreen
// preview-image renderer so all three look identical.
function buildProp(spec) {
  const holder = new THREE.Group();
  holder.add(spec.gen ? spec.gen() : instantiate(spec.key, { shadows: false }).group);
  if (spec.crystalTip) {
    // glowing crystal nestled in the staff's hook (values dialed in
    // with a dev overlay while tuning weapon placement)
    const tip = instantiate('prop-crystal', { shadows: false, cloneMaterials: true }).group;
    tip.scale.setScalar(0.45);
    tip.position.set(0, 0.055, -0.005);
    tip.rotation.set(-3.15, 0.29, 0.05);
    tip.traverse((o) => {
      if (o.isMesh && o.material.emissive) {
        o.material.emissive.set(spec.crystalTip);
        o.material.emissiveIntensity = 0.7;
        o.userData.isCrystal = true; // tier finish repaints only the gem
      }
    });
    holder.add(tip);
  }
  // upgraded weapons wear their gold/crystal finish
  applyTierFinish(holder, spec.tier || 0, spec.tierMode);
  return holder;
}

// a fully-built, tier-finished weapon model at the origin (no bone
// placement) — for the offscreen preview-image renderer
export function buildWeaponPreview(id, tier = 0) {
  const base = WEAPON_PROPS[id];
  if (!base) return null;
  return buildProp({ ...base, tier });
}

// Parent hand props onto a character's bones. Shared by the in-game
// actors and the character-creation preview. Returns the holders so a
// live actor can strip them again when its loadout changes.
export function attachProps(group, specs) {
  const holders = [];
  for (const spec of specs || []) {
    const bone = group.getObjectByName(spec.bone);
    if (!bone) continue;
    const holder = buildProp(spec);
    // raw props: bone space == raw model units, and the bone already
    // carries the character's scale, so placement is direct
    holder.scale.setScalar(spec.scale || 1);
    holder.position.set(spec.pos[0], spec.pos[1], spec.pos[2]);
    holder.rotation.set(spec.rot[0], spec.rot[1], spec.rot[2]);
    bone.add(holder);
    holders.push(holder);
  }
  return holders;
}

// world-space head height of a built actor group, so HP bars / name
// labels / crowns can sit right on top whatever the model's size
function modelTop(group) {
  group.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(group);
  return Number.isFinite(box.max.y) ? box.max.y : 1.4;
}

const CLASS_TINT = {
  berserker: 0xff6a4d, tanker: 0x6a9cff, archer: 0x7de87d, mage: 0xc07dff,
};

// checkpoint bosses carry their name over their head
const BOSS_BY_KIND = {};
for (const b of Object.values(BOSSES)) BOSS_BY_KIND[b.kind] = b;

// graveyard-kit props are authored in the same mini scale as the
// character hand props, so they attach straight onto the bones
const ENEMY_PROPS = {
  // the gravedigger grips his shovel exactly like the berserker holds his
  // axe (same bone-relative pos/rot); he's just scaled up as a whole, so
  // the relative placement carries straight over
  keeper: [{ gen: makeShovel, ...MOUNTS.axe, scale: 0.9 }],
  // skeleton archers hold the bow & quiver identically to the player archer
  archer: CLASS_PROPS.archer,
  // Zé do Caixão hauls his own coffin on his back
  coffin: [{ key: 'prop-coffin', bone: 'torso', pos: [0, -0.18, -0.16], rot: [-Math.PI / 2, 0, 0.12], scale: 0.7 }],
  // Brutus marches in behind a great shield with a great axe raised
  brutus: [
    { ...WEAPON_PROPS.greataxe, tier: 0 },
    { ...WEAPON_PROPS.greatshield, tier: 0 },
  ],
};

// tower base color per upgrade level: grey→blue→green→red→purple→gold
const TOWER_LEVEL_COLORS = [0x9aa1ab, 0x4a86e8, 0x3fbf5f, 0xe0503a, 0x9a4ae0, 0xe8b84b];
const TOWERS_MAX_VISUAL = 6;

// A bought special recolors ONE telling detail of the turret model —
// never a full-body filter. The Kenney models keep their sub-parts as
// named nodes, so: the crystal tower's crystals turn blue (ice) or
// yellow (storm), the ballista's loaded arrow gets the gold/cyan
// finish, the cannon's barrel glows ember, the catapult's throwing arm
// goes iron. The flamethrower model is a single mesh, so venom hangs a
// small green gem off the roof instead.
const SPEC_DETAILS = {
  ice: { color: 0x3f9fff, prefix: 'crystal' },
  storm: { color: 0xffd224, prefix: 'crystal' },
  triple: { color: 0xffc41f, prefix: 'arrow' },
  pierce: { color: 0x4adfff, prefix: 'arrow' },
  napalm: { color: 0xff6a22, prefix: 'barrel' },
  scatter: { color: 0x6f7884, prefix: 'catapult' },
  venom: { color: 0x39d824, gem: true },
};

function paintSpecDetail(weapon, spec) {
  const d = SPEC_DETAILS[spec];
  if (!d) return;
  if (d.prefix) {
    weapon.traverse((o) => {
      if (o.isMesh && o.material && o.name.startsWith(d.prefix)) {
        // drop the colormap on this part: a clean solid color reads as
        // "the detail changed", not a filter (yellow × blue tex = mud)
        o.material.map = null;
        o.material.color.set(d.color);
        if (o.material.emissive) {
          o.material.emissive.set(d.color);
          o.material.emissiveIntensity = 0.3;
        }
        o.material.needsUpdate = true;
      }
    });
  }
  if (d.gem) {
    const gem = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.16),
      new THREE.MeshStandardMaterial({
        color: d.color, emissive: d.color, emissiveIntensity: 0.7,
        roughness: 0.4, flatShading: true,
      })
    );
    // the flame tower model is normalized to ~1.25 units tall
    gem.position.y = 1.45;
    weapon.add(gem);
  }
}

// the two sanctuary vendors live in the plaza's far corners now (see
// sanctuary.js for the whole layout). main.js checks the local hero's
// distance to unlock each shop, and projects these to screen to pin
// the shop button under the vendor. Tonho (pets) right, Baru left.
export const PET_SHOP_POS = { x: NPCS.pets.x, z: NPCS.pets.z };
export const PET_SHOP_RADIUS = 3.2;
export const WEAPON_SHOP_POS = { x: NPCS.weapons.x, z: NPCS.weapons.z };
export const WEAPON_SHOP_RADIUS = 3.2;

export class GameView {
  constructor(gameScene) {
    this.gs = gameScene;
    this.scene = gameScene.scene;
    this.players = new Map();   // id -> actor
    this.pets = new Map();      // ownerId -> companion pet trotting at their heels
    this.enemies = new Map();
    this.towers = new Map();
    this.obstacles = new Map();
    this.graves = new Map();    // gravedigger tombs, id -> {group, riseT}
    this.cosmetics = new Map(); // id -> { cls, colors } custom part colours
    this.projectiles = [];
    this.effects = [];
    this.corpses = [];
    this.ghost = null;          // build-mode ghost preview
    this.time = 0;

    this._ringGeo = new THREE.RingGeometry(0.85, 1, 40);
    this._discGeo = new THREE.CircleGeometry(1, 32);

    // shared materials for the enemy status overlays (chill ring,
    // embers, poison bubbles, stun stars) — one of each, ever
    this._statusMats = {
      slow: new THREE.MeshBasicMaterial({
        color: 0x66c8ff, transparent: true, opacity: 0.75,
        depthWrite: false, side: THREE.DoubleSide,
      }),
      burn: new THREE.SpriteMaterial({ color: 0xff8a2a, transparent: true, opacity: 0.9, depthWrite: false }),
      poison: new THREE.SpriteMaterial({ color: 0x62e84a, transparent: true, opacity: 0.85, depthWrite: false }),
      stun: new THREE.SpriteMaterial({ color: 0xffe066, transparent: true, opacity: 0.95, depthWrite: false }),
    };

    // wall-mode aura resources, built ONCE and shared by every tanker.
    // A fresh MeshStandardMaterial used to be created on each activation,
    // and compiling its shader program the first frame it rendered stalled
    // the scene ("travada"). Sharing keeps allocations at zero and lets us
    // pre-warm the shader below so the very first activation is smooth too.
    this._wallSlabGeo = new THREE.BoxGeometry(0.34, 0.52, 0.12);
    this._wallStoneMat = new THREE.MeshStandardMaterial({
      color: 0x9aa1ab, roughness: 0.9, flatShading: true,
      transparent: true, opacity: 0.9,
    });
    this._wallRingMat = new THREE.MeshBasicMaterial({
      color: 0xbfc8d4, transparent: true, opacity: 0.55,
      depthWrite: false, side: THREE.DoubleSide,
    });

    // XP (green) / point (blue) orbs — two instanced meshes with flat
    // materials keep hundreds of orbs at a single draw call each.
    // Only the local player's own orbs are ever rendered.
    this.dropCap = 160;
    const mkOrbs = (geo, color) => {
      const mesh = new THREE.InstancedMesh(
        geo, new THREE.MeshBasicMaterial({ color }), this.dropCap
      );
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.scene.add(mesh);
      return mesh;
    };
    this.xpOrbs = mkOrbs(new THREE.OctahedronGeometry(0.17), 0x5dff7a);
    // point orbs read as crystal shards now (fragments off slain foes)
    this.ptsOrbs = mkOrbs(new THREE.OctahedronGeometry(0.17), 0x66e0ff);
    // gold coins use the real mini-dungeon coin mesh, instanced like the
    // orbs (only ever a handful on the ground). They're special pickups,
    // so they render bigger and glow — the material is cloned off the
    // shared coin so boosting its emissive doesn't light the shop props.
    {
      const t = instantiate('dungeon-coin', { shadows: false });
      t.group.updateMatrixWorld(true);
      let geo = null, mat = null;
      t.group.traverse((o) => {
        if (o.isMesh && !geo) {
          geo = o.geometry.clone();
          geo.applyMatrix4(o.matrixWorld);
          mat = o.material;
        }
      });
      const gmat = mat.clone();
      if (gmat.emissive) { gmat.emissive.set(0xffb020); gmat.emissiveIntensity = 0.75; }
      gmat.toneMapped = false;
      this.goldOrbs = new THREE.InstancedMesh(geo, gmat, this.dropCap);
      this.goldOrbs.count = 0;
      this.goldOrbs.frustumCulled = false;
      this.goldOrbs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.scene.add(this.goldOrbs);
      this.goldMat = gmat;
      // a handful of little golden dots orbit each live coin — a light,
      // round sparkle (no flat billboard) so these special pickups pop
      this.goldDots = 4;
      this.goldSparkle = new THREE.InstancedMesh(
        new THREE.SphereGeometry(0.05, 8, 8),
        new THREE.MeshBasicMaterial({ color: 0xffe89a, toneMapped: false }),
        this.dropCap * this.goldDots
      );
      this.goldSparkle.count = 0;
      this.goldSparkle.frustumCulled = false;
      this.goldSparkle.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.scene.add(this.goldSparkle);
    }
    this.npcs = [];
    this.showPets = []; // the vendor's display critters goofing around
    // everything living on the sanctuary floor registers here so it can
    // be hidden (and its updates skipped) while a wave rages — the
    // sanctuary is far off-camera then, no need to render or animate it
    this.sanctNodes = [];
    this.sanctActive = true;
    this.spawnNpcs();
    this.spawnPetShop();
    this.spawnWeaponShop();
    this._orbMat = new THREE.Matrix4();
    this._orbPos = new THREE.Vector3();
    this._orbQuat = new THREE.Quaternion();
    this._orbEuler = new THREE.Euler();
    this._orbScale = new THREE.Vector3(1, 1, 1);
    this._orbScaleGold = new THREE.Vector3(1.7, 1.7, 1.7);
    this._dotMat = new THREE.Matrix4();
    this._dotPos = new THREE.Vector3();
    this._dotScale = new THREE.Vector3(1, 1, 1);
    this._identQuat = new THREE.Quaternion();

    this._prewarmShaders();
  }

  // Compile the shared aura shaders now, during load, so no in-combat
  // activation ever stalls the frame compiling them. renderer.compile()
  // builds the GL programs for everything currently in the scene without
  // drawing; the throwaway aura keeps the wall-mode materials referenced
  // long enough to be compiled, then we drop it (the materials — and thus
  // their cached programs — live on for the real auras to reuse).
  _prewarmShaders() {
    const r = this.gs?.renderer, cam = this.gs?.camera;
    if (!r || !cam) return;
    const warm = new THREE.Group();
    warm.add(new THREE.Mesh(this._wallSlabGeo, this._wallStoneMat));
    warm.add(new THREE.Mesh(this._ringGeo, this._wallRingMat));
    warm.position.set(0, -999, 0);
    this.scene.add(warm);
    try { r.compile(this.scene, cam); } catch { /* pre-warm is best-effort */ }
    this.scene.remove(warm);
  }

  // ---------------- actors ----------------

  makeAnimated(modelKey) {
    const inst = instantiate(modelKey, { cloneMaterials: true });
    const group = inst.group;
    const mixer = new THREE.AnimationMixer(group);
    const actions = {};
    for (const clip of inst.animations) actions[clip.name] = mixer.clipAction(clip);
    const mats = [];
    group.traverse((o) => {
      if ((o.isMesh || o.isSkinnedMesh) && o.material) mats.push(o.material);
    });
    const actor = {
      group, mixer, actions, mats, factor: inst.factor,
      current: null, currentName: null, oneShot: null, flashT: 0,
    };
    mixer.addEventListener('finished', () => {
      if (actor.oneShot) {
        actor.oneShot.fadeOut(0.12);
        actor.oneShot = null;
        if (actor.current) actor.current.reset().fadeIn(0.12).play();
      }
    });
    return actor;
  }

  setLoco(actor, name, timeScale = 1) {
    const a = actor.actions[name] || actor.actions.idle;
    if (!a) return;
    if (actor.currentName === name) { if (actor.current) actor.current.timeScale = timeScale; return; }
    if (actor.current && !actor.oneShot) actor.current.fadeOut(0.18);
    actor.current = a;
    actor.currentName = name;
    a.timeScale = timeScale;
    if (!actor.oneShot) a.reset().fadeIn(0.18).play();
  }

  playOnce(actor, name, fitDuration = 0) {
    const a = actor.actions[name] || actor.actions['attack-melee-right'];
    if (!a || actor.oneShot === a) return;
    if (actor.oneShot) actor.oneShot.stop();
    else if (actor.current) actor.current.fadeOut(0.06);
    actor.oneShot = a;
    a.reset();
    a.setLoop(THREE.LoopOnce, 1);
    const dur = a.getClip().duration;
    a.timeScale = fitDuration > 0 ? Math.max(dur / fitDuration, 1) : 1.2;
    a.fadeIn(0.06).play();
  }

  makeHpBar(width = 1.0, y = 1.6) {
    const g = new THREE.Group();
    const bg = new THREE.Mesh(
      new THREE.PlaneGeometry(width, 0.13),
      new THREE.MeshBasicMaterial({ color: 0x25101a, transparent: true, opacity: 0.85, depthWrite: false })
    );
    const fg = new THREE.Mesh(
      new THREE.PlaneGeometry(width, 0.13),
      new THREE.MeshBasicMaterial({ color: 0x58d858, transparent: true, opacity: 0.95, depthWrite: false })
    );
    fg.position.z = 0.001;
    g.add(bg, fg);
    g.position.y = y;
    g.userData = { fg, width };
    g.renderOrder = 10;
    return g;
  }

  setHpBar(bar, frac, color) {
    frac = Math.max(Math.min(frac, 1), 0);
    const { fg, width } = bar.userData;
    fg.scale.x = Math.max(frac, 0.001);
    fg.position.x = -width * (1 - frac) / 2;
    if (color) fg.material.color.set(color);
    else fg.material.color.setHSL(lerp(0, 0.33, frac), 0.75, 0.5);
  }

  // auto-sized speech bubble for longer NPC lines (the fixed-canvas
  // makeTextSprite would clip them) — width follows the text
  makeBubbleSprite(text) {
    const ss = 2, H = 64, pad = 18;
    const font = 'bold 36px "Trebuchet MS", sans-serif';
    const meas = document.createElement('canvas').getContext('2d');
    meas.font = font;
    const W = Math.max(120, Math.ceil(meas.measureText(text).width) + pad * 2);
    const canvas = document.createElement('canvas');
    canvas.width = W * ss; canvas.height = H * ss;
    const ctx = canvas.getContext('2d');
    ctx.scale(ss, ss);
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 7;
    ctx.strokeStyle = 'rgba(0,0,0,0.78)';
    ctx.strokeText(text, W / 2, H / 2);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, W / 2, H / 2);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false }));
    const worldW = W * 0.0065;
    spr.scale.set(worldW, worldW * H / W, 1);
    spr.renderOrder = 11;
    return spr;
  }

  makeTextSprite(text, tint, width = 3.1) {
    const canvas = document.createElement('canvas');
    canvas.width = 384; canvas.height = 84;
    const ctx = canvas.getContext('2d');
    ctx.font = 'bold 52px "Trebuchet MS", sans-serif';
    ctx.textAlign = 'center';
    ctx.lineWidth = 8;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.strokeText(text, 192, 60);
    ctx.fillStyle = '#' + new THREE.Color(tint).getHexString();
    ctx.fillText(text, 192, 60);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false }));
    spr.scale.set(width, width * 0.22, 1);
    spr.renderOrder = 11;
    return spr;
  }

  // overhead label for OTHER players: a class-tinted badge (glyph) on
  // the left, the hero name, then a separate gold level pill — so the
  // level never runs into the name and long numbers can't clip.
  makePlayerLabel(name, lvl, cls, tint) {
    const ss = 2;                       // supersample for crisp text
    const H = 76, pad = 10, badge = 58, gap = 12;
    const nameFont = 'bold 46px "Trebuchet MS", sans-serif';
    const lvlFont = 'bold 32px "Trebuchet MS", sans-serif';
    const meas = document.createElement('canvas').getContext('2d');
    meas.font = nameFont;
    const nameW = Math.ceil(meas.measureText(name || '').width);
    const lvlText = `Lv ${lvl}`;
    meas.font = lvlFont;
    const lvlPad = 14;
    const pillW = Math.ceil(meas.measureText(lvlText).width) + lvlPad * 2;
    const W = pad + badge + gap + nameW + gap + pillW + pad;

    const canvas = document.createElement('canvas');
    canvas.width = W * ss; canvas.height = H * ss;
    const ctx = canvas.getContext('2d');
    ctx.scale(ss, ss);

    const rgb = new THREE.Color(tint);
    const rgbCss = `${(rgb.r * 255) | 0}, ${(rgb.g * 255) | 0}, ${(rgb.b * 255) | 0}`;

    // class badge
    const by = (H - badge) / 2;
    roundRect(ctx, pad, by, badge, badge, 15);
    ctx.fillStyle = `rgba(${rgbCss}, 0.92)`;
    ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)'; ctx.stroke();
    drawClassGlyph(ctx, cls, pad + badge * 0.17, by + badge * 0.17, badge * 0.66, '#ffffff');

    // name
    ctx.font = nameFont;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const nameX = pad + badge + gap;
    ctx.lineWidth = 7; ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
    ctx.strokeText(name || '', nameX, H / 2);
    ctx.fillStyle = '#' + rgb.getHexString();
    ctx.fillText(name || '', nameX, H / 2);

    // separate level pill
    const pillH = 42, pillX = nameX + nameW + gap, pillY = (H - pillH) / 2;
    roundRect(ctx, pillX, pillY, pillW, pillH, pillH / 2);
    ctx.fillStyle = 'rgba(232, 184, 75, 0.96)';
    ctx.fill();
    ctx.font = lvlFont;
    ctx.fillStyle = '#2a1f08';
    ctx.fillText(lvlText, pillX + lvlPad, H / 2 + 1);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false }));
    const worldW = W * 0.0085;
    spr.scale.set(worldW, worldW * H / W, 1);
    spr.renderOrder = 11;
    return spr;
  }

  ensurePlayer(row, selfId) {
    const id = row[PL.ID];
    let a = this.players.get(id);
    if (a) return a;
    const cls = row[PL.CLS];
    const isSelf = id === selfId;
    a = this.makeAnimated(CLASSES[cls]?.model || 'char-berserker');
    a.cls = cls;
    // anchor the bar/label just above THIS model's head (heights now
    // vary a little between classes, so a fixed offset would float)
    const top = modelTop(a.group);
    this.syncLoadoutProps(a, row);
    const cos = this.cosmetics.get(id);
    if (cos) this.applyCosmetic(a, cls, cos.colors);

    const tint = CLASS_TINT[cls] || 0xffffff;
    // class-colored ring under the character
    const ring = new THREE.Mesh(
      this._ringGeo,
      new THREE.MeshBasicMaterial({ color: tint, transparent: true, opacity: 0.5, depthWrite: false })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    ring.scale.setScalar(0.5);
    a.group.add(ring);

    a.labelTop = top;
    a.isSelf = isSelf;
    a.tint = tint;
    // HP bar for everyone, but only shown once someone is hurt
    a.hpBar = this.makeHpBar(1.0, top + 0.3);
    a.hpBar.visible = false;
    a.group.add(a.hpBar);
    // name / level / class badge float over OTHER players only — you
    // read your own stats from the HUD, not over your own head
    if (!isSelf) {
      a.label = this.makePlayerLabel(row[PL.NAME], row[PL.LVL], cls, tint);
      a.label.position.y = top + 0.72;
      a.labelLvl = row[PL.LVL];
      a.labelName = row[PL.NAME];
      a.group.add(a.label);
    }

    // arriving through the sanctuary portal. While an arrival is armed
    // (the intro is playing) the hero stays hidden until the timer fires
    // so the whole flare-open + step-out reads AFTER the scene appears;
    // otherwise (a late checkpoint join) it plays right away.
    if (Math.hypot(row[PL.X] - PORTAL.x, row[PL.Z] - PORTAL.z) < 3.5) {
      if (this.arrivalArmed) {
        a.arrivalPending = true;
        a.group.visible = false;
      } else {
        this.spawnPortalFx();
        a.spawnT = -0.22; // let the portal open a touch before the pop-in
        a.group.scale.setScalar(0.01);
      }
    }

    this.scene.add(a.group);
    this.players.set(id, a);
    this.setLoco(a, 'idle');
    return a;
  }

  // thin wrapper so existing callers using an actor still work
  attachProps(actor, specs) { attachProps(actor.group, specs); }

  // keep a player's hand props in sync with the equipped weapon/shield
  // (+ their gold/crystal tiers) carried in the snapshot row
  syncLoadoutProps(a, row) {
    const key = `${row[PL.WPN]}|${row[PL.WPNT]}|${row[PL.SHD]}|${row[PL.SHDT]}`;
    if (a.loadoutKey === key) return;
    a.loadoutKey = key;
    for (const h of a.propHolders || []) h.parent?.remove(h);
    a.propHolders = attachProps(a.group, loadoutProps(
      a.cls,
      row[PL.WPN] ? { id: row[PL.WPN], tier: row[PL.WPNT] } : null,
      row[PL.SHD] ? { id: row[PL.SHD], tier: row[PL.SHDT] } : null
    ));
  }

  // ---------------- companion pets ----------------

  // keep each player's companion actor in sync with the snapshot: the
  // right animal, wearing the right name/level label. Movement is pure
  // presentation and happens per-frame in updatePets.
  syncPet(ownerId, petId, petName, petLvl) {
    let pet = this.pets.get(ownerId);
    if (!petId || !PETS[petId]) {
      if (pet) this.removePet(ownerId);
      return;
    }
    if (pet && pet.petId !== petId) { this.removePet(ownerId); pet = null; }
    if (!pet) {
      const actor = this.makeAnimated(PETS[petId].model);
      const owner = this.players.get(ownerId);
      if (owner) {
        actor.group.position.copy(owner.group.position);
        actor.group.rotation.y = owner.group.rotation.y;
      }
      actor.labelTop = modelTop(actor.group);
      this.scene.add(actor.group);
      this.setLoco(actor, 'idle');
      pet = { actor, petId, name: null, lvl: null, smSpeed: 0 };
      this.pets.set(ownerId, pet);
    }
    if (pet.name !== petName || pet.lvl !== petLvl) {
      if (pet.label) {
        pet.actor.group.remove(pet.label);
        pet.label.material.map.dispose();
      }
      pet.label = this.makeTextSprite(`${petName || PETS[petId].name} · ${petLvl}`, 0xffd8a0, 1.9);
      pet.label.position.y = pet.actor.labelTop + 0.35;
      pet.actor.group.add(pet.label);
      pet.name = petName;
      pet.lvl = petLvl;
    }
  }

  removePet(ownerId) {
    const pet = this.pets.get(ownerId);
    if (!pet) return;
    if (pet.label) pet.label.material.map.dispose();
    this.scene.remove(pet.actor.group);
    this.pets.delete(ownerId);
  }

  // trot each companion to a heel spot behind its owner, choosing
  // idle/walk/run (and their pace) from how hard it has to hustle
  updatePets(dt) {
    for (const [ownerId, pet] of this.pets) {
      const owner = this.players.get(ownerId);
      if (!owner) { this.removePet(ownerId); continue; }
      pet.actor.mixer.update(dt);
      const og = owner.group;
      pet.actor.group.visible = og.visible;
      if (!og.visible) continue; // owner down — pet waits out of sight
      const yaw = og.rotation.y;
      // heel position: behind and a bit to the owner's left
      const side = yaw + Math.PI / 2;
      const tx = og.position.x - Math.sin(yaw) * 0.8 - Math.sin(side) * 0.5;
      const tz = og.position.z - Math.cos(yaw) * 0.8 - Math.cos(side) * 0.5;
      const g = pet.actor.group;
      let dx = tx - g.position.x, dz = tz - g.position.z;
      let dist = Math.hypot(dx, dz);
      if (dist > 7) {
        // fell hopelessly behind (respawn/teleport) — pop over
        g.position.set(tx, 0, tz);
        dx = dz = dist = 0;
      }
      let spd = 0;
      if (dist > 0.06) {
        // spring chase: the farther behind, the harder it runs
        spd = Math.min(1.5 + dist * 4, 10);
        const step = Math.min(spd * dt, dist);
        g.position.x += (dx / dist) * step;
        g.position.z += (dz / dist) * step;
      }
      pet.smSpeed = lerp(pet.smSpeed, spd, Math.min(dt * 7, 1));
      // while airborne keep the legs churning (run) so it reads as a leap,
      // otherwise fall back to the ground gaits
      if (pet.jumpT != null && pet.jumpT > 0) this.setLoco(pet.actor, 'run', 1.3);
      else if (pet.smSpeed > 3.4) this.setLoco(pet.actor, 'run', 0.9 + pet.smSpeed * 0.06);
      else if (pet.smSpeed > 0.4) this.setLoco(pet.actor, 'walk', 1.1);
      else this.setLoco(pet.actor, 'idle', 1);
      const wantYaw = dist > 0.06 && pet.smSpeed > 0.4 ? Math.atan2(dx, dz) : yaw;
      g.rotation.y = angleLerp(g.rotation.y, wantYaw, Math.min(dt * 8, 1));

      // hop along whenever the hero vaults an obstacle. The cube pets have
      // no jump clip (idle/walk/run/eat/…), so the leap is procedural: a
      // sine arc with a playful forward tuck, kicked off the frame the hero
      // leaves the ground — a hair later so the pet reads as following over.
      const ownerJumping = owner.jumpT != null;
      if (ownerJumping && !pet.ownerJumping) {
        pet.jumpDur = owner.jumpDur || JUMP.DUR;
        pet.jumpT = -0.08 * (pet.jumpDur / JUMP.DUR); // brief lag behind the hero
        pet.jumpH = (owner.jumpH || JUMP.HEIGHT) * 0.8; // smaller critter, smaller hop
        if (pet.actor.actions.jump) this.playOnce(pet.actor, 'jump', pet.jumpDur);
      }
      pet.ownerJumping = ownerJumping;

      // the companion walks the same terrain as its owner (plateau,
      // stairs, sanctuary floor); the leap arc rides on top of it
      const baseY = terrainY(g.position.z);
      if (pet.jumpT != null) {
        pet.jumpT += dt;
        if (pet.jumpT <= 0) {
          g.position.y = baseY; // still crouched, waiting out the lag
        } else {
          const k = Math.min(pet.jumpT / pet.jumpDur, 1);
          g.position.y = baseY + Math.sin(k * Math.PI) * pet.jumpH;
          g.rotation.x = -Math.sin(k * Math.PI) * 0.35; // nose-down tuck mid-air
          if (k >= 1) { pet.jumpT = null; g.position.y = baseY; g.rotation.x = 0; }
        }
      } else {
        g.position.y = baseY;
      }
    }
  }

  // Remember each player's custom part colours (from the lobby roster)
  // and (re)paint any actor already on screen.
  setCosmetics(list) {
    for (const p of list || []) {
      if (!p || !p.id) continue;
      const colors = p.colors || {};
      const key = p.cls + '|' + JSON.stringify(colors);
      const prev = this.cosmetics.get(p.id);
      if (prev && prev.key === key) continue;
      this.cosmetics.set(p.id, { cls: p.cls, colors, key });
      const a = this.players.get(p.id);
      if (a) this.applyCosmetic(a, p.cls, colors);
    }
  }

  applyCosmetic(actor, cls, colors) {
    const modelKey = CLASSES[cls]?.model;
    if (!modelKey) return;
    let tex = null;
    try { tex = buildTexture(modelKey, colors); } catch { tex = null; }
    applyTexture(actor.group, modelKey, tex);
    if (actor.customTex && actor.customTex !== tex) actor.customTex.dispose();
    actor.customTex = tex;
  }

  // a live, attackable training dummy (sim-side enemy) — looks exactly
  // like the static yard props it temporarily replaces
  makeDummyActor(x, z) {
    const group = this.makeDummyMesh();
    // face the training hero, same as the static yard props
    const focus = { x: NPCS.treino.x - 2.4, z: NPCS.treino.z + 1.2 };
    group.rotation.y = Math.atan2(focus.x - x, focus.z - z);
    const mixer = new THREE.AnimationMixer(group); // no clips — API compat
    const mats = [];
    group.traverse((o) => {
      if (o.isMesh && o.material) { o.material = o.material.clone(); mats.push(o.material); }
    });
    return {
      group, mixer, actions: {}, mats, factor: 1,
      current: null, currentName: null, oneShot: null, flashT: 0,
    };
  }

  ensureEnemy(row) {
    const id = row[EN.ID];
    let a = this.enemies.get(id);
    if (a) return a;
    const kind = row[EN.KIND];
    if (kind === 'dummy') {
      a = this.makeDummyActor(row[EN.X], row[EN.Z]);
      a.kind = kind;
      a.hpBar = this.makeHpBar(0.85, 1.75);
      a.hpBar.visible = false;
      a.group.add(a.hpBar);
      a.statusMask = 0;
      a.statusFx = {};
      a.topLocal = 1.75;
      a.fade = 1;
      this.scene.add(a.group);
      this.enemies.set(id, a);
      return a;
    }
    const def = ENEMIES[kind] || {};
    const isBoss = row[EN.BOSS] === 2;
    a = this.makeAnimated(def.model || `enemy-${kind}`);
    a.kind = kind;
    const scale = row[EN.SCALE] || 1;
    a.group.scale.setScalar(scale);
    // measure the head height now (after scale) so overhead bits sit
    // right on top no matter the model's size
    const top = modelTop(a.group);
    a.isGhost = !!def.flying;
    a.isArcher = !!def.archer;
    if (a.isGhost) {
      for (const m of a.mats) { m.transparent = true; m.opacity = 0.8; }
    }
    if (a.isArcher) this.attachProps(a, ENEMY_PROPS.archer);
    if (kind === 'keeper') this.attachProps(a, ENEMY_PROPS.keeper);
    if (kind === 'vampire' && isBoss) this.attachProps(a, ENEMY_PROPS.coffin);
    const vr = row[EN.VR] || 0;
    if (vr === VR_BRUTUS) this.attachProps(a, ENEMY_PROPS.brutus);
    // stage-2/3 power looks: swap in the recolored hide — only the
    // matching atlas pixels (skin/bone/body) change, never the whole
    // model. Materials are per-actor clones, so this stays local.
    if (vr === VR_T2 || vr === VR_T3) {
      const tex = tierTexture(def.model || `enemy-${kind}`, kind, vr - 1);
      if (tex) {
        for (const m of a.mats) {
          if ('map' in m && m.map) { m.map = tex; m.needsUpdate = true; }
        }
      }
    }
    // a hundred-zombie horde would melt the shadow pass — past a crowd
    // threshold, newcomers stop casting shadows
    if (this.enemies.size > 26) {
      a.group.traverse((o) => { if (o.isMesh || o.isSkinnedMesh) o.castShadow = false; });
    }
    if (row[EN.BOSS] > 0) {
      const crown = new THREE.Mesh(
        new THREE.ConeGeometry(0.16, 0.22, 5),
        new THREE.MeshStandardMaterial({
          color: isBoss ? 0xffd24a : 0xff7a4a,
          emissive: isBoss ? 0xaa7a00 : 0x882200, emissiveIntensity: 0.8,
        })
      );
      crown.position.y = (top + 0.2) / scale; // constant world margin
      a.group.add(crown);
    }
    if (isBoss) {
      // the boss announces itself: name floating over its head
      const bossLabel = bossNameByKind(kind);
      const label = this.makeTextSprite(bossLabel.toUpperCase(), 0xffd24a, 2.1);
      label.position.y = (top + 0.62) / scale;
      a.group.add(label);
    }
    a.hpBar = this.makeHpBar(row[EN.BOSS] ? 1.3 : 0.85, (top + 0.25) / scale);
    a.hpBar.visible = false;
    a.group.add(a.hpBar);
    a.statusMask = 0;
    a.statusFx = {};
    a.topLocal = (top + 0.35) / scale;
    this.scene.add(a.group);
    this.enemies.set(id, a);
    this.setLoco(a, 'walk');
    return a;
  }

  // ---------------- enemy status-effect overlays ----------------

  // one overlay per active status: chill ring (slow), rising embers
  // (burn), rising bubbles (poison), orbiting stars (stun). Driven by
  // the snapshot's status bitmask so every client shows the same state.
  setStatusFx(a, mask) {
    if (a.statusMask === mask) return;
    const defs = [
      [ST_SLOW, 'slow'], [ST_BURN, 'burn'], [ST_POISON, 'poison'], [ST_STUN, 'stun'],
    ];
    for (const [bit, key] of defs) {
      const on = (mask & bit) !== 0, had = !!a.statusFx[key];
      if (on && !had) a.statusFx[key] = this.makeStatusFx(a, key);
      else if (!on && had) { a.group.remove(a.statusFx[key]); delete a.statusFx[key]; }
    }
    a.statusMask = mask;
    // body glow: burn > poison > slow (the strongest tell wins)
    a.statusTint = (mask & ST_BURN) ? 0xff7a22
      : (mask & ST_POISON) ? 0x58d84a
      : (mask & ST_SLOW) ? 0x66c8ff : null;
  }

  makeStatusFx(a, key) {
    const g = new THREE.Group();
    g.userData.fx = key;
    if (key === 'slow') {
      const ring = new THREE.Mesh(this._ringGeo, this._statusMats.slow);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.06;
      ring.scale.setScalar(0.6);
      g.add(ring);
    } else {
      // floating particles: embers (burn), bubbles (poison), stars (stun)
      const mat = this._statusMats[key];
      const n = key === 'stun' ? 3 : 4;
      for (let i = 0; i < n; i++) {
        const spr = new THREE.Sprite(mat);
        spr.scale.setScalar(key === 'stun' ? 0.16 : 0.2);
        spr.userData.phase = Math.random();
        spr.userData.ang = (i / n) * Math.PI * 2;
        g.add(spr);
      }
      if (key === 'stun') g.position.y = a.topLocal || 1.5;
    }
    a.group.add(g);
    return g;
  }

  // per-frame animation for every live status overlay
  animateStatusFx(dt) {
    for (const a of this.enemies.values()) {
      if (!a.statusMask && !a.tintWas) continue;
      for (const [key, g] of Object.entries(a.statusFx)) {
        if (key === 'slow') {
          const ring = g.children[0];
          ring.rotation.z += dt * 2.2;
          const k = 0.55 + Math.sin(this.time * 5) * 0.1;
          ring.scale.setScalar(k);
        } else if (key === 'stun') {
          for (const spr of g.children) {
            const ang = spr.userData.ang + this.time * 4;
            spr.position.set(Math.cos(ang) * 0.34, 0.1 + Math.sin(this.time * 6) * 0.04, Math.sin(ang) * 0.34);
          }
        } else {
          // embers / bubbles loop upward and fade near the top
          for (const spr of g.children) {
            const k = (this.time * (key === 'burn' ? 0.9 : 0.55) + spr.userData.phase) % 1;
            spr.position.set(
              Math.sin((spr.userData.phase + k) * Math.PI * 4) * 0.18,
              0.25 + k * 1.0,
              Math.cos((spr.userData.phase + k) * Math.PI * 3) * 0.18
            );
            spr.material = this._statusMats[key];
            spr.scale.setScalar((key === 'burn' ? 0.24 : 0.18) * (1 - k * 0.6));
          }
        }
      }
      // steady tinted glow on the body while a status holds (the hit
      // flash overrides it briefly and this restores it right after)
      if (a.statusTint && (a.flashT || 0) <= 0) {
        for (const m of a.mats) {
          if (m.emissive) { m.emissive.set(a.statusTint); m.emissiveIntensity = 0.38; }
        }
      } else if (!a.statusTint && a.tintWas) {
        for (const m of a.mats) {
          if (m.emissive) { m.emissive.set(0x000000); m.emissiveIntensity = 1; }
        }
      }
      a.tintWas = !!a.statusTint;
    }
  }

  // ---------------- sanctuary NPCs ----------------

  // the sanctuary's dwellers: the four service NPCs around the fountain
  // (guide, cheerleader, cleric, drill master — positions & facing in
  // sanctuary.js, all turned roughly toward the portal so arriving
  // players read them front-on) plus two ambient strollers
  spawnNpcs() {
    const defs = [
      // Theo the guide
      { ...NPCS.duvidas, id: 'duvidas', model: 'char-male-e' },
      // Nina the cheerleader: the mini-market employee, green apron dyed
      // yellow — shouts a different encouragement every time you pass by
      { ...NPCS.incentivo, id: 'incentivo', model: 'char-employee', rotate: true,
        recolor: [{ match: 'green', to: 0xf2c33a }] },
      // Iris the cleric: white hair, blue robe & tiara
      { ...NPCS.blessings, id: 'blessings', model: 'char-mage',
        recolor: [
          { match: 'hair', to: 0xeef0f4 },
          { match: 'outfit', to: 0x3f6fd8 },
        ] },
      { ...NPCS.treino, id: 'treino', model: 'char-berserker', tint: 0xc86a5a },
      ...AMBIENT_NPCS,
    ];
    this.npcById = {};
    for (const d of defs) {
      const a = this.mkNpc(d);
      if (d.id) this.npcById[d.id] = a;
    }
    // a glowing crystal shard stands at Iris's side (chest-high, so it
    // reads clearly next to her)
    const iris = NPCS.blessings;
    const shard = instantiate('prop-crystal', { cloneMaterials: true }).group;
    shard.scale.setScalar(1.9);
    shard.position.set(iris.x + 0.95, terrainY(iris.z) + 0.15, iris.z + 0.35);
    shard.traverse((o) => {
      if (o.isMesh && o.material?.emissive) {
        o.material.emissive.set(0x39b6e0);
        o.material.emissiveIntensity = 0.85;
      }
    });
    this.scene.add(shard);
    this.sanctNodes.push(shard);
    const shardGlow = new THREE.PointLight(0x66c8e8, 4, 5, 2);
    shardGlow.position.set(iris.x + 0.95, terrainY(iris.z) + 1.0, iris.z + 0.35);
    this.scene.add(shardGlow);
    this.sanctNodes.push(shardGlow);

    this.buildTrainingDummies();
  }

  // recolor a mini-character's shared colormap atlas by hue rule (green
  // apron → yellow, mage hair → white, etc.), keeping per-pixel shading.
  // Rules run on a per-actor clone so nothing else wearing the atlas is
  // touched. Matchers: 'green' (apron/skin-green), 'hair' & 'outfit' use
  // the customize analyzer's real part cells for precise targeting.
  recolorNpc(actor, modelKey, rules) {
    // pixel-hue rules (e.g. the employee's green apron)
    const hueRules = rules.filter((r) => r.match === 'green');
    if (hueRules.length) {
      const tex = npcHueTexture(modelKey, hueRules);
      if (tex) applyTexture(actor.group, modelKey, tex);
    }
    // part-cell rules (hair / outfit) via the customization analyzer
    const partRules = rules.filter((r) => r.match === 'hair' || r.match === 'outfit');
    if (partRules.length) {
      const slots = getSlots(modelKey);
      const colors = {};
      for (const s of slots) {
        const lbl = s.label.toLowerCase();
        if (lbl.includes('skin')) continue;
        const hair = partRules.find((r) => r.match === 'hair');
        const outfit = partRules.find((r) => r.match === 'outfit');
        if (lbl.includes('hair') && hair) colors[s.id] = '#' + new THREE.Color(hair.to).getHexString();
        else if (outfit) colors[s.id] = '#' + new THREE.Color(outfit.to).getHexString();
      }
      const tex = buildTexture(modelKey, colors);
      if (tex) applyTexture(actor.group, modelKey, tex);
    }
  }

  // the drill master's target dummies: a wooden post with a crossbar
  // and a painted target board, standing in his little training yard
  buildTrainingDummies() {
    this.dummyProps = [];
    // face each dummy toward where a training hero would stand (just in
    // front of the drill master), so the target board looks at the player
    const focus = { x: NPCS.treino.x - 2.4, z: NPCS.treino.z + 1.2 };
    for (const d of DUMMIES) {
      const g = this.makeDummyMesh();
      g.position.set(d.x, terrainY(d.z), d.z);
      g.rotation.y = Math.atan2(focus.x - d.x, focus.z - d.z);
      this.scene.add(g);
      this.sanctNodes.push(g);
      this.dummyProps.push(g);
    }
  }

  makeDummyMesh() {
    const g = new THREE.Group();
    const wood = new THREE.MeshStandardMaterial({ color: 0x8a5a33, roughness: 1, flatShading: true });
    const woodDark = new THREE.MeshStandardMaterial({ color: 0x6b431f, roughness: 1, flatShading: true });
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, 1.25, 7), wood);
    post.position.y = 0.62;
    post.castShadow = true;
    g.add(post);
    const arms = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.09, 0.09), woodDark);
    arms.position.y = 1.0;
    g.add(arms);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 8, 8), woodDark);
    head.position.y = 1.38;
    g.add(head);
    // a real round archery target strapped square onto the dummy's chest.
    // The kit board stands upright with its face along local +X, so a
    // quarter-turn points that face forward (+Z), centered on the body.
    const target = instantiate('kit-target', { shadows: false }).group;
    target.rotation.y = Math.PI / 2;   // face (local +X) → forward (+Z)
    target.scale.setScalar(1.25);
    target.position.set(0, 0.62, 0.06); // centered on the chest, a hair proud
    g.add(target);
    g.userData.target = target; // handle for the dev editor overlay
    return g;
  }

  // ---- dev overlay hooks: live-edit the training dummies & targets ----

  // current editor state derived from where the props actually sit,
  // expressed as an offset from the drill master (Rocha)
  dummyEditState() {
    const rx = NPCS.treino.x, rz = NPCS.treino.z;
    const dummies = (this.dummyProps || []).map((g) => ({
      dx: +(g.position.x - rx).toFixed(2),
      dz: +(g.position.z - rz).toFixed(2),
      yaw: +g.rotation.y.toFixed(3),
      scale: +g.scale.x.toFixed(2),
    }));
    const tgt = this.dummyProps?.[0]?.userData.target;
    const target = tgt ? {
      px: +tgt.position.x.toFixed(2), py: +tgt.position.y.toFixed(2), pz: +tgt.position.z.toFixed(2),
      rx: +tgt.rotation.x.toFixed(2), ry: +tgt.rotation.y.toFixed(2), rz: +tgt.rotation.z.toFixed(2),
      scale: +tgt.scale.x.toFixed(2),
    } : { px: 0, py: 0.62, pz: 0.06, rx: 0, ry: Math.PI / 2, rz: 0, scale: 1.25 };
    return { dummies, target };
  }

  // apply an editor state to every live dummy prop (and remember the
  // target transform so training-mode actors match)
  applyDummyEdit(state) {
    const rx = NPCS.treino.x, rz = NPCS.treino.z;
    (this.dummyProps || []).forEach((g, i) => {
      const d = state.dummies[i];
      if (!d) return;
      g.position.set(rx + d.dx, terrainY(rz + d.dz), rz + d.dz);
      g.rotation.y = d.yaw;
      g.scale.setScalar(d.scale);
      const t = g.userData.target;
      const s = state.target;
      if (t) {
        t.position.set(s.px, s.py, s.pz);
        t.rotation.set(s.rx, s.ry, s.rz);
        t.scale.setScalar(s.scale);
      }
    });
  }

  mkNpc(d) {
    const a = this.makeAnimated(d.model);
    a.group.position.set(d.x, terrainY(d.z), d.z);
    a.group.rotation.y = d.yaw;
    // either recolor specific parts (hue/part rules) or, failing that,
    // dye the whole outfit so they don't read as a player class
    if (d.recolor) this.recolorNpc(a, d.model, d.recolor);
    else if (d.tint) for (const m of a.mats) m.color.multiply(new THREE.Color(d.tint));
    const label = this.makeTextSprite(d.name, 0xffe9b8, 2.2);
    label.position.y = 2.0;
    a.group.add(label);
    const bubble = this.makeTextSprite(d.bubble || t('npc.greeting'), 0xffffff, 1.5);
    bubble.position.y = 2.5;
    bubble.visible = false;
    a.group.add(bubble);
    a.bubble = bubble;
    a.rotatePhrases = !!d.rotate;
    a.homeYaw = d.yaw;
    this.scene.add(a.group);
    this.setLoco(a, 'idle');
    this.npcs.push(a);
    this.sanctNodes.push(a.group);
    return a;
  }

  // hide the sanctuary's dwellers & props while a wave rages (their
  // per-frame updates are skipped too — see updateNpcs/updateShowPets)
  setSanctuaryActive(on) {
    if (this.sanctActive === on) return;
    this.sanctActive = on;
    for (const n of this.sanctNodes) n.visible = on;
  }

  // ---------------- the arrival portal ----------------

  // arm a delayed arrival: heroes spawned at the portal wait hidden,
  // then flare it open and step out once the timer fires — timed by the
  // caller to land a beat after the intro clears the screen
  beginArrival(delay) {
    this.arrivalArmed = true;
    this.arrivalT = delay;
    // anything already spawned near the portal joins the wait
    for (const a of this.players.values()) {
      if (Math.hypot(a.group.position.x - PORTAL.x, a.group.position.z - PORTAL.z) < 3.5) {
        a.arrivalPending = true;
        a.group.visible = false;
      }
    }
  }

  fireArrival() {
    this.arrivalArmed = false;
    let any = false;
    for (const a of this.players.values()) {
      if (!a.arrivalPending) continue;
      a.arrivalPending = false;
      a.group.visible = true;
      a.spawnT = -0.22; // portal opens a touch before the hero pops in
      a.group.scale.setScalar(0.01);
      any = true;
    }
    if (any) this.spawnPortalFx();
  }

  // swirling vortex shader for the round portal plane — arms spiraling
  // into a bright core, ringed by a purple glow; uOpen drives both the
  // flare-open and the fade-out so one uniform animates the whole life
  makePortalMaterial() {
    return new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: { uT: { value: 0 }, uOpen: { value: 0 } },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv * 2.0 - 1.0;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        varying vec2 vUv;
        uniform float uT, uOpen;
        void main() {
          float r = length(vUv);
          if (r > 1.0) discard;
          float ang = atan(vUv.y, vUv.x);
          float swirl = 0.5 + 0.5 * sin(ang * 3.0 + uT * 3.2 - r * 10.0);
          float rings = 0.5 + 0.5 * sin(r * 20.0 - uT * 6.0);
          float core = smoothstep(0.4, 0.0, r);
          float edge = smoothstep(1.0, 0.78, r) * smoothstep(0.5, 0.9, r);
          vec3 purple = vec3(0.62, 0.35, 0.95);
          vec3 blue = vec3(0.42, 0.55, 1.0);
          vec3 col = mix(purple, blue, rings * 0.5) * (0.4 + 0.6 * swirl);
          col += vec3(0.92, 0.82, 1.0) * core * 1.5;
          col += purple * edge * 1.4;
          float alpha = uOpen * clamp(edge + core + swirl * 0.35 * (1.0 - r), 0.0, 1.0);
          gl_FragColor = vec4(col * uOpen, alpha);
        }`,
    });
  }

  // flare the arrival portal open: it expands under the spawning hero,
  // holds while they materialize, then shrinks away to nothing. Called
  // once per arriving player — an already-open portal just lingers.
  spawnPortalFx() {
    if (this.portalFx) { this.portalFx.hold = Math.max(this.portalFx.hold, 1.1); return; }
    if (!this._portalMat) this._portalMat = this.makePortalMaterial();
    const y = terrainY(PORTAL.z);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(PORTAL.r, 48), this._portalMat);
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(PORTAL.x, y + 0.06, PORTAL.z);
    disc.renderOrder = 3;
    // soft light column rising off the vortex
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(PORTAL.r * 0.5, PORTAL.r * 0.92, 2.8, 20, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xb27aff, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      })
    );
    beam.position.set(PORTAL.x, y + 1.4, PORTAL.z);
    const light = new THREE.PointLight(0x9a4ae0, 0, 10, 2);
    light.position.set(PORTAL.x, y + 1.2, PORTAL.z);
    this.scene.add(disc, beam, light);
    this.portalFx = { disc, beam, light, t: 0, hold: 1.1, closing: 0 };
  }

  // per-frame portal life-cycle: flare open (with a little overshoot),
  // hold while heroes step through, shrink & die
  updatePortal(dt) {
    const fx = this.portalFx;
    if (!fx) return;
    fx.t += dt;
    this._portalMat.uniforms.uT.value = this.time;
    const OPEN = 0.38, CLOSE = 0.5;
    let open;
    if (fx.t < OPEN) {
      const k = fx.t / OPEN;
      open = 1 - Math.pow(1 - k, 3);
      open *= 1 + 0.18 * Math.sin(k * Math.PI); // overshoot pop
    } else if (fx.hold > 0) {
      fx.hold -= dt;
      open = 1;
    } else {
      fx.closing += dt;
      open = Math.max(1 - fx.closing / CLOSE, 0);
      if (open <= 0) {
        this.scene.remove(fx.disc, fx.beam, fx.light);
        this.portalFx = null;
        return;
      }
    }
    this._portalMat.uniforms.uOpen.value = Math.min(open, 1);
    fx.disc.scale.setScalar(Math.max(open, 0.001));
    fx.beam.scale.set(open, 0.55 + open * 0.45, open);
    fx.beam.material.opacity = 0.32 * open;
    fx.light.intensity = 24 * open;
  }

  // ---------------- pet vendor's stall ----------------

  // Tonho the pet seller stands facing the camera (+z), his banner-
  // draped canopy just behind him with a coin sign spinning overhead
  // and two of his critters loafing about out front — impossible to
  // mistake for anything but the pet shop.
  spawnPetShop() {
    const { x, z } = PET_SHOP_POS;

    // the stall sits well behind Tonho now (he takes a full step out
    // front so his name is never swallowed by the canopy), opening
    // toward the portal like everything else on the sanctuary floor
    const stall = new THREE.Group();
    stall.position.set(x, -ELEV, z - 1.8);
    const frame = instantiate('dungeon-stall').group;
    stall.add(frame);
    const frameBox = new THREE.Box3().setFromObject(frame);
    // banners hang off the canopy's front corners (facing the camera)
    for (const sx of [-1, 1]) {
      const banner = instantiate('dungeon-banner', { shadows: false }).group;
      banner.position.set(sx * (frameBox.max.x - 0.28), frameBox.max.y - 0.18, frameBox.max.z - 0.12);
      stall.add(banner);
    }
    const chest = instantiate('dungeon-chest').group;
    chest.scale.setScalar(0.75);
    chest.position.set(-(frameBox.max.x - 0.15), 0, 0.5);
    chest.rotation.y = 0.5;
    stall.add(chest);
    // a big slowly-spinning coin as the shop sign
    const sign = instantiate('dungeon-coin', { shadows: false }).group;
    sign.scale.setScalar(2.2);
    sign.position.set(0, frameBox.max.y + 0.42, 0);
    stall.add(sign);
    this.petShopSign = sign;
    this.scene.add(stall);
    this.sanctNodes.push(stall);

    // Tonho stands a clear step out front, facing the portal
    this.mkNpc({
      model: 'char-male-f', name: 'Tonho',
      x, z, yaw: 0, bubble: t('npc.pets'),
    });

    // his display critters potter about out front (portal side), never
    // hidden by the canopy — idling / eating / dancing / strolling
    for (const [key, ox, oz] of [['pet-dog', -1.9, 1.1], ['pet-cat', 1.7, 1.3]]) {
      const actor = this.makeAnimated(key);
      actor.group.position.set(x + ox, -ELEV, z + oz);
      this.scene.add(actor.group);
      this.setLoco(actor, 'idle');
      this.sanctNodes.push(actor.group);
      this.showPets.push({
        actor, ax: x + ox, az: z + oz,
        mode: 'idle', t: 1 + Math.random() * 2, ang: Math.random() * Math.PI * 2,
      });
    }
  }

  // ---------------- weapon smith's hut ----------------

  // Baru's forge-front, facing the camera (+z) like Tonho across the
  // plaza: a mini-arena stone wall behind him with two weapon racks
  // half-set into it (spears on the left, swords on the right), a couple
  // of blades hung between them, an anvil and a dropped great axe on the
  // ground out front, and a spinning trophy for a shop sign. Everything
  // is laid out so no two models overlap. Same trade rules as the pets.
  spawnWeaponShop() {
    const { x, z } = WEAPON_SHOP_POS;

    // hut origin sits on Baru; the wall is built a bit north (−z) so it
    // ends up behind him and the whole display opens toward the portal
    const hut = new THREE.Group();
    hut.position.set(x, -ELEV, z);
    this.scene.add(hut);
    this.sanctNodes.push(hut);

    // measure one wall segment
    let wallH = 1.7, wallW = 2;
    {
      const probe = instantiate('arena-wall', { shadows: false }).group;
      const s = new THREE.Box3().setFromObject(probe).getSize(new THREE.Vector3());
      wallH = s.y; wallW = Math.max(s.x, s.z);
    }
    const WALLZ = -1.35;               // wall line (behind Baru)
    // back wall, two segments wide, spanning ±wallW
    for (const sx of [-0.5, 0.5]) {
      const wall = instantiate('arena-wall').group;
      wall.position.set(sx * wallW, 0, WALLZ);
      hut.add(wall);
    }

    // two weapon racks half-set into the wall (one per segment), a touch
    // in front of the wall line so they read as embedded in it
    const rackZ = WALLZ + 0.28;
    // left rack — spears; right rack — swords
    for (const [side, mk, n] of [[-1, makeSpear, 2], [1, () => instantiate('prop-sword', { shadows: false }).group, 2]]) {
      const rack = instantiate('arena-rack').group;
      rack.position.set(side * wallW * 0.5, 0, rackZ);
      hut.add(rack);
      for (let i = 0; i < n; i++) {
        const w = mk();
        const dx = (i - (n - 1) / 2) * 0.16;
        w.position.set(side * wallW * 0.5 + dx, 0.5, rackZ + 0.06);
        w.rotation.z = dx * 1.2; // fan them slightly in the rack
        if (mk !== makeSpear) w.scale.setScalar(1.1);
        hut.add(w);
      }
    }

    // a great sword hung flat between the racks + the banner beside it
    const hangSword = makeGreatSword();
    hangSword.scale.multiplyScalar(1.1);
    hangSword.position.set(0.15, wallH * 0.6, WALLZ + 0.05);
    hangSword.rotation.set(0, 0, Math.PI * 0.78);
    hut.add(hangSword);
    const banner = instantiate('arena-banner', { shadows: false }).group;
    banner.position.set(-wallW * 0.72, wallH - 0.1, WALLZ + 0.05);
    hut.add(banner);

    // anvil on the ground to Baru's right (out front, clear of him)
    const anvil = instantiate('arena-anvil').group;
    anvil.position.set(1.15, 0, 0.35);
    anvil.rotation.y = -0.4;
    hut.add(anvil);
    // a great shield leaning against the anvil
    const leanShield = makeGreatShield();
    leanShield.scale.multiplyScalar(1.3);
    leanShield.position.set(1.15, 0.42, 0.72);
    leanShield.rotation.set(-1.15, 0.3, 0);
    hut.add(leanShield);

    // a great axe dropped flat on the ground to Baru's left
    const floorAxe = makeGreatAxe();
    floorAxe.position.set(-1.2, 0.05, 0.45);
    floorAxe.rotation.set(Math.PI / 2 - 0.08, 0, 0.9);
    hut.add(floorAxe);

    // spinning trophy = the shop sign (mirrors the pet stall's coin)
    const sign = instantiate('arena-trophy', { shadows: false }).group;
    sign.scale.setScalar(1.6);
    sign.position.set(0, wallH + 0.5, WALLZ);
    hut.add(sign);
    this.weaponShopSign = sign;

    // Baru's wall line sits behind him; he stands a step out front of
    // the anvil area, facing the portal like Tonho across the plaza
    this.mkNpc({
      model: 'char-tanker', name: 'Baru', tint: 0xd87a5a,
      x, z: z + 0.5, yaw: 0, bubble: t('npc.weapons'),
    });
  }

  updateShowPets(dt) {
    if (!this.sanctActive) return;
    const MODES = ['idle', 'eat', 'dance', 'walk', 'gesture-positive'];
    for (const p of this.showPets) {
      p.actor.mixer.update(dt);
      p.t -= dt;
      if (p.t <= 0) {
        p.t = 2.2 + Math.random() * 3.2;
        p.mode = MODES[(Math.random() * MODES.length) | 0];
        this.setLoco(p.actor, p.mode === 'walk' ? 'walk' : p.mode, 1);
      }
      if (p.mode === 'walk') {
        // amble a lazy circle around the home spot (sanctuary floor)
        p.ang += dt * 1.1;
        const r = 0.65;
        p.actor.group.position.set(p.ax + Math.cos(p.ang) * r, -ELEV, p.az + Math.sin(p.ang) * r);
        p.actor.group.rotation.y = Math.atan2(-Math.sin(p.ang), Math.cos(p.ang));
      }
    }
    if (this.petShopSign) this.petShopSign.rotation.y += dt * 1.2;
    if (this.weaponShopSign) this.weaponShopSign.rotation.y += dt * 1.2;
  }

  updateNpcs(dt, selfPos) {
    if (!this.sanctActive) return;
    for (const a of this.npcs) {
      a.mixer.update(dt);
      const near = !!selfPos && Math.hypot(
        selfPos.x - a.group.position.x, selfPos.z - a.group.position.z
      ) < 2.2;
      if (near) {
        // turn to face the visitor and greet them
        const ty = Math.atan2(
          selfPos.x - a.group.position.x, selfPos.z - a.group.position.z
        );
        a.group.rotation.y = angleLerp(a.group.rotation.y, ty, Math.min(dt * 6, 1));
        if (!a.bubble.visible && a.actions.wave) this.playOnce(a, 'wave', 1.1);
        // the cheerleader swaps in a fresh encouragement on every visit
        if (a.rotatePhrases && !a.bubble.visible) {
          a.phraseIdx = ((a.phraseIdx ?? -1) + 1) % 6;
          a.group.remove(a.bubble);
          a.bubble.material.map.dispose();
          a.bubble = this.makeBubbleSprite(t(`npc.inc${a.phraseIdx}`));
          a.bubble.position.y = 2.5;
          a.group.add(a.bubble);
        }
      } else {
        a.group.rotation.y = angleLerp(a.group.rotation.y, a.homeYaw, Math.min(dt * 2, 1));
      }
      a.bubble.visible = near;
    }
  }

  // ---------------- gravedigger tombs ----------------

  ensureGrave(row) {
    const [id, x, z] = row;
    if (this.graves.has(id)) return;
    const group = new THREE.Group();
    const mound = instantiate('prop-grave-mound').group;
    const stone = instantiate('prop-gravestone').group;
    stone.position.z = -0.4; // headstone at the head of the mound
    group.add(mound, stone);
    group.position.set(x, -1.3, z);
    group.rotation.y = (id % 7) * 0.9;
    this.scene.add(group);
    this.graves.set(id, { group, riseT: 0 });
    this.burst(x, z, 0.9, 0xa2764a); // dirt kicked up as it surfaces
  }

  ensureTower(row) {
    const [id, kind, c, r, lvl] = row;
    const spec = row[6] || 0;
    let a = this.towers.get(id);
    if (a && (a.lvl !== lvl || a.spec !== spec)) { this.removeTowerActor(id); a = null; }
    if (a) return a;
    const w = cellToWorld(c, r);
    const group = new THREE.Group();
    group.position.set(w.x, 0, w.z);

    // base tinted by level: grey→blue→green→red→purple→gold, with a soft glow
    const lvlColor = TOWER_LEVEL_COLORS[Math.min(lvl, TOWER_LEVEL_COLORS.length) - 1];
    const base = instantiate('tower-base', { cloneMaterials: true }).group;
    base.traverse((o) => {
      if (o.isMesh && o.material) {
        o.material.color.set(lvlColor);
        if (o.material.emissive) {
          o.material.emissive.set(lvlColor);
          o.material.emissiveIntensity = 0.12 + lvl * 0.06;
        }
      }
    });
    group.add(base);

    const weapon = instantiate(TOWERS[kind]?.model || 'tower-ballista', {
      cloneMaterials: !!spec,
    }).group;
    weapon.position.y = 0.55;
    weapon.scale.setScalar(1 + (lvl - 1) * 0.07);
    if (spec) paintSpecDetail(weapon, spec);
    group.add(weapon);
    if (lvl >= TOWERS_MAX_VISUAL) {
      const deco = instantiate('tower-crystals', { shadows: false }).group;
      deco.position.y = 0.05;
      group.add(deco);
    }
    // matching colored ring on the ground from level 2 up
    if (lvl >= 2) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.92, 1.12, 40),
        new THREE.MeshBasicMaterial({
          color: lvlColor,
          transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide,
        })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.05;
      ring.renderOrder = 3;
      group.add(ring);
    }
    this.scene.add(group);
    a = { group, weapon, lvl, kind, c, r, rot: Math.PI, spec };
    this.towers.set(id, a);
    return a;
  }

  removeTowerActor(id) {
    const a = this.towers.get(id);
    if (a) { this.scene.remove(a.group); this.towers.delete(id); }
  }

  ensureObstacle(row) {
    const [id, kind, c, r] = row;
    if (this.obstacles.has(id)) return;
    const w = cellToWorld(c, r);
    const g = instantiate(`obstacle-${kind}`).group;
    g.position.set(w.x, 0, w.z);
    g.rotation.y = (id % 4) * (Math.PI / 2) + 0.2;
    this.scene.add(g);
    this.obstacles.set(id, g);
  }

  // ---------------- snapshot application ----------------

  applySnapshot(prev, next, alpha, selfId, selfPose) {
    if (!next) return;
    const prevPl = new Map(), prevEn = new Map();
    if (prev) {
      for (const r of prev.pl) prevPl.set(r[PL.ID], r);
      for (const r of prev.en) prevEn.set(r[EN.ID], r);
    }

    // ---- players
    const seenP = new Set();
    for (const row of next.pl) {
      const id = row[PL.ID];
      seenP.add(id);
      const a = this.ensurePlayer(row, selfId);
      const dead = row[PL.DEAD] === 1;
      // stay hidden while waiting on an armed portal arrival
      a.group.visible = !dead && !a.arrivalPending;
      let x = row[PL.X], z = row[PL.Z], yaw = row[PL.YAW], moving = row[PL.MOV] === 1;
      const p = prevPl.get(id);
      if (id === selfId && selfPose) {
        x = selfPose.x; z = selfPose.z; yaw = selfPose.yaw; moving = selfPose.moving;
      } else if (p) {
        x = lerp(p[PL.X], x, alpha);
        z = lerp(p[PL.Z], z, alpha);
        yaw = angleLerp(p[PL.YAW], yaw, alpha);
      }
      a.group.position.x = x;
      a.group.position.z = z;
      // heroes stand on the terrain: 0 on the battlefield plateau,
      // ramping down the stairs to the sunken sanctuary floor
      a.baseY = terrainY(z);
      if (a.jumpT == null) a.group.position.y = a.baseY;
      a.group.rotation.y = yaw;
      if (!dead) {
        const spd = CLASSES[a.cls]?.speed || 4;
        this.setLoco(a, moving ? (spd > 4.8 ? 'sprint' : 'walk') : 'idle', moving ? spd / 3.2 : 1);
      }
      const frac = row[PL.HP] / row[PL.MHP];
      this.setHpBar(a.hpBar, frac);
      // the HP bar only appears once the hero has actually taken damage
      a.hpBar.visible = !dead && frac < 0.999;
      // "wall mode" aura follows the tanker skill flag in the snapshot
      const wall = row[PL.WALL] === 1;
      if (wall && !a.wallFx) this.addWallAura(a);
      else if (!wall && a.wallFx) this.removeWallAura(a);
      // rebuild the overhead label (other players only) when name/level change
      if (a.label && (a.labelLvl !== row[PL.LVL] || a.labelName !== row[PL.NAME])) {
        a.group.remove(a.label);
        a.label.material.map.dispose();
        a.label = this.makePlayerLabel(row[PL.NAME], row[PL.LVL], a.cls, a.tint);
        a.label.position.y = (a.labelTop || 1.4) + 0.72;
        a.labelLvl = row[PL.LVL];
        a.labelName = row[PL.NAME];
        a.group.add(a.label);
      }
      // companion pet at the hero's heels
      this.syncPet(id, row[PL.PET], row[PL.PETNAME], row[PL.PETLVL]);
      // equipped weapon & shield (swapped at the smith between waves)
      this.syncLoadoutProps(a, row);
    }
    for (const [id, a] of this.players) {
      if (!seenP.has(id)) {
        this.scene.remove(a.group);
        this.players.delete(id);
        this.removePet(id);
      }
    }

    // ---- enemies
    const seenE = new Set();
    for (const row of next.en) {
      const id = row[EN.ID];
      seenE.add(id);
      const a = this.ensureEnemy(row);
      const p = prevEn.get(id);
      let x = row[EN.X], z = row[EN.Z], yaw = row[EN.YAW];
      if (p) {
        x = lerp(p[EN.X], x, alpha);
        z = lerp(p[EN.Z], z, alpha);
        yaw = angleLerp(p[EN.YAW], yaw, alpha);
      }
      a.group.position.x = x;
      a.group.position.z = z;
      // ghosts hover; everything else stands on the terrain (training
      // dummies live down on the sunken sanctuary floor)
      a.group.position.y = a.isGhost
        ? 0.25 + Math.sin(this.time * 3 + id) * 0.12
        : terrainY(z);
      if (a.kind !== 'dummy') a.group.rotation.y = yaw;
      // enemies spawn hidden deep in the northern woods and slowly
      // step out of the penumbra: invisible until the forest mouth,
      // fully lit a few cells into the board
      const fade = Math.min(Math.max((z + HALF_H + 2) / 7, 0), 1);
      if (a.fade !== fade) {
        a.fade = fade;
        const baseOp = a.isGhost ? 0.8 : 1;
        const full = fade >= 1 && !a.isGhost;
        for (const m of a.mats) {
          m.transparent = !full;
          m.opacity = full ? 1 : baseOp * (0.05 + 0.95 * fade);
        }
      }
      this.setLoco(a, row[EN.MOV] === 1 ? 'walk' : 'idle', 1.15);
      const frac = row[EN.HP] / row[EN.MHP];
      a.hpBar.visible = frac < 0.999;
      this.setHpBar(a.hpBar, frac);
      this.setStatusFx(a, row[EN.ST] || 0);
    }
    for (const [id, a] of this.enemies) {
      if (!seenE.has(id)) { this.scene.remove(a.group); this.enemies.delete(id); }
    }
    // the static yard dummies stand in whenever no live (attackable)
    // sim dummies exist — the two never show at once
    let liveDummy = false;
    for (const a of this.enemies.values()) if (a.kind === 'dummy') { liveDummy = true; break; }
    for (const g of this.dummyProps || []) g.visible = this.sanctActive && !liveDummy;

    // ---- towers / obstacles
    const seenT = new Set();
    for (const row of next.tw) {
      seenT.add(row[0]);
      const a = this.ensureTower(row);
      a.targetRot = row[5];
    }
    for (const id of [...this.towers.keys()]) if (!seenT.has(id)) this.removeTowerActor(id);

    const seenO = new Set();
    for (const row of next.ob) { seenO.add(row[0]); this.ensureObstacle(row); }
    for (const [id, g] of this.obstacles) {
      if (!seenO.has(id)) { this.scene.remove(g); this.obstacles.delete(id); }
    }

    // ---- gravedigger tombs (rise on appear, crumble away on remove)
    const seenG = new Set();
    for (const row of next.gr || []) { seenG.add(row[0]); this.ensureGrave(row); }
    for (const [id, g] of this.graves) {
      if (!seenG.has(id)) {
        this.graves.delete(id);
        this.effects.push({ type: 'grave-sink', mesh: g.group, t: 0, dur: 0.55 });
      }
    }

    this.updateDrops(prev?.dr, next.dr, alpha, selfId);
  }

  // ---------------- drops ----------------

  // rows: [id, owner, kind(0=xp 1=pts 2=gold), x, z] — only own orbs are
  // drawn; gold renders as a bigger, glowing spinning mini-dungeon coin
  updateDrops(prevRows, rows, alpha, selfId) {
    const prevMap = new Map();
    if (prevRows) for (const r of prevRows) prevMap.set(r[0], r);
    const counts = [0, 0, 0];
    const meshes = [this.xpOrbs, this.ptsOrbs, this.goldOrbs];
    let sparkN = 0;
    const sparkCap = this.dropCap * this.goldDots;
    if (rows) {
      for (const row of rows) {
        if (row[1] !== selfId) continue;
        const kind = row[2];
        const mesh = meshes[kind] || this.xpOrbs;
        const i = counts[kind];
        if (i >= this.dropCap) continue;
        let x = row[3], z = row[4];
        const p = prevMap.get(row[0]);
        if (p) { x = lerp(p[3], x, alpha); z = lerp(p[4], z, alpha); }
        const gold = kind === 2;
        // gold floats a little higher and bobs more, to catch the eye
        const y = gold
          ? 0.5 + Math.sin(this.time * 3 + row[0] * 1.7) * 0.14
          : 0.32 + Math.sin(this.time * 3.5 + row[0] * 1.7) * 0.09;
        this._orbPos.set(x, y, z);
        this._orbEuler.set(0, this.time * (gold ? 3.2 : 2.2) + row[0], 0);
        this._orbMat.compose(
          this._orbPos, this._orbQuat.setFromEuler(this._orbEuler),
          gold ? this._orbScaleGold : this._orbScale
        );
        mesh.setMatrixAt(i, this._orbMat);
        counts[kind]++;
        // little golden dots orbiting each coin
        if (gold) {
          for (let d = 0; d < this.goldDots && sparkN < sparkCap; d++) {
            const ang = this.time * 2 + row[0] + d * (Math.PI * 2 / this.goldDots);
            this._dotPos.set(
              x + Math.cos(ang) * 0.34,
              y + 0.05 + Math.sin(this.time * 4 + d + row[0]) * 0.13,
              z + Math.sin(ang) * 0.34
            );
            this._dotMat.compose(this._dotPos, this._identQuat, this._dotScale);
            this.goldSparkle.setMatrixAt(sparkN++, this._dotMat);
          }
        }
      }
    }
    meshes.forEach((mesh, k) => {
      mesh.count = counts[k];
      mesh.instanceMatrix.needsUpdate = true;
    });
    this.goldSparkle.count = sparkN;
    this.goldSparkle.instanceMatrix.needsUpdate = true;
  }

  // ---------------- events ----------------

  handleEvent(ev) {
    switch (ev.t) {
      case 'atk': {
        const a = this.players.get(ev.id) || this.enemies.get(ev.id);
        if (!a) return;
        const name = a.cls
          ? { berserker: 'attack-melee-right', tanker: 'attack-melee-right', archer: 'holding-right-shoot', mage: 'interact-right' }[a.cls]
          : (a.isArcher ? 'holding-right-shoot' : 'attack-melee-right');
        this.playOnce(a, name, 0.6);
        if (typeof ev.tx === 'number') {
          a.group.rotation.y = Math.atan2(ev.tx - a.group.position.x, ev.tz - a.group.position.z);
        }
        // melee swings get a visible flourish + swing sound
        // (ev.r marks ranged enemy attacks: arrows / lobbed pumpkins)
        const isMelee = a.cls ? (a.cls === 'berserker' || a.cls === 'tanker') : !ev.r;
        if (isMelee) {
          const px = a.group.position.x, pz = a.group.position.z, yaw = a.group.rotation.y;
          // upgraded weapons swing in gold / crystal instead of steel
          const col = tierEffectColor(a.cls ? 0xffe9a8 : 0xff9a8a, ev.wt);
          if (ev.wid === 'spear') this.spawnThrust(px, pz, yaw, col);       // stab
          else if (ev.wid === 'hammer') this.spawnBash(px, pz, yaw, col);   // pound
          else this.spawnSlash(px, pz, yaw, col);                           // slash
          sfx.melee();
        }
        break;
      }
      case 'shoot': this.spawnProjectile(ev); break;
      case 'aoe': this.spawnAoe(ev); break;
      case 'hit': {
        const a = this.players.get(ev.id) || this.enemies.get(ev.id);
        if (a) a.flashT = 0.12;
        break;
      }
      case 'die': {
        if (ev.player) break; // players just hide via snapshot
        const a = this.enemies.get(ev.id);
        if (a) {
          this.enemies.delete(ev.id);
          this.spawnCorpse(a);
        }
        break;
      }
      case 'breach': {
        this.gs.crystalBreachFx();
        this.burst(CRYSTAL_POS.x, CRYSTAL_POS.z, 1.6, 0xff5540);
        break;
      }
      case 'lvl': {
        const a = this.players.get(ev.id);
        if (a) this.burst(a.group.position.x, a.group.position.z, 1.3, 0xffd24a);
        break;
      }
      case 'upgrade': {
        const w = cellToWorld(ev.c, ev.r);
        this.burst(w.x, w.z, 1.4, 0x8fd0ff);
        break;
      }
      case 'place': {
        const w = cellToWorld(ev.c, ev.r);
        this.burst(w.x, w.z, 1.1, 0x8fe98f);
        break;
      }
      case 'respawn': {
        this.burst(ev.x, ev.z, 1.4, 0x8fe98f);
        // checkpoint respawns come back through the sanctuary portal
        if (Math.hypot(ev.x - PORTAL.x, ev.z - PORTAL.z) < 3.5) {
          this.spawnPortalFx();
          const a = this.players.get(ev.id);
          if (a) { a.spawnT = 0; a.group.scale.setScalar(0.01); }
        }
        break;
      }
      case 'crit': {
        // tiger-pet critical hit: punchy ring + floating callout
        this.burst(ev.x, ev.z, 0.9, 0xffb020);
        this.spawnFloatText('CRIT!', ev.x, ev.z, 0xffb020);
        break;
      }
      case 'dreset': {
        // a depleted training dummy springs back to full
        this.burst(ev.x, ev.z, 1.0, 0xffd24a);
        break;
      }
      case 'petswap': {
        const a = this.players.get(ev.id);
        if (a) this.burst(a.group.position.x, a.group.position.z, 1.0, 0xffd24a);
        break;
      }
      case 'wswap': {
        const a = this.players.get(ev.id);
        if (a) this.burst(a.group.position.x, a.group.position.z, 1.0, 0x9fe8ff);
        break;
      }
      case 'block': {
        // shield block: a silvery flash + callout where the hit landed
        this.burst(ev.x, ev.z, 0.8, 0xbfc8d4);
        this.spawnFloatText('BLOCK!', ev.x, ev.z, 0xbfc8d4);
        break;
      }
      case 'stun': {
        // war-hammer stun: dizzy-yellow pop over the rooted enemy
        this.burst(ev.x, ev.z, 0.7, 0xffe066);
        this.spawnFloatText('STUN!', ev.x, ev.z, 0xffe066);
        break;
      }
      case 'revive': {
        // a horde zombie claws back up: dark pulse + callout
        this.burst(ev.x, ev.z, 1.0, 0x9a4ae0);
        this.spawnFloatText('REVIVE!', ev.x, ev.z, 0xc06aff);
        break;
      }
      case 'zap': {
        // storm crystal arc between two bunched enemies
        this.spawnZap(ev.x1, ev.z1, ev.x2, ev.z2);
        break;
      }
      case 'flame': {
        // flamethrower jet: a fan of embers washing toward the target
        this.spawnFlameJet(ev.x, ev.z, ev.tx, ev.tz, ev.v === 1);
        break;
      }
      case 'gfire': {
        // cannon napalm: the ground keeps burning where the shell hit
        this.spawnGroundFire(ev.x, ev.z, ev.r, ev.dur);
        break;
      }
      case 'spec': {
        const w = cellToWorld(ev.c, ev.r);
        this.burst(w.x, w.z, 1.6, 0xffd24a);
        break;
      }
      case 'spawn': {
        // clawing out of a gravedigger tomb
        if (ev.g) this.burst(ev.x, ev.z, 1.0, 0x9a4ae0);
        break;
      }
      case 'ejump': {
        // vampire vaulting the maze — swarm of bats around the hop
        const a = this.enemies.get(ev.id);
        if (!a) return;
        a.jumpT = 0;
        a.jumpDur = ev.dur || JUMP.DUR;
        if (a.actions.jump) this.playOnce(a, 'jump', a.jumpDur);
        this.spawnBats(a);
        break;
      }
      case 'skill': {
        const a = this.players.get(ev.id);
        if (ev.cls === 'berserker' && typeof ev.x === 'number') {
          // shock rings pop along the line as the dash passes through
          const n = 6;
          for (let i = 0; i <= n; i++) {
            const k = i / n;
            this.effects.push({
              type: 'delayed-burst', t: -(ev.dur || 0.4) * k, dur: 0.3,
              x: lerp(ev.x, ev.tx, k), z: lerp(ev.z, ev.tz, k),
              r: 1.15, color: 0xff6a4d,
            });
          }
          if (a) this.playOnce(a, 'attack-melee-right', ev.dur || 0.4);
        } else if (ev.cls === 'tanker' && a) {
          this.burst(a.group.position.x, a.group.position.z, 1.7, 0xbfc8d4);
          this.playOnce(a, 'interact-right', 0.5);
        } else if (ev.cls === 'mage' && a) {
          this.burst(a.group.position.x, a.group.position.z, 1.2, 0xc07dff);
        }
        break;
      }
    }
  }

  // "wall mode": a slowly orbiting ring of stone slabs around the
  // tanker so the no-knockback / double-defense window is unmissable
  addWallAura(a) {
    const g = new THREE.Group();
    for (let i = 0; i < 6; i++) {
      const slab = new THREE.Mesh(this._wallSlabGeo, this._wallStoneMat);
      const ang = (i / 6) * Math.PI * 2;
      slab.position.set(Math.cos(ang) * 0.85, 0.55, Math.sin(ang) * 0.85);
      slab.rotation.y = -ang;
      g.add(slab);
    }
    const ring = new THREE.Mesh(this._ringGeo, this._wallRingMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.04;
    g.add(ring);
    g.userData.stone = this._wallStoneMat;
    a.group.add(g);
    a.wallFx = g;
  }

  removeWallAura(a) {
    a.group.remove(a.wallFx);
    a.wallFx = null;
  }

  // vertical arc while the character vaults grid cells; x/z motion
  // comes from the snapshot (or local prediction for the own player).
  // Longer vaults (monkey pet) take longer AND arc a little higher.
  startJump(id, dur) {
    const a = this.players.get(id);
    if (!a) return;
    a.jumpT = 0;
    a.jumpDur = dur || JUMP.DUR;
    a.jumpH = JUMP.HEIGHT * Math.min(0.6 + 0.4 * (a.jumpDur / JUMP.DUR), 1.9);
    if (a.actions.jump) this.playOnce(a, 'jump', a.jumpDur);
  }

  // one-shot rising text callout ("CRIT!") anchored in world space
  spawnFloatText(text, x, z, color) {
    const spr = this.makeTextSprite(text, color, 1.7);
    spr.position.set(x, terrainY(z) + 1.35, z);
    spr.userData.baseY = terrainY(z);
    this.scene.add(spr);
    this.effects.push({ type: 'float-text', mesh: spr, t: 0, dur: 0.7 });
  }

  // flutter of little black bats swirling around a jumping vampire;
  // the swarm follows the actor through the hop and disperses
  spawnBats(actor) {
    const g = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({
      color: 0x241a38, transparent: true, opacity: 0.95, side: THREE.DoubleSide,
    });
    const wingGeo = new THREE.PlaneGeometry(0.17, 0.1);
    const bats = [];
    for (let i = 0; i < 7; i++) {
      const bat = new THREE.Group();
      const wings = [];
      for (const side of [-1, 1]) {
        const holder = new THREE.Group();
        const wing = new THREE.Mesh(wingGeo, mat);
        wing.rotation.x = -Math.PI / 2; // lie flat so the top-down camera sees them
        wing.position.x = side * 0.085;
        holder.add(wing);
        bat.add(holder);
        wings.push(holder);
      }
      g.add(bat);
      bats.push({
        bat, wings,
        a: Math.random() * Math.PI * 2,
        rad: 0.15 + Math.random() * 0.3,
        rise: 0.7 + Math.random() * 0.9,
        spin: (2.5 + Math.random() * 3) * (Math.random() < 0.5 ? -1 : 1),
        flap: 16 + Math.random() * 8,
        y0: 0.5 + Math.random() * 0.6,
      });
    }
    this.scene.add(g);
    this.effects.push({ type: 'bats', mesh: g, mat, bats, actor, t: 0, dur: 1.05 });
  }

  spawnCorpse(a) {
    a.hpBar.visible = false;
    if (a.actions.die) {
      if (a.oneShot) a.oneShot.stop();
      if (a.current) a.current.fadeOut(0.08);
      const d = a.actions.die;
      d.reset();
      d.setLoop(THREE.LoopOnce, 1);
      d.clampWhenFinished = true;
      d.timeScale = 1.4;
      d.fadeIn(0.05).play();
    }
    this.corpses.push({ actor: a, t: 0 });
  }

  // spear stab: a bright lance streaking forward from the attacker,
  // stretching along the facing then fading (a thrust, not an arc)
  spawnThrust(x, z, yaw, color) {
    const lance = new THREE.Mesh(
      new THREE.ConeGeometry(0.16, 1.3, 8),
      new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.9,
        depthWrite: false, blending: THREE.AdditiveBlending,
      })
    );
    // cone points +Y by default — lay it along +Z (forward) tip-first
    lance.rotation.x = Math.PI / 2;
    lance.position.z = 0.65;
    const holder = new THREE.Group();
    holder.add(lance);
    holder.position.set(x, terrainY(z) + 0.85, z);
    holder.rotation.y = yaw;
    this.scene.add(holder);
    this.effects.push({ mesh: holder, inner: lance, t: 0, dur: 0.2, type: 'thrust' });
  }

  // war hammer pound: a heavy downward smash — a shockwave ring at the
  // impact spot out front plus a quick vertical slam streak, no slicing
  spawnBash(x, z, yaw, color) {
    const ix = x + Math.sin(yaw) * 0.95, iz = z + Math.cos(yaw) * 0.95;
    const gy = terrainY(iz);
    // ground shockwave
    const ring = new THREE.Mesh(
      this._ringGeo,
      new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.95,
        depthWrite: false, side: THREE.DoubleSide,
      })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(ix, gy + 0.06, iz);
    ring.scale.setScalar(0.2);
    this.scene.add(ring);
    this.effects.push({ mesh: ring, t: 0, dur: 0.32, type: 'burst', r: 1.5 });
    // vertical slam streak
    const slam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.16, 0.02, 1.1, 7),
      new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.85,
        depthWrite: false, blending: THREE.AdditiveBlending,
      })
    );
    slam.position.set(ix, gy + 0.6, iz);
    this.scene.add(slam);
    this.effects.push({ mesh: slam, inner: slam, t: 0, dur: 0.16, type: 'slam' });
  }

  // quick swipe arc that sweeps in front of a melee attacker
  spawnSlash(x, z, yaw, color) {
    const arc = new THREE.Mesh(
      new THREE.RingGeometry(0.55, 1.2, 24, 1, -Math.PI / 3.2, Math.PI / 1.6),
      new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.9,
        depthWrite: false, side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      })
    );
    arc.rotation.x = -Math.PI / 2;
    arc.position.set(x, 0.75, z);
    arc.renderOrder = 8;
    const holder = new THREE.Group();
    holder.add(arc);
    holder.position.set(x, terrainY(z), z);
    arc.position.set(0, 0.75, 0);
    // ring theta 0 is +X; rotate so the arc opens toward the facing direction
    holder.rotation.y = yaw - Math.PI / 2;
    this.scene.add(holder);
    this.effects.push({ mesh: holder, inner: arc, t: 0, dur: 0.22, type: 'slash', baseYaw: holder.rotation.y });
  }

  spawnProjectile(ev) {
    if (ev.k === 'magic') {
      // glowing bolt from the mage's staff (ev.big: the skill's
      // giant arcane orb — same bolt, way scaled up). Upgraded weapons
      // recolour the bolt gold / crystal instead of arcane purple.
      const s = ev.big ? 2.8 : 1;
      const coreCol = tierEffectColor(0xe6c4ff, ev.wt);
      const haloCol = tierEffectColor(0xa050ff, ev.wt);
      const bolt = new THREE.Group();
      const core = new THREE.Mesh(
        new THREE.SphereGeometry(0.16 * s, 10, 10),
        new THREE.MeshBasicMaterial({ color: coreCol })
      );
      const halo = new THREE.Mesh(
        new THREE.SphereGeometry(0.3 * s, 10, 10),
        new THREE.MeshBasicMaterial({
          color: haloCol, transparent: true, opacity: 0.45,
          blending: THREE.AdditiveBlending, depthWrite: false,
        })
      );
      bolt.add(core, halo);
      this.scene.add(bolt);
      const from = new THREE.Vector3(...ev.f);
      const to = new THREE.Vector3(...ev.to);
      from.y += terrainY(from.z);
      to.y += terrainY(to.z);
      this.projectiles.push({
        mesh: bolt,
        from,
        to,
        ft: Math.max(ev.ft, 0.05),
        t: 0, lob: false, kind: 'magic',
      });
      return;
    }
    const key = {
      arrow: 'ammo-arrow', cannonball: 'ammo-cannonball',
      boulder: 'ammo-boulder', pumpkin: 'prop-pumpkin',
    }[ev.k] || 'ammo-arrow';
    const mesh = instantiate(key, { shadows: false, cloneMaterials: ev.k === 'arrow' && ev.wt > 0 }).group;
    if (ev.k === 'boulder') mesh.scale.setScalar(1.5);
    if (ev.k === 'arrow') mesh.scale.setScalar(0.55);
    if (ev.k === 'pumpkin') mesh.scale.setScalar(1.6);
    if (ev.small) mesh.scale.setScalar(0.7); // catapult scatter balls
    // a gold / crystal arrow for upgraded bows
    if (ev.k === 'arrow' && ev.wt > 0) {
      const glow = new THREE.Color(TIER_COLORS[ev.wt]);
      mesh.traverse((o) => {
        if (o.isMesh && o.material) {
          o.material.color.lerp(glow, 0.8);
          if (o.material.emissive) { o.material.emissive.copy(glow); o.material.emissiveIntensity = 0.5; }
        }
      });
    }
    this.scene.add(mesh);
    const from = new THREE.Vector3(...ev.f);
    const to = new THREE.Vector3(...ev.to);
    // the sim's heights are relative to the local ground — offset them
    // by the terrain so training shots down in the sanctuary fly level
    from.y += terrainY(from.z);
    to.y += terrainY(to.z);
    this.projectiles.push({
      mesh,
      from,
      to,
      ft: Math.max(ev.ft, 0.05),
      t: 0,
      lob: !!ev.lob,
      kind: ev.k,
    });
  }

  spawnAoe(ev) {
    let color = {
      mage: 0xc07dff, cannonball: 0xffa040, boulder: 0xcfa070, pumpkin: 0xff8c1a,
      crystal: 0x8fd0ff, ice: 0x66c8ff, storm: 0xffe066,
    }[ev.k] || 0xffffff;
    if (ev.k === 'mage') color = tierEffectColor(color, ev.wt); // gold/crystal blast
    if (ev.ft > 0) {
      // telegraph circle, then burst
      const warn = new THREE.Mesh(
        this._discGeo,
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, depthWrite: false })
      );
      warn.rotation.x = -Math.PI / 2;
      warn.position.set(ev.x, terrainY(ev.z) + 0.05, ev.z);
      warn.scale.setScalar(ev.r);
      this.scene.add(warn);
      this.effects.push({ mesh: warn, t: 0, dur: ev.ft, type: 'warn' });
      this.effects.push({ t: -ev.ft, dur: 0.3, type: 'delayed-burst', x: ev.x, z: ev.z, r: ev.r, color });
    } else {
      this.burst(ev.x, ev.z, ev.r, color);
    }
  }

  burst(x, z, r, color) {
    const ring = new THREE.Mesh(
      this._ringGeo,
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2;
    // bursts land on the ground wherever it is — board or sanctuary floor
    ring.position.set(x, terrainY(z) + 0.08, z);
    ring.scale.setScalar(0.2);
    this.scene.add(ring);
    this.effects.push({ mesh: ring, t: 0, dur: 0.35, type: 'burst', r });
  }

  // jagged lightning arc between two enemies (storm crystal)
  spawnZap(x1, z1, x2, z2) {
    const pts = [];
    const segs = 5;
    for (let i = 0; i <= segs; i++) {
      const k = i / segs;
      const jx = i === 0 || i === segs ? 0 : (Math.random() - 0.5) * 0.4;
      const jz = i === 0 || i === segs ? 0 : (Math.random() - 0.5) * 0.4;
      pts.push(new THREE.Vector3(x1 + (x2 - x1) * k + jx, 0.7 + Math.random() * 0.25, z1 + (z2 - z1) * k + jz));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
      color: 0xffe066, transparent: true, opacity: 0.95, depthWrite: false,
    }));
    this.scene.add(line);
    this.effects.push({ mesh: line, t: 0, dur: 0.22, type: 'zap' });
    this.burst(x2, z2, 0.5, 0xffe066);
  }

  // flamethrower jet: a stream of ember sprites racing from the nozzle
  // to the tip of the spray (green for the venom special)
  spawnFlameJet(x, z, tx, tz, venom) {
    const g = new THREE.Group();
    const mat = venom ? this._statusMats.poison : this._statusMats.burn;
    const parts = [];
    for (let i = 0; i < 10; i++) {
      const spr = new THREE.Sprite(mat);
      spr.scale.setScalar(0.15);
      g.add(spr);
      parts.push({ spr, k: i / 10, side: (Math.random() - 0.5) * 0.8 });
    }
    this.scene.add(g);
    this.effects.push({
      mesh: g, t: 0, dur: 0.55, type: 'flamejet',
      x, z, tx, tz, parts,
    });
  }

  // lingering fire patch on the ground (cannon napalm)
  spawnGroundFire(x, z, r, dur) {
    const g = new THREE.Group();
    const disc = new THREE.Mesh(
      this._discGeo,
      new THREE.MeshBasicMaterial({ color: 0xff5a1a, transparent: true, opacity: 0.3, depthWrite: false })
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.06;
    disc.scale.setScalar(r);
    g.add(disc);
    const parts = [];
    for (let i = 0; i < 8; i++) {
      const spr = new THREE.Sprite(this._statusMats.burn);
      const ang = Math.random() * Math.PI * 2, rad = Math.sqrt(Math.random()) * r * 0.8;
      spr.position.set(Math.cos(ang) * rad, 0.2, Math.sin(ang) * rad);
      spr.scale.setScalar(0.22);
      spr.userData.phase = Math.random();
      g.add(spr);
      parts.push(spr);
    }
    g.position.set(x, 0, z);
    this.scene.add(g);
    this.effects.push({ mesh: g, t: 0, dur: dur || 3.5, type: 'gfire', disc, parts });
  }

  // ---------------- build ghost ----------------

  // The ghost follows every pointer move while dragging/hovering, so the
  // model is instantiated once per item and then only repositioned and
  // retinted — rebuilding it per move both cost a full instantiate and
  // compounded the tint multiply into the cloned materials.
  setGhost(item, c, r, ok) {
    if (!item || c == null) return this.clearGhost();
    if (this.ghost?.item !== item) {
      this.clearGhost();
      const key = item === 'obstacle' ? 'obstacle-rocks' : TOWERS[item]?.model;
      if (!key) return;
      const g = instantiate(key, { cloneMaterials: true, shadows: false }).group;
      g.traverse((o) => {
        if (o.isMesh && o.material) {
          o.material.transparent = true;
          o.material.opacity = 0.55;
          o.userData.baseColor = o.material.color.clone();
        }
      });
      this.scene.add(g);
      this.ghost = { item, group: g, ok: null };
    }
    const g = this.ghost.group;
    const w = cellToWorld(c, r);
    g.position.set(w.x, 0.02, w.z);
    if (this.ghost.ok !== ok) {
      this.ghost.ok = ok;
      const tint = new THREE.Color(ok ? 0x9fff9f : 0xff8f8f);
      g.traverse((o) => {
        if (o.isMesh && o.material && o.userData.baseColor) {
          o.material.color.copy(o.userData.baseColor).multiply(tint);
        }
      });
    }
    this.gs.showCellHighlight(c, r, ok);
    if (item !== 'obstacle' && TOWERS[item]) {
      this.gs.showRange(w.x, w.z, TOWERS[item].range, ok ? 'ok' : 'bad');
    } else {
      this.gs.hideRange();
    }
  }

  clearGhost() {
    if (this.ghost) { this.scene.remove(this.ghost.group); this.ghost = null; }
    this.gs.hideCellHighlight();
    this.gs.hideRange();
  }

  // ---------------- per-frame ----------------

  update(dt, camera, selfPos = null) {
    this.time += dt;
    // pulse the coins' own glow so they shimmer for attention
    if (this.goldMat) this.goldMat.emissiveIntensity = 0.6 + Math.sin(this.time * 4) * 0.35;
    this.updateNpcs(dt, selfPos);
    this.updateShowPets(dt);
    this.updatePets(dt);
    // countdown to the armed portal arrival (see beginArrival)
    if (this.arrivalArmed) {
      this.arrivalT -= dt;
      if (this.arrivalT <= 0) this.fireArrival();
    }
    this.updatePortal(dt);
    this.animateStatusFx(dt);

    for (const a of this.players.values()) {
      // materializing out of the arrival portal: pop-in scale (spawnT
      // starts slightly negative so the portal opens first)
      if (a.spawnT != null) {
        a.spawnT += dt;
        if (a.spawnT < 0) {
          a.group.scale.setScalar(0.01);
        } else {
          const k = Math.min(a.spawnT / 0.55, 1);
          const s = k * (1 + 0.16 * Math.sin(k * Math.PI));
          a.group.scale.setScalar(Math.max(s, 0.01));
          if (k >= 1) { a.spawnT = null; a.group.scale.setScalar(1); }
        }
      }
      // orbiting stone slabs of the tanker's wall mode
      if (a.wallFx) {
        a.wallFx.rotation.y += dt * 1.7;
        a.wallFx.userData.stone.opacity = 0.75 + Math.sin(this.time * 5) * 0.2;
      }
      if (a.jumpT == null) continue;
      a.jumpT += dt;
      const k = Math.min(a.jumpT / a.jumpDur, 1);
      a.group.position.y = (a.baseY || 0) + Math.sin(k * Math.PI) * (a.jumpH || JUMP.HEIGHT);
      if (k >= 1) { a.jumpT = null; a.group.position.y = a.baseY || 0; }
    }
    // vaulting vampires get the same arc (runs after applySnapshot, so
    // it overrides the grounded y the snapshot wrote)
    for (const a of this.enemies.values()) {
      if (a.jumpT == null) continue;
      a.jumpT += dt;
      const k = Math.min(a.jumpT / a.jumpDur, 1);
      a.group.position.y = Math.sin(k * Math.PI) * JUMP.HEIGHT;
      if (k >= 1) { a.jumpT = null; a.group.position.y = 0; }
    }

    // tombs rising out of the earth
    for (const g of this.graves.values()) {
      if (g.riseT == null) continue;
      g.riseT += dt;
      const k = Math.min(g.riseT / 0.55, 1);
      g.group.position.y = -1.3 * (1 - easeOut(k));
      if (k >= 1) { g.riseT = null; g.group.position.y = 0; }
    }

    for (const group of [this.players, this.enemies]) {
      for (const a of group.values()) {
        a.mixer.update(dt);
        // hit flash
        if (a.flashT > 0) {
          a.flashT -= dt;
          const k = Math.max(a.flashT / 0.12, 0);
          for (const m of a.mats) {
            if (m.emissive) { m.emissive.setRGB(k, k * 0.9, k * 0.8); m.emissiveIntensity = 1; }
          }
        }
        if (a.hpBar) {
          // true billboard: cancel the actor's rotation first, so the
          // bar faces the camera even when the model walks away from it
          a.hpBar.quaternion
            .copy(a.group.quaternion)
            .invert()
            .multiply(camera.quaternion);
        }
      }
    }

    // tower turret rotation
    for (const a of this.towers.values()) {
      if (typeof a.targetRot === 'number') {
        a.rot = angleLerp(a.rot, a.targetRot, Math.min(dt * 8, 1));
        a.weapon.rotation.y = a.rot;
      }
    }

    // projectiles
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.t += dt;
      const k = Math.min(p.t / p.ft, 1);
      const pos = p.mesh.position;
      pos.lerpVectors(p.from, p.to, k);
      const arcH = p.lob ? p.from.distanceTo(p.to) * 0.32 : (p.kind === 'arrow' ? 0.6 : 0);
      pos.y += Math.sin(k * Math.PI) * arcH;
      if (p.kind === 'arrow') {
        const ahead = new THREE.Vector3().lerpVectors(p.from, p.to, Math.min(k + 0.05, 1));
        ahead.y += Math.sin(Math.min(k + 0.05, 1) * Math.PI) * arcH;
        p.mesh.lookAt(ahead); // the arrow model's long axis is +Z
      } else {
        p.mesh.rotation.x += dt * 7;
      }
      if (k >= 1) {
        this.scene.remove(p.mesh);
        this.projectiles.splice(i, 1);
      }
    }

    // effects
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const e = this.effects[i];
      e.t += dt;
      if (e.type === 'delayed-burst') {
        if (e.t >= 0) {
          this.burst(e.x, e.z, e.r, e.color);
          this.effects.splice(i, 1);
        }
        continue;
      }
      const k = e.t / e.dur;
      if (k >= 1) {
        this.scene.remove(e.mesh);
        this.effects.splice(i, 1);
        continue;
      }
      if (e.type === 'burst') {
        e.mesh.scale.setScalar(0.2 + (e.r - 0.2) * easeOut(k));
        e.mesh.material.opacity = 0.85 * (1 - k);
      } else if (e.type === 'warn') {
        e.mesh.material.opacity = 0.22 + Math.sin(this.time * 10) * 0.08;
      } else if (e.type === 'bats') {
        // swarm rides along with the vampire, spiraling out and up
        if (e.actor) e.mesh.position.copy(e.actor.group.position);
        for (const b of e.bats) {
          const ang = b.a + this.time * b.spin;
          const rad = b.rad + k * 1.3;
          b.bat.position.set(Math.cos(ang) * rad, b.y0 + k * b.rise, Math.sin(ang) * rad);
          const f = Math.sin(this.time * b.flap) * 0.85;
          b.wings[0].rotation.z = f;
          b.wings[1].rotation.z = -f;
        }
        e.mat.opacity = 0.95 * (1 - k * k);
      } else if (e.type === 'grave-sink') {
        e.mesh.position.y = -1.3 * easeOut(k);
      } else if (e.type === 'float-text') {
        e.mesh.position.y = (e.mesh.userData.baseY || 0) + 1.35 + easeOut(k) * 0.85;
        e.mesh.material.opacity = 1 - k * k;
      } else if (e.type === 'slash') {
        // sweep the arc across the front and fade it out
        e.mesh.rotation.y = e.baseYaw - 0.55 + easeOut(k) * 1.2;
        e.inner.material.opacity = 0.9 * (1 - k * k);
        e.inner.scale.setScalar(1 + k * 0.25);
      } else if (e.type === 'thrust') {
        // lunge the lance forward then fade (a stab)
        e.inner.position.z = 0.35 + easeOut(k) * 0.7;
        e.inner.material.opacity = 0.9 * (1 - k);
      } else if (e.type === 'slam') {
        // hammer's vertical smash streak drops and fades fast
        e.inner.material.opacity = 0.85 * (1 - k);
        e.inner.scale.y = 1 - k * 0.6;
      } else if (e.type === 'zap') {
        e.mesh.material.opacity = 0.95 * (1 - k);
      } else if (e.type === 'flamejet') {
        // embers race along the jet line, spreading sideways as they go
        for (const p of e.parts) {
          const kk = (k + p.k) % 1;
          const px = lerp(e.x, e.tx, kk), pz = lerp(e.z, e.tz, kk);
          // perpendicular spread widens toward the tip of the spray
          const dx = e.tx - e.x, dz = e.tz - e.z;
          const len = Math.hypot(dx, dz) || 1;
          p.spr.position.set(
            px + (-dz / len) * p.side * kk,
            0.75 + kk * 0.3,
            pz + (dx / len) * p.side * kk
          );
          p.spr.scale.setScalar(0.13 + kk * 0.3);
        }
      } else if (e.type === 'gfire') {
        // flames flicker on the burning ground, fading near the end
        const fade = k > 0.75 ? 1 - (k - 0.75) / 0.25 : 1;
        e.disc.material.opacity = 0.3 * fade;
        for (const spr of e.parts) {
          const kk = (this.time * 1.4 + spr.userData.phase) % 1;
          spr.position.y = 0.1 + kk * 0.7;
          spr.scale.setScalar(0.26 * (1 - kk * 0.7) * fade);
        }
      }
    }

    // corpses
    for (let i = this.corpses.length - 1; i >= 0; i--) {
      const c = this.corpses[i];
      c.t += dt;
      c.actor.mixer.update(dt);
      if (c.t > 0.9) c.actor.group.position.y -= dt * 0.9;
      if (c.t > 1.6) {
        this.scene.remove(c.actor.group);
        this.corpses.splice(i, 1);
      }
    }
  }

  reset() {
    for (const a of this.players.values()) {
      if (a.customTex) a.customTex.dispose();
      this.scene.remove(a.group);
    }
    for (const id of [...this.pets.keys()]) this.removePet(id);
    for (const a of this.enemies.values()) this.scene.remove(a.group);
    for (const a of this.towers.values()) this.scene.remove(a.group);
    for (const g of this.obstacles.values()) this.scene.remove(g);
    for (const g of this.graves.values()) this.scene.remove(g.group);
    for (const p of this.projectiles) this.scene.remove(p.mesh);
    for (const e of this.effects) if (e.mesh) this.scene.remove(e.mesh);
    for (const c of this.corpses) this.scene.remove(c.actor.group);
    this.players.clear(); this.enemies.clear(); this.towers.clear();
    this.obstacles.clear(); this.graves.clear();
    this.projectiles = []; this.effects = []; this.corpses = [];
    this.xpOrbs.count = 0; this.ptsOrbs.count = 0; this.goldOrbs.count = 0;
    this.goldSparkle.count = 0;
    if (this.portalFx) {
      this.scene.remove(this.portalFx.disc, this.portalFx.beam, this.portalFx.light);
      this.portalFx = null;
    }
    this.clearGhost();
  }
}

const easeOut = (t) => 1 - Math.pow(1 - t, 3);

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// the fill-based class glyphs are authored in a 512×512 viewBox; parse
// their paths once and stamp them onto the label canvas at any size.
const CLASS_GLYPH_CACHE = {};
function classGlyphPaths(cls) {
  if (!(cls in CLASS_GLYPH_CACHE)) {
    CLASS_GLYPH_CACHE[cls] = iconPaths('cls-' + cls).map((d) => new Path2D(d));
  }
  return CLASS_GLYPH_CACHE[cls];
}

function drawClassGlyph(ctx, cls, x, y, size, color) {
  const paths = classGlyphPaths(cls);
  if (!paths.length) return;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 512, size / 512);
  ctx.fillStyle = color;
  for (const p of paths) ctx.fill(p);
  ctx.restore();
}
