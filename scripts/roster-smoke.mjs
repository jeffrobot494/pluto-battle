import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const candidate = `${process.env.USERPROFILE}/AppData/Local/ms-playwright/chromium-1169/chrome-win/chrome.exe`;
const executablePath = process.env.BATTLE_CHROMIUM ?? (existsSync(candidate) ? candidate : undefined);
const browser = await chromium.launch({ executablePath, args: ['--use-angle=d3d11', '--force_high_performance_gpu'] });
const url = process.env.BATTLE_URL ?? 'http://localhost:5180/';
const errors = [];
try {
  await mkdir('artifacts', { recursive: true });
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 412, height: 915 }]) {
    const page = await (await browser.newContext({ viewport, deviceScaleFactor: 1 })).newPage();
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(url); await page.waitForFunction(() => window.__battle?.ready);
    await page.evaluate(() => window.__battle.setPaused(true));
    assert.equal(await page.evaluate(() => window.__battle.roster.size), 1000);

    // The roster is a tab of the tuning panel.
    await page.click('#tuning-toggle'); await page.click('[data-page-tab="roster"]');
    assert.match(await page.locator('#roster-summary').textContent(), /1000 soldiers/);
    await page.screenshot({ path: `artifacts/roster-tab-${viewport.width}.png` });

    // Drafted Plutonians carry roster names; the card shows name and level.
    const id = await page.evaluate(() => { const b = window.__battle, sim = b.sim; const i = [...Array(sim.used).keys()].find(i => sim.team[i] === 0); b.selectSoldier(sim.id[i]); return sim.id[i]; });
    const name = await page.evaluate(id => window.__battle.battleRoster.soldier(id).name, id);
    assert.match(await page.locator('#soldier-card').textContent(), new RegExp(`${name}\\s*LV 1\\b`));
    await page.evaluate(() => window.__battle.selectSoldier(0));

    // View lists the living Plutonians.
    await page.click('#roster-view');
    const perTeam = await page.evaluate(() => window.__battle.tuning.count);
    assert.equal(await page.locator('#soldier-list li[data-sim-id]').count(), perTeam);
    await page.screenshot({ path: `artifacts/roster-list-${viewport.width}.png` });
    await page.keyboard.press('Escape'); assert.equal(await page.locator('#soldier-list').isVisible(), false);

    // Survivors level up exactly once when the battle ends.
    const survivors = await page.evaluate(() => {
      const b = window.__battle, sim = b.sim;
      let kept = 0;
      for (let i = 0; i < sim.used; i++) if (sim.team[i] === 1 || kept++ >= 7) sim.hp[i] = 0;
      sim.alive[0] = 7; sim.alive[1] = 0;
      b.step(2); b.step(1);
      return b.battleRoster.living().map(s => s.record.id);
    });
    assert.equal(survivors.length, 7);
    const levels = await page.evaluate(ids => ids.map(id => window.__battle.roster.get(id).level), survivors);
    assert.deepEqual(levels, Array(7).fill(2));
    assert.equal(await page.evaluate(() => window.__battle.roster.list().filter(r => r.level > 1).length), 7);
    assert.match(await page.locator('#roster-summary').textContent(), /7 veterans · top level 2/);
    await page.click('#roster-view');
    assert.equal(await page.locator('#soldier-list li[data-sim-id]').count(), 7);
    await page.click('#close-soldier-list');

    // A soldier who dies drops to level 1 at once; the rest keep their levels.
    const afterDeath = await page.evaluate(() => {
      const b = window.__battle; b.restartMap(); b.setPaused(true);
      const sim = b.sim, slots = [...Array(sim.used).keys()].filter(i => sim.team[i] === 0);
      const ids = slots.map(i => b.battleRoster.soldier(sim.id[i]).id);
      for (const id of ids) b.roster.update(id, { level: 3 });
      sim.hp[slots[0]] = 0; sim.alive[0]--; b.step(1);
      return { dead: b.roster.get(ids[0]).level, card: b.battleRoster.soldier(sim.id[slots[0]]).level, alive: b.roster.get(ids[1]).level };
    });
    assert.deepEqual(afterDeath, { dead: 1, card: 1, alive: 3 });

    // Reset needs a confirming second tap.
    await page.click('#roster-reset');
    assert.ok(await page.evaluate(() => window.__battle.roster.list().some(r => r.level > 1)));
    await page.click('#roster-reset');
    assert.ok(await page.evaluate(() => window.__battle.roster.list().every(r => r.level === 1)));
    assert.match(await page.locator('#roster-summary').textContent(), /1000 soldiers · 0 veterans · top level 1/);
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log('Roster smoke passed.');
} finally { await browser.close(); }
