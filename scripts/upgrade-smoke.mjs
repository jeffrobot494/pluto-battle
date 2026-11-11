import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const candidate = `${process.env.USERPROFILE}/AppData/Local/ms-playwright/chromium-1169/chrome-win/chrome.exe`;
const browser = await chromium.launch({ executablePath: process.env.BATTLE_CHROMIUM ?? (existsSync(candidate) ? candidate : undefined), args: process.env.BATTLE_SOFTWARE ? ['--use-angle=swiftshader'] : ['--use-angle=d3d11', '--force_high_performance_gpu'] });
const errors = [];
const base = new URL(process.env.BATTLE_URL ?? 'http://localhost:5181/'); base.searchParams.set('flat', '1');
const url = base.href;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const SNIPER = 2, SHOTGUN = 3;

/** Paused 3 vs 3 on flat ground: friends at x = -2, 0, 2 (z = 0) plus one at x = 14; enemies far away at z = -20. */
async function fixture(page) {
  return page.evaluate(() => {
    const g = window.__battle; g.restart(4); g.setPaused(true); g.renderer.resetCamera();
    const spots = [[-2, 0], [0, 0], [2, 0], [14, 0], [-3, -20], [0, -20], [3, -20], [6, -20]];
    for (let i = 0; i < g.sim.used; i++) {
      const [x, z] = spots[i];
      g.sim.x[i] = g.sim.previousX[i] = x; g.sim.z[i] = g.sim.previousZ[i] = z; g.sim.grid.insert(i, x, z);
    }
    g.step(0);
    const screen = id => g.soldierScreen(id);
    const ids = Array.from(g.sim.id.slice(0, g.sim.used));
    const ground = (x, z) => { const p = g.renderer.project(x, 0, z); return { x: (p.x + 1) * innerWidth / 2, y: (1 - p.y) * innerHeight / 2 }; };
    return { ids, teams: Array.from(g.sim.team.slice(0, g.sim.used)), soldiers: ids.map(screen), center: ground(0, 0), empty: ground(-10, 12) };
  });
}
const inventory = (page, slot) => page.evaluate(i => window.__battle.sim.inventory[i], slot);
const has = (mask, weapon) => !!(mask & (1 << weapon));
function watch(page) { page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); }); }

const report = {};
try {
  await mkdir('artifacts', { recursive: true });
  // ---------- Desktop mouse ----------
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage(); watch(page);
  await page.goto(url); await page.waitForFunction(() => window.__battle?.ready);
  let f = await fixture(page);

  // Tap selects and shows the card; tapping empty ground deselects.
  await page.mouse.click(f.soldiers[1].x, f.soldiers[1].y);
  assert.equal(await page.evaluate(() => window.__battle.selectedSoldier), f.ids[1]);
  assert.equal(await page.isVisible('#soldier-card'), true);
  assert.match(await page.textContent('#soldier-card'), /Plutonian[\s\S]*100 \/ 100 HP[\s\S]*Laser rifle/);
  assert.equal(await page.evaluate(() => window.__battle.renderer.selectionRing.visible), true);
  await page.screenshot({ path: 'artifacts/upgrade-select-desktop.png' });
  await page.mouse.click(f.empty.x, f.empty.y);
  assert.equal(await page.evaluate(() => window.__battle.selectedSoldier), 0);
  assert.equal(await page.isVisible('#soldier-card'), false);

  // Exclusive toggles: pressing another switches, pressing the active one clears.
  const pressed = () => page.$$eval('[data-upgrade]', buttons => buttons.map(b => b.getAttribute('aria-pressed')).join(','));
  await page.click('[data-upgrade="sniper"]'); assert.equal(await pressed(), 'true,false,false');
  await page.click('[data-upgrade="shotgun"]'); assert.equal(await pressed(), 'false,true,false');
  await page.click('[data-upgrade="shotgun"]'); assert.equal(await pressed(), 'false,false,false');
  await page.keyboard.press('1'); assert.equal(await pressed(), 'true,false,false');
  await page.keyboard.press('Escape'); assert.equal(await pressed(), 'false,false,false');

  // A hold with nothing armed grows a neutral zone and does nothing on release.
  await page.mouse.move(f.center.x, f.center.y); await page.mouse.down(); await wait(700);
  const neutral = await page.evaluate(() => window.__battle.zone);
  assert.ok(neutral && neutral.radius > 2 && neutral.color === '#ece6f0', JSON.stringify(neutral));
  assert.equal(await page.evaluate(() => window.__battle.renderer.zoneFill.visible), true);
  await page.screenshot({ path: 'artifacts/upgrade-zone-neutral.png' });
  await page.mouse.up();
  assert.equal(await page.evaluate(() => window.__battle.sim.totalUpgrades), 0);

  // Sniper hold over the centre upgrades the nearby friends only.
  await page.keyboard.press('1');
  await page.mouse.move(f.center.x, f.center.y); await page.mouse.down(); await wait(650);
  const armed = await page.evaluate(() => window.__battle.zone);
  assert.equal(armed.color, '#7fd6ff'); assert.ok(armed.radius > 2.5 && armed.radius < 10, `radius ${armed.radius}`);
  await page.screenshot({ path: 'artifacts/upgrade-zone-sniper.png' });
  await page.mouse.up();
  for (const slot of [0, 1, 2]) assert.ok(has(await inventory(page, slot), SNIPER), `friend ${slot} upgraded`);
  assert.ok(!has(await inventory(page, 3), SNIPER), 'distant friend unchanged');
  for (const slot of [4, 5, 6, 7]) assert.ok(!has(await inventory(page, slot), SNIPER), 'enemies unchanged');
  assert.match(await page.textContent('#upgrade-status'), /3 soldiers → Sniper rifle/);
  await page.evaluate(() => window.__battle.step(1));
  assert.ok(await page.evaluate(() => window.__battle.renderer.upgradePulses.count) > 0, 'upgrade pulse rendered');
  await page.screenshot({ path: 'artifacts/upgrade-pulse.png' });

  // Dragging before the hold begins pans the camera instead.
  const before = await page.evaluate(() => window.__battle.sim.totalUpgrades);
  await page.keyboard.press('2');
  await page.mouse.move(f.center.x, f.center.y); await page.mouse.down(); await page.mouse.move(f.center.x + 80, f.center.y + 40, { steps: 4 }); await wait(500);
  assert.equal(await page.evaluate(() => window.__battle.zone), null);
  await page.mouse.up();
  assert.equal(await page.evaluate(() => window.__battle.sim.totalUpgrades), before);

  // Tap-upgrading one soldier with the shotgun armed works on either army.
  f = await fixture(page); await page.keyboard.press('2');
  await page.mouse.click(f.soldiers[3].x, f.soldiers[3].y);
  assert.ok(has(await inventory(page, 3), SHOTGUN)); assert.ok(!has(await inventory(page, 1), SHOTGUN));
  assert.equal(await page.evaluate(() => window.__battle.selectedSoldier), f.ids[3]);
  assert.match(await page.textContent('#soldier-card'), /Laser rifle[\s\S]*Shotgun/);
  await page.mouse.click(f.soldiers[5].x, f.soldiers[5].y);
  assert.equal(await page.evaluate(() => window.__battle.selectedSoldier), f.ids[5]);
  assert.ok(has(await inventory(page, 5), SHOTGUN), 'tapped Sectoid upgraded');
  assert.match(await page.textContent('#soldier-card'), /Sectoid[\s\S]*Shotgun/);
  assert.match(await page.textContent('#upgrade-status'), new RegExp(`Soldier #${f.ids[5]} → Shotgun`));

  // The army switch: S cycles Plutonians → Sectoids → both; clicks pick directly.
  const target = () => page.evaluate(() => window.__battle.upgradeTarget);
  const checked = () => page.$$eval('[data-target]', buttons => buttons.map(b => b.getAttribute('aria-checked')).join(','));
  assert.equal(await target(), 'plutonians'); assert.equal(await checked(), 'true,false,false');
  await page.keyboard.press('s'); assert.equal(await target(), 'sectoids'); assert.equal(await checked(), 'false,true,false');
  await page.keyboard.press('s'); assert.equal(await target(), 'both');
  await page.keyboard.press('s'); assert.equal(await target(), 'plutonians');
  await page.click('[data-target="sectoids"]'); assert.equal(await target(), 'sectoids');
  assert.match(await page.textContent('#upgrade-status'), /Shotgun → Sectoids/);
  await page.screenshot({ path: 'artifacts/upgrade-target-sectoids.png' });

  // A Sectoid-targeted zone over the enemy line upgrades only Sectoids; one over the friends finds nobody.
  f = await fixture(page); await page.keyboard.press('1');
  const enemyCenter = await page.evaluate(() => { const p = window.__battle.renderer.project(1.5, 0, -20); return { x: (p.x + 1) * innerWidth / 2, y: (1 - p.y) * innerHeight / 2 }; });
  await page.mouse.move(enemyCenter.x, enemyCenter.y); await page.mouse.down(); await wait(800); await page.mouse.up();
  const enemyUpgraded = [];
  for (const slot of [4, 5, 6, 7]) enemyUpgraded.push(has(await inventory(page, slot), SNIPER));
  assert.ok(enemyUpgraded.filter(Boolean).length >= 2, `enemies upgraded ${enemyUpgraded}`);
  for (const slot of [0, 1, 2, 3]) assert.ok(!has(await inventory(page, slot), SNIPER), 'friends unchanged by a Sectoid zone');
  await page.mouse.move(f.center.x, f.center.y); await page.mouse.down(); await wait(500); await page.mouse.up();
  for (const slot of [0, 1, 2]) assert.ok(!has(await inventory(page, slot), SNIPER), 'friends still unchanged');
  assert.match(await page.textContent('#upgrade-status'), /No Sectoids in range/);

  // "Both" reaches every soldier in the zone.
  f = await fixture(page); await page.click('[data-target="both"]');
  assert.equal(await page.evaluate(() => window.__battle.upgradeArea('shotgun', 0, -10, 999)), 8);
  for (let slot = 0; slot < 8; slot++) assert.ok(has(await inventory(page, slot), SHOTGUN), `both upgraded ${slot}`);
  await page.click('[data-target="plutonians"]');

  // A live battle: upgraded friends switch weapons and fire.
  await page.evaluate(() => { const g = window.__battle; g.restart(4); g.setPaused(true); });
  const live = await page.evaluate(() => {
    const g = window.__battle; g.upgradeArea('sniper', 0, 0, 999);
    g.setPaused(false); return g.sim.totalUpgrades;
  });
  assert.equal(live, 4);
  await page.waitForFunction(() => Array.from(window.__battle.sim.weapon.slice(0, 4)).includes(2), null, { timeout: 15000 });

  // Explosion mode keeps taps for detonation.
  f = await fixture(page); await page.evaluate(() => window.__battle.setPaused(false));
  await page.click('#explosion-toggle');
  await page.mouse.click(f.center.x, f.center.y);
  await page.waitForFunction(() => window.__battle.sim.totalExplosions === 1);
  assert.equal(await page.evaluate(() => window.__battle.selectedSoldier), 0);
  await page.click('#restart');
  assert.equal(await pressed(), 'false,false,false');
  await context.close();

  // ---------- Phone touch ----------
  const phone = await browser.newContext({ viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const mobile = await phone.newPage(); watch(mobile);
  await mobile.goto(url); await mobile.waitForFunction(() => window.__battle?.ready);
  f = await fixture(mobile);
  const layout = await mobile.evaluate(() => {
    const box = s => document.querySelector(s).getBoundingClientRect().toJSON();
    return { rail: box('#upgrade-menu'), zoom: box('.view-controls'), bar: box('.bottom-bar') };
  });
  assert.ok(layout.rail.right <= 412 && layout.rail.bottom < layout.zoom.top, JSON.stringify(layout));
  await mobile.tap('[data-target="sectoids"]');
  assert.equal(await mobile.evaluate(() => window.__battle.upgradeTarget), 'sectoids');
  await mobile.tap('[data-target="plutonians"]');
  await mobile.tap('[data-upgrade="sniper"]');
  assert.equal(await mobile.getAttribute('[data-upgrade="sniper"]', 'aria-pressed'), 'true');
  const cdp = await phone.newCDPSession(mobile);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  await touch('touchStart', f.center.x, f.center.y); await wait(650);
  await touch('touchMove', f.center.x + 3, f.center.y + 2); await wait(100);
  assert.ok((await mobile.evaluate(() => window.__battle.zone))?.radius > 2);
  await mobile.screenshot({ path: 'artifacts/upgrade-zone-phone.png' });
  await touch('touchEnd');
  for (const slot of [0, 1, 2]) assert.ok(has(await inventory(mobile, slot), SNIPER), `touch upgraded ${slot}`);
  // Finger drag before the hold pans.
  const panned = await mobile.evaluate(() => window.__battle.sim.totalUpgrades);
  await mobile.tap('[data-upgrade="shotgun"]');
  await touch('touchStart', f.center.x, f.center.y); await touch('touchMove', f.center.x + 40, f.center.y + 30); await wait(500); await touch('touchEnd');
  assert.equal(await mobile.evaluate(() => window.__battle.sim.totalUpgrades), panned);
  f = await fixture(mobile);
  await mobile.tap('[data-upgrade="shotgun"]');
  await mobile.touchscreen.tap(f.soldiers[2].x, f.soldiers[2].y);
  assert.ok(has(await inventory(mobile, 2), SHOTGUN));
  assert.equal(await mobile.isVisible('#soldier-card'), true);
  await mobile.screenshot({ path: 'artifacts/upgrade-select-phone.png' });
  report.layout = layout;
  await phone.close();

  assert.deepEqual(errors, []);
  await writeFile('artifacts/upgrade-report.json', JSON.stringify({ ok: true, ...report }, null, 2));
  console.log('Upgrade smoke passed.');
} catch (error) {
  console.error(error); process.exitCode = 1;
} finally { await browser.close(); }
