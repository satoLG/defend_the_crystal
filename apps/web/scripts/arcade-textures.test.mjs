import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { textureModel, withArcadeTexture } from '../src/render/arcade-textures.js';

function compile(material) {
  const shader = {
    uniforms: {},
    vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader,
  };
  material.onBeforeCompile(shader);
  return shader;
}

test('palette maps, tint and detail survive the material clones used by actors', () => {
  const palette = new THREE.Texture();
  const source = new THREE.MeshStandardMaterial({ map: palette, color: 0x98ba76, roughness: 0.8 });
  const decorated = withArcadeTexture(source, 'grain', 2, 0.48);
  const clone = decorated.clone();
  assert.equal(clone.map, palette);
  assert.ok(clone.color.equals(source.color));
  assert.equal(clone.roughness, source.roughness);
  assert.deepEqual(clone.userData.arcade, decorated.userData.arcade);
  assert.equal(source.userData.arcade, undefined);
  const a = compile(decorated), b = compile(clone);
  assert.equal(a.uniforms.arcadeDetail.value, b.uniforms.arcadeDetail.value);
  assert.match(b.fragmentShader, /diffuseColor.rgb \*=/);
  assert.ok(b.vertexShader.indexOf('vArcadePosition = position') < b.vertexShader.indexOf('#include <skinning_vertex>'));
  // Recoloring and hit feedback still operate independently per actor.
  clone.map = new THREE.Texture();
  clone.color.set(0xff0000);
  assert.equal(decorated.map, palette);
  assert.ok(decorated.color.equals(source.color));
  assert.equal(compile(clone).uniforms.arcadeDetail.value, a.uniforms.arcadeDetail.value);
});

test('detail maps are shared, repeatable and mipmapped for distant terrain', () => {
  for (const kind of ['stone', 'grass', 'dirt', 'wood', 'grain']) {
    const tex = compile(withArcadeTexture(new THREE.MeshStandardMaterial(), kind)).uniforms.arcadeDetail.value;
    assert.equal(tex.image.width, 64);
    assert.equal(tex.image.height, 64);
    assert.equal(tex.magFilter, THREE.NearestFilter);
    assert.equal(tex.minFilter, THREE.LinearMipmapLinearFilter);
    assert.equal(tex.wrapS, THREE.RepeatWrapping);
    assert.equal(tex.generateMipmaps, true);
    assert.equal(tex.colorSpace, THREE.NoColorSpace);
    assert.equal(tex, compile(withArcadeTexture(new THREE.MeshStandardMaterial(), kind)).uniforms.arcadeDetail.value);
    assert.ok(new Set(tex.image.data).size > 3);
  }
});

test('model decoration leaves faces, transparent effects and magic crystals alone', () => {
  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1), new THREE.MeshStandardMaterial());
  const head = body.clone(); head.name = 'Head';
  const glass = new THREE.Mesh(body.geometry, new THREE.MeshStandardMaterial({ transparent: true }));
  group.add(body, head, glass);
  const headMaterial = head.material, glassMaterial = glass.material;
  textureModel(group, 'char-tanker');
  assert.equal(body.material.userData.arcade.kind, 'grain');
  assert.equal(body.material.userData.arcade.scale, 0.5);
  assert.equal(head.material, headMaterial);
  assert.equal(glass.material, glassMaterial);
  for (const key of ['env-crystal', 'enemy-ghost', 'ammo-arrow', 'env-tile']) {
    const mesh = new THREE.Mesh(body.geometry, new THREE.MeshStandardMaterial());
    const material = mesh.material;
    textureModel(mesh, key);
    assert.equal(mesh.material, material);
  }
});
