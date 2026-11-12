import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

function build(draw: (box: (w: number, h: number, l: number, x: number, y: number, z: number, shade: string, tilt?: number) => void,
  wheel: (x: number, z: number) => void) => void) {
  const parts: THREE.BufferGeometry[] = [];
  const add = (geometry: THREE.BufferGeometry, shade: string) => {
    const { r, g, b } = new THREE.Color(shade), count = geometry.getAttribute('position').count, color = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) { color[i * 3] = r; color[i * 3 + 1] = g; color[i * 3 + 2] = b; }
    geometry.setAttribute('color', new THREE.BufferAttribute(color, 3));
    parts.push(geometry);
  };
  draw(
    (w, h, l, x, y, z, shade, tilt = 0) => add(new THREE.BoxGeometry(w, h, l).rotateX(tilt).translate(x, y, z), shade),
    (x, z) => add(new THREE.CylinderGeometry(0.22, 0.22, 0.14, 6).rotateZ(Math.PI / 2).translate(x, 0.23, z), '#222026'),
  );
  const merged = mergeGeometries(parts)!;
  parts.forEach(part => part.dispose());
  return merged;
}

/** One mesh for the wheeled chassis and one for the rotating turret, including their trim. */
export function truckGeometry() {
  return build((box, wheel) => {
    box(0.83, 0.23, 1.62, 0, 0.31, 0, '#6c7174');
    box(0.89, 0.23, 1.23, 0, 0.53, -0.20, '#797e80');
    box(0.79, 0.22, 0.63, 0, 0.58, 0.53, '#7f8589', -0.12);
    box(0.67, 0.14, 0.08, 0, 0.70, 0.36, '#a4b5b8', 0.20);
    box(0.91, 0.09, 0.12, 0, 0.31, 0.82, '#404049');
    box(0.74, 0.10, 0.11, 0, 0.36, -0.81, '#4e484f');
    for (const side of [-1, 1]) {
      box(0.09, 0.10, 1.05, side * 0.43, 0.55, -0.09, '#f1f4f4');
      box(0.13, 0.10, 0.06, side * 0.29, 0.53, 0.84, '#fff5c5');
      wheel(side * 0.44, 0.53); wheel(side * 0.44, -0.53);
    }
  });
}

export function turretGeometry() {
  return build(box => {
    box(0.43, 0.24, 0.33, 0, -0.10, 0, '#878e91');
    box(0.36, 0.07, 0.24, 0, 0.025, 0, '#e8edf0');
    box(0.105, 0.10, 0.49, 0, 0, 0.31, '#737479');
    box(0.14, 0.13, 0.12, 0, 0, 0.52, '#cdd4d6');
  });
}
