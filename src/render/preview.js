import * as THREE from 'three';
import { instantiate } from './assets.js';
import { attachProps, CLASS_PROPS } from './view.js';
import { buildTexture, applyTexture } from './customize.js';
import { CLASSES } from '../config.js';

// ============================================================
// A little turntable used by the character-creation screen: the
// chosen class model idling (weapons already in hand) and free to
// spin under a finger. It runs its own tiny renderer, started/
// stopped as the screen is shown/hidden so it never competes with
// the match render loop.
// ============================================================

export class CharacterPreview {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = false;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
    this.camera.position.set(0, 1.05, 3.25);
    this.camLook = new THREE.Vector3(0, 0.82, 0);

    this.scene.add(new THREE.HemisphereLight(0xbfc6ff, 0x30263f, 1.5));
    const key = new THREE.DirectionalLight(0xfff2d6, 2.1);
    key.position.set(2.5, 4, 3);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x88aaff, 1.1);
    rim.position.set(-3, 2, -2);
    this.scene.add(rim);

    // soft pedestal disc under the hero
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(0.7, 40),
      new THREE.MeshBasicMaterial({ color: 0x2a2440, transparent: true, opacity: 0.55 })
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(0, 0.01, 0);
    this.scene.add(disc);

    this.charPivot = new THREE.Group();
    this.scene.add(this.charPivot);

    this.actor = null;
    this.clock = new THREE.Clock();
    this.running = false;
    this.cls = null;
    this.colors = {};
    this.onPropsChanged = null; // (cls) => void — fired when weapons rebuild

    this._bindDrag();
    window.addEventListener('resize', () => this.resize());
  }

  _bindDrag() {
    let dragging = false, lastX = 0;
    const down = (x) => { dragging = true; lastX = x; };
    const move = (x) => {
      if (!dragging) return;
      this.charPivot.rotation.y += (x - lastX) * 0.01;
      lastX = x;
    };
    const up = () => { dragging = false; };
    this.canvas.addEventListener('pointerdown', (e) => { this.canvas.setPointerCapture?.(e.pointerId); down(e.clientX); });
    this.canvas.addEventListener('pointermove', (e) => move(e.clientX));
    this.canvas.addEventListener('pointerup', up);
    this.canvas.addEventListener('pointercancel', up);
  }

  // ---- content -------------------------------------------------

  setClass(cls, colors) {
    this.colors = colors || {};
    if (this.cls === cls) { this.setColors(this.colors); return; }
    this.cls = cls;
    // rebuild character
    if (this.actor) this.charPivot.remove(this.actor.group);
    const modelKey = CLASSES[cls]?.model || 'char-berserker';
    const inst = instantiate(modelKey, { cloneMaterials: true, shadows: false });
    const mixer = new THREE.AnimationMixer(inst.group);
    const idle = inst.animations.find((c) => c.name === 'idle') || inst.animations[0];
    if (idle) mixer.clipAction(idle).play();
    const specs = CLASS_PROPS[cls] || [];
    const holders = attachProps(inst.group, specs);
    // flat list of everything the tuner can nudge: each weapon holder,
    // plus the mage's crystal (a child of the staff holder, so its
    // transform is measured relative to the staff)
    const tunables = [];
    specs.forEach((s, i) => {
      const h = holders[i];
      tunables.push({ kind: 'prop', obj: h, spec: s });
      const tip = h && h.userData.crystalTip;
      if (tip) tunables.push({ kind: 'crystal', obj: tip, spec: s });
    });
    this.actor = { group: inst.group, mixer, modelKey, specs, holders, tunables };
    this.charPivot.add(inst.group);
    this.charPivot.rotation.y = 0.3;
    this.setColors(this.colors);
    this.onPropsChanged?.(cls);
  }

  // ---- weapon tuning (used by the dev overlay) ----------------

  // Snapshot of the current class's tunables (weapons + the mage crystal):
  // current transforms plus enough metadata to label controls and emit code.
  getProps() {
    const items = this.actor?.tunables || [];
    return items.map((t, i) => {
      const s = t.spec;
      const o = t.obj;
      const label = s.label || (s.key ? s.key.replace('prop-', '') : 'prop');
      if (t.kind === 'crystal') {
        return {
          i, kind: 'crystal', label: `${label} · Crystal`, bone: s.bone, source: 'crystal',
          crystalTip: false,
          pos: o ? [o.position.x, o.position.y, o.position.z] : [0, 0, 0],
          rot: o ? [o.rotation.x, o.rotation.y, o.rotation.z] : [0, 0, 0],
          scale: o ? o.scale.x : 1,
          available: !!o,
        };
      }
      return {
        i, kind: 'prop', label, bone: s.bone,
        source: s.gen ? `gen:${s.gen.name}` : `key:${s.key}`,
        crystalTip: !!s.crystalTip,
        pos: [...s.pos], rot: [...s.rot], scale: s.scale ?? 1,
        available: !!o,
      };
    });
  }

  // Live-nudge one tunable (weapon holder or crystal) by list index.
  setPropTransform(i, { pos, rot, scale } = {}) {
    const o = this.actor?.tunables?.[i]?.obj;
    if (!o) return;
    if (pos) o.position.set(pos[0], pos[1], pos[2]);
    if (rot) o.rotation.set(rot[0], rot[1], rot[2]);
    if (scale != null) o.scale.setScalar(scale);
  }

  setColors(colors) {
    this.colors = colors || {};
    if (!this.actor) return;
    let tex = null;
    try { tex = buildTexture(this.actor.modelKey, this.colors); } catch { tex = null; }
    applyTexture(this.actor.group, this.actor.modelKey, tex);
    if (this.actor.customTex && this.actor.customTex !== tex) this.actor.customTex.dispose();
    this.actor.customTex = tex;
  }

  // ---- lifecycle ----------------------------------------------

  start() {
    if (this.running) return;
    this.running = true;
    this.resize();
    this.clock.getDelta();
    const loop = () => {
      if (!this.running) return;
      this._raf = requestAnimationFrame(loop);
      const dt = Math.min(this.clock.getDelta(), 0.05);
      if (this.actor) this.actor.mixer.update(dt);
      this.camera.lookAt(this.camLook);
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}
