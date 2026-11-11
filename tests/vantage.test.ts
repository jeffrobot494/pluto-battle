import test from 'node:test';
import assert from 'node:assert/strict';
import { Terrain } from '../src/terrain.ts';
import { BattleSimulation } from '../src/simulation.ts';
import { DEFAULT_TUNING } from '../src/tuning.ts';

/** Plateau (x > 1) with a sheer cliff facing the open ground; its only way down is a long ramp at z > 2. */
function plateauFixture() {
  const terrain = Terrain.flat(10, 12);
  for (let r = 0; r <= terrain.rows; r++) for (let c = 0; c <= terrain.columns; c++) {
    const x = -10 + c * terrain.dx, z = -12 + r * terrain.dz;
    terrain.heights[r * (terrain.columns + 1) + c] = x > 1 ? 3 * Math.max(0, Math.min(1, (10 - z) / 8)) : 0;
  }
  terrain.rebuild(); return terrain;
}

test('soldiers on a plateau take the cliff-top shot instead of the long walk down', () => {
  const terrain = plateauFixture(), tuning = { ...DEFAULT_TUNING, halfWidth: 10, halfDepth: 12 };
  const sim = new BattleSimulation(0, 7, 64, tuning, terrain);
  const shooter = sim.spawn(0, 7, -2)!, enemy = sim.spawn(1, -4, -6)!;
  assert.ok(shooter && enemy);
  const s = sim.byId.get(shooter)!, e = sim.byId.get(enemy)!;
  sim.hp[e] = 1e9; // enemy survives so the shooter keeps a target
  let lowest = Infinity, firedFromTop = false;
  for (let n = 0; n < 600; n++) {
    sim.step();
    lowest = Math.min(lowest, sim.y[s]);
    if (sim.visible[s] && sim.y[s] > 2.5 && Math.hypot(sim.x[e] - sim.x[s], sim.z[e] - sim.z[s], sim.y[e] - sim.y[s]) <= tuning.range) firedFromTop = true;
  }
  assert.ok(lowest > 2.5, `shooter left the plateau (lowest y ${lowest.toFixed(2)})`);
  assert.ok(firedFromTop, 'shooter never reached a cliff-top firing position');
  assert.ok(sim.navigation!.fields[0].firingSeeds > 0);
});
