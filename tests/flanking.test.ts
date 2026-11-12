import test from 'node:test';
import assert from 'node:assert/strict';
import { BattleSimulation } from '../src/simulation.ts';
import { CONFIG, WEAPON_ID } from '../src/config.ts';
import { DEFAULT_TUNING } from '../src/tuning.ts';
import { prepareTerrain } from '../src/navigation.ts';
import { Terrain } from '../src/terrain.ts';

/** Worst count, sampled each second from 4–10 s, of soldiers out of range that have not moved for 2 s. */
function worstPile(sim: BattleSimulation) {
  const lastMoved = new Float64Array(sim.used), px = Float64Array.from(sim.x), pz = Float64Array.from(sim.z);
  let worst = 0;
  for (let n = 1; n <= 600 && sim.result === 'running'; n++) {
    sim.step();
    for (let i = 0; i < sim.used; i++) if (Math.hypot(sim.x[i] - px[i], sim.z[i] - pz[i]) > 0.02) { lastMoved[i] = sim.time; px[i] = sim.x[i]; pz[i] = sim.z[i]; }
    if (n % 60 || n < 240) continue;
    let pinned = 0;
    for (let i = 0; i < sim.used; i++) if (sim.hp[i] > 0 && sim.time - lastMoved[i] >= 2) {
      let nearest = Infinity;
      for (let j = 0; j < sim.used; j++) if (sim.hp[j] > 0 && sim.team[j] !== sim.team[i]) nearest = Math.min(nearest, Math.hypot(sim.x[j] - sim.x[i], sim.z[j] - sim.z[i]));
      if (nearest > sim.rifle.range) pinned++;
    }
    worst = Math.max(worst, pinned);
  }
  return worst;
}

test('rear ranks flank around their own firing line instead of piling up behind it', () => {
  // Before flanking, this default flat battle left 40+ soldiers per army frozen behind the line.
  const sim = new BattleSimulation(100);
  const worst = worstPile(sim);
  assert.ok(worst <= 5, `${worst} soldiers stayed pinned out of range`);
  assert.ok(sim.totalFlanks > 0);
});

test('flanking also clears piles on terrain', () => {
  const tuning = { ...DEFAULT_TUNING };
  const prepared = prepareTerrain(tuning, 2);
  const sim = new BattleSimulation(100, CONFIG.seed, CONFIG.capacity, tuning, prepared.terrain, prepared.navigation);
  const worst = worstPile(sim);
  assert.ok(worst <= 5, `${worst} soldiers stayed pinned out of range`);
});

test('a soldier pinned against a cliff advances when its ally clears the route', () => {
  const terrain = new Terrain(3.8, 8, 0, [], [], 0.7);
  for (let row = 0; row <= terrain.rows; row++) {
    const z = row * terrain.dz - terrain.halfDepth;
    for (let column = 0; column <= terrain.columns; column++) {
      const x = column * terrain.dx - terrain.halfWidth;
      // A one-soldier-wide corridor with a cliff at its back and an opening toward the enemy.
      if (z < -0.4 || (z < 2.5 && Math.abs(x) > 0.4)) terrain.heights[row * (terrain.columns + 1) + column] = 3;
    }
  }
  terrain.rebuild();

  const tuning = { ...DEFAULT_TUNING, halfWidth: terrain.halfWidth, halfDepth: terrain.halfDepth, range: 2, initialSearchDelay: 0 };
  const sim = new BattleSimulation(0, 7, 16, tuning, terrain);
  const rear = sim.spawn(0, 0, -0.05);
  const ally = sim.spawn(0, 0, 0.55, WEAPON_ID.heavy);
  assert.ok(rear && ally && sim.spawn(1, 0, 4.4, WEAPON_ID.heavy));
  const slot = sim.byId.get(rear)!;

  for (let tick = 0; tick < 80; tick++) sim.step();
  assert.ok(sim.z[slot] < 0.1, 'the ally should hold the corridor long enough to trigger recovery');
  sim.damage(ally, tuning.health);

  for (let tick = 0; tick < 60; tick++) sim.step();
  assert.ok(sim.z[slot] > 1, `soldier stayed at the cliff after the route cleared (z = ${sim.z[slot]})`);
});

test('soldiers with a clear path never flank', () => {
  const sim = new BattleSimulation(0);
  sim.spawn(0, 0, 15); sim.spawn(1, 0, -15);
  for (let n = 0; n < 240; n++) sim.step();
  assert.equal(sim.totalFlanks, 0);
  assert.ok(sim.flankState.every(state => state === 0));
});
