import assert from 'node:assert/strict';
import test from 'node:test';
import { CONFIG } from '../src/config.ts';
import { prepareTerrain } from '../src/navigation.ts';
import { BattleSimulation } from '../src/simulation.ts';
import { Terrain } from '../src/terrain.ts';
import { DEFAULT_TUNING } from '../src/tuning.ts';
import { Maneuver, TRUCK } from '../src/vehicle-types.ts';

function fixture(terrain?: Terrain) {
  const sim = new BattleSimulation(0, 17, 32, { ...DEFAULT_TUNING, speed: 0.2 }, terrain);
  sim.weaponsEnabled = false;
  const driver = sim.spawn(0, 0, 0);
  assert.ok(driver);
  assert.ok(sim.spawn(1, -15, 10));
  sim.queue({ type: 'deployTrucks', teams: 1, x: 0, z: 0, radius: 1 });
  sim.flushCommands();
  const fleet = sim.vehicles, truck = fleet.active[0];
  fleet.exitLeft[truck] = 0;
  fleet.desiredSpeed[truck] = 0;
  fleet.mode[truck] = Maneuver.Approach;
  fleet.due[truck] = 0;
  return { sim, fleet, truck, driver };
}

function step(sim: BattleSimulation, ticks: number) {
  for (let n = 0; n < ticks; n++) sim.step();
}

test('the trace flags a crewed truck waiting for pickup and preserves the stop when it is destroyed', () => {
  const { sim, fleet, truck, driver } = fixture();
  const recruit = sim.spawn(0, 4, 0);
  assert.ok(recruit);
  const trace = fleet.startTrace();
  step(sim, 119);
  assert.deepEqual(trace.report().stoppedTruckIds, []);
  step(sim, 1);
  const report = trace.report(), [entry] = report.trucks;
  assert.equal(report.outcome, 'running');
  assert.deepEqual(report.stoppedTruckIds, [fleet.id[truck]]);
  assert.equal(entry.snapshot!.crew.driver, driver);
  assert.equal(entry.snapshot!.activity, 'waiting-for-pickup');
  assert.ok(entry.snapshot!.reservations.some(r => r.soldierId === recruit));
  assert.equal(entry.lastStop!.detectedTick - entry.lastStop!.sinceTick, 120);
  assert.ok(entry.lastStop!.preceding.some(e => e.kind === 'decision' && e.outcome === 'pickup'));

  fleet.damage(fleet.id[truck], fleet.hp[truck]);
  const archived = fleet.stopTrace()!;
  assert.equal(fleet.trace, null);
  assert.deepEqual(archived.stoppedTruckIds, []);
  assert.equal(archived.trucks[0].active, false);
  assert.equal(archived.trucks[0].lastStop!.endedBy, 'destroyed');
  assert.equal(report.trucks[0].lastStop!.endedTick, null, 'exported reports are snapshots');
});

test('after contact with a rock or map edge, the trace explains the rejected plan and the truck backs out', () => {
  for (const kind of ['map-edge', 'rock'] as const) {
    function run(record: boolean) {
      const terrain = kind === 'rock' ? new Terrain(28, 34, 0, [{ x: 4, z: 0, radius: 1, base: 0, height: 2, angle: 0 }]) : undefined;
      terrain?.rebuild();
      const { sim, fleet, truck } = fixture(terrain);
      const start = kind === 'rock' ? 1.5 : fleet.grid.halfWidth - TRUCK.reach - 0.35;
      fleet.setPose(truck, start, 0, Math.PI / 2);
      fleet.desiredYaw[truck] = fleet.yaw[truck];
      fleet.desiredSpeed[truck] = 3.8;
      fleet.due[truck] = Infinity;
      if (record) fleet.startTrace();
      step(sim, 85);
      return { x: fleet.x[truck], z: fleet.z[truck], contacts: fleet.metrics.contacts, report: fleet.stopTrace() };
    }

    const { x, z, contacts, report } = run(true);
    assert.deepEqual({ x, z, contacts, report: null }, run(false), 'recording does not affect driving');
    const [entry] = report!.trucks;
    const contact = entry.events.find(e => e.kind === 'contact' && e.blocker.kind === kind);
    assert.ok(contact?.kind === 'contact');
    if (kind === 'rock') assert.equal(contact.blocker.id, 0);
    const decision = entry.events.find(e => e.kind === 'decision' && e.outcome === 'fallback-reverse');
    assert.ok(decision?.kind === 'decision');
    assert.ok(decision.checks.some(c => c.score === null && c.blockedBy?.blocker.kind === kind && c.blockedBy.blocker.atStart && c.blockedBy.blocker.padding > 0));
    assert.deepEqual(decision.recovery, [{ direction: 'reverse', blockedBy: null }]);
    assert.ok(x < contact.x - 0.6);
    assert.deepEqual(report!.stoppedTruckIds, []);
  }
});

test('a truck can pull forward if its rear is against the map edge', () => {
  const { sim, fleet, truck } = fixture();
  const x = fleet.grid.halfWidth - TRUCK.reach - 0.005;
  fleet.setPose(truck, x, 0, -Math.PI / 2);
  const trace = fleet.startTrace();
  step(sim, 35);
  assert.ok(fleet.x[truck] < x - 0.6);
  const decision = trace.report().trucks[0].events.find(e => e.kind === 'decision');
  assert.ok(decision?.kind === 'decision');
  assert.equal(decision.outcome, 'fallback-forward');
  assert.equal(decision.recovery[0].direction, 'reverse');
  assert.equal(decision.recovery[0].blockedBy!.blocker.kind, 'map-edge');
  assert.deepEqual(decision.recovery[1], { direction: 'forward', blockedBy: null });
});

test('a truck can steer in reverse when the same rock blocks both straight recoveries', () => {
  // A canyon rock met with the front corner while turning (a pose taken from a full canyon battle).
  const seed = 74319;
  const tuning = { ...DEFAULT_TUNING, count: 20, columns: 5, seed };
  const { terrain, navigation } = prepareTerrain(tuning, seed, 'canyon');
  const sim = new BattleSimulation(0, seed, 64, tuning, terrain, navigation);
  sim.weaponsEnabled = false;
  assert.ok(sim.spawn(0, -6.5, -13.5));
  assert.ok(sim.spawn(1, 6, 12));
  sim.queue({ type: 'deployTrucks', teams: 1, x: -6.5, z: -13.5, radius: 1 });
  sim.flushCommands();
  const fleet = sim.vehicles, v = fleet.active[0];
  assert.equal(fleet.count, 1);
  fleet.exitLeft[v] = 0;
  fleet.setPose(v, -6.098, -11.514, 0.637);
  fleet.previousX[v] = fleet.x[v]; fleet.previousZ[v] = fleet.z[v];
  fleet.vx[v] = 1.93; fleet.vz[v] = 3.8; fleet.desiredYaw[v] = 0.66; fleet.desiredSpeed[v] = 7.88;
  fleet.mode[v] = Maneuver.Approach; fleet.due[v] = fleet.committedUntil[v] = Infinity;
  const trace = fleet.startTrace();
  step(sim, 60);

  const [truck] = trace.report().trucks;
  assert.ok(truck?.snapshot);
  const contact = truck.events.find(event => event.kind === 'contact' && event.blocker.kind === 'rock' && event.blocker.id === 12);
  const decision = truck.events.find(event => event.kind === 'decision' && event.recovery.some(check => check.steering && !check.blockedBy));
  assert.ok(contact);
  assert.ok(decision?.kind === 'decision');
  assert.equal(decision.outcome, 'fallback-reverse');
  assert.deepEqual(decision.recovery.slice(0, 2).map(check => [check.direction, check.blockedBy?.blocker.id]), [
    ['reverse', 12], ['forward', 12],
  ]);
  assert.ok(Math.hypot(truck.snapshot.x - contact.x, truck.snapshot.z - contact.z) > 0.85);
  assert.equal(truck.events.some(event => event.kind === 'contact' && event.tick > decision.tick), false);
});

test('the trace totals routing work: plans by route state, truck graph builds and field sweeps', () => {
  const terrain = new Terrain(20, 20, 0, [{ x: 0, z: 6, radius: 1.5, base: 0, height: 3, angle: 0 }]);
  terrain.rebuild();
  const { sim, fleet, truck } = fixture(terrain);
  // A tough enemy keeps the battle running after the truck reaches it.
  for (let i = 0; i < sim.used; i++) if (sim.team[i] === 1) sim.hp[i] = 1e6;
  const trace = fleet.startTrace();
  step(sim, 240);
  const { routing } = trace.report(), m = fleet.metrics;
  assert.equal(routing.graphBuilds, 1);
  assert.ok(routing.graphBuildMs > 0);
  assert.ok(routing.queries > 0);
  // Every plan is counted exactly once: aimed along the field, straight, or a fallback.
  const fallbacks = Object.values(routing.fallbacks).reduce((a, b) => a + b, 0);
  assert.equal(routing.route + routing.straight + fallbacks, routing.queries);
  assert.ok(routing.route + routing.straight > 0);
  assert.ok(routing.fieldFullSweeps + routing.fieldEarlyStops > 0);
  assert.ok(routing.peakFieldExpansions <= 512 && routing.fieldExpansions >= routing.peakFieldExpansions);
  sim.tuning.truckPathing = 0;
  const before = m.fallbackDisabled;
  fleet.due[truck] = fleet.committedUntil[truck] = 0;
  step(sim, 2);
  assert.ok(m.fallbackDisabled > before);
});
