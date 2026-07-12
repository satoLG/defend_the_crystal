import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { GRID } from '../config.js';

// ============================================================
// Loads every GLB once, normalizes scale (Kenney kits use
// different unit sizes), and hands out clones ready to render.
// norm: { h } scale to world height | { fp } scale to XZ footprint
//       | { tile: true } use the tower-defense kit tile factor
// ============================================================

const M = (url, norm) => ({ url: `models/${url}`, norm });

const MANIFEST = {
  // playable classes (rigged + animated)
  'char-berserker': M('characters/berserker.glb', { h: 1.35 }),
  'char-tanker': M('characters/tanker.glb', { h: 1.35 }),
  'char-archer': M('characters/archer.glb', { h: 1.35 }),
  'char-mage': M('characters/mage.glb', { h: 1.35 }),
  // enemies (rigged + animated)
  'enemy-skeleton': M('enemies/skeleton.glb', { h: 1.25 }),
  'enemy-zombie': M('enemies/zombie.glb', { h: 1.35 }),
  'enemy-ghost': M('enemies/ghost.glb', { h: 1.2 }),
  'enemy-orc': M('enemies/orc.glb', { h: 1.55 }),
  'enemy-vampire': M('enemies/vampire.glb', { h: 1.5 }),
  'enemy-keeper': M('enemies/keeper.glb', { h: 1.75 }),
  // towers
  'tower-ballista': M('towers/ballista.glb', { tile: true }),
  'tower-cannon': M('towers/cannon.glb', { tile: true }),
  'tower-catapult': M('towers/catapult.glb', { tile: true }),
  'tower-base': M('towers/base.glb', { tile: true }),
  'tower-crystals': M('towers/crystals.glb', { tile: true }),
  // ammo
  'ammo-arrow': M('ammo/arrow.glb', { tile: true }),
  'ammo-cannonball': M('ammo/cannonball.glb', { tile: true }),
  'ammo-boulder': M('ammo/boulder.glb', { tile: true }),
  // hand props
  'prop-sword': M('props/sword.glb', { h: 0.65 }),
  'prop-shield': M('props/shield.glb', { h: 0.55 }),
  'prop-staff': M('props/staff.glb', { h: 0.95 }),
  'prop-crystal': M('props/crystal-small.glb', { h: 0.3 }),
  // obstacles — big and chunky so they read as impassable
  'obstacle-barrel': M('obstacles/barrel.glb', { fp: 1.6 }),
  'obstacle-rocks': M('env/rocks-tall.glb', { h: 1.5 }),
  // environment
  'env-tile': M('env/tile.glb', { tile: true }),
  'env-tile-dirt': M('env/tile-dirt.glb', { tile: true }),
  'env-spawn': M('env/spawn.glb', { fp: 1.9 }),
  'env-crystal': M('env/crystal.glb', { h: 2.7 }),
  'env-fire': M('env/fire-basket.glb', { h: 1.15 }),
  'env-pine': M('env/pine.glb', { h: 3.4 }),
  'env-pine-crooked': M('env/pine-crooked.glb', { h: 2.9 }),
  'env-rocks-tall': M('env/rocks-tall.glb', { h: 1.6 }),
  'env-lantern': M('env/lantern.glb', { h: 1.5 }),
};

const templates = {};

export async function loadAssets(onProgress) {
  const loader = new GLTFLoader();
  const keys = Object.keys(MANIFEST);
  const raw = {};
  let done = 0;
  await Promise.all(keys.map(async (key) => {
    const base = import.meta.env.BASE_URL || './';
    raw[key] = await loader.loadAsync(base + MANIFEST[key].url);
    done += 1;
    onProgress?.(done / keys.length);
  }));

  // the TD-kit tile defines "1 kit unit"; scale it to our cell size
  const tileBox = new THREE.Box3().setFromObject(raw['env-tile'].scene);
  const tileSize = tileBox.getSize(new THREE.Vector3());
  const tileFactor = GRID.CELL / Math.max(tileSize.x, tileSize.z);

  for (const key of keys) {
    templates[key] = prepare(raw[key], MANIFEST[key].norm, tileFactor);
  }
  return templates;
}

function prepare(gltf, norm, tileFactor) {
  const scene = gltf.scene;
  const box = new THREE.Box3().setFromObject(scene);
  const size = box.getSize(new THREE.Vector3());
  let s = 1;
  if (norm.h) s = norm.h / Math.max(size.y, 1e-4);
  else if (norm.fp) s = norm.fp / Math.max(size.x, size.z, 1e-4);
  else if (norm.tile) s = tileFactor;
  scene.scale.setScalar(s);

  // re-center: feet on y=0, centered on XZ
  const box2 = new THREE.Box3().setFromObject(scene);
  const c = box2.getCenter(new THREE.Vector3());
  scene.position.x -= c.x;
  scene.position.z -= c.z;
  scene.position.y -= box2.min.y;

  const group = new THREE.Group();
  group.add(scene);
  return { group, animations: gltf.animations, factor: s };
}

export function getTemplate(key) {
  const t = templates[key];
  if (!t) throw new Error(`unknown model: ${key}`);
  return t;
}

// Fresh instance. cloneMaterials lets us flash hit feedback
// without affecting every other actor sharing the material.
export function instantiate(key, { cloneMaterials = false, shadows = true } = {}) {
  const t = getTemplate(key);
  const group = skeletonClone(t.group);
  group.traverse((o) => {
    if (o.isMesh || o.isSkinnedMesh) {
      if (shadows) { o.castShadow = true; o.receiveShadow = false; }
      if (o.isSkinnedMesh) o.frustumCulled = false;
      if (cloneMaterials && o.material) {
        o.material = Array.isArray(o.material)
          ? o.material.map((m) => m.clone())
          : o.material.clone();
      }
    }
  });
  return { group, animations: t.animations, factor: t.factor };
}
