import { GRID } from '@dtc/shared/config.js';
import { PLAZA, STAIRS } from '@dtc/shared/sanctuary.js';

const halfW = GRID.COLS * GRID.CELL / 2;
const halfH = GRID.ROWS * GRID.CELL / 2;
const south = halfH + PLAZA.DEPTH;
const f = value => Number(value).toFixed(4);

// World-space falloff, after lighting/tone mapping: distant woods reach the
// same black as the background regardless of camera aspect, angle or exposure.
// Reconstruct world position from mvPosition so skinning and instancing agree.
export function addForestShade(shader) {
  shader.vertexShader = shader.vertexShader.replace('#include <common>', `
    #include <common>
    varying vec3 vForestWorld;
  `).replace('#include <project_vertex>', `
    #include <project_vertex>
    vForestWorld = cameraPosition + vec3(
      dot(viewMatrix[0].xyz, mvPosition.xyz),
      dot(viewMatrix[1].xyz, mvPosition.xyz),
      dot(viewMatrix[2].xyz, mvPosition.xyz)
    );
  `);
  shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `
    #include <common>
    varying vec3 vForestWorld;
  `).replace('#include <fog_fragment>', `
    #include <fog_fragment>
    float forestWidth = mix(${f(halfW)}, ${f(PLAZA.HALF_W)}, smoothstep(${f(STAIRS.TOP)}, ${f(STAIRS.BOTTOM)}, vForestWorld.z));
    vec2 outside = max(vec2(abs(vForestWorld.x) - forestWidth,
      max(${f(-halfH)} - vForestWorld.z, vForestWorld.z - ${f(south)})), vec2(0.0));
    float forestDark = smoothstep(0.35, 7.0, length(outside));
    // Spawn cells are outside the buildable band. Enemies emerge from the
    // same shroud as the trees, rather than appearing on a lit tile.
    float spawnDark = 1.0 - smoothstep(${f(-halfH + 0.5)}, ${f(-halfH + GRID.CELL * 2.4)}, vForestWorld.z);
    gl_FragColor.rgb *= 1.0 - max(forestDark, spawnDark * 0.98);
  `);
}
