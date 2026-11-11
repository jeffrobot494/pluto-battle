import * as THREE from 'three';
import { MAX_SLOPE, Terrain, type TerrainPalette } from './terrain.ts';
import { random } from './random.ts';
import { polylineDistance, smooth } from './terrain-shapes.ts';

/** Look of the flat fixture and of maps made before palettes existed. */
export const DEFAULT_PALETTE: TerrainPalette = {
  low: '#66333f', high: '#79607f', cliff: '#53445f', ramp: '#8b687d', rocks: ['#79607f', '#66506f', '#8b687d', '#53445f'],
  sky: '#9a7886', hemiSky: '#e5d8f5', hemiGround: '#68313b', sun: '#ffd8b9', sunIntensity: 3, skirt: '#57333f', backdrop: '#68516f', strata: 0,
};
export const paletteOf = (terrain: Terrain | null) => terrain?.palette ?? DEFAULT_PALETTE;

export function loadBedrockDetail() {
  // Keep the palette visible while the texture loads or if the request fails.
  const strength = { value: 0 };
  const texture = new THREE.TextureLoader().load(
    `${import.meta.env.BASE_URL}textures/alien-bedrock.webp`,
    () => { strength.value = 2.5; },
  );
  texture.wrapS = texture.wrapT = THREE.MirroredRepeatWrapping;
  return { texture, strength };
}

function bedrockMaterial(detail: ReturnType<typeof loadBedrockDetail>, parameters: THREE.MeshStandardMaterialParameters) {
  const material = new THREE.MeshStandardMaterial(parameters);
  material.onBeforeCompile = shader => {
    shader.uniforms.bedrockMap = { value: detail.texture };
    shader.uniforms.bedrockStrength = detail.strength;
    shader.vertexShader = `varying vec3 vBedrockPosition;
varying vec3 vBedrockNormal;
${shader.vertexShader}`.replace('#include <begin_vertex>', `#include <begin_vertex>
  vBedrockPosition = position / 9.0;
  vBedrockNormal = normal;`);
    shader.fragmentShader = `uniform sampler2D bedrockMap;
uniform float bedrockStrength;
varying vec3 vBedrockPosition;
varying vec3 vBedrockNormal;
${shader.fragmentShader}`.replace('#include <color_fragment>', `#include <color_fragment>
  if (bedrockStrength > 0.0) {
    // Blend across three axes so the detail keeps its scale on steep faces.
    vec3 weights = abs(vBedrockNormal);
    weights *= weights;
    weights /= weights.x + weights.y + weights.z;
    float grain = dot(weights, vec3(
      texture2D(bedrockMap, vBedrockPosition.zy).r,
      texture2D(bedrockMap, vBedrockPosition.xz).r,
      texture2D(bedrockMap, vBedrockPosition.xy).r
    ));
    diffuseColor.rgb *= 1.0 + (grain - 0.53) * bedrockStrength;
  }`);
  };
  return material;
}

/** Meshes are made from the exact support triangles and convex rock planes.
 * Children: 0 ground, 1 rocks, then edge walls, backdrop and skirt. */
export function addTerrainWorld(world: THREE.Group, terrain: Terrain, detail: ReturnType<typeof loadBedrockDetail>) {
  const rng = random(terrain.seed ^ 0x41b693), vertices: number[] = [], colors: number[] = [], palette = paletteOf(terrain);
  const color = new THREE.Color(), low = new THREE.Color(palette.low), high = new THREE.Color(palette.high), cliff = new THREE.Color(palette.cliff), ramp = new THREE.Color(palette.ramp);
  const span = Math.max(1, terrain.maxHeight - terrain.minHeight), h = terrain.heights, stride = terrain.columns + 1;
  const vertex = (c: number, r: number) => { vertices.push(-terrain.halfWidth + c * terrain.dx, h[r * stride + c], -terrain.halfDepth + r * terrain.dz); color.toArray(colors, colors.length); };
  const ramps = terrain.ramps.map(p => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i + 1 < p.points.length; i += 2) { x0 = Math.min(x0, p.points[i]); x1 = Math.max(x1, p.points[i]); z0 = Math.min(z0, p.points[i + 1]); z1 = Math.max(z1, p.points[i + 1]); }
    return { ...p, x0: x0 - p.halfWidth, x1: x1 + p.halfWidth, z0: z0 - p.halfWidth, z1: z1 + p.halfWidth };
  });
  const phase = rng() * 6.283;
  for (let r = 0; r < terrain.rows; r++) for (let c = 0; c < terrain.columns; c++) {
    const x = -terrain.halfWidth + (c + 0.5) * terrain.dx, z = -terrain.halfDepth + (r + 0.5) * terrain.dz;
    let road = 0;
    for (const p of ramps) if (x > p.x0 && x < p.x1 && z > p.z0 && z < p.z1) road = Math.max(road, 1 - smooth((polylineDistance(p.points, x, z) - p.halfWidth * 0.7) / 0.6));
    for (let side = 0; side < 2; side++) {
      const a = side ? h[r * stride + c + 1] : h[r * stride + c], b = h[(r + 1) * stride + c], d = side ? h[(r + 1) * stride + c + 1] : h[r * stride + c + 1];
      const y = (a + b + d) / 3, t = (y - terrain.minHeight) / span, slope = terrain.slope[(r * terrain.columns + c) * 2 + side];
      color.copy(low).lerp(high, Math.pow(t, 0.85));
      // Strata: horizontal bands that read as layered rock on cliffs.
      if (palette.strata) color.multiplyScalar(1 + palette.strata * 0.09 * Math.sin(y * 2.1 + phase + Math.sin(y * 0.7) * 1.5));
      color.lerp(cliff, smooth((slope - MAX_SLOPE * 0.7) / (MAX_SLOPE * 0.35)));
      if (road) color.lerp(ramp, road * 0.28);
      color.multiplyScalar(0.9 + rng() * 0.18);
      if (!side) { vertex(c, r); vertex(c, r + 1); vertex(c + 1, r); }
      else { vertex(c + 1, r); vertex(c, r + 1); vertex(c + 1, r + 1); }
    }
  }
  const ground = new THREE.BufferGeometry(); ground.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3)); ground.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3)); ground.computeVertexNormals();
  world.add(new THREE.Mesh(ground, bedrockMaterial(detail, { vertexColors: true, roughness: 1, flatShading: true })));

  const positions: number[] = [], rockColors: number[] = [];
  for (let i = 0; i < terrain.rocks.length; i++) {
    const rock = terrain.rocks[i]; color.set(palette.rocks[i % palette.rocks.length]);
    const point = (s: number, top: boolean) => { const a = rock.angle + s * Math.PI / 4, radius = rock.radius * (top ? 0.55 : 1); positions.push(rock.x + Math.cos(a) * radius, rock.base + (top ? rock.height * 0.78 : 0), rock.z + Math.sin(a) * radius); color.toArray(rockColors, rockColors.length); };
    for (let s = 0; s < 8; s++) {
      point(s, false); point(s, true); point(s + 1, false);
      point(s + 1, false); point(s, true); point(s + 1, true);
      positions.push(rock.x, rock.base + rock.height, rock.z); color.toArray(rockColors, rockColors.length); point(s + 1, true); point(s, true);
    }
  }
  const rocks = new THREE.BufferGeometry(); rocks.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); rocks.setAttribute('color', new THREE.Float32BufferAttribute(rockColors, 3)); rocks.computeVertexNormals();
  world.add(new THREE.Mesh(rocks, bedrockMaterial(detail, { vertexColors: true, roughness: 0.98, flatShading: true })));

  // Edge walls: the battlefield reads as a raised block of ground, not a paper-thin sheet.
  const wall: number[] = [], bottom = terrain.minHeight - 1.5;
  const edge = (c0: number, r0: number, c1: number, r1: number) => {
    const x0 = -terrain.halfWidth + c0 * terrain.dx, z0 = -terrain.halfDepth + r0 * terrain.dz, x1 = -terrain.halfWidth + c1 * terrain.dx, z1 = -terrain.halfDepth + r1 * terrain.dz;
    const y0 = h[r0 * stride + c0], y1 = h[r1 * stride + c1];
    wall.push(x0, y0, z0, x1, y1, z1, x0, bottom, z0, x1, y1, z1, x1, bottom, z1, x0, bottom, z0);
  };
  for (let c = 0; c < terrain.columns; c++) { edge(c + 1, 0, c, 0); edge(c, terrain.rows, c + 1, terrain.rows); }
  for (let r = 0; r < terrain.rows; r++) { edge(0, r, 0, r + 1); edge(terrain.columns, r + 1, terrain.columns, r); }
  const walls = new THREE.BufferGeometry(); walls.setAttribute('position', new THREE.Float32BufferAttribute(wall, 3)); walls.computeVertexNormals();
  world.add(new THREE.Mesh(walls, bedrockMaterial(detail, { color: new THREE.Color(palette.cliff).multiplyScalar(0.75), roughness: 1, side: THREE.DoubleSide })));

  // Distant scenery stays outside the active rectangle and never hides obstacles; it grows with the relief.
  const backdrop = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0), new THREE.MeshStandardMaterial({ color: palette.backdrop, roughness: 1, flatShading: true }), 100);
  const dummy = new THREE.Object3D(), lift = 1 + Math.max(0, terrain.maxHeight) / 18;
  for (let i = 0; i < 100; i++) {
    const size = (1.7 + rng() * 5) * lift, side = i % 2 ? 1 : -1;
    dummy.position.set(side * (terrain.halfWidth + size * 2.4 + 4 + rng() * 25), bottom + size * 0.4, (rng() - 0.5) * (terrain.halfDepth * 2 + 65));
    dummy.rotation.set(rng(), rng() * 6, rng()); dummy.scale.set(size, size * (0.65 + rng()), size); dummy.updateMatrix(); backdrop.setMatrixAt(i, dummy.matrix);
  }
  backdrop.computeBoundingSphere(); world.add(backdrop);
  const skirt = new THREE.Mesh(new THREE.PlaneGeometry(260, 260), new THREE.MeshStandardMaterial({ color: palette.skirt, roughness: 1 })); skirt.rotation.x = -Math.PI / 2; skirt.position.y = bottom; world.add(skirt);
}
