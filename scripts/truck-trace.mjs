import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { CONFIG } from '../src/config.ts';
import { prepareTerrain } from '../src/navigation.ts';
import { BattleSimulation } from '../src/simulation.ts';
import { archetypeById } from '../src/terrain-archetypes.ts';
import { DEFAULT_TUNING } from '../src/tuning.ts';

const { values } = parseArgs({
  options: {
    map: { type: 'string', default: 'ice' },
    'terrain-seed': { type: 'string', default: String(CONFIG.seed) },
    'battle-seed': { type: 'string', default: String(CONFIG.seed) },
    soldiers: { type: 'string', default: '30' },
    seconds: { type: 'string', default: '60' },
    output: { type: 'string', default: 'artifacts/truck-trace.json' },
  },
});

function integer(name, min, max) {
  const raw = values[name], number = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(number) || number < min || number > max) {
    throw new Error(`--${name} must be an integer from ${min} through ${max}.`);
  }
  return number;
}

const count = integer('soldiers', 1, 500);
const battleSeed = integer('battle-seed', 0, 0xffffffff);
const terrainSeed = integer('terrain-seed', 0, 0xffffffff);
const ticks = Math.round(integer('seconds', 1, 600) / CONFIG.step);
const map = values.map;
if (map !== 'flat' && !archetypeById(map)) throw new Error(`Unknown map ${map}.`);

const tuning = { ...DEFAULT_TUNING, count, seed: battleSeed, columns: Math.ceil(Math.sqrt(count)) };
const world = map === 'flat' ? undefined : prepareTerrain(tuning, terrainSeed, map);
const sim = new BattleSimulation(count, battleSeed, CONFIG.capacity, tuning, world?.terrain, world?.navigation);
sim.vehicles.startTrace();
sim.queue({ type: 'deployTrucks', x: 0, z: 0, radius: Math.hypot(tuning.halfWidth, tuning.halfDepth) + 1, teams: 3 });
while (sim.tick < ticks && sim.result === 'running') sim.step();
const report = sim.vehicles.stopTrace();
const path = resolve(values.output);
await mkdir(dirname(path), { recursive: true });
await writeFile(path, JSON.stringify(report));

const byId = new Map(report.trucks.map(truck => [truck.id, truck]));
const episodes = report.trucks.reduce((sum, truck) => sum + truck.stopCount, 0);
console.log(`${report.map} · ${(report.throughTick * CONFIG.step).toFixed(1)}s · ${report.outcome} · ${report.alive.join(' vs ')} alive`);
console.log(`${report.trucks.length} tracked · ${episodes} stops · ${report.stoppedTruckIds.length} stopped at end`);
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
  console.log(`Truck ${id} ${where} · ${((report.throughTick - lastStop.sinceTick) * CONFIG.step).toFixed(1)}s · ${snapshot.activity}${blocker ? ` · ${blocker.kind}${blocker.id === null ? '' : ` #${blocker.id}`}` : ''}`);
}
console.log(path);
