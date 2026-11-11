/// <reference types="vite/client" />
// Loads saved settings from RUN before any module below reads them.
import './rundot-storage.ts';
import './style.css';
import { CONFIG } from './config.ts';
import { BattleSimulation } from './simulation.ts';
import { BattleRenderer } from './renderer.ts';
import { loadTuning, saveTuning, deploymentError } from './tuning.ts';
import { TuningPanel } from './tuning-panel.ts';
import { BattleAudio, SOUND_EFFECTS } from './audio.ts';
import { copyEquipment, loadEquipment, saveEquipment, validateEquipment, type EquipmentSettings } from './equipment.ts';
import { EquipmentPanel } from './equipment-panel.ts';
import { prepareTerrain } from './navigation.ts';
import { archetypeById, pickArchetype } from './terrain-archetypes.ts';
import { PerformanceCapture } from './performance-capture.ts';
import { BattleInput, type GroundPoint } from './battle-input.ts';
import { UpgradeMenu } from './upgrade-menu.ts';
import { SoldierCard } from './soldier-card.ts';
import { NEUTRAL_ZONE_COLOR, PLAYER_TEAM, UPGRADES, zoneRadius, type Upgrade, type UpgradeId } from './upgrades.ts';

const icons = {
  pause: '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M5 4h3v12H5zm7 0h3v12h-3z"/></svg>',
  play: '<svg viewBox="0 0 20 20" fill="currentColor"><path d="m6 3 11 7-11 7z"/></svg>',
  restart: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4.6 5a7 7 0 1 1-1.3 7M4 1v5h5"/></svg>',
  map: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m2 15 5-9 3 5 2-3 6 7z"/><circle cx="14.5" cy="4.5" r="1.6"/></svg>',
  focus: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M7 3H3v4m10-4h4v4M3 13v4h4m10-4v4h-4"/><circle cx="10" cy="10" r="2.5"/></svg>',
  stats: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 14h3l3-9 4 12 3-8h3"/></svg>',
  sound: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M3 8h3l4-4v12l-4-4H3zM13 7a5 5 0 0 1 0 6m3-9a9 9 0 0 1 0 12"/></svg>',
};

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <main id="battle-app">
    <div id="viewport"></div><div class="vignette" aria-hidden="true"></div>
    <header class="top-bar">
      <div class="brand"><span class="planet-mark" aria-hidden="true"></span><h1>PLUTO<span>MASS COMBAT</span></h1><span class="prototype-label">PROTOTYPE 001</span></div>
      <div class="sector"><span class="sector-cross" aria-hidden="true">✣</span><div><span id="map-name">TEST RANGE</span><small id="map-region">FLAT FIXTURE</small></div></div>
    </header>
    <section class="army-hud" aria-label="Army status">
      <div class="army plutonians"><div class="army-label"><span class="team-symbol">Ⅰ</span><div>PLUTONIANS<small>EXPEDITIONARY CORPS</small></div></div><div class="army-count"><strong id="pluto-count">100</strong><span>ACTIVE</span></div><div class="strength-track"><div id="pluto-strength"></div></div></div>
      <div class="battle-readout"><span id="state-label"><i></i> LIVE BATTLE</span><time id="battle-time">00:00</time><span class="versus">VS</span></div>
      <div class="army sectoids"><div class="army-label"><span class="team-symbol">Ⅲ</span><div>SECTOIDS<small>HOSTILE WAR PARTY</small></div></div><div class="army-count"><strong id="sectoid-count">100</strong><span>ACTIVE</span></div><div class="strength-track"><div id="sectoid-strength"></div></div></div>
    </section>
    <div class="field-label" aria-hidden="true"><span class="coordinate-line"></span><span>07 / ALIEN SURFACE</span><small>NO ORDERS REQUIRED.</small></div>
    <div class="view-controls" aria-label="Camera controls"><button id="zoom-in" aria-label="Zoom in" title="Zoom in">+</button><span></span><button id="zoom-out" aria-label="Zoom out" title="Zoom out">−</button></div>
    <section id="outcome" class="outcome" hidden aria-live="polite"><span>ENGAGEMENT COMPLETE</span><h2 id="outcome-title"></h2><p id="outcome-description"></p><button id="play-again">New battle, new map <span>↗</span></button></section>
    <div id="paused-notice" class="paused-notice" hidden>SIMULATION PAUSED</div>
    <button id="explosion-toggle" class="explosion-toggle" aria-pressed="false" aria-describedby="explosion-status"><span aria-hidden="true">✳</span> Test explosions <small>OFF</small></button>
    <p id="explosion-status" class="explosion-status" role="status" hidden>Click or tap ground to detonate · drag to pan</p>
    <footer class="bottom-bar">
      <div class="battle-note"><span class="status-light"></span><div id="engagement-label">ARMIES ADVANCING<small>100 vs 100 · AUTOMATIC ENGAGEMENT</small></div></div>
      <nav class="battle-controls" aria-label="Battle controls"><button id="pause" class="primary">${icons.pause}<span>Pause</span></button><button id="restart" title="Restart on this map (R)">${icons.restart}<span>Restart</span></button><button id="new-map" title="New battle on a new map (N)">${icons.map}<span>New map</span></button><button id="center">${icons.focus}<span>Center view</span></button></nav>
      <button id="diagnostics-toggle" class="performance-badge" aria-expanded="false" aria-controls="diagnostics" title="Performance and battle settings (D)">${icons.stats}<strong id="fps-label">—</strong><span>FPS</span></button>
    </footer>
    <div class="input-hint">TAP SELECT <span>·</span> HOLD ZONE <span>·</span> DRAG PAN <span>·</span> RIGHT-DRAG ORBIT <span>·</span> SCROLL / PINCH ZOOM <span>·</span> 1 / 2 UPGRADE</div>
    <details id="sound-panel" class="sound-panel">
      <summary>${icons.sound}<span>Sound effects</span><span id="sound-state">TAP TO ENABLE</span><span class="sound-chevron" aria-hidden="true">⌃</span></summary>
      <div class="sound-settings">
        <p id="sound-status" role="status">Tap or press a key to enable audio.</p>
        ${SOUND_EFFECTS.map(({ id, label, volume }) => `<div class="sound-control"><div class="sound-label"><label for="volume-${id}">${label}</label><output id="level-${id}" for="volume-${id}">${volume}%</output></div><div class="sound-slider"><input id="volume-${id}" type="range" min="0" max="100" step="1" value="${volume}"/><button id="preview-${id}" aria-label="Preview ${label.toLowerCase()}" title="Preview ${label.toLowerCase()}">${icons.play}</button></div></div>`).join('')}
        <p class="sound-help">0% mutes an effect. Levels save automatically.</p>
      </div>
    </details>
    <aside id="diagnostics" hidden aria-label="Performance and battle settings">
      <div class="panel-heading"><span>FIELD DIAGNOSTICS</span><button id="close-diagnostics" aria-label="Close diagnostics">×</button></div>
      <dl id="metrics"></dl>
      <div class="settings"><label for="deployment">Deployment preset <select id="deployment"><option value="custom" disabled>Custom · tuning panel</option><option value="100">100 vs 100</option><option value="250">250 vs 250</option><option value="500">500 vs 500</option></select></label><label for="quality">Visual quality <select id="quality"><option value="balanced">Adaptive · up to 1.5× pixels</option><option value="low">Low · up to 1× pixels</option></select></label><button id="apply-battle">Deploy preset ${icons.restart}</button></div>
      <p>Restart replays this map; New map (N) rolls a different landscape. Target: 60 FPS at 500 vs 500 on Pixel 10. Physical-phone validation pending.</p>
      <div class="settings"><button id="benchmark-start">Benchmark 500 vs 500 · 15 min</button><button id="benchmark-save" disabled>Save benchmark report</button></div>
      <p id="benchmark-status" role="status">5-minute warmup, then 10-minute recording. Keep the page visible.</p>
    </aside>
    <div id="error" hidden role="alert"></div>
  </main>`;

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
let tuning = loadTuning();
let tuningPanel: TuningPanel;
let equipment = loadEquipment();
let equipmentPanel: EquipmentPanel;
let renderer: BattleRenderer;
try { renderer = new BattleRenderer($('#viewport'), tuning); }
catch (error) { $('#error').hidden = false; $('#error').textContent = `The battlefield could not start. Enable WebGL and reload. ${error instanceof Error ? error.message : ''}`; throw error; }

const audio = new BattleAudio(updateSoundStatus);
const soundPanel = $<HTMLDetailsElement>('#sound-panel');

function updateSoundStatus() {
  const state = audio.state;
  $('#sound-state').textContent = state === 'running' ? 'ON' : state === 'unavailable' ? 'UNAVAILABLE' : 'TAP TO ENABLE';
  $('#sound-status').textContent = state === 'running' ? 'Battle audio on. Preview a sound to tune its level.'
    : state === 'unavailable' ? 'Audio is unavailable in this browser. The battle can still run.'
      : 'Tap or press a key to enable audio.';
}
for (const { id } of SOUND_EFFECTS) {
  const slider = $<HTMLInputElement>(`#volume-${id}`), level = $<HTMLOutputElement>(`#level-${id}`);
  slider.value = String(audio.getVolume(id)); level.value = `${slider.value}%`;
  slider.addEventListener('input', () => { audio.setVolume(id, Number(slider.value)); level.value = `${slider.value}%`; });
  $(`#preview-${id}`).addEventListener('click', () => { void audio.preview(id); });
}
// Browsers require a user gesture before the automatically running battle can make sound.
const audioEvents = new AbortController();
const unlockAudio = () => { if (!document.hidden) void audio.unlock(); };
document.addEventListener('pointerdown', unlockAudio, { capture: true, signal: audioEvents.signal });
document.addEventListener('keydown', unlockAudio, { capture: true, signal: audioEvents.signal });
soundPanel.addEventListener('toggle', () => { if (soundPanel.open) { toggleDiagnostics(false); tuningPanel?.toggle(false); equipmentPanel?.toggle(false); } });

let perTeam = tuning.count, seed = tuning.seed;
const parameters = new URLSearchParams(location.search);
const flatFixture = parameters.get('flat') === '1';
function freshTerrainSeed() { return crypto.getRandomValues(new Uint32Array(1))[0]; }
// `?map=<archetype>` pins every battle to one landscape type.
const forcedArchetype = archetypeById(parameters.get('map') ?? '')?.id;
/** A fresh seed whose landscape type differs from the current one, so rerolls always look new. */
function freshMapSeed() {
  const current = prepared?.terrain.archetype;
  let next = freshTerrainSeed();
  for (let i = 0; !forcedArchetype && i < 24 && pickArchetype(next).id === current; i++) next = freshTerrainSeed();
  return next;
}
let terrainSeed = parameters.has('terrain') ? Number(parameters.get('terrain')) >>> 0 : freshTerrainSeed();
let prepared: ReturnType<typeof prepareTerrain> | null = null;
prepared = flatFixture ? null : prepareTerrain(tuning, terrainSeed, forcedArchetype);
let sim = new BattleSimulation(perTeam, seed, CONFIG.capacity, tuning, prepared?.terrain, prepared?.navigation, equipment), paused = false, accumulator = 0, endAge = 0;
let explosionTesting = false;
const canDetonate = () => !paused && !document.hidden && sim.result === 'running';

// Ability zone: grows from a held ground point; on release the armed action applies inside it.
let zone: { point: GroundPoint; start: number; released: number; radius: number; color: string } | null = null;
const ZONE_FADE_MS = 320;
function zoneColor() { return upgradeMenu?.selected?.color ?? NEUTRAL_ZONE_COLOR; }
function maxZoneRadius() { return Math.hypot(sim.grid.halfWidth, sim.grid.halfDepth) * 2; }
function updateZone(now: number) {
  if (!zone) return;
  if (!zone.released) { zone.radius = zoneRadius((now - zone.start) / 1000, maxZoneRadius()); zone.color = zoneColor(); }
  const fade = zone.released ? 1 - (now - zone.released) / ZONE_FADE_MS : 1;
  if (fade <= 0) { zone = null; renderer.setZone(null); return; }
  // The release flashes slightly wider so the moment of activation reads clearly.
  renderer.setZone(zone.point, zone.radius * (zone.released ? 1 + (1 - fade) * 0.06 : 1), zone.color, fade);
}

/** Gives `upgrade` to friendly soldiers; returns how many gained a new weapon. */
function upgradeArea(upgrade: Upgrade, point: { x: number; z: number }, radius: number) {
  if (sim.result !== 'running') return 0;
  const count = sim.upgradeCandidates(PLAYER_TEAM, point.x, point.z, radius, upgrade.weapon);
  sim.queue({ type: 'upgradeArea', team: PLAYER_TEAM, x: point.x, z: point.z, radius, weapon: upgrade.weapon });
  if (paused) { sim.flushCommands(); soldierCard.update(sim); }
  return count;
}
function upgradeSoldier(upgrade: Upgrade, id: number) {
  const i = sim.byId.get(id);
  if (i === undefined || sim.result !== 'running' || sim.hp[i] <= 0 || sim.team[i] !== PLAYER_TEAM) return false;
  const gained = !(sim.inventory[i] & (1 << upgrade.weapon));
  sim.queue({ type: 'upgrade', ids: [id], weapon: upgrade.weapon });
  if (paused) sim.flushCommands();
  return gained;
}
function selectSoldier(id: number) {
  renderer.selectedId = id; soldierCard.show(id); soldierCard.update(sim); soldierCard.position(sim, renderer);
}
function onTap(clientX: number, clientY: number) {
  if (explosionTesting) {
    if (canDetonate()) { const point = renderer.pickGround(clientX, clientY, sim); if (point) explode(point); }
    return;
  }
  const slot = renderer.pickSoldier(clientX, clientY, sim);
  if (slot < 0) { selectSoldier(0); return; }
  const id = sim.id[slot], upgrade = upgradeMenu.selected;
  if (upgrade && sim.team[slot] === PLAYER_TEAM) {
    if (sim.result !== 'running') upgradeMenu.say('Battle ended · start a new battle to upgrade');
    else upgradeMenu.say(upgradeSoldier(upgrade, id) ? `Soldier #${id} → ${upgrade.name}` : `Soldier #${id} already carries a ${upgrade.name.toLowerCase()}`);
  }
  selectSoldier(id);
}
const input = new BattleInput(renderer.webgl.domElement, {
  pick: (x, y) => renderer.pickGround(x, y, sim),
  tap: onTap,
  holdStart(point) { zone = { point, start: performance.now(), released: 0, radius: 0, color: zoneColor() }; updateZone(performance.now()); },
  holdEnd(commit) {
    if (!zone) return;
    const now = performance.now(), upgrade = upgradeMenu.selected;
    zone.radius = zoneRadius((now - zone.start) / 1000, maxZoneRadius()); zone.color = zoneColor();
    if (commit && upgrade) {
      if (sim.result !== 'running') upgradeMenu.say('Battle ended · start a new battle to upgrade');
      else { const count = upgradeArea(upgrade, zone.point, zone.radius); upgradeMenu.say(count ? `${count} soldier${count === 1 ? '' : 's'} → ${upgrade.name}` : `No Plutonians in range without a ${upgrade.name.toLowerCase()}`); }
    }
    // A canceled hold just disappears; a released one fades out.
    if (commit) zone.released = now; else { zone = null; renderer.setZone(null); }
  },
  hover(x, y) { renderer.setExplosionPreview(explosionTesting && canDetonate() ? renderer.pickGround(x, y, sim) : null, tuning.explosionRadius); },
  hoverEnd() { renderer.setExplosionPreview(null, tuning.explosionRadius); },
  lockPan(locked) { renderer.controls.enablePan = !locked; },
});
const upgradeMenu = new UpgradeMenu($('#battle-app'), upgrade => {
  renderer.webgl.domElement.classList.toggle('upgrade-cursor', !!upgrade);
  if (zone && !zone.released) zone.color = zoneColor();
});
const soldierCard = new SoldierCard($('#battle-app'), () => selectSoldier(0));
function explode(point: GroundPoint) {
  sim.queue({ type: 'explode', ...point, radius: tuning.explosionRadius, damage: tuning.explosionDamage, impulse: tuning.explosionImpulse });
}
function setExplosionTesting(value: boolean) {
  explosionTesting = value; input.cancel(); renderer.setExplosionPreview(null, tuning.explosionRadius);
  $('#explosion-toggle').setAttribute('aria-pressed', String(value));
  $('#explosion-toggle small').textContent = value ? 'ON' : 'OFF';
  $('#explosion-status').hidden = !value;
  renderer.webgl.domElement.classList.toggle('explosion-cursor', value);
}
$('#explosion-toggle').addEventListener('click', () => setExplosionTesting(!explosionTesting));
audio.reset(sim); updateMapLabel();
let previousTime = 0, lastHudUpdate = -Infinity, hidden = document.hidden, frameHandle = 0;
let simMs = 0, renderMs = 0, lastElapsed = 16.67, frames = 0, slowFrames = 0;
let lastSimMs = 0, lastRenderMs = 0;
const intervals = new Float32Array(360), samples: number[] = [];
let intervalCursor = 0, intervalCount = 0;
let droppedSimulationSeconds = 0;
const capture = new PerformanceCapture(status => { $('#benchmark-status').textContent = status; $<HTMLButtonElement>('#benchmark-save').disabled = !capture.report; $('#benchmark-start').textContent = capture.active ? 'Stop benchmark' : 'Benchmark 500 vs 500 · 15 min'; });
let simulationHz = 0, hzTime = 0, hzTicks = 0;
const plutoCount = $('#pluto-count'), sectoidCount = $('#sectoid-count'), battleTime = $('#battle-time');
const plutoStrength = $('#pluto-strength'), sectoidStrength = $('#sectoid-strength');
const stateLabel = $('#state-label'), outcome = $('#outcome'), pauseButton = $('#pause');

function toggleDiagnostics(force?: boolean) {
  const open = force ?? $('#diagnostics').hidden; $('#diagnostics').hidden = !open;
  $('#diagnostics-toggle').setAttribute('aria-expanded', String(open));
  if (open) { soundPanel.open = false; tuningPanel?.toggle(false); equipmentPanel?.toggle(false); updateHud(); }
}
function setPaused(value: boolean) {
  if (value) stopBenchmark('Benchmark stopped: battle paused.');
  paused = value; accumulator = 0;
  previousTime = 0;
  input.cancel(); hzTime = hzTicks = simulationHz = 0;
  if (value) audio.stop();
  pauseButton.innerHTML = `${value ? icons.play : icons.pause}<span>${value ? 'Resume' : 'Pause'}</span>`;
  pauseButton.setAttribute('aria-label', value ? 'Resume battle' : 'Pause battle');
  $('#paused-notice').hidden = !value || sim.result !== 'running'; updateHud();
}
function restart(count?: number, nextSeed?: number, nextTerrainSeed?: number) {
  if (equipmentPanel && !equipmentPanel.valid) { tuningPanel.toggle(false); equipmentPanel.toggle(true); return false; }
  stopBenchmark('Benchmark stopped: new battle.');
  const candidate = { ...tuning };
  if (count !== undefined) { candidate.count = count; candidate.columns = Math.ceil(Math.sqrt(count)); }
  if (nextSeed !== undefined) candidate.seed = nextSeed;
  tuning = candidate;
  if (deploymentError(candidate)) { tuningPanel.sync(tuning, sim.tuning); equipmentPanel.toggle(false); tuningPanel.toggle(true); return false; }
  perTeam = tuning.count; seed = tuning.seed;
  terrainSeed = nextTerrainSeed === undefined ? freshMapSeed() : nextTerrainSeed >>> 0;
  prepared = flatFixture ? null : prepareTerrain(tuning, terrainSeed, forcedArchetype);
  sim = new BattleSimulation(perTeam, seed, CONFIG.capacity, tuning, prepared?.terrain, prepared?.navigation, equipment); accumulator = 0; endAge = 0;
  setExplosionTesting(false);
  input.reset(); zone = null; renderer.setZone(null); selectSoldier(0); upgradeMenu.select(null);
  audio.reset(sim);
  updateMapLabel();
  intervalCount = intervalCursor = frames = slowFrames = 0; simMs = renderMs = 0;
  previousTime = 0; droppedSimulationSeconds = 0;
  saveTuning(tuning); tuningPanel.sync(tuning, sim.tuning);
  saveEquipment(equipment); equipmentPanel.sync(equipment, sim.equipment, perTeam);
  $<HTMLSelectElement>('#deployment').value = [100, 250, 500].includes(perTeam) ? String(perTeam) : 'custom';
  outcome.hidden = true; setPaused(false); updateHud();
  return true;
}
/** Same map, fresh battle. */
const restartMap = () => restart(undefined, undefined, terrainSeed);
/** New battle on a different landscape. */
const newMap = () => restart();
function updateMapLabel() {
  const t = sim.terrain, holder = t.defender === 0 ? 'PLUTONIANS HOLD THE HEIGHTS' : t.defender === 1 ? 'SECTOIDS HOLD THE HEIGHTS' : '';
  $('#map-name').textContent = t.name.toUpperCase();
  $('#map-region').textContent = [t.region.toUpperCase(), holder].filter(Boolean).join(' · ');
}
function elapsedLabel(seconds: number) { return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`; }

function performanceSnapshot() {
  samples.length = intervalCount;
  let sum = 0;
  for (let i = 0; i < intervalCount; i++) { samples[i] = intervals[i]; sum += intervals[i]; }
  samples.sort((a, b) => a - b);
  return {
    fps: intervalCount ? 1000 / (sum / intervalCount) : 0,
    p95: samples[Math.floor(Math.max(0, intervalCount - 1) * 0.95)] ?? 0,
    p99: samples[Math.floor(Math.max(0, intervalCount - 1) * 0.99)] ?? 0,
    simMs, renderMs, frames, slowFrames,
    drawCalls: renderer.webgl.info.render.calls, triangles: renderer.webgl.info.render.triangles,
    activeEffects: renderer.activeEffects, geometries: renderer.webgl.info.memory.geometries,
    textures: renderer.webgl.info.memory.textures,
    live: sim.alive[0] + sim.alive[1], capacity: sim.capacity,
    pixelRatio: renderer.webgl.getPixelRatio(), lastElapsed,
    terrainSeed, terrainArchetype: sim.terrain.archetype, terrainRamps: sim.terrain.ramps.length, terrainGenerationMs: sim.terrain.generationMs, terrainRepairs: sim.terrain.repairs,
    navigationBuildMs: sim.navigation?.buildMs ?? 0, navigationExpansions: sim.navigation?.expansions ?? 0,
    navigationPending: sim.navigation?.fields.filter(f => f.building).length ?? 0,
    rayQueries: sim.terrain.rayQueries, rayCells: sim.terrain.rayCells,
    renderScale: renderer.resolutionScale, simulationTick: sim.tick, droppedSimulationSeconds,
    blockedUnits: sim.blockedUnits,
    simulationHz, tick: sim.tick, airborne: sim.airborne, activeBodies: sim.activeBodies,
    explosionCandidates: sim.explosionCandidates, collisionChecks: sim.collisionChecks,
    explosions: sim.totalExplosions, activeExplosions: renderer.activeExplosions, overwrittenExplosionEffects: sim.explosions.overwritten,
  };
}

function updateHud() {
  soldierCard.update(sim);
  plutoCount.textContent = String(sim.alive[0]); sectoidCount.textContent = String(sim.alive[1]); battleTime.textContent = elapsedLabel(sim.battleTime);
  $('#explosion-status').textContent = sim.result !== 'running' ? 'Battle ended · restart to test explosions' : paused ? 'Paused · resume to test explosions' : 'Click or tap ground to detonate · drag to pan';
  if (paused || sim.result !== 'running') renderer.setExplosionPreview(null, tuning.explosionRadius);
  plutoStrength.style.width = `${Math.min(100, sim.alive[0] / perTeam * 100)}%`; sectoidStrength.style.width = `${Math.min(100, sim.alive[1] / perTeam * 100)}%`;
  stateLabel.innerHTML = `<i></i> ${sim.result !== 'running' ? 'BATTLE ENDED' : paused ? 'PAUSED' : 'LIVE BATTLE'}`;
  stateLabel.classList.toggle('is-paused', paused || sim.result !== 'running');
  $('#engagement-label').innerHTML = `${sim.result !== 'running' ? 'ENGAGEMENT COMPLETE' : sim.totalShots > 0 ? 'WEAPONS FREE' : 'ARMIES ADVANCING'}<small>${perTeam} vs ${perTeam} · AUTOMATIC ENGAGEMENT</small>`;
  if (sim.result !== 'running') {
    outcome.hidden = false;
    $('#outcome-title').textContent = sim.result === 'draw' ? 'Mutual destruction.' : sim.result === 'plutonians' ? 'Plutonians hold the field.' : 'Sectoids hold the field.';
    $('#outcome-description').textContent = `${sim.alive[0] + sim.alive[1]} survivors · ${sim.totalShots.toLocaleString()} shots fired · ${elapsedLabel(sim.battleTime)}`;
    $('#paused-notice').hidden = true;
  }
  const stats = performanceSnapshot(); $('#fps-label').textContent = stats.fps ? String(Math.round(stats.fps)) : '—';
  $('#diagnostics-toggle').classList.toggle('slow', stats.fps > 0 && stats.fps < 50);
  if (!$('#diagnostics').hidden) {
    const entries = [
      ['Frame p95 / p99', `${stats.p95.toFixed(1)} / ${stats.p99.toFixed(1)} ms`],
      ['Simulation / frame', `${stats.simMs.toFixed(2)} ms`], ['Render submission', `${stats.renderMs.toFixed(2)} ms`],
      ['Draw calls / triangles', `${stats.drawCalls} / ${(stats.triangles / 1000).toFixed(1)}k`],
      ['Live units / effects', `${stats.live} / ${stats.activeEffects}`], ['Unit capacity', `${stats.capacity}`],
      ['Geometry / textures', `${stats.geometries} / ${stats.textures}`], ['Pixel ratio', `${stats.pixelRatio.toFixed(2)}×`],
      ['Simulation rate', `${stats.simulationHz.toFixed(1)} Hz`], ['Airborne / moving bodies', `${stats.airborne} / ${stats.activeBodies}`],
      ['Blast candidates / contacts', `${stats.explosionCandidates} / ${stats.collisionChecks}`],
      ['Explosions / visible', `${stats.explosions} / ${stats.activeExplosions}`], ['Overwritten blast visuals', String(stats.overwrittenExplosionEffects)],
      ['Frames > 33.4 ms', `${stats.slowFrames} / ${stats.frames}`],
      ['Terrain seed / map', `${stats.terrainSeed} / ${stats.terrainArchetype}`], ['Ramps / repairs', `${stats.terrainRamps} / ${stats.terrainRepairs}`], ['Terrain / navigation build', `${stats.terrainGenerationMs.toFixed(1)} / ${stats.navigationBuildMs.toFixed(1)} ms`],
      ['Navigation nodes / pending', `${stats.navigationExpansions} / ${stats.navigationPending}`],
      ['Render scale / lost sim time', `${Math.round(stats.renderScale * 100)}% / ${stats.droppedSimulationSeconds.toFixed(2)}s`],
      ['Blocked > 2 seconds', `${stats.blockedUnits}`],
    ];
    $('#metrics').innerHTML = entries.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join('');
  }
}

$('#pause').addEventListener('click', () => setPaused(!paused));
$('#restart').addEventListener('click', () => restartMap());
$('#new-map').addEventListener('click', () => newMap());
$('#play-again').addEventListener('click', () => newMap());
$('#center').addEventListener('click', () => renderer.resetCamera());
$('#zoom-in').addEventListener('click', () => renderer.zoom(1.2));
$('#zoom-out').addEventListener('click', () => renderer.zoom(1 / 1.2));
$('#diagnostics-toggle').addEventListener('click', () => toggleDiagnostics());
$('#close-diagnostics').addEventListener('click', () => toggleDiagnostics(false));
$('#quality').addEventListener('change', () => renderer.setQuality($('#quality') instanceof HTMLSelectElement && $<HTMLSelectElement>('#quality').value === 'low' ? 'low' : 'balanced'));
function startBenchmark(warmup = 300, duration = 600) {
  if (!restart(500)) return false;
  sim.hp.fill(1e8, 0, sim.used);
  capture.start(terrainSeed, seed, sim.tuning, warmup, duration);
  $('#benchmark-start').textContent = 'Stop benchmark'; return true;
}
function finishBenchmark() {
  sim.weaponsEnabled = true;
  for (let i = 0; i < sim.used; i++) sim.hp[i] = Math.min(sim.hp[i], sim.tuning.health);
  $('#benchmark-start').textContent = 'Benchmark 500 vs 500 · 15 min';
  $<HTMLButtonElement>('#benchmark-save').disabled = !capture.report;
}
function stopBenchmark(reason?: string) { if (capture.active) { capture.cancel(reason); finishBenchmark(); } }
$('#benchmark-start').addEventListener('click', () => {
  if (capture.active) stopBenchmark();
  else startBenchmark();
});
$('#benchmark-save').addEventListener('click', () => {
  if (!capture.report) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(capture.report, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `pluto-1000-${terrainSeed}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('#apply-battle').addEventListener('click', () => {
  const count = Number($<HTMLSelectElement>('#deployment').value);
  if (Number.isFinite(count)) restart(count, undefined, terrainSeed);
});
tuningPanel = new TuningPanel($('#battle-app'), tuning, values => {
  stopBenchmark('Benchmark stopped: tuning changed.');
  tuning = values; sim.applyLiveTuning(tuning); saveTuning(tuning); equipmentPanel?.updateCount(tuning.count); equipmentPanel?.updateRifle(sim.rifle); updateHud();
}, () => restartMap());
equipmentPanel = new EquipmentPanel($('#battle-app'), equipment, tuning.count, values => {
  equipment = values; saveEquipment(equipment);
}, () => restartMap());
equipmentPanel.updateRifle(sim.rifle);
function openTuning() { tuningPanel.toggle(); if (!tuningPanel.element.hidden) { soundPanel.open = false; equipmentPanel.toggle(false); toggleDiagnostics(false); } }
function openEquipment() { equipmentPanel.toggle(); if (!equipmentPanel.element.hidden) { soundPanel.open = false; tuningPanel.toggle(false); toggleDiagnostics(false); } }
tuningPanel.toggleButton.addEventListener('click', () => { if (!tuningPanel.element.hidden) { soundPanel.open = false; equipmentPanel.toggle(false); toggleDiagnostics(false); } });
equipmentPanel.toggleButton.addEventListener('click', () => { if (!equipmentPanel.element.hidden) { soundPanel.open = false; tuningPanel.toggle(false); toggleDiagnostics(false); } });
$<HTMLSelectElement>('#deployment').value = [100, 250, 500].includes(perTeam) ? String(perTeam) : 'custom';
document.addEventListener('keydown', event => {
  const typing = event.target instanceof Element && event.target.closest('input, select, textarea');
  const upgrade = typing || event.repeat ? undefined : UPGRADES.find(u => event.code === `Digit${u.key}` || event.code === `Numpad${u.key}`);
  if (upgrade) { upgradeMenu.toggle(upgrade.id); return; }
  if (event.code !== 'Escape' && event.target instanceof Element && event.target.closest('input, select, button, summary')) return;
  if (event.code === 'Escape' && typing) return;
  if (event.code === 'Space') { event.preventDefault(); setPaused(!paused); }
  if (event.code === 'KeyR') restartMap();
  if (event.code === 'KeyN') newMap();
  if (event.code === 'KeyD') toggleDiagnostics();
  if (event.code === 'KeyT') openTuning();
  if (event.code === 'KeyE') openEquipment();
  if (event.code === 'KeyC') renderer.resetCamera();
  if (event.code === 'Escape') { toggleDiagnostics(false); soundPanel.open = false; tuningPanel.toggle(false); equipmentPanel.toggle(false); upgradeMenu.select(null); selectSoldier(0); }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopBenchmark('Benchmark stopped: page hidden.');
  hidden = document.hidden; previousTime = 0; accumulator = 0;
  input.reset(); hzTime = hzTicks = simulationHz = 0;
  if (hidden) audio.stop();
});

function frame(now: number) {
  frameHandle = requestAnimationFrame(frame);
  if (hidden) { previousTime = 0; return; }
  const elapsed = previousTime ? (now - previousTime) / 1000 : CONFIG.step; previousTime = now;
  lastElapsed = elapsed * 1000;
  if (elapsed > 0 && elapsed < 1) { intervals[intervalCursor++ % intervals.length] = elapsed * 1000; intervalCount = Math.min(intervalCount + 1, intervals.length); frames++; if (elapsed > 0.0334) slowFrames++; }
  const start = performance.now();
  if (capture.active) sim.weaponsEnabled = !capture.movementPhase;
  // After the result, bodies and blast effects keep settling while the battle clock stays fixed.
  const advancing = sim.result === 'running' || sim.activeBodies > 0 || sim.time - sim.endedAt < CONFIG.corpseLifetime;
  if (!paused && advancing) {
    droppedSimulationSeconds += Math.max(0, elapsed - 0.1);
    accumulator += Math.min(elapsed, 0.1);
    let steps = 0;
    while (accumulator >= CONFIG.step && steps < 4) { sim.step(); accumulator -= CONFIG.step; steps++; hzTicks++; }
    if (accumulator >= CONFIG.step) { const remaining = accumulator % CONFIG.step; droppedSimulationSeconds += accumulator - remaining; accumulator = remaining; }
    hzTime += elapsed;
    if (hzTime >= 1) { simulationHz = hzTicks / hzTime; hzTime = hzTicks = 0; }
  } else if (!paused) endAge += Math.min(elapsed, 0.1);
  const afterSim = performance.now();
  audio.update(sim, !paused);
  if (!paused) renderer.adapt(lastElapsed);
  updateZone(now);
  renderer.update(sim, paused || !advancing ? 1 : accumulator / CONFIG.step, sim.time + endAge);
  soldierCard.position(sim, renderer);
  lastSimMs = afterSim - start; lastRenderMs = performance.now() - afterSim;
  simMs = simMs * 0.9 + lastSimMs * 0.1; renderMs = renderMs * 0.9 + lastRenderMs * 0.1;
  if (capture.active) {
    capture.sample(now, { simMs, renderMs, droppedSimulationSeconds, renderScale: renderer.resolutionScale, live: sim.alive[0] + sim.alive[1], simulationTick: sim.tick });
    if (!capture.active) { finishBenchmark(); setPaused(true); }
  }
  if (now - lastHudUpdate > 200) { updateHud(); lastHudUpdate = now; }
}

// Developer hooks for repeatable QA and future command-driven integrations.
const api = {
  ready: true,
  get sim() { return sim; }, renderer, audio,
  get paused() { return paused; }, setPaused, restart,
  get terrainSeed() { return terrainSeed; }, restartMap, newMap,
  get map() { const t = sim.terrain; return { archetype: t.archetype, name: t.name, region: t.region, defender: t.defender, repairs: t.repairs, ramps: t.ramps.length }; },
  replay() { tuning = { ...sim.tuning }; return restart(undefined, seed, terrainSeed); },
  startBenchmark,
  get benchmark() { return { active: capture.active, report: capture.report }; },
  get explosionTesting() { return explosionTesting; }, setExplosionTesting,
  explode,
  get upgrade() { return upgradeMenu.selected?.id ?? null; },
  selectUpgrade(id: UpgradeId | null) { upgradeMenu.select(id); },
  upgradeArea(id: UpgradeId, x: number, z: number, radius: number) { const u = UPGRADES.find(u => u.id === id); return u ? upgradeArea(u, { x, z }, radius) : 0; },
  get selectedSoldier() { return soldierCard.selectedId; },
  selectSoldier,
  get zone() { return zone && { ...zone.point, radius: zone.radius, released: !!zone.released, color: zone.color }; },
  /** Screen coordinates of a soldier for gesture tests. */
  soldierScreen(id: number) { const i = sim.byId.get(id); if (i === undefined) return null; renderer.update(sim, 1, sim.time); const rect = renderer.webgl.domElement.getBoundingClientRect(); const p = renderer.soldierScreen(sim, i, CONFIG.soldier.height * 0.55); return p && { x: rect.left + p.x, y: rect.top + p.y }; },
  get tuning() { return { ...tuning }; },
  get equipment() { return copyEquipment(equipment); },
  setEquipment(values: EquipmentSettings) {
    if (!validateEquipment(values)) return false;
    equipment = copyEquipment(values); saveEquipment(equipment); equipmentPanel.sync(equipment, sim.equipment, tuning.count); return true;
  },
  performance: performanceSnapshot,
  get timings() { return { simMs, renderMs, lastSimMs, lastRenderMs }; },
  step(count = 1) {
    for (let i = 0; i < count; i++) sim.step();
    audio.update(sim, false);
    renderer.update(sim, 1, sim.time); updateHud();
  },
};
Object.assign(window, { __battle: api });
updateHud(); frameHandle = requestAnimationFrame(frame);
function dispose() { cancelAnimationFrame(frameHandle); audioEvents.abort(); input.dispose(); audio.dispose(); renderer.dispose(); }
window.addEventListener('pagehide', dispose, { once: true });
if (import.meta.hot) import.meta.hot.dispose(dispose);
