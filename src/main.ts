/// <reference types="vite/client" />
import './style.css';
import { CONFIG } from './config.ts';
import { BattleSimulation } from './simulation.ts';
import { BattleRenderer } from './renderer.ts';
import { loadTuning, saveTuning, deploymentError } from './tuning.ts';
import { TuningPanel } from './tuning-panel.ts';
import { BattleAudio, SOUND_EFFECTS } from './audio.ts';

const icons = {
  pause: '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M5 4h3v12H5zm7 0h3v12h-3z"/></svg>',
  play: '<svg viewBox="0 0 20 20" fill="currentColor"><path d="m6 3 11 7-11 7z"/></svg>',
  restart: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4.6 5a7 7 0 1 1-1.3 7M4 1v5h5"/></svg>',
  focus: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M7 3H3v4m10-4h4v4M3 13v4h4m10-4v4h-4"/><circle cx="10" cy="10" r="2.5"/></svg>',
  stats: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 14h3l3-9 4 12 3-8h3"/></svg>',
  sound: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M3 8h3l4-4v12l-4-4H3zM13 7a5 5 0 0 1 0 6m3-9a9 9 0 0 1 0 12"/></svg>',
};

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <main id="battle-app">
    <div id="viewport"></div><div class="vignette" aria-hidden="true"></div>
    <header class="top-bar">
      <div class="brand"><span class="planet-mark" aria-hidden="true"></span><h1>PLUTO<span>MASS COMBAT</span></h1><span class="prototype-label">PROTOTYPE 001</span></div>
      <div class="sector"><span class="sector-cross" aria-hidden="true">✣</span><div>VERMILION BASIN<small>OUTER RIM · SECTOR 07</small></div></div>
    </header>
    <section class="army-hud" aria-label="Army status">
      <div class="army plutonians"><div class="army-label"><span class="team-symbol">Ⅰ</span><div>PLUTONIANS<small>EXPEDITIONARY CORPS</small></div></div><div class="army-count"><strong id="pluto-count">100</strong><span>ACTIVE</span></div><div class="strength-track"><div id="pluto-strength"></div></div></div>
      <div class="battle-readout"><span id="state-label"><i></i> LIVE BATTLE</span><time id="battle-time">00:00</time><span class="versus">VS</span></div>
      <div class="army sectoids"><div class="army-label"><span class="team-symbol">Ⅲ</span><div>SECTOIDS<small>HOSTILE WAR PARTY</small></div></div><div class="army-count"><strong id="sectoid-count">100</strong><span>ACTIVE</span></div><div class="strength-track"><div id="sectoid-strength"></div></div></div>
    </section>
    <div class="field-label" aria-hidden="true"><span class="coordinate-line"></span><span>07 / ALIEN SURFACE</span><small>NO ORDERS REQUIRED.</small></div>
    <div class="view-controls" aria-label="Camera controls"><button id="zoom-in" aria-label="Zoom in" title="Zoom in">+</button><span></span><button id="zoom-out" aria-label="Zoom out" title="Zoom out">−</button></div>
    <section id="outcome" class="outcome" hidden aria-live="polite"><span>ENGAGEMENT COMPLETE</span><h2 id="outcome-title"></h2><p id="outcome-description"></p><button id="play-again">Run another battle <span>↗</span></button></section>
    <div id="paused-notice" class="paused-notice" hidden>SIMULATION PAUSED</div>
    <footer class="bottom-bar">
      <div class="battle-note"><span class="status-light"></span><div id="engagement-label">ARMIES ADVANCING<small>100 vs 100 · AUTOMATIC ENGAGEMENT</small></div></div>
      <nav class="battle-controls" aria-label="Battle controls"><button id="pause" class="primary">${icons.pause}<span>Pause</span></button><button id="restart">${icons.restart}<span>Restart</span></button><button id="center">${icons.focus}<span>Center view</span></button></nav>
      <button id="diagnostics-toggle" class="performance-badge" aria-expanded="false" aria-controls="diagnostics" title="Performance and battle settings (D)">${icons.stats}<strong id="fps-label">—</strong><span>FPS</span></button>
    </footer>
    <div class="input-hint">LEFT-DRAG PAN <span>·</span> RIGHT-DRAG ORBIT <span>·</span> SCROLL / PINCH ZOOM <span>·</span> SPACE PAUSE</div>
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
      <div class="settings"><label for="deployment">Deployment preset <select id="deployment"><option value="custom" disabled>Custom · tuning panel</option><option value="100">100 vs 100</option><option value="250">250 vs 250 · stress test</option><option value="500">500 vs 500 · stress test</option></select></label><label for="quality">Visual quality <select id="quality"><option value="balanced">Balanced · 1.5× pixel cap</option><option value="low">Low · 1× pixel cap</option></select></label><button id="apply-battle">Deploy preset ${icons.restart}</button></div>
      <p>Stress tests measure scaling. Phone performance requires testing on a physical device.</p>
    </aside>
    <div id="error" hidden role="alert"></div>
  </main>`;

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
let tuning = loadTuning();
let tuningPanel: TuningPanel;
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
soundPanel.addEventListener('toggle', () => { if (soundPanel.open) { toggleDiagnostics(false); tuningPanel?.toggle(false); } });

let perTeam = tuning.count, seed = tuning.seed;
let sim = new BattleSimulation(perTeam, seed, CONFIG.capacity, tuning), paused = false, accumulator = 0, endAge = 0;
audio.reset(sim);
let previousTime = 0, lastHudUpdate = -Infinity, hidden = document.hidden, frameHandle = 0;
let simMs = 0, renderMs = 0, lastElapsed = 16.67, frames = 0, slowFrames = 0;
const intervals = new Float32Array(360), samples: number[] = [];
let intervalCursor = 0, intervalCount = 0;
const plutoCount = $('#pluto-count'), sectoidCount = $('#sectoid-count'), battleTime = $('#battle-time');
const plutoStrength = $('#pluto-strength'), sectoidStrength = $('#sectoid-strength');
const stateLabel = $('#state-label'), outcome = $('#outcome'), pauseButton = $('#pause');

function toggleDiagnostics(force?: boolean) {
  const open = force ?? $('#diagnostics').hidden; $('#diagnostics').hidden = !open;
  $('#diagnostics-toggle').setAttribute('aria-expanded', String(open));
  if (open) { soundPanel.open = false; updateHud(); }
}
function setPaused(value: boolean) {
  paused = value; accumulator = 0;
  if (value) audio.stop();
  pauseButton.innerHTML = `${value ? icons.play : icons.pause}<span>${value ? 'Resume' : 'Pause'}</span>`;
  pauseButton.setAttribute('aria-label', value ? 'Resume battle' : 'Pause battle');
  $('#paused-notice').hidden = !value || sim.result !== 'running'; updateHud();
}
function restart(count?: number, nextSeed?: number) {
  const candidate = { ...tuning };
  if (count !== undefined) { candidate.count = count; candidate.columns = Math.ceil(Math.sqrt(count)); }
  if (nextSeed !== undefined) candidate.seed = nextSeed;
  tuning = candidate;
  if (deploymentError(candidate)) { tuningPanel.sync(tuning, sim.tuning); tuningPanel.toggle(true); return false; }
  perTeam = tuning.count; seed = tuning.seed;
  sim = new BattleSimulation(perTeam, seed, CONFIG.capacity, tuning); accumulator = 0; endAge = 0;
  audio.reset(sim);
  intervalCount = intervalCursor = frames = slowFrames = 0; simMs = renderMs = 0;
  saveTuning(tuning); tuningPanel.sync(tuning, sim.tuning);
  $<HTMLSelectElement>('#deployment').value = [100, 250, 500].includes(perTeam) ? String(perTeam) : 'custom';
  outcome.hidden = true; setPaused(false); updateHud();
  return true;
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
  };
}

function updateHud() {
  plutoCount.textContent = String(sim.alive[0]); sectoidCount.textContent = String(sim.alive[1]); battleTime.textContent = elapsedLabel(sim.time);
  plutoStrength.style.width = `${Math.min(100, sim.alive[0] / perTeam * 100)}%`; sectoidStrength.style.width = `${Math.min(100, sim.alive[1] / perTeam * 100)}%`;
  stateLabel.innerHTML = `<i></i> ${sim.result !== 'running' ? 'BATTLE ENDED' : paused ? 'PAUSED' : 'LIVE BATTLE'}`;
  stateLabel.classList.toggle('is-paused', paused || sim.result !== 'running');
  $('#engagement-label').innerHTML = `${sim.result !== 'running' ? 'ENGAGEMENT COMPLETE' : sim.totalShots > 0 ? 'WEAPONS FREE' : 'ARMIES ADVANCING'}<small>${perTeam} vs ${perTeam} · AUTOMATIC ENGAGEMENT</small>`;
  if (sim.result !== 'running') {
    outcome.hidden = false;
    $('#outcome-title').textContent = sim.result === 'draw' ? 'Mutual destruction.' : sim.result === 'plutonians' ? 'Plutonians hold the field.' : 'Sectoids hold the field.';
    $('#outcome-description').textContent = `${sim.alive[0] + sim.alive[1]} survivors · ${sim.totalShots.toLocaleString()} shots fired · ${elapsedLabel(sim.time)}`;
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
      ['Frames > 33.4 ms', `${stats.slowFrames} / ${stats.frames}`],
    ];
    $('#metrics').innerHTML = entries.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join('');
  }
}

$('#pause').addEventListener('click', () => setPaused(!paused));
$('#restart').addEventListener('click', () => restart());
$('#play-again').addEventListener('click', () => restart());
$('#center').addEventListener('click', () => renderer.resetCamera());
$('#zoom-in').addEventListener('click', () => renderer.zoom(1.2));
$('#zoom-out').addEventListener('click', () => renderer.zoom(1 / 1.2));
$('#diagnostics-toggle').addEventListener('click', () => toggleDiagnostics());
$('#close-diagnostics').addEventListener('click', () => toggleDiagnostics(false));
$('#quality').addEventListener('change', () => renderer.setQuality($('#quality') instanceof HTMLSelectElement && $<HTMLSelectElement>('#quality').value === 'low' ? 'low' : 'balanced'));
$('#apply-battle').addEventListener('click', () => {
  const count = Number($<HTMLSelectElement>('#deployment').value);
  if (Number.isFinite(count)) restart(count);
});
tuningPanel = new TuningPanel($('#battle-app'), tuning, values => {
  tuning = values; sim.applyLiveTuning(tuning); saveTuning(tuning); updateHud();
}, () => restart());
tuningPanel.toggleButton.addEventListener('click', () => { if (!tuningPanel.element.hidden) soundPanel.open = false; });
$<HTMLSelectElement>('#deployment').value = [100, 250, 500].includes(perTeam) ? String(perTeam) : 'custom';
document.addEventListener('keydown', event => {
  if (event.target instanceof Element && event.target.closest('input, select, button, summary')) return;
  if (event.code === 'Space') { event.preventDefault(); setPaused(!paused); }
  if (event.code === 'KeyR') restart();
  if (event.code === 'KeyD') toggleDiagnostics();
  if (event.code === 'KeyT') { tuningPanel.toggle(); if (!tuningPanel.element.hidden) soundPanel.open = false; }
  if (event.code === 'KeyC') renderer.resetCamera();
  if (event.code === 'Escape') { toggleDiagnostics(false); soundPanel.open = false; tuningPanel.toggle(false); }
});
document.addEventListener('visibilitychange', () => {
  hidden = document.hidden; previousTime = 0; accumulator = 0;
  if (hidden) audio.stop();
});

function frame(now: number) {
  frameHandle = requestAnimationFrame(frame);
  if (hidden) { previousTime = 0; return; }
  const elapsed = previousTime ? (now - previousTime) / 1000 : CONFIG.step; previousTime = now;
  lastElapsed = elapsed * 1000;
  if (elapsed > 0 && elapsed < 1) { intervals[intervalCursor++ % intervals.length] = elapsed * 1000; intervalCount = Math.min(intervalCount + 1, intervals.length); frames++; if (elapsed > 0.0334) slowFrames++; }
  const start = performance.now();
  if (!paused && sim.result === 'running') {
    accumulator += Math.min(elapsed, 0.1);
    let steps = 0;
    while (accumulator >= CONFIG.step && steps < 4) { sim.step(); accumulator -= CONFIG.step; steps++; }
    if (accumulator >= CONFIG.step) accumulator %= CONFIG.step;
  } else if (!paused) endAge += Math.min(elapsed, 0.1);
  const afterSim = performance.now();
  audio.update(sim, !paused);
  renderer.update(sim, paused || sim.result !== 'running' ? 1 : accumulator / CONFIG.step, sim.time + endAge);
  simMs = simMs * 0.9 + (afterSim - start) * 0.1; renderMs = renderMs * 0.9 + (performance.now() - afterSim) * 0.1;
  if (now - lastHudUpdate > 200) { updateHud(); lastHudUpdate = now; }
}

// Developer hooks for repeatable QA and future command-driven integrations.
const api = {
  ready: true,
  get sim() { return sim; }, renderer, audio,
  get paused() { return paused; }, setPaused, restart,
  get tuning() { return { ...tuning }; },
  performance: performanceSnapshot,
  get timings() { return { simMs, renderMs }; },
  step(count = 1) {
    for (let i = 0; i < count; i++) sim.step();
    audio.update(sim, false);
    renderer.update(sim, 1, sim.time); updateHud();
  },
};
Object.assign(window, { __battle: api });
updateHud(); frameHandle = requestAnimationFrame(frame);
function dispose() { cancelAnimationFrame(frameHandle); audioEvents.abort(); audio.dispose(); renderer.dispose(); }
window.addEventListener('pagehide', dispose, { once: true });
if (import.meta.hot) import.meta.hot.dispose(dispose);
