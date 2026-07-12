import * as THREE from 'three';
import { GRID } from '../config.js';
import { cellToWorld, CRYSTAL_POS, HALF_W, HALF_H } from '../sim/grid.js';
import { instantiate } from './assets.js';

// ============================================================
// Static world: renderer, portrait-friendly camera that always
// frames the whole board, moody night lighting, terrain tiles,
// spawn pads, the crystal, and campfire decor.
// ============================================================

const { COLS, ROWS, CELL, SPAWNS, BUILD_ROW_MIN, BUILD_ROW_MAX } = GRID;

export class GameScene {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.35;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a1530);
    this.scene.fog = new THREE.Fog(0x1a1530, 42, 95);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.5, 200);
    this.lookTarget = new THREE.Vector3(0, 0, 0.8);
    this.camDir = new THREE.Vector3(0, Math.sin(0.98), Math.cos(0.98)).normalize();
    this.shake = 0;

    this.raycaster = new THREE.Raycaster();
    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.time = 0;

    this.buildLights();
    this.buildTerrain();
    this.buildCrystal();
    this.buildDecor();
    this.buildOverlay();

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  buildLights() {
    this.scene.add(new THREE.HemisphereLight(0x9aa0d8, 0x35284a, 1.15));

    const moon = new THREE.DirectionalLight(0xcdd6ff, 1.8);
    this.moon = moon;
    moon.position.set(-10, 24, -6);
    moon.castShadow = true;
    moon.shadow.mapSize.set(1024, 1024);
    const s = 20;
    moon.shadow.camera.left = -s; moon.shadow.camera.right = s;
    moon.shadow.camera.top = s * 1.7; moon.shadow.camera.bottom = -s * 1.7;
    moon.shadow.camera.far = 60;
    moon.shadow.bias = -0.001;
    this.scene.add(moon);

    this.crystalLight = new THREE.PointLight(0x66e0ff, 30, 14, 1.8);
    this.crystalLight.position.set(CRYSTAL_POS.x, 2.2, CRYSTAL_POS.z);
    this.scene.add(this.crystalLight);

    this.fireLight = new THREE.PointLight(0xff8c3a, 18, 10, 1.9);
    this.fireLight.position.set(CRYSTAL_POS.x - 2.2, 1.4, CRYSTAL_POS.z + 1.4);
    this.scene.add(this.fireLight);
  }

  buildTerrain() {
    // one instanced mesh per tile variant, checkerboard tinting via instance color
    const tile = instantiate('env-tile', { shadows: false });
    let tileGeo = null, tileMat = null;
    tile.group.updateMatrixWorld(true);
    tile.group.traverse((o) => {
      if (o.isMesh && !tileGeo) {
        tileGeo = o.geometry.clone();
        tileGeo.applyMatrix4(o.matrixWorld);
        tileMat = o.material;
      }
    });
    // sink the tiles so their TOP surface is exactly y=0 — actors,
    // range rings and grid overlays all live relative to that plane
    tileGeo.computeBoundingBox();
    const tileTop = tileGeo.boundingBox.max.y;
    const count = COLS * ROWS;
    const inst = new THREE.InstancedMesh(tileGeo, tileMat, count);
    inst.receiveShadow = true;
    const m = new THREE.Matrix4();
    const colA = new THREE.Color(1.0, 1.0, 1.0);
    const colB = new THREE.Color(0.82, 0.86, 0.78);
    const colSpawn = new THREE.Color(0.85, 0.7, 0.85);
    let i = 0;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const w = cellToWorld(c, r);
        m.makeTranslation(w.x, -tileTop, w.z);
        inst.setMatrixAt(i, m);
        const spawnish = r < BUILD_ROW_MIN;
        inst.setColorAt(i, spawnish ? colSpawn : (c + r) % 2 ? colA : colB);
        i++;
      }
    }
    inst.instanceColor.needsUpdate = true;
    this.scene.add(inst);

    // dark base plane under everything
    const base = new THREE.Mesh(
      new THREE.PlaneGeometry(140, 140),
      new THREE.MeshStandardMaterial({ color: 0x131020, roughness: 1 })
    );
    base.rotation.x = -Math.PI / 2;
    base.position.y = -tileTop - 0.02;
    base.receiveShadow = true;
    this.scene.add(base);

    // spawn pads
    for (const s of SPAWNS) {
      const w = cellToWorld(s.c, s.r);
      const pad = instantiate('env-spawn', { shadows: false }).group;
      pad.position.set(w.x, 0.02, w.z);
      this.scene.add(pad);
    }
  }

  buildCrystal() {
    this.crystal = instantiate('env-crystal').group;
    this.crystal.position.set(CRYSTAL_POS.x, 0, CRYSTAL_POS.z);
    this.scene.add(this.crystal);
    this.crystalMats = [];
    this.crystal.traverse((o) => {
      if (o.isMesh) {
        o.material = o.material.clone();
        o.material.emissive = new THREE.Color(0x2299cc);
        o.material.emissiveIntensity = 0.55;
        this.crystalMats.push(o.material);
      }
    });
    this.crystalHurt = 0;

    const fire = instantiate('env-fire').group;
    fire.position.set(CRYSTAL_POS.x - 2.2, 0, CRYSTAL_POS.z + 1.4);
    this.scene.add(fire);

    // fake flame: glowing cone
    this.flame = new THREE.Mesh(
      new THREE.ConeGeometry(0.16, 0.5, 6),
      new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.95 })
    );
    this.flame.position.set(CRYSTAL_POS.x - 2.2, 1.05, CRYSTAL_POS.z + 1.4);
    this.scene.add(this.flame);
  }

  buildDecor() {
    const rng = mulberry32(7);
    const spots = [];
    for (let i = 0; i < 46; i++) {
      const side = rng() < 0.5 ? -1 : 1;
      const x = side * (HALF_W + 1.2 + rng() * 7);
      const z = -HALF_H - 2 + rng() * (ROWS * CELL + 6);
      spots.push({ x, z, r: rng() });
    }
    for (let i = 0; i < 12; i++) {
      spots.push({ x: -HALF_W + rng() * COLS * CELL, z: -HALF_H - 2 - rng() * 5, r: rng() });
    }
    for (const s of spots) {
      const key = s.r < 0.42 ? 'env-pine' : s.r < 0.7 ? 'env-pine-crooked' : 'env-rocks-tall';
      const d = instantiate(key).group;
      d.position.set(s.x, 0, s.z);
      d.rotation.y = s.r * Math.PI * 2;
      const sc = 0.7 + s.r * 0.7;
      d.scale.setScalar(sc);
      this.scene.add(d);
    }
    // lanterns at the board's bottom corners
    for (const sx of [-1, 1]) {
      const lt = instantiate('env-lantern').group;
      lt.position.set(sx * (HALF_W + 0.9), 0, HALF_H - 2);
      this.scene.add(lt);
      const gl = new THREE.PointLight(0xffc06a, 6, 6, 2);
      gl.position.set(sx * (HALF_W + 0.9), 1.4, HALF_H - 2);
      this.scene.add(gl);
    }
  }

  buildOverlay() {
    // build-mode grid lines over the buildable band
    const pts = [];
    const y = 0.04;
    const x0 = -HALF_W, x1 = HALF_W;
    const z0 = (BUILD_ROW_MIN - (ROWS - 1) / 2) * CELL - CELL / 2;
    const z1 = (BUILD_ROW_MAX - (ROWS - 1) / 2) * CELL + CELL / 2;
    for (let c = 0; c <= COLS; c++) {
      const x = x0 + c * CELL;
      pts.push(x, y, z0, x, y, z1);
    }
    for (let r = BUILD_ROW_MIN; r <= BUILD_ROW_MAX + 1; r++) {
      const z = (r - (ROWS - 1) / 2) * CELL - CELL / 2;
      pts.push(x0, y, z, x1, y, z);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.gridLines = new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({
        color: 0xe8b84b, transparent: true, opacity: 0.3, depthWrite: false,
      })
    );
    this.gridLines.renderOrder = 4;
    this.gridLines.visible = false;
    this.scene.add(this.gridLines);

    // hover cell highlight
    this.cellHighlight = new THREE.Mesh(
      new THREE.PlaneGeometry(CELL * 0.96, CELL * 0.96),
      new THREE.MeshBasicMaterial({
        color: 0x8fe98f, transparent: true, opacity: 0.35,
        side: THREE.DoubleSide, depthWrite: false,
      })
    );
    this.cellHighlight.rotation.x = -Math.PI / 2;
    this.cellHighlight.position.y = 0.05;
    this.cellHighlight.renderOrder = 5;
    this.cellHighlight.visible = false;
    this.scene.add(this.cellHighlight);

    // tower range indicator: soft fill + bright edge, always on top of terrain
    this.rangeGroup = new THREE.Group();
    const rangeFill = new THREE.Mesh(
      new THREE.CircleGeometry(1, 48),
      new THREE.MeshBasicMaterial({
        color: 0x8fd0ff, transparent: true, opacity: 0.13,
        depthWrite: false, side: THREE.DoubleSide,
      })
    );
    const rangeEdge = new THREE.Mesh(
      new THREE.RingGeometry(0.965, 1, 64),
      new THREE.MeshBasicMaterial({
        color: 0xaadeff, transparent: true, opacity: 0.85,
        depthWrite: false, side: THREE.DoubleSide,
      })
    );
    rangeEdge.position.z = 0.001;
    this.rangeGroup.add(rangeFill, rangeEdge);
    this.rangeGroup.rotation.x = -Math.PI / 2;
    this.rangeGroup.position.y = 0.06;
    this.rangeGroup.renderOrder = 6;
    rangeFill.renderOrder = 6;
    rangeEdge.renderOrder = 7;
    this.rangeGroup.visible = false;
    this.scene.add(this.rangeGroup);
  }

  setBuildMode(on) { this.gridLines.visible = on; }

  showCellHighlight(c, r, ok) {
    const w = cellToWorld(c, r);
    this.cellHighlight.visible = true;
    this.cellHighlight.position.set(w.x, 0.05, w.z);
    this.cellHighlight.material.color.set(ok ? 0x8fe98f : 0xe05a4e);
  }
  hideCellHighlight() { this.cellHighlight.visible = false; }

  showRange(x, z, range) {
    this.rangeGroup.visible = true;
    this.rangeGroup.position.set(x, 0.06, z);
    this.rangeGroup.scale.setScalar(range);
  }
  hideRange() { this.rangeGroup.visible = false; }

  // pointer (client coords) -> world point on the ground plane
  pointerToGround(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const out = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(this.groundPlane, out) ? out : null;
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.fitCamera();
  }

  // binary-search the camera distance so the whole board fits
  fitCamera() {
    const corners = [
      new THREE.Vector3(-HALF_W - 0.8, 0, -HALF_H - 1.2),
      new THREE.Vector3(HALF_W + 0.8, 0, -HALF_H - 1.2),
      new THREE.Vector3(-HALF_W - 0.8, 0, HALF_H + 0.6),
      new THREE.Vector3(HALF_W + 0.8, 0, HALF_H + 0.6),
      new THREE.Vector3(0, 2.6, -HALF_H),
    ];
    let lo = 8, hi = 130;
    for (let it = 0; it < 22; it++) {
      const mid = (lo + hi) / 2;
      this.placeCamera(mid);
      let fits = true;
      for (const c of corners) {
        const p = c.clone().project(this.camera);
        if (Math.abs(p.x) > 0.96 || p.y > 0.86 || p.y < -0.98) { fits = false; break; }
      }
      if (fits) hi = mid; else lo = mid;
    }
    this.placeCamera(hi);
    this.baseCamPos = this.camera.position.clone();
  }

  placeCamera(dist) {
    this.camera.position.copy(this.lookTarget).addScaledVector(this.camDir, dist);
    this.camera.lookAt(this.lookTarget);
    this.camera.updateMatrixWorld();
    this.camera.updateProjectionMatrix();
  }

  addShake(amount) {
    if (this.shakeEnabled === false) return;
    this.shake = Math.min(this.shake + amount, 0.7);
  }

  setShadows(on) { this.moon.castShadow = on; }

  update(dt) {
    this.time += dt;
    // crystal idle: bob + spin + pulse
    this.crystal.rotation.y += dt * 0.5;
    this.crystal.position.y = Math.sin(this.time * 1.6) * 0.12 + 0.05;
    const pulse = 0.55 + Math.sin(this.time * 2.2) * 0.18;
    this.crystalHurt = Math.max(this.crystalHurt - dt * 2, 0);
    for (const m of this.crystalMats) {
      m.emissiveIntensity = pulse + this.crystalHurt * 1.5;
      m.emissive.setHSL(0.55 - this.crystalHurt * 0.5, 0.85, 0.45);
    }
    this.crystalLight.intensity = 26 + Math.sin(this.time * 2.2) * 7 + this.crystalHurt * 40;

    // campfire flicker
    this.fireLight.intensity = 15 + Math.sin(this.time * 11) * 2.5 + Math.sin(this.time * 23) * 1.5;
    this.flame.scale.y = 1 + Math.sin(this.time * 13) * 0.2;
    this.flame.rotation.y += dt * 2;

    // camera shake decay
    if (this.shake > 0.001) {
      this.shake *= Math.exp(-6 * dt);
      this.camera.position.copy(this.baseCamPos).add(new THREE.Vector3(
        (Math.random() - 0.5) * this.shake,
        (Math.random() - 0.5) * this.shake * 0.5,
        (Math.random() - 0.5) * this.shake
      ));
    } else if (this.baseCamPos) {
      this.camera.position.copy(this.baseCamPos);
    }
  }

  render() { this.renderer.render(this.scene, this.camera); }

  crystalBreachFx() {
    this.crystalHurt = 1;
    this.addShake(0.5);
  }
}

function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
