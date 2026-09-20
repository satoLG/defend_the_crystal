import * as THREE from 'three';
import { addForestShade } from './forest-shade.js';
import { bakeTilePalette } from './terrain-palette.js';

// Small, deterministic detail maps multiply the existing palette rather than
// replacing it. Kenney's UVs often point into a single colour swatch: project
// detail in bind-pose object space so it works on those meshes too, follows
// animated characters, and never interferes with player colour customization.
const textures = new Map();

function detailTexture(kind) {
  if (textures.has(kind)) return textures.get(kind);
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  let seed = 731;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const pixel = (x, y, value) => {
    const i = (((y + size) % size) * size + ((x + size) % size)) * 4;
    const v = Math.round(value * 127.5); // 0.5 decodes to neutral, 1.0
    data.set([v, v, v, 255], i);
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      pixel(x, y, 0.97 + Math.floor(random() * 4) * 0.025);
    }
  }
  if (kind === 'stone') {
    // Staggered flagstones, shallow joints and chipped bright upper edges.
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const row = Math.floor(y / 16);
        const bx = (x + (row % 2) * 16) % 32;
        const by = y % 16;
        const shade = ((Math.floor((x + (row % 2) * 16) / 32) + row * 3) % 5) * 0.026;
        let value = 0.93 + shade + Math.floor(random() * 3) * 0.025;
        if (bx === 0 || by === 0) value = 0.65;
        else if (bx === 1 || by === 1) value = 1.16;
        else if (bx === 31 || by === 15) value = 0.82;
        pixel(x, y, value);
      }
    }
    for (let i = 0; i < 42; i++) {
      const x = Math.floor(random() * size), y = Math.floor(random() * size);
      pixel(x, y, 0.78); pixel(x + 1, y, 0.85); pixel(x, y + 1, 1.09);
    }
  } else if (kind === 'grass') {
    for (let i = 0; i < 210; i++) {
      const x = Math.floor(random() * size), y = Math.floor(random() * size);
      pixel(x, y, 0.8); pixel(x, y - 1, 1.18);
      pixel(x + 1, y - 2, 1.1); pixel(x - 1, y - 1, 0.9);
    }
  } else if (kind === 'dirt') {
    for (let i = 0; i < 130; i++) {
      const x = Math.floor(random() * size), y = Math.floor(random() * size);
      const v = random() > 0.65 ? 1.18 : 0.83;
      pixel(x, y, v); pixel(x + 1, y, v);
      if (i % 3 === 0) pixel(x, y + 1, 0.72);
    }
  } else if (kind === 'wood') {
    for (let i = 0; i < 150; i++) {
      const x = Math.floor(random() * size), y = Math.floor(random() * size);
      const length = 2 + Math.floor(random() * 7);
      for (let j = 0; j < length; j++) pixel(x, y + j, i % 3 ? 0.85 : 1.12);
    }
  } else {
    // Fine woven/dithered finish for outfits, armor, creatures and foliage.
    for (let y = 0; y < size; y += 2) {
      for (let x = 0; x < size; x += 2) {
        pixel(x, y, random() > 0.45 ? 0.78 : 1.16);
        pixel(x + 1, y + 1, 1.08);
      }
    }
  }
  const texture = new THREE.DataTexture(data, size, size);
  texture.name = `arcade-${kind}`;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.NearestFilter;
  // Crisp up close, filtered in the distance to avoid pixel shimmer on mobile.
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  textures.set(kind, texture);
  return texture;
}

// A subclass keeps the shader hook when existing game code clones a material
// for hit flashes, ghosts, character previews or per-instance tinting.
class ForestMaterial extends THREE.MeshStandardMaterial {
  customProgramCacheKey() { return 'dtc-forest-v2'; }
  onBeforeCompile(shader) { addForestShade(shader); }
}

class ArcadeMaterial extends ForestMaterial {
  customProgramCacheKey() { return 'dtc-arcade-forest-v2'; }

  onBeforeCompile(shader) {
    addForestShade(shader);
    const { kind, scale, strength } = this.userData.arcade;
    shader.uniforms.arcadeDetail = { value: detailTexture(kind) };
    shader.uniforms.arcadeScale = { value: scale };
    shader.uniforms.arcadeStrength = { value: strength };
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `
      #include <common>
      uniform float arcadeScale;
      varying vec3 vArcadePosition;
      varying vec3 vArcadeNormal;
    `).replace('#include <begin_vertex>', `
      #include <begin_vertex>
      vArcadePosition = position * arcadeScale;
      vArcadeNormal = normal;
    `);
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `
      #include <common>
      uniform sampler2D arcadeDetail;
      uniform float arcadeStrength;
      varying vec3 vArcadePosition;
      varying vec3 vArcadeNormal;
    `).replace('#include <map_fragment>', `
      #include <map_fragment>
      vec3 weights = pow(abs(normalize(vArcadeNormal)), vec3(8.0));
      weights /= max(dot(weights, vec3(1.0)), 0.0001);
      float detail = dot(weights, vec3(
        texture2D(arcadeDetail, vArcadePosition.zy).r,
        texture2D(arcadeDetail, vArcadePosition.xz).r,
        texture2D(arcadeDetail, vArcadePosition.xy).r
      )) * 2.0;
      diffuseColor.rgb *= mix(1.0, detail, arcadeStrength);
    `);
  }
}

export function withArcadeTexture(source, kind, scale = 1, strength = 0.75) {
  const material = new ArcadeMaterial().copy(source);
  material.userData.arcade = { kind, scale, strength };
  return material;
}

export function textureModel(group, key) {
  // Terrain gets a consistent world-sized treatment in scene.js. Keep magic
  // crystals, projectiles and translucent effects clean and immediately legible.
  if (/tile/.test(key)) return;
  const clean = /crystal|ammo-|cobweb|ghost/.test(key);
  const stone = /rocks|altar|bowl|pillar|column|statue|obelisk|gravestone|arena-wall|arena-block|tower-base/.test(key);
  const wood = /barrel|coffin|dungeon-stall|arena-rack|tower-ballista|tower-catapult/.test(key);
  const kind = stone ? 'stone' : wood ? 'wood' : 'grain';
  group.traverse((mesh) => {
    if (!mesh.isMesh) return;
    mesh.geometry.computeBoundingBox();
    const span = mesh.geometry.boundingBox.getSize(new THREE.Vector3());
    const scale = 1 / Math.max(span.x, span.y, span.z, 0.001);
    const decorate = material => {
      if (!material.isMeshStandardMaterial || material.isMeshPhysicalMaterial) return material;
      if (clean || /head/i.test(mesh.name) || material.transparent) return new ForestMaterial().copy(material);
      if (key.startsWith('env-pine')) {
        // Resolve the foliage palette once. The orange underside swatches
        // above the trunk become shaded green, keeping brown at the roots.
        mesh.geometry = mesh.geometry.clone();
        material = bakeTilePalette(mesh.geometry, material);
        const colors = mesh.geometry.attributes.color;
        const pos = mesh.geometry.attributes.position;
        const box = mesh.geometry.boundingBox;
        for (let i = 0; colors && i < colors.count; i++) {
          let r = colors.getX(i), g = colors.getY(i), b = colors.getZ(i);
          if (g > r) { r *= 1.05; g *= 0.92; b *= 0.34; }
          else if (pos.getY(i) > box.min.y + span.y * 0.22) {
            const light = Math.max(r, g, b);
            r = light * 0.12; g = light * 0.30; b = light * 0.035;
          }
          colors.setXYZ(i, r, g, b);
        }
      }
      return withArcadeTexture(material, kind, scale, stone ? 0.6 : wood ? 0.65 : 0.48);
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(decorate) : decorate(mesh.material);
  });
}
