import type { BenchmarkScenario } from './vehicle-benchmark.ts';
import type { DeploymentReport, VehicleFleet } from './vehicles.ts';

type Work = VehicleFleet['metrics'];
export interface CaptureMetrics {
  simMs: number; renderMs: number; droppedSimulationSeconds: number; renderScale: number; live: number; simulationTick: number;
  drawCalls: number; trucks: number; vehicleWork: Work; openingDeployment: DeploymentReport | null;
}
export interface CaptureReport {
  environment: { userAgent: string; viewport: number[]; devicePixelRatio: number; hardware: string; note: string };
  terrainSeed: number; battleSeed: number; scenario: BenchmarkScenario; tuning: Record<string, number>;
  warmupSeconds: number; durationSeconds: number; samples: number;
  fps: number; p95: number; p99: number; framesOver33ms: number;
  simulationHz: number; averageSimulationMs: number; averageRenderMs: number;
  droppedSimulationSeconds: number; minimumRenderScale: number; live: number;
  averageDrawCalls: number; maxDrawCalls: number;
  vehicles: { atFinish: number; opening: DeploymentReport | null; work: Work; meanQueueDelayMs: number;
    paintRelease: { samples: number; maxWorkMs: number; frameP95Ms: number; frameP99Ms: number; maxFrameMs: number } };
}

function percentile(sorted: ArrayLike<number>, q: number) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
}

/** On-device capture. Runs on the existing animation loop with bounded storage.
 * UI measurements are development evidence, never an inferred phone result. */
export class PerformanceCapture {
  active = false;
  report: CaptureReport | null = null;
  private started = 0;
  private recording = 0;
  private last = 0;
  private startTick = 0;
  private startDropped = 0;
  private frames = new Float32Array(0);
  private count = 0;
  private simTotal = 0;
  private renderTotal = 0;
  private drawTotal = 0;
  private maxDrawCalls = 0;
  private workStart: Work | null = null;
  private priorPaints = 0;
  private priorPaintWork = 0;
  private priorSample = 0;
  private paintPreviousFrame = false;
  private readonly paintIntervals: number[] = [];
  private maxPaintWork = 0;
  private minimumScale = 1;
  private warmup = 300;
  private duration = 600;
  private metadata = { terrainSeed: 0, battleSeed: 0, scenario: 'infantry' as BenchmarkScenario, tuning: {} as Record<string, number> };
  private lastStatus = 0;
  constructor(privateStatus: (status: string) => void) { this.status = privateStatus; }
  private readonly status: (status: string) => void;
  start(terrainSeed: number, battleSeed: number, tuning: Record<string, number>, warmup = 300, duration = 600, scenario: BenchmarkScenario = 'infantry') {
    this.warmup = Math.max(0, Math.min(300, warmup)); this.duration = Math.max(1, Math.min(600, duration));
    this.metadata = { terrainSeed, battleSeed, scenario, tuning: { ...tuning } };
    this.frames = new Float32Array(Math.ceil(this.duration * 240) + 2);
    this.count = this.simTotal = this.renderTotal = this.recording = this.last = this.lastStatus = 0;
    this.drawTotal = this.maxDrawCalls = this.priorPaints = this.priorPaintWork = this.priorSample = this.maxPaintWork = 0;
    this.workStart = null; this.paintPreviousFrame = false; this.paintIntervals.length = 0;
    this.minimumScale = 1; this.report = null; this.started = performance.now(); this.active = true;
    this.status('Warming up 500 vs 500… Keep this page visible.');
  }
  cancel(reason = 'Benchmark stopped.') { const wasActive = this.active; this.active = false; if (wasActive) this.status(reason); }
  sample(now: number, metrics: CaptureMetrics) {
    if (!this.active) return;
    if (metrics.live !== 1000) { this.cancel('Benchmark stopped: deployment changed.'); return; }
    const work = metrics.vehicleWork, paintWork = work.groupingMs + work.placementMs;
    if (this.paintPreviousFrame && this.priorSample) this.paintIntervals.push(now - this.priorSample);
    this.paintPreviousFrame = work.paints > this.priorPaints;
    if (this.paintPreviousFrame) this.maxPaintWork = Math.max(this.maxPaintWork, paintWork - this.priorPaintWork);
    this.priorPaints = work.paints; this.priorPaintWork = paintWork; this.priorSample = now;
    const elapsed = (now - this.started) / 1000;
    if (now - this.lastStatus >= 1000) {
      this.status(elapsed < this.warmup ? `Warmup · ${Math.ceil(this.warmup - elapsed)}s remaining`
        : `Recording · ${Math.ceil(Math.max(0, this.warmup + this.duration - elapsed))}s remaining`);
      this.lastStatus = now;
    }
    if (elapsed < this.warmup) return;
    if (!this.recording) {
      this.recording = this.last = now; this.startTick = metrics.simulationTick; this.startDropped = metrics.droppedSimulationSeconds; this.workStart = { ...work }; return;
    }
    if (this.count >= this.frames.length) { this.cancel('Benchmark stopped: sample capacity exceeded.'); return; }
    this.frames[this.count++] = now - this.last; this.last = now;
    this.simTotal += metrics.simMs; this.renderTotal += metrics.renderMs; this.minimumScale = Math.min(this.minimumScale, metrics.renderScale);
    this.drawTotal += metrics.drawCalls; this.maxDrawCalls = Math.max(this.maxDrawCalls, metrics.drawCalls);
    if (now - this.recording < this.duration * 1000) return;
    const seconds = (now - this.recording) / 1000, sorted = this.frames.slice(0, this.count).sort();
    const paintSorted = this.paintIntervals.sort((a, b) => a - b);
    const workDuringCapture = { ...work };
    for (const key of Object.keys(work) as (keyof Work)[]) {
      if (key !== 'peakTrucks' && key !== 'maxQueueDelay') workDuringCapture[key] -= this.workStart![key];
    }
    let long = 0; for (const frame of sorted) if (frame > 33.4) long++;
    this.report = {
      environment: { userAgent: navigator.userAgent, viewport: [innerWidth, innerHeight], devicePixelRatio,
        hardware: 'Record the physical device model and power/charging conditions with this report.', note: '500 per side kept alive. Alternates 30-second movement and combat phases. Vehicle work is counted during capture; peak trucks, maximum queue delay and paint release include warmup.' },
      ...this.metadata, warmupSeconds: this.warmup, durationSeconds: seconds, samples: this.count,
      fps: this.count / seconds, p95: percentile(sorted, 0.95), p99: percentile(sorted, 0.99), framesOver33ms: long,
      simulationHz: (metrics.simulationTick - this.startTick) / seconds, averageSimulationMs: this.simTotal / this.count, averageRenderMs: this.renderTotal / this.count,
      droppedSimulationSeconds: metrics.droppedSimulationSeconds - this.startDropped, minimumRenderScale: this.minimumScale, live: metrics.live,
      averageDrawCalls: this.drawTotal / this.count, maxDrawCalls: this.maxDrawCalls,
      vehicles: { atFinish: metrics.trucks, opening: metrics.openingDeployment, work: workDuringCapture,
        meanQueueDelayMs: workDuringCapture.queueDelay * 1000 / Math.max(1, workDuringCapture.decisions),
        paintRelease: { samples: paintSorted.length, maxWorkMs: this.maxPaintWork, frameP95Ms: percentile(paintSorted, 0.95),
          frameP99Ms: percentile(paintSorted, 0.99), maxFrameMs: paintSorted.at(-1) ?? 0 } },
    };
    this.active = false; this.status(`Complete · ${this.report.fps.toFixed(1)} FPS · p95 ${this.report.p95.toFixed(1)}ms. Save the report.`);
  }
  get movementPhase() { return this.active && Math.floor((performance.now() - this.started) / 30000) % 2 === 0; }
}
