import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';

const candidate = `${process.env.USERPROFILE}/AppData/Local/ms-playwright/chromium-1169/chrome-win/chrome.exe`;
const executablePath = process.env.BATTLE_CHROMIUM ?? (existsSync(candidate) ? candidate : undefined);
const uncapped = process.env.BATTLE_UNCAPPED === '1';
const args = ['--use-angle=d3d11', '--force_high_performance_gpu'];
if (uncapped) args.push('--disable-frame-rate-limit', '--disable-gpu-vsync');
const browser = await chromium.launch({ executablePath, args });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const canvasBaselineFps = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 1440; canvas.height = 1000; document.body.append(canvas);
    const context = canvas.getContext('2d');
    const frames = []; let previous = 0;
    await new Promise(resolve => { function sample(now) { context.fillStyle = `hsl(${frames.length % 360}, 30%, 30%)`; context.fillRect(0, 0, canvas.width, canvas.height); if (previous) frames.push(now - previous); previous = now; if (frames.length < 120) requestAnimationFrame(sample); else resolve(); } requestAnimationFrame(sample); });
    return 1000 / (frames.reduce((a, b) => a + b, 0) / frames.length);
  });
  await page.goto(process.env.BATTLE_URL ?? 'http://localhost:5183/');
  await page.waitForFunction(() => window.__battle?.ready);
  const panelOpen = process.env.BATTLE_PANEL === '1';
  if (panelOpen) await page.click('#tuning-toggle');
  const count = Number(process.env.BATTLE_COUNT ?? 100);
  await page.evaluate(count => { const g = window.__battle; g.restart(count); g.setPaused(true); g.sim.hp.fill(100000, 0, g.sim.used); g.step(360); g.setPaused(false); }, count);
  // No screenshots or browser commands during capture. Keep all soldiers alive so the
  // reported window measures sustained firing instead of an almost empty field.
  const result = await page.evaluate(async () => {
    const g = window.__battle;
    await new Promise(resolve => setTimeout(resolve, 6500));
    const frames = [], sim = [], render = [];
    let previous = performance.now();
    const startShots = g.sim.totalShots;
    await new Promise(resolve => {
      function record(now) {
        frames.push(now - previous); previous = now;
        const p = g.timings; sim.push(p.simMs); render.push(p.renderMs);
        if (frames.length < 480) requestAnimationFrame(record); else resolve();
      }
      requestAnimationFrame(record);
    });
    const sorted = frames.slice().sort((a, b) => a - b);
    const gl = g.renderer.webgl.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      note: 'Desktop GPU benchmark; soldiers given extra health to sustain combat. This is not a physical-phone benchmark.',
      renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unavailable',
      viewport: [innerWidth, innerHeight], pixelRatio: g.renderer.webgl.getPixelRatio(), samples: frames.length,
      fps: 1000 / (frames.reduce((a, b) => a + b, 0) / frames.length),
      p50: sorted[Math.floor(sorted.length * 0.5)], p95: sorted[Math.floor(sorted.length * 0.95)], p99: sorted[Math.floor(sorted.length * 0.99)],
      framesOver33ms: frames.filter(t => t > 33.4).length,
      averageSimulationMs: sim.reduce((a, b) => a + b, 0) / sim.length,
      averageRenderSubmissionMs: render.reduce((a, b) => a + b, 0) / render.length,
      shotsDuringCapture: g.sim.totalShots - startShots, live: Array.from(g.sim.alive), stats: g.performance(),
    };
  });
  Object.assign(result, { uncapped, canvasBaselineFps, panelOpen });
  await mkdir('artifacts', { recursive: true });
  result.count = count;
  await writeFile(`artifacts/${process.env.BATTLE_REPORT ?? `benchmark-${count}${uncapped ? '-uncapped' : ''}`}.json`, JSON.stringify({ checkedAt: new Date().toISOString(), ...result }, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
