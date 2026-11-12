import * as THREE from 'three';
import { CONFIG, TEAM_COLORS } from './config.ts';

type Point = [x: number, y: number, z: number];
type Face = readonly number[];
type Part = { points: readonly Point[]; faces: readonly Face[]; color: THREE.Color };

const black = new THREE.Color('#20242b');
const gold = new THREE.Color('#ffb62e');
const visorGreen = new THREE.Color(TEAM_COLORS[0]);
const capePurple = new THREE.Color('#a84be0');

// X and Z are in capsule radii, Y is in world units above the body origin.
// The game uses +Z for the visor and +X for the rifle side.
function armorPart(points: Point[], faces: Face[], color = gold): Part {
  const center = new THREE.Vector3();
  for (const point of points) center.add(new THREE.Vector3(...point));
  center.multiplyScalar(1 / points.length);
  return {
    points,
    color,
    faces: faces.map(face => {
      const a = new THREE.Vector3(...points[face[0]]);
      const b = new THREE.Vector3(...points[face[1]]);
      const c = new THREE.Vector3(...points[face[2]]);
      return b.sub(a).cross(c.sub(a)).dot(a.sub(center)) > 0 ? face : [...face].reverse();
    }),
  };
}

function epaulet(side: number) {
  return armorPart([
    [side * 0.50, 0.22, -0.42], [side * 0.50, 0.22, 0.49],
    [side * 1.37, 0.18, 0.50], [side * 1.41, 0.18, -0.44],
    [side * 1.66, 0.01, 0.46], [side * 1.66, 0.01, -0.46],
  ], [[0, 1, 2, 3], [3, 2, 4, 5], [1, 4, 2], [0, 3, 5]]);
}

function earPiece(side: number) {
  return armorPart([
    [side * 0.53, 0.34, 0.19], [side * 0.64, 0.44, -0.22],
    [side * 1.09, 0.35, 0.05], [side * 1.44, 0.61, -0.51],
  ], [[0, 1, 3], [0, 3, 2], [1, 2, 3]], visorGreen);
}

function cheekGuard(side: number) {
  return armorPart([
    [side * 0.48, 0.35, 0.78], [side * 0.81, 0.35, 0.56],
    [side * 0.53, 0.25, 0.97], [side * 0.70, 0.31, 1.04],
  ], [[0, 3, 1], [0, 2, 3], [1, 3, 2]]);
}

function yokeWing(side: number) {
  return armorPart([
    [side * 0.32, 0.25, -0.83], [side * 0.88, 0.26, -0.47],
    [side * 1.44, 0.24, -1.21], [side * 0.72, 0.12, -0.72],
  ], [[0, 1, 2], [1, 3, 2]]);
}

// A folded sheet with a short gold hem, baked in both directions so it uses the
// same opaque, front-face material as the rest of the body.
const cape: Part = {
  points: [[-0.73, 0.21, -0.68], [0.73, 0.21, -0.68],
    [-2.03, -0.30, -2.02], [0.29, -0.38, -2.94], [2.46, -0.30, -1.86]],
  faces: [[0, 2, 3], [0, 3, 1], [1, 3, 4]],
  color: capePurple,
};
const capeHem: Part = {
  points: [cape.points[2], cape.points[3], cape.points[4],
    [-2.11, -0.39, -2.14], [2.54, -0.39, -1.98]],
  faces: [[0, 3, 1], [1, 4, 2]],
  color: gold,
};
const reverseFaces = (part: Part): Part => ({ ...part, faces: part.faces.map(face => [...face].reverse()) });

function crown(): Part[] {
  const points: Point[] = [], faces: Face[] = [];
  const tips = 4;
  for (let i = 0; i < tips; i++) {
    const angle = i * 2 * Math.PI / tips - Math.PI / tips;
    const tipAngle = angle + Math.PI / tips;
    points.push(
      [0.94 * Math.sin(angle), 0.491, 0.94 * Math.cos(angle)],
      [0.98 * Math.sin(angle), 0.552, 0.98 * Math.cos(angle)],
      [1.01 * Math.sin(tipAngle), 0.68, 1.01 * Math.cos(tipAngle)],
    );
    const base = i * 3, next = ((i + 1) % tips) * 3;
    faces.push([base, next, next + 1, base + 1], [base + 1, next + 1, base + 2]);
  }
  const outer = { points, faces, color: visorGreen };
  const inner = reverseFaces(outer);
  // The inner wall slopes into the capsule so the band sits on the dome.
  inner.points = points.map(([x, y, z], i) => i % 3 === 0 ? [x * 0.50, y - 0.02, z * 0.50] : [x, y, z]);
  return [outer, inner];
}

const additions: readonly (readonly Part[])[] = [
  [epaulet(1)],
  [epaulet(-1)],
  [armorPart([
    [-0.62, 0.411, 0.47], [0.62, 0.411, 0.47], [0.77, 0.412, 0.80],
    [0, 0.402, 1.21], [-0.77, 0.412, 0.80], [0, 0.515, 0.55],
  ], [[0, 4, 5], [4, 3, 5], [3, 2, 5], [2, 1, 5], [2, 3, 4]])],
  [earPiece(1), earPiece(-1)],
  [armorPart([
    [0.02, 0.50, 0.21], [0.35, 0.50, 0.19], [0.43, 0.50, -0.49],
    [0.08, 0.50, -0.52], [0.40, 0.83, -0.94],
  ], [[0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4]])],
  [cheekGuard(1), cheekGuard(-1)],
  [yokeWing(1), yokeWing(-1)],
  [cape, reverseFaces(cape), capeHem, reverseFaces(capeHem)],
  crown(),
];

/** Three rings and two poles leave room for the armor within the capsule's triangle budget. */
function rankedCapsule(radius: number): Part {
  const half = CONFIG.soldier.height / 2;
  const sides = 6;
  const points: Point[] = [], faces: Face[] = [];
  const rings = [[1, -half + radius * 0.70], [1, half - radius * 0.85], [0.65, half - radius * 0.23]];
  for (const [width, y] of rings) {
    for (let i = 0; i < sides; i++) {
      const angle = (i + 0.5) * 2 * Math.PI / sides;
      points.push([width * Math.sin(angle), y, width * Math.cos(angle)]);
    }
  }
  const bottom = points.push([0, -half, 0]) - 1;
  const top = points.push([0, half, 0]) - 1;
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    faces.push([bottom, j, i], [i, j, j + sides, i + sides],
      [i + sides, j + sides, j + 2 * sides, i + 2 * sides],
      [i + 2 * sides, j + 2 * sides, top]);
  }
  return { points, faces, color: black };
}

export function makeRankBody(radius: number) {
  const positions: number[] = [], colors: number[] = [], unlocks: number[] = [], indices: number[] = [];
  const indexCountByLevel = [0];
  const partsByLevel = [[rankedCapsule(radius)], ...additions];
  for (const [index, parts] of partsByLevel.entries()) {
    for (const { points, faces, color } of parts) {
      const start = positions.length / 3;
      for (const [x, y, z] of points) {
        positions.push(x * radius, y, z * radius);
        colors.push(color.r, color.g, color.b);
        unlocks.push(index + 1);
      }
      for (const face of faces) {
        for (let i = 1; i < face.length - 1; i++) {
          indices.push(start + face[0], start + face[i], start + face[i + 1]);
        }
      }
    }
    indexCountByLevel.push(indices.length);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('aUnlockLevel', new THREE.Uint8BufferAttribute(unlocks, 1));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return { geometry, indexCountByLevel };
}
