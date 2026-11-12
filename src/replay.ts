/**
 * Prototype battle replays (see replay-and-physics-plan.md). A replay is the battle's starting
 * values plus every input stamped with the sim tick it arrived on, so re-running the same
 * deterministic sim reproduces the battle. Camera moves and taps ride along for viewing.
 *
 * Prototype limits: same-device playback only (no det-math yet), battles only (no menus),
 * and inputs made while paused play back instantly.
 */
import type { BattleSimulation, Command } from './simulation.ts';
import type { TuningValues } from './tuning.ts';
import type { EquipmentSettings } from './equipment.ts';

export interface ReplayHeader {
  version: 1;
  perTeam: number; seed: number; terrainSeed: number;
  flat: boolean; archetype?: string;
  tuning: TuningValues; equipment: EquipmentSettings; roster: string;
  recordedAt: string; screen: { width: number; height: number };
}
type Vec = [number, number, number];
export type ReplayEvent =
  | { at: number; kind: 'command'; command: Command }
  | { at: number; kind: 'flush' }
  | { at: number; kind: 'tuning'; tuning: TuningValues }
  /** `x`/`y` are 0–1 fractions of the screen; keys have no position. */
  | { at: number; kind: 'tap'; x?: number; y?: number; label: string }
  | { at: number; kind: 'camera'; position: Vec; target: Vec; zoom: number }
  | { at: number; kind: 'hash'; hash: number };
export interface Replay { header: ReplayHeader; events: ReplayEvent[]; endTick: number; outcome: string }

const HASH_EVERY = 60;
/** FNV-1a over positions and health, so the viewer can tell when playback drifts. */
export function stateHash(sim: BattleSimulation) {
  let h = 0x811c9dc5;
  const mix = (v: number) => { h = Math.imul(h ^ (Math.round(v * 1000) | 0), 0x01000193); };
  for (let i = 0; i < sim.used; i++) { mix(sim.x[i]); mix(sim.z[i]); mix(sim.hp[i]); }
  mix(sim.alive[0]); mix(sim.alive[1]);
  return h >>> 0;
}

interface CameraLike { camera: { position: { x: number; y: number; z: number; set(x: number, y: number, z: number): unknown }; zoom: number; updateProjectionMatrix(): void }; controls: { target: { x: number; y: number; z: number; set(x: number, y: number, z: number): unknown }; update(): void } }
const round = (v: number) => Math.round(v * 100) / 100;

export class ReplayRecorder {
  readonly events: ReplayEvent[] = [];
  private lastCamera = '';
  private lastCameraTick = -Infinity;
  readonly header: ReplayHeader;
  readonly sim: BattleSimulation;

  constructor(header: ReplayHeader, sim: BattleSimulation) {
    this.header = header; this.sim = sim;
    const queue = sim.queue.bind(sim), flush = sim.flushCommands.bind(sim), tune = sim.applyLiveTuning.bind(sim), step = sim.step.bind(sim);
    sim.queue = command => { queue(command); this.events.push({ at: sim.tick, kind: 'command', command: structuredClone(sim.commands[sim.commands.length - 1]) }); };
    sim.flushCommands = () => { this.events.push({ at: sim.tick, kind: 'flush' }); flush(); };
    sim.applyLiveTuning = values => { this.events.push({ at: sim.tick, kind: 'tuning', tuning: { ...values } }); tune(values); };
    sim.step = () => { step(); if (sim.tick % HASH_EVERY === 0) this.events.push({ at: sim.tick, kind: 'hash', hash: stateHash(sim) }); };
  }
  tap(label: string, x?: number, y?: number) {
    this.events.push(x === undefined || y === undefined ? { at: this.sim.tick, kind: 'tap', label } : { at: this.sim.tick, kind: 'tap', x: round(x), y: round(y), label });
  }
  /** Samples the camera at most every 3 ticks, and only when it moved. */
  camera(view: CameraLike) {
    if (this.sim.tick - this.lastCameraTick < 3 && this.lastCamera) return;
    const { camera, controls } = view, position: Vec = [round(camera.position.x), round(camera.position.y), round(camera.position.z)];
    const target: Vec = [round(controls.target.x), round(controls.target.y), round(controls.target.z)], zoom = round(camera.zoom);
    const key = `${position}|${target}|${zoom}`;
    if (key === this.lastCamera) return;
    this.lastCamera = key; this.lastCameraTick = this.sim.tick;
    this.events.push({ at: this.sim.tick, kind: 'camera', position, target, zoom });
  }
  finish(): Replay { return { header: this.header, events: this.events.slice(), endTick: this.sim.tick, outcome: this.sim.result }; }
}

export class ReplayPlayer {
  speed = 1;
  followCamera = true;
  desyncTick: number | null = null;
  checkedHashes = 0;
  private cursor = 0;
  private readonly hashes = new Map<number, number>();
  private readonly cameras: Extract<ReplayEvent, { kind: 'camera' }>[];
  private readonly queue: (command: Command) => void;
  private readonly flush: () => void;
  private readonly tune: (values: TuningValues) => void;
  readonly replay: Replay;
  readonly sim: BattleSimulation;
  private readonly onTap: (tap: Extract<ReplayEvent, { kind: 'tap' }>) => void;

  constructor(replay: Replay, sim: BattleSimulation, onTap: (tap: Extract<ReplayEvent, { kind: 'tap' }>) => void) {
    this.replay = replay; this.sim = sim; this.onTap = onTap;
    this.queue = sim.queue.bind(sim); this.flush = sim.flushCommands.bind(sim); this.tune = sim.applyLiveTuning.bind(sim);
    // The viewer's own clicks must not change the recorded battle.
    sim.queue = () => {}; sim.flushCommands = () => {}; sim.applyLiveTuning = () => {};
    for (const e of replay.events) if (e.kind === 'hash') this.hashes.set(e.at, e.hash);
    this.cameras = replay.events.filter((e): e is Extract<ReplayEvent, { kind: 'camera' }> => e.kind === 'camera');
    const step = sim.step.bind(sim);
    sim.step = () => {
      this.feed(); step();
      const expected = this.hashes.get(sim.tick);
      if (expected !== undefined) { this.checkedHashes++; if (expected !== stateHash(sim) && this.desyncTick === null) this.desyncTick = sim.tick; }
    };
  }
  get finished() { return this.sim.tick >= this.replay.endTick && this.cursor >= this.replay.events.length; }
  /** Applies every recorded input that arrived on or before the current tick. */
  feed() {
    const events = this.replay.events;
    while (this.cursor < events.length && events[this.cursor].at <= this.sim.tick) {
      const e = events[this.cursor++];
      if (e.kind === 'command') this.queue(structuredClone(e.command));
      else if (e.kind === 'flush') this.flush();
      else if (e.kind === 'tuning') this.tune({ ...e.tuning });
      else if (e.kind === 'tap') this.onTap(e);
    }
  }
  /** Moves the camera to where the player had it, interpolating between samples. */
  applyCamera(view: CameraLike, tick: number) {
    if (!this.followCamera || !this.cameras.length) return;
    let hi = this.cameras.findIndex(c => c.at > tick);
    if (hi === -1) hi = this.cameras.length - 1;
    const b = this.cameras[hi], a = this.cameras[Math.max(0, hi - 1)];
    const t = b.at === a.at ? 1 : Math.min(1, Math.max(0, (tick - a.at) / (b.at - a.at)));
    const lerp = (i: 0 | 1 | 2, from: Vec, to: Vec) => from[i] + (to[i] - from[i]) * t;
    view.controls.target.set(lerp(0, a.target, b.target), lerp(1, a.target, b.target), lerp(2, a.target, b.target));
    view.camera.position.set(lerp(0, a.position, b.position), lerp(1, a.position, b.position), lerp(2, a.position, b.position));
    view.camera.zoom = a.zoom + (b.zoom - a.zoom) * t; view.camera.updateProjectionMatrix();
    view.controls.update();
  }
}

export function validReplay(data: unknown): data is Replay {
  const r = data as Replay;
  return !!r && r.header?.version === 1 && Array.isArray(r.events) && Number.isInteger(r.endTick);
}
