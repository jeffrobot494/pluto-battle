import test from 'node:test';
import assert from 'node:assert/strict';
import { BattleSimulation } from '../src/simulation.ts';
import { BattleRoster, Roster, ROSTER_SIZE, SOLDIERS_KEY, loadRoster, randomName, saveRoster, validName } from '../src/soldiers.ts';
import { random } from '../src/random.ts';
import { readSetting, writeSetting } from '../src/settings-store.ts';

test('random names are 1–14 letters with a capital first letter', () => {
  const rng = random(7), lengths = new Set<number>();
  for (let i = 0; i < 2000; i++) {
    const name = randomName(rng);
    assert.ok(validName(name) && /^[A-Z][a-z]*$/.test(name), name);
    lengths.add(name.length);
  }
  assert.equal(Math.min(...lengths), 1); assert.equal(Math.max(...lengths), 14);
});

test('create, read, update and delete soldiers', () => {
  const roster = new Roster(random(1));
  const a = roster.create(), b = roster.create({ name: 'Zed', level: 3 });
  assert.equal(a.level, 1);
  assert.notEqual(a.id, b.id); assert.equal(roster.size, 2);
  assert.deepEqual(roster.get(b.id), { id: b.id, name: 'Zed', level: 3 });
  assert.ok(roster.update(a.id, { name: 'Quark', level: 2 }));
  assert.deepEqual(roster.get(a.id), { id: a.id, name: 'Quark', level: 2 });
  assert.equal(roster.update(a.id, { name: 'not valid' }), false);
  assert.equal(roster.update(a.id, { level: -1 }), false);
  assert.equal(roster.update(999, { level: 1 }), false);
  // Returned records are copies; mutating them does not change the roster.
  roster.get(a.id)!.level = 50; assert.equal(roster.get(a.id)!.level, 2);
  assert.ok(roster.delete(a.id)); assert.equal(roster.get(a.id), undefined); assert.equal(roster.size, 1);
  roster.reset(); assert.equal(roster.size, ROSTER_SIZE);
  assert.ok(roster.list().every(r => r.level === 1)); assert.equal(roster.get(b.id), undefined);
});

test('drafts are distinct, random in order and top up a small pool', () => {
  const roster = new Roster(random(3)); roster.reset();
  const first = roster.draft(500), second = roster.draft(500);
  assert.equal(new Set(first.map(r => r.id)).size, 500);
  // The last formation slot holds different soldiers from battle to battle.
  assert.notDeepEqual(first.slice(-50).map(r => r.id), second.slice(-50).map(r => r.id));
  const counts = new Map<number, number>();
  for (let n = 0; n < 200; n++) for (const r of roster.draft(100)) counts.set(r.id, (counts.get(r.id) ?? 0) + 1);
  assert.ok(counts.size > ROSTER_SIZE * 0.99, 'nearly every soldier is drafted over many battles');
  const small = new Roster(random(4)); small.create();
  assert.equal(small.draft(10).length, 10); assert.equal(small.size, 10);
});

test('survivors of a finished battle level up once; the fallen drop to level 1 and stay in the pool', () => {
  const roster = new Roster(random(5)); roster.reset();
  for (const r of roster.list()) roster.update(r.id, { level: 5 });
  const sim = new BattleSimulation(20, 11);
  const battle = new BattleRoster(roster, sim);
  const plutonians = [...Array(sim.used).keys()].filter(i => sim.team[i] === 0);
  assert.equal(plutonians.length, 20);
  assert.ok(plutonians.every(i => battle.soldier(sim.id[i])));
  assert.equal(battle.soldier(sim.id[sim.used - 1]), undefined, 'Sectoids are anonymous');
  // Kill half the Plutonians and every Sectoid.
  const fallen = plutonians.slice(0, 10).map(i => battle.soldier(sim.id[i])!.id);
  for (const i of plutonians.slice(0, 10)) sim.hp[i] = 0;
  for (let i = 0; i < sim.used; i++) if (sim.team[i] === 1) sim.hp[i] = 0;
  assert.equal(battle.living().length, 10);
  assert.equal(battle.recordOutcome(), false, 'no promotion while the battle runs');
  // Death resets a soldier's level immediately, once.
  assert.equal(battle.recordDeaths(), 10); assert.equal(battle.recordDeaths(), 0);
  assert.ok(fallen.every(id => roster.get(id)?.level === 1));
  assert.equal(battle.soldier(sim.id[plutonians[0]])!.level, 1, 'the battle record shows the reset');
  sim.result = 'plutonians';
  assert.ok(battle.recordOutcome()); assert.equal(battle.recordOutcome(), false);
  const survivors = battle.living().map(s => s.record.id);
  assert.ok(survivors.every(id => roster.get(id)?.level === 6));
  assert.ok(fallen.every(id => roster.get(id)?.level === 1)); assert.equal(roster.size, ROSTER_SIZE);
  assert.equal(roster.list().filter(r => r.level === 5).length, ROSTER_SIZE - 20, 'undrafted soldiers are untouched');
  assert.ok(battle.living().every(s => s.record.level === 6), 'battle records show the new level');
  // Recruits attached to an already fallen body after a reset are not counted as deaths.
  roster.reset();
  assert.equal(new BattleRoster(roster, sim).recordDeaths(), 0);
});

test('rosters save and load, and invalid saves fall back to a fresh pool', () => {
  const roster = new Roster(random(6)); roster.reset(5);
  roster.update(roster.list()[0].id, { level: 4 });
  saveRoster(roster);
  const loaded = loadRoster();
  assert.deepEqual(loaded.list(), roster.list());
  assert.ok(loaded.create().id > Math.max(...roster.list().map(r => r.id)), 'ids are never reused');
  writeSetting(SOLDIERS_KEY, '{"nextId":2,"soldiers":[[1,"bad name",0]]}');
  assert.equal(loadRoster().size, ROSTER_SIZE);
  assert.ok(readSetting(SOLDIERS_KEY));
});

test('saved level 0 recruits move to level 1 without changing veteran levels', () => {
  const roster = new Roster();
  assert.ok(roster.restore('{"nextId":3,"soldiers":[[1,"Nova",0],[2,"Vega",4]]}'));
  assert.deepEqual(roster.list(), [{ id: 1, name: 'Nova', level: 1 }, { id: 2, name: 'Vega', level: 4 }]);
});

test('legacy levels above ten are restored and survivors stop at ten', () => {
  const roster = new Roster(random(9));
  assert.ok(roster.restore('{"nextId":3,"soldiers":[[1,"Nova",9],[2,"Vega",18]]}'));
  assert.equal(roster.get(2)?.level, 10);
  const sim = new BattleSimulation(2, 11);
  const battle = new BattleRoster(roster, sim);
  sim.result = 'plutonians';
  assert.ok(battle.recordOutcome());
  assert.deepEqual(battle.living().map(({ record }) => record.level), [10, 10]);
  assert.deepEqual(roster.list().map(record => record.level), [10, 10]);
});
