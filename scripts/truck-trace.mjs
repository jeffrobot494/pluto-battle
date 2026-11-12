import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { CONFIG } from '../src/config.ts';
import { Navigation, prepareTerrain } from '../src/navigation.ts';
import { BattleSimulation } from '../src/simulation.ts';
import { archetypeById } from '../src/terrain-archetypes.ts';
import { DEFAULT_TUNING, TUNING } from '../src/tuning.ts';
import { serializeTruckTrace } from '../src/truck-trace-export.ts';
import { DRIVER, Maneuver } from '../src/vehicle-types.ts';
import { VehicleBenchmark, benchmarkTuning, liftBenchmarkLimits } from '../src/vehicle-benchmark.ts';

const { values } = parseArgs({
  options: {
    // Comma-separated lists run every map and terrain seed combination and print a summary.
    map: { type: 'string', default: 'ice' },
    'terrain-seed': { type: 'string', default: String(CONFIG.seed) },
    'battle-seed': { type: 'string', default: String(CONFIG.seed) },
    soldiers: { type: 'string', default: '30' },
    seconds: { type: 'string', default: '60' },
    // Battlefield area multiplier. Scales width, depth and frontline by its square root, past the Tuning limits.
    area: { type: 'string', default: '1' },
    // 'trace' (one paint of crewed trucks, --soldiers per army) or a vehicle benchmark workload: packed, sparse, mixed.
    workload: { type: 'string', default: 'trace' },
    // 'off' sets truckPathing to 0 (the straight-line planner) for A/B checks. The truck graph and fields still build.
    pathing: { type: 'string', default: 'on' },
    full: { type: 'boolean', default: false },
    quiet: { type: 'boolean', default: false },
    output: { type: 'string', default: 'artifacts/truck-trace.json' },
  },
});

function integer(name, min, max, raw = values[name]) {
  const number = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(number) || number < min || number > max) {
    throw new Error(`--${name} must be an integer from ${min} through ${max}.`);
  }
  return number;
}

const workload = values.workload;
if (!['trace', 'packed', 'sparse', 'mixed'].includes(workload)) throw new Error('--workload must be trace, packed, sparse or mixed.');
const fixture = workload !== 'trace';
const count = fixture ? 500 : integer('soldiers', 1, 500);
const battleSeed = integer('battle-seed', 0, 0xffffffff);
const terrainSeeds = values['terrain-seed'].split(',').map(raw => integer('terrain-seed', 0, 0xffffffff, raw.trim()));
const ticks = Math.round(integer('seconds', 1, 600) / CONFIG.step);
const area = Number(values.area);
if (!(area >= 1 && area <= 8)) throw new Error('--area must be from 1 through 8.');
const maps = values.map.split(',').map(map => map.trim());
for (const map of maps) if (map !== 'flat' && !archetypeById(map)) throw new Error(`Unknown map ${map}.`);

const side = Math.sqrt(area);
// Lift the battlefield limits for this process only; Tuning keeps its own.
for (const definition of TUNING) if (definition.key === 'halfWidth' || definition.key === 'halfDepth' || definition.key === 'frontline') definition.max *= side;
const tuning = fixture ? { ...benchmarkTuning({ ...DEFAULT_TUNING, seed: battleSeed }, workload, area), seed: battleSeed } : {
  ...DEFAULT_TUNING, count, seed: battleSeed, columns: Math.ceil(Math.sqrt(count)),
  halfWidth: DEFAULT_TUNING.halfWidth * side, halfDepth: DEFAULT_TUNING.halfDepth * side, frontline: DEFAULT_TUNING.frontline * side,
};
if (fixture) liftBenchmarkLimits(area);
if (values.pathing !== 'on' && values.pathing !== 'off') throw new Error('--pathing must be on or off.');
tuning.truckPathing = values.pathing === 'on' ? 1 : 0;

function run(map, terrainSeed) {
  let navigationBuildMs = 0;
  const preparedAt = performance.now();
  const world = map === 'flat' ? undefined : prepareTerrain(tuning, terrainSeed, map);
  const preparedMs = performance.now() - preparedAt;
  if (world) {
    // One clean build of the final graph; prepareTerrain may build several while repairing.
    const builtAt = performance.now();
    new Navigation(world.terrain, tuning.radius);
    navigationBuildMs = performance.now() - builtAt;
  }
  const sim = new BattleSimulation(count, battleSeed, CONFIG.capacity, tuning, world?.terrain, world?.navigation);
  // Script-only timing hook: the simulation is unchanged.
  let navigationMs = 0;
  const updateNavigation = sim.updateNavigation.bind(sim);
  sim.updateNavigation = () => { const at = performance.now(); updateNavigation(); navigationMs += performance.now() - at; };
  const f = sim.vehicles;
  // Truck graph slices and truck fields, timed apart from the infantry fields above.
  let truckNavigationMs = 0, peakTruckNavigationMs = 0, peakStepMs = 0;
  const updateTruckNavigation = f.updateNavigation.bind(f);
  f.updateNavigation = () => {
    const at = performance.now(); updateTruckNavigation();
    const ms = performance.now() - at; truckNavigationMs += ms; peakTruckNavigationMs = Math.max(peakTruckNavigationMs, ms);
  };
  f.startTrace();
  // The benchmark fixture repaints every 25 s and keeps hulls alive, as in the vehicle benchmark capture.
  const bench = fixture ? new VehicleBenchmark(workload) : null;
  if (!bench) sim.queue({ type: 'deployTrucks', x: 0, z: 0, radius: Math.hypot(tuning.halfWidth, tuning.halfDepth) + 1, teams: 3 });
  let truckTicks = 0, holdTicks = 0, reverseTicks = 0;
  const startedAt = performance.now();
  while (sim.tick < ticks && sim.result === 'running') {
    bench?.beforeStep(sim);
    const stepAt = performance.now();
    sim.step();
    // Skip the first second: one-off warm-up (JIT, first deployment) is not a stall.
    if (sim.tick > 1 / CONFIG.step) peakStepMs = Math.max(peakStepMs, performance.now() - stepAt);
    for (let n = 0; n < f.count; n++) {
      const v = f.active[n];
      if (f.seat(v, DRIVER) < 0) continue;
      truckTicks++;
      if (f.mode[v] === Maneuver.Hold) holdTicks++;
      else if (f.mode[v] === Maneuver.Reverse) reverseTicks++;
    }
  }
  const wallMs = performance.now() - startedAt;
  const report = f.stopTrace();
  const stops = report.trucks.reduce((sum, truck) => sum + truck.stopCount, 0);
  const routedStops = report.trucks.reduce((sum, truck) => sum + truck.routedStops, 0);
  const fallbackStops = report.trucks.reduce((sum, truck) => sum + truck.fallbackStops, 0);
  const routing = report.routing;
  return {
    routedStops, fallbackStops, stuck: report.recovery.stuck, livelocks: report.recovery.livelocks,
    routeQueries: routing.queries, routeUsed: routing.route, routeFallbacks: Object.values(routing.fallbacks).reduce((a, b) => a + b, 0),
    fallbacks: routing.fallbacks, fieldExpansions: routing.fieldExpansions, peakFieldExpansions: routing.peakFieldExpansions,
    fieldEarlyStops: routing.fieldEarlyStops, fieldFullSweeps: routing.fieldFullSweeps, graphBuildMs: routing.graphBuildMs,
    map: report.map, terrainSeed, report, stops, stoppedAtEnd: report.stoppedTruckIds.length,
    truckMinutes: truckTicks * CONFIG.step / 60, holdTicks, reverseTicks, truckTicks,
    planningMs: f.metrics.planningMs, decisions: f.metrics.decisions, navigationMs, simulatedTicks: sim.tick,
    navigationBuildMs, preparedMs, wallMs, cells: world ? world.navigation.walkable.length : 0,
    truckNavigationMs, peakTruckNavigationMs, peakStepMs,
    contacts: f.metrics.contacts, rams: f.metrics.rams, shots: f.metrics.shots, wrecks: f.metrics.destructions, peakTrucks: f.metrics.peakTrucks,
    yields: f.metrics.yields, retreats: f.metrics.retreats, crawls: f.metrics.crawls, makeWay: f.metrics.makeWay, displaced: f.metrics.displaced,
  };
}

function describeStops(report) {
  const byId = new Map(report.trucks.map(truck => [truck.id, truck]));
  for (const id of report.stoppedTruckIds.slice(0, 12)) {
    const truck = byId.get(id), { snapshot, lastStop, events } = truck;
    let blocker;
    if (snapshot.activity === 'no-clear-route') {
      const decision = events.findLast(event => event.kind === 'decision' && event.outcome === 'no-clear-route');
      blocker = decision?.recovery.find(check => check.blockedBy)?.blockedBy.blocker
        ?? decision?.checks.find(check => check.score === null && check.blockedBy)?.blockedBy.blocker;
    } else if (snapshot.activity === 'driving' || snapshot.activity === 'waiting-for-replan') {
      blocker = events.findLast(event => event.kind === 'contact' && event.throughTick >= lastStop.sinceTick)?.blocker;
    }
    const where = `(${snapshot.x.toFixed(2)}, ${snapshot.z.toFixed(2)})`;
    console.log(`  Truck ${id} ${where} · ${((report.throughTick - lastStop.sinceTick) * CONFIG.step).toFixed(1)}s · ${snapshot.activity}${blocker ? ` · ${blocker.kind}${blocker.id === null ? '' : ` #${blocker.id}`}` : ''}`);
  }
}

const percent = (part, whole) => whole ? `${(part / whole * 100).toFixed(1)}%` : '—';
function line(r) {
  return `${r.map} #${r.terrainSeed} · ${(r.simulatedTicks * CONFIG.step).toFixed(0)}s ${r.report.outcome} · ${r.report.trucks.length} trucks · `
    + `${r.stops} stops (${(r.stops / Math.max(r.truckMinutes, 1e-9)).toFixed(2)}/truck-min) · ${r.stoppedAtEnd} stopped at end · `
    + `hold ${percent(r.holdTicks, r.truckTicks)} reverse ${percent(r.reverseTicks, r.truckTicks)} · `
    + `plan ${r.planningMs.toFixed(0)} ms (${(r.planningMs / Math.max(r.decisions, 1) * 1000).toFixed(0)} µs/decision) · `
    + `nav build ${r.navigationBuildMs.toFixed(1)} ms, ${(r.navigationMs / Math.max(r.simulatedTicks, 1)).toFixed(3)} ms/tick`
    + `
    stops routed ${r.routedStops} fallback ${r.fallbackStops} · route ${percent(r.routeUsed, r.routeQueries)} of ${r.routeQueries} plans, fallback ${percent(r.routeFallbacks, r.routeQueries)} `
    + `(${Object.entries(r.fallbacks).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}) · `
    + `truck graph ${r.graphBuildMs.toFixed(1)} ms · fields ${(r.fieldExpansions / Math.max(r.simulatedTicks, 1)).toFixed(1)} exp/tick, peak ${r.peakFieldExpansions}, `
    + `${r.fieldEarlyStops} early stops, ${r.fieldFullSweeps} full sweeps · stuck ${r.stuck} livelock ${r.livelocks}`;
}

const results = [];
for (const map of maps) for (const terrainSeed of terrainSeeds) {
  const result = run(map, terrainSeed);
  results.push(result);
  console.log(line(result));
  if (!values.quiet) describeStops(result.report);
}

if (results.length === 1) {
  const path = resolve(values.output);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serializeTruckTrace(results[0].report, values.full));
  console.log(path);
} else {
  const sum = key => results.reduce((total, r) => total + r[key], 0);
  const truckMinutes = sum('truckMinutes'), truckTicks = sum('truckTicks'), simulated = sum('simulatedTicks');
  console.log(`\n${results.length} runs · ${workload} · area ×${area} · ${count} soldiers per army · ${truckMinutes.toFixed(1)} truck-minutes`);
  console.log(`stops ${sum('stops')} (${(sum('stops') / Math.max(truckMinutes, 1e-9)).toFixed(2)}/truck-min) · stopped at end ${sum('stoppedAtEnd')} · `
    + `hold ${percent(sum('holdTicks'), truckTicks)} · reverse ${percent(sum('reverseTicks'), truckTicks)}`);
  console.log(`planning ${(sum('planningMs') / Math.max(sum('decisions'), 1) * 1000).toFixed(0)} µs/decision, ${(sum('planningMs') / simulated).toFixed(3)} ms/tick · `
    + `nav build ${(sum('navigationBuildMs') / results.length).toFixed(1)} ms mean, ${Math.max(...results.map(r => r.navigationBuildMs)).toFixed(1)} ms max · `
    + `nav ${(sum('navigationMs') / simulated).toFixed(3)} ms/tick · ${Math.round(sum('cells') / results.length)} cells mean`);
  console.log(`stops routed ${sum('routedStops')} fallback ${sum('fallbackStops')} · route ${percent(sum('routeUsed'), sum('routeQueries'))} of plans, fallback ${percent(sum('routeFallbacks'), sum('routeQueries'))} · `
    + `fields ${(sum('fieldExpansions') / simulated).toFixed(1)} exp/tick, peak ${Math.max(...results.map(r => r.peakFieldExpansions))}, ${sum('fieldEarlyStops')} early stops, ${sum('fieldFullSweeps')} full sweeps · `
    + `truck graph ${(sum('graphBuildMs') / results.length).toFixed(1)} ms mean · stuck ${sum('stuck')} livelock ${sum('livelocks')}`);
  console.log(`truck nav ${(sum('truckNavigationMs') / simulated).toFixed(3)} ms/tick, peak ${Math.max(...results.map(r => r.peakTruckNavigationMs)).toFixed(1)} ms · `
    + `peak step ${Math.max(...results.map(r => r.peakStepMs)).toFixed(1)} ms · contacts ${sum('contacts')} rams ${sum('rams')} shots ${sum('shots')} wrecks ${sum('wrecks')} · `
    + `ladder: yields ${sum('yields')} retreats ${sum('retreats')} crawls ${sum('crawls')} make-way ${sum('makeWay')} displaced ${sum('displaced')}`);
  const path = resolve(values.output.replace(/\.json$/, '-summary.json'));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ workload, area, pathing: values.pathing, count, seconds: ticks * CONFIG.step, battleSeed, runs: results.map(({ report, ...r }) => r) }, null, 2));
  console.log(path);
}

// Hard gate: any stuck truck or livelock fails the run (see truck-pathfinding-plan.md, "Zero stuck trucks").
const failing = results.filter(r => r.stuck || r.livelocks);
if (failing.length) {
  console.error(`
FAIL: stuck trucks in ${failing.length} run(s): ${failing.map(r => `${r.map} #${r.terrainSeed} (stuck ${r.stuck}, livelock ${r.livelocks})`).join(', ')}`);
  process.exitCode = 1;
}
