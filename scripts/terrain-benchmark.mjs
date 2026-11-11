import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
// BATTLE_SOURCE serves another checkout (e.g. a worktree of an older commit) with that checkout's own vite.config.ts,
// which the RUN SDK needs (es2022 target, libraries plugin). The checkout needs its own node_modules (a junction is fine).
// Inline server options win over the file's, so this never collides with the dev server on 5181.
// No watcher or HMR: an edit to the served files mid-capture would otherwise reload the page and kill the run.
const source = process.env.BATTLE_SOURCE ? resolve(process.env.BATTLE_SOURCE) : null;
const sourceConfig = source && existsSync(resolve(source, 'vite.config.ts')) ? resolve(source, 'vite.config.ts') : false;
const server = source ? await createServer({ configFile: sourceConfig, root: source, logLevel: 'error', server: { host: '127.0.0.1', port: 5192, strictPort: true, fs: { strict: false }, hmr: false, watch: null } }) : null;
if (server) await server.listen();
const count = Number(process.env.BATTLE_COUNT ?? 500);
const uncapped = process.env.BATTLE_UNCAPPED === '1';
const fixedResolution = process.env.BATTLE_FIXED_RESOLUTION === '1';
const candidate = `${process.env.USERPROFILE}/AppData/Local/ms-playwright/chromium-1169/chrome-win/chrome.exe`;
const args = ['--use-angle=d3d11', '--force_high_performance_gpu'];
if (uncapped) args.push('--disable-frame-rate-limit', '--disable-gpu-vsync');
const browser = await chromium.launch({ executablePath: process.env.BATTLE_CHROMIUM ?? (existsSync(candidate) ? candidate : undefined), args });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  // A cold server pre-bundles dependencies on first load, which can exceed Playwright's 30 s default.
  await page.goto(server ? 'http://127.0.0.1:5192/' : process.env.BATTLE_URL ?? 'http://localhost:5181/', { waitUntil: 'commit', timeout: 120000 });
  await page.waitForFunction(() => window.__battle?.ready, null, { timeout: 120000 });
  if (fixedResolution) await page.evaluate(() => { const r = window.__battle.renderer; r.setQuality('low'); if (r.adapt) r.adapt = () => {}; });
  await page.evaluate(count => { const g = window.__battle; g.restart(count, 74319, 189423); g.setPaused(true); g.sim.hp.fill(1e8, 0, g.sim.used); g.step(480); g.setPaused(false); }, count);
  const result = await page.evaluate(async () => {
    const g = window.__battle; await new Promise(r => setTimeout(r, 3000));
    const frames = [], simulation = [], render = [], startTick = g.sim.tick, startShots = g.sim.totalShots, startDropped = g.performance().droppedSimulationSeconds ?? 0, start = performance.now(); let previous = start;
    await new Promise(resolve => { function sample(now) { frames.push(now - previous); previous = now; simulation.push(g.timings.simMs); render.push(g.timings.renderMs); if (now - start < 10000) requestAnimationFrame(sample); else resolve(); } requestAnimationFrame(sample); });
    const sorted = frames.slice().sort((a,b) => a-b), mean = a => a.reduce((x,y) => x+y,0)/a.length;
    const gl = g.renderer.webgl.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
    return { note: 'Desktop development measurement, not Pixel 10 acceptance.', renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unavailable', fps: 1000/mean(frames), p95: sorted[Math.floor(sorted.length*.95)], p99: sorted[Math.floor(sorted.length*.99)], simulationMs: mean(simulation), renderMs: mean(render), simulationRate: (g.sim.tick-startTick)/((previous-start)/1000), droppedSimulationSecondsDuringCapture:(g.performance().droppedSimulationSeconds ?? 0)-startDropped, shots: g.sim.totalShots-startShots, live: Array.from(g.sim.alive), stats: g.performance() };
  });
  result.uncapped = uncapped;
  result.fixedResolution = fixedResolution;
  await mkdir('artifacts', { recursive: true });
  await writeFile(process.env.BATTLE_REPORT ?? 'artifacts/terrain-benchmark.json', JSON.stringify(result,null,2)); console.log(JSON.stringify(result,null,2));
} finally { await browser.close(); await server?.close(); }
