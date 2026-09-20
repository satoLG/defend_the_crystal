import * as THREE from 'three';
import { withArcadeTexture } from './arcade-textures.js';

function waterMaterial(flow = false) {
  return new THREE.ShaderMaterial({
    // Basin water is opaque so the stone floor cannot show through it.
    transparent: flow, depthWrite: !flow, side: flow ? THREE.DoubleSide : THREE.FrontSide,
    fog: true,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uT: { value: 0 } }]),
    vertexShader: `
      varying vec2 vUv;
      #include <fog_pars_vertex>
      void main() {
        vUv = uv;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `
      uniform float uT;
      varying vec2 vUv;
      #include <fog_pars_fragment>
      void main() {
        ${flow ? `
          float streak = pow(0.5 + 0.5 * sin(vUv.x * 45.0 - uT * 9.0 + sin(vUv.y * 19.0)), 3.0);
          float edge = pow(0.5 + 0.5 * sin(vUv.y * 6.28318), 4.0);
          vec3 col = mix(vec3(0.07, 0.43, 0.60), vec3(0.69, 0.96, 1.0), streak * 0.65 + edge * 0.3);
          gl_FragColor = vec4(col, 0.76 + streak * 0.2);
        ` : `
          vec2 p = vUv * 2.0 - 1.0;
          float r = length(p);
          float ripple = sin(r * 28.0 - uT * 2.4 + sin(p.x * 6.0 + uT) * 0.7);
          float crossWave = sin(p.x * 12.0 + p.y * 9.0 + uT * 1.5);
          float highlight = smoothstep(0.7, 0.98, ripple) * 0.13;
          vec3 col = mix(vec3(0.018, 0.17, 0.26), vec3(0.055, 0.40, 0.49), 0.45 + ripple * 0.16 + crossWave * 0.1);
          col += vec3(0.3, 0.7, 0.78) * highlight;
          // Soft foam at the rim and expanding rings below the falling water.
          float foam = smoothstep(0.84, 1.0, r) * (0.45 + 0.2 * sin(atan(p.y, p.x) * 16.0 + uT));
          float splash = exp(-pow((r - 0.55) * 9.0, 2.0)) * smoothstep(0.80, 0.98, sin(r * 52.0 - uT * 4.0));
          col = mix(col, vec3(0.62, 0.91, 0.94), foam + splash * 0.3);
          gl_FragColor = vec4(col, 1.0);
        `}
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
}

export function createFountain(radius, cellSize) {
  const group = new THREE.Group();
  group.name = 'fountain';
  const stone = withArcadeTexture(new THREE.MeshStandardMaterial({ color: 0x9298ac, roughness: 0.9, flatShading: true }), 'stone', 1 / cellSize, 0.6);
  const innerStone = stone.clone(); innerStone.side = THREE.BackSide;
  const waterMat = waterMaterial();
  const flowMat = waterMaterial(true);
  const add = (name, geometry, material, y) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name; mesh.position.y = y;
    group.add(mesh);
    return mesh;
  };
  const disc = (name, r, material, y, segments = 8) => {
    const mesh = add(name, new THREE.CircleGeometry(r, segments), material, y);
    mesh.rotation.x = -Math.PI / 2;
    return mesh;
  };
  // Open walls and an annular rim: no solid cylinder lid above the water.
  add('basin-outer-wall', new THREE.CylinderGeometry(radius + 0.1, radius + 0.22, 0.52, 8, 1, true), stone, 0.26).receiveShadow = true;
  add('basin-inner-wall', new THREE.CylinderGeometry(radius - 0.1, radius - 0.1, 0.52, 8, 1, true), innerStone, 0.26);
  const rim = add('basin-rim', new THREE.RingGeometry(radius - 0.1, radius + 0.1, 8), stone, 0.52);
  rim.rotation.x = -Math.PI / 2;
  disc('basin-floor', radius - 0.1, stone, 0.05);
  disc('basin-water', radius - 0.105, waterMat, 0.40);

  // A stone pedestal with a shallow spill tray, replacing the old goblet.
  add('pedestal-foot', new THREE.CylinderGeometry(0.34, 0.42, 0.18, 8), stone, 0.49);
  add('pedestal-column', new THREE.CylinderGeometry(0.22, 0.29, 0.78, 8), stone, 0.94);
  add('spill-tray', new THREE.CylinderGeometry(0.51, 0.30, 0.18, 8), stone, 1.40);
  disc('upper-water', 0.515, waterMat, 1.505);
  // Six small curved streams share a scrolling shader (no particle system).
  for (let i = 0; i < 6; i++) {
    const angle = i * Math.PI / 3;
    const point = (r, y) => new THREE.Vector3(Math.cos(angle) * r, y, Math.sin(angle) * r);
    const curve = new THREE.CatmullRomCurve3([
      point(0.46, 1.505), point(0.64, 1.44), point(0.86, 1.10), point(1.0, 0.41),
    ]);
    add('falling-water-' + i, new THREE.TubeGeometry(curve, 12, 0.055, 5, false), flowMat, 0);
  }
  const glow = new THREE.PointLight(0x66c8e8, 5, 7, 2);
  glow.position.y = 1.6; group.add(glow);
  return { group, waterMat, flowMat };
}
