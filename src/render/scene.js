import * as THREE from 'three';
import { GRID } from '../config.js';
import { cellToWorld, CRYSTAL_POS, HALF_W, HALF_H, PLAZA } from '../sim/grid.js';
import { instantiate } from './assets.js';

// ============================================================
// Static world: renderer, portrait-friendly camera that always
// frames the whole board, moody night lighting, and the set
// dressing — enemies emerge from a fog-choked forest at the top,
// the board is a clearing whose floor blends dirt and grass into
// stone paving near the crystal, and behind the south edge sits a
// small sanctuary plaza (fountains, statues, columns) players can
// wander into between waves.
// ============================================================

const { COLS, ROWS, CELL, SPAWNS, CRYSTAL, BUILD_ROW_MIN, BUILD_ROW_MAX } = GRID;

// unit view direction (from a look target toward the camera) for a given
// pitch (tilt above the board) and yaw (swing left/right around the target)
function camDirFromAngles(pitch, yaw) {
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  return new THREE.Vector3(Math.sin(yaw) * cp, sp, Math.cos(yaw) * cp).normalize();
}

export class GameScene {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.35;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x151128);
    // tight fog: the forest dissolves into darkness before any edge of
    // the ground plane or tree cover can show
    this.scene.fog = new THREE.Fog(0x151128, 34, 62);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.5, 200);
    this.lookTarget = new THREE.Vector3(0, 0, 2.2);

    // partida: the fixed board framing held during a wave
    this.boardDir = camDirFromAngles(60 * Math.PI / 180, 0);
    this.boardZoom = 1.20;
    this.boardPan = new THREE.Vector3(0, 0, -3.5);

    // checkpoint: the up-close follow-cam tracking the local hero while
    // strolling the sanctuary between waves
    this.followDir = camDirFromAngles(35 * Math.PI / 180, 0);
    this.followZoom = 1;
    this.CHK_BASE_DIST = 15; // follow-cam distance at zoom 1

    this.shake = 0;
    // checkpoint stroll: camera leaves the board framing to track the player
    this.followGoal = null;
    this.followPos = new THREE.Vector3();
    this.followBlend = 0;
    this._camPos = new THREE.Vector3();
    this._camLook = new THREE.Vector3();
    this._followCam = new THREE.Vector3();

    this.raycaster = new THREE.Raycaster();
    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.time = 0;
    this.waters = [];
    this.fogSprites = [];

    this.buildLights();
    this.buildTerrain();
    this.buildPlaza();
    this.buildCrystal();
    this.buildForest();
    this.buildForestFill();
    this.buildPenumbra();
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
    // normalBias pushes the shadow lookup along the surface normal, which
    // clears the self-shadow "static" that peppered the near-flat grass
    // tiles at high pixel ratios (invisible on lower-res mobile screens).
    moon.shadow.bias = -0.0006;
    moon.shadow.normalBias = 0.04;
    this.scene.add(moon);

    this.crystalLight = new THREE.PointLight(0x66e0ff, 30, 14, 1.8);
    this.crystalLight.position.set(CRYSTAL_POS.x, 2.6, CRYSTAL_POS.z);
    this.scene.add(this.crystalLight);
  }

  buildTerrain() {
    // grab geometry+material from both tile variants
    const grabTile = (key) => {
      const t = instantiate(key, { shadows: false });
      let geo = null, mat = null;
      t.group.updateMatrixWorld(true);
      t.group.traverse((o) => {
        if (o.isMesh && !geo) {
          geo = o.geometry.clone();
          geo.applyMatrix4(o.matrixWorld);
          mat = o.material;
        }
      });
      geo.computeBoundingBox();
      return { geo, mat, top: geo.boundingBox.max.y };
    };
    const grass = grabTile('env-tile');
    const dirt = grabTile('env-tile-dirt');
    const tileTop = grass.top;

    // decide per cell: dirt trails wander from both spawns down to the
    // crystal, the forest edge is bare earth, everything else is grass
    const rng = mulberry32(12);
    const lattice = [];
    for (let i = 0; i < (COLS + 2) * (ROWS + 2); i++) lattice.push(rng());
    const noise = (x, y) => {
      const xi = Math.floor(x), yi = Math.floor(y);
      const fx = x - xi, fy = y - yi;
      const s = (a, b, t) => a + (b - a) * (t * t * (3 - 2 * t));
      const at = (c, r) => lattice[((r % (ROWS + 2)) * (COLS + 2)) + (c % (COLS + 2))];
      return s(
        s(at(xi, yi), at(xi + 1, yi), fx),
        s(at(xi, yi + 1), at(xi + 1, yi + 1), fx),
        fy
      );
    };

    // 0 grass, 1 dirt, 2 stone (the crystal's row and the pocket in
    // front of it read as old paving; nothing else sits on the grid)
    const kinds = [];
    const colors = [];
    const GRASS_TONES = [
      [0.72, 0.85, 0.6], [0.85, 0.97, 0.7], [0.97, 1.05, 0.8],
      [1.02, 1.02, 0.86], [0.64, 0.8, 0.6],
    ];
    const DIRT_TONES = [
      [1.0, 0.94, 0.86], [0.88, 0.83, 0.78], [0.97, 0.88, 0.78], [0.8, 0.76, 0.74],
    ];
    const STONE_TONES = [
      [0.62, 0.64, 0.74], [0.55, 0.57, 0.66], [0.68, 0.7, 0.8], [0.5, 0.52, 0.62],
    ];
    const isStoneCell = (c, r) =>
      r >= ROWS - 2 || (r === ROWS - 3 && Math.abs(c - CRYSTAL.c) <= 1);
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (isStoneCell(c, r)) {
          kinds.push(2);
          const tone = STONE_TONES[Math.floor(rng() * STONE_TONES.length)];
          const jit = 0.92 + rng() * 0.16;
          colors.push([tone[0] * jit, tone[1] * jit, tone[2] * jit]);
          continue;
        }
        const w = cellToWorld(c, r);
        const t = r / (ROWS - 1);
        // the two spawn trails bend toward the crystal as they go south
        let lane = Infinity;
        for (const s of SPAWNS) {
          const sx = cellToWorld(s.c, s.r).x;
          const wob = Math.sin(t * 5.2 + sx) * 0.8;
          const lx = (sx + (CRYSTAL_POS.x - sx) * t * t) + wob;
          lane = Math.min(lane, Math.abs(w.x - lx));
        }
        const n = noise(c * 0.62 + 0.3, r * 0.62 + 0.3);
        const score = n * 0.52
          + Math.max(0, 1 - lane / (CELL * 1.15)) * 0.62
          + (r <= 1 ? 0.3 : 0);
        const isDirt = score > 0.58;
        kinds.push(isDirt ? 1 : 0);

        const tones = isDirt ? DIRT_TONES : GRASS_TONES;
        const tone = tones[Math.min(tones.length - 1, Math.floor(rng() * tones.length))];
        const jit = 0.9 + rng() * 0.18;
        let cr = tone[0] * jit, cg = tone[1] * jit, cb = tone[2] * jit;
        // penumbra: the forest's shade feathers half a tile onto the grid
        // (row 0 shaded, row 1 barely) so the board→woods seam reads as a
        // gradient instead of a hard line; the grid still stays lit
        if (r === 0) {
          const dark = 0.72;
          cr *= dark; cg *= dark; cb *= dark * 1.05;
        } else if (r === 1) {
          const dark = 0.89;
          cr *= dark; cg *= dark; cb *= dark * 1.02;
        }
        colors.push([cr, cg, cb]);
      }
    }

    // stone paving continues past the south edge as the plaza floor
    const plazaCells = [];
    const plazaRows = Math.round(PLAZA.DEPTH / CELL);
    for (let pr = 0; pr < plazaRows; pr++) {
      for (let c = 0; c < COLS; c++) {
        const w = cellToWorld(c, ROWS + pr);
        if (Math.abs(w.x) > PLAZA.HALF_W) continue;
        const tone = STONE_TONES[Math.floor(rng() * STONE_TONES.length)];
        const jit = 0.9 + rng() * 0.16;
        plazaCells.push({ x: w.x, z: w.z, color: [tone[0] * jit, tone[1] * jit, tone[2] * jit] });
      }
    }

    // untextured stone material: the tile shape with a plain gray face
    // (kept dim — the crystal and fountain lights land right on it)
    const stoneMat = new THREE.MeshStandardMaterial({ color: 0x878b9e, roughness: 0.95 });

    const m = new THREE.Matrix4();
    for (const kind of [0, 1, 2]) {
      const src = kind === 1 ? dirt : grass;
      const extra = kind === 2 ? plazaCells.length : 0;
      const count = kinds.filter((k) => k === kind).length + extra;
      if (!count) continue;
      const inst = new THREE.InstancedMesh(src.geo, kind === 2 ? stoneMat : src.mat, count);
      inst.receiveShadow = true;
      let i = 0, ci = 0;
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++, ci++) {
          if (kinds[ci] !== kind) continue;
          const w = cellToWorld(c, r);
          m.makeTranslation(w.x, -tileTop, w.z);
          inst.setMatrixAt(i, m);
          inst.setColorAt(i, new THREE.Color(...colors[ci]));
          i++;
        }
      }
      if (kind === 2) {
        for (const p of plazaCells) {
          m.makeTranslation(p.x, -tileTop, p.z);
          inst.setMatrixAt(i, m);
          inst.setColorAt(i, new THREE.Color(...p.color));
          i++;
        }
      }
      inst.instanceColor.needsUpdate = true;
      this.scene.add(inst);
    }

    // the world around the clearing is forest floor, not a void: a dim
    // mossy ground stretching out under the trees. Kept darker than the
    // board so the flanks read as gloom, and biased back in the depth
    // buffer (polygonOffset) so it never z-fights the grid tiles sitting
    // just above it.
    const base = new THREE.Mesh(
      new THREE.PlaneGeometry(240, 240),
      new THREE.MeshStandardMaterial({
        color: 0x2b3a1f, roughness: 1,
        polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2,
      })
    );
    base.rotation.x = -Math.PI / 2;
    base.position.y = -tileTop - 0.06;
    base.receiveShadow = true;
    this.scene.add(base);

    // subtle color breakup so the surrounding ground reads as terrain.
    // Each patch is nudged a hair higher than the last so overlapping
    // circles never share a plane (which flickered against each other and
    // the floor); they also sit clearly above the offset base.
    const patchGeo = new THREE.CircleGeometry(1, 10);
    const patchMats = [0x33482a, 0x263420, 0x39502e, 0x2b3b22].map(
      (col) => new THREE.MeshStandardMaterial({ color: col, roughness: 1 })
    );
    for (let i = 0; i < 90; i++) {
      const a = rng() * Math.PI * 2;
      const rad = 12 + rng() * 38;
      const px = Math.cos(a) * rad;
      const pz = Math.sin(a) * rad * 1.3;
      // keep patches off the board and plaza
      if (Math.abs(px) < HALF_W + 1 && pz > -HALF_H - 1 && pz < HALF_H + PLAZA.DEPTH + 1) continue;
      const patch = new THREE.Mesh(patchGeo, patchMats[Math.floor(rng() * patchMats.length)]);
      patch.rotation.x = -Math.PI / 2;
      patch.position.set(px, -tileTop + 0.02 + i * 0.0004, pz);
      patch.scale.setScalar(1.5 + rng() * 3.5);
      this.scene.add(patch);
    }

    // world-space dark fog on the ground: beyond the tree band the
    // scenery simply sinks into blackness — there is nothing out there
    const vg = document.createElement('canvas');
    vg.width = vg.height = 256;
    const vctx = vg.getContext('2d');
    const vgrad = vctx.createRadialGradient(128, 128, 0, 128, 128, 128);
    vgrad.addColorStop(0, 'rgba(21,17,40,0)');
    vgrad.addColorStop(0.40, 'rgba(21,17,40,0)');
    vgrad.addColorStop(0.54, 'rgba(21,17,40,0.62)');
    vgrad.addColorStop(0.74, 'rgba(21,17,40,0.95)');
    vgrad.addColorStop(1, 'rgba(21,17,40,0.98)');
    vctx.fillStyle = vgrad;
    vctx.fillRect(0, 0, 256, 256);
    const vTex = new THREE.CanvasTexture(vg);
    vTex.colorSpace = THREE.SRGBColorSpace;
    const vignette = new THREE.Mesh(
      new THREE.PlaneGeometry(150, 170),
      new THREE.MeshBasicMaterial({ map: vTex, transparent: true, depthWrite: false })
    );
    vignette.rotation.x = -Math.PI / 2;
    vignette.position.set(0, 0.02, 4);
    vignette.renderOrder = 1;
    this.scene.add(vignette);
  }

  // the crystal's pedestal is the ONLY prop on the grid; the sanctuary
  // proper is a small plaza behind the south edge where players can
  // stretch their legs between waves
  buildPlaza() {
    const cz = CRYSTAL_POS.z;
    const pz = HALF_H + PLAZA.DEPTH / 2; // plaza center line

    // pedestal the crystal hovers over
    const altar = instantiate('env-altar').group;
    altar.position.set(0, 0.05, cz);
    this.scene.add(altar);
    const altarBox = new THREE.Box3().setFromObject(altar);
    this.crystalBaseY = altarBox.max.y - 0.06;

    // cools a kit piece toward gray stone so the plaza reads uniform
    const grayStone = (group) => {
      group.traverse((o) => {
        if (o.isMesh && o.material) {
          o.material = o.material.clone();
          o.material.color.multiply(new THREE.Color(0.55, 0.58, 0.72));
        }
      });
      return group;
    };

    // (the twin fountains that used to sit at ±4.1 were removed — the
    // two sanctuary vendors stand on those spots now, see GameView)

    // statues guard the plaza entrance, facing the battlefield
    for (const sx of [-1, 1]) {
      const statue = grayStone(instantiate('env-statue').group);
      statue.position.set(sx * 5.9, 0, HALF_H + 1.1);
      statue.rotation.y = Math.PI + sx * 0.25;
      statue.scale.setScalar(1.15);
      this.scene.add(statue);
    }

    // gray columns mark the plaza's four corners
    for (const sx of [-1, 1]) {
      for (const zz of [HALF_H + 0.8, HALF_H + PLAZA.DEPTH - 0.6]) {
        const col = grayStone(instantiate('env-column').group);
        col.position.set(sx * (PLAZA.HALF_W - 0.6), 0, zz);
        this.scene.add(col);
      }
    }

    // lanterns light the resting spot and the clearing's bottom corners
    for (const sx of [-1, 1]) {
      for (const [lx, lz] of [[HALF_W + 0.9, HALF_H - 2], [2.9, HALF_H + PLAZA.DEPTH - 1]]) {
        const lt = instantiate('env-lantern').group;
        lt.position.set(sx * lx, 0, lz);
        this.scene.add(lt);
        const gl = new THREE.PointLight(0xffc06a, 6, 6, 2);
        gl.position.set(sx * lx, 1.4, lz);
        this.scene.add(gl);
      }
    }
  }

  makeFountain(x, z, scale = 1) {
    const g = new THREE.Group();
    const base = instantiate('env-pillar-small').group;
    g.add(base);
    const baseTop = new THREE.Box3().setFromObject(base).max.y;
    const bowl = instantiate('env-bowl').group;
    bowl.position.y = baseTop - 0.04;
    g.add(bowl);
    const bowlBox = new THREE.Box3().setFromObject(bowl);

    const water = new THREE.Mesh(
      new THREE.CircleGeometry(0.52, 20),
      new THREE.MeshStandardMaterial({
        color: 0x5fc8e8, emissive: 0x1e6e8c, emissiveIntensity: 0.6,
        transparent: true, opacity: 0.9, roughness: 0.15,
      })
    );
    water.rotation.x = -Math.PI / 2;
    water.position.y = bowlBox.max.y - 0.08;
    g.add(water);

    const jet = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.028, 0.42, 6),
      new THREE.MeshBasicMaterial({
        color: 0x9fdcf0, transparent: true, opacity: 0.4,
        blending: THREE.AdditiveBlending, depthWrite: false,
      })
    );
    jet.position.y = water.position.y + 0.2;
    g.add(jet);

    // faint cool glow so the water reads as water from afar
    const glow = new THREE.PointLight(0x66c8e8, 2.2, 4, 2);
    glow.position.y = water.position.y + 0.5;
    g.add(glow);

    g.position.set(x, 0, z);
    g.scale.setScalar(scale);
    this.scene.add(g);
    this.waters.push({ water, jet, phase: x * 1.7 });
  }

  buildCrystal() {
    // a clean silhouette instead of the old dense cluster: one tall crystal
    // standing vertical at the centre with three smaller shards orbiting it
    // (the group's slow spin in update() makes them drift around)
    const proto = instantiate('prop-crystal').group;
    proto.updateWorldMatrix(true, true);
    const pb = new THREE.Box3().setFromObject(proto);
    const unit = 1 / (pb.max.y - pb.min.y); // scale to 1 unit tall
    this.crystal = new THREE.Group();
    this.crystalMats = [];
    const mk = (scale) => {
      const g = proto.clone(true);
      g.traverse((o) => {
        if (o.isMesh) {
          o.material = o.material.clone();
          o.material.emissive = new THREE.Color(0x2299cc);
          o.material.emissiveIntensity = 0.55;
          this.crystalMats.push(o.material);
        }
      });
      g.scale.setScalar(unit * scale);
      const b = new THREE.Box3().setFromObject(g);
      g.position.y -= b.min.y; // seat base at y = 0
      return g;
    };
    this.crystal.add(mk(2.7)); // big central crystal
    const orbit = [
      { a: -Math.PI / 2, r: 0.9, y: 0.5, s: 0.85 },
      { a: -Math.PI / 2 + (Math.PI * 2) / 3, r: 0.95, y: 1.0, s: 0.62 },
      { a: -Math.PI / 2 + (Math.PI * 4) / 3, r: 0.9, y: 0.4, s: 0.75 },
    ];
    for (const o of orbit) {
      const c = mk(o.s);
      c.position.set(Math.cos(o.a) * o.r, o.y, Math.sin(o.a) * o.r);
      c.rotation.y = o.a;
      this.crystal.add(c);
    }
    this.crystal.position.set(CRYSTAL_POS.x, this.crystalBaseY || 0, CRYSTAL_POS.z);
    this.scene.add(this.crystal);
    this.crystalHurt = 0;
  }

  // the clearing is hemmed in by forest: a dense, dark tree wall to the
  // north (where enemies pour out), thinning woods along the flanks that
  // gradually give way to sanctuary stonework near the bottom
  buildForest() {
    const rng = mulberry32(7);

    const placeTree = (x, z, scale, darkness, crooked) => {
      const key = crooked ? 'env-pine-crooked' : 'env-pine';
      const d = instantiate(key, { cloneMaterials: darkness < 0.96 }).group;
      d.position.set(x, 0, z);
      d.rotation.y = rng() * Math.PI * 2;
      d.scale.setScalar(scale);
      if (darkness < 0.96) {
        d.traverse((o) => { if (o.isMesh && o.material) o.material.color.multiplyScalar(darkness); });
      }
      this.scene.add(d);
    };

    // --- north wall of trees, several rows deep, darker the deeper
    const spawnXs = SPAWNS.map((s) => cellToWorld(s.c, s.r).x);
    for (let i = 0; i < 90; i++) {
      const x = -HALF_W - 7 + rng() * (COLS * CELL + 14);
      const depth = rng();
      const z = -HALF_H - 0.4 - depth * 6.2;
      // leave shadowy trail mouths where the spawns are
      if (depth < 0.3 && spawnXs.some((sx) => Math.abs(x - sx) < 1.5)) continue;
      const darkness = 0.55 - depth * 0.35;
      placeTree(x, z, 0.75 + rng() * 0.95, darkness, rng() < 0.3);
    }
    // a few trees leaning INTO the top corners of the board
    for (const [x, z, s] of [[-HALF_W + 0.6, -HALF_H + 1.1, 0.85], [HALF_W - 0.5, -HALF_H + 0.8, 0.75], [HALF_W - 2.2, -HALF_H + 0.4, 0.6]]) {
      placeTree(x, z, s, 0.62, true);
    }

    // --- flanking woods, thinning toward the sanctuary
    for (let i = 0; i < 55; i++) {
      const side = rng() < 0.5 ? -1 : 1;
      const z = -HALF_H - 1 + rng() * 22;
      const p = (z + HALF_H + 1) / 22; // 0 north → 1 south
      if (rng() < p * 0.75) continue;  // forest thins going south
      const x = side * (HALF_W + 0.9 + rng() * 6.5);
      if (rng() < 0.22) {
        const rock = instantiate('env-rocks-tall').group;
        rock.position.set(x, 0, z);
        rock.rotation.y = rng() * Math.PI * 2;
        rock.scale.setScalar(0.6 + rng() * 0.8);
        this.scene.add(rock);
      } else {
        placeTree(x, z, 0.65 + rng() * 0.85, 0.7 + p * 0.28, rng() < 0.4);
      }
    }

    // --- far scatter wrapping ONLY the plaza's back so it never stares
    // into the void. The flanks are deliberately left empty — past the
    // dense band the sides are meant to be fog then darkness, no lone
    // trees hanging in the gloom.
    for (let i = 0; i < 22; i++) {
      const x = -HALF_W - 12 + rng() * (COLS * CELL + 24);
      const z = HALF_H + 1.5 + rng() * 10;
      // keep the plaza itself clear; trees hug its sides and back
      if (Math.abs(x) < PLAZA.HALF_W + 1.2 && z < HALF_H + PLAZA.DEPTH + 1) continue;
      placeTree(x, z, 0.8 + rng() * 1.1, 0.3 + rng() * 0.15, rng() < 0.35);
    }

    // --- a tree line closes off the back of the plaza
    for (let i = 0; i < 9; i++) {
      const x = -PLAZA.HALF_W - 1 + rng() * (PLAZA.HALF_W * 2 + 2);
      const z = HALF_H + PLAZA.DEPTH + 1.4 + rng() * 2.4;
      placeTree(x, z, 0.8 + rng() * 0.7, 0.62 + rng() * 0.2, rng() < 0.35);
    }

    // --- low rocks and shrubs hug the board's side edges so it's
    // obvious the clearing ends there
    for (let i = 0; i < 14; i++) {
      const side = rng() < 0.5 ? -1 : 1;
      const z = -HALF_H + 3 + rng() * (ROWS * CELL - 5);
      const x = side * (HALF_W + 0.65 + rng() * 0.5);
      if (rng() < 0.55) {
        const rock = instantiate('env-rocks-tall').group;
        rock.position.set(x, 0, z);
        rock.rotation.y = rng() * Math.PI * 2;
        rock.scale.setScalar(0.35 + rng() * 0.35);
        this.scene.add(rock);
      } else {
        placeTree(x, z, 0.45 + rng() * 0.3, 0.8, true);
      }
    }

    // --- stone takes over on the southern flanks (forest → sanctuary)
    const stones = [
      ['env-obelisk', -HALF_W - 1.7, 5.4, 0.9, 0.3],
      ['env-obelisk', HALF_W + 2.1, 7.6, 1.05, -0.5],
      ['env-column-damaged', -HALF_W - 2.6, 8.8, 1, 0.7],
      ['env-column-damaged', HALF_W + 1.4, 11.2, 0.9, 2.3],
      ['env-pillar-small', -HALF_W - 1.2, 11.6, 1.1, 0],
      ['env-obelisk', -HALF_W - 3.4, 13.2, 0.8, 1.2],
      ['env-column', HALF_W + 3.1, 13.8, 0.85, 0],
    ];
    for (const [key, x, z, s, ry] of stones) {
      const d = instantiate(key).group;
      d.position.set(x, 0, z);
      d.rotation.y = ry;
      d.scale.setScalar(s);
      this.scene.add(d);
    }
  }

  // Instanced filler forest: a SOLID band of pines hugging the board and
  // plaza edges out to the tree line (you can barely see the ground in
  // it), then only sparse near-black silhouettes beyond — the dark fog
  // owns the rest of the world. A couple of InstancedMeshes keep the
  // whole thing at a handful of draw calls.
  buildForestFill() {
    const rng = mulberry32(99);
    const spawnXs = SPAWNS.map((s) => cellToWorld(s.c, s.r).x);
    const edgeX = HALF_W + 0.7;   // trees touch the board border
    const bandW = 11;             // packed band width (to the tree line)
    const northD = 13;            // packed depth of the enemy woods
    const southZ = HALF_H + PLAZA.DEPTH;
    const specs = [];

    const push = (x, z, base) => {
      const north = Math.min(Math.max((-z - HALF_H + 4) / 12, 0), 1);
      const out = Math.max(0, Math.abs(x) - (edgeX + bandW)) +
        Math.max(0, z - (southZ + 8)) + Math.max(0, -z - (HALF_H + northD));
      const dark = Math.max(0.08, (base - north * 0.38 - out * 0.05) * (0.85 + rng() * 0.3));
      specs.push({
        x, z, s: 0.72 + rng() * 0.9, dark,
        crooked: rng() < 0.3, rot: rng() * Math.PI * 2,
      });
    };
    const jit = () => (rng() - 0.5) * 1.2;

    // flank bands: wall-to-wall foliage from the board edge outward
    for (const side of [-1, 1]) {
      for (let x = edgeX; x <= edgeX + bandW; x += 1.5) {
        for (let z = -HALF_H - 1; z <= HALF_H + 1.2; z += 1.5) {
          push(side * (x + Math.abs(jit())), z + jit(), 0.62);
        }
      }
    }
    // north band: the dark woods the enemies march out of (the two
    // spawn corridors stay clear so they don't walk through trunks)
    for (let x = -(edgeX + bandW); x <= edgeX + bandW; x += 1.55) {
      for (let z = -HALF_H - northD; z <= -HALF_H - 0.2; z += 1.55) {
        const px = x + jit(), pz = z + jit();
        if (spawnXs.some((sx) => Math.abs(px - sx) < 1.7)) continue;
        push(px, pz, 0.5);
      }
    }
    // the sanctuary plaza is walled in too: flanks and back
    for (const side of [-1, 1]) {
      for (let x = PLAZA.HALF_W + 0.8; x <= edgeX + bandW; x += 1.6) {
        for (let z = HALF_H + 1; z <= southZ + 2; z += 1.6) {
          push(side * (x + Math.abs(jit())), z + jit(), 0.6);
        }
      }
    }
    for (let x = -(edgeX + bandW); x <= edgeX + bandW; x += 1.6) {
      for (let z = southZ + 1.5; z <= southZ + 8; z += 1.6) {
        push(x + jit(), z + jit(), 0.55);
      }
    }
    // beyond the tree line: a few near-black silhouettes ONLY far behind
    // the forest (north) and the plaza (south) for depth on wide screens.
    // The flanks get nothing — the sides fade straight to darkness past
    // the dense band, so any lone tree there is culled.
    for (let i = 0; i < 90; i++) {
      const x = (rng() * 2 - 1) * 58;
      const z = -HALF_H - 26 + rng() * (ROWS * CELL + PLAZA.DEPTH + 26 + 16);
      if (Math.abs(x) < edgeX + bandW + 1 && z > -HALF_H - northD - 1 && z < southZ + 9) continue;
      // cull side silhouettes near the board — the flanks stay empty
      if (Math.abs(x) < 32 && z > -HALF_H - 2 && z < southZ + 2) continue;
      push(x, z, 0.16);
    }

    const grabParts = (key) => {
      const t = instantiate(key, { shadows: false });
      t.group.updateMatrixWorld(true);
      const parts = [];
      t.group.traverse((o) => {
        if (o.isMesh) {
          const geo = o.geometry.clone();
          geo.applyMatrix4(o.matrixWorld);
          parts.push({ geo, mat: o.material });
        }
      });
      return parts;
    };
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3(), s3 = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const col = new THREE.Color();
    for (const [key, list] of [
      ['env-pine', specs.filter((t) => !t.crooked)],
      ['env-pine-crooked', specs.filter((t) => t.crooked)],
    ]) {
      if (!list.length) continue;
      for (const part of grabParts(key)) {
        const inst = new THREE.InstancedMesh(part.geo, part.mat, list.length);
        inst.frustumCulled = false;
        list.forEach((t, i) => {
          q.setFromAxisAngle(up, t.rot);
          m.compose(p.set(t.x, 0, t.z), q, s3.setScalar(t.s));
          inst.setMatrixAt(i, m);
          inst.setColorAt(i, col.setScalar(t.dark));
        });
        inst.instanceColor.needsUpdate = true;
        this.scene.add(inst);
      }
    }
  }

  // layered darkness where the enemies come from + drifting fog
  buildPenumbra() {
    const gradTex = (stops, vertical = true) => {
      const cv = document.createElement('canvas');
      cv.width = cv.height = 128;
      const ctx = cv.getContext('2d');
      const gr = vertical ? ctx.createLinearGradient(0, 0, 0, 128) : ctx.createLinearGradient(0, 0, 128, 0);
      for (const [at, col] of stops) gr.addColorStop(at, col);
      ctx.fillStyle = gr;
      ctx.fillRect(0, 0, 128, 128);
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      return tex;
    };

    // vertical curtain of darkness behind the tree wall (matches the
    // scene background so its edges dissolve on wide screens)
    const curtain = new THREE.Mesh(
      new THREE.PlaneGeometry(110, 14),
      new THREE.MeshBasicMaterial({
        map: gradTex([[0, 'rgba(21,17,40,1)'], [0.5, 'rgba(19,15,36,0.9)'], [1, 'rgba(19,15,36,0)']]),
        transparent: true, depthWrite: false, fog: false,
      })
    );
    curtain.position.set(0, 5.4, -HALF_H - 7.6);
    this.scene.add(curtain);

    // near shroud right at the forest mouth: swallows most of the tree
    // wall so only silhouettes of the first trunks survive, and the
    // enemies walk out of a black void
    const shroud = new THREE.Mesh(
      new THREE.PlaneGeometry(110, 15),
      new THREE.MeshBasicMaterial({
        map: gradTex([[0, 'rgba(10,8,24,0.98)'], [0.6, 'rgba(10,8,24,0.92)'], [1, 'rgba(10,8,24,0)']]),
        transparent: true, depthWrite: false,
      })
    );
    shroud.position.set(0, 5.1, -HALF_H - 1.4);
    this.scene.add(shroud);

    // soft pool of darkness over the forest mouth where the enemies spawn
    // — radial, fading in every direction, so no hard edge ever reads as a
    // rectangle on the ground. It sits north of the board (over the spawn
    // woods) and only its faint tail laps onto the first grid row; the
    // grid itself must stay lit.
    const spillCv = document.createElement('canvas');
    spillCv.width = spillCv.height = 256;
    const sctx = spillCv.getContext('2d');
    const sg = sctx.createRadialGradient(128, 128, 0, 128, 128, 128);
    sg.addColorStop(0, 'rgba(6,4,16,0.92)');
    sg.addColorStop(0.45, 'rgba(6,4,16,0.62)');
    sg.addColorStop(1, 'rgba(6,4,16,0)');
    sctx.fillStyle = sg;
    sctx.fillRect(0, 0, 256, 256);
    const spillTex = new THREE.CanvasTexture(spillCv);
    spillTex.colorSpace = THREE.SRGBColorSpace;
    const spill = new THREE.Mesh(
      new THREE.PlaneGeometry(64, 18),
      new THREE.MeshBasicMaterial({ map: spillTex, transparent: true, depthWrite: false })
    );
    spill.rotation.x = -Math.PI / 2;
    // half a tile further onto the board than before, so the shade drapes
    // over the board→woods seam instead of stopping short of it
    spill.position.set(0, 0.035, -HALF_H - 6);
    spill.renderOrder = 2;
    this.scene.add(spill);

    // soft fog banks drifting between the trunks
    const fogCv = document.createElement('canvas');
    fogCv.width = fogCv.height = 128;
    const fctx = fogCv.getContext('2d');
    const fg = fctx.createRadialGradient(64, 64, 6, 64, 64, 62);
    fg.addColorStop(0, 'rgba(154,160,216,0.55)');
    fg.addColorStop(1, 'rgba(154,160,216,0)');
    fctx.fillStyle = fg;
    fctx.fillRect(0, 0, 128, 128);
    const fogTex = new THREE.CanvasTexture(fogCv);
    const mkFog = (x, y, z, sx, sy, op) => {
      const spr = new THREE.Sprite(new THREE.SpriteMaterial({
        map: fogTex, transparent: true, opacity: op, depthWrite: false,
      }));
      spr.position.set(x, y, z);
      spr.scale.set(sx, sy, 1);
      this.scene.add(spr);
      this.fogSprites.push({ spr, x0: x, amp: 1.5 + Math.random() * 2, speed: 0.08 + Math.random() * 0.07, phase: Math.random() * 6.28 });
    };
    mkFog(-4.5, 1.0, -HALF_H - 1.6, 9, 3.2, 0.30);
    mkFog(4, 1.2, -HALF_H - 2.6, 10, 3.6, 0.26);
    mkFog(0, 0.8, -HALF_H + 0.6, 8, 2.4, 0.22);
    mkFog(-8, 1.4, -HALF_H - 4, 11, 4, 0.20);
    // névoa rolling down both flanks: past the dense band the sides are
    // just mist and then darkness, so a run of soft fog banks hugs each
    // edge from the forest mouth down to the plaza
    for (const side of [-1, 1]) {
      for (const [z, op] of [[-HALF_H + 2, 0.16], [-HALF_H + 8, 0.15], [-1, 0.14], [HALF_H - 5, 0.13], [HALF_H + 3, 0.12]]) {
        mkFog(side * (HALF_W + 2.5), 1.0, z, 7, 3, op);
      }
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

  // world point -> screen (CSS) pixels, or null if behind the camera.
  // Used to pin a shop's HTML prompt right under its vendor's model.
  projectToScreen(x, y, z) {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    if (v.z > 1) return null; // behind the camera
    const rect = this.renderer.domElement.getBoundingClientRect();
    return {
      x: rect.left + (v.x * 0.5 + 0.5) * rect.width,
      y: rect.top + (-v.y * 0.5 + 0.5) * rect.height,
    };
  }

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

  // binary-search the camera distance so the whole board fits, measured
  // from the fixed board center — the board pan offset is applied
  // afterward as a pure translation, never fed back into this search.
  fitCamera() {
    const corners = [
      new THREE.Vector3(-HALF_W - 0.8, 0, -HALF_H - 1.2),
      new THREE.Vector3(HALF_W + 0.8, 0, -HALF_H - 1.2),
      new THREE.Vector3(-HALF_W - 0.8, 0, HALF_H + 0.6),
      new THREE.Vector3(HALF_W + 0.8, 0, HALF_H + 0.6),
      new THREE.Vector3(0, 2.6, -HALF_H),
      // keep the plaza entrance on screen below the board (the deep
      // part is toured with the checkpoint follow-cam instead)
      new THREE.Vector3(0, 0.4, HALF_H + 4),
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
    const boardTarget = this.lookTarget.clone().add(this.boardPan);
    this.baseCamPos = boardTarget.clone().addScaledVector(this.boardDir, hi / this.boardZoom);
    this.baseCamLook = boardTarget;
  }

  placeCamera(dist) {
    this.camera.position.copy(this.lookTarget).addScaledVector(this.boardDir, dist);
    this.camera.lookAt(this.lookTarget);
    this.camera.updateMatrixWorld();
    this.camera.updateProjectionMatrix();
  }

  addShake(amount) {
    if (this.shakeEnabled === false) return;
    this.shake = Math.min(this.shake + amount, 0.7);
  }

  // checkpoint stroll: while set, the camera glides off its board
  // framing and tracks the given point (the local player) up close
  setFollow(x, z) {
    if (!this.followGoal) {
      this.followGoal = new THREE.Vector3(x, 0, z);
      this.followPos.set(x, 0, z);
    } else {
      this.followGoal.set(x, 0, z);
    }
  }

  clearFollow() { this.followGoal = null; }

  setShadows(on) { this.moon.castShadow = on; }

  update(dt) {
    this.time += dt;
    // crystal idle: bob + spin + pulse over its pedestal
    this.crystal.rotation.y += dt * 0.5;
    this.crystal.position.y = this.crystalBaseY + Math.sin(this.time * 1.6) * 0.12 + 0.05;
    const pulse = 0.55 + Math.sin(this.time * 2.2) * 0.18;
    this.crystalHurt = Math.max(this.crystalHurt - dt * 2, 0);
    for (const m of this.crystalMats) {
      m.emissiveIntensity = pulse + this.crystalHurt * 1.5;
      m.emissive.setHSL(0.55 - this.crystalHurt * 0.5, 0.85, 0.45);
    }
    this.crystalLight.intensity = 26 + Math.sin(this.time * 2.2) * 7 + this.crystalHurt * 40;

    // fountain water: shimmering surface + pulsing jet
    for (const w of this.waters) {
      w.water.material.emissiveIntensity = 0.55 + Math.sin(this.time * 2.4 + w.phase) * 0.2;
      w.water.rotation.z += dt * 0.4;
      const k = 1 + Math.sin(this.time * 5 + w.phase) * 0.12;
      w.jet.scale.set(1, k, 1);
      w.jet.material.opacity = 0.32 + Math.sin(this.time * 5 + w.phase) * 0.1;
    }

    // fog banks drift slowly between the trees
    for (const f of this.fogSprites) {
      f.spr.position.x = f.x0 + Math.sin(this.time * f.speed + f.phase) * f.amp;
    }

    // camera: blend between the fixed board framing and the checkpoint
    // follow-cam, then layer shake on top
    this.followBlend += ((this.followGoal ? 1 : 0) - this.followBlend) * Math.min(dt * 2, 1);
    this._camPos.copy(this.baseCamPos || this.camera.position);
    this._camLook.copy(this.baseCamLook || this.lookTarget);
    if (this.followBlend > 0.003) {
      if (this.followGoal) this.followPos.lerp(this.followGoal, Math.min(dt * 6, 1));
      const b = this.followBlend;
      const k = b * b * (3 - 2 * b); // smoothstep for a gentle glide
      const fd = this.CHK_BASE_DIST / this.followZoom;
      this._followCam.copy(this.followPos).addScaledVector(this.followDir, fd);
      this._camPos.lerp(this._followCam, k);
      this._camLook.lerp(this.followPos, k);
    }
    this.camera.position.copy(this._camPos);
    this.camera.lookAt(this._camLook);

    // camera shake decay
    if (this.shake > 0.001) {
      this.shake *= Math.exp(-6 * dt);
      this.camera.position.x += (Math.random() - 0.5) * this.shake;
      this.camera.position.y += (Math.random() - 0.5) * this.shake * 0.5;
      this.camera.position.z += (Math.random() - 0.5) * this.shake;
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
