import * as THREE from 'three';
import { instantiate } from './assets.js';
import { CLASSES, TOWERS } from '../config.js';
import { cellToWorld, CRYSTAL_POS } from '../sim/grid.js';
import { lerp, angleLerp } from '../utils.js';
import { sfx } from '../audio.js';

// ============================================================
// Turns simulation snapshots + one-shot events into moving,
// animated, glowing things on screen. Pure visuals — no game
// rules live here.
// ============================================================

const PL = { ID: 0, CLS: 1, X: 2, Z: 3, YAW: 4, HP: 5, MHP: 6, LVL: 7, XP: 8, XPN: 9, MOV: 10, DEAD: 11, RESP: 12, OBST: 13, KILLS: 14, NAME: 15 };
const EN = { ID: 0, KIND: 1, X: 2, Z: 3, YAW: 4, HP: 5, MHP: 6, SCALE: 7, BOSS: 8, MOV: 9 };

const CLASS_PROPS = {
  berserker: [{ key: 'prop-sword', bone: 'arm-right', pos: [0.05, -0.22, 0.12], rot: [1.35, 0, 0] }],
  tanker: [
    { key: 'prop-sword', bone: 'arm-right', pos: [0.05, -0.22, 0.12], rot: [1.35, 0, 0] },
    { key: 'prop-shield', bone: 'arm-left', pos: [-0.1, -0.28, 0.3], rot: [-0.15, 0, 0] },
  ],
  archer: [{ key: 'ammo-arrow', bone: 'arm-right', pos: [0.03, -0.25, 0.2], rot: [Math.PI / 2, 0, 0], scale: 0.55 }],
  mage: [{ key: 'prop-staff', bone: 'arm-right', pos: [0.02, -0.28, 0.1], rot: [-0.1, 0, 0], crystalTip: true }],
};

const CLASS_TINT = {
  berserker: 0xff6a4d, tanker: 0x6a9cff, archer: 0x7de87d, mage: 0xc07dff,
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
    this.projectiles = [];
    this.effects = [];
    this.corpses = [];
    this.ghost = null;          // build-mode ghost preview
    this.time = 0;

    this._ringGeo = new THREE.RingGeometry(0.85, 1, 40);
    this._discGeo = new THREE.CircleGeometry(1, 32);
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

  makeNameLabel(name, lvl, tint) {
    const canvas = document.createElement('canvas');
    canvas.width = 384; canvas.height = 84;
    const ctx = canvas.getContext('2d');
    ctx.font = 'bold 52px "Trebuchet MS", sans-serif';
    ctx.textAlign = 'center';
    const text = `${name}  Lv${lvl}`;
    ctx.lineWidth = 8;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.strokeText(text, 192, 60);
    ctx.fillStyle = '#' + new THREE.Color(tint).getHexString();
    ctx.fillText(text, 192, 60);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false }));
    spr.scale.set(3.1, 0.68, 1);
    spr.renderOrder = 11;
    return spr;
  }

  ensurePlayer(row) {
    const id = row[PL.ID];
    let a = this.players.get(id);
    if (a) return a;
    const cls = row[PL.CLS];
    a = this.makeAnimated(CLASSES[cls]?.model || 'char-berserker');
    a.cls = cls;
    this.attachProps(a, cls);

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

    a.hpBar = this.makeHpBar(1.0, 1.75);
    a.group.add(a.hpBar);
    a.label = this.makeNameLabel(row[PL.NAME], row[PL.LVL], tint);
    a.label.position.y = 2.1;
    a.labelLvl = row[PL.LVL];
    a.labelName = row[PL.NAME];
    a.tint = tint;
    a.group.add(a.label);

    this.scene.add(a.group);
    this.players.set(id, a);
    this.setLoco(a, 'idle');
    return a;
  }

  attachProps(actor, cls) {
    for (const spec of CLASS_PROPS[cls] || []) {
      const bone = actor.group.getObjectByName(spec.bone);
      if (!bone) continue;
      const prop = instantiate(spec.key, { shadows: false });
      const holder = new THREE.Group();
      holder.add(prop.group);
      if (spec.crystalTip) {
        const tip = instantiate('prop-crystal', { shadows: false }).group;
        tip.position.y = 0.92;
        holder.add(tip);
      }
      // props were normalized in world units; bones inherit the
      // character's scale, so compensate
      const inv = 1 / actor.factor;
      holder.scale.setScalar(inv * (spec.scale || 1));
      holder.position.set(spec.pos[0], spec.pos[1], spec.pos[2]).multiplyScalar(inv);
      holder.rotation.set(spec.rot[0], spec.rot[1], spec.rot[2]);
      bone.add(holder);
    }
  }

  ensureEnemy(row) {
    const id = row[EN.ID];
    let a = this.enemies.get(id);
    if (a) return a;
    const kind = row[EN.KIND];
    a = this.makeAnimated(`enemy-${kind}`);
    a.kind = kind;
    const scale = row[EN.SCALE] || 1;
    a.group.scale.setScalar(scale);
    a.isGhost = kind === 'ghost';
    if (a.isGhost) {
      for (const m of a.mats) { m.transparent = true; m.opacity = 0.8; }
    }
    if (row[EN.BOSS] > 0) {
      const crown = new THREE.Mesh(
        new THREE.ConeGeometry(0.16, 0.22, 5),
        new THREE.MeshStandardMaterial({
          color: row[EN.BOSS] === 2 ? 0xffd24a : 0xff7a4a,
          emissive: row[EN.BOSS] === 2 ? 0xaa7a00 : 0x882200, emissiveIntensity: 0.8,
        })
      );
      crown.position.y = 1.75;
      a.group.add(crown);
    }
    a.hpBar = this.makeHpBar(row[EN.BOSS] ? 1.3 : 0.85, 1.55);
    a.hpBar.visible = false;
    a.group.add(a.hpBar);
    this.scene.add(a.group);
    this.enemies.set(id, a);
    this.setLoco(a, 'walk');
    return a;
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
      const a = this.ensurePlayer(row);
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
      this.setHpBar(a.hpBar, row[PL.HP] / row[PL.MHP]);
      if (a.labelLvl !== row[PL.LVL] || a.labelName !== row[PL.NAME]) {
        a.group.remove(a.label);
        a.label.material.map.dispose();
        a.label = this.makeNameLabel(row[PL.NAME], row[PL.LVL], a.tint);
        a.label.position.y = 2.1;
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
  }

  // ---------------- events ----------------

  handleEvent(ev) {
    switch (ev.t) {
      case 'atk': {
        const a = this.players.get(ev.id) || this.enemies.get(ev.id);
        if (!a) return;
        const name = a.cls
          ? { berserker: 'attack-melee-right', tanker: 'attack-melee-right', archer: 'holding-right-shoot', mage: 'interact-right' }[a.cls]
          : 'attack-melee-right';
        this.playOnce(a, name, 0.6);
        if (typeof ev.tx === 'number') {
          a.group.rotation.y = Math.atan2(ev.tx - a.group.position.x, ev.tz - a.group.position.z);
        }
        // melee swings get a visible slash arc + swing sound
        const isMelee = a.cls ? (a.cls === 'berserker' || a.cls === 'tanker') : true;
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
    }
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
      // glowing bolt from the mage's staff
      const bolt = new THREE.Group();
      const core = new THREE.Mesh(
        new THREE.SphereGeometry(0.16, 10, 10),
        new THREE.MeshBasicMaterial({ color: 0xe6c4ff })
      );
      const halo = new THREE.Mesh(
        new THREE.SphereGeometry(0.3, 10, 10),
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
    const key = { arrow: 'ammo-arrow', cannonball: 'ammo-cannonball', boulder: 'ammo-boulder' }[ev.k] || 'ammo-arrow';
    const mesh = instantiate(key, { shadows: false }).group;
    if (ev.k === 'boulder') mesh.scale.setScalar(1.5);
    if (ev.k === 'arrow') mesh.scale.setScalar(0.55);
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
    const color = { mage: 0xc07dff, cannonball: 0xffa040, boulder: 0xcfa070 }[ev.k] || 0xffffff;
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

  update(dt, camera) {
    this.time += dt;

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
    for (const a of this.players.values()) this.scene.remove(a.group);
    for (const a of this.enemies.values()) this.scene.remove(a.group);
    for (const a of this.towers.values()) this.scene.remove(a.group);
    for (const g of this.obstacles.values()) this.scene.remove(g);
    for (const p of this.projectiles) this.scene.remove(p.mesh);
    for (const e of this.effects) if (e.mesh) this.scene.remove(e.mesh);
    for (const c of this.corpses) this.scene.remove(c.actor.group);
    this.players.clear(); this.enemies.clear(); this.towers.clear(); this.obstacles.clear();
    this.projectiles = []; this.effects = []; this.corpses = [];
    this.clearGhost();
  }
}

const easeOut = (t) => 1 - Math.pow(1 - t, 3);
