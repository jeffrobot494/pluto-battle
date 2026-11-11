import test from 'node:test';
import assert from 'node:assert/strict';
import { BattleSimulation } from '../src/simulation.ts';
import { WEAPON_ID } from '../src/config.ts';
import { UPGRADES, zoneRadius } from '../src/upgrades.ts';

const bit = (w: number) => 1 << w;
/** A rifleman facing one stationary enemy `distance` away, ready to fire. */
function duel(distance: number) {
  const sim = new BattleSimulation(0);
  const a = sim.spawn(0, 0, 0)!, b = sim.spawn(1, 0, distance)!;
  const ai = sim.byId.get(a)!, bi = sim.byId.get(b)!;
  sim.target[ai] = b; sim.nextFire[ai] = 0; sim.nextFire[bi] = 1000; sim.nextSearch[bi] = 1000;
  sim.tuning.speed = 0;
  return { sim, a, ai, bi };
}
function shotsBy(sim: BattleSimulation, steps: number) {
  const before = sim.totalShots;
  for (let n = 0; n < steps; n++) sim.step();
  return sim.totalShots - before;
}

test('an upgrade adds the weapon and keeps the rest of the inventory', () => {
  const { sim, a, ai } = duel(20);
  sim.queue({ type: 'upgrade', ids: [a], weapon: WEAPON_ID.sniper }); sim.step();
  assert.equal(sim.inventory[ai], bit(WEAPON_ID.rifle) | bit(WEAPON_ID.sniper));
  assert.equal(sim.totalUpgrades, 1);
  sim.queue({ type: 'upgrade', ids: [a], weapon: WEAPON_ID.sniper }); sim.step();
  assert.equal(sim.totalUpgrades, 1, 'repeating an upgrade the soldier already has changes nothing');
});

test('a sniper upgrade at range 15 makes an idle rifleman switch and start firing', () => {
  const { sim, a, ai } = duel(15);
  assert.equal(shotsBy(sim, 60), 0, 'out of rifle range');
  sim.queue({ type: 'upgrade', ids: [a], weapon: WEAPON_ID.sniper });
  assert.ok(shotsBy(sim, 30) > 0);
  assert.equal(sim.weapon[ai], WEAPON_ID.sniper);
});

test('a shotgun upgrade at range 3 switches to the shotgun', () => {
  const { sim, a, ai } = duel(3);
  sim.step(); assert.equal(sim.weapon[ai], WEAPON_ID.rifle);
  sim.queue({ type: 'upgrade', ids: [a], weapon: WEAPON_ID.shotgun });
  assert.ok(shotsBy(sim, 30) > 0);
  assert.equal(sim.weapon[ai], WEAPON_ID.shotgun);
});

test('area upgrades reach only living soldiers of the given team inside the radius', () => {
  const sim = new BattleSimulation(0);
  const near = sim.spawn(0, 0, 0)!, edge = sim.spawn(0, 3, 0)!, far = sim.spawn(0, 8, 0)!, enemy = sim.spawn(1, 1, 1)!, dead = sim.spawn(0, -1, 1)!;
  sim.damage(dead, 1e6);
  const has = (id: number) => !!(sim.inventory[sim.byId.get(id)!] & bit(WEAPON_ID.sniper));
  assert.equal(sim.upgradeCandidates(0, 0, 0, 3, WEAPON_ID.sniper), 2);
  sim.queue({ type: 'upgradeArea', team: 0, x: 0, z: 0, radius: 3, weapon: WEAPON_ID.sniper }); sim.flushCommands();
  assert.deepEqual([near, edge, far, enemy, dead].map(has), [true, true, false, false, false]);
  assert.equal(sim.upgradeCandidates(0, 0, 0, 3, WEAPON_ID.sniper), 0);
  assert.equal(sim.upgrades[sim.byId.get(near)!], 1);
});

test('upgrades are ignored after the battle ends and invalid weapons are rejected', () => {
  const sim = new BattleSimulation(0);
  const a = sim.spawn(0, 0, 0)!; sim.spawn(1, 0, 20);
  sim.queue({ type: 'upgrade', ids: [a], weapon: 99 }); sim.flushCommands();
  assert.equal(sim.totalUpgrades, 0);
  sim.result = 'plutonians';
  sim.queue({ type: 'upgradeArea', team: 0, x: 0, z: 0, radius: 50, weapon: WEAPON_ID.shotgun }); sim.flushCommands();
  assert.equal(sim.totalUpgrades, 0);
});

test('reused slots clear upgrade feedback state', () => {
  const sim = new BattleSimulation(0);
  const a = sim.spawn(0, 0, 0)!; sim.spawn(1, 0, 20);
  sim.queue({ type: 'upgrade', ids: [a], weapon: WEAPON_ID.sniper }); sim.flushCommands();
  const slot = sim.byId.get(a)!;
  sim.damage(a, 1e6); sim.time += 10;
  const b = sim.spawn(0, 0, 0)!;
  assert.equal(sim.byId.get(b), slot);
  assert.equal(sim.upgrades[slot], 0); assert.equal(sim.inventory[slot], bit(WEAPON_ID.rifle));
});

test('the zone grows ever faster and respects a cap', () => {
  assert.ok(zoneRadius(0) > 0);
  assert.ok(zoneRadius(1) - zoneRadius(0) < zoneRadius(2) - zoneRadius(1));
  assert.ok(zoneRadius(4) > 60, 'a few seconds covers the whole battlefield');
  assert.equal(zoneRadius(100, 30), 30);
  assert.ok(UPGRADES.every(u => u.cost === 0));
});

test('a rifleman with a shotgun fires the rifle while closing to shotgun range', () => {
  const { sim, a, ai, bi } = duel(9);
  sim.tuning.speed = 3;
  sim.queue({ type: 'upgrade', ids: [a], weapon: WEAPON_ID.shotgun }); sim.flushCommands();
  assert.ok(shotsBy(sim, 10) > 0, 'fires while advancing');
  assert.equal(sim.weapon[ai], WEAPON_ID.rifle);
  const start = Math.hypot(sim.x[bi] - sim.x[ai], sim.z[bi] - sim.z[ai]);
  assert.ok(start < 9, 'advanced instead of holding at rifle range');
  for (let n = 0; n < 600 && sim.hp[bi] > 0 && sim.weapon[ai] !== WEAPON_ID.shotgun; n++) sim.step();
  assert.equal(sim.weapon[ai], WEAPON_ID.shotgun);
});

test('a soldier with a sniper rifle and laser rifle holds at sniper range', () => {
  const { sim, a, ai, bi } = duel(20);
  sim.queue({ type: 'upgrade', ids: [a], weapon: WEAPON_ID.sniper }); sim.flushCommands(); sim.step(); sim.tuning.speed = 3;
  const x = sim.x[ai], z = sim.z[ai];
  for (let n = 0; n < 30; n++) sim.step();
  assert.ok(sim.hp[bi] > 0);
  assert.ok(Math.hypot(sim.x[ai] - x, sim.z[ai] - z) < 0.01, 'holds instead of closing to rifle range');
});
