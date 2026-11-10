import test from 'node:test';
import assert from 'node:assert/strict';
import { SOUND_EFFECTS, synthesizeEffect } from '../src/audio.ts';
import { BattleSimulation } from '../src/simulation.ts';

test('all five effects produce distinct, finite audio with headroom and click-free ends', () => {
  const signatures = new Set<string>();
  for (const rate of [22050, 44100, 48000]) for (const effect of SOUND_EFFECTS) {
    const samples = synthesizeEffect(effect.id, rate);
    assert.equal(samples.length, Math.ceil(effect.duration * rate));
    let peak = 0, energy = 0;
    for (const value of samples) {
      assert.ok(Number.isFinite(value)); peak = Math.max(peak, Math.abs(value)); energy += value * value;
    }
    assert.ok(peak > 0.69 && peak < 0.71);
    assert.ok(energy / samples.length > 0.001, effect.id);
    assert.equal(Math.abs(samples[0]), 0); assert.ok(Math.abs(samples.at(-1)!) < 0.001);
    if (rate === 44100) signatures.add(Array.from(samples.slice(100, 108)).join(','));
  }
  assert.equal(signatures.size, 5);
});

test('combat emits firing and the victim team for hits and deaths without duplicate death cries', () => {
  const sim = new BattleSimulation(0);
  const pluto = sim.spawn(0, 0, 2)!, sectoid = sim.spawn(1, 0, -2)!;
  sim.target[sim.byId.get(pluto)!] = sectoid;
  sim.nextFire[sim.byId.get(pluto)!] = 0;
  sim.nextFire[sim.byId.get(sectoid)!] = 100;
  sim.step();
  assert.equal(sim.events.cursor, 2);
  assert.deepEqual(sim.events.kind.slice(0, 2), ['shot', 'hit']);
  assert.deepEqual(Array.from(sim.events.team.slice(0, 2)), [0, 1]);
  sim.damage(pluto, 1); sim.damage(pluto, 1000); sim.damage(sectoid, 1000);
  const end = sim.events.cursor; sim.damage(pluto, 1000); sim.damage(sectoid, 1000);
  assert.equal(sim.events.cursor, end);
  assert.deepEqual(sim.events.kind.slice(2, end), ['hit', 'death', 'death']);
  assert.deepEqual(Array.from(sim.events.team.slice(2, end)), [0, 0, 1]);
});

test('saturating the sound event buffer does not change combat damage or deaths', () => {
  const sim = new BattleSimulation(1), id = sim.id[0];
  for (let n = 0; n < sim.events.capacity * 3; n++) sim.events.emit('shot', 0, 0, sim.time);
  sim.damage(id, 20); assert.equal(sim.hp[0], 80);
  sim.damage(id, 1000); assert.equal(sim.hp[0], 0); assert.equal(sim.alive[0], 0);
  assert.equal(sim.events.kind[(sim.events.cursor - 1) % sim.events.capacity], 'death');
});
