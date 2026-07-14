import * as THREE from 'three';
import { instantiate } from './assets.js';
import { attachProps, makeBow, makeQuiver, CLASS_PROPS } from './view.js';
import { buildTexture, applyTexture } from './customize.js';
import { CLASSES } from '../config.js';

// ============================================================
// A little turntable used by the character-creation screen:
// the chosen class model idling and free to spin under a finger,
// with that class's weapons displayed on a stand beside it. It
// runs its own tiny renderer, started/stopped as the screen is
// shown/hidden so it never competes with the match render loop.
// ============================================================

export class CharacterPreview {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = false;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    this.camera.position.set(0.15, 1.05, 3.5);
    this.camLook = new THREE.Vector3(0.15, 0.82, 0);

    this.scene.add(new THREE.HemisphereLight(0xbfc6ff, 0x30263f, 1.5));
    const key = new THREE.DirectionalLight(0xfff2d6, 2.1);
    key.position.set(2.5, 4, 3);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x88aaff, 1.1);
    rim.position.set(-3, 2, -2);
    this.scene.add(rim);

    // soft pedestal disc under each display
    const discMat = new THREE.MeshBasicMaterial({ color: 0x2a2440, transparent: true, opacity: 0.55 });
    for (const dx of [-0.55, 0.95]) {
      const disc = new THREE.Mesh(new THREE.CircleGeometry(0.7, 40), discMat);
      disc.rotation.x = -Math.PI / 2;
      disc.position.set(dx, 0.01, 0);
      this.scene.add(disc);
    }

    this.charPivot = new THREE.Group();
    this.charPivot.position.x = -0.55;
    this.scene.add(this.charPivot);
    this.weaponPivot = new THREE.Group();
    this.weaponPivot.position.set(0.95, 0.85, 0);
    this.scene.add(this.weaponPivot);

    this.actor = null;
    this.clock = new THREE.Clock();
    this.running = false;
    this.cls = null;
    this.colors = {};

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
    attachProps(inst.group, CLASS_PROPS[cls]);
    this.actor = { group: inst.group, mixer, modelKey };
    this.charPivot.add(inst.group);
    this.charPivot.rotation.y = 0.3;
    this.setColors(this.colors);
    this._buildWeapons(cls);
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

  _buildWeapons(cls) {
    this.weaponPivot.clear();
    const P = (key, s = 1) => { const g = instantiate(key, { shadows: false }).group; g.scale.multiplyScalar(s); return g; };
    const place = (obj, x, y, rot = [0, 0, 0]) => { obj.position.set(x, y, 0); obj.rotation.set(rot[0], rot[1], rot[2]); this.weaponPivot.add(obj); };
    const S = 2.4;
    if (cls === 'berserker') {
      place(P('prop-sword', S), 0, 0, [0, 0, 0.12]);
    } else if (cls === 'tanker') {
      place(P('prop-sword', S * 0.9), -0.2, 0, [0, 0, 0.12]);
      place(P('prop-shield', S * 0.95), 0.22, 0, [Math.PI / 2, 0, 0]);
    } else if (cls === 'archer') {
      const bow = makeBow();
      bow.scale.multiplyScalar(1.7);
      place(bow, -0.05, 0, [0, 0, 0]);
      const quiver = makeQuiver();
      quiver.scale.multiplyScalar(1.7);
      place(quiver, 0.28, -0.1, [0, 0, -0.15]);
    } else if (cls === 'mage') {
      const staff = P('prop-staff', S);
      place(staff, 0, -0.1, [Math.PI, 0, 0]);
      const tip = instantiate('prop-crystal', { shadows: false, cloneMaterials: true }).group;
      tip.scale.setScalar(0.9);
      tip.position.set(0, 0.42, 0);
      tip.traverse((o) => {
        if (o.isMesh && o.material.emissive) { o.material.emissive.set(0x8a2be2); o.material.emissiveIntensity = 0.8; }
      });
      this.weaponPivot.add(tip);
    }
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
      this.weaponPivot.rotation.y += dt * 0.7;
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
