import assert from 'node:assert/strict';
import test from 'node:test';
import { CONFIG, NO_WEAPON, WEAPON_ID } from '../src/config.ts';
import { BattleSimulation } from '../src/simulation.ts';
import { Terrain } from '../src/terrain.ts';
import { DEFAULT_TUNING, effectiveTurretRange, loadTuning, type TuningValues } from '../src/tuning.ts';
import { writeSetting } from '../src/settings-store.ts';
import { DRIVER, GUNNER, Maneuver, PASSENGER, SEAT_COUNT, TRUCK } from '../src/vehicle-types.ts';
import { ROUTE_STATES } from '../src/truck-tactics.ts';

function battle(changes: Partial<TuningValues> = {}, terrain?: Terrain) {
  const sim = new BattleSimulation(0, 27, 128, { ...DEFAULT_TUNING, speed: 0.2, ...changes }, terrain);
  sim.weaponsEnabled = false;
  return sim;
}
function spawn(sim: BattleSimulation, team: 0 | 1, x: number, z: number, weapon = WEAPON_ID.rifle as number) {
  const id = sim.spawn(team, x, z, weapon);
  assert.notEqual(id, null, `valid spawn at ${x}, ${z}`);
  return sim.byId.get(id!)!;
}
function paint(sim: BattleSimulation, x = 0, z = 0, radius = 3, teams = 1, flush = true, solo = false) {
  sim.queue({ type: 'deployTrucks', x, z, radius, teams, solo });
  if (flush) sim.flushCommands();
}
function tick(sim: BattleSimulation, count = 1) { for (let n = 0; n < count; n++) sim.step(); }
function active(sim: BattleSimulation) { return Array.from(sim.vehicles.active.subarray(0, sim.vehicles.count)); }
function parked(sim: BattleSimulation, v: number, x = sim.vehicles.x[v], z = sim.vehicles.z[v], yaw = sim.vehicles.yaw[v]) {
  const f = sim.vehicles;
  f.setPose(v, x, z, yaw);
  f.vx[v] = f.vz[v] = f.exitLeft[v] = f.desiredSpeed[v] = 0;
  f.desiredYaw[v] = yaw; f.due[v] = Infinity;
}
function crew(sim: BattleSimulation, team: 0 | 1 = 0, x = 0, z = 0) {
  const slots = [spawn(sim, team, x - 0.75, z), spawn(sim, team, x + 0.75, z), spawn(sim, team, x, z - 0.68)];
  paint(sim, x, z, 1.1, 1 << team);
  assert.ok(slots.every(i => sim.vehicles.ride[i] >= 0));
  return sim.vehicles.ride[slots[0]];
}

test('a paused paint snapshots on dispatch, groups 7 as 3 + 3 + 1 and boards only its own army', () => {
  const run = () => {
    const sim = battle(), f = sim.vehicles;
    for (let i = 0; i < 6; i++) spawn(sim, 0, i % 3 - 1, 0.95 * Math.floor(i / 3));
    spawn(sim, 1, 2.9, -0.4);
    paint(sim, 0, 0, 6, 1, false);
    const late = spawn(sim, 0, 0, -0.94);
    assert.equal(f.count, 0);
    sim.flushCommands();
    tick(sim, 360);
    const sizes = active(sim).map(v => [0, 1, 2].filter(r => f.seat(v, r) >= 0).length);
    assert.deepEqual(sizes.sort(), [1, 3, 3]); assert.equal(f.lastDeployment?.boarded, 7);
    assert.equal(f.lastDeployment?.onFoot, 0); assert.ok(f.ride[late] >= 0); assert.equal(f.ride[6], -1);
    return active(sim).map(v => [f.id[v], f.x[v], f.z[v], ...[0, 1, 2].map(r => f.seat(v, r))]);
  };
  assert.deepEqual(run(), run());
});

test('one BOTH paint keeps armies separate, and overlapping paused releases cannot double-book pending seats', () => {
  const sim = battle(), f = sim.vehicles;
  for (let i = 0; i < 24; i++) spawn(sim, (i % 2) as 0 | 1, -24 + 2.08 * i, i % 2 ? 7 : -7);
  paint(sim, 0, 0, 100, 3, false, true);
  paint(sim, 0, 0, 100, 3, false, true);
  sim.flushCommands();
  assert.equal(sim.tick, 0); assert.equal(f.count, 16); assert.equal(f.pendingCrews, 8);
  assert.equal(f.metrics.painted, 24); assert.ok(active(sim).every(v => f.speed(v) === 0));
  sim.flushCommands(); assert.equal(f.count, 16, 'a paused flush without a new paint does not advance placement');
  tick(sim, 10);
  assert.equal(f.count, 24); assert.equal(f.lastDeployment?.boarded, 24);
  for (const v of active(sim)) assert.equal(f.team[v], sim.team[f.seat(v, DRIVER)]);
  assert.ok(active(sim).some(v => f.speed(v) > 0), 'drivers pull away on resume');
});

test('blocked crews stay on foot, retry atomically when a lane opens, and report the actual deadline result', () => {
  const build = () => {
    const sim = battle({ truckPlacementDistance: 0.5, truckPlacementRetry: 0.5 }), driver = spawn(sim, 0, 0, 0);
    const ring = Array.from({ length: 10 }, (_, n) => spawn(sim, 1, Math.sin(n * Math.PI / 5) * 1.10, Math.cos(n * Math.PI / 5) * 1.10));
    spawn(sim, 1, 20, -20);
    paint(sim, 0, 0, 0.25);
    assert.equal(sim.vehicles.count, 0); assert.equal(sim.vehicles.ride[driver], -1);
    return { sim, driver, ring };
  };
  const blocked = build(); tick(blocked.sim, 40);
  assert.deepEqual(blocked.sim.vehicles.lastDeployment, { id: 1, selected: 1, boarded: 0, onFoot: 1, trucks: 0 });
  const open = build();
  for (const i of open.ring) open.sim.damage(open.sim.id[i], 100);
  tick(open.sim, 16);
  assert.ok(open.sim.vehicles.ride[open.driver] >= 0);
  assert.equal(open.sim.vehicles.lastDeployment?.boarded, 1);
});

test('crew armor and promotion preserve the turret; nearby infantry can replace a dead driver', () => {
  const sim = battle({ speed: 3 }), f = sim.vehicles, v = crew(sim);
  const driver = f.seat(v, DRIVER), gunner = f.seat(v, GUNNER), passenger = f.seat(v, PASSENGER);
  spawn(sim, 1, 20, -20);
  parked(sim, v, 0, 0, 0);
  sim.damage(sim.id[passenger], 50);
  assert.ok(Math.abs(sim.hp[passenger] - (100 - 50 * (1 - sim.tuning.truckCrewArmor))) < 0.001);
  sim.damage(sim.id[driver], 1000);
  assert.equal(f.seat(v, DRIVER), passenger); assert.equal(f.seat(v, GUNNER), gunner); assert.equal(f.ride[driver], -1);
  sim.damage(sim.id[passenger], 1000);
  assert.equal(f.seat(v, DRIVER), gunner); assert.equal(f.seat(v, GUNNER), -1);
  sim.damage(sim.id[gunner], 1000);
  const recruit = spawn(sim, 0, -3.1, 0);
  f.vz[v] = 2.4;
  tick(sim, 72);
  assert.equal(f.seat(v, DRIVER), recruit); assert.equal(f.reservedVehicle[recruit], -1);
});

test('the turret fires past rifle range, owns its cooldown, and holds fire behind an ally', () => {
  const sim = battle(), f = sim.vehicles, v = crew(sim);
  parked(sim, v, 0, 0, 0);
  const target = spawn(sim, 1, 0, 13);
  const ally = spawn(sim, 0, 0, 5);
  sim.inventory[ally] = sim.inventory[target] = 0; sim.weapon[ally] = sim.weapon[target] = NO_WEAPON;
  sim.weaponsEnabled = true; f.nextTurretShot[v] = 0;
  const gunner = f.seat(v, GUNNER), driver = f.seat(v, DRIVER);
  sim.inventory[driver] |= 1 << WEAPON_ID.sniper;
  tick(sim, 20);
  assert.equal(sim.hp[target], 100); assert.equal(f.metrics.shots, 0);
  sim.damage(sim.id[ally], 100);
  for (let n = 0; n < 35 && f.metrics.shots === 0; n++) tick(sim);
  assert.equal(sim.hp[target], 100 - sim.tuning.turretDamage); assert.equal(sim.lastFire[driver], -Infinity);
  assert.ok(sim.lastFire[gunner] > 0);
  tick(sim, Math.floor(sim.tuning.turretInterval / CONFIG.step) - 1);
  assert.equal(f.metrics.shots, 1, 'mounted shot interval is independent of the gunner’s inventory');
});

test('enemy hulls take the first valid beam hit and stop rockets before the soldiers behind them', () => {
  const sim = battle({ rocketRadius: 0.55 }), f = sim.vehicles;
  const gun = spawn(sim, 0, 0, -6), target = spawn(sim, 1, 0, 4);
  const v = crew(sim, 1, 3, 0); parked(sim, v, 0, 0, 0);
  sim.target[gun] = sim.id[target]; sim.nextFire.fill(1000); sim.nextFire[gun] = 0;
  f.nextTurretShot[v] = 1000; sim.weaponsEnabled = true;
  tick(sim);
  const afterRifle = sim.tuning.truckHealth - sim.rifle.damage;
  assert.equal(f.hp[v], afterRifle); assert.equal(sim.hp[target], 100);
  sim.weaponsEnabled = false;
  assert.ok(sim.rockets.add(0, 0.38, -2, 0, 0, 1, 12, true, sim.id[gun], 0));
  tick(sim, 10);
  assert.equal(sim.rockets.count, 0); assert.equal(sim.totalExplosions, 1);
  assert.equal(f.hp[v], afterRifle - sim.tuning.rocketDamage);
  assert.ok(sim.explosions.z[0] < 0, 'impact lies on the near side of the hull');
});

test('live weapon ranges stay ordered for active trucks; legacy conflicts still allow infantry combat', () => {
  writeSetting('pluto-battle-tuning-v1', JSON.stringify({ range: 18, rocketRange: 16 }));
  const saved = loadTuning();
  assert.equal(saved.truckHealth, DEFAULT_TUNING.truckHealth);
  const legacy = battle(saved);
  const driver = spawn(legacy, 0, 0, 0);
  spawn(legacy, 1, 0, -20);
  paint(legacy);
  assert.equal(legacy.vehicles.ride[driver], -1);
  assert.equal(legacy.rifle.range, 18);
  const sim = battle(); crew(sim);
  sim.applyLiveTuning(saved);
  assert.equal(sim.rifle.range, DEFAULT_TUNING.range);
  sim.applyLiveTuning({ ...saved, rocketRange: 23, turretRangePosition: 99 });
  assert.ok(sim.rifle.range < sim.vehicles.range! && sim.vehicles.range! < sim.rocket.range);
  assert.equal(effectiveTurretRange(saved), null);
});

test('ram damage scales with normal closing speed on both armies; one hit lasts until separation', () => {
  const hit = (speed: number, team: 0 | 1) => {
    const sim = battle({ truckSpeed: 24, truckRamDamage: 4, truckRamImpulse: 0, truckImpactLoss: 0.2 }), f = sim.vehicles;
    spawn(sim, 0, 0, 0); spawn(sim, 1, 20, 20); paint(sim);
    const v = active(sim)[0];
    parked(sim, v, 0, 0, 0);
    const victim = spawn(sim, team, 0, TRUCK.reach + sim.tuning.radius + 0.055);
    f.desiredSpeed[v] = f.vz[v] = speed; f.mode[v] = Maneuver.Ram;
    tick(sim, speed < 4.5 ? 10 : 1);
    const health = sim.hp[victim];
    if (speed >= 4.5) {
      assert.equal(f.metrics.rams, 1); assert.ok(f.speed(v) < speed);
      assert.ok(f.z[v] < sim.z[victim] - TRUCK.reach, 'swept footprint stops at contact');
      tick(sim, 3);
      assert.equal(f.metrics.rams, 1);
    }
    return 100 - health;
  };
  assert.equal(hit(3, 1), 0);
  assert.ok(hit(24, 1) > hit(9, 1));
  assert.ok(hit(24, 0) > 0);
});

test('the footprint sweeps thin rocks and other trucks at top speed, and a parked hull blocks foot spawns', () => {
  const terrain = new Terrain(28, 34, 0, [{ x: 0, z: 1.18, base: 0, height: 0.9, radius: 0.07, angle: 0 }]);
  terrain.rebuild();
  const sim = battle({ truckSpeed: 24 }, terrain), f = sim.vehicles;
  spawn(sim, 0, -4, 0); spawn(sim, 1, 4, 0); paint(sim, 0, 0, 10, 3);
  assert.equal(f.count, 2);
  const [a, b] = active(sim);
  parked(sim, a, 0, 0, 0); parked(sim, b, 6, 3, 0);
  f.desiredSpeed[a] = f.vz[a] = 24; tick(sim);
  assert.ok(f.z[a] < 0.21); assert.ok(f.speed(a) < 24);
  parked(sim, a, 6, 1, 0);
  assert.equal(sim.spawn(0, 6, 3), null);
  f.desiredSpeed[a] = f.vz[a] = 24; tick(sim);
  assert.ok(f.z[a] <= 3 - 2 * TRUCK.reach);
  parked(sim, a, 6, 34 - TRUCK.reach - 0.09, 0);
  f.desiredSpeed[a] = f.vz[a] = 24; tick(sim);
  assert.ok(f.z[a] <= 34 - TRUCK.reach);
});

test('destruction damages each former rider exactly once and survivors land on foot', () => {
  const sim = battle(), f = sim.vehicles, v = crew(sim), id = f.id[v];
  const riders = Array.from({ length: SEAT_COUNT }, (_, r) => f.seat(v, r));
  spawn(sim, 1, 0, 24);
  f.damage(id, 1000); assert.equal(f.count, 0); assert.ok(!f.byId.has(id));
  tick(sim);
  assert.equal(sim.totalExplosions, 1);
  for (const i of riders) {
    assert.equal(sim.hp[i], 100 - sim.tuning.truckBlastDamage);
    assert.equal(f.ride[i], -1); assert.equal(sim.grounded[i], 0); assert.ok(sim.velocityY[i] > 0);
  }
  f.damage(id, 1000); tick(sim, 130);
  assert.equal(sim.totalExplosions, 1); assert.ok(riders.every(i => sim.grounded[i]));
});

test('ejected riders wait to use their personal weapons until they land', () => {
  const sim = battle({ truckBlastRadius: 0.6 }), f = sim.vehicles, v = crew(sim);
  const riders = [f.seat(v, DRIVER), f.seat(v, GUNNER), f.seat(v, PASSENGER)];
  const target = spawn(sim, 1, 0, 7);
  sim.inventory[target] = 0; sim.hp[target] = 1000;
  f.damage(f.id[v], 1000); tick(sim);
  sim.weaponsEnabled = true; sim.friendlyBlocking = false;
  tick(sim, 30);
  assert.ok(riders.every(i => !sim.grounded[i]));
  assert.equal(sim.totalShots, 0);
  tick(sim, 130);
  assert.ok(riders.every(i => sim.grounded[i]));
  assert.ok(sim.totalShots > 0);
});

test('chain blasts cross a tick budget before the final outcome settles', () => {
  const sim = battle({ truckHealth: 40, truckBlastDamage: 110, truckBlastRadius: 1.8, truckBlastImpulse: 0 }), f = sim.vehicles;
  for (let n = 0; n < 11; n++) {
    const x = n * 2.1 - 11, team = n === 0 ? 1 : 0;
    spawn(sim, team, x, 0); paint(sim, x, 0, 0.2, 1 << team);
  }
  const trucks = active(sim).sort((a, b) => f.x[a] - f.x[b]);
  assert.equal(trucks.length, 11);
  trucks.forEach((v, n) => parked(sim, v, n * 1.51 - 8, 0, 0));
  f.damage(f.id[trucks[0]], 40);
  tick(sim);
  assert.equal(sim.totalExplosions, 8); assert.equal(sim.result, 'running'); assert.equal(f.pendingDestructions, 1);
  tick(sim);
  assert.equal(sim.totalExplosions, 11); assert.equal(f.count, 0); assert.equal(sim.result, 'draw');
});

test('blocked driver requests get priority within the shared budget and older requests are still served', () => {
  const sim = battle({ truckDecisionsPerTick: 1 }), f = sim.vehicles;
  for (let n = 0; n < 5; n++) spawn(sim, 0, n * 4 - 8, 0);
  spawn(sim, 1, 0, 24);
  paint(sim, 0, 0, 12, 1, true, true);
  const trucks = active(sim);
  assert.equal(trucks.length, 5);
  for (const v of trucks) { parked(sim, v); f.due[v] = 0; }
  const urgent = trucks[4]; f.requestRecovery(urgent);
  tick(sim);
  assert.equal(f.metrics.decisions, 1); assert.ok(f.due[urgent] > sim.time);
  tick(sim, 4);
  assert.equal(f.metrics.decisions, 5); assert.ok(trucks.every(v => f.due[v] > sim.time));
});

test('drivers take a firing pass around scattered groups and can choose a ram with a working turret', () => {
  const encounter = (aggression: number, distance: number, scattered: boolean) => {
    const sim = battle({ truckRamAggression: aggression, truckCrewArmor: 0.85 }), f = sim.vehicles, v = crew(sim);
    for (const [x, z] of [[0, distance], [1.2, distance], [0, distance + 1.25], ...(scattered ? [[7, 10], [9, 10], [-10, 15], [-12, 15]] : [])]) {
      const i = spawn(sim, 1, x, z);
      sim.inventory[i] = 0; sim.hp[i] = 1000;
    }
    parked(sim, v, 0, 0, 0);
    f.due[v] = 0; sim.weaponsEnabled = true;
    const modes = new Set<number>();
    for (let n = 0; n < 250; n++) { tick(sim); modes.add(f.mode[v]); }
    assert.ok(f.metrics.shots > 0);
    return { modes, rams: f.metrics.rams, traveled: Math.hypot(f.x[v], f.z[v]) };
  };
  const pass = encounter(0, 14, true);
  assert.ok(pass.modes.has(Maneuver.Pass)); assert.ok(pass.traveled > 3); assert.equal(pass.rams, 0);
  const charge = encounter(3.4, 7, false);
  assert.ok(charge.modes.has(Maneuver.Ram)); assert.ok(charge.rams > 0);
});

test('drivers go around a friendly firing line, including when terrain closes one flank', () => {
  for (const rocky of [false, true]) {
    const terrain = rocky ? new Terrain(28, 34, 0, [{ x: -4, z: 0.45, base: 0, height: 3, radius: 2.3, angle: 0 }]) : undefined;
    terrain?.rebuild();
    const sim = battle({ truckRecruitRadius: 0.5, truckRamAggression: 0 }, terrain);
    const f = sim.vehicles;
    if (rocky) crew(sim);
    else { spawn(sim, 0, 0, 0); paint(sim, 0, 0, 1); }
    const v = active(sim)[0];
    parked(sim, v, 0, 0, 0);
    f.due[v] = 0;

    // Snipers hold their ranks in range. Suppress infantry fire so the line stays intact.
    for (let row = 0; row < 2; row++) for (let col = -7; col <= 7; col++) {
      spawn(sim, 0, col * 0.72, 3.2 + row * 0.72, WEAPON_ID.sniper);
    }
    const enemy = spawn(sim, 1, 0, 18, WEAPON_ID.sniper);
    sim.hp[enemy] = 1000;
    sim.weaponsEnabled = true;
    sim.nextFire.fill(Infinity);

    for (let n = 0; n < 240 && f.z[v] < 5.1; n++) tick(sim);
    assert.ok(f.z[v] >= 5.1, 'cleared the infantry ranks within four seconds');
    assert.ok(rocky ? f.x[v] > 5.5 : Math.abs(f.x[v]) > 5.5, 'used an open flank');
    assert.equal(f.metrics.contacts, 0);
  }
});

test('an expired recruitment reservation frees both the rider and the seat', () => {
  const sim = battle({ truckReservationTime: 0.5 }), f = sim.vehicles, driver = spawn(sim, 0, 0, 0);
  paint(sim, 0, 0, 0.25);
  const v = f.ride[driver];
  parked(sim, v, 0, 0, 0);
  const recruit = spawn(sim, 0, 4, 0);
  spawn(sim, 1, 0, -20);
  sim.damage(sim.id[driver], 1000); f.due[v] = 0;
  tick(sim);
  assert.equal(f.reservation(v, DRIVER), recruit); assert.equal(f.reservedVehicle[recruit], v);
  tick(sim, 33);
  assert.equal(f.reservation(v, DRIVER), -1); assert.equal(f.reservedVehicle[recruit], -1); assert.equal(f.seat(v, DRIVER), -1);
});

const wallRock = (height = 3) => ([x, z]: number[]) => ({ x, z, radius: 1.1, base: 0, height, angle: 0 });
function rockLine(x0: number, z0: number, x1: number, z1: number) {
  const n = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 1.3);
  return Array.from({ length: n + 1 }, (_, k) => [x0 + (x1 - x0) * k / n, z0 + (z1 - z0) * k / n]);
}
function rockRing(x: number, z: number, radius: number, count: number) {
  return Array.from({ length: count }, (_, k) => [x + Math.sin(k * 2 * Math.PI / count) * radius, z + Math.cos(k * 2 * Math.PI / count) * radius]);
}
/** One crewed truck at `start` against tough, unarmed enemies: its closest approach, end, trail and route states seen. */
function routeRun(rocks: ReturnType<ReturnType<typeof wallRock>>[], changes: Partial<TuningValues>, start: number[], enemies: number[][], ticks: number, traced = false) {
  const terrain = new Terrain(28, 34, 0, rocks);
  terrain.rebuild();
  const sim = battle({ truckRamAggression: 0, ...changes }, terrain), f = sim.vehicles, v = crew(sim, 0, start[0], start[1]);
  const foes = enemies.map(([x, z]) => { const i = spawn(sim, 1, x, z); sim.hp[i] = 1e6; return i; });
  const trace = traced ? f.startTrace() : null;
  const states = new Set<string>(), trail: number[] = [];
  let closest = Infinity;
  for (let n = 0; n < ticks; n++) {
    tick(sim);
    closest = Math.min(closest, Math.hypot(f.x[v] - sim.x[foes[0]], f.z[v] - sim.z[foes[0]]));
    states.add(ROUTE_STATES[f.tactics.routeState[v]]); trail.push(f.x[v], f.z[v], f.yaw[v]);
  }
  return { sim, v, closest, states, trail, trace, distance: Math.hypot(f.x[v] - sim.x[foes[0]], f.z[v] - sim.z[foes[0]]) };
}

test('drivers follow the truck route out of a U-shaped wall that stops a straight-line driver', () => {
  const cup = [...rockLine(-9, 0, 9, 0), ...rockLine(-9, -1.3, -9, -14), ...rockLine(9, -1.3, 9, -14)].map(wallRock());
  const routed = routeRun(cup, {}, [0, -6], [[0, 18]], 1200, true);
  assert.ok(routed.closest < 6, `reached the enemy behind the cup (${routed.closest.toFixed(1)})`);
  assert.ok(routed.states.has('route') && routed.states.has('straight'), 'routed around the wall, then drove straight');
  const decisions = routed.trace!.report().trucks[0].events.filter(e => e.kind === 'decision');
  const step = decisions.find(e => e.kind === 'decision' && e.route?.state === 'route');
  assert.ok(step && step.kind === 'decision' && step.route!.target && step.route!.fieldDistance! > 0, 'the trace records the route');
  const straight = routeRun(cup, { truckPathing: 0 }, [0, -6], [[0, 18]], 1200);
  assert.ok(straight.closest > 15, 'with pathfinding off the driver stays inside the cup');
  assert.deepEqual([...straight.states].filter(s => s !== 'none'), ['disabled']);
});

test('drivers find a canyon entrance far outside the old search horizon', () => {
  const ridge = [...rockLine(-27, 0, 16, 0), ...rockLine(23, 0, 27, 0)].map(wallRock());
  assert.ok(routeRun(ridge, {}, [0, -6], [[0, 18]], 1500).closest < 6, 'drove through a gap 17 units to the side');
  assert.ok(routeRun(ridge, { truckPathing: 0 }, [0, -6], [[0, 18]], 1500).closest > 15);
});

test('open-field routes are unchanged by the truck route', () => {
  const far = [[-24, 30]].map(wallRock()), foes = [[3, 14], [-2, 16], [8, 20]];
  const on = routeRun(far, {}, [0, -6], foes, 900), off = routeRun(far, { truckPathing: 0 }, [0, -6], foes, 900);
  assert.deepEqual(on.trail, off.trail);
  assert.ok(!on.states.has('route') && on.states.has('straight'));
});

test('an enemy on unreachable ground draws the truck to a firing position at its foot', () => {
  const rim = rockRing(0, 18, 6, 30).map(wallRock(0.5));
  const run = routeRun(rim, {}, [0, -6], [[0, 18]], 1200), f = run.sim.vehicles, nav = f.truckNavigation!;
  assert.ok(run.distance > 7.1 && run.distance < effectiveTurretRange(run.sim.tuning), `holds in turret range outside the rim (${run.distance.toFixed(1)})`);
  assert.ok(Number.isFinite(nav.fields[0].distance[nav.nodeAt(f.x[run.v], f.z[run.v])]), 'the firing cell is on the field');
});

test('each route fallback is reported: disabled, no graph, not ready and unknown cell', () => {
  const flat = battle({ truckRamAggression: 0 }), v = crew(flat, 0, 0, -6);
  spawn(flat, 1, 0, 18); tick(flat, 120);
  assert.equal(ROUTE_STATES[flat.vehicles.tactics.routeState[v]], 'no-graph');
  const box = rockRing(0, -20, 3.2, 16).map(wallRock());
  const boxed = routeRun(box, {}, [0, -20], [[0, 25]], 300);
  assert.ok(boxed.states.has('not-ready'), 'plans while the graph builds fall back');
  assert.equal(ROUTE_STATES[boxed.sim.vehicles.tactics.routeState[boxed.v]], 'unknown-cell');
  assert.ok(routeRun(box, { truckPathing: 0 }, [0, -20], [[0, 25]], 120).states.has('disabled'));
});
