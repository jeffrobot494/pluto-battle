import { BattleSimulation } from '../src/simulation.ts';
import { mkdir, writeFile } from 'node:fs/promises';

const reports = [];
for (const count of [100, 250, 500]) for (const blasts of [false, true]) {
  const sim = new BattleSimulation(count); sim.hp.fill(1e9, 0, sim.used);
  const samples = []; let maxAirborne = 0, maxContacts = 0;
  for (let n = 0; n < 1800; n++) {
    if (blasts && n % 120 < 3) for (let p = 0; p < 4; p++) sim.queue({ type: 'explode', x: sim.x[0] + (p - 1.5) * 0.5, y: 0, z: sim.z[0], radius: 20, damage: 0, impulse: 40 });
    const start = performance.now(); sim.step(); const elapsed = performance.now() - start;
    if (n >= 600) samples.push(elapsed);
    maxAirborne = Math.max(maxAirborne, sim.airborne); maxContacts = Math.max(maxContacts, sim.collisionChecks);
  }
  samples.sort((a, b) => a - b);
  const report = { count, blasts, meanMs: samples.reduce((a, b) => a + b, 0) / samples.length, p95: samples[Math.floor(samples.length * 0.95)], p99: samples[Math.floor(samples.length * 0.99)], maxMs: samples.at(-1), maxAirborne, maxContacts, explosions: sim.totalExplosions, live: Array.from(sim.alive) };
  reports.push(report); console.log(JSON.stringify(report));
}
await mkdir('artifacts', { recursive: true });
await writeFile('artifacts/simulation-benchmark.json', JSON.stringify(reports, null, 2));
