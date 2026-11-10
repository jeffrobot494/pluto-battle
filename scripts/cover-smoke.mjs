import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';

const server = await createServer({ server: { host: '127.0.0.1', port: 5196, strictPort: true } });
await server.listen();
const candidate = `${process.env.USERPROFILE}/AppData/Local/ms-playwright/chromium-1169/chrome-win/chrome.exe`;
const browser = await chromium.launch({ executablePath: process.env.BATTLE_CHROMIUM ?? (existsSync(candidate) ? candidate : undefined), args: ['--use-angle=d3d11', '--force_high_performance_gpu'] });
const errors = [], cases = [];
try {
  await mkdir('artifacts', { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:5196/?terrain=189423');
  await page.waitForFunction(() => window.__battle?.ready);
  await page.evaluate(() => window.__battle.setPaused(true));
  for (const kind of ['ridge', 'boulder', 'clear']) {
    const result = await page.evaluate(async kind => {
      const { Terrain } = await import('/src/terrain.ts');
      const { BattleSimulation } = await import('/src/simulation.ts');
      const terrain = Terrain.flat(8, 8);
      if (kind === 'boulder') terrain.rocks.push({ x: 0, z: 0, radius: 1, base: -0.1, height: 2.5, angle: 0.3 });
      else for (let r = 0; r <= terrain.rows; r++) for (let c = 0; c <= terrain.columns; c++) {
        terrain.heights[r * (terrain.columns + 1) + c] = Math.max(0, 1 - Math.abs(-8 + c * terrain.dx) / 3) * (kind === 'ridge' ? 2.5 : 0.2);
      }
      terrain.rebuild();
      const sim = new BattleSimulation(0, 7, 32, undefined, terrain);
      const a = sim.spawn(0, -5, 0), b = sim.spawn(1, 5, 0);
      sim.target[0] = b; sim.target[1] = a; sim.visible.fill(1); sim.nextSearch.fill(999); sim.nextFire.fill(0);
      sim.step();
      const g = window.__battle, renderer = g.renderer;
      window.__coverUpdate ??= renderer.update.bind(renderer);
      renderer.update = () => window.__coverUpdate(sim, 1, sim.time + 0.01);
      renderer.update();
      renderer.controls.target.set(0, 0.5, 0); renderer.camera.position.set(0, 13, 16); renderer.controls.update(); renderer.update();
      const beams = [];
      for (let i = 0; i < sim.shots.cursor; i++) beams.push({ start: [sim.shots.x[i], sim.shots.y[i], sim.shots.z[i]], end: [sim.shots.endX[i], sim.shots.endY[i], sim.shots.endZ[i]] });
      return { kind, hp: Array.from(sim.hp.slice(0, 2)), visible: Array.from(sim.visible.slice(0, 2)), shots: sim.totalShots, renderedBeams: renderer.beams.count, beams };
    }, kind);
    if (kind === 'clear') { assert.equal(result.shots, 2); assert.equal(result.renderedBeams, 2); assert.deepEqual(result.hp, [91, 91]); }
    else { assert.equal(result.shots, 0); assert.equal(result.renderedBeams, 0); assert.deepEqual(result.hp, [100, 100]); assert.deepEqual(result.visible, [0, 0]); }
    cases.push(result);
    await page.screenshot({ path: `artifacts/cover-${kind}.png` });
  }
  assert.deepEqual(errors, []);
  await writeFile('artifacts/cover-browser-report.json', JSON.stringify({ passed: true, cases, errors }, null, 2));
  console.log(JSON.stringify({ passed: true, cases, errors }, null, 2));
} finally { await browser.close(); await server.close(); }
