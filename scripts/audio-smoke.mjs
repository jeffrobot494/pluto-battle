import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const url = process.env.BATTLE_URL ?? 'http://localhost:5180/';
const candidate = `${process.env.USERPROFILE}/AppData/Local/ms-playwright/chromium-1169/chrome-win/chrome.exe`;
const executablePath = process.env.BATTLE_CHROMIUM ?? (existsSync(candidate) ? candidate : undefined);
const browser = await chromium.launch({ executablePath, args: ['--use-angle=d3d11'] });
const errors = [], report = {};
const ids = ['laser', 'plutonianHit', 'sectoidHit', 'plutonianDeath', 'sectoidDeath'];
const levels = [17, 42, 63, 76, 91];
try {
  await mkdir('artifacts', { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url); await page.waitForFunction(() => window.__battle?.ready);
  await page.evaluate(() => window.__battle.setPaused(true));
  assert.equal(await page.locator('#sound-panel').getAttribute('open'), null);
  assert.equal(await page.locator('#sound-panel input[type=range]').count(), 5);
  assert.equal(await page.evaluate(() => window.__battle.audio.state), 'locked');
  await page.click('#sound-panel summary');
  await page.waitForFunction(() => window.__battle.audio.state === 'running');
  // Keyboard slider input must not fire the game's Space/Pause shortcut.
  await page.locator('#volume-laser').focus(); await page.keyboard.press('Home');
  assert.equal(await page.locator('#level-laser').textContent(), '0%');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#level-laser').textContent(), '1%');
  assert.equal(await page.evaluate(() => window.__battle.paused), true);
  for (const [i, id] of ids.entries()) {
    await page.locator(`#volume-${id}`).evaluate((slider, value) => { slider.value = value; slider.dispatchEvent(new Event('input', { bubbles: true })); }, String(levels[i]));
    assert.equal(await page.locator(`#level-${id}`).textContent(), `${levels[i]}%`);
    await page.click(`#preview-${id}`);
  }
  assert.deepEqual(await page.evaluate(() => window.__battle.audio.snapshot().volumes), Object.fromEntries(ids.map((id, i) => [id, levels[i]])));
  // Probe the actual final audio bus, leaving the normal output connected.
  report.signal = await page.evaluate(async ids => {
    const audio = window.__battle.audio, context = audio.context;
    const analyser = context.createAnalyser(), silent = context.createGain();
    analyser.fftSize = 2048; silent.gain.value = 0;
    audio.output.connect(analyser); analyser.connect(silent); silent.connect(context.destination);
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const rms = () => { const data = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(data); return Math.sqrt(data.reduce((sum, n) => sum + n * n, 0) / data.length); };
    const result = {};
    for (const id of ids) {
      audio.stop(); const level = audio.getVolume(id); audio.setVolume(id, 100);
      await audio.preview(id); await wait(65); const audible = rms();
      audio.stop(); audio.setVolume(id, 0); const before = audio.snapshot().played[id];
      await audio.preview(id); await wait(120);
      result[id] = { audible, muted: rms(), mutedSources: audio.snapshot().played[id] - before };
      audio.setVolume(id, level);
    }
    audio.output.disconnect(analyser); analyser.disconnect(); silent.disconnect();
    return result;
  }, ids);
  for (const [id, signal] of Object.entries(report.signal)) {
    assert.ok(signal.audible > 0.0001, `${id}: ${JSON.stringify(signal)}`);
    assert.ok(signal.muted < 0.000001, `${id}: mute output`);
    assert.equal(signal.mutedSources, 0);
  }
  await page.screenshot({ path: 'artifacts/sound-panel-desktop.png' });
  await page.evaluate(() => window.__battle.restart());
  assert.equal(await page.evaluate(() => window.__battle.audio.snapshot().activeVoices), 0);
  await page.waitForFunction(() => window.__battle.audio.snapshot().played.laser > 2 && window.__battle.sim.totalShots > 10, null, { timeout: 30000 });
  report.combat = await page.evaluate(() => {
    const g = window.__battle; g.setPaused(true); const before = g.audio.snapshot().played;
    for (const slot of [0, g.sim.used / 2]) g.sim.damage(g.sim.id[slot], 1);
    g.audio.update(g.sim); const hits = g.audio.snapshot().played;
    g.audio.stop();
    for (const slot of [0, g.sim.used / 2]) g.sim.damage(g.sim.id[slot], 10000);
    g.audio.update(g.sim); const deaths = g.audio.snapshot().played;
    g.audio.stop(); return { before, hits, deaths, stopped: g.audio.snapshot().activeVoices };
  });
  assert.ok(report.combat.hits.plutonianHit > report.combat.before.plutonianHit);
  assert.ok(report.combat.hits.sectoidHit > report.combat.before.sectoidHit);
  assert.ok(report.combat.deaths.plutonianDeath > report.combat.hits.plutonianDeath);
  assert.ok(report.combat.deaths.sectoidDeath > report.combat.hits.sectoidDeath);
  assert.equal(report.combat.stopped, 0);
  await page.reload(); await page.waitForFunction(() => window.__battle?.ready);
  await page.evaluate(() => window.__battle.setPaused(true));
  for (const [i, id] of ids.entries()) assert.equal(await page.locator(`#volume-${id}`).inputValue(), String(levels[i]));
  await page.click('#sound-panel summary'); await page.click('#diagnostics-toggle');
  assert.equal(await page.locator('#sound-panel').getAttribute('open'), null);
  await page.click('#sound-panel summary'); assert.equal(await page.locator('#diagnostics').isVisible(), false);
  await page.locator('#sound-panel summary').focus(); await page.keyboard.press('Space');
  assert.equal(await page.locator('#sound-panel').getAttribute('open'), null);
  assert.equal(await page.evaluate(() => window.__battle.paused), true);
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const phone = await mobile.newPage(); phone.on('pageerror', error => errors.push(error.message));
  await phone.goto(url); await phone.waitForFunction(() => window.__battle?.ready);
  await phone.evaluate(() => window.__battle.setPaused(true));
  await phone.tap('#sound-panel summary'); await phone.waitForFunction(() => window.__battle.audio.state === 'running');
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  for (const id of ids) assert.equal(await phone.locator(`#preview-${id}`).isVisible(), true);
  await phone.tap('#preview-sectoidDeath');
  assert.equal(await phone.evaluate(() => window.__battle.audio.snapshot().played.sectoidDeath), 1);
  await phone.screenshot({ path: 'artifacts/sound-panel-mobile.png' });
  await phone.setViewportSize({ width: 320, height: 568 });
  await phone.locator('#preview-sectoidDeath').scrollIntoViewIfNeeded(); await phone.tap('#preview-sectoidDeath');
  const bounds = await phone.locator('#sound-panel').boundingBox();
  assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 320 && bounds.y + bounds.height <= 568);
  assert.deepEqual(errors, []);
  await writeFile('artifacts/audio-report.json', JSON.stringify({ passed: true, report, errors }, null, 2));
  console.log(JSON.stringify({ passed: true, report, errors }, null, 2));
} finally { await browser.close(); }
