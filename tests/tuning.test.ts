import test from 'node:test';
import assert from 'node:assert/strict';
import { BattleSimulation } from '../src/simulation.ts';
import { DEFAULT_TUNING, TUNING, deploymentError } from '../src/tuning.ts';

test('the 25 tuning controls validate legal formations and reject unsafe deployments', () => {
  assert.equal(TUNING.length, 25); assert.equal(new Set(TUNING.map(d => d.key)).size, 25);
  assert.equal(deploymentError(DEFAULT_TUNING), null);
  for (const values of [
    { ...DEFAULT_TUNING, radius: 0.5 }, { ...DEFAULT_TUNING, halfWidth: 6, columns: 20 },
    { ...DEFAULT_TUNING, halfDepth: 8 }, { ...DEFAULT_TUNING, seed: NaN },
    { ...DEFAULT_TUNING, columns: 2.5 }, { ...DEFAULT_TUNING, count: 501 },
  ]) assert.ok(deploymentError(values));
});

test('custom radius, formation and battlefield dimensions retain solid collision', () => {
  const values = { ...DEFAULT_TUNING, count: 64, columns: 8, radius: 0.4, halfWidth: 12, halfDepth: 22, frontline: 8, range: 4, speed: 6 };
  assert.equal(deploymentError(values), null);
  const sim = new BattleSimulation(64, 74319, 2048, values); sim.weaponsEnabled = false;
  assert.equal(sim.grid.halfWidth, 12); assert.equal(sim.grid.halfDepth, 22); assert.equal(sim.rifle.range, 4);
  for (let n = 0; n < 480; n++) sim.step();
  for (let i = 0; i < sim.used; i++) {
    assert.ok(Math.abs(sim.x[i]) + sim.radius[i] <= 12);
    assert.ok(Math.abs(sim.z[i]) + sim.radius[i] <= 22);
    for (let j = i + 1; j < sim.used; j++) assert.ok(Math.hypot(sim.x[i] - sim.x[j], sim.z[i] - sim.z[j]) >= sim.radius[i] + sim.radius[j] - 1e-6);
  }
});

test('live tuning rescales living health and cooldowns without applying deployment changes', () => {
  const sim = new BattleSimulation(2); sim.damage(sim.id[0], 25); sim.damage(sim.id[1], 1000);
  const before = sim.nextFire[0];
  sim.applyLiveTuning({ ...DEFAULT_TUNING, health: 200, damage: 25, fireInterval: 0.92, range: 18, speed: 5, radius: 0.4, halfWidth: 40 });
  assert.equal(sim.hp[0], 150); assert.equal(sim.hp[1], 0);
  assert.equal(sim.rifle.damage, 25); assert.equal(sim.rifle.range, 18); assert.equal(sim.tuning.speed, 5);
  assert.ok(Math.abs(sim.nextFire[0] - before * 2) < 1e-10);
  assert.equal(sim.tuning.radius, DEFAULT_TUNING.radius); assert.equal(sim.grid.halfWidth, DEFAULT_TUNING.halfWidth);
});

test('renumbering unit IDs cannot change crowd steering or the battle outcome', () => {
  const original = new BattleSimulation(100), renumbered = new BattleSimulation(100);
  renumbered.byId.clear();
  for (let i = 0; i < renumbered.used; i++) { renumbered.id[i]++; renumbered.byId.set(renumbered.id[i], i); }
  renumbered.nextId++;
  for (let n = 0; n < 12000 && original.result === 'running'; n++) { original.step(); renumbered.step(); }
  assert.notEqual(original.result, 'running'); assert.equal(renumbered.result, original.result);
  assert.deepEqual(renumbered.x, original.x); assert.deepEqual(renumbered.z, original.z);
  assert.deepEqual(renumbered.hp, original.hp); assert.equal(renumbered.totalShots, original.totalShots);
});
