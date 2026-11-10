import test from 'node:test';
import assert from 'node:assert/strict';
import { BattleSimulation, rayCircle } from '../src/simulation.ts';
import { CONFIG, WEAPONS } from '../src/config.ts';

function separation(sim: BattleSimulation) {
  for (let i = 0; i < sim.used; i++) if (sim.hp[i] > 0) for (let j = i + 1; j < sim.used; j++) if (sim.hp[j] > 0) {
    assert.ok(Math.hypot(sim.x[i] - sim.x[j], sim.z[i] - sim.z[j]) >= sim.radius[i] + sim.radius[j] - 1e-6, `Overlap: ${i}, ${j}`);
  }
}

test('default and stress deployments have exact counts and legal occupancy', () => {
  for (const count of [100, 250, 500]) {
    const sim = new BattleSimulation(count);
    assert.deepEqual(Array.from(sim.alive), [count, count]);
    assert.equal(sim.byId.size, count * 2); separation(sim);
  }
});

test('dense opposing crowds never penetrate through movement, grid crossings or deaths', () => {
  const sim = new BattleSimulation(100); sim.weaponsEnabled = false;
  const initialCenter = Array.from(sim.z.slice(0, 100)).reduce((a, b) => a + b, 0) / 100;
  for (let n = 0; n < 720; n++) {
    sim.step(); if (n % 30 === 0) separation(sim);
    if (n === 119) assert.ok(Array.from(sim.z.slice(0, 100)).reduce((a, b) => a + b, 0) / 100 < initialCenter);
  }
  separation(sim);
  for (let i = 0; i < sim.used; i += 4) sim.damage(sim.id[i], 1000);
  for (let n = 0; n < 180; n++) sim.step();
  separation(sim);
  for (let i = 0; i < sim.used; i++) {
    assert.equal(sim.grid.cell[i] >= 0, sim.hp[i] > 0);
    if (sim.hp[i] > 0) assert.equal(sim.grid.cell[i], sim.grid.row(sim.z[i]) * sim.grid.columns + sim.grid.column(sim.x[i]));
  }
});

test('weapons respect range, friendly fire and first enemy intersection', () => {
  const sim = new BattleSimulation(0);
  const shooter = sim.spawn(0, 0, 0)!, ally = sim.spawn(0, 0, 2)!, front = sim.spawn(1, 0, 5)!, rear = sim.spawn(1, 0, 7)!;
  const s = sim.byId.get(shooter)!, f = sim.byId.get(front)!, r = sim.byId.get(rear)!;
  sim.target[s] = rear;
  sim.nextFire[s] = 0; sim.nextFire[f] = sim.nextFire[r] = 1000;
  sim.nextFire[sim.byId.get(ally)!] = 1000;
  sim.step();
  assert.equal(sim.hp[f], CONFIG.soldier.health - WEAPONS[0].damage);
  assert.equal(sim.hp[r], CONFIG.soldier.health); assert.equal(sim.hp[sim.byId.get(ally)!], CONFIG.soldier.health);
  const far = new BattleSimulation(0); const a = far.spawn(0, 0, 15)!, b = far.spawn(1, 0, -15)!;
  far.target[far.byId.get(a)!] = b; far.nextFire.fill(0); far.step(); assert.equal(far.totalShots, 0);
});

test('approaching rifles retain staggered firing phases at first contact', () => {
  const sim = new BattleSimulation(100);
  const firedAt = new Set<number>();
  for (let n = 0; n < 240; n++) {
    const before = sim.totalShots; sim.step();
    if (sim.totalShots > before) firedAt.add(sim.tick);
  }
  assert.ok(firedAt.size > 15, `Only ${firedAt.size} distinct firing ticks`);
});

test('both teams can fire a lethal shot in the same step and produce a draw', () => {
  const sim = new BattleSimulation(0); const a = sim.spawn(0, 0, 2)!, b = sim.spawn(1, 0, -2)!;
  const ai = sim.byId.get(a)!, bi = sim.byId.get(b)!;
  sim.hp[ai] = sim.hp[bi] = WEAPONS[0].damage;
  sim.target[ai] = b; sim.target[bi] = a; sim.nextFire.fill(0);
  sim.step(); assert.equal(sim.totalShots, 2); assert.equal(sim.result, 'draw');
  assert.equal(sim.lastHit[ai], sim.time); assert.equal(sim.lastHit[bi], sim.time);
  assert.equal(sim.grid.cell[ai], -1); assert.equal(sim.grid.cell[bi], -1);
});

test('live queued spawns validate occupancy; upgrades copy IDs and preserve cooldowns', () => {
  const sim = new BattleSimulation(1); const id = sim.id[0], ids = [id], oldCooldown = sim.nextFire[0];
  sim.queue({ type: 'equip', ids, weapon: 1 }); ids.length = 0;
  sim.queue({ type: 'spawn', team: 0, x: 18, z: 20 });
  sim.queue({ type: 'spawn', team: 0, x: 18, z: 20 });
  sim.step(); assert.equal(sim.weapon[0], 1); assert.equal(sim.nextFire[0], oldCooldown);
  assert.equal(sim.alive[0], 2); assert.equal(sim.rejectedSpawns, 1); separation(sim);
  assert.equal(sim.spawn(0, NaN, 0), null); assert.equal(sim.spawn(0, 100, 0), null);
});

test('reused slots have new IDs and stale references cannot damage or equip replacements', () => {
  const sim = new BattleSimulation(1); const oldId = sim.id[0]; sim.damage(oldId, 1000);
  // Let its bounded death presentation expire while keeping the battle running.
  sim.time = 3;
  const newId = sim.spawn(0, 20, 20)!;
  assert.ok(newId !== oldId); assert.equal(sim.byId.get(oldId), undefined); assert.equal(sim.byId.get(newId), 0);
  sim.damage(oldId, 1000); sim.queue({ type: 'equip', ids: [oldId], weapon: 1 }); sim.step();
  assert.equal(sim.hp[0], CONFIG.soldier.health); assert.equal(sim.weapon[0], 0); separation(sim);
});

test('damage does not depend on cosmetic effect capacity; hits refresh their timestamp', () => {
  const sim = new BattleSimulation(1), id = sim.id[0];
  for (let n = 0; n < CONFIG.maxEffects * 3; n++) sim.shots.emit(0, 0, 1, 1, 0, sim.time);
  sim.damage(id, 10); assert.equal(sim.hp[0], 90); assert.equal(sim.lastHit[0], 0);
  sim.time = 0.06; sim.damage(id, 10); assert.equal(sim.hp[0], 80); assert.equal(sim.lastHit[0], 0.06);
});

test('seeded 200-unit battles finish, remain separated and reproduce exactly', () => {
  const first = new BattleSimulation(100), second = new BattleSimulation(100);
  for (let n = 0; n < 12000 && first.result === 'running'; n++) {
    first.step(); second.step(); if (n % 300 === 0) separation(first);
  }
  assert.notEqual(first.result, 'running'); assert.equal(first.result, second.result);
  assert.equal(first.totalShots, second.totalShots); assert.deepEqual(first.x, second.x); assert.deepEqual(first.hp, second.hp);
  separation(first);
});

test('ray-circle sweep catches contact along a segment, including starting inside', () => {
  assert.equal(rayCircle(0, 0, 1, 0, 2, 0, 0.5), 1.5);
  assert.equal(rayCircle(2, 0, 1, 0, 2, 0, 0.5), 0);
  assert.equal(rayCircle(0, 0, 1, 0, 2, 2, 0.5), Infinity);
});
