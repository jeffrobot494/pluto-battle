import test from 'node:test';
import assert from 'node:assert/strict';
import { Terrain, generateTerrain } from '../src/terrain.ts';
import { Navigation, prepareTerrain } from '../src/navigation.ts';
import { BattleSimulation, rayCapsule } from '../src/simulation.ts';
import { DEFAULT_TUNING } from '../src/tuning.ts';
import * as THREE from 'three';
import { addTerrainWorld } from '../src/terrain-renderer.ts';
import { random } from '../src/random.ts';

test('terrain seeds reproduce exact geometry and fresh seeds change the battlefield', () => {
  const a = generateTerrain(DEFAULT_TUNING, 17), b = generateTerrain(DEFAULT_TUNING, 17), c = generateTerrain(DEFAULT_TUNING, 18);
  assert.deepEqual(a.heights, b.heights); assert.deepEqual(a.rocks, b.rocks); assert.notDeepEqual(a.heights, c.heights);
  assert.ok(a.minHeight < -0.3); assert.ok(a.maxHeight > 2);
  for (const kind of ['basin', 'hill', 'mesa', 'ridge']) assert.ok(a.features.some(f => f.kind === kind));
});

test('team occupancy acceleration stays exact across movement, deaths and queued spawns', () => {
  const sim = new BattleSimulation(100); sim.weaponsEnabled = false;
  for (let tick = 0; tick < 360; tick++) {
    if (tick === 180) for (let i = 0; i < sim.used; i += 3) sim.damage(sim.id[i], 1000);
    sim.step();
    if (tick % 60 !== 0) continue;
    const expected = [new Uint16Array(sim.grid.heads.length), new Uint16Array(sim.grid.heads.length)];
    for (let i = 0; i < sim.used; i++) if (sim.hp[i] > 0) expected[sim.team[i]][sim.grid.cell[i]]++;
    assert.deepEqual(sim.grid.teamCounts, expected);
  }
  sim.queue({ type: 'spawn', team: 1, x: 20, z: -24 }); sim.step();
  const expected = [new Uint16Array(sim.grid.heads.length), new Uint16Array(sim.grid.heads.length)];
  for (let i = 0; i < sim.used; i++) if (sim.hp[i] > 0) expected[sim.team[i]][sim.grid.cell[i]]++;
  assert.deepEqual(sim.grid.teamCounts, expected);
});

test('100 generated maps support legal connected deployments and accessible mesa tops', () => {
  for (let seed = 0; seed < 100; seed++) {
    const tuning = seed % 3 === 0 ? { ...DEFAULT_TUNING, count: 500, columns: 23 }
      : seed % 3 === 1 ? { ...DEFAULT_TUNING, count: 64, columns: 8, radius: 0.4, halfWidth: 12, halfDepth: 22, frontline: 8 }
      : { ...DEFAULT_TUNING };
    const { terrain, navigation } = prepareTerrain(tuning, seed);
    const sim = new BattleSimulation(tuning.count, 74319, 2048, tuning, terrain, navigation);
    let region = -1;
    for (let i = 0; i < sim.used; i++) {
      assert.ok(terrain.canStand(sim.x[i], sim.z[i], sim.radius[i]), `illegal spawn seed ${seed}, slot ${i}`);
      const node = navigation.nodeAt(sim.x[i], sim.z[i]); assert.ok(node >= 0, `no nav node seed ${seed}`);
      if (region < 0) region = navigation.regions[node];
      assert.equal(navigation.regions[node], region, `disconnected spawn seed ${seed}`);
    }
    for (const f of terrain.features) if (f.kind === 'mesa') {
      const node = navigation.nodeAt(f.x, f.z); assert.ok(node >= 0, `mesa has no approach seed ${seed}`);
      assert.equal(navigation.regions[node], region, `isolated mesa seed ${seed}`);
    }
    assert.ok(terrain.repairs <= 5);
  }
});

test('convex rock cover blocks movement and shots while high shots pass over it', () => {
  const terrain = Terrain.flat(8, 8);
  terrain.rocks.push({ x: 0, z: 0, radius: 1, base: -0.1, height: 2, angle: 0 }); terrain.rebuild();
  assert.equal(terrain.canStand(0, 0, 0.29), false);
  assert.equal(terrain.canTraverse(-3, 0, 3, 0, 0.29), false);
  assert.equal(terrain.visible(-3, 0.7, 0, 3, 0.7, 0), false);
  assert.equal(terrain.visible(-3, 2.5, 0, 3, 2.5, 0), true);
  assert.ok(terrain.raycast(-3, 0.7, 0, 1, 0, 0, 6) < 3);
  const sim = new BattleSimulation(0, 1, 2048, undefined, terrain);
  assert.equal(sim.spawn(0, 0, 0), null);
  const a = sim.spawn(0, -3, 0)!, b = sim.spawn(1, 3, 0)!;
  const shooter = sim.byId.get(a)!;
  sim.target[shooter] = b; sim.visible[shooter] = 1; sim.nextSearch.fill(999); sim.nextFire.fill(999); sim.nextFire[shooter] = 0;
  sim.step(); assert.equal(sim.hp[sim.byId.get(b)!], 100); assert.equal(sim.shots.cursor, 0);
  assert.equal(sim.visible[shooter], 0, 'fresh cover check must invalidate stale visibility');
  assert.equal(sim.lastFire[shooter], -Infinity);
  assert.ok(sim.nextFire[shooter] > sim.time, 'blocked rifles retain their staggered phase');
});

test('capsule rays reject enemies behind the muzzle, including behind solid cover', () => {
  assert.equal(rayCapsule(0, 0.7, 0, 1, 0, 0, -1.2, 0, 0, 0.29), Infinity);
  assert.equal(rayCapsule(0, 0.7, 0, 1, 0, 0, 0, 0, 0, 0.29), 0);
  const terrain = Terrain.flat(8, 8);
  terrain.rocks.push({ x: -0.6, z: 0, radius: 0.12, base: -0.1, height: 2, angle: 0 }); terrain.rebuild();
  const sim = new BattleSimulation(0, 7, 32, undefined, terrain);
  const a = sim.spawn(0, 0, 0)!, b = sim.spawn(1, 3, 0)!, rear = sim.spawn(1, -1.2, 0)!;
  assert.ok(a && b && rear);
  const shooter = sim.byId.get(a)!, target = sim.byId.get(b)!, behind = sim.byId.get(rear)!;
  sim.target[shooter] = b; sim.visible[shooter] = 1; sim.nextSearch.fill(999); sim.nextFire.fill(999); sim.nextFire[shooter] = 0;
  sim.step(); assert.equal(sim.hp[behind], 100); assert.equal(sim.hp[target], 91);
  assert.ok(sim.shots.endX[0] > 2, 'beam and damage must travel forward to the visible enemy');
});

test('ridge cover blocks sight and direct fire from both sides even with stale visibility', () => {
  const terrain = Terrain.flat(8, 8);
  for (let r = 0; r <= terrain.rows; r++) for (let c = 0; c <= terrain.columns; c++) terrain.heights[r * (terrain.columns + 1) + c] = Math.max(0, 2.5 - Math.abs(-8 + c * terrain.dx) * 0.7);
  terrain.rebuild();
  assert.equal(terrain.visible(-5, 0.7, 0, 5, 0.7, 0), false);
  assert.equal(terrain.visible(5, 0.7, 0, -5, 0.7, 0), false);
  const sim = new BattleSimulation(0, 7, 32, undefined, terrain);
  const a = sim.spawn(0, -5, 0)!, b = sim.spawn(1, 5, 0)!; assert.ok(a && b);
  sim.target[0] = b; sim.target[1] = a; sim.visible.fill(1); sim.nextSearch.fill(999); sim.nextFire.fill(0);
  sim.step(); assert.equal(sim.totalShots, 0); assert.equal(sim.shots.cursor, 0);
  assert.equal(sim.events.cursor, 0); assert.deepEqual(Array.from(sim.hp.slice(0, 2)), [100, 100]);
});

test('cached hidden targets emit no lasers and a clear elevated firing line still deals damage', () => {
  for (const height of [2.5, 0.2]) {
    const terrain = Terrain.flat(8, 8);
    for (let r = 0; r <= terrain.rows; r++) for (let c = 0; c <= terrain.columns; c++) terrain.heights[r * (terrain.columns + 1) + c] = Math.max(0, 1 - Math.abs(-8 + c * terrain.dx) / 3) * height;
    terrain.rebuild();
    const sim = new BattleSimulation(0, 7, 32, undefined, terrain);
    const a = sim.spawn(0, -5, 0)!, b = sim.spawn(1, 5, 0)!;
    sim.target[0] = b; sim.target[1] = a; sim.visible.fill(+(height < 0.7)); sim.nextSearch.fill(999); sim.nextFire.fill(0);
    sim.step();
    const expectedShots = height < 0.7 ? 2 : 0;
    assert.equal(sim.totalShots, expectedShots); assert.equal(sim.shots.cursor, expectedShots);
    assert.deepEqual(Array.from(sim.hp.slice(0, 2)), height < 0.7 ? [91, 91] : [100, 100]);
  }
});

test('terrain sight rays agree with the independently intersected rendered ground and boulders', () => {
  const terrain = generateTerrain(DEFAULT_TUNING, 189423), world = new THREE.Group(); addTerrainWorld(world, terrain); world.updateMatrixWorld(true);
  const solids = world.children.slice(0, 2) as THREE.Mesh[];
  for (const solid of solids) (solid.material as THREE.Material).side = THREE.DoubleSide;
  const rng = random(4932), ray = new THREE.Raycaster(), origin = new THREE.Vector3(), direction = new THREE.Vector3();
  let checked = 0, occluded = 0;
  for (let attempt = 0; checked < 120 && attempt < 1000; attempt++) {
    const x = (rng() * 2 - 1) * 25, z = (rng() * 2 - 1) * 31;
    const angle = rng() * Math.PI * 2, length = 4 + rng() * 9;
    const tx = Math.max(-27, Math.min(27, x + Math.cos(angle) * length)), tz = Math.max(-33, Math.min(33, z + Math.sin(angle) * length));
    if (!terrain.canStand(x, z, 0.29) || !terrain.canStand(tx, tz, 0.29)) continue;
    const y = terrain.heightAt(x, z) + 0.7, ty = terrain.heightAt(tx, tz) + 0.7, distance = Math.hypot(tx - x, ty - y, tz - z);
    origin.set(x, y, z); direction.set(tx - x, ty - y, tz - z).normalize(); ray.set(origin, direction); ray.far = distance;
    const hit = ray.intersectObjects(solids, false)[0], actual = terrain.raycast(x, y, z, direction.x, direction.y, direction.z, distance);
    assert.ok(Math.abs(actual - (hit?.distance ?? distance)) < 2e-4, `ray ${checked}: simulation=${actual}, rendered=${hit?.distance}`);
    if (hit) occluded++; checked++;
  }
  assert.equal(checked, 120); assert.ok(occluded > 10);
  world.traverse(object => { const mesh = object as THREE.Mesh; mesh.geometry?.dispose(); if (mesh.material) for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) material.dispose(); });
});

test('heightfield rays intersect triangle crests from either direction and respect elevation', () => {
  const terrain = Terrain.flat(8, 8);
  for (let r = 0; r <= terrain.rows; r++) for (let c = 0; c <= terrain.columns; c++) terrain.heights[r * (terrain.columns + 1) + c] = Math.max(0, 2 - Math.abs(-8 + c * terrain.dx) * 0.6);
  terrain.rebuild();
  assert.equal(terrain.visible(-6, 0.7, 0, 6, 0.7, 0), false);
  assert.equal(terrain.visible(-6, 3, 0, 6, 3, 0), true);
  assert.ok(Math.abs(terrain.raycast(-6, 0.7, 0, 1, 0, 0, 12) - terrain.raycast(6, 0.7, 0, -1, 0, 0, 12)) < 1e-5);
  assert.ok(Number.isFinite(rayCapsule(0, 4, 0, 0, -1, 0, 0, 0, 0, 0.29)));
  assert.equal(rayCapsule(-3, 3, 0, 1, 0, 0, 0, 0, 0, 0.29), Infinity);
});

function uFixture() {
  const terrain = Terrain.flat(8, 9);
  for (let x = -3; x <= 3; x += 1.5) terrain.rocks.push({ x, z: -2, radius: 0.9, base: -0.1, height: 2.5, angle: 0 });
  for (let z = -0.5; z <= 3; z += 1.5) for (const x of [-3, 3]) terrain.rocks.push({ x, z, radius: 0.9, base: -0.1, height: 2.5, angle: 0 });
  terrain.rebuild(); return terrain;
}

test('A* and shared fields route out of a U-shaped blocker with bounded work and no corner cuts', () => {
  const terrain = uFixture(), nav = new Navigation(terrain, 0.29), path = nav.findPath(0, 0, 0, -6)!;
  assert.ok(path); assert.ok(Math.max(...path.map(n => nav.z(n))) > 3);
  for (let i = 1; i < path.length; i++) assert.ok(terrain.canTraverse(nav.x(path[i - 1]), nav.z(path[i - 1]), nav.x(path[i]), nav.z(path[i]), 0.29));
  nav.beginField(0, Int32Array.of(nav.nodeAt(0, -6)), 1);
  let iterations = 0;
  while (!nav.fields[0].ready && iterations++ < 100) { nav.advance(73); assert.ok(nav.expansions <= 73); }
  assert.ok(nav.fields[0].ready); assert.ok(nav.direction(0, 0, 0));
  assert.ok(nav.directionZ > 0, 'route initially leads away from the enemy to the opening');
});

test('covered in-range soldiers reposition around a U and finish their battle', () => {
  const terrain = uFixture(), tuning = { ...DEFAULT_TUNING, range: 4, halfWidth: 8, halfDepth: 9 };
  const sim = new BattleSimulation(0, 7, 128, tuning, terrain);
  const a = sim.spawn(0, 0, 0)!, b = sim.spawn(1, 0, -4)!;
  assert.ok(a && b); sim.target[0] = b; sim.target[1] = a;
  let maxZ = 0;
  for (let n = 0; n < 3000 && sim.result === 'running'; n++) { sim.step(); maxZ = Math.max(maxZ, sim.z[0]); }
  assert.ok(maxZ > 1, `covered soldier never moved toward opening: ${maxZ}`);
  assert.notEqual(sim.result, 'running');
});

test('ground support rejects cliffs and fast movement cannot tunnel across a rock', () => {
  const terrain = Terrain.flat(8, 8);
  for (let r = 0; r <= terrain.rows; r++) for (let c = 0; c <= terrain.columns; c++) terrain.heights[r * (terrain.columns + 1) + c] = c > terrain.columns / 2 ? 4 : 0;
  terrain.rebuild(); assert.equal(terrain.canTraverse(-2, 0, 2, 0, 0.29), false);
  const nav = new Navigation(terrain, 0.29); assert.equal(nav.findPath(-3, 0, 3, 0), null);
});

test('soldiers climb a large formation through its slope at a bounded surface speed', () => {
  const terrain = Terrain.flat(8, 10);
  for (let r = 0; r <= terrain.rows; r++) for (let c = 0; c <= terrain.columns; c++) {
    const x = -8 + c * terrain.dx, z = -10 + r * terrain.dz;
    terrain.heights[r * (terrain.columns + 1) + c] = Math.max(0, 2.8 * (1 - Math.abs(z) / 7)) * Math.max(0, Math.min(1, (4 - Math.abs(x)) * 2));
  }
  terrain.rebuild();
  const tuning = { ...DEFAULT_TUNING, halfWidth: 8, halfDepth: 10, range: 2, speed: 5 };
  const sim = new BattleSimulation(0, 7, 64, tuning, terrain); sim.weaponsEnabled = false;
  assert.ok(sim.spawn(0, 0, -8)); assert.ok(sim.spawn(1, 0, 1));
  let highest = 0;
  for (let tick = 0; tick < 300; tick++) {
    sim.step(); highest = Math.max(highest, sim.y[0]);
    for (let i = 0; i < sim.used; i++) {
      assert.ok(Math.hypot(sim.x[i] - sim.previousX[i], sim.z[i] - sim.previousZ[i], sim.y[i] - sim.previousY[i]) <= tuning.speed / 60 + 1e-6);
      assert.ok(terrain.canStand(sim.x[i], sim.z[i], sim.radius[i]));
    }
  }
  assert.ok(highest > 1.4, `never climbed the rock: ${highest}`);
});

test('terrain battles replay identically, preserve support and finish across fixed seeds', () => {
  for (const seed of [1, 189423, 74319]) {
    const p = prepareTerrain(DEFAULT_TUNING, seed), q = prepareTerrain(DEFAULT_TUNING, seed);
    const a = new BattleSimulation(100, 74319, 2048, DEFAULT_TUNING, p.terrain, p.navigation), b = new BattleSimulation(100, 74319, 2048, DEFAULT_TUNING, q.terrain, q.navigation);
    for (let tick = 0; tick < 12000 && a.result === 'running'; tick++) {
      a.step(); b.step();
      if (tick % 120 === 0) for (let i = 0; i < a.used; i++) if (a.hp[i] > 0) {
        assert.ok(a.terrain.canStand(a.x[i], a.z[i], a.radius[i]));
        assert.ok(Math.abs(a.y[i] - a.terrain.heightAt(a.x[i], a.z[i])) < 1e-8);
        for (let j = i + 1; j < a.used; j++) if (a.hp[j] > 0) assert.ok(Math.hypot(a.x[i] - a.x[j], a.z[i] - a.z[j]) >= a.radius[i] + a.radius[j] - 1e-6);
      }
    }
    assert.notEqual(a.result, 'running', `stalled seed ${seed}`); assert.equal(a.result, b.result); assert.deepEqual(a.x, b.x); assert.deepEqual(a.hp, b.hp);
  }
});
