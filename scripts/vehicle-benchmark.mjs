import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { launchBattleBrowser, serveBattleBuild } from './battle-browser.mjs';

const warmup = Number(process.env.BATTLE_WARMUP ?? 5);
const duration = Number(process.env.BATTLE_SECONDS ?? 30);
assert.ok(warmup >= 0 && warmup <= 300 && duration >= 1 && duration <= 600, 'Use 0–300 seconds of warmup and 1–600 seconds of recording.');
const scenarios = (process.env.BATTLE_SCENARIOS ?? 'infantry,packed,infantry-spread,sparse,mixed').split(',');
const url = new URL(process.env.BATTLE_URL ?? 'http://localhost:5181/');
if (!url.searchParams.has('terrain')) url.searchParams.set('terrain', '74319');
const browser = await launchBattleBrowser();
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await serveBattleBuild(context, url);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url.href); await page.waitForFunction(() => window.__battle?.ready);
  await page.evaluate(quality => window.__battle.renderer.setQuality(quality), process.env.BATTLE_QUALITY ?? 'low');
  const reports = [];
  for (const scenario of scenarios) {
    const started = await page.evaluate(({ warmup, duration, scenario }) => window.__battle.startBenchmark(warmup, duration, scenario), { warmup, duration, scenario });
    assert.ok(started, `Could not start ${scenario}`);
    await page.waitForFunction(() => !window.__battle.benchmark.active, null, { timeout: (warmup + duration + 60) * 1000 });
    const report = await page.evaluate(() => window.__battle.benchmark.report);
    assert.ok(report, `Capture did not complete: ${await page.textContent('#benchmark-status')}`);
    assert.equal(report.live, 1000);
    assert.ok(report.averageDrawCalls > 0);
    reports.push(report);
    console.log(`${scenario}: ${report.fps.toFixed(1)} FPS, ${report.simulationHz.toFixed(1)} Hz, p95/p99 ${report.p95.toFixed(1)}/${report.p99.toFixed(1)} ms, ${report.vehicles.work.peakTrucks} peak trucks`);
  }
  assert.deepEqual(errors, []);
  await mkdir('artifacts', { recursive: true });
  await writeFile(process.env.BATTLE_REPORT ?? 'artifacts/vehicle-benchmark.json', JSON.stringify({
    note: 'Desktop development measurement. Physical Pixel 10 acceptance is separate.', map: await page.evaluate(() => window.__battle.map), reports,
  }, null, 2));
} finally { await browser.close(); }
