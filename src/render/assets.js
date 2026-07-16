import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { GRID } from '../config.js';

// ============================================================
// Loads every GLB once, normalizes scale (Kenney kits use
// different unit sizes), and hands out clones ready to render.
// norm: { h } scale to world height | { fp } scale to XZ footprint
//       | { tile: true } use the tower-defense kit tile factor
//       | { char: true } use ONE shared scale factor for every
//         humanoid — the factor that puts the berserker at 1.35 world
//         height. Kenney characters come from different kits with
//         different silhouettes (hair spikes, helmet crests), so
//         normalizing each to the same bounding-box height over-scales
//         the shorter-authored ones (the archer read noticeably bigger).
//         A shared factor keeps every body the same size instead.
//       | { raw: true } keep authored origin & scale — hand props
//         are authored with the grip exactly at the origin, so
//         they can be parented straight onto an arm bone
// ============================================================

const M = (url, norm) => ({ url: `models/${url}`, norm });

// world height the berserker (our reference character) renders at; the
// shared { char } factor is derived from it at load time
const CHAR_HEIGHT = 1.35;

const MANIFEST = {
  // playable classes (rigged + animated) — all share the berserker scale
  'char-berserker': M('characters/character-human.glb', { char: true }),
  'char-tanker': M('characters/character-soldier.glb', { char: true }),
  'char-archer': M('characters/archer.glb', { char: true }),
  'char-mage': M('characters/mage.glb', { char: true }),
  // enemies (rigged + animated) — normal-size enemies share it too;
  // bosses/subbosses still scale up on top (per-entity scale in the sim)
  'enemy-skeleton': M('enemies/skeleton.glb', { char: true }),
  'enemy-zombie': M('enemies/zombie.glb', { char: true }),
  'enemy-ghost': M('enemies/ghost.glb', { char: true }),
  'enemy-orc': M('enemies/orc.glb', { char: true }),
  'enemy-vampire': M('enemies/vampire.glb', { char: true }),
  'enemy-keeper': M('enemies/keeper.glb', { char: true }),
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
  // hand props (raw: grip at origin, sized for the mini characters)
  'prop-bow': M('props/bow.glb', { raw: true }),
  'prop-sword': M('props/sword.glb', { raw: true }),
  // survival-kit axe (different unit scale) — normalized at runtime by makeAxe
  'prop-axe': M('props/axe.glb', { raw: true }),
  'prop-shield': M('props/shield.glb', { raw: true }),
  'prop-staff': M('props/staff.glb', { raw: true }),
  'prop-crystal': M('props/crystal-small.glb', { raw: true }),
  // purchasable weapons (kit units differ — normalized by their makers)
  'prop-axe-great': M('props/axe-great.glb', { raw: true }),
  'prop-hammer': M('props/hammer.glb', { raw: true }),
  'prop-spear': M('props/spear.glb', { raw: true }),
  'prop-shield-great': M('props/shield-great.glb', { raw: true }),
  'prop-sword-great': M('props/sword-great.glb', { raw: true }),
  // graveyard-kit props for the boss powers (kit units — normalized here)
  'prop-gravestone': M('props/gravestone.glb', { h: 1.0 }),
  'prop-grave-mound': M('props/grave-mound.glb', { fp: 1.5 }),
  'prop-pumpkin': M('props/pumpkin.glb', { h: 0.55 }),
  'prop-shovel': M('props/shovel.glb', { raw: true }),
  'prop-coffin': M('props/coffin.glb', { raw: true }),
  // obstacles — big and chunky so they read as impassable
  'obstacle-barrel': M('obstacles/barrel.glb', { fp: 1.6 }),
  'obstacle-rocks': M('env/rocks-tall.glb', { h: 1.5 }),
  // companion pets (Kenney Cube Pets — node-animated: idle/walk/run/
  // eat/dance/gestures). Heights tuned per animal so they read as small
  // critters trotting at their hero's heels.
  'pet-dog': M('pets/animal-dog.glb', { h: 0.55 }),
  'pet-cat': M('pets/animal-cat.glb', { h: 0.5 }),
  'pet-pig': M('pets/animal-pig.glb', { h: 0.5 }),
  'pet-crab': M('pets/animal-crab.glb', { h: 0.4 }),
  'pet-bunny': M('pets/animal-bunny.glb', { h: 0.52 }),
  'pet-fox': M('pets/animal-fox.glb', { h: 0.52 }),
  'pet-lion': M('pets/animal-lion.glb', { h: 0.6 }),
  'pet-tiger': M('pets/animal-tiger.glb', { h: 0.6 }),
  'pet-giraffe': M('pets/animal-giraffe.glb', { h: 0.95 }),
  'pet-elephant': M('pets/animal-elephant.glb', { h: 0.68 }),
  'pet-hog': M('pets/animal-hog.glb', { h: 0.55 }),
  'pet-monkey': M('pets/animal-monkey.glb', { h: 0.55 }),
  'pet-panda': M('pets/animal-panda.glb', { h: 0.6 }),
  // mini-dungeon kit pieces: the pet vendor's stall + gold coins
  'dungeon-coin': M('dungeon/coin.glb', { h: 0.34 }),
  'dungeon-stall': M('dungeon/wood-structure.glb', { fp: 2.6 }),
  'dungeon-banner': M('dungeon/banner.glb', { h: 1.1 }),
  'dungeon-chest': M('dungeon/chest.glb', { fp: 0.9 }),
  // mini-arena kit pieces: the weapon smith's hut across the plaza
  'arena-rack': M('arena/weapon-rack.glb', { h: 1.5 }),
  'arena-wall': M('arena/wall.glb', { h: 1.7 }),
  'arena-banner': M('arena/banner.glb', { h: 1.6 }),
  'arena-column': M('arena/column.glb', { h: 1.9 }),
  'arena-trophy': M('arena/trophy.glb', { h: 0.55 }),
  'arena-block': M('arena/block.glb', { fp: 0.85 }),
  // environment
  'env-tile': M('env/tile.glb', { tile: true }),
  'env-tile-dirt': M('env/tile-dirt.glb', { tile: true }),
  'env-crystal': M('env/crystal.glb', { h: 2.7 }),
  'env-pine': M('env/pine.glb', { h: 3.4 }),
  'env-pine-crooked': M('env/pine-crooked.glb', { h: 2.9 }),
  'env-rocks-tall': M('env/rocks-tall.glb', { h: 1.6 }),
  'env-lantern': M('env/lantern.glb', { h: 1.5 }),
  // sanctuary — stone ruins & fountains around the crystal
  'env-altar': M('env/altar-stone.glb', { fp: 2.3 }),
  'env-bowl': M('env/bowl.glb', { fp: 1.5 }),
  'env-pillar-small': M('env/pillar-small.glb', { h: 0.95 }),
  'env-column': M('env/column.glb', { h: 2.7 }),
  'env-column-damaged': M('env/column-damaged.glb', { h: 1.9 }),
  'env-statue': M('env/statue.glb', { h: 2.3 }),
  'env-obelisk': M('env/obelisk.glb', { h: 2.5 }),
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

  // one shared scale for every humanoid: the factor that renders the
  // berserker at CHAR_HEIGHT, applied to all { char } models so they
  // stay the same size regardless of their authored silhouette
  const berBox = new THREE.Box3().setFromObject(raw['char-berserker'].scene);
  const charFactor = CHAR_HEIGHT / Math.max(berBox.getSize(new THREE.Vector3()).y, 1e-4);

  for (const key of keys) {
    templates[key] = prepare(raw[key], MANIFEST[key].norm, tileFactor, charFactor);
  }
  return templates;
}

function prepare(gltf, norm, tileFactor, charFactor) {
  const scene = gltf.scene;
  const group = new THREE.Group();
  group.add(scene);
  if (norm.raw) return { group, animations: gltf.animations, factor: 1 };

  const box = new THREE.Box3().setFromObject(scene);
  const size = box.getSize(new THREE.Vector3());
  let s = 1;
  if (norm.char) s = charFactor;
  else if (norm.h) s = norm.h / Math.max(size.y, 1e-4);
  else if (norm.fp) s = norm.fp / Math.max(size.x, size.z, 1e-4);
  else if (norm.tile) s = tileFactor;
  scene.scale.setScalar(s);

  // re-center: feet on y=0, centered on XZ
  const box2 = new THREE.Box3().setFromObject(scene);
  const c = box2.getCenter(new THREE.Vector3());
  scene.position.x -= c.x;
  scene.position.z -= c.z;
  scene.position.y -= box2.min.y;

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
