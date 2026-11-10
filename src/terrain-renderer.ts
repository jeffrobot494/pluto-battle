import * as THREE from 'three';
import { Terrain } from './terrain.ts';
import { random } from './random.ts';

/** Meshes are made from the exact support triangles and convex rock planes. */
export function addTerrainWorld(world: THREE.Group, terrain: Terrain) {
  const rng = random(terrain.seed ^ 0x41b693), vertices: number[] = [], colors: number[] = [];
  const color = new THREE.Color(), dirt = new THREE.Color('#66333f'), violet = new THREE.Color('#79607f');
  const vertex = (c: number, r: number) => {
    const x = -terrain.halfWidth + c * terrain.dx, z = -terrain.halfDepth + r * terrain.dz, y = terrain.heights[r * (terrain.columns + 1) + c];
    vertices.push(x, y, z); color.toArray(colors, colors.length);
  };
  for (let r = 0; r < terrain.rows; r++) for (let c = 0; c < terrain.columns; c++) {
    const x = -terrain.halfWidth + c * terrain.dx, z = -terrain.halfDepth + r * terrain.dz, height = terrain.heightAt(x, z);
    const rocky = terrain.features.some(f => f.kind === 'mesa' && Math.abs(x - f.x) / f.rx + 0.16 * ((z - f.z) / f.rz) ** 2 < 0.97 && Math.abs(z - f.z) < f.rz * 0.94 && height > 0.25);
    for (let side = 0; side < 2; side++) {
      color.copy(dirt).lerp(violet, rocky ? 0.8 : Math.max(0, Math.min(0.7, height * 0.15 + terrain.slope[(r * terrain.columns + c) * 2 + side] * 0.45)));
      color.multiplyScalar(0.86 + rng() * 0.25);
      if (!side) { vertex(c, r); vertex(c, r + 1); vertex(c + 1, r); }
      else { vertex(c + 1, r); vertex(c, r + 1); vertex(c + 1, r + 1); }
    }
  }
  const ground = new THREE.BufferGeometry(); ground.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3)); ground.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3)); ground.computeVertexNormals();
  world.add(new THREE.Mesh(ground, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true })));

  const positions: number[] = [], rockColors: number[] = [], palette = ['#79607f', '#66506f', '#8b687d', '#53445f'];
  for (let i = 0; i < terrain.rocks.length; i++) {
    const rock = terrain.rocks[i]; color.set(palette[i % palette.length]);
    const point = (s: number, top: boolean) => { const a = rock.angle + s * Math.PI / 4, radius = rock.radius * (top ? 0.55 : 1); positions.push(rock.x + Math.cos(a) * radius, rock.base + (top ? rock.height * 0.78 : 0), rock.z + Math.sin(a) * radius); color.toArray(rockColors, rockColors.length); };
    for (let s = 0; s < 8; s++) {
      point(s, false); point(s, true); point(s + 1, false);
      point(s + 1, false); point(s, true); point(s + 1, true);
      positions.push(rock.x, rock.base + rock.height, rock.z); color.toArray(rockColors, rockColors.length); point(s + 1, true); point(s, true);
    }
  }
  const rocks = new THREE.BufferGeometry(); rocks.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); rocks.setAttribute('color', new THREE.Float32BufferAttribute(rockColors, 3)); rocks.computeVertexNormals();
  world.add(new THREE.Mesh(rocks, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.98, flatShading: true })));

  // Distant scenery stays outside the active rectangle and never hides obstacles.
  const backdrop = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0), new THREE.MeshStandardMaterial({ color: '#68516f', roughness: 1, flatShading: true }), 100);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < 100; i++) {
    const size = 1.7 + rng() * 5, side = i % 2 ? 1 : -1;
    dummy.position.set(side * (terrain.halfWidth + size * 2 + rng() * 25), size * 0.4 - 0.8, (rng() - 0.5) * (terrain.halfDepth * 2 + 65));
    dummy.rotation.set(rng(), rng() * 6, rng()); dummy.scale.set(size, size * (0.65 + rng()), size); dummy.updateMatrix(); backdrop.setMatrixAt(i, dummy.matrix);
  }
  backdrop.computeBoundingSphere(); world.add(backdrop);
  const skirt = new THREE.Mesh(new THREE.PlaneGeometry(260, 260), new THREE.MeshStandardMaterial({ color: '#57333f', roughness: 1 })); skirt.rotation.x = -Math.PI / 2; skirt.position.y = terrain.minHeight - 0.25; world.add(skirt);
}
