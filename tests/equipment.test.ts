import test from 'node:test';
import assert from 'node:assert/strict';
import { BattleSimulation } from '../src/simulation.ts';
import { CONFIG, NO_WEAPON, WEAPON_ID, WEAPONS } from '../src/config.ts';
import { copyEquipment, defaultEquipment, loadEquipment, saveEquipment, validateEquipment, type EquipmentSettings } from '../src/equipment.ts';
import { DEFAULT_TUNING } from '../src/tuning.ts';
import { writeSetting } from '../src/settings-store.ts';

const bit = (w: number) => 1 << w;
const all = bit(WEAPON_ID.rifle) | bit(WEAPON_ID.sniper) | bit(WEAPON_ID.shotgun);
function count(sim: BattleSimulation, team: number, w: number) {
  let count = 0;
  for (let i = 0; i < sim.used; i++) if (sim.team[i] === team && (sim.inventory[i] & bit(w))) count++;
  return count;
}
function duel(distance: number, inventory: number) {
  const sim = new BattleSimulation(0);
  const a = sim.spawn(0, 0, 0)!, b = sim.spawn(1, 0, distance)!;
  const ai = sim.byId.get(a)!, bi = sim.byId.get(b)!;
  sim.inventory[ai] = inventory; sim.target[ai] = b;
  sim.nextSearch[ai] = 100; sim.nextFire[ai] = 0; sim.nextFire[bi] = 100;
  sim.tuning.speed = 0;
  return { sim, ai, bi };
}

test('default loadouts retain standard rifles; percentages give exact, independently rounded counts', () => {
  const baseline = new BattleSimulation(100);
  assert.ok(baseline.inventory.slice(0, baseline.used).every(mask => mask === bit(WEAPON_ID.rifle)));
  const settings: EquipmentSettings = [{ rifle: 100, sniper: 10, shotgun: 25, rocket: 0 }, { rifle: 50, sniper: 100, shotgun: 0, rocket: 0 }];
  const sim = new BattleSimulation(100, 1234, CONFIG.capacity, undefined, undefined, undefined, settings);
  assert.deepEqual([count(sim, 0, 0), count(sim, 0, 2), count(sim, 0, 3)], [100, 10, 25]);
  assert.deepEqual([count(sim, 1, 0), count(sim, 1, 2), count(sim, 1, 3)], [50, 100, 0]);
  const small = new BattleSimulation(7, 1234, CONFIG.capacity, undefined, undefined, undefined, settings);
  assert.equal(count(small, 0, 2), 1); assert.equal(count(small, 0, 3), 2); assert.equal(count(small, 1, 0), 4);
  settings[0].sniper = 0;
  assert.equal(sim.equipment[0].sniper, 10);
});

test('100% of every item equips every soldier with all three weapons', () => {
  const settings: EquipmentSettings = [{ rifle: 100, sniper: 100, shotgun: 100, rocket: 0 }, { rifle: 100, sniper: 100, shotgun: 100, rocket: 0 }];
  const sim = new BattleSimulation(100, 9, CONFIG.capacity, undefined, undefined, undefined, settings);
  assert.ok(sim.inventory.slice(0, sim.used).every(mask => mask === all));
  assert.ok(sim.weapon.slice(0, sim.used).every(w => w === WEAPON_ID.sniper));
});

test('recipients repeat by seed, vary across seeds, and do not perturb formations or other allocations', () => {
  const settings: EquipmentSettings = [{ rifle: 100, sniper: 10, shotgun: 25, rocket: 0 }, { rifle: 100, sniper: 30, shotgun: 50, rocket: 0 }];
  const a = new BattleSimulation(100, 42, CONFIG.capacity, undefined, undefined, undefined, settings);
  const b = new BattleSimulation(100, 42, CONFIG.capacity, undefined, undefined, undefined, settings);
  const c = new BattleSimulation(100, 43, CONFIG.capacity, undefined, undefined, undefined, settings);
  const baseline = new BattleSimulation(100, 42);
  assert.deepEqual(a.inventory, b.inventory); assert.notDeepEqual(a.inventory, c.inventory);
  assert.deepEqual(a.x, baseline.x); assert.deepEqual(a.z, baseline.z);
  assert.deepEqual(a.nextSearch, baseline.nextSearch); assert.deepEqual(a.detourSide, baseline.detourSide);
  const changed = copyEquipment(settings); changed[0].shotgun = 90;
  const d = new BattleSimulation(100, 42, CONFIG.capacity, undefined, undefined, undefined, changed);
  for (let i = 0; i < a.used; i++) {
    assert.equal(a.inventory[i] & bit(2), d.inventory[i] & bit(2));
    if (a.team[i] === 1) assert.equal(a.inventory[i], d.inventory[i]);
  }
  assert.ok(a.inventory.slice(0, 10).some(mask => !(mask & bit(2))), 'Random recipients must not be the first ten slots.');
});

test('actual shots use the sniper at distance, shotgun up close, and rifle as a fallback', () => {
  for (const [distance, inventory, weapon] of [[20, all, 2], [7, all, 2], [3, all, 3], [8, bit(0) | bit(3), 0], [25, all, NO_WEAPON]]) {
    const { sim, ai, bi } = duel(distance, inventory);
    sim.step();
    assert.equal(sim.weapon[ai], weapon === NO_WEAPON ? WEAPON_ID.sniper : weapon);
    assert.equal(sim.hp[bi], 100 - (weapon === NO_WEAPON ? 0 : WEAPONS[weapon].damage));
    assert.equal(sim.totalShots, weapon === NO_WEAPON ? 0 : 1);
    if (weapon !== NO_WEAPON) { assert.equal(sim.shots.weapon[0], weapon); assert.equal(sim.events.weapon[0], weapon); }
  }
});

test('switching preserves cooldown, then fires the new weapon once ready', () => {
  const { sim, ai, bi } = duel(20, all);
  sim.step(); assert.equal(sim.weapon[ai], WEAPON_ID.sniper);
  const deadline = sim.nextFire[ai]; sim.hp[bi] = 1000;
  sim.grid.remove(bi); sim.z[bi] = 3; sim.grid.insert(bi, sim.x[bi], sim.z[bi]);
  sim.step();
  assert.equal(sim.weapon[ai], WEAPON_ID.shotgun); assert.equal(sim.nextFire[ai], deadline); assert.equal(sim.totalShots, 1);
  while (sim.time + CONFIG.step < deadline) sim.step();
  assert.equal(sim.totalShots, 1);
  sim.step(); assert.equal(sim.totalShots, 2); assert.equal(sim.hp[bi], 955);
  assert.ok(Math.abs(sim.nextFire[ai] - sim.time - WEAPONS[3].interval) < 1e-9);
});

test('nearby enemies interrupt a long-range engagement at the next target search', () => {
  const { sim, ai } = duel(20, all);
  const close = sim.spawn(1, 0, 3)!; sim.nextFire[sim.byId.get(close)!] = 100;
  sim.nextSearch[ai] = 0; sim.step();
  assert.equal(sim.target[ai], close); assert.equal(sim.weapon[ai], WEAPON_ID.shotgun);
  assert.equal(sim.hp[sim.byId.get(close)!], 55);
});

test('soldiers carrying a shotgun advance while snipers hold at long range', () => {
  for (const [inventory, advances] of [[bit(3), true], [bit(2), false], [bit(0) | bit(2), false], [all, true]]) {
    const { sim, ai } = duel(15, inventory); sim.tuning.speed = 3; sim.nextFire.fill(100);
    sim.step(); assert.equal(sim.moving[ai] === 1, advances);
  }
});

test('unarmed armies stay unarmed, deaths do not redistribute, and reused slots reset inventory', () => {
  const settings: EquipmentSettings = [{ rifle: 0, sniper: 0, shotgun: 0, rocket: 0 }, { rifle: 0, sniper: 0, shotgun: 0, rocket: 0 }];
  const sim = new BattleSimulation(3, 9, CONFIG.capacity, undefined, undefined, undefined, settings);
  for (let n = 0; n < 100; n++) sim.step();
  assert.equal(sim.totalShots, 0); assert.ok(sim.weapon.slice(0, sim.used).every(w => w === NO_WEAPON));
  sim.inventory[0] = all; const before = sim.inventory.slice(); const oldId = sim.id[0];
  sim.damage(oldId, 1000); assert.deepEqual(sim.inventory, before);
  sim.time += 3;
  const replacement = sim.spawn(0, 18, 20, WEAPON_ID.shotgun)!;
  assert.equal(sim.byId.get(replacement), 0); assert.equal(sim.inventory[0], bit(3));
  sim.queue({ type: 'equip', ids: [oldId], weapon: 2 }); sim.step(); assert.equal(sim.inventory[0], bit(3));
});

test('live rifle tuning changes weapon choice without changing inventories', () => {
  const { sim, ai } = duel(3, all);
  const before = sim.inventory.slice();
  sim.applyLiveTuning({ ...DEFAULT_TUNING, damage: 100, fireInterval: 0.1 });
  sim.step(); assert.equal(sim.weapon[ai], WEAPON_ID.rifle); assert.deepEqual(sim.inventory, before);
});

test('invalid allocations are rejected and persisted values recover independently', () => {
  const settings = defaultEquipment();
  for (const value of [-1, 101, 0.5, NaN, Infinity]) {
    settings[0].sniper = value; assert.equal(validateEquipment(settings), false);
    assert.throws(() => new BattleSimulation(1, 1, CONFIG.capacity, undefined, undefined, undefined, settings), /percentages/);
  }
  const key = 'pluto-battle-equipment-v1';
  const valid = defaultEquipment(); valid[0].sniper = 10; valid[1].shotgun = 45;
  saveEquipment(valid); assert.deepEqual(loadEquipment(), valid);
  writeSetting(key, '[{"rifle":-1,"sniper":12,"shotgun":"50"},{"rifle":0,"sniper":101,"shotgun":75}]');
  assert.deepEqual(loadEquipment(), [{ rifle: 100, sniper: 12, shotgun: 0, rocket: 0 }, { rifle: 0, sniper: 0, shotgun: 75, rocket: 0 }]);
  writeSetting(key, 'broken'); assert.deepEqual(loadEquipment(), defaultEquipment());
});

test('mixed-loadout battles reproduce combat and finish', () => {
  const settings: EquipmentSettings = [{ rifle: 100, sniper: 25, shotgun: 60, rocket: 0 }, { rifle: 100, sniper: 25, shotgun: 60, rocket: 0 }];
  const a = new BattleSimulation(100, 12, CONFIG.capacity, undefined, undefined, undefined, settings);
  const b = new BattleSimulation(100, 12, CONFIG.capacity, undefined, undefined, undefined, settings);
  for (let n = 0; n < 12000 && a.result === 'running'; n++) { a.step(); b.step(); }
  assert.notEqual(a.result, 'running'); assert.equal(a.result, b.result);
  assert.deepEqual(a.hp, b.hp); assert.deepEqual(a.x, b.x); assert.equal(a.totalShots, b.totalShots);
});
