import { CONFIG } from './config.ts';
import { DRIVER, Maneuver, TRUCK, angleDelta } from './vehicle-types.ts';
import type { VehicleFleet } from './vehicles.ts';

/** Progress that resets the stall clock, and the stall that counts as stuck (the trace's stationary rule). */
export const STALL_RADIUS = 0.25;
export const STUCK_TIME = 2;
/** Escalation ladder, in seconds of stall. Each step hands over well before STUCK_TIME. */
export const LADDER = { replan: 0.2, yield: 0.6, retreat: 1.0, crawl: 1.5 } as const;
/** Pose trail: one pose per TRAIL_SPACING units driven, the last TRAIL_POSES kept (about 20 units of road). */
export const TRAIL_POSES = 40;
export const TRAIL_SPACING = 0.5;
/** Longest trail retreat before re-planning. */
export const RETREAT_DISTANCE = 3;
const RETREAT_SPEED = 2, YIELD_HOLD = 0.5, CRAWL_SPEED = 0.9;
/** Ticks a trail retreat waits behind another truck before giving up and re-planning. */
const RETREAT_WAIT = 12;
/** A ladder that ran out at the crawl step (nothing moved) starts over this long after the crawl. */
const LADDER_RESTART = 1;
/** Re-entering the ladder this close to the last escalation spot, this often within LOOP_WINDOW, is a livelock. */
const LOOP_RADIUS = 1, LOOP_WINDOW = 15, LOOP_COUNT = 3;
const MAKE_WAY_LENGTH = 2.6, MAKE_WAY_PUSH = 1.4, MAKE_WAY_PERIOD = 0.1;
const SPOT_RINGS = 40, SPOT_STEP = 0.3;

export type Escalation = 'replan' | 'yield' | 'hold' | 'make-way' | 'retreat' | 'crawl';
const STAGE_REPLAN = 1, STAGE_YIELD = 2, STAGE_RETREAT = 3, STAGE_CRAWL = 4;

/**
 * Keeps every crewed truck moving. Measures stalls (no STALL_RADIUS progress while the driver wants to move),
 * climbs the escalation ladder (re-plan, yield or make way, trail retreat, last-resort crawl) and flags
 * trucks that stay stuck past STUCK_TIME or keep looping back to the same spot.
 */
export class TruckRecovery {
  private readonly f: VehicleFleet;
  private readonly anchorX: Float64Array;
  private readonly anchorZ: Float64Array;
  private readonly since: Float64Array;
  private readonly pickupSince: Float64Array;
  private readonly stage: Uint8Array;
  /** Per truck: 1 while it counts as stuck. */
  readonly stuck: Uint8Array;
  /** The truck that last stopped this one's sweep, or -1. Written by the controller. */
  readonly blockerTruck: Int32Array;
  private readonly trailX: Float64Array;
  private readonly trailZ: Float64Array;
  private readonly trailYaw: Float64Array;
  private readonly retreatWait: Uint8Array;
  private readonly restartAt: Float64Array;
  private readonly trailHead: Int32Array;
  private readonly trailLength: Int32Array;
  /** Distance a trail retreat may still cover; positive while one is running. */
  readonly retreatLeft: Float64Array;
  private readonly loopX: Float64Array;
  private readonly loopZ: Float64Array;
  private readonly loopAt: Float64Array;
  private readonly loops: Uint8Array;
  private readonly nextMakeWay: Float64Array;
  private readonly yieldUntil: Float64Array;
  private readonly overlap: number[] = [];

  constructor(f: VehicleFleet) {
    this.f = f;
    const n = f.active.length;
    this.anchorX = new Float64Array(n); this.anchorZ = new Float64Array(n); this.since = new Float64Array(n); this.pickupSince = new Float64Array(n);
    this.stage = new Uint8Array(n); this.stuck = new Uint8Array(n); this.blockerTruck = new Int32Array(n).fill(-1);
    this.trailX = new Float64Array(n * TRAIL_POSES); this.trailZ = new Float64Array(n * TRAIL_POSES); this.trailYaw = new Float64Array(n * TRAIL_POSES);
    this.retreatWait = new Uint8Array(n); this.restartAt = new Float64Array(n);
    this.trailHead = new Int32Array(n); this.trailLength = new Int32Array(n); this.retreatLeft = new Float64Array(n);
    this.loopX = new Float64Array(n); this.loopZ = new Float64Array(n); this.loopAt = new Float64Array(n).fill(-Infinity); this.loops = new Uint8Array(n);
    this.nextMakeWay = new Float64Array(n); this.yieldUntil = new Float64Array(n);
  }

  /** A new truck: an empty clock and a trail that starts at its spawn pose. */
  reset(v: number) {
    const f = this.f, now = f.sim.time;
    this.anchorX[v] = f.x[v]; this.anchorZ[v] = f.z[v]; this.since[v] = this.pickupSince[v] = now;
    this.stage[v] = this.stuck[v] = this.loops[v] = 0; this.blockerTruck[v] = -1; this.retreatLeft[v] = 0;
    this.loopAt[v] = -Infinity; this.nextMakeWay[v] = now; this.yieldUntil[v] = 0;
    this.trailLength[v] = 0; this.trailHead[v] = 0; this.record(v);
  }

  /** Seconds since the truck last made STALL_RADIUS progress while its driver wanted to move. */
  stall(v: number) { return this.f.sim.time - this.since[v]; }
  retreating(v: number) { return this.retreatLeft[v] > 0; }
  trailSize(v: number) { return this.trailLength[v]; }

  private record(v: number) {
    const f = this.f, k = v * TRAIL_POSES + this.trailHead[v];
    this.trailX[k] = f.x[v]; this.trailZ[k] = f.z[v]; this.trailYaw[k] = f.yaw[v];
    this.trailHead[v] = (this.trailHead[v] + 1) % TRAIL_POSES;
    this.trailLength[v] = Math.min(TRAIL_POSES, this.trailLength[v] + 1);
  }
  private last(v: number) { return v * TRAIL_POSES + (this.trailHead[v] + TRAIL_POSES - 1) % TRAIL_POSES; }
  private pop(v: number) { this.trailHead[v] = (this.trailHead[v] + TRAIL_POSES - 1) % TRAIL_POSES; this.trailLength[v]--; }

  /**
   * Before the controller drives: replays a running trail retreat, or crawls a truck at the last step.
   * Returns true when this tick's motion is already done.
   */
  steer(v: number) {
    const f = this.f;
    if (this.retreatLeft[v] > 0) return this.replay(v);
    return this.stage[v] >= STAGE_CRAWL && f.seat(v, DRIVER) >= 0 && this.crawl(v);
  }

  /** After the controller drives: the stall clock, the trail and the ladder. */
  update(v: number) {
    const f = this.f, sim = f.sim, now = sim.time;
    if (f.seat(v, DRIVER) < 0) { this.settle(v, now); this.retreatLeft[v] = 0; return; }
    const dx = f.x[v] - this.anchorX[v], dz = f.z[v] - this.anchorZ[v];
    if (dx * dx + dz * dz > STALL_RADIUS * STALL_RADIUS) this.settle(v, now);
    const k = this.last(v);
    if (this.retreatLeft[v] <= 0 && (!this.trailLength[v] || (f.x[v] - this.trailX[k]) ** 2 + (f.z[v] - this.trailZ[k]) ** 2 >= TRAIL_SPACING ** 2)) this.record(v);
    // Waiting at a pickup is deliberate, up to the reservation time; past that bound the clock runs again.
    if (f.hasReservation(v) && f.canWaitForPickup(v)) {
      if (now - this.pickupSince[v] <= sim.tuning.truckReservationTime) { this.settle(v, now); return; }
    } else {
      this.pickupSince[v] = now;
      // A truck that is not trying to move cannot be stuck (it does stop in Hold, when it has no clear route).
      if (f.desiredSpeed[v] === 0 && f.mode[v] !== Maneuver.Hold) { this.settle(v, now); return; }
      // Running free (no contact, no pending re-plan) is progress, however slowly it starts from rest.
      if (!f.stalledTicks[v] && !f.blocked[v] && f.mode[v] !== Maneuver.Hold && this.retreatLeft[v] <= 0) { this.settle(v, now); return; }
    }
    if (this.retreatLeft[v] > 0) return;
    const stall = now - this.since[v];
    if (stall >= STUCK_TIME && !this.stuck[v]) { this.stuck[v] = 1; f.metrics.stuck++; f.trace?.stuck(v, this.since[v]); }
    if (stall >= LADDER.replan && this.stage[v] < STAGE_REPLAN) { this.stage[v] = STAGE_REPLAN; this.escalate(v, 'replan'); f.requestRecovery(v); }
    if (stall >= LADDER.yield && this.stage[v] < STAGE_YIELD) { this.stage[v] = STAGE_YIELD; this.yieldOrder(v); }
    if (this.stage[v] === STAGE_YIELD && now >= this.nextMakeWay[v]) this.makeWay(v);
    // A truck holding while the other one of a pair backs out waits for its hold to finish.
    const yielding = this.yieldUntil[v] > now;
    if (stall >= LADDER.retreat && this.stage[v] < STAGE_RETREAT && !yielding) {
      this.stage[v] = STAGE_RETREAT;
      this.noteLoop(v);
      if (this.trailLength[v] > 1) this.startRetreat(v);
    }
    if (stall >= LADDER.crawl && this.stage[v] < STAGE_CRAWL) {
      this.stage[v] = STAGE_CRAWL; this.restartAt[v] = now + LADDER_RESTART; this.escalate(v, 'crawl'); f.metrics.crawls++;
    }
    // Nothing moved it, not even the crawl (another truck, or no trail yet): climb the ladder again.
    else if (this.stage[v] === STAGE_CRAWL && now >= this.restartAt[v]) this.stage[v] = 0;
  }

  /** Progress (or a lost driver): the clock restarts here and the ladder is reset. */
  private settle(v: number, now: number) {
    const f = this.f;
    if (this.stuck[v]) { this.stuck[v] = 0; f.trace?.unstuck(v); }
    this.anchorX[v] = f.x[v]; this.anchorZ[v] = f.z[v]; this.since[v] = now; this.stage[v] = 0;
  }

  private escalate(v: number, step: Escalation) { this.f.trace?.escalation(v, step, this.stall(v)); }

  /** Two trucks blocking each other: the higher ID backs out along its trail, the other holds briefly. */
  private yieldOrder(v: number) {
    const f = this.f, other = this.blockerTruck[v];
    if (other < 0 || f.hp[other] <= 0 || f.id[other] === 0 || this.stall(other) < LADDER.replan && !this.retreating(other)) { this.makeWay(v); return; }
    if (f.id[v] > f.id[other]) {
      f.metrics.yields++; this.escalate(v, 'yield');
      if (this.trailLength[v] > 1) this.startRetreat(v);
    } else if (!this.retreating(v)) {
      this.escalate(v, 'hold');
      f.mode[v] = Maneuver.Hold; f.desiredSpeed[v] = 0; f.blocked[v] = f.urgent[v] = 0;
      f.committedUntil[v] = f.due[v] = this.yieldUntil[v] = f.sim.time + YIELD_HOLD;
    }
  }

  /** Allies in the planned path step sideways, actively, before contact. */
  private makeWay(v: number) {
    const f = this.f, sim = f.sim, grid = sim.grid, now = sim.time;
    this.nextMakeWay[v] = now + MAKE_WAY_PERIOD;
    const direction = f.desiredSpeed[v] < 0 ? -1 : 1, yaw = f.desiredSpeed[v] < 0 ? f.yaw[v] : f.desiredYaw[v];
    const sn = Math.sin(yaw) * direction, cs = Math.cos(yaw) * direction, width = TRUCK.radius + sim.tuning.radius + 0.35;
    const reach = TRUCK.reach + MAKE_WAY_LENGTH, x = f.x[v], z = f.z[v];
    let pushed = 0;
    for (let row = grid.row(z - reach); row <= grid.row(z + reach); row++) for (let col = grid.column(x - reach); col <= grid.column(x + reach); col++) {
      for (let i = grid.heads[row * grid.columns + col]; i >= 0; i = grid.next[i]) {
        if (sim.team[i] !== f.team[v] || sim.hp[i] <= 0 || !f.onFoot(i) || !sim.grounded[i]) continue;
        const ox = sim.x[i] - x, oz = sim.z[i] - z, along = ox * sn + oz * cs, side = ox * cs - oz * sn;
        if (along < 0 || along > reach || Math.abs(side) > width) continue;
        const away = Math.abs(side) < 0.05 ? sim.detourSide[i] : Math.sign(side);
        sim.velocityX[i] += cs * away * MAKE_WAY_PUSH; sim.velocityZ[i] -= sn * away * MAKE_WAY_PUSH;
        pushed++;
      }
    }
    if (pushed) { f.metrics.makeWay += pushed; if (this.stage[v] === STAGE_YIELD && now - this.since[v] < LADDER.yield + MAKE_WAY_PERIOD) this.escalate(v, 'make-way'); }
  }

  private startRetreat(v: number) {
    const f = this.f;
    this.escalate(v, 'retreat'); f.metrics.retreats++;
    this.retreatLeft[v] = RETREAT_DISTANCE;
    // Drop the poses the truck is still sitting on.
    while (this.trailLength[v] > 1) {
      const k = this.last(v);
      if ((f.x[v] - this.trailX[k]) ** 2 + (f.z[v] - this.trailZ[k]) ** 2 >= (TRAIL_SPACING * 0.7) ** 2) break;
      this.pop(v);
    }
    this.retreatWait[v] = 0;
    f.mode[v] = Maneuver.Reverse; f.desiredYaw[v] = f.yaw[v]; f.desiredSpeed[v] = -RETREAT_SPEED;
    f.committedUntil[v] = f.due[v] = Infinity; f.urgent[v] = f.blocked[v] = f.exitLeft[v] = f.stalledTicks[v] = 0;
  }

  /**
   * One tick of trail retreat: the truck is moved back toward its previous recorded pose, position and heading
   * together. Terrain never changes, so those poses are statically clear by construction; only other trucks are
   * checked, and soldiers in the way are moved aside as in the crawl. Returns true when the truck moved.
   */
  private replay(v: number) {
    const f = this.f;
    while (this.trailLength[v] > 1) {
      const k = this.last(v);
      if ((f.x[v] - this.trailX[k]) ** 2 + (f.z[v] - this.trailZ[k]) ** 2 > 1e-6) break;
      this.pop(v);
    }
    if (this.retreatLeft[v] <= 0 || this.trailLength[v] <= 1) { this.endRetreat(v); return false; }
    const k = this.last(v), x = f.x[v], z = f.z[v], yaw = f.yaw[v];
    const dx = this.trailX[k] - x, dz = this.trailZ[k] - z, length = Math.hypot(dx, dz);
    const t = Math.min(1, RETREAT_SPEED * CONFIG.step / length), tx = x + dx * t, tz = z + dz * t;
    const tyaw = yaw + angleDelta(this.trailYaw[k], yaw) * t;
    if (!f.ground.trucksClear(v, x, z, yaw, tx, tz, tyaw)) {
      // Another truck behind: wait a moment for it, then plan afresh from here.
      if (++this.retreatWait[v] > RETREAT_WAIT) this.endRetreat(v);
      f.vx[v] = f.vz[v] = 0;
      return true;
    }
    this.retreatWait[v] = 0;
    f.mode[v] = Maneuver.Reverse; f.desiredYaw[v] = tyaw; f.desiredSpeed[v] = -RETREAT_SPEED;
    f.setPose(v, tx, tz, tyaw); f.vx[v] = f.vz[v] = 0;
    this.retreatLeft[v] -= length * t;
    this.displace(v);
    if (this.retreatLeft[v] <= 0) this.endRetreat(v);
    return true;
  }

  private endRetreat(v: number) {
    const f = this.f, now = f.sim.time;
    this.retreatLeft[v] = 0;
    // Stop here (not in the retreat's reverse) until the re-plan, due next tick.
    f.desiredSpeed[v] = 0; f.mode[v] = Maneuver.Hold;
    f.committedUntil[v] = now; f.due[v] = now; f.urgent[v] = 1; f.blocked[v] = 0;
  }

  /** Repeated escalation at one spot is a loop, not a stall: report it once. */
  private noteLoop(v: number) {
    const f = this.f, now = f.sim.time;
    const near = (f.x[v] - this.loopX[v]) ** 2 + (f.z[v] - this.loopZ[v]) ** 2 <= LOOP_RADIUS * LOOP_RADIUS;
    if (near && now - this.loopAt[v] <= LOOP_WINDOW) {
      if (++this.loops[v] === LOOP_COUNT - 1) { f.metrics.livelocks++; f.trace?.livelock(v, this.loops[v] + 1); }
    } else { this.loops[v] = 0; this.loopX[v] = f.x[v]; this.loopZ[v] = f.z[v]; }
    this.loopAt[v] = now;
  }

  /**
   * Last resort: creep straight on at crawl speed, past soldiers but never through rock or trucks,
   * moving each soldier the footprint now overlaps to the nearest free standing spot. No damage.
   */
  private crawl(v: number) {
    const f = this.f, sim = f.sim, step = CRAWL_SPEED * CONFIG.step, x = f.x[v], z = f.z[v], yaw = f.yaw[v];
    const first = f.desiredSpeed[v] < 0 ? -1 : 1;
    for (const direction of [first, -first]) {
      const tx = x + Math.sin(yaw) * step * direction, tz = z + Math.cos(yaw) * step * direction;
      if (!f.ground.clear(v, x, z, yaw, tx, tz, yaw, 0, 'none')) continue;
      f.setPose(v, tx, tz, yaw); f.vx[v] = f.vz[v] = 0;
      this.displace(v);
      return true;
    }
    return false;
  }

  private displace(v: number) {
    const f = this.f, sim = f.sim, grid = sim.grid, reach = TRUCK.reach + TRUCK.radius + sim.tuning.radius + 0.1, x = f.x[v], z = f.z[v];
    const overlap = this.overlap;
    overlap.length = 0;
    for (let row = grid.row(z - reach); row <= grid.row(z + reach); row++) for (let col = grid.column(x - reach); col <= grid.column(x + reach); col++) {
      for (let i = grid.heads[row * grid.columns + col]; i >= 0; i = grid.next[i]) {
        if (sim.hp[i] <= 0 || !f.onFoot(i) || sim.y[i] > f.y[v] + TRUCK.hull.top + 0.02) continue;
        const r = TRUCK.radius + sim.radius[i] + 0.004;
        if (TRUCK.disks.some(d => (sim.x[i] - x - f.sin[v] * d) ** 2 + (sim.z[i] - z - f.cos[v] * d) ** 2 < r * r)) overlap.push(i);
      }
    }
    for (const i of overlap) if (this.moveSoldier(i)) f.metrics.displaced++;
  }

  /** The nearest standing spot clear of rock, trucks and other soldiers, widening until one is found. */
  private moveSoldier(i: number) {
    const sim = this.f.sim, x = sim.x[i], z = sim.z[i], r = sim.radius[i], hw = sim.grid.halfWidth - r, hd = sim.grid.halfDepth - r;
    for (let ring = 1; ring <= SPOT_RINGS; ring++) {
      const distance = ring * SPOT_STEP, count = Math.max(8, Math.ceil(2 * Math.PI * distance / SPOT_STEP));
      for (let k = 0; k < count; k++) {
        const a = (k + 0.5 * (ring & 1)) * 2 * Math.PI / count, tx = x + Math.sin(a) * distance, tz = z + Math.cos(a) * distance;
        if (Math.abs(tx) > hw || Math.abs(tz) > hd || !sim.clearPosition(i, tx, tz, r)) continue;
        sim.x[i] = sim.previousX[i] = tx; sim.z[i] = sim.previousZ[i] = tz; sim.y[i] = sim.previousY[i] = sim.terrain.heightAt(tx, tz);
        sim.velocityX[i] = sim.velocityZ[i] = 0;
        sim.grid.insert(i, tx, tz);
        return true;
      }
    }
    return false;
  }
}
