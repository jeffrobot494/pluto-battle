import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';

// Stress test: a battlefield LENGTH× the normal depth, both 500-soldier armies scattered at random over the
// whole map, fighting with normal health until one side wins (or the time cap). Records map loading time and
// per-frame performance, with a normal-length map run the same way as a baseline.
// The half-depth tuning cap (65) is raised by a test-only transform; the game source is unchanged.
const LENGTH = Number(process.env.BATTLE_LENGTH ?? 3), COUNT = Number(process.env.BATTLE_COUNT ?? 500);
const SEEDS = (process.env.BATTLE_TERRAIN_SEEDS ?? '189423,52011,90817').split(',').map(Number);
const FIGHT_SECONDS = Number(process.env.BATTLE_FIGHT_SECONDS ?? 150);
const uncapped = process.env.BATTLE_UNCAPPED === '1';
const normalDepth = 34, longDepth = normalDepth * LENGTH;

const raiseCap = { name: 'long-map-cap', enforce: 'pre', transform(code, id) {
  if (!id.replace(/\\/g, '/').endsWith('/src/tuning.ts')) return null;
  const next = code.replace(/(key: ['"]halfDepth['"][^}]*?max: )65(?![0-9])/, `$1${Math.max(65, longDepth)}`);
  if (next === code) throw new Error(`long-map-benchmark: half-depth tuning definition not found in ${id}: ${JSON.stringify(code.slice(code.indexOf('halfDepth'), code.indexOf('halfDepth') + 160))}`);
  return next;
} };
const server = await createServer({ logLevel: 'error', plugins: [raiseCap], server: { host: '127.0.0.1', port: 5193, strictPort: true, hmr: false, watch: null } });
await server.listen();
const candidate = `${process.env.USERPROFILE}/AppData/Local/ms-playwright/chromium-1169/chrome-win/chrome.exe`;
const args = ['--use-angle=d3d11', '--force_high_performance_gpu'];
if (uncapped) args.push('--disable-frame-rate-limit', '--disable-gpu-vsync');
const browser = await chromium.launch({ executablePath: process.env.BATTLE_CHROMIUM ?? (existsSync(candidate) ? candidate : undefined), args });

const reports = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on('pageerror', e => console.error('page error:', e.message));
  const navStart = Date.now();
  await page.goto('http://127.0.0.1:5193/', { waitUntil: 'commit', timeout: 120000 });
  await page.waitForFunction(() => window.__battle?.ready, null, { timeout: 120000 });
  const coldLoad = { pageReadyMs: Date.now() - navStart, note: 'Cold dev-server page load at default tuning (includes Vite module transform), not a production load.' };
  console.log(JSON.stringify(coldLoad));
  // Throwaway load so shader compilation and first-use costs do not land on the first measured map.
  await page.evaluate(async count => { const g = window.__battle; g.restart(count, 74319, 1); g.setPaused(true); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); }, COUNT);

  for (const halfDepth of [normalDepth, longDepth]) for (const terrainSeed of SEEDS) {
    const label = `${halfDepth === normalDepth ? 'normal' : `${LENGTH}x`}-seed${terrainSeed}`;
    // Set the depth through the tuning panel's own input so main.ts's tuning state takes it.
    const set = await page.evaluate(depth => {
      const input = document.querySelector('input[type="number"][data-tuning-key="halfDepth"]');
      input.value = String(depth); input.dispatchEvent(new Event('input', { bubbles: true }));
      return window.__battle.tuning.halfDepth;
    }, halfDepth);
    if (set !== halfDepth) throw new Error(`Could not set half-depth ${halfDepth} (got ${set}).`);

    // Map loading: restart() synchronously generates terrain, builds navigation and the simulation;
    // the first animation frame afterwards rebuilds the rendered world (terrain mesh, rocks).
    const load = await page.evaluate(async ({ count, terrainSeed }) => {
      const g = window.__battle;
      const t0 = performance.now();
      if (!g.restart(count, 74319, terrainSeed)) throw new Error('restart rejected');
      const restartMs = performance.now() - t0;
      g.setPaused(true);
      const t1 = performance.now();
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const s = g.sim, t = s.terrain;
      return { restartMs, terrainGenerationMs: t.generationMs, navigationAndSimMs: restartMs - t.generationMs, firstFramesMs: performance.now() - t1,
        totalMs: performance.now() - t0, archetype: t.archetype, name: t.name, repairs: t.repairs, ramps: t.ramps.length, rocks: t.rocks.length,
        grid: [t.columns, t.rows], field: [s.grid.halfWidth * 2, s.grid.halfDepth * 2] };
    }, { count: COUNT, terrainSeed });

    // Scatter: every soldier teleported to a random standable, non-overlapping spot anywhere on the map.
    const scatter = await page.evaluate(() => {
      const g = window.__battle, s = g.sim, t = s.terrain, r = s.tuning.radius, min = (2 * r + 0.05) ** 2;
      let state = 0x9e3779b9; const rng = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
      const cell = 1, buckets = new Map(), key = (cx, cz) => cx * 100003 + cz;
      let failed = 0;
      for (let i = 0; i < s.used; i++) {
        let ok = false;
        for (let a = 0; a < 400 && !ok; a++) {
          const x = (rng() * 2 - 1) * (t.halfWidth - 1), z = (rng() * 2 - 1) * (t.halfDepth - 1);
          if (!t.canStand(x, z, r)) continue;
          const cx = Math.floor(x / cell), cz = Math.floor(z / cell); let clear = true;
          for (let ox = -1; ox <= 1 && clear; ox++) for (let oz = -1; oz <= 1 && clear; oz++)
            for (const [px, pz] of buckets.get(key(cx + ox, cz + oz)) ?? []) if ((px - x) ** 2 + (pz - z) ** 2 < min) { clear = false; break; }
          if (!clear) continue;
          (buckets.get(key(cx, cz)) ?? buckets.set(key(cx, cz), []).get(key(cx, cz))).push([x, z]);
          s.x[i] = s.previousX[i] = x; s.z[i] = s.previousZ[i] = z; s.y[i] = s.previousY[i] = t.heightAt(x, z);
          s.velocityX[i] = s.velocityY[i] = s.velocityZ[i] = 0; s.rebuildX[i] = s.rebuildZ[i] = Infinity;
          s.nextSearch[i] = s.nextSight[i] = s.moveRetryAt[i] = 0; s.lastProgress[i] = s.time; s.flankState[i] = 0; s.flankUntil[i] = 0;
          ok = true;
        }
        if (!ok) failed++;
      }
      g.step(1);
      return { soldiers: s.used, failedPlacements: failed };
    });

    // Fight in real time until a side wins or the cap; sample every frame, bucket every 5 s.
    const fight = await page.evaluate(async seconds => {
      const g = window.__battle; g.setPaused(false);
      const frames = [], sims = [], renders = [], buckets = [], start = performance.now(), startTick = g.sim.tick, dropped0 = g.performance().droppedSimulationSeconds ?? 0;
      let previous = start, bucket = null, peakNav = 0;
      await new Promise(resolve => {
        function sample(now) {
          const dt = now - previous; previous = now;
          const tm = g.timings, s = g.sim; frames.push(dt); sims.push(tm.lastSimMs); renders.push(tm.lastRenderMs);
          const second = Math.floor((now - start) / 5000) * 5;
          if (!bucket || bucket.t !== second) {
            bucket = { t: second, frames: [], sim: [], render: [], live0: 0, live1: 0 }; buckets.push(bucket);
          }
          bucket.frames.push(dt); bucket.sim.push(tm.lastSimMs); bucket.render.push(tm.lastRenderMs); bucket.live0 = s.alive[0]; bucket.live1 = s.alive[1];
          if (s.result !== 'running' || now - start > seconds * 1000) resolve(); else requestAnimationFrame(sample);
        }
        requestAnimationFrame(sample);
      });
      const mean = a => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length), pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor((s.length - 1) * p)] ?? 0; };
      const s = g.sim, elapsed = (previous - start) / 1000, stats = g.performance();
      return {
        result: s.result, realSeconds: elapsed, simSeconds: (s.tick - startTick) / 60, simulationRate: (s.tick - startTick) / elapsed,
        droppedSimulationSeconds: (stats.droppedSimulationSeconds ?? 0) - dropped0,
        fps: 1000 / mean(frames), frameP50: pct(frames, 0.5), frameP95: pct(frames, 0.95), frameP99: pct(frames, 0.99), worstFrame: Math.max(...frames),
        framesOver33ms: frames.filter(f => f > 33.4).length, framesOver50ms: frames.filter(f => f > 50).length, frameCount: frames.length,
        simMeanMs: mean(sims), simP95Ms: pct(sims, 0.95), simMaxMs: Math.max(...sims), renderMeanMs: mean(renders), renderP95Ms: pct(renders, 0.95),
        live: Array.from(s.alive), shots: s.totalShots, blockedUnits: s.blockedUnits, drawCalls: stats.drawCalls, triangles: stats.triangles,
        timeline: buckets.map(b => ({ t: b.t, fps: +(1000 / mean(b.frames)).toFixed(1), frameP95: +pct(b.frames, 0.95).toFixed(1), simMs: +mean(b.sim).toFixed(2), simMaxMs: +Math.max(...b.sim).toFixed(1), renderMs: +mean(b.render).toFixed(2), live: [b.live0, b.live1] })),
      };
    }, FIGHT_SECONDS);
    const report = { label, halfDepth, terrainSeed, load, scatter, fight };
    reports.push(report);
    const { timeline, ...summary } = fight;
    console.log(JSON.stringify({ label, load, scatter, fight: summary }));
  }
  const gl = await page.evaluate(() => { const gl = window.__battle.renderer.webgl.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info'); return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unavailable'; });
  await mkdir('artifacts', { recursive: true });
  const out = process.env.BATTLE_REPORT ?? `artifacts/long-map-benchmark-${LENGTH}x.json`;
  await writeFile(out, JSON.stringify({ checkedAt: new Date().toISOString(), note: 'Desktop development measurement, not a phone benchmark. Soldiers scattered uniformly at random over the whole map, both teams intermixed, normal health.', renderer: gl, uncapped, count: COUNT, coldLoad, reports }, null, 2));
  console.log(`wrote ${out}`);
} finally { await browser.close(); await server.close(); }
