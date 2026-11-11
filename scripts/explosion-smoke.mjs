import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const candidate = `${process.env.USERPROFILE}/AppData/Local/ms-playwright/chromium-1169/chrome-win/chrome.exe`;
const browser = await chromium.launch({ executablePath: process.env.BATTLE_CHROMIUM ?? (existsSync(candidate) ? candidate : undefined), args: ['--use-angle=d3d11', '--force_high_performance_gpu'] });
const errors = [];
const url = process.env.BATTLE_URL ?? 'http://localhost:5181/';
async function fixture(page) {
  await page.evaluate(() => {
    const g = window.__battle; g.restart(1); g.setPaused(true); g.sim.weaponsEnabled = false; g.sim.tuning.speed = 0;
    for (let i = 0; i < 2; i++) {
      g.sim.x[i] = g.sim.previousX[i] = i ? 20 : 0;
      g.sim.z[i] = g.sim.previousZ[i] = i ? 20 : 0;
      g.sim.grid.insert(i, g.sim.x[i], g.sim.z[i]);
    }
    g.step(1); g.setPaused(false);
  });
  return page.evaluate(() => {
    const p = window.__battle.renderer.project(0, 0, 0);
    return { x: (p.x + 1) * innerWidth / 2, y: (1 - p.y) * innerHeight / 2 };
  });
}
function watch(page) { page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); }); }
try {
  await mkdir('artifacts', { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage(); watch(page);
  await page.goto(url); await page.waitForFunction(() => window.__battle?.ready);
  let point = await fixture(page);
  assert.equal(await page.getAttribute('#explosion-toggle', 'aria-pressed'), 'false');
  await page.mouse.click(point.x, point.y);
  assert.equal(await page.evaluate(() => window.__battle.sim.totalExplosions), 0);
  await page.click('#explosion-toggle'); await page.mouse.move(point.x, point.y);
  assert.equal(await page.evaluate(() => window.__battle.renderer.blastPreview.visible), true);
  await page.mouse.click(point.x, point.y);
  await page.waitForFunction(() => window.__battle.sim.totalExplosions === 1 && window.__battle.sim.y[0] > 0.03);
  const visual = await page.evaluate(() => {
    const g = window.__battle; g.setPaused(true); g.step(5);
    const m = g.renderer.dummy.matrix;
    g.renderer.guns.getMatrixAt(0, m); const gunY = m.elements[13];
    g.renderer.visors.getMatrixAt(0, m); const visorY = m.elements[13];
    g.renderer.shadows.getMatrixAt(0, m); const shadowY = m.elements[13];
    const surface = g.sim.terrain.heightAt(g.sim.x[0], g.sim.z[0]);
    return { y: g.sim.y[0], surface, gunY, visorY, shadowY, hp: g.sim.hp[0], spheres: g.renderer.blastSpheres.count };
  });
  assert.equal(visual.hp, 65); assert.ok(visual.y > 0.1); assert.equal(visual.spheres, 1);
  assert.ok(Math.abs(visual.gunY - visual.y - 0.69) < 1e-5); assert.ok(Math.abs(visual.visorY - visual.y - 0.88) < 1e-5); assert.ok(Math.abs(visual.shadowY - visual.surface - 0.025) < 1e-5);
  await page.screenshot({ path: 'artifacts/explosion-desktop.png' });
  await page.mouse.click(point.x, point.y); await page.evaluate(() => window.__battle.step(1));
  assert.equal(await page.evaluate(() => window.__battle.sim.totalExplosions), 1);
  await page.evaluate(() => window.__battle.setPaused(false));
  await page.mouse.move(point.x, point.y); await page.mouse.down(); await page.mouse.move(point.x + 100, point.y + 60, { steps: 10 }); await page.mouse.up();
  assert.equal(await page.evaluate(() => window.__battle.sim.totalExplosions), 1);
  await page.mouse.click(point.x, point.y, { button: 'right' });
  await page.evaluate(() => document.querySelector('#viewport canvas').addEventListener('pointerdown', event => { window.__qaPointer = event.pointerId; }, { once: true }));
  await page.mouse.move(point.x, point.y); await page.mouse.down();
  const pointerId = await page.evaluate(() => window.__qaPointer);
  await page.locator('#viewport canvas').dispatchEvent('pointercancel', { pointerId, pointerType: 'mouse' });
  await page.mouse.up();
  await page.click('#center');
  assert.equal(await page.evaluate(() => window.__battle.sim.totalExplosions), 1);
  await page.click('#restart'); assert.equal(await page.getAttribute('#explosion-toggle', 'aria-pressed'), 'false');
  assert.equal(await page.evaluate(() => window.__battle.sim.totalExplosions), 0);
  await page.evaluate(() => window.__battle.setPaused(true));
  await page.click('#tuning-toggle'); await page.locator('[data-tuning-key="gravity"]').fill('15');
  assert.equal(await page.evaluate(() => window.__battle.sim.tuning.gravity), 15);
  await page.reload(); await page.waitForFunction(() => window.__battle?.ready);
  assert.equal(await page.evaluate(() => window.__battle.tuning.gravity), 15);
  await page.click('#tuning-toggle'); await page.click('#reset-tuning');
  assert.equal(await page.evaluate(() => window.__battle.sim.tuning.gravity), 9.81);
  await page.click('#close-tuning');
  // Repeated pooled effects and restarts must keep GPU resource counts stable.
  await fixture(page);
  const resources = await page.evaluate(() => ({ ...window.__battle.renderer.webgl.info.memory }));
  for (let n = 0; n < 6; n++) {
    await page.evaluate(() => {
      const g = window.__battle; g.setPaused(true);
      for (let i = 0; i < 80; i++) g.sim.queue({ type: 'explode', x: 0, y: 0, z: 0, radius: 4, damage: 0, impulse: 0 });
      g.step(1); g.restart(1); g.setPaused(true); g.step(1);
    });
  }
  assert.deepEqual(await page.evaluate(() => ({ ...window.__battle.renderer.webgl.info.memory })), resources);
  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const phone = await mobileContext.newPage(); watch(phone); await phone.goto(url); await phone.waitForFunction(() => window.__battle?.ready);
  point = await fixture(phone);
  assert.equal(await phone.locator('#explosion-toggle').isVisible(), false);
  await phone.evaluate(() => window.__battle.setExplosionTesting(true));
  await phone.touchscreen.tap(point.x, point.y);
  await phone.waitForFunction(() => window.__battle.sim.totalExplosions === 1);
  await phone.evaluate(() => { window.__battle.setPaused(true); window.__battle.step(5); });
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await phone.screenshot({ path: 'artifacts/explosion-mobile.png' });
  // Real touch events through CDP exercise pinch cancellation in OrbitControls and the tap tool.
  const session = await mobileContext.newCDPSession(phone);
  await phone.evaluate(() => window.__battle.setPaused(false));
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: point.x - 30, y: point.y, id: 1 }, { x: point.x + 30, y: point.y, id: 2 }] });
  await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x - 60, y: point.y, id: 1 }, { x: point.x + 60, y: point.y, id: 2 }] });
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.equal(await phone.evaluate(() => window.__battle.sim.totalExplosions), 1);
  const hud = await phone.locator('#pause').boundingBox();
  const hudTouch = { x: hud.x + hud.width / 2, y: hud.y + hud.height / 2, id: 3 };
  const fieldTouch = { x: point.x, y: point.y, id: 4 };
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [hudTouch] });
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [hudTouch, fieldTouch] });
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [hudTouch] });
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.equal(await phone.evaluate(() => window.__battle.sim.totalExplosions), 1);
  await phone.setViewportSize({ width: 844, height: 390 });
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await phone.screenshot({ path: 'artifacts/explosion-landscape.png' });
  assert.deepEqual(errors, []);
  await writeFile('artifacts/explosion-smoke.json', JSON.stringify({ passed: true, visual, desktop: true, touch: true, pinchCanceled: true, persistence: true, stableResources: true, errors }, null, 2));
  console.log('Explosion browser checks passed: desktop/touch, 3D attachments, drag/pinch/HUD isolation, pause/restart, tuning persistence, resources.');
} finally { await browser.close(); }
