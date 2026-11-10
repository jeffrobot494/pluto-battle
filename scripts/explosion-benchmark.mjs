import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';

const candidate = `${process.env.USERPROFILE}/AppData/Local/ms-playwright/chromium-1169/chrome-win/chrome.exe`;
const uncapped = process.env.BATTLE_UNCAPPED === '1';
const args = ['--use-angle=d3d11', '--force_high_performance_gpu'];
if (uncapped) args.push('--disable-frame-rate-limit', '--disable-gpu-vsync');
const browser = await chromium.launch({ executablePath: process.env.BATTLE_CHROMIUM ?? (existsSync(candidate) ? candidate : undefined), args });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.env.BATTLE_URL ?? 'http://localhost:5181/'); await page.waitForFunction(() => window.__battle?.ready);
  const options = {
    count: Number(process.env.BATTLE_COUNT ?? 500), mode: process.env.BATTLE_BLASTS ?? 'bursts',
    seconds: Number(process.env.BATTLE_SECONDS ?? 30), warmup: Number(process.env.BATTLE_WARMUP ?? 5),
    uncapped, quality: process.env.BATTLE_QUALITY ?? 'balanced',
  };
  if (!['none', 'clicks', 'bursts'].includes(options.mode) || !Number.isFinite(options.seconds) || options.seconds < 1) throw new Error('Invalid benchmark options.');
  const result = await page.evaluate(async options => {
    const g = window.__battle; g.restart(options.count); g.setPaused(true); g.renderer.setQuality(options.quality);
    g.sim.hp.fill(1e9, 0, g.sim.used); g.step(360);
    // A tick-based fixture exercises every blast even when multiple ticks run in one frame.
    const step = g.sim.step.bind(g.sim);
    g.sim.step = () => {
      const tick = g.sim.tick;
      const burst = options.mode === 'bursts' && tick % 120 < 3;
      if (burst || (options.mode === 'clicks' && tick % 30 === 0)) {
        // Alternate the two crowded fronts and track a living body's current position.
        const i = tick % 240 < 120 ? 0 : options.count;
        for (let p = 0; p < (burst ? 4 : 1); p++) g.sim.queue({ type: 'explode', x: g.sim.x[i] + (p - 1.5) * 0.5, y: 0, z: g.sim.z[i], radius: burst ? 20 : 4, damage: 0, impulse: burst ? 40 : 10 });
      }
      step();
    };
    g.setPaused(false);
    await new Promise(resolve => setTimeout(resolve, options.warmup * 1000));
    const intervals = [], sim = [], render = [], work = [];
    let previous = performance.now(), maxAirborne = 0, maxEffects = 0, maxCollisionChecks = 0;
    const started = previous, startTick = g.sim.tick, startShots = g.sim.totalShots, startBlasts = g.sim.totalExplosions;
    const resources = { ...g.renderer.webgl.info.memory };
    await new Promise(resolve => {
      function record(now) {
        const interval = now - previous; previous = now; intervals.push(interval);
        const s = g.timings.lastSimMs ?? g.timings.simMs, r = g.timings.lastRenderMs ?? g.timings.renderMs;
        sim.push(s); render.push(r); work.push(s + r);
        maxAirborne = Math.max(maxAirborne, g.sim.airborne); maxEffects = Math.max(maxEffects, g.renderer.activeExplosions); maxCollisionChecks = Math.max(maxCollisionChecks, g.sim.collisionChecks);
        if (now - started < options.seconds * 1000) requestAnimationFrame(record); else resolve();
      }
      requestAnimationFrame(record);
    });
    const elapsed = previous - started, mean = values => values.reduce((a, b) => a + b, 0) / values.length;
    const percentile = (values, p) => values.slice().sort((a, b) => a - b)[Math.floor((values.length - 1) * p)];
    const gl = g.renderer.webgl.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      note: 'Desktop GPU capture. Uncapped mode measures throughput, not display pacing. Physical Pixel 10 acceptance remains separate.',
      renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unavailable',
      ...options, viewport: [innerWidth, innerHeight], pixelRatio: g.renderer.webgl.getPixelRatio(),
      frames: intervals.length, elapsedMs: elapsed, fps: 1000 / mean(intervals), p95: percentile(intervals, 0.95), p99: percentile(intervals, 0.99),
      framesOver16ms: intervals.filter(t => t > 16.67).length, framesOver33ms: intervals.filter(t => t > 33.4).length,
      timingSamples: 'Raw CPU work per frame; render submission excludes GPU completion.',
      simulationHz: (g.sim.tick - startTick) / (elapsed / 1000), simulationMs: mean(sim), renderSubmissionMs: mean(render), cpuWorkP95: percentile(work, 0.95), cpuWorkP99: percentile(work, 0.99),
      shots: g.sim.totalShots - startShots, blasts: g.sim.totalExplosions - startBlasts, maxAirborne, maxEffects, maxCollisionChecks,
      live: Array.from(g.sim.alive), resourcesBefore: resources, resourcesAfter: { ...g.renderer.webgl.info.memory }, stats: g.performance(),
    };
  }, options);
  if (errors.length) throw new Error(errors.join('\n'));
  if (result.live.some(n => n !== options.count)) throw new Error('Benchmark lost soldiers.');
  await mkdir('artifacts', { recursive: true });
  const name = process.env.BATTLE_REPORT ?? `explosions-${options.count}-${options.mode}${uncapped ? '-uncapped' : ''}`;
  await writeFile(`artifacts/${name}.json`, JSON.stringify({ checkedAt: new Date().toISOString(), ...result }, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
