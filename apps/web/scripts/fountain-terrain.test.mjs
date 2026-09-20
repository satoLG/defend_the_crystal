import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createFountain } from '../src/render/fountain.js';
import { bakeTilePalette } from '../src/render/terrain-palette.js';

test('basin water is the visible surface, not a stone cylinder cap', () => {
  const { group, waterMat, flowMat } = createFountain(1.9, 2);
  group.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(new THREE.Vector3(0.8, 4, 0.4), new THREE.Vector3(0, -1, 0));
  const hit = ray.intersectObject(group, true)[0];
  assert.equal(hit.object.name, 'basin-water');
  assert.ok(Math.abs(hit.point.y - 0.4) < 1e-5);
  assert.equal(hit.object.material, waterMat);
  assert.equal(waterMat.transparent, false);
  assert.equal(waterMat.userData.arcade, undefined);
  const upper = new THREE.Raycaster(new THREE.Vector3(0, 4, 0), new THREE.Vector3(0, -1, 0)).intersectObject(group, true)[0];
  assert.equal(upper.object.name, 'upper-water');
  const streams = group.children.filter(o => o.name.startsWith('falling-water-'));
  assert.equal(streams.length, 6);
  for (const stream of streams) {
    assert.equal(stream.material, flowMat);
    const end = stream.geometry.parameters.path.getPoint(1);
    assert.ok(Math.abs(end.y - 0.41) < 1e-5);
    assert.ok(Math.hypot(end.x, end.z) < 1.8);
  }
});

test('tile palette is resolved to linear vertex colours without mutating shared materials', () => {
  const map = new THREE.DataTexture(new Uint8Array([86, 193, 134, 255, 32, 137, 107, 255]), 2, 1);
  map.colorSpace = THREE.SRGBColorSpace;
  const source = new THREE.MeshStandardMaterial({ map });
  const geometry = new THREE.BufferGeometry();
  // A collapsed face UV sitting precisely on a texel boundary, plus a side.
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0.5, 0.5, 0.5, 0.5, 0.25, 0.5], 2));
  const result = bakeTilePalette(geometry, source);
  assert.equal(result.map, null);
  assert.equal(result.vertexColors, true);
  assert.equal(source.map, map);
  assert.equal(source.vertexColors, false);
  const colors = geometry.attributes.color;
  const expected = new THREE.Color().setRGB(32 / 255, 137 / 255, 107 / 255, THREE.SRGBColorSpace);
  assert.ok(Math.abs(colors.getY(0) - expected.g) < 1e-6);
  assert.equal(colors.getY(0), colors.getY(1));
  assert.notEqual(colors.getY(0), colors.getY(2));
});
