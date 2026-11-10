import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const candidate = `${process.env.USERPROFILE}/AppData/Local/ms-playwright/chromium-1169/chrome-win/chrome.exe`;
const executablePath = process.env.BATTLE_CHROMIUM ?? (existsSync(candidate) ? candidate : undefined);
const browser = await chromium.launch({ executablePath, args: ['--use-angle=d3d11', '--force_high_performance_gpu'] });
const errors = [];
const changed = {
  gravity: 12, explosionRadius: 5, explosionDamage: 40, explosionImpulse: 15, count: 64, health: 150, damage: 12, range: 12, fireInterval: 0.35, speed: 4, radius: 0.35,
  halfWidth: 20, halfDepth: 30, frontline: 9, columns: 8, columnSpacing: 1.2, rowSpacing: 1.1,
  jitterX: 0.1, jitterZ: 0.1, seed: 1234, searchPadding: 6, searchInterval: 0.2, initialSearchDelay: 0.25,
  avoidanceDistance: 1.4, avoidanceStrength: 1.2, shallowAngle: 0.8, wideAngle: 1.4, flashDuration: 0.2, flashIntensity: 1.4,
};
try {
  await mkdir('artifacts', { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(process.env.BATTLE_URL ?? 'http://localhost:5183/');
  await page.waitForFunction(() => window.__battle?.ready); await page.evaluate(() => window.__battle.setPaused(true));
  assert.equal(await page.locator('#tuning-panel').isVisible(), false);
  await page.click('#tuning-toggle'); assert.equal(await page.locator('#tuning-panel').isVisible(), true);
  assert.equal(await page.locator('[data-tuning-key]').count(), 29);
  const resources = await page.evaluate(() => ({ ...window.__battle.renderer.webgl.info.memory }));
  for (const [key, value] of Object.entries(changed)) {
    await page.locator(`[data-tuning-key="${key}"]`).fill(String(value));
    assert.equal(await page.evaluate(key => window.__battle.tuning[key], key), value, key);
  }
  assert.equal(await page.evaluate(() => window.__battle.sim.tuning.radius), 0.29);
  assert.equal(await page.evaluate(() => window.__battle.sim.grid.halfWidth), 28);
  assert.equal(await page.evaluate(() => window.__battle.sim.hp[0]), 150);
  assert.equal(await page.evaluate(() => window.__battle.sim.rifle.damage), 12);
  await page.waitForFunction(() => window.__battle.renderer.uniforms.duration.value === 0.2 && window.__battle.renderer.uniforms.intensity.value === 1.4);
  assert.match(await page.locator('#tuning-status').innerText(), /new battle/i);
  await page.locator('.tuning-scroll').evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: 'artifacts/tuning-desktop.png' });
  await page.click('#deploy-tuning'); await page.evaluate(() => window.__battle.setPaused(true));
  assert.deepEqual(await page.evaluate(() => Array.from(window.__battle.sim.alive)), [64, 64]);
  assert.equal(await page.evaluate(() => window.__battle.sim.grid.halfWidth), 20);
  assert.equal(await page.evaluate(() => window.__battle.sim.tuning.radius), 0.35);
  await page.waitForFunction(() => window.__battle.renderer.bodies.geometry.parameters.radius === 0.35);
  assert.deepEqual(await page.evaluate(() => ({ ...window.__battle.renderer.webgl.info.memory })), resources);
  await page.reload(); await page.waitForFunction(() => window.__battle?.ready); await page.evaluate(() => window.__battle.setPaused(true));
  assert.deepEqual(await page.evaluate(() => window.__battle.tuning), changed);
  await page.keyboard.press('t'); assert.equal(await page.locator('#tuning-panel').isVisible(), true);
  await page.locator('[data-tuning-key="rowSpacing"]').fill('0.25');
  assert.equal(await page.locator('#deploy-tuning').isDisabled(), true);
  assert.match(await page.locator('#tuning-status').innerText(), /overlapping/i);
  assert.equal(await page.evaluate(() => window.__battle.sim.tuning.rowSpacing), 1.1);
  await page.click('#reset-tuning'); assert.equal(await page.locator('#deploy-tuning').isDisabled(), false);
  await page.click('#deploy-tuning'); await page.evaluate(() => window.__battle.setPaused(true));
  assert.deepEqual(await page.evaluate(() => Array.from(window.__battle.sim.alive)), [100, 100]);
  const speed = page.locator('[data-tuning-range="speed"]'); await speed.focus(); await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => window.__battle.sim.tuning.speed), 3.1);
  await page.locator('[data-tuning-key="health"]').fill('0');
  assert.equal(await page.locator('#deploy-tuning').isDisabled(), true);
  assert.equal(await page.evaluate(() => window.__battle.sim.tuning.health), 100);
  await page.click('#reset-tuning'); await page.click('#deploy-tuning');
  const crowd = page.locator('.tuning-group').filter({ hasText: 'Crowd steering' });
  await crowd.locator('summary').click(); assert.equal(await crowd.locator('[data-tuning-key="avoidanceDistance"]').isVisible(), false);
  await crowd.locator('summary').click();
  await page.click('#close-tuning'); assert.equal(await page.locator('#tuning-panel').isVisible(), false);
  await page.click('#tuning-toggle'); await page.click('#close-tuning');
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const phone = await mobile.newPage(); phone.on('pageerror', error => errors.push(error.message));
  await phone.goto(process.env.BATTLE_URL ?? 'http://localhost:5183/'); await phone.waitForFunction(() => window.__battle?.ready);
  await phone.evaluate(() => window.__battle.setPaused(true)); await phone.tap('#tuning-toggle');
  assert.equal(await phone.locator('[data-tuning-key]').count(), 29);
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await phone.locator('[data-tuning-key="damage"]').fill('20'); assert.equal(await phone.evaluate(() => window.__battle.sim.rifle.damage), 20);
  await phone.locator('.tuning-scroll').evaluate(element => { element.scrollTop = 0; });
  await phone.screenshot({ path: 'artifacts/tuning-mobile.png' });
  await phone.setViewportSize({ width: 844, height: 390 });
  assert.ok(await phone.locator('.tuning-scroll').evaluate(element => element.clientHeight) > 50);
  await phone.locator('[data-tuning-key="flashIntensity"]').fill('2');
  await phone.waitForFunction(() => window.__battle.renderer.uniforms.intensity.value === 2);
  await phone.screenshot({ path: 'artifacts/tuning-landscape.png' });
  await phone.tap('#close-tuning'); assert.equal(await phone.locator('#tuning-panel').isVisible(), false);
  assert.deepEqual(errors, []);
  const report = { passed: true, controls: Object.keys(changed).length, persistence: true, liveTuning: true, deploymentValidation: true, desktopAndTouch: true, errors };
  await writeFile('artifacts/tuning-report.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
