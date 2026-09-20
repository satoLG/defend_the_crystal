import * as THREE from 'three';

// The kit's flat tile faces collapse all UVs onto one palette coordinate.
// Nearest sampling around a swatch/texel boundary can alternate colours as
// the camera moves. Resolve the palette once at load time, then interpolate
// vertex colours instead. The separate arcade detail texture still tiles.
export function bakeTilePalette(geometry, source) {
  const map = source.map;
  if (!map?.image || !geometry.attributes.uv) return source;
  const { width, height } = map.image;
  let pixels = map.image.data;
  if (!pixels) {
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(map.image, 0, 0);
    pixels = ctx.getImageData(0, 0, width, height).data;
  }
  map.updateMatrix();
  const uv = geometry.attributes.uv;
  const colors = new Float32Array(uv.count * 3);
  const point = new THREE.Vector2(), color = new THREE.Color();
  for (let i = 0; i < uv.count; i++) {
    point.fromBufferAttribute(uv, i);
    map.transformUv(point);
    const x = Math.min(width - 1, Math.max(0, Math.floor(point.x * width)));
    const y = Math.min(height - 1, Math.max(0, Math.floor(point.y * height)));
    const p = (y * width + x) * 4;
    color.setRGB(pixels[p] / 255, pixels[p + 1] / 255, pixels[p + 2] / 255, map.colorSpace);
    color.toArray(colors, i * 3);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const material = source.clone();
  material.map = null;
  material.vertexColors = true;
  return material;
}
