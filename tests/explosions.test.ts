import test from 'node:test';
import assert from 'node:assert/strict';
import { BattleSimulation } from '../src/simulation.ts';
import { CONFIG } from '../src/config.ts';
import { DEFAULT_TUNING } from '../src/tuning.ts';
import { rayCapsule } from '../src/collision.ts';
import type { Explosion } from '../src/explosions.ts';

const blast: Explosion = { x: 0, y: 0, z: 0, radius: 4, damage: 35, impulse: 10 };
function quiet() {
  const sim = new BattleSimulation(0); sim.weaponsEnabled = false; sim.tuning.speed = 0;
  sim.spawn(1, 25, 25);
  return sim;
}
function spawn(sim: BattleSimulation, x: number, z: number, y = 0, team: 0 | 1 = 0) {
  const id = sim.spawn(team, x, z)!; assert.ok(id); const i = sim.byId.get(id)!;
  sim.y[i] = sim.previousY[i] = y; return i;
}
function separated(sim: BattleSimulation) {
  for (let i = 0; i < sim.used; i++) if (sim.hp[i] > 0) for (let j = i + 1; j < sim.used; j++) if (sim.hp[j] > 0) {
    const axial = CONFIG.soldier.height - sim.radius[i] - sim.radius[j];
    const dy = Math.max(0, Math.abs(sim.y[i] - sim.y[j]) - axial);
    assert.ok(Math.hypot(sim.x[i] - sim.x[j], dy, sim.z[i] - sim.z[j]) >= sim.radius[i] + sim.radius[j] - 1e-6, `capsules ${i}/${j} overlap at tick ${sim.tick}`);
  }
  for (let i = 0; i < sim.used; i++) if (sim.hp[i] > 0) {
    assert.equal(sim.grid.cell[i], sim.grid.row(sim.z[i]) * sim.grid.columns + sim.grid.column(sim.x[i]));
    assert.equal(sim.targetGrid.cell[i], sim.targetGrid.row(sim.z[i]) * sim.targetGrid.columns + sim.targetGrid.column(sim.x[i]));
  }
}

test('spherical membership includes the boundary and excludes elevated or distant bodies', () => {
  const sim = quiet(); sim.tuning.gravity = 0;
  const near = spawn(sim, 1, 0), edge = spawn(sim, 4, 0), outside = spawn(sim, 4.7, 0), high = spawn(sim, -1, 0, 5);
  sim.queue({ type: 'explode', ...blast, y: CONFIG.soldier.height / 2, impulse: 0 }); sim.step();
  assert.equal(sim.hp[near], 65); assert.equal(sim.hp[edge], 65); assert.equal(sim.hp[outside], 100); assert.equal(sim.hp[high], 100);
});

test('impulse points outward in 3D, falls linearly, and accumulates for simultaneous blasts', () => {
  const sim = quiet(); sim.tuning.gravity = 0;
  const near = spawn(sim, 1, 0, 2), far = spawn(sim, -3, 0, 2);
  for (let n = 0; n < 2; n++) sim.queue({ type: 'explode', ...blast, y: 2 + CONFIG.soldier.height / 2, damage: 5 });
  sim.step();
  assert.equal(sim.velocityX[near], 15); assert.equal(sim.velocityX[far], -5);
  assert.equal(sim.velocityY[near], 0); assert.equal(sim.hp[near], 90); assert.equal(sim.hp[far], 90);
  assert.equal(sim.totalExplosions, 2);
});

test('ground blasts launch upward and the coincident-center fallback stays finite', () => {
  const sim = quiet(); sim.tuning.gravity = 0;
  const i = spawn(sim, 0, 0);
  sim.queue({ type: 'explode', ...blast, y: CONFIG.soldier.height / 2 }); sim.step();
  assert.equal(sim.velocityY[i], 10); assert.ok(sim.y[i] > 0); assert.equal(sim.grounded[i], 0);
  assert.ok(Number.isFinite(sim.x[i]) && Number.isFinite(sim.y[i]));
});

test('gravity and live gravity changes return launched bodies to ground; friction settles them', () => {
  const sim = quiet(), i = spawn(sim, 0, 0);
  sim.queue({ type: 'explode', ...blast, x: -0.5, damage: 0 }); sim.step();
  const initial = sim.velocityY[i];
  sim.applyLiveTuning({ ...DEFAULT_TUNING, gravity: 20, speed: 0 }); sim.step();
  assert.ok(Math.abs(sim.velocityY[i] - initial + 20 * CONFIG.step) < 1e-9);
  for (let n = 0; n < 300; n++) sim.step();
  assert.equal(sim.y[i], 0); assert.equal(sim.velocityY[i], 0); assert.equal(sim.grounded[i], 1);
  assert.equal(sim.velocityX[i], 0); assert.equal(sim.velocityZ[i], 0);
});

test('zero gravity preserves airborne velocity rather than adding frame-dependent damping', () => {
  const sim = quiet(); sim.tuning.gravity = 0; const i = spawn(sim, 0, 0, 2);
  sim.velocityY[i] = 3;
  for (let n = 0; n < 60; n++) sim.step();
  assert.ok(Math.abs(sim.y[i] - 5) < 1e-9); assert.equal(sim.velocityY[i], 3);
});

test('fast swept movement cannot cross another capsule or the field boundary', () => {
  const sim = quiet(); sim.tuning.gravity = 0;
  const i = spawn(sim, -2, 0), obstacle = spawn(sim, 0, 0);
  sim.velocityX[i] = 300; sim.step(); separated(sim);
  assert.ok(sim.x[i] < sim.x[obstacle]); assert.equal(sim.velocityX[i], 0);
  sim.velocityX[i] = -10000; sim.step();
  assert.ok(sim.x[i] >= -sim.grid.halfWidth + sim.radius[i]);
  assert.equal(sim.velocityX[i], 0);
});

test('vertically separated capsules can cross, then land without penetrating', () => {
  const sim = quiet(); const low = spawn(sim, 0, 0), high = spawn(sim, -2, 0, 3);
  sim.velocityX[high] = 240; sim.step(); assert.ok(sim.x[high] > sim.x[low]); separated(sim);
  sim.velocityX[high] = 0;
  for (let n = 0; n < 180; n++) { sim.step(); separated(sim); }
  assert.equal(sim.y[high], 0);
});

test('a centered head landing slides off and eventually restores legal ground occupancy', () => {
  const sim = quiet(), low = spawn(sim, 0, 0), high = spawn(sim, 1.5, 0, 2);
  sim.x[high] = sim.previousX[high] = sim.x[low]; sim.grid.insert(high, sim.x[high], sim.z[high]);
  for (let n = 0; n < 600; n++) { sim.step(); separated(sim); }
  assert.equal(sim.y[high], 0); assert.equal(sim.grounded[high], 1);
});

test('lethal blasts retain motion after victory and record a stable battle duration', () => {
  const sim = new BattleSimulation(0); sim.weaponsEnabled = false; sim.tuning.speed = 0;
  const i = spawn(sim, 0, 0), j = spawn(sim, 1, 0, 0, 1);
  sim.queue({ type: 'explode', ...blast, damage: 100 }); sim.step();
  assert.equal(sim.result, 'draw'); assert.equal(sim.hp[i], 0); assert.equal(sim.hp[j], 0);
  const height = sim.y[i], endedAt = sim.battleTime; sim.step();
  assert.ok(sim.y[i] > height); assert.equal(sim.battleTime, endedAt); assert.ok(sim.time > endedAt);
  for (let n = 0; n < 120; n++) sim.step();
  const replacement = sim.spawn(0, -10, -10)!, slot = sim.byId.get(replacement)!;
  assert.equal(slot, i); assert.equal(sim.y[slot], 0); assert.equal(sim.previousY[slot], 0);
  assert.equal(sim.velocityX[slot], 0); assert.equal(sim.velocityY[slot], 0); assert.equal(sim.velocityZ[slot], 0);
});

test('command snapshots and saturated cosmetic pools cannot change explosion damage', () => {
  const sim = quiet(), i = spawn(sim, 0, 0);
  const command = { type: 'explode' as const, ...blast, damage: 1, impulse: 0 };
  for (let n = 0; n < 80; n++) sim.queue(command);
  command.damage = 100; command.radius = 0; sim.step();
  assert.equal(sim.hp[i], 20); assert.equal(sim.totalExplosions, 80);
  assert.equal(sim.explosions.overwritten, 80 - sim.explosions.capacity);
});

test('invalid explosion parameters are rejected without poisoning state', () => {
  const sim = quiet(), i = spawn(sim, 0, 0);
  for (const values of [{ x: NaN }, { y: Infinity }, { radius: 0 }, { radius: 21 }, { damage: -1 }, { impulse: 41 }]) sim.queue({ type: 'explode', ...blast, ...values });
  sim.step(); assert.equal(sim.rejectedExplosions, 6); assert.equal(sim.totalExplosions, 0); assert.equal(sim.hp[i], 100);
});

test('3D lasers pass over low bodies and hit the first elevated capsule', () => {
  const sim = new BattleSimulation(0); sim.tuning.gravity = 0; sim.tuning.speed = 0;
  const shooter = spawn(sim, 0, 0), low = spawn(sim, 0, 2, 0, 1), high = spawn(sim, 0, 6, 6, 1);
  sim.target[shooter] = sim.id[high]; sim.nextFire.fill(1000); sim.nextFire[shooter] = 0; sim.step();
  assert.equal(sim.hp[low], 100); assert.equal(sim.hp[high], 91); assert.ok(sim.aimPitch[shooter] < 0);
  assert.ok(sim.shots.endY[0] > sim.shots.y[0]);
  assert.ok(Math.abs(rayCapsule(0, 0.5, 0, 0, 1, 0, 0, 2, 0, 0.29) - 1.5) < 1e-9);
});

test('laser and blast damage commit together so a lethally blasted soldier still fires', () => {
  const sim = new BattleSimulation(0); sim.tuning.speed = 0;
  const a = spawn(sim, 0, 2), b = spawn(sim, 0, -2, 0, 1);
  sim.hp[a] = sim.hp[b] = 10; sim.target[a] = sim.id[b]; sim.target[b] = sim.id[a]; sim.nextFire.fill(0);
  sim.queue({ type: 'explode', ...blast, damage: 1, impulse: 0 }); sim.step();
  assert.equal(sim.result, 'draw'); assert.equal(sim.totalShots, 2);
});

test('dense maximum-strength repeated blasts remain separated and reproduce exactly', () => {
  const a = new BattleSimulation(100), b = new BattleSimulation(100);
  for (const sim of [a, b]) { sim.weaponsEnabled = false; sim.hp.fill(100000, 0, sim.used); }
  for (let n = 0; n < 480; n++) {
    if (n % 120 < 3) for (let p = 0; p < 4; p++) for (const sim of [a, b]) sim.queue({ type: 'explode', ...blast, x: (p - 1.5) * 2, z: n < 120 ? 12 : 0, radius: 20, damage: 0, impulse: 40 });
    a.step(); b.step(); if (n % 10 === 0) separated(a);
    for (let i = 0; i < a.used; i++) { assert.ok(a.y[i] >= 0); assert.ok(Math.abs(a.x[i]) + a.radius[i] <= a.grid.halfWidth + 1e-6); }
  }
  assert.deepEqual(a.x, b.x); assert.deepEqual(a.y, b.y); assert.deepEqual(a.z, b.z);
  assert.deepEqual(a.velocityY, b.velocityY); assert.deepEqual(a.hp, b.hp);
});

test('1,000 bodies retain legal capsule occupancy through dense blast bursts and landings', () => {
  const sim = new BattleSimulation(500); sim.hp.fill(1e9, 0, sim.used);
  for (let n = 0; n < 600; n++) {
    if (n % 120 < 3) for (let p = 0; p < 4; p++) sim.queue({ type: 'explode', ...blast, x: (p - 1.5) * 2, z: n < 120 ? 12 : 0, radius: 20, damage: 0, impulse: 40 });
    sim.step(); if (n % 60 === 0) separated(sim);
  }
  assert.deepEqual(Array.from(sim.alive), [500, 500]); separated(sim);
});
