import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createStairVerge } from '../src/render/stair-verge.js';
import { STAIRS, terrainY } from '@dtc/shared/sanctuary.js';

test('both stair flanks have continuous ground beneath the tree cover', () => {
  const verge = createStairVerge();
  verge.updateMatrixWorld(true);
  const ray = new THREE.Raycaster();
  for (const side of [-1, 1]) {
    for (let z = STAIRS.TOP; z <= STAIRS.BOTTOM; z += 0.2) {
      for (const x of [8.21, 8.5, 8.99, 10]) {
        ray.set(new THREE.Vector3(side * x, 2, z), new THREE.Vector3(0, -1, 0));
        const hits = ray.intersectObject(verge);
        assert.ok(hits.length, `missing ground at ${side * x}, ${z}`);
        assert.ok(hits[0].point.y <= terrainY(z));
      }
    }
  }
  ray.set(new THREE.Vector3(0, 2, 18), new THREE.Vector3(0, -1, 0));
  assert.equal(ray.intersectObject(verge).length, 0, 'walkable stair area stays clear');
  assert.equal(verge.geometry.index.count / 3, 20, 'cheap continuous backing');
});
