// Per-step cost on generated terrain, including the flow-field rebuild ticks that seed firing positions.
import { BattleSimulation } from '../src/simulation.ts';
import { prepareTerrain } from '../src/navigation.ts';
import { DEFAULT_TUNING } from '../src/tuning.ts';

for (const count of [100, 250]) {
  const all: number[] = [], rebuild: number[] = [];
  let rays = 0, seeds = 0, builds = 0;
  for (const seed of [3, 11, 17, 29, 41, 58]) {
    const tuning = { ...DEFAULT_TUNING, count, columns: Math.ceil(Math.sqrt(count)) };
    const { terrain, navigation } = prepareTerrain(tuning, seed);
    const sim = new BattleSimulation(count, seed, 2048, tuning, terrain, navigation);
    for (let n = 0; n < 1500 && sim.result === 'running'; n++) {
      const before = navigation.fireRays ?? 0, start = performance.now(); sim.step(); const ms = performance.now() - start;
      if (n > 60) {
        all.push(ms);
        if (sim.tick % 60 === 0) { rebuild.push(ms); rays += (navigation.fireRays ?? 0) - before; seeds += (navigation.fields[0].firingSeeds ?? 0) + (navigation.fields[1].firingSeeds ?? 0); builds++; }
      }
    }
  }
  const stat = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return { mean: +(s.reduce((x, y) => x + y, 0) / s.length).toFixed(3), p99: +s[Math.floor(s.length * 0.99)].toFixed(3), max: +s.at(-1)!.toFixed(3) }; };
  console.log(JSON.stringify({ count, all: stat(all), rebuildTicks: stat(rebuild), raysPerRebuild: Math.round(rays / builds), seedsPerRebuild: Math.round(seeds / builds) }));
}
