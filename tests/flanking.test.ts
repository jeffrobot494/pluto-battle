import test from 'node:test';
import assert from 'node:assert/strict';
import { BattleSimulation } from '../src/simulation.ts';
import { CONFIG } from '../src/config.ts';
import { DEFAULT_TUNING } from '../src/tuning.ts';
import { prepareTerrain } from '../src/navigation.ts';

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

test('soldiers with a clear path never flank', () => {
  const sim = new BattleSimulation(0);
  sim.spawn(0, 0, 15); sim.spawn(1, 0, -15);
  for (let n = 0; n < 240; n++) sim.step();
  assert.equal(sim.totalFlanks, 0);
  assert.ok(sim.flankState.every(state => state === 0));
});
