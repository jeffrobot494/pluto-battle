import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { CONFIG, WEAPON_ID } from '../src/config.ts';
import { CorpseRenderer } from '../src/corpse-renderer.ts';
import { BattleSimulation } from '../src/simulation.ts';

test('retirement captures a corpse before a queued spawn reuses its slot', () => {
  const sim = new BattleSimulation(0, 9, 2);
  sim.tuning.speed = 0;
  const fallen = sim.spawn(0, 1, 0, WEAPON_ID.sniper)!;
  sim.spawn(1, 10, 10);
  sim.damage(fallen, 100);
  // Arrange for the spawn to run on the first tick after expiry, before body integration.
  sim.time = CONFIG.corpseLifetime;
  sim.queue({ type: 'spawn', team: 0, x: -5, z: 0 });
  sim.step();
  assert.equal(sim.rejectedSpawns, 0);
  assert.equal(sim.byId.has(fallen), false);
  assert.equal(sim.x[0], -5);
  assert.equal(sim.retiredCorpseCount, 1);
  assert.deepEqual(sim.retiredCorpses[0], {
    id: fallen, at: CONFIG.corpseLifetime, x: 1, y: 0, z: 0, velocityY: 0,
    yaw: Math.fround(Math.PI), aimPitch: 0, radius: Math.fround(CONFIG.soldier.radius),
    team: 0, weapon: WEAPON_ID.sniper,
  });
});

test('retained poses land, stop uploading, survive hide and show, and wrap the archive', () => {
  const sim = new BattleSimulation(0, 9, 2);
  sim.tuning.speed = 0;
  const scene = new THREE.Scene();
  const geometry = new THREE.BoxGeometry(), material = new THREE.MeshStandardMaterial();
  const source = new THREE.InstancedMesh(geometry, material, 1);
  const colors = [new THREE.Color('black'), new THREE.Color('brown')];
  const corpses = new CorpseRenderer(scene, { bodies: source, guns: source, visors: source, shadows: source }, colors, colors);
  const mesh = scene.getObjectByName('Retained corpses') as THREE.InstancedMesh;
  const matrix = new THREE.Matrix4();
  try {
    const fallen = sim.spawn(0, 1, 0)!;
    sim.spawn(1, 10, 10);
    sim.tuning.gravity = 0;
    sim.y[0] = 7;
    sim.damage(fallen, 100);
    sim.time = CONFIG.corpseLifetime;
    sim.step();
    assert.equal(corpses.update(sim, sim.time), 0);
    assert.equal(mesh.visible, false);

    sim.tuning.keepCorpses = 1;
    assert.equal(corpses.update(sim, sim.time), 1);
    mesh.getMatrixAt(0, matrix);
    assert.ok(matrix.elements[13] > 7);
    const airborneVersion = mesh.instanceMatrix.version;
    corpses.update(sim, sim.time);
    assert.equal(mesh.instanceMatrix.version, airborneVersion);

    corpses.update(sim, sim.time + 2);
    mesh.getMatrixAt(0, matrix);
    assert.ok(Math.abs(matrix.elements[13] - CONFIG.soldier.radius) < 1e-6);
    const settledVersion = mesh.instanceMatrix.version;
    sim.tuning.keepCorpses = 0;
    corpses.update(sim, sim.time + 3);
    assert.equal(mesh.visible, false);
    sim.tuning.keepCorpses = 1;
    corpses.update(sim, sim.time + 4);
    assert.equal(mesh.visible, true);
    assert.equal(mesh.instanceMatrix.version, settledVersion);

    for (let n = 0; n < CONFIG.retainedCorpses; n++) {
      const id = sim.spawn(0, -5, 0)!;
      sim.damage(id, 100);
      sim.time += CONFIG.corpseLifetime + CONFIG.step;
      sim.step();
    }
    assert.equal(sim.retiredCorpseCount, CONFIG.retainedCorpses + 1);
    assert.equal(sim.retiredCorpses.some(corpse => corpse.id === fallen), false);
    assert.equal(corpses.update(sim, sim.time), CONFIG.retainedCorpses);
    assert.equal(mesh.count, CONFIG.retainedCorpses);
    mesh.getMatrixAt(0, matrix);
    assert.equal(matrix.elements[12], -5);
  } finally {
    corpses.dispose();
    source.dispose();
    geometry.dispose();
    material.dispose();
  }
});
