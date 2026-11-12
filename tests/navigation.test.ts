import test from 'node:test';
import assert from 'node:assert/strict';
import { Navigation, infantryProfile, prepareTerrain, type NavigationProfile } from '../src/navigation.ts';
import type { Terrain } from '../src/terrain.ts';
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
