import test from 'node:test';
import assert from 'node:assert/strict';
import { BattleSimulation } from '../src/simulation.ts';
import { CONFIG } from '../src/config.ts';
import { DEFAULT_TUNING } from '../src/tuning.ts';
import { defaultEquipment } from '../src/equipment.ts';
import { prepareTerrain } from '../src/navigation.ts';
import { ReplayPlayer, ReplayRecorder, stateHash, validReplay, type ReplayHeader } from '../src/replay.ts';
import { WEAPON_ID } from '../src/config.ts';

function battle(tuning = { ...DEFAULT_TUNING, count: 60, columns: 8 }, terrainSeed = 7) {
  const { terrain, navigation } = prepareTerrain(tuning, terrainSeed);
  return new BattleSimulation(tuning.count, tuning.seed, CONFIG.capacity, tuning, terrain, navigation, defaultEquipment());
}

test('a recorded battle plays back identically, including paused flushes and live tuning', () => {
  const tuning = { ...DEFAULT_TUNING, count: 60, columns: 8 };
  const live = battle(tuning);
  const header: ReplayHeader = { version: 1, perTeam: 60, seed: tuning.seed, terrainSeed: 7, flat: false, tuning: { ...tuning }, equipment: defaultEquipment(), roster: '', recordedAt: '', screen: { width: 1, height: 1 } };
  const recorder = new ReplayRecorder(header, live);
  for (let t = 0; t < 900; t++) {
    if (t === 120) live.queue({ type: 'explode', x: 0, y: 0, z: 0, radius: 6, damage: 40, impulse: 8 });
    if (t === 200) { live.queue({ type: 'upgradeArea', team: 0, x: 0, z: 10, radius: 30, weapon: WEAPON_ID.rocket }); live.flushCommands(); }
    if (t === 300) live.applyLiveTuning({ ...live.tuning, speed: live.tuning.speed * 1.5 });
    if (t === 400) recorder.tap('battlefield', 0.5, 0.5);
    live.step();
  }
  const replay = JSON.parse(JSON.stringify(recorder.finish()));
  assert.ok(validReplay(replay));

  const taps: string[] = [];
  const copy = battle(tuning), player = new ReplayPlayer(replay, copy, tap => taps.push(tap.label));
  copy.queue({ type: 'explode', x: 0, y: 0, z: 0, radius: 50, damage: 999, impulse: 1 }); // a viewer click must be ignored
  while (copy.tick < replay.endTick) copy.step();
  player.feed();
  assert.equal(player.desyncTick, null);
  assert.equal(player.checkedHashes, 15);
  assert.equal(stateHash(copy), stateHash(live));
  assert.deepEqual(taps, ['battlefield']);
  assert.ok(player.finished);
});

test('playback flags the first tick where the battle drifts', () => {
  const live = battle();
  const header = { version: 1 } as ReplayHeader;
  const recorder = new ReplayRecorder(header, live);
  for (let t = 0; t < 240; t++) live.step();
  const copy = battle(), player = new ReplayPlayer(recorder.finish(), copy, () => {});
  for (let t = 0; t < 90; t++) copy.step();
  copy.hp[0] = 1; // something the recording never saw
  while (copy.tick < 240) copy.step();
  assert.equal(player.desyncTick, 120);
});
