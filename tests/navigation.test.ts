import test from 'node:test';
import assert from 'node:assert/strict';
import { Navigation, NavigationBuild, infantryProfile, prepareTerrain, type NavigationProfile } from '../src/navigation.ts';
import { Terrain } from '../src/terrain.ts';
import { BattleSimulation } from '../src/simulation.ts';
import { TRUCK_BUILD_CELLS_PER_TICK, TRUCK_GRAPH_RADIUS, TruckGraph, truckProfile } from '../src/truck-navigation.ts';
import { TRUCK } from '../src/vehicle-types.ts';
import { ARCHETYPES } from '../src/terrain-archetypes.ts';
import { DEFAULT_TUNING } from '../src/tuning.ts';

const DX = [1, 0, -1, 0, 1, -1, -1, 1], DZ = [0, 1, 0, -1, 1, 1, -1, -1];

/** Straight-from-the-definition infantry graph: what navigation built before profiles existed. */
function referenceGraph(terrain: Terrain, radius: number) {
  const { columns, rows } = terrain, size = columns * rows;
  const cx = (n: number) => -terrain.halfWidth + (n % columns + 0.5) * terrain.dx, cz = (n: number) => -terrain.halfDepth + (Math.floor(n / columns) + 0.5) * terrain.dz;
  const walkable = new Uint8Array(size), elevation = new Float64Array(size), neighbours: [number, number][][] = Array.from({ length: size }, () => []);
  for (let n = 0; n < size; n++) { walkable[n] = +terrain.canStand(cx(n), cz(n), radius + 0.035); elevation[n] = terrain.heightAt(cx(n), cz(n)); }
  for (let n = 0; n < size; n++) if (walkable[n]) {
    const c = n % columns, r = Math.floor(n / columns);
    for (const dir of [0, 1, 4, 5]) {
      const nc = c + DX[dir], nr = r + DZ[dir]; if (nc < 0 || nc >= columns || nr < 0 || nr >= rows) continue;
      const m = nr * columns + nc; if (!walkable[m]) continue;
      if (dir >= 4 && (!walkable[r * columns + nc] || !walkable[nr * columns + c])) continue;
      if (!terrain.canTraverse(cx(n), cz(n), cx(m), cz(m), radius + 0.02)) continue;
      const cost = Math.hypot(DX[dir] * terrain.dx, DZ[dir] * terrain.dz);
      neighbours[n].push([m, cost]); neighbours[m].push([n, cost]);
    }
  }
  return { walkable, elevation, neighbours };
}

/** Plain Dijkstra (linear-scan open list) over the reference graph with the infantry cost (no congestion or firing seeds). */
function referenceField(graph: ReturnType<typeof referenceGraph>, crowding: Float32Array, goals: number[]) {
  const distance = new Float64Array(graph.walkable.length).fill(Infinity), done = new Uint8Array(distance.length);
  const open: number[] = [];
  for (const g of goals) { distance[g] = 0; open.push(g); }
  while (open.length) {
    let best = 0; for (let i = 1; i < open.length; i++) if (distance[open[i]] < distance[open[best]]) best = i;
    const node = open[best]; open[best] = open[open.length - 1]; open.pop();
    if (done[node]) continue; done[node] = 1;
    for (const [next, cost] of graph.neighbours[node]) {
      const d = distance[node] + cost * crowding[next] + Math.abs(graph.elevation[node] - graph.elevation[next]) * 0.25;
      if (d < distance[next]) { distance[next] = d; open.push(next); }
    }
  }
  return distance;
}

test('the infantry profile builds the same graph and fields as the pre-profile navigation on every landscape type', () => {
  const tuning = { ...DEFAULT_TUNING, count: 60, columns: 8 };
  for (const { id } of ARCHETYPES) {
    const { terrain } = prepareTerrain(tuning, 4242, id);
    const nav = new Navigation(terrain, infantryProfile(tuning.radius)), legacy = new Navigation(terrain, tuning.radius);
    assert.deepEqual(legacy.walkable, nav.walkable); assert.deepEqual(legacy.edges, nav.edges); assert.deepEqual(legacy.crowding, nav.crowding);

    const ref = referenceGraph(terrain, tuning.radius);
    assert.deepEqual(nav.walkable, ref.walkable, `walkable ${id}`);
    for (let n = 0; n < nav.walkable.length; n++) {
      const built = new Set<number>(); for (let dir = 0; dir < 8; dir++) if (nav.edges[n] & 1 << dir) built.add(n + nav.offsets[dir]);
      assert.deepEqual(built, new Set(ref.neighbours[n].map(([m]) => m)), `edges ${id} node ${n}`);
    }
    // Regions are the connected components of the edge graph.
    for (let n = 0; n < nav.walkable.length; n++) {
      if (!nav.walkable[n]) { assert.equal(nav.regions[n], -1); continue; }
      for (const [m] of ref.neighbours[n]) assert.equal(nav.regions[m], nav.regions[n], `region split ${id}`);
    }
    for (let n = 0; n < nav.walkable.length; n++) {
      const t = Math.max(0, 1 - nav.clearance[n] / 2.6);
      assert.ok(Math.abs(nav.crowding[n] - (1 + 4 * t * t)) < 1e-6, `crowding ${id}`);
    }

    // A field from three goal cells matches plain Dijkstra over the reference graph.
    const goals: number[] = [];
    for (let n = 0; goals.length < 3 && n < nav.walkable.length; n += 997) if (nav.walkable[n]) goals.push(n);
    nav.beginField(0, Int32Array.from(goals), goals.length);
    while (!nav.fields[0].ready) nav.advance(4096);
    const expected = referenceField(ref, nav.crowding, goals), actual = nav.fields[0].distance;
    for (let n = 0; n < actual.length; n++) {
      if (expected[n] === Infinity) { assert.equal(actual[n], Infinity, `${id} node ${n} reached`); continue; }
      assert.ok(Math.abs(actual[n] - expected[n]) <= 1e-4 * (1 + expected[n]), `${id} node ${n}: ${actual[n]} vs ${expected[n]}`);
    }
  }
});

test('a custom profile changes the graph, nodeAt snapping and costs, and path scratch is allocated on demand', () => {
  const tuning = { ...DEFAULT_TUNING, count: 60, columns: 8 };
  const { terrain } = prepareTerrain(tuning, 11, 'canyon');
  const infantry = new Navigation(terrain, tuning.radius), wide = 0.6;
  const broad: NavigationProfile = {
    ...infantryProfile(tuning.radius), radius: wide,
    stand: (t, x, z) => t.canStand(x, z, wide), traverse: (t, x, z, tx, tz) => t.canTraverse(x, z, tx, tz, wide), snap: (t, x, z, tx, tz) => t.canTraverse(x, z, tx, tz, wide),
    openClearance: 4, narrowPenalty: 9,
  };
  const nav = new Navigation(terrain, broad);
  assert.equal(nav.radius, wide); assert.equal(nav.profile, broad);
  let fewer = 0;
  for (let n = 0; n < nav.walkable.length; n++) { assert.ok(!nav.walkable[n] || infantry.walkable[n], 'a wider mover stands only where a soldier can'); if (infantry.walkable[n] && !nav.walkable[n]) fewer++; }
  assert.ok(fewer > 0, 'canyon walls should exclude some soldier cells for a wide mover');
  for (let n = 0; n < nav.walkable.length; n++) if (nav.walkable[n]) { const t = Math.max(0, 1 - nav.clearance[n] / 4); assert.ok(Math.abs(nav.crowding[n] - (1 + 9 * t * t)) < 1e-6); }
  // Snapping returns only cells the profile can use.
  for (let i = 0; i < 200; i++) {
    const x = ((i * 7.31) % (2 * terrain.halfWidth)) - terrain.halfWidth, z = ((i * 11.17) % (2 * terrain.halfDepth)) - terrain.halfDepth, node = nav.nodeAt(x, z);
    if (node >= 0) assert.ok(nav.walkable[node] && broad.snap(terrain, x, z, nav.x(node), nav.z(node)));
  }
  // findPath allocates its scratch on first use and reuses it.
  const scratch = nav as unknown as { pathScore: Float32Array | null };
  assert.equal(scratch.pathScore, null);
  let a = -1, b = -1;
  for (let n = 0; n < nav.walkable.length; n++) if (nav.walkable[n] && nav.regions[n] === 0) { if (a < 0) a = n; b = n; }
  const path = nav.findPath(nav.x(a), nav.z(a), nav.x(b), nav.z(b));
  assert.ok(path && path[0] === a && path[path.length - 1] === b);
  const first = scratch.pathScore; assert.ok(first);
  nav.findPath(nav.x(b), nav.z(b), nav.x(a), nav.z(a)); assert.equal(scratch.pathScore, first);
});

/** Same graph however the build is sliced: the arrays every consumer reads. */
function assertSameGraph(a: Navigation, b: Navigation, label: string) {
  assert.deepEqual(a.walkable, b.walkable, `${label} walkable`); assert.deepEqual(a.edges, b.edges, `${label} edges`);
  assert.deepEqual(a.regions, b.regions, `${label} regions`); assert.equal(a.regionCount, b.regionCount, `${label} region count`);
  assert.deepEqual(a.clearance, b.clearance, `${label} clearance`); assert.deepEqual(a.crowding, b.crowding, `${label} crowding`);
  assert.deepEqual(a.elevation, b.elevation, `${label} elevation`);
}

test('a graph build sliced on any budget matches a one-shot build', () => {
  const tuning = { ...DEFAULT_TUNING, count: 60, columns: 8 };
  for (const id of ['canyon', 'blades', 'massif']) {
    const { terrain } = prepareTerrain(tuning, 101, id);
    for (const profile of [infantryProfile(tuning.radius), truckProfile(tuning.truckSlope)]) {
      const whole = new Navigation(terrain, profile);
      for (const budget of [1, 7, 300]) {
        const build = new NavigationBuild(terrain, profile);
        let steps = 0, last = 0;
        while (!build.step(budget)) { steps++; assert.ok(build.progress >= last && build.progress < 1); last = build.progress; }
        assert.equal(build.progress, 1);
        assertSameGraph(new Navigation(terrain, profile, build), whole, `${id} r=${profile.radius} budget ${budget}`);
        if (budget === 300) assert.ok(steps <= Math.ceil((2 + 3 / 16) * terrain.columns * terrain.rows / 300) + 1, `${steps} steps`);
      }
    }
  }
  assert.throws(() => new Navigation(prepareTerrain(tuning, 101, 'canyon').terrain, truckProfile(0.68), new NavigationBuild(Terrain.flat(), truckProfile(0.68))));
});

test('truck graph cells and edges pass the controller clearance test', () => {
  const tuning = { ...DEFAULT_TUNING, count: 60, columns: 8 };
  for (const { id } of ARCHETYPES) {
    const { terrain } = prepareTerrain(tuning, 202, id), slope = tuning.truckSlope;
    const nav = new TruckGraph(terrain).finish(slope);
    let usable = 0;
    for (let n = 0; n < nav.walkable.length; n++) {
      if (!nav.walkable[n]) continue;
      usable++;
      const x = nav.x(n), z = nav.z(n);
      assert.ok(nav.clearance[n] >= TRUCK_GRAPH_RADIUS, `${id} cell ${n} clearance ${nav.clearance[n]}`);
      for (const radius of [TRUCK.radius, TRUCK_GRAPH_RADIUS]) assert.ok(terrain.driveClear(x, z, x, z, radius, slope), `${id} cell ${n} at r=${radius}`);
      for (let dir = 0; dir < 8; dir++) if (nav.edges[n] & 1 << dir) {
        const m = n + nav.offsets[dir];
        assert.ok(nav.walkable[m], `${id} edge to unusable cell`);
        for (const radius of [TRUCK.radius, TRUCK_GRAPH_RADIUS]) {
          assert.ok(terrain.driveClear(x, z, nav.x(m), nav.z(m), radius, slope), `${id} edge ${n}->${m} at r=${radius}`);
          assert.ok(terrain.driveClear(nav.x(m), nav.z(m), x, z, radius, slope), `${id} edge ${m}->${n} at r=${radius}`);
        }
      }
    }
    assert.ok(usable > nav.walkable.length * 0.1, `${id}: only ${usable} truck cells`);
  }
});

test('the fleet builds the truck graph a slice per tick and republishes atomically after a slope change', () => {
  const tuning = { ...DEFAULT_TUNING, count: 20, columns: 5 };
  const { terrain, navigation } = prepareTerrain(tuning, 303, 'escarpment');
  const sim = new BattleSimulation(20, 9, 512, tuning, terrain, navigation), fleet = sim.vehicles;
  sim.weaponsEnabled = false;
  assert.ok(fleet.truckGraph); assert.equal(fleet.truckNavigation, null, 'nothing published before the first slice');
  const units = (2 + 3 / 16) * terrain.columns * terrain.rows, ticks = Math.ceil(units / TRUCK_BUILD_CELLS_PER_TICK);
  for (let t = 0; t < ticks - 2; t++) sim.step();
  assert.equal(fleet.truckNavigation, null, 'published early');
  for (let t = 0; t < 4 && !fleet.truckNavigation; t++) sim.step();
  const first = fleet.truckNavigation!;
  assert.ok(first, 'not published on budget');
  assertSameGraph(first, new Navigation(terrain, truckProfile(tuning.truckSlope)), 'first build');
  assert.equal(fleet.truckGraph!.builds, 1);
  for (let t = 0; t < 30; t++) sim.step();
  assert.equal(fleet.truckNavigation, first, 'no rebuild without a change');

  const before = first.walkable.slice();
  sim.tuning.truckSlope = 0.3;
  for (let t = 0; t < ticks - 2; t++) { sim.step(); assert.equal(fleet.truckNavigation, first, 'old graph kept until the new one is complete'); }
  assert.deepEqual(first.walkable, before, 'the published graph is never written by a rebuild');
  // Changing the slope again mid-build restarts it for the newest value.
  sim.tuning.truckSlope = 0.35;
  for (let t = 0; t < ticks + 4 && fleet.truckNavigation === first; t++) sim.step();
  const second = fleet.truckNavigation!;
  assert.notEqual(second, first);
  assert.equal(fleet.truckGraph!.slope, 0.35); assert.equal(fleet.truckGraph!.builds, 2);
  assertSameGraph(second, new Navigation(terrain, truckProfile(0.35)), 'rebuild');
  let lost = 0; for (let n = 0; n < before.length; n++) { assert.ok(!second.walkable[n] || before[n]); lost += before[n] - second.walkable[n]; }
  assert.ok(lost > 0, 'a lower slope limit removes truck cells');
});

test('flat battles have no truck graph', () => {
  const plain = new BattleSimulation(20, 9, 512);
  assert.equal(plain.vehicles.truckGraph, null);
  const terrain = Terrain.flat(DEFAULT_TUNING.halfWidth, DEFAULT_TUNING.halfDepth);
  const explicit = new BattleSimulation(20, 9, 512, DEFAULT_TUNING, terrain, new Navigation(terrain, DEFAULT_TUNING.radius));
  for (const sim of [plain, explicit]) { for (let t = 0; t < 5; t++) sim.step(); assert.equal(sim.vehicles.truckGraph, null); assert.equal(sim.vehicles.truckNavigation, null); }
});
