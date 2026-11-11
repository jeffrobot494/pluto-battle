import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const url = process.env.BATTLE_URL ?? 'http://localhost:5180/';
const candidate = `${process.env.USERPROFILE}/AppData/Local/ms-playwright/chromium-1169/chrome-win/chrome.exe`;
const executablePath = process.env.BATTLE_CHROMIUM ?? (existsSync(candidate) ? candidate : undefined);
const software = process.env.BATTLE_SOFTWARE === '1';
const browser = await chromium.launch({ executablePath, args: software ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=d3d11', '--force_high_performance_gpu'] });
const errors = [], reports = {};
try {
  await mkdir('artifacts', { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(url);
  await page.waitForFunction(() => window.__battle?.ready);
  assert.equal(await page.title(), 'Pluto — Mass Combat');
  assert.deepEqual(await page.evaluate(() => Array.from(window.__battle.sim.alive)), [100, 100]);
  await page.screenshot({ path: 'artifacts/deployment-desktop.png' });
  await page.waitForFunction(() => window.__battle.sim.totalShots > 30, null, { timeout: 30000 });
  await page.screenshot({ path: 'artifacts/combat-desktop.png' });
  const combat = await page.evaluate(() => {
    const g = window.__battle, sim = g.sim;
    const gl = g.renderer.webgl.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
    return { shots: sim.totalShots, alive: Array.from(sim.alive), flashed: Array.from(sim.lastHit).filter(v => Number.isFinite(v)).length, renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unavailable', stats: g.performance() };
  });
  assert.ok(combat.shots > 0 && combat.flashed > 0); reports.combat = combat;
  await page.click('#pause');
  const frozen = await page.evaluate(() => window.__battle.sim.time);
  await page.waitForTimeout(180); assert.equal(await page.evaluate(() => window.__battle.sim.time), frozen);
  assert.equal(await page.locator('#paused-notice').isVisible(), true);
  await page.click('#pause'); await page.waitForFunction(t => window.__battle.sim.time > t, frozen);
  assert.equal(await page.evaluate(() => window.__battle.renderer.camera.isPerspectiveCamera), true);
  const beforeZoom = await page.evaluate(() => window.__battle.renderer.controls.getDistance());
  await page.click('#zoom-in'); assert.ok(await page.evaluate(() => window.__battle.renderer.controls.getDistance()) < beforeZoom);
  await page.click('#center'); assert.ok(Math.abs(await page.evaluate(() => window.__battle.renderer.controls.getDistance()) - beforeZoom) < 0.001);
  const beforePan = await page.evaluate(() => window.__battle.renderer.controls.target.x);
  await page.mouse.move(720, 480); await page.mouse.down(); await page.mouse.move(780, 480, { steps: 4 }); await page.mouse.up();
  await page.waitForTimeout(150); assert.notEqual(await page.evaluate(() => window.__battle.renderer.controls.target.x), beforePan);
  await page.click('#center');
  const beforeOrbit = await page.evaluate(() => { const c = window.__battle.renderer.controls; return { azimuth: c.getAzimuthalAngle(), polar: c.getPolarAngle(), target: c.target.toArray(), distance: c.getDistance() }; });
  await page.mouse.move(720, 480); await page.mouse.down({ button: 'right' });
  await page.mouse.move(870, 550, { steps: 8 }); await page.mouse.up({ button: 'right' }); await page.waitForTimeout(180);
  const afterOrbit = await page.evaluate(() => { const c = window.__battle.renderer.controls; return { azimuth: c.getAzimuthalAngle(), polar: c.getPolarAngle(), target: c.target.toArray(), distance: c.getDistance() }; });
  assert.ok(Math.abs(afterOrbit.azimuth - beforeOrbit.azimuth) > 0.1);
  assert.ok(Math.abs(afterOrbit.polar - beforeOrbit.polar) > 0.1);
  afterOrbit.target.forEach((v, k) => assert.ok(Math.abs(v - beforeOrbit.target[k]) < 1e-9, 'orbit moved the target')); assert.ok(Math.abs(afterOrbit.distance - beforeOrbit.distance) < 0.001);
  await page.screenshot({ path: 'artifacts/orbit-desktop.png' });
  await page.click('#center'); await page.waitForTimeout(180);
  const resetOrbit = await page.evaluate(() => { const c = window.__battle.renderer.controls; return { azimuth: c.getAzimuthalAngle(), polar: c.getPolarAngle() }; });
  assert.ok(Math.abs(resetOrbit.azimuth - beforeOrbit.azimuth) < 0.001 && Math.abs(resetOrbit.polar - beforeOrbit.polar) < 0.001);
  reports.camera = { perspective: true, beforeOrbit, afterOrbit, resetOrbit };
  await page.click('#diagnostics-toggle'); assert.equal(await page.locator('#diagnostics').isVisible(), true);
  await page.selectOption('#quality', 'low'); assert.equal(await page.evaluate(() => window.__battle.renderer.quality), 'low');
  await page.selectOption('#quality', 'balanced');
  const resources = await page.evaluate(() => ({ geometries: window.__battle.renderer.webgl.info.memory.geometries, textures: window.__battle.renderer.webgl.info.memory.textures }));
  await page.selectOption('#deployment', '500'); await page.click('#apply-battle');
  assert.deepEqual(await page.evaluate(() => Array.from(window.__battle.sim.alive)), [500, 500]);
  await page.evaluate(() => { window.__battle.setPaused(true); window.__battle.step(300); });
  reports.stress1000 = await page.evaluate(() => window.__battle.performance());
  await page.screenshot({ path: 'artifacts/stress-1000.png' });
  await page.selectOption('#deployment', '100'); await page.click('#apply-battle');
  // Deterministic QA can advance the actual app without a long wall-clock wait.
  await page.evaluate(() => { window.__battle.setPaused(true); window.__battle.step(12000); });
  assert.notEqual(await page.evaluate(() => window.__battle.sim.result), 'running');
  assert.equal(await page.locator('#outcome').isVisible(), true);
  await page.screenshot({ path: 'artifacts/outcome-desktop.png' });
  await page.click('#close-diagnostics'); await page.click('#play-again');
  assert.equal(await page.locator('#outcome').isVisible(), false);
  // Restart replays the same map; New map always changes the landscape type and the header follows.
  const map = () => page.evaluate(() => ({ seed: window.__battle.terrainSeed, ...window.__battle.map, label: document.querySelector('#map-name').textContent }));
  const first = await map(); await page.click('#restart'); const replayed = await map();
  assert.equal(replayed.seed, first.seed); assert.equal(replayed.archetype, first.archetype);
  await page.click('#new-map'); const rerolled = await map();
  assert.notEqual(rerolled.archetype, first.archetype); assert.equal(rerolled.label, rerolled.name.toUpperCase());
  await page.evaluate(() => document.activeElement?.blur()); await page.keyboard.press('KeyN'); assert.notEqual((await map()).archetype, rerolled.archetype);
  reports.maps = [first, rerolled];
  for (let n = 0; n < 6; n++) await page.click('#restart');
  const afterResources = await page.evaluate(() => ({ geometries: window.__battle.renderer.webgl.info.memory.geometries, textures: window.__battle.renderer.webgl.info.memory.textures }));
  assert.deepEqual(afterResources, resources);
  await page.click('#pause');
  // A fully isolated hit scene checks white emissive feedback against the GPU output.
  const flashResult = await page.evaluate(async () => {
    const g = window.__battle, r = g.renderer;
    const slot = 0; const sim = g.sim;
    const ground = sim.y[slot]; // terrain height under the soldier
    // A steep view keeps the next soldier in the column from covering the sampled pixels on sloped maps.
    r.camera.position.set(sim.x[slot], ground + 16.5, sim.z[slot] + 4.2); r.controls.target.set(sim.x[slot], ground, sim.z[slot]); r.camera.zoom = 3;
    r.camera.lookAt(r.controls.target); r.camera.updateProjectionMatrix(); r.controls.update();
    const p = r.project(sim.x[slot], ground + 0.55, sim.z[slot]);
    const gl = r.webgl.getContext(), width = gl.drawingBufferWidth, height = gl.drawingBufferHeight;
    const px = Math.round((p.x + 1) * 0.5 * width), py = Math.round((p.y + 1) * 0.5 * height);
    function brightness() { const pixels = new Uint8Array(5 * 5 * 4); gl.readPixels(px - 2, py - 2, 5, 5, gl.RGBA, gl.UNSIGNED_BYTE, pixels); let sum = 0; for (let i = 0; i < pixels.length; i += 4) sum += pixels[i] + pixels[i + 1] + pixels[i + 2]; return sum / 75; }
    r.update(sim, 1, sim.time + 1); const normal = brightness();
    sim.damage(sim.id[slot], 1); r.update(sim, 1, sim.time); const hit = brightness();
    r.update(sim, 1, sim.time + 0.13); const restored = brightness();
    r.resetCamera(); return { normal, hit, restored };
  });
  assert.ok(flashResult.hit > flashResult.normal + 35, JSON.stringify(flashResult));
  assert.ok(Math.abs(flashResult.restored - flashResult.normal) < 3, JSON.stringify(flashResult));
  reports.flash = flashResult;
  const laserColors = await page.evaluate(() => {
    const g = window.__battle, r = g.renderer, sim = g.sim;
    sim.shots.at.fill(-Infinity);
    sim.shots.emit(-5, 0, 5, 0, 0, sim.time);
    sim.shots.emit(-5, 2, 5, 2, 1, sim.time);
    r.update(sim, 1, sim.time + 0.01);
    const gl = r.webgl.getContext(), width = gl.drawingBufferWidth, height = gl.drawingBufferHeight;
    const data = new Uint8Array(width * height * 4); gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
    let greenPixels = 0, redPixels = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 1] > 200 && data[i] < 150 && data[i + 2] < 100) greenPixels++;
      if (data[i] > 220 && data[i + 1] < 80 && data[i + 2] < 80) redPixels++;
    }
    return { greenPixels, redPixels };
  });
  assert.ok(laserColors.greenPixels > 20 && laserColors.redPixels > 20, JSON.stringify(laserColors)); reports.laserColors = laserColors;
  await page.click('#restart');
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const phone = await mobile.newPage(); phone.on('pageerror', error => errors.push(error.message));
  await phone.goto(url); await phone.waitForFunction(() => window.__battle?.ready);
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await phone.locator('#pause').isVisible(), true);
  await phone.waitForFunction(() => window.__battle.sim.totalShots > 20, null, { timeout: 30000 });
  await phone.screenshot({ path: 'artifacts/combat-mobile.png' });
  await phone.tap('#pause'); assert.equal(await phone.evaluate(() => window.__battle.paused), true);
  for (const selector of ['.top-bar', '#zoom-in', '#zoom-out', '#center', '#explosion-toggle', '#pause span', '#restart span', '#tuning-toggle span']) {
    assert.equal(await phone.locator(`${selector}:visible`).count(), 0, selector);
  }
  assert.deepEqual(await phone.locator('.battle-controls button:visible').evaluateAll(buttons => buttons.map(button => button.id)),
    ['pause', 'restart', 'new-map', 'tuning-toggle', 'sound-mute']);
  const toolbar = await phone.locator('.battle-controls').boundingBox();
  const fps = await phone.locator('#diagnostics-toggle').boundingBox();
  assert.ok(fps.y + fps.height <= toolbar.y && fps.x + fps.width === toolbar.x + toolbar.width);
  await phone.tap('#tuning-toggle');
  const panel = await phone.locator('#tuning-panel').boundingBox();
  assert.ok(panel.y >= toolbar.y + toolbar.height);
  await phone.tap('#close-tuning');
  await phone.tap('#restart');
  assert.equal(await phone.evaluate(() => window.__battle.paused), false);
  await phone.tap('#diagnostics-toggle'); await phone.selectOption('#deployment', '250'); await phone.tap('#apply-battle');
  assert.deepEqual(await phone.evaluate(() => Array.from(window.__battle.sim.alive)), [250, 250]);
  reports.mobileEmulation = await phone.evaluate(() => window.__battle.performance());
  await phone.tap('#close-diagnostics');
  assert.deepEqual(errors, []);
  await writeFile('artifacts/browser-report.json', JSON.stringify({ checkedAt: new Date().toISOString(), software, reports, errors }, null, 2));
  console.log(JSON.stringify({ passed: true, reports, errors }, null, 2));
} finally { await browser.close(); }
