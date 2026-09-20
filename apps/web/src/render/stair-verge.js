import * as THREE from 'three';
import { PLAZA, STAIRS, terrainY } from '@dtc/shared/sanctuary.js';
import { withArcadeTexture } from './arcade-textures.js';

// A continuous forest floor behind the foliage: the tile apron starts at
// x=9 but the staircase ends at x=8.2. Canopies alone cannot seal that gap.
export function createStairVerge() {
  const positions = [], indices = [];
  const rows = [STAIRS.TOP - 0.5, STAIRS.TOP,
    STAIRS.TOP + STAIRS.FLIGHT,
    STAIRS.TOP + STAIRS.FLIGHT + STAIRS.LANDING,
    STAIRS.BOTTOM, STAIRS.BOTTOM + 0.6];
  for (const side of [-1, 1]) {
    const start = positions.length / 3;
    for (const z of rows) {
      positions.push(side * (PLAZA.HALF_W + 0.2), terrainY(z) - 0.32, z);
      positions.push(side * (PLAZA.HALF_W + 3), terrainY(z) - 0.04, z);
    }
    for (let i = 0; i < rows.length - 1; i++) {
      const a = start + i * 2;
      const faces = [a, a + 2, a + 1, a + 1, a + 2, a + 3];
      indices.push(...(side > 0 ? faces : faces.reverse()));
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const material = withArcadeTexture(new THREE.MeshStandardMaterial({
    color: 0x355b24, roughness: 1,
  }), 'grass', 0.5, 0.55);
  const verge = new THREE.Mesh(geometry, material);
  verge.name = 'stair-forest-verge';
  verge.receiveShadow = true;
  return verge;
}
