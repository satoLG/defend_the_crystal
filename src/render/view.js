import * as THREE from 'three';
import { instantiate } from './assets.js';
import { buildTexture, applyTexture } from './customize.js';
import { iconPaths } from '../icons.js';
import { CLASSES, TOWERS, JUMP, ENEMIES, BOSSES } from '../config.js';
import { cellToWorld, CRYSTAL_POS, HALF_H, PLAZA } from '../sim/grid.js';
import { lerp, angleLerp } from '../utils.js';
import { sfx } from '../audio.js';

// ============================================================
// Turns simulation snapshots + one-shot events into moving,
// animated, glowing things on screen. Pure visuals — no game
// rules live here.
// ============================================================

const PL = { ID: 0, CLS: 1, X: 2, Z: 3, YAW: 4, HP: 5, MHP: 6, LVL: 7, XP: 8, XPN: 9, MOV: 10, DEAD: 11, RESP: 12, OBST: 13, KILLS: 14, NAME: 15, SKCD: 16, WALL: 17, ATK: 18 };
const EN = { ID: 0, KIND: 1, X: 2, Z: 3, YAW: 4, HP: 5, MHP: 6, SCALE: 7, BOSS: 8, MOV: 9 };

// Hand props live in BONE space: raw Kenney units, grip at the origin.
// The hand sits ~0.14 units down the arm bone; rot compensates the
// arm's resting tilt so weapons read upright and stay visible.
export const CLASS_PROPS = {
  berserker: [{ gen: makeAxe, label: 'Axe', bone: 'arm-right', pos: [-0.225, 0.01, 0.09], rot: [0.66, 0.6, -0.45], scale: 1 }],
  tanker: [
    { key: 'prop-sword', label: 'Sword', bone: 'arm-right', pos: [-0.225, 0.065, 0.115], rot: [0.54, 1.09, 0.11], scale: 0.94 },
    { key: 'prop-shield', label: 'Shield', bone: 'arm-left', pos: [0.175, 0.055, 0.195], rot: [-0.26, 0.29, -0.2], scale: 1.32 },
  ],
  archer: [
    { gen: makeBow, label: 'Bow', bone: 'arm-right', pos: [0.02, -0.155, 0.255], rot: [-2.78, 0.23, -1], scale: 1.6 },
    { gen: makeQuiver, label: 'Quiver', bone: 'torso', pos: [-0.145, 0.055, -0.12], rot: [-0.02, -0.81, 0.41], scale: 1.03 },
  ],
  mage: [{ key: 'prop-staff', label: 'Staff', bone: 'arm-right', pos: [-0.225, 0.29, 0.175], rot: [0, 0.35, 3.142], scale: 1.32, crystalTip: true }],
};

// The real bow model (Bow.glb). It's authored on its side with an odd
// FBX2glTF node scale, so normalize at runtime: stand the long axis up
// (+Y), face the limbs forward (+Z), drop the grip on the origin and
// scale to a hand-prop height — matching the convention the archer's
// prop transform expects.
export function makeBow() {
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
  holder.scale.setScalar(0.5 / Math.max(size.y, 1e-3)); // ~0.5 units tall
  return holder;
}

// The survival-kit axe (axe.glb) comes from a different Kenney kit than
// the mini characters, so its authored units don't match bone space.
// Normalize it the same way makeBow does: stand the long axis (handle)
// upright, drop the grip on the origin (sitting low on the handle so it
// reads like it's being held) and scale to a hand-prop height.
export function makeAxe() {
  const inner = instantiate('prop-axe', { shadows: false }).group;
  const pre = new THREE.Box3().setFromObject(inner);
  const s = pre.getSize(new THREE.Vector3());
  // whichever axis is longest is the handle — rotate it upright (+Y)
  if (s.x >= s.y && s.x >= s.z) inner.rotation.z = Math.PI / 2;
  else if (s.z >= s.y && s.z >= s.x) inner.rotation.x = Math.PI / 2;

  const holder = new THREE.Group();
  holder.add(inner);
  const box = new THREE.Box3().setFromObject(holder);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  inner.position.sub(center);            // center to origin…
  inner.position.y += size.y * 0.28;     // …then bias so the grip sits low
  holder.scale.setScalar(0.6 / Math.max(size.y, 1e-3)); // ~0.6 units tall
  return holder;
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

// Parent hand props onto a character's bones. Shared by the in-game
// actors and the character-creation preview.
export function attachProps(group, specs) {
  for (const spec of specs || []) {
    const bone = group.getObjectByName(spec.bone);
    if (!bone) continue;
    const holder = new THREE.Group();
    holder.add(spec.gen ? spec.gen() : instantiate(spec.key, { shadows: false }).group);
    if (spec.crystalTip) {
      // glowing crystal nestled in the staff's hook (values dialed in
      // with a dev overlay while tuning weapon placement, relative to
      // the staff holder)
      const tip = instantiate('prop-crystal', { shadows: false, cloneMaterials: true }).group;
      tip.scale.setScalar(0.45);
      tip.position.set(0, 0.055, -0.005);
      tip.rotation.set(-3.15, 0.29, 0.05);
      tip.traverse((o) => {
        if (o.isMesh && o.material.emissive) {
          o.material.emissive.set(0x8a2be2);
          o.material.emissiveIntensity = 0.7;
        }
      });
      holder.add(tip);
    }
    // raw props: bone space == raw model units, and the bone already
    // carries the character's scale, so placement is direct
    holder.scale.setScalar(spec.scale || 1);
    holder.position.set(spec.pos[0], spec.pos[1], spec.pos[2]);
    holder.rotation.set(spec.rot[0], spec.rot[1], spec.rot[2]);
    bone.add(holder);
  }
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
  keeper: [{ key: 'prop-shovel', bone: 'arm-right', pos: [-0.225, 0.01, 0.09], rot: [0.66, 0.6, -0.45], scale: 0.9 }],
  // skeleton archers hold the bow & quiver identically to the player archer
  archer: CLASS_PROPS.archer,
  // Zé do Caixão hauls his own coffin on his back
  coffin: [{ key: 'prop-coffin', bone: 'torso', pos: [0, -0.18, -0.16], rot: [-Math.PI / 2, 0, 0.12], scale: 0.7 }],
};

// tower base color per upgrade level: grey→blue→green→red→purple→gold
const TOWER_LEVEL_COLORS = [0x9aa1ab, 0x4a86e8, 0x3fbf5f, 0xe0503a, 0x9a4ae0, 0xe8b84b];
const TOWERS_MAX_VISUAL = 6;

export class GameView {
  constructor(gameScene) {
    this.gs = gameScene;
    this.scene = gameScene.scene;
    this.players = new Map();   // id -> actor
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
    this.ptsOrbs = mkOrbs(new THREE.IcosahedronGeometry(0.16), 0x5ab8ff);
    this.npcs = [];
    this.spawnNpcs();
    this._orbMat = new THREE.Matrix4();
    this._orbPos = new THREE.Vector3();
    this._orbQuat = new THREE.Quaternion();
    this._orbEuler = new THREE.Euler();
    this._orbScale = new THREE.Vector3(1, 1, 1);
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
    this.attachProps(a, CLASS_PROPS[cls]);
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

    this.scene.add(a.group);
    this.players.set(id, a);
    this.setLoco(a, 'idle');
    return a;
  }

  // thin wrapper so existing callers using an actor still work
  attachProps(actor, specs) { attachProps(actor.group, specs); }

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

  ensureEnemy(row) {
    const id = row[EN.ID];
    let a = this.enemies.get(id);
    if (a) return a;
    const kind = row[EN.KIND];
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
      const bossName = BOSS_BY_KIND[kind]?.name || def.name || kind;
      const label = this.makeTextSprite(bossName.toUpperCase(), 0xffd24a, 2.1);
      label.position.y = (top + 0.62) / scale;
      a.group.add(label);
    }
    a.hpBar = this.makeHpBar(row[EN.BOSS] ? 1.3 : 0.85, (top + 0.25) / scale);
    a.hpBar.visible = false;
    a.group.add(a.hpBar);
    this.scene.add(a.group);
    this.enemies.set(id, a);
    this.setLoco(a, 'walk');
    return a;
  }

  // ---------------- sanctuary NPCs ----------------

  // two dwellers pottering around the plaza behind the crystal; pure
  // set dressing for now — walk up to them and they greet you ("Oi!")
  spawnNpcs() {
    const defs = [
      { model: 'char-mage', name: 'Mira', tint: 0x8fd8c8, x: -3.1, z: HALF_H + PLAZA.DEPTH * 0.56, yaw: 0.8 },
      { model: 'char-tanker', name: 'Bento', tint: 0xd8b06a, x: 2.3, z: HALF_H + PLAZA.DEPTH * 0.24, yaw: -0.7 },
    ];
    for (const d of defs) {
      const a = this.makeAnimated(d.model);
      a.group.position.set(d.x, 0, d.z);
      a.group.rotation.y = d.yaw;
      // dye the outfit so they don't read as one of the player classes
      for (const m of a.mats) m.color.multiply(new THREE.Color(d.tint));
      const label = this.makeTextSprite(d.name, 0xffe9b8, 2.2);
      label.position.y = 2.0;
      a.group.add(label);
      const bubble = this.makeTextSprite('Oi!', 0xffffff, 1.5);
      bubble.position.y = 2.5;
      bubble.visible = false;
      a.group.add(bubble);
      a.bubble = bubble;
      a.homeYaw = d.yaw;
      this.scene.add(a.group);
      this.setLoco(a, 'idle');
      this.npcs.push(a);
    }
  }

  updateNpcs(dt, selfPos) {
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
    let a = this.towers.get(id);
    if (a && a.lvl !== lvl) { this.removeTowerActor(id); a = null; }
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

    const weapon = instantiate(TOWERS[kind]?.model || 'tower-ballista').group;
    weapon.position.y = 0.55;
    weapon.scale.setScalar(1 + (lvl - 1) * 0.07);
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
    a = { group, weapon, lvl, kind, c, r, rot: Math.PI };
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
      a.group.visible = !dead;
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
    }
    for (const [id, a] of this.players) {
      if (!seenP.has(id)) { this.scene.remove(a.group); this.players.delete(id); }
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
      a.group.position.y = a.isGhost ? 0.25 + Math.sin(this.time * 3 + id) * 0.12 : 0;
      a.group.rotation.y = yaw;
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
    }
    for (const [id, a] of this.enemies) {
      if (!seenE.has(id)) { this.scene.remove(a.group); this.enemies.delete(id); }
    }

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

  // rows: [id, owner, kind(0=xp 1=pts), x, z] — only own orbs are drawn
  updateDrops(prevRows, rows, alpha, selfId) {
    const prevMap = new Map();
    if (prevRows) for (const r of prevRows) prevMap.set(r[0], r);
    let xi = 0, pi = 0;
    if (rows) {
      for (const row of rows) {
        if (row[1] !== selfId) continue;
        const isXp = row[2] === 0;
        const i = isXp ? xi : pi;
        if (i >= this.dropCap) continue;
        let x = row[3], z = row[4];
        const p = prevMap.get(row[0]);
        if (p) { x = lerp(p[3], x, alpha); z = lerp(p[4], z, alpha); }
        this._orbPos.set(x, 0.32 + Math.sin(this.time * 3.5 + row[0] * 1.7) * 0.09, z);
        this._orbEuler.set(0, this.time * 2.2 + row[0], 0);
        this._orbMat.compose(
          this._orbPos, this._orbQuat.setFromEuler(this._orbEuler), this._orbScale
        );
        (isXp ? this.xpOrbs : this.ptsOrbs).setMatrixAt(i, this._orbMat);
        if (isXp) xi++; else pi++;
      }
    }
    this.xpOrbs.count = xi;
    this.ptsOrbs.count = pi;
    this.xpOrbs.instanceMatrix.needsUpdate = true;
    this.ptsOrbs.instanceMatrix.needsUpdate = true;
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
        // melee swings get a visible slash arc + swing sound
        // (ev.r marks ranged enemy attacks: arrows / lobbed pumpkins)
        const isMelee = a.cls ? (a.cls === 'berserker' || a.cls === 'tanker') : !ev.r;
        if (isMelee) {
          this.spawnSlash(
            a.group.position.x, a.group.position.z, a.group.rotation.y,
            a.cls ? 0xffe9a8 : 0xff9a8a
          );
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
    const stone = new THREE.MeshStandardMaterial({
      color: 0x9aa1ab, roughness: 0.9, flatShading: true,
      transparent: true, opacity: 0.9,
    });
    const slabGeo = new THREE.BoxGeometry(0.34, 0.52, 0.12);
    for (let i = 0; i < 6; i++) {
      const slab = new THREE.Mesh(slabGeo, stone);
      const ang = (i / 6) * Math.PI * 2;
      slab.position.set(Math.cos(ang) * 0.85, 0.55, Math.sin(ang) * 0.85);
      slab.rotation.y = -ang;
      g.add(slab);
    }
    const ring = new THREE.Mesh(
      this._ringGeo,
      new THREE.MeshBasicMaterial({
        color: 0xbfc8d4, transparent: true, opacity: 0.55,
        depthWrite: false, side: THREE.DoubleSide,
      })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.04;
    g.add(ring);
    g.userData.stone = stone;
    a.group.add(g);
    a.wallFx = g;
  }

  removeWallAura(a) {
    a.group.remove(a.wallFx);
    a.wallFx = null;
  }

  // vertical arc while the character vaults a grid cell; x/z motion
  // comes from the snapshot (or local prediction for the own player)
  startJump(id, dur) {
    const a = this.players.get(id);
    if (!a) return;
    a.jumpT = 0;
    a.jumpDur = dur || JUMP.DUR;
    if (a.actions.jump) this.playOnce(a, 'jump', a.jumpDur);
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
    holder.position.set(x, 0, z);
    arc.position.set(0, 0.75, 0);
    // ring theta 0 is +X; rotate so the arc opens toward the facing direction
    holder.rotation.y = yaw - Math.PI / 2;
    this.scene.add(holder);
    this.effects.push({ mesh: holder, inner: arc, t: 0, dur: 0.22, type: 'slash', baseYaw: holder.rotation.y });
  }

  spawnProjectile(ev) {
    if (ev.k === 'magic') {
      // glowing bolt from the mage's staff (ev.big: the skill's
      // giant arcane orb — same bolt, way scaled up)
      const s = ev.big ? 2.8 : 1;
      const bolt = new THREE.Group();
      const core = new THREE.Mesh(
        new THREE.SphereGeometry(0.16 * s, 10, 10),
        new THREE.MeshBasicMaterial({ color: 0xe6c4ff })
      );
      const halo = new THREE.Mesh(
        new THREE.SphereGeometry(0.3 * s, 10, 10),
        new THREE.MeshBasicMaterial({
          color: 0xa050ff, transparent: true, opacity: 0.45,
          blending: THREE.AdditiveBlending, depthWrite: false,
        })
      );
      bolt.add(core, halo);
      this.scene.add(bolt);
      this.projectiles.push({
        mesh: bolt,
        from: new THREE.Vector3(...ev.f),
        to: new THREE.Vector3(...ev.to),
        ft: Math.max(ev.ft, 0.05),
        t: 0, lob: false, kind: 'magic',
      });
      return;
    }
    const key = {
      arrow: 'ammo-arrow', cannonball: 'ammo-cannonball',
      boulder: 'ammo-boulder', pumpkin: 'prop-pumpkin',
    }[ev.k] || 'ammo-arrow';
    const mesh = instantiate(key, { shadows: false }).group;
    if (ev.k === 'boulder') mesh.scale.setScalar(1.5);
    if (ev.k === 'arrow') mesh.scale.setScalar(0.55);
    if (ev.k === 'pumpkin') mesh.scale.setScalar(1.6);
    this.scene.add(mesh);
    this.projectiles.push({
      mesh,
      from: new THREE.Vector3(...ev.f),
      to: new THREE.Vector3(...ev.to),
      ft: Math.max(ev.ft, 0.05),
      t: 0,
      lob: !!ev.lob,
      kind: ev.k,
    });
  }

  spawnAoe(ev) {
    const color = { mage: 0xc07dff, cannonball: 0xffa040, boulder: 0xcfa070, pumpkin: 0xff8c1a }[ev.k] || 0xffffff;
    if (ev.ft > 0) {
      // telegraph circle, then burst
      const warn = new THREE.Mesh(
        this._discGeo,
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, depthWrite: false })
      );
      warn.rotation.x = -Math.PI / 2;
      warn.position.set(ev.x, 0.05, ev.z);
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
    ring.position.set(x, 0.08, z);
    ring.scale.setScalar(0.2);
    this.scene.add(ring);
    this.effects.push({ mesh: ring, t: 0, dur: 0.35, type: 'burst', r });
  }

  // ---------------- build ghost ----------------

  setGhost(item, c, r, ok) {
    this.clearGhost();
    if (!item || c == null) return;
    const key = item === 'obstacle' ? 'obstacle-rocks' : TOWERS[item]?.model;
    if (!key) return;
    const g = instantiate(key, { cloneMaterials: true, shadows: false }).group;
    const w = cellToWorld(c, r);
    g.position.set(w.x, 0.02, w.z);
    g.traverse((o) => {
      if (o.isMesh && o.material) {
        o.material.transparent = true;
        o.material.opacity = 0.55;
        o.material.color.multiply(new THREE.Color(ok ? 0x9fff9f : 0xff8f8f));
      }
    });
    this.scene.add(g);
    this.ghost = g;
    this.gs.showCellHighlight(c, r, ok);
    if (item !== 'obstacle' && TOWERS[item]) {
      this.gs.showRange(w.x, w.z, TOWERS[item].range);
    } else {
      this.gs.hideRange();
    }
  }

  clearGhost() {
    if (this.ghost) { this.scene.remove(this.ghost); this.ghost = null; }
    this.gs.hideCellHighlight();
    this.gs.hideRange();
  }

  // ---------------- per-frame ----------------

  update(dt, camera, selfPos = null) {
    this.time += dt;
    this.updateNpcs(dt, selfPos);

    for (const a of this.players.values()) {
      // orbiting stone slabs of the tanker's wall mode
      if (a.wallFx) {
        a.wallFx.rotation.y += dt * 1.7;
        a.wallFx.userData.stone.opacity = 0.75 + Math.sin(this.time * 5) * 0.2;
      }
      if (a.jumpT == null) continue;
      a.jumpT += dt;
      const k = Math.min(a.jumpT / a.jumpDur, 1);
      a.group.position.y = Math.sin(k * Math.PI) * JUMP.HEIGHT;
      if (k >= 1) { a.jumpT = null; a.group.position.y = 0; }
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
      } else if (e.type === 'slash') {
        // sweep the arc across the front and fade it out
        e.mesh.rotation.y = e.baseYaw - 0.55 + easeOut(k) * 1.2;
        e.inner.material.opacity = 0.9 * (1 - k * k);
        e.inner.scale.setScalar(1 + k * 0.25);
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
    this.xpOrbs.count = 0; this.ptsOrbs.count = 0;
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
