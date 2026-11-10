export interface CaptureMetrics { simMs: number; renderMs: number; droppedSimulationSeconds: number; renderScale: number; live: number; simulationTick: number }
export interface CaptureReport {
  environment: { userAgent: string; viewport: number[]; devicePixelRatio: number; hardware: string; note: string };
  terrainSeed: number; battleSeed: number; tuning: Record<string, number>;
  warmupSeconds: number; durationSeconds: number; samples: number;
  fps: number; p95: number; p99: number; framesOver33ms: number;
  simulationHz: number; averageSimulationMs: number; averageRenderMs: number;
  droppedSimulationSeconds: number; minimumRenderScale: number; live: number;
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
  private minimumScale = 1;
  private warmup = 300;
  private duration = 600;
  private metadata = { terrainSeed: 0, battleSeed: 0, tuning: {} as Record<string, number> };
  private lastStatus = 0;
  constructor(privateStatus: (status: string) => void) { this.status = privateStatus; }
  private readonly status: (status: string) => void;
  start(terrainSeed: number, battleSeed: number, tuning: Record<string, number>, warmup = 300, duration = 600) {
    this.warmup = Math.max(0, Math.min(300, warmup)); this.duration = Math.max(1, Math.min(600, duration));
    this.metadata = { terrainSeed, battleSeed, tuning: { ...tuning } };
    this.frames = new Float32Array(Math.ceil(this.duration * 240) + 2);
    this.count = this.simTotal = this.renderTotal = this.recording = this.last = this.lastStatus = 0;
    this.minimumScale = 1; this.report = null; this.started = performance.now(); this.active = true;
    this.status('Warming up 500 vs 500… Keep this page visible.');
  }
  cancel(reason = 'Benchmark stopped.') { const wasActive = this.active; this.active = false; if (wasActive) this.status(reason); }
  sample(now: number, metrics: CaptureMetrics) {
    if (!this.active) return;
    if (metrics.live !== 1000) { this.cancel('Benchmark stopped: deployment changed.'); return; }
    const elapsed = (now - this.started) / 1000;
    if (now - this.lastStatus >= 1000) {
      this.status(elapsed < this.warmup ? `Warmup · ${Math.ceil(this.warmup - elapsed)}s remaining`
        : `Recording · ${Math.ceil(Math.max(0, this.warmup + this.duration - elapsed))}s remaining`);
      this.lastStatus = now;
    }
    if (elapsed < this.warmup) return;
    if (!this.recording) { this.recording = this.last = now; this.startTick = metrics.simulationTick; this.startDropped = metrics.droppedSimulationSeconds; return; }
    if (this.count >= this.frames.length) { this.cancel('Benchmark stopped: sample capacity exceeded.'); return; }
    this.frames[this.count++] = now - this.last; this.last = now;
    this.simTotal += metrics.simMs; this.renderTotal += metrics.renderMs; this.minimumScale = Math.min(this.minimumScale, metrics.renderScale);
    if (now - this.recording < this.duration * 1000) return;
    const seconds = (now - this.recording) / 1000, sorted = this.frames.slice(0, this.count).sort();
    let long = 0; for (const frame of sorted) if (frame > 33.4) long++;
    this.report = {
      environment: { userAgent: navigator.userAgent, viewport: [innerWidth, innerHeight], devicePixelRatio,
        hardware: 'Record the physical device model and power/charging conditions with this report.', note: '500 per side kept alive. Alternates 30-second crowd-movement and combat phases. Frame timings include all rendering work.' },
      ...this.metadata, warmupSeconds: this.warmup, durationSeconds: seconds, samples: this.count,
      fps: this.count / seconds, p95: sorted[Math.floor(this.count * 0.95)], p99: sorted[Math.floor(this.count * 0.99)], framesOver33ms: long,
      simulationHz: (metrics.simulationTick - this.startTick) / seconds, averageSimulationMs: this.simTotal / this.count, averageRenderMs: this.renderTotal / this.count,
      droppedSimulationSeconds: metrics.droppedSimulationSeconds - this.startDropped, minimumRenderScale: this.minimumScale, live: metrics.live,
    };
    this.active = false; this.status(`Complete · ${this.report.fps.toFixed(1)} FPS · p95 ${this.report.p95.toFixed(1)}ms. Save the report.`);
  }
  get movementPhase() { return this.active && Math.floor((performance.now() - this.started) / 30000) % 2 === 0; }
}
