import { CONFIG } from './config.ts';
import { DRIVER, GUNNER, Maneuver, PASSENGER, type TruckBlocker } from './vehicle-types.ts';
import type { VehicleFleet } from './vehicles.ts';
import type { Escalation } from './truck-recovery.ts';
import { ROUTE_STATES } from './truck-tactics.ts';

const STATIONARY_TICKS = Math.round(2 / CONFIG.step);
const STATIONARY_RADIUS = 0.25;
const RECENT_EVENTS = 24;
const EVENTS_BEFORE_STOP = 6;
const maneuverNames = Object.keys(Maneuver) as (keyof typeof Maneuver)[];

type Activity = 'driving' | 'waiting-for-replan' | 'waiting-for-pickup' | 'no-clear-route' | 'holding' | 'no-driver';
type Decision = 'route-selected' | 'fallback-reverse' | 'fallback-forward' | 'pickup' | 'no-clear-route';
type StopEnd = 'moved' | 'driver-lost' | 'destroyed';

export function maneuverName(mode: number) { return maneuverNames[mode]; }

export interface RouteBlock {
  segment: number | 'exit' | 'reverse-fallback' | 'forward-fallback';
  from: { x: number; z: number };
  to: { x: number; z: number };
  blocker: TruckBlocker;
}

export interface RecoveryCheck {
  direction: 'reverse' | 'forward';
  steering?: number;
  blockedBy: RouteBlock | null;
}

export interface RouteCheck {
  mode: keyof typeof Maneuver;
  yaw: number;
  speed: number;
  targetId: number | null;
  coarseScore: number;
  score: number | null;
  blockedBy: RouteBlock | null;
}

/** How a decision aimed: along the truck field, or straight (by choice, or as a fallback). */
export interface RouteTrace {
  state: 'none' | 'straight' | 'route' | 'disabled' | 'no-graph' | 'not-ready' | 'unknown-cell';
  /** Field distance at the truck's cell, when the field knows it. */
  fieldDistance: number | null;
  /** Route heading from the field (downhill, string-pulled), when one exists. */
  heading: number | null;
  /** String-pull target cell, when the route was used. */
  target: { x: number; z: number } | null;
  /** Heading up the field, offered as an Escape. */
  escape: number | null;
}

interface EventStamp { tick: number; x: number; z: number }
type TraceEvent = EventStamp & (
  | { kind: 'activity'; activity: Activity; mode: keyof typeof Maneuver; crew: ReturnType<TruckTrace['crew']> }
  | { kind: 'decision'; outcome: Decision; mode: keyof typeof Maneuver; requestedYaw: number; requestedSpeed: number;
    waitedTicks: number; routesScored: number; checks: RouteCheck[]; selectedCheck: number | null; recovery: RecoveryCheck[]; route: RouteTrace | null }
  | { kind: 'contact'; blocker: TruckBlocker; sweepSpeed: number; fraction: number; count: number; throughTick: number }
  | { kind: 'stopped'; activity: Activity; sinceTick: number }
  | { kind: 'stop-ended'; reason: StopEnd }
  | { kind: 'destroyed' }
  | { kind: 'escalation'; step: Escalation; stallSeconds: number }
  | { kind: 'stuck'; sinceTick: number }
  | { kind: 'unstuck' }
  | { kind: 'livelock'; count: number }
);

interface Stop {
  sinceTick: number;
  detectedTick: number;
  endedTick: number | null;
  endedBy: StopEnd | null;
  x: number;
  z: number;
  activity: Activity;
  preceding: TraceEvent[];
}

interface TruckHistory {
  id: number;
  activity: Activity | null;
  driver: number | null;
  gunner: number | null;
  passenger: number | null;
  anchorTick: number;
  anchorX: number;
  anchorZ: number;
  stopCount: number;
  /** Stops by how the last plan aimed: with a working truck field (route or a clear straight line) or as a fallback. */
  routedStops: number;
  fallbackStops: number;
  lastStop: Stop | null;
  droppedEvents: number;
  events: TraceEvent[];
  retired: ReturnType<TruckTrace['snapshot']> | null;
}

/** Optional diagnostics. No history is created or sampled unless a capture is running. */
export class TruckTrace {
  private readonly fleet: VehicleFleet;
  private readonly histories = new Map<number, TruckHistory>();
  private readonly startedTick: number;
  private readonly startingTuning: VehicleFleet['sim']['tuning'];
  private stopped = 0;
  private evicted = 0;

  constructor(fleet: VehicleFleet) {
    this.fleet = fleet;
    this.startedTick = fleet.sim.tick;
    this.startingTuning = { ...fleet.sim.tuning };
    for (let n = 0; n < fleet.count; n++) this.observe(fleet.active[n]);
  }

  get trackedCount() { return this.histories.size; }
  get stoppedCount() { return this.stopped; }

  private history(v: number) {
    const f = this.fleet, id = f.id[v];
    const existing = this.histories.get(id);
    if (existing) return existing;
    if (this.histories.size >= f.active.length + 128) {
      for (const [id, history] of this.histories) if (history.retired) {
        this.histories.delete(id);
        this.evicted++;
        break;
      }
    }
    const history: TruckHistory = {
      id, activity: null, driver: null, gunner: null, passenger: null,
      anchorTick: f.sim.tick, anchorX: f.x[v], anchorZ: f.z[v],
      stopCount: 0, routedStops: 0, fallbackStops: 0, lastStop: null, droppedEvents: 0, events: [], retired: null,
    };
    this.histories.set(id, history);
    return history;
  }

  private stamp(v: number): EventStamp {
    const f = this.fleet;
    return { tick: f.sim.tick, x: f.x[v], z: f.z[v] };
  }

  private append(history: TruckHistory, event: TraceEvent) {
    if (history.events.length >= RECENT_EVENTS) {
      history.events.shift();
      history.droppedEvents++;
    }
    history.events.push(event);
  }

  private crew(v: number) {
    const f = this.fleet;
    const soldierId = (role: number) => f.sim.id[f.seat(v, role)] ?? null;
    return { driver: soldierId(DRIVER), gunner: soldierId(GUNNER), passenger: soldierId(PASSENGER) };
  }

  private activity(v: number): Activity {
    const f = this.fleet;
    if (f.seat(v, DRIVER) < 0) return 'no-driver';
    if (f.hasReservation(v) && f.canWaitForPickup(v)) return 'waiting-for-pickup';
    if (f.blocked[v]) return 'waiting-for-replan';
    if (f.mode[v] === Maneuver.Hold) return 'no-clear-route';
    return f.desiredSpeed[v] === 0 ? 'holding' : 'driving';
  }

  private snapshot(v: number) {
    const f = this.fleet;
    const reservations = (['driver', 'gunner', 'passenger'] as const).flatMap((role, seat) => {
      const i = f.reservation(v, seat);
      return i < 0 ? [] : [{ role, soldierId: f.sim.id[i], distance: Math.hypot(f.sim.x[i] - f.x[v], f.sim.z[i] - f.z[v]) }];
    });
    return {
      ...this.stamp(v), team: f.team[v], hp: f.hp[v], yaw: f.yaw[v], crew: this.crew(v), reservations,
      mode: maneuverName(f.mode[v]), activity: this.activity(v), desiredYaw: f.desiredYaw[v], desiredSpeed: f.desiredSpeed[v],
      chassisSpeed: f.speed(v),
      movementSpeed: Math.hypot(f.x[v] - f.previousX[v], f.z[v] - f.previousZ[v]) / CONFIG.step,
      decisionDue: Number.isFinite(f.due[v]) ? f.due[v] : null,
      committedUntil: f.committedUntil[v], recoveryRequested: Boolean(f.urgent[v]), pullAwayRemaining: f.exitLeft[v],
    };
  }

  private endStop(v: number, history: TruckHistory, reason: StopEnd) {
    const stop = history.lastStop;
    if (!stop || stop.endedTick !== null) return;
    stop.endedTick = this.fleet.sim.tick;
    stop.endedBy = reason;
    this.stopped--;
    this.append(history, { ...this.stamp(v), kind: 'stop-ended', reason });
  }

  observe(v: number) {
    const f = this.fleet, history = this.history(v), activity = this.activity(v), tick = f.sim.tick;
    const driver = f.sim.id[f.seat(v, DRIVER)] ?? null;
    const gunner = f.sim.id[f.seat(v, GUNNER)] ?? null;
    const passenger = f.sim.id[f.seat(v, PASSENGER)] ?? null;
    if (activity !== history.activity || driver !== history.driver || gunner !== history.gunner || passenger !== history.passenger) {
      history.activity = activity;
      history.driver = driver;
      history.gunner = gunner;
      history.passenger = passenger;
      this.append(history, { ...this.stamp(v), kind: 'activity', activity, mode: maneuverName(f.mode[v]), crew: { driver, gunner, passenger } });
    }

    const moved = (f.x[v] - history.anchorX) ** 2 + (f.z[v] - history.anchorZ) ** 2 > STATIONARY_RADIUS ** 2;
    if (moved || driver === null) {
      this.endStop(v, history, driver === null ? 'driver-lost' : 'moved');
      history.anchorTick = tick;
      history.anchorX = f.x[v];
      history.anchorZ = f.z[v];
    } else if (tick - history.anchorTick >= STATIONARY_TICKS && (!history.lastStop || history.lastStop.endedTick !== null)) {
      history.stopCount++;
      this.stopped++;
      const route = ROUTE_STATES[f.tactics.routeState[v]];
      if (route === 'route' || route === 'straight') history.routedStops++; else history.fallbackStops++;
      history.lastStop = {
        sinceTick: history.anchorTick, detectedTick: tick, endedTick: null, endedBy: null,
        x: f.x[v], z: f.z[v], activity, preceding: history.events.slice(-EVENTS_BEFORE_STOP).map(event => ({ ...event })),
      };
      this.append(history, { ...this.stamp(v), kind: 'stopped', activity, sinceTick: history.anchorTick });
    }
  }

  decision(v: number, outcome: Decision, wait: number, routesScored: number, checks: RouteCheck[], selectedCheck: number | null, recovery: RecoveryCheck[] = [], route: RouteTrace | null = null) {
    const f = this.fleet;
    this.append(this.history(v), {
      ...this.stamp(v), kind: 'decision', outcome, mode: maneuverName(f.mode[v]),
      requestedYaw: f.desiredYaw[v], requestedSpeed: f.desiredSpeed[v],
      waitedTicks: Math.round(wait / CONFIG.step), routesScored, checks, selectedCheck, recovery, route,
    });
  }

  contact(v: number, blocker: TruckBlocker, sweepSpeed: number, fraction: number) {
    const history = this.history(v), last = history.events.at(-1), tick = this.fleet.sim.tick;
    if (last?.kind === 'contact' && last.throughTick + 1 === tick
      && last.blocker.kind === blocker.kind && last.blocker.id === blocker.id && last.blocker.atStart === blocker.atStart) {
      last.throughTick = tick;
      last.count++;
      return;
    }
    this.append(history, {
      ...this.stamp(v), kind: 'contact', blocker: { ...blocker }, sweepSpeed, fraction, throughTick: tick, count: 1,
    });
  }

  /** A recovery ladder step, from re-plan to crawl. */
  escalation(v: number, step: Escalation, stallSeconds: number) {
    this.append(this.history(v), { ...this.stamp(v), kind: 'escalation', step, stallSeconds });
  }

  /** The truck wanted to move and covered less than the stall radius for the stuck bound: the ladder failed. */
  stuck(v: number, since: number) {
    this.append(this.history(v), { ...this.stamp(v), kind: 'stuck', sinceTick: Math.round(since / CONFIG.step) });
  }

  unstuck(v: number) { this.append(this.history(v), { ...this.stamp(v), kind: 'unstuck' }); }

  /** The ladder keeps restarting at the same spot. */
  livelock(v: number, count: number) { this.append(this.history(v), { ...this.stamp(v), kind: 'livelock', count }); }

  destroy(v: number) {
    const history = this.history(v);
    history.retired = this.snapshot(v);
    this.endStop(v, history, 'destroyed');
    this.append(history, { ...this.stamp(v), kind: 'destroyed' });
  }

  report() {
    const f = this.fleet, sim = f.sim, terrain = sim.terrain;
    const trucks = Array.from(this.histories.values(), history => {
      const slot = f.byId.get(history.id);
      return {
        id: history.id, active: slot !== undefined, snapshot: slot === undefined ? history.retired : this.snapshot(slot),
        stopCount: history.stopCount, routedStops: history.routedStops, fallbackStops: history.fallbackStops, lastStop: history.lastStop, droppedEvents: history.droppedEvents, events: history.events,
      };
    });
    const stuckTruckIds = Array.from({ length: f.count }, (_, n) => f.active[n]).filter(v => f.recovery.stuck[v]).map(v => f.id[v]).sort((a, b) => a - b);
    const stoppedTruckIds = trucks.filter(truck => truck.active && truck.lastStop?.endedTick === null)
      .sort((a, b) => a.lastStop!.sinceTick - b.lastStop!.sinceTick || a.id - b.id).map(truck => truck.id);
    return structuredClone({
      version: 1, ticksPerSecond: 1 / CONFIG.step, startedTick: this.startedTick, throughTick: sim.tick, outcome: sim.result,
      alive: [...sim.alive], weaponsEnabled: sim.weaponsEnabled,
      battleSeed: sim.tuning.seed, terrainSeed: terrain.seed, map: terrain.archetype, bounds: { halfWidth: terrain.halfWidth, halfDepth: terrain.halfDepth },
      rocks: terrain.rocks, startingTuning: this.startingTuning, tuning: sim.tuning,
      stationary: { ticks: STATIONARY_TICKS, radius: STATIONARY_RADIUS },
      recentEventLimit: RECENT_EVENTS, evictedTrucks: this.evicted, stoppedTruckIds, stuckTruckIds,
      recovery: { stuck: f.metrics.stuck, livelocks: f.metrics.livelocks, yields: f.metrics.yields, retreats: f.metrics.retreats, crawls: f.metrics.crawls, makeWay: f.metrics.makeWay, displaced: f.metrics.displaced },
      routing: {
        queries: f.metrics.routeQueries, route: f.metrics.routeUsed, straight: f.metrics.routeStraight,
        fallbacks: { disabled: f.metrics.fallbackDisabled, 'no-graph': f.metrics.fallbackNoGraph, 'not-ready': f.metrics.fallbackNotReady, 'unknown-cell': f.metrics.fallbackUnknownCell },
        graphBuilds: f.metrics.graphBuilds, graphBuildMs: f.metrics.graphBuildMs, fieldExpansions: f.metrics.fieldExpansions, peakFieldExpansions: f.metrics.peakFieldExpansions,
        fieldEarlyStops: f.metrics.fieldEarlyStops, fieldFullSweeps: f.metrics.fieldFullSweeps,
      },
      trucks,
    });
  }
}

export type TruckTraceReport = ReturnType<TruckTrace['report']>;
