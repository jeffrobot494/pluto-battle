import test from 'node:test';
import assert from 'node:assert/strict';
import { BattleSimulation } from '../src/simulation.ts';
import { CONFIG, NO_WEAPON, WEAPON_ID } from '../src/config.ts';

const bit = (w: number) => 1 << w;
const ROCKET = bit(WEAPON_ID.rocket), RIFLE = bit(WEAPON_ID.rifle);

function duel(distance: number, inventory: number) {
  const sim = new BattleSimulation(0);
  const a = sim.spawn(0, 0, 0)!, b = sim.spawn(1, 0, distance)!;
  const ai = sim.byId.get(a)!, bi = sim.byId.get(b)!;
  sim.inventory[ai] = inventory; sim.target[ai] = b;
  sim.nextSearch[ai] = 100; sim.nextFire[ai] = 0; sim.nextFire[bi] = 100;
  sim.tuning.speed = 0;
  return { sim, ai, bi };
}
const fly = (sim: BattleSimulation, ticks = 240) => { for (let n = 0; n < ticks && (sim.rockets.count || n === 0); n++) sim.step(); };

test('a carried rocket is chosen first within rocket range, then leaves the inventory', () => {
  const { sim, ai, bi } = duel(8, ROCKET | RIFLE);
  assert.equal(sim.selectWeapon(ai, 8), WEAPON_ID.rocket);
  assert.equal(sim.selectWeapon(ai, sim.rocket.range + 1), WEAPON_ID.rocket, 'the launcher (longest reach) is carried while closing');
  assert.equal(sim.selectWeapon(ai, 8) === WEAPON_ID.rocket && sim.selectWeapon(ai, 5), WEAPON_ID.rocket, 'rocket beats rifle DPS in reach');
  assert.equal(sim.preferredRange(ai), sim.rocket.range);
  sim.step();
  assert.equal(sim.totalRockets, 1); assert.equal(sim.rockets.count, 1);
  assert.equal(sim.inventory[ai], RIFLE); assert.equal(sim.weapon[ai], WEAPON_ID.rifle);
  fly(sim);
  assert.equal(sim.rockets.count, 0);
  assert.ok(sim.hp[bi] <= CONFIG.soldier.health - sim.tuning.rocketDamage + 1e-9, `target hp ${sim.hp[bi]}`);
  assert.equal(sim.totalRockets, 1, 'only one rocket per launcher');
});

test('a soldier whose only weapon was the rocket is weaponless after firing', () => {
  const { sim, ai } = duel(10, ROCKET);
  sim.step();
  assert.equal(sim.totalRockets, 1); assert.equal(sim.inventory[ai], 0); assert.equal(sim.weapon[ai], NO_WEAPON);
  fly(sim); sim.nextFire[ai] = 0;
  for (let n = 0; n < 60; n++) sim.step();
  assert.equal(sim.totalRockets, 1);
});

test('the blast hurts allies near the target, and the shooter too when he is close', () => {
  const { sim, ai, bi } = duel(9, ROCKET);
  const friend = sim.byId.get(sim.spawn(0, 1.2, 9)!)!; sim.nextFire[friend] = 100;
  sim.step(); fly(sim);
  assert.ok(sim.hp[bi] < CONFIG.soldier.health); assert.ok(sim.hp[friend] < CONFIG.soldier.health, 'ally inside the radius takes damage');
  assert.equal(sim.hp[ai], CONFIG.soldier.health, 'shooter outside the radius is safe');
  const close = duel(2.5, ROCKET); close.sim.step(); fly(close.sim);
  assert.ok(close.sim.hp[close.ai] < CONFIG.soldier.health, 'no self-blast check');
});

test('an ally in the lane holds the rocket like a laser', () => {
  const { sim, ai } = duel(10, ROCKET);
  const friend = sim.byId.get(sim.spawn(0, 0, 3)!)!; sim.nextFire[friend] = 100;
  sim.step();
  assert.equal(sim.totalRockets, 0); assert.equal(sim.totalBlockedShots, 1); assert.equal(sim.inventory[ai], ROCKET);
});

test('rockets aim at the feet and stay deterministic', () => {
  const run = () => {
    const { sim, ai } = duel(12, ROCKET); sim.step();
    const r = sim.rockets, shooterY = sim.y[ai] + 0.7;
    assert.ok(r.dy[0] < 0, 'aimed down toward the feet');
    const end = [] as number[]; fly(sim);
    for (let i = 0; i < sim.used; i++) end.push(sim.hp[i], sim.x[i], sim.z[i]);
    return { dy: r.dy[0], shooterY, end };
  };
  assert.deepEqual(run(), run());
});

test('a mass rocket battle stays bounded and finishes', () => {
  const sim = new BattleSimulation(250);
  for (let i = 0; i < sim.used; i++) sim.inventory[i] |= ROCKET;
  let peak = 0;
  for (let n = 0; n < 1200 && sim.result === 'running'; n++) { sim.step(); peak = Math.max(peak, sim.rockets.count); }
  assert.ok(sim.totalRockets > 100, `rockets fired: ${sim.totalRockets}`);
  assert.ok(peak <= sim.rockets.capacity); assert.equal(sim.droppedRockets, 0);
});
