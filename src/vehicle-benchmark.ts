import type { BattleSimulation } from './simulation.ts';
import type { TuningValues } from './tuning.ts';
import type { DeploymentReport } from './vehicles.ts';

export const BENCHMARK_SCENARIOS = [
  { id: 'infantry', label: 'Infantry baseline' },
  { id: 'packed', label: 'Packed trucks · both armies' },
  { id: 'infantry-spread', label: 'Infantry baseline · spread' },
  { id: 'sparse', label: 'Solo trucks · both armies' },
  { id: 'mixed', label: 'Mixed · trucks versus infantry' },
] as const;
export type BenchmarkScenario = typeof BENCHMARK_SCENARIOS[number]['id'];
export function usesTrucks(mode: BenchmarkScenario) { return mode !== 'infantry' && mode !== 'infantry-spread'; }

/** Keep matching formations for each infantry comparison. Use enough room to pull 1,000 separate trucks away. */
export function benchmarkTuning(tuning: TuningValues, mode: BenchmarkScenario): TuningValues {
  const spread = mode === 'sparse' || mode === 'infantry-spread';
  return { ...tuning, count: 500, columns: 23, halfWidth: 42, halfDepth: 54, frontline: 8, radius: Math.min(0.45, tuning.radius),
    columnSpacing: spread ? 2.35 : 1.4, rowSpacing: spread ? 1.88 : 1.16, jitterX: Math.min(0.04, tuning.jitterX), jitterZ: Math.min(0.06, tuning.jitterZ) };
}

/** Capture fixture only. Deployments, contact, turret fire, and destruction use the gameplay paths. */
export class VehicleBenchmark {
  private nextPaint = 0;
  private nextBlast = 12;
  private vulnerabilityEnds = 0;
  private readonly vulnerable = new Set<number>();
  openingDeployment: DeploymentReport | null = null;

  readonly mode: BenchmarkScenario;
  constructor(mode: BenchmarkScenario) { this.mode = mode; }

  beforeStep(sim: BattleSimulation) {
    if (!usesTrucks(this.mode)) return;
    const f = sim.vehicles, t = sim.tuning;
    if (!this.openingDeployment && f.lastDeployment?.id === 1) this.openingDeployment = f.lastDeployment;
    if (this.vulnerable.size && sim.time >= this.vulnerabilityEnds) this.vulnerable.clear();
    for (let n = 0; n < f.count; n++) {
      const v = f.active[n];
      if (f.hp[v] < t.truckHealth && !this.vulnerable.has(f.id[v])) f.hp[v] = t.truckHealth;
    }
    if (sim.time >= this.nextPaint && !f.pendingCrews) {
      sim.queue({ type: 'deployTrucks', x: 0, z: 0, radius: Math.hypot(sim.grid.halfWidth, sim.grid.halfDepth) + 1,
        teams: this.mode === 'mixed' ? 1 : 3, solo: this.mode === 'sparse' });
      this.nextPaint = sim.time + 25;
    }
    if (sim.time < this.nextBlast || f.count < 2 || t.truckBlastDamage <= 0) return;
    this.nextBlast = sim.time + 10;
    const reach = t.truckBlastRadius * 0.9, g = f.grid;
    let center = -1, best = -1;
    // Find a cluster without an all-pairs scan. Only nearby hulls are made vulnerable to the chain.
    for (let n = 0; n < Math.min(64, f.count); n++) {
      const v = f.active[(sim.tick + n * 17) % f.count], x = f.x[v], z = f.z[v];
      let neighbors = 0;
      for (let row = g.row(z - reach); row <= g.row(z + reach); row++) for (let col = g.column(x - reach); col <= g.column(x + reach); col++) {
        for (let j = g.heads[row * g.columns + col]; j >= 0; j = g.next[j]) {
          if ((f.x[j] - x) ** 2 + (f.z[j] - z) ** 2 < reach * reach && Math.abs(f.y[j] - f.y[v]) < reach * 0.4) neighbors++;
        }
      }
      if (neighbors > best) { center = v; best = neighbors; }
    }
    if (center < 0) return;
    const x = f.x[center], y = f.y[center], z = f.z[center];
    const neighbors: number[] = [];
    for (let row = g.row(z - reach); row <= g.row(z + reach); row++) for (let col = g.column(x - reach); col <= g.column(x + reach); col++) {
      for (let v = g.heads[row * g.columns + col]; v >= 0; v = g.next[v]) {
        if ((f.x[v] - x) ** 2 + (f.z[v] - z) ** 2 < reach * reach && Math.abs(f.y[v] - y) < reach * 0.4) neighbors.push(v);
      }
    }
    for (const v of [center, ...neighbors.filter(v => v !== center).slice(0, 9)]) {
      f.hp[v] = Math.min(f.hp[v], t.truckBlastDamage * 0.8);
      this.vulnerable.add(f.id[v]);
    }
    this.vulnerabilityEnds = sim.time + 0.65;
    sim.queue({ type: 'explode', x, y: y + 0.46, z, radius: 0.5, damage: t.truckBlastDamage, impulse: 0 });
  }
}
