import { CONFIG } from './config.ts';
import { SpatialGrid } from './spatial-grid.ts';
import type { BattleSimulation } from './simulation.ts';
import type { Explosion } from './explosions.ts';
import { effectiveTurretRange } from './tuning.ts';
import { TruckController } from './truck-controller.ts';
import { TruckTactics } from './truck-tactics.ts';
import { TruckTrace } from './truck-trace.ts';
import { DRIVER, GUNNER, Maneuver, PASSENGER, PULL_AWAY, SEAT_COUNT, TRUCK, TRUCK_TYPE, VEHICLE_TYPES } from './vehicle-types.ts';

const POSES_PER_CREW = 8, CREWS_PER_TICK = 16;
const GROUP_DISTANCE = 2.6, REMAINDER_DISTANCE = 4.2;
const BOARD_REACH = 1.28;
const RING_ANGLES = [0, 0.55, -0.55, 1.1, -1.1, 1.65, -1.65, 2.2, -2.2, 2.7, -2.7, Math.PI];

interface Deployment {
  readonly id: number;
  readonly selected: number[];
  readonly deadline: number;
  left: number;
  boarded: number;
  trucks: number;
}
interface Crew {
  readonly job: Deployment;
  readonly ids: number[];
  readonly outward: number;
  pose: number;
  retry: number;
}
export interface DeploymentReport { id: number; selected: number; boarded: number; onFoot: number; trucks: number }
export interface Wreck extends Explosion {
  readonly crew: readonly number[];
  readonly yaw: number;
}

function boxRay(x: number, y: number, z: number, dx: number, dy: number, dz: number,
  w: number, bottom: number, top: number, length: number, limit: number) {
  let enter = 0, leave = limit;
  if (Math.abs(dx) < 1e-10) { if (Math.abs(x) > w) return Infinity; }
  else {
    const a = (-w - x) / dx, b = (w - x) / dx;
    enter = Math.max(enter, Math.min(a, b)); leave = Math.min(leave, Math.max(a, b));
  }
  if (Math.abs(dz) < 1e-10) { if (Math.abs(z) > length) return Infinity; }
  else {
    const a = (-length - z) / dz, b = (length - z) / dz;
    enter = Math.max(enter, Math.min(a, b)); leave = Math.min(leave, Math.max(a, b));
  }
  if (Math.abs(dy) < 1e-10) { if (y < bottom || y > top) return Infinity; }
  else {
    const a = (bottom - y) / dy, b = (top - y) / dy;
    enter = Math.max(enter, Math.min(a, b)); leave = Math.min(leave, Math.max(a, b));
  }
  return enter <= leave ? enter : Infinity;
}

/** Stable public IDs, recycled storage slots, dense active iteration, and explicit links in both directions. */
export class VehicleFleet {
  readonly grid: SpatialGrid;
  readonly ground: TruckController;
  readonly tactics: TruckTactics;
  readonly byId = new Map<number, number>();
  readonly active: Int32Array;
  readonly id: Uint32Array;
  readonly type: Uint8Array;
  readonly team: Uint8Array;
  readonly hp: Float32Array;
  readonly pendingDamage: Float32Array;
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly z: Float64Array;
  readonly previousX: Float64Array;
  readonly previousY: Float64Array;
  readonly previousZ: Float64Array;
  readonly yaw: Float64Array;
  readonly previousYaw: Float64Array;
  readonly sin: Float64Array;
  readonly cos: Float64Array;
  readonly vx: Float64Array;
  readonly vz: Float64Array;
  readonly desiredYaw: Float64Array;
  readonly desiredSpeed: Float64Array;
  readonly mode: Uint8Array;
  readonly exitLeft: Float64Array;
  readonly due: Float64Array;
  readonly committedUntil: Float64Array;
  readonly blocked: Uint8Array;
  readonly stalledTicks: Uint8Array;
  readonly urgent: Uint8Array;
  readonly recoverAt: Float64Array;
  readonly turretYaw: Float64Array;
  readonly previousTurretYaw: Float64Array;
  readonly turretPitch: Float64Array;
  readonly nextTurretShot: Float64Array;
  readonly nextTurretSearch: Float64Array;
  readonly ride: Int32Array;
  readonly role: Int8Array;
  readonly awaitingEjection: Uint8Array;
  readonly ejected: Uint8Array;
  readonly reservedVehicle: Int32Array;
  private readonly reservedRole: Int8Array;
  private readonly seatSlots: Int32Array;
  private readonly reservedSlots: Int32Array;
  private readonly reservedUntil: Float64Array;
  private readonly paintFor: Uint32Array;
  private readonly groupMark: Uint8Array;
  private readonly groupDistance: Float64Array;
  private readonly activeIndex: Int32Array;
  private readonly free: Int32Array;
  private freeCount = 0;
  private used = 0;
  private nextId = 1;
  count = 0;
  trace: TruckTrace | null = null;
  private readonly placement: Crew[] = [];
  private placementHead = 0;
  private nextPaintId = 1;
  private placedThisTick = 0;
  lastDeployment: DeploymentReport | null = null;
  deploymentRevision = 0;
  private readonly crewScratch: number[] = [];
  private readonly wrecks: Wreck[] = [];
  private wreckHead = 0;
  private readonly rayStamp: Uint32Array;
  private rayQuery = 0;
  rayHit = -1;
  readonly metrics = {
    paints: 0, painted: 0, boarded: 0, unplaced: 0, groupingMs: 0, placementMs: 0, placementChecks: 0,
    planningMs: 0, decisions: 0, detailedPaths: 0, queueDelay: 0, maxQueueDelay: 0,
    contactChecks: 0, contacts: 0, rams: 0, firingMs: 0, shots: 0, destructions: 0, peakTrucks: 0,
  };

  readonly sim: BattleSimulation;
  constructor(sim: BattleSimulation) {
    this.sim = sim;
    const n = sim.capacity, seats = n * SEAT_COUNT;
    this.active = new Int32Array(n); this.activeIndex = new Int32Array(n).fill(-1); this.free = new Int32Array(n);
    this.id = new Uint32Array(n); this.type = new Uint8Array(n); this.team = new Uint8Array(n);
    this.hp = new Float32Array(n); this.pendingDamage = new Float32Array(n);
    this.x = new Float64Array(n); this.y = new Float64Array(n); this.z = new Float64Array(n);
    this.previousX = new Float64Array(n); this.previousY = new Float64Array(n); this.previousZ = new Float64Array(n);
    this.yaw = new Float64Array(n); this.previousYaw = new Float64Array(n); this.sin = new Float64Array(n); this.cos = new Float64Array(n);
    this.vx = new Float64Array(n); this.vz = new Float64Array(n);
    this.desiredYaw = new Float64Array(n); this.desiredSpeed = new Float64Array(n); this.mode = new Uint8Array(n);
    this.exitLeft = new Float64Array(n); this.due = new Float64Array(n); this.committedUntil = new Float64Array(n);
    this.blocked = new Uint8Array(n); this.stalledTicks = new Uint8Array(n); this.urgent = new Uint8Array(n); this.recoverAt = new Float64Array(n);
    this.turretYaw = new Float64Array(n); this.previousTurretYaw = new Float64Array(n); this.turretPitch = new Float64Array(n);
    this.nextTurretShot = new Float64Array(n); this.nextTurretSearch = new Float64Array(n);
    this.ride = new Int32Array(n).fill(-1); this.role = new Int8Array(n).fill(-1);
    this.awaitingEjection = new Uint8Array(n); this.ejected = new Uint8Array(n);
    this.reservedVehicle = new Int32Array(n).fill(-1); this.reservedRole = new Int8Array(n).fill(-1);
    this.seatSlots = new Int32Array(seats).fill(-1); this.reservedSlots = new Int32Array(seats).fill(-1); this.reservedUntil = new Float64Array(seats);
    this.paintFor = new Uint32Array(n); this.groupMark = new Uint8Array(n); this.groupDistance = new Float64Array(n); this.rayStamp = new Uint32Array(n);
    this.grid = new SpatialGrid(n, sim.grid.halfWidth, sim.grid.halfDepth, this.team);
    this.ground = new TruckController(this); this.tactics = new TruckTactics(this);
  }

  get range() { return effectiveTurretRange(this.sim.tuning); }
  get pendingCrews() { return this.placement.length - this.placementHead; }
  get pendingDestructions() { return this.wrecks.length - this.wreckHead; }
  onFoot(i: number) { return this.ride[i] < 0 && !this.awaitingEjection[i]; }
  seat(v: number, role: number) { return this.seatSlots[v * SEAT_COUNT + role]; }
  reservation(v: number, role: number) { return this.reservedSlots[v * SEAT_COUNT + role]; }
  hasReservation(v: number) { return this.reservation(v, DRIVER) >= 0 || this.reservation(v, GUNNER) >= 0 || this.reservation(v, PASSENGER) >= 0; }
  speed(v: number) { return Math.hypot(this.vx[v], this.vz[v]); }

  startTrace() { return this.trace ??= new TruckTrace(this); }
  stopTrace() {
    const report = this.trace?.report() ?? null;
    this.trace = null;
    return report;
  }

  savePrevious() {
    for (let n = 0; n < this.count; n++) {
      const v = this.active[n];
      this.previousX[v] = this.x[v]; this.previousY[v] = this.y[v]; this.previousZ[v] = this.z[v];
      this.previousYaw[v] = this.yaw[v]; this.previousTurretYaw[v] = this.turretYaw[v];
    }
  }

  setPose(v: number, x: number, z: number, yaw: number, y?: number) {
    this.x[v] = x; this.z[v] = z; this.yaw[v] = yaw;
    this.sin[v] = Math.sin(yaw); this.cos[v] = Math.cos(yaw);
    this.y[v] = y ?? this.ground.supportHeight(x, z, this.sin[v], this.cos[v]);
    this.grid.insert(v, x, z);
    for (let role = 0; role < SEAT_COUNT; role++) {
      const i = this.seat(v, role);
      if (i >= 0) this.positionRider(v, role, i);
    }
  }

  private positionRider(v: number, role: number, i: number) {
    const s = VEHICLE_TYPES[this.type[v]].seats[role], sim = this.sim, sn = this.sin[v], cs = this.cos[v];
    sim.x[i] = this.x[v] + s.x * cs + s.z * sn; sim.z[i] = this.z[v] - s.x * sn + s.z * cs; sim.y[i] = this.y[v] + s.y;
    if (role === DRIVER) sim.facing[i] = this.yaw[v];
    if (role === GUNNER) sim.facing[i] = this.turretYaw[v];
    sim.grid.insert(i, sim.x[i], sim.z[i]);
  }

  private board(v: number, role: number, i: number) {
    this.release(v, role);
    const sim = this.sim;
    this.seatSlots[v * SEAT_COUNT + role] = i; this.ride[i] = v; this.role[i] = role; this.paintFor[i] = 0;
    sim.velocityX[i] = sim.velocityY[i] = sim.velocityZ[i] = 0;
    sim.grounded[i] = sim.moving[i] = sim.flankState[i] = sim.visible[i] = 0;
    sim.target[i] = 0; sim.nextSearch[i] = sim.time; sim.blockedUntil[i] = 0;
    this.positionRider(v, role, i);
    sim.previousX[i] = sim.x[i]; sim.previousY[i] = sim.y[i]; sim.previousZ[i] = sim.z[i];
    if (role === GUNNER) this.nextTurretSearch[v] = sim.time;
  }

  private spawn(x: number, z: number, yaw: number, crew: readonly number[]) {
    if (!this.freeCount && this.used >= this.active.length) return false;
    const v = this.freeCount ? this.free[--this.freeCount] : this.used++, sim = this.sim, t = sim.tuning;
    const id = this.nextId++;
    this.id[v] = id; this.byId.set(id, v); this.type[v] = TRUCK_TYPE; this.team[v] = sim.team[crew[0]];
    this.hp[v] = t.truckHealth; this.pendingDamage[v] = 0; this.vx[v] = this.vz[v] = 0;
    this.activeIndex[v] = this.count; this.active[this.count++] = v;
    this.metrics.peakTrucks = Math.max(this.metrics.peakTrucks, this.count);
    this.turretYaw[v] = this.previousTurretYaw[v] = this.previousYaw[v] = this.desiredYaw[v] = yaw; this.turretPitch[v] = 0;
    this.desiredSpeed[v] = 2.25; this.exitLeft[v] = PULL_AWAY; this.mode[v] = Maneuver.Exit;
    const phase = (Math.imul(id, 0x9e3779b1) >>> 0) / 0x100000000;
    this.due[v] = sim.time + (0.15 + 0.85 * phase) * t.truckDecisionInterval;
    this.nextTurretShot[v] = sim.time + phase * t.turretInterval; this.committedUntil[v] = this.recoverAt[v] = sim.time;
    this.blocked[v] = this.urgent[v] = this.stalledTicks[v] = 0;
    this.setPose(v, x, z, yaw);
    this.previousX[v] = x; this.previousY[v] = this.y[v]; this.previousZ[v] = z;
    crew.forEach((i, role) => this.board(v, role, i));
    this.trace?.observe(v);
    return true;
  }

  /** Snapshot at command dispatch, with one exclusive pending seat per soldier. */
  paint(x: number, z: number, radius: number, teams: number, solo = false) {
    if (this.range === null || !Number.isFinite(x) || !Number.isFinite(z) || !(radius >= 0) || !(teams & 3)) return;
    const start = performance.now(), sim = this.sim, grid = sim.grid, id = this.nextPaintId++;
    const job: Deployment = { id, selected: [], deadline: sim.time + sim.tuning.truckPlacementRetry, left: 0, boarded: 0, trucks: 0 };
    const left = grid.column(x - radius), right = grid.column(x + radius), near = grid.row(z - radius), far = grid.row(z + radius);
    const slots: number[][] = [[], []];
    for (let row = near; row <= far; row++) for (let col = left; col <= right; col++) {
      for (let i = grid.heads[row * grid.columns + col]; i >= 0; i = grid.next[i]) {
        if (!(teams & (1 << sim.team[i])) || !this.onFoot(i) || this.paintFor[i] || this.reservedVehicle[i] >= 0
          || (sim.x[i] - x) ** 2 + (sim.z[i] - z) ** 2 > radius * radius) continue;
        this.paintFor[i] = id; this.groupMark[i] = 1;
        slots[sim.team[i]].push(i); job.selected.push(sim.id[i]);
      }
    }
    const crews: { crew: Crew; outside: number }[] = [];
    for (let team = 0; team < 2; team++) {
      const candidates = slots[team];
      if (!candidates.length) continue;
      let cx = 0, cz = 0;
      for (const i of candidates) { cx += sim.x[i]; cz += sim.z[i]; }
      cx /= candidates.length; cz /= candidates.length;
      const distances = this.groupDistance;
      for (const i of candidates) distances[i] = (sim.x[i] - cx) ** 2 + (sim.z[i] - cz) ** 2;
      const outside = (i: number) => distances[i];
      candidates.sort((a, b) => outside(b) - outside(a) || sim.id[a] - sim.id[b]);
      for (let pass = 0; pass < 2; pass++) for (const i of candidates) {
        if (!this.groupMark[i]) continue;
        const ix = sim.x[i], iz = sim.z[i], d = pass ? REMAINDER_DISTANCE : GROUP_DISTANCE;
        let a = -1, b = -1, da = d * d, db = d * d;
        const near = grid.row(iz - d), far = grid.row(iz + d), left = grid.column(ix - d), right = grid.column(ix + d);
        if (!solo) for (let r = near; r <= far; r++) for (let c = left; c <= right; c++) {
          for (let j = grid.heads[r * grid.columns + c]; j >= 0; j = grid.next[j]) {
            if (j === i || sim.team[j] !== team || this.paintFor[j] !== id || !this.groupMark[j]) continue;
            const distance = (sim.x[j] - ix) ** 2 + (sim.z[j] - iz) ** 2;
            if (distance < da || distance === da && a >= 0 && sim.id[j] < sim.id[a]) { b = a; db = da; a = j; da = distance; }
            else if (distance < db || distance === db && b >= 0 && sim.id[j] < sim.id[b]) { b = j; db = distance; }
          }
        }
        // Leave incomplete groups available to the second, wider sweep through the remainder.
        if (!solo && !pass && b < 0) continue;
        const crewSlots = [i];
        if (a >= 0) crewSlots.push(a);
        if (b >= 0) crewSlots.push(b);
        let dx = 0, dz = 0;
        for (const j of crewSlots) { this.groupMark[j] = 0; dx += sim.x[j] - cx; dz += sim.z[j] - cz; }
        const outward = Math.hypot(dx, dz) > 0.12 ? Math.atan2(dx, dz) : team === 0 ? Math.PI : 0;
        crews.push({ crew: { job, ids: crewSlots.map(j => sim.id[j]), outward, pose: 0, retry: sim.tick }, outside: outside(i) });
      }
    }
    crews.sort((a, b) => b.outside - a.outside || a.crew.ids[0] - b.crew.ids[0]);
    for (const { crew } of crews) this.placement.push(crew);
    job.left = crews.length;
    if (!job.left) this.reportDeployment(job);
    this.metrics.paints++; this.metrics.painted += job.selected.length; this.metrics.groupingMs += performance.now() - start;
  }

  private reportDeployment(job: Deployment) {
    const sim = this.sim;
    let onFoot = 0;
    for (const id of job.selected) {
      const i = sim.byId.get(id);
      if (i !== undefined && sim.hp[i] > 0 && this.onFoot(i)) onFoot++;
    }
    this.lastDeployment = { id: job.id, selected: job.selected.length, boarded: job.boarded, onFoot, trucks: job.trucks };
    this.deploymentRevision++; this.metrics.unplaced += onFoot;
  }

  private finishCrew(crew: Crew) {
    for (const id of crew.ids) {
      const i = this.sim.byId.get(id);
      if (i !== undefined && this.paintFor[i] === crew.job.id) this.paintFor[i] = 0;
    }
    if (--crew.job.left === 0) this.reportDeployment(crew.job);
  }

  place(resetBudget = false) {
    if (resetBudget) this.placedThisTick = 0;
    if (!this.pendingCrews) return;
    const start = performance.now(), end = this.placement.length, sim = this.sim;
    while (this.placementHead < end) {
      const crew = this.placement[this.placementHead++];
      if (sim.time >= crew.job.deadline || sim.result !== 'running') this.finishCrew(crew);
      else if (crew.retry > sim.tick || this.placedThisTick >= CREWS_PER_TICK) {
        this.placement.push(crew);
        // Deadlines still advance in simulation time even if a placement queue is saturated.
      } else {
        this.placedThisTick++;
        if (this.placeCrew(crew)) this.finishCrew(crew);
        else { crew.retry = sim.tick + 5; this.placement.push(crew); }
      }
    }
    this.placement.splice(0, this.placementHead); this.placementHead = 0;
    this.metrics.placementMs += performance.now() - start;
  }

  private placeCrew(crew: Crew) {
    const sim = this.sim, t = sim.tuning, slots = this.crewScratch;
    slots.length = 0;
    let x = 0, z = 0;
    for (const id of crew.ids) {
      const i = sim.byId.get(id);
      if (i === undefined || sim.hp[i] <= 0 || !this.onFoot(i) || this.paintFor[i] !== crew.job.id) continue;
      slots.push(i); x += sim.x[i]; z += sim.z[i];
    }
    if (!slots.length) return true;
    if (slots.some(i => !sim.grounded[i])) return false;
    x /= slots.length; z /= slots.length;
    const rings = Math.ceil(t.truckPlacementDistance / 0.65), poses = RING_ANGLES.length * (rings + 1);
    for (let n = 0; n < POSES_PER_CREW; n++) {
      const pose = crew.pose++ % poses, ring = Math.floor(pose / RING_ANGLES.length), k = pose % RING_ANGLES.length;
      const distance = ring * t.truckPlacementDistance / rings, direction = crew.outward + RING_ANGLES[k];
      const tx = x + Math.sin(direction) * distance, tz = z + Math.cos(direction) * distance;
      // Rotate the search slightly on every lap through it. An opening needn't align to a fixed compass heading.
      const yaw = direction + (Math.floor((crew.pose - 1) / poses) % 3 - 1) * 0.29;
      this.metrics.placementChecks++;
      if (!this.ground.clear(-1, tx, tz, yaw, tx, tz, yaw, 0.025, 'all', slots)) continue;
      if (!this.ground.clear(-1, tx, tz, yaw, tx + Math.sin(yaw) * PULL_AWAY, tz + Math.cos(yaw) * PULL_AWAY, yaw, 0.025, 'all', slots)) continue;
      if (slots.some(i => Math.hypot(tx - sim.x[i], tz - sim.z[i]) > t.truckPlacementDistance + 1e-6
        || (sim.navigation && !sim.terrain.canTraverse(sim.x[i], sim.z[i], tx, tz, sim.radius[i])))) continue;
      if (!this.spawn(tx, tz, yaw, slots)) return false;
      crew.job.boarded += slots.length; crew.job.trucks++; this.metrics.boarded += slots.length;
      return true;
    }
    return false;
  }

  private release(v: number, role: number) {
    const index = v * SEAT_COUNT + role, i = this.reservedSlots[index];
    if (i < 0) return;
    this.reservedSlots[index] = -1; this.reservedVehicle[i] = this.reservedRole[i] = -1;
  }

  canWaitForPickup(v: number) {
    if (this.seat(v, DRIVER) < 0) return true;
    return this.exitLeft[v] <= 0 && this.tactics.enemiesNear(this.x[v], this.z[v], this.team[v], this.sim.rifle.range * 0.72) === 0;
  }

  recruit(v: number) {
    const sim = this.sim, grid = sim.grid, x = this.x[v], z = this.z[v], radius = sim.tuning.truckRecruitRadius;
    if (!this.canWaitForPickup(v)) return;
    for (let role = 0; role < SEAT_COUNT; role++) {
      if (this.seat(v, role) >= 0 || this.reservation(v, role) >= 0) continue;
      let best = -1, distance = radius * radius;
      for (let row = grid.row(z - radius); row <= grid.row(z + radius); row++) for (let col = grid.column(x - radius); col <= grid.column(x + radius); col++) {
        const cell = row * grid.columns + col;
        if (!grid.teamCounts[this.team[v]][cell]) continue;
        for (let i = grid.heads[cell]; i >= 0; i = grid.next[i]) {
          if (sim.team[i] !== this.team[v] || !this.onFoot(i) || this.paintFor[i] || !sim.grounded[i]
            || this.reservedVehicle[i] >= 0 && (role !== DRIVER || this.reservedRole[i] === DRIVER)) continue;
          const d = (sim.x[i] - x) ** 2 + (sim.z[i] - z) ** 2;
          if (d < distance && (!sim.navigation || sim.terrain.canTraverse(sim.x[i], sim.z[i], x, z, sim.radius[i]))) { best = i; distance = d; }
        }
      }
      if (best < 0) continue;
      if (this.reservedVehicle[best] >= 0) this.release(this.reservedVehicle[best], this.reservedRole[best]);
      const k = v * SEAT_COUNT + role;
      this.reservedSlots[k] = best; this.reservedUntil[k] = sim.time + sim.tuning.truckReservationTime;
      this.reservedVehicle[best] = v; this.reservedRole[best] = role;
    }
  }

  private boardRecruits(v: number) {
    if (!this.hasReservation(v)) return;
    const sim = this.sim, speed = this.speed(v);
    for (let role = 0; role < SEAT_COUNT; role++) {
      const k = v * SEAT_COUNT + role, i = this.reservedSlots[k];
      if (i < 0) continue;
      const distance = Math.hypot(this.x[v] - sim.x[i], this.z[v] - sim.z[i]);
      if (sim.hp[i] <= 0 || !this.onFoot(i) || this.seat(v, role) >= 0 || sim.time >= this.reservedUntil[k]
        || distance > sim.tuning.truckRecruitRadius * 1.4 || this.seat(v, DRIVER) >= 0 && !this.canWaitForPickup(v)) this.release(v, role);
      else if (distance <= BOARD_REACH + sim.radius[i] && Math.abs(this.y[v] - sim.y[i]) < 0.6 && sim.grounded[i]
        && speed <= sim.tuning.truckBoardingSpeed) {
        this.board(v, role, i);
        if (role === DRIVER) { this.blocked[v] = 1; this.due[v] = sim.time; this.urgent[v] = 1; }
      }
    }
  }

  requestRecovery(v: number) {
    this.blocked[v] = 1;
    if (this.urgent[v]) return;
    this.urgent[v] = 1; this.due[v] = Math.max(this.sim.time, this.recoverAt[v]);
  }

  soldierDied(i: number) {
    this.paintFor[i] = this.ejected[i] = 0;
    if (this.reservedVehicle[i] >= 0) this.release(this.reservedVehicle[i], this.reservedRole[i]);
    const v = this.ride[i], role = this.role[i], sim = this.sim;
    if (v < 0) return;
    this.seatSlots[v * SEAT_COUNT + role] = -1; this.ride[i] = this.role[i] = -1;
    sim.velocityX[i] = this.vx[v]; sim.velocityZ[i] = this.vz[v]; sim.velocityY[i] = 0.5;
    if (role === DRIVER) {
      const replacement = this.seat(v, PASSENGER) >= 0 ? PASSENGER : GUNNER, next = this.seat(v, replacement);
      if (next >= 0) {
        this.seatSlots[v * SEAT_COUNT + replacement] = -1;
        this.board(v, DRIVER, next);
      } else { this.desiredSpeed[v] = 0; this.exitLeft[v] = 0; }
    }
    this.due[v] = Math.min(this.due[v], sim.time + 0.1);
    this.trace?.observe(v);
  }

  step() {
    if (!this.count) return;
    this.tactics.schedule();
    this.ground.releaseContacts();
    for (let n = 0; n < this.count; n++) {
      const v = this.active[(this.sim.tick + (this.sim.tick % 2 ? n : this.count - n - 1)) % this.count];
      if (VEHICLE_TYPES[this.type[v]].controller === 'ground') this.ground.drive(v);
      this.boardRecruits(v);
      this.trace?.observe(v);
    }
  }

  rescaleHealth(old: number) {
    const hp = this.sim.tuning.truckHealth;
    if (hp === old) return;
    for (let n = 0; n < this.count; n++) { const v = this.active[n]; this.hp[v] = Math.min(hp, this.hp[v] * hp / old); }
  }

  damage(id: number, amount: number) {
    const v = this.byId.get(id);
    if (v === undefined || !Number.isFinite(amount) || amount <= 0) return;
    this.hp[v] = Math.max(0, this.hp[v] - amount);
    if (!this.hp[v]) this.destroy(v);
  }

  applyDamage() {
    for (let n = 0; n < this.count;) {
      const v = this.active[n], damage = this.pendingDamage[v];
      this.pendingDamage[v] = 0;
      if (damage > 0) this.damage(this.id[v], damage);
      if (this.hp[v] > 0) n++;
    }
  }

  private destroy(v: number) {
    const sim = this.sim, t = sim.tuning, crew: number[] = [];
    this.trace?.destroy(v);
    for (let role = 0; role < SEAT_COUNT; role++) {
      this.release(v, role);
      const k = v * SEAT_COUNT + role, i = this.seatSlots[k];
      if (i < 0) continue;
      this.seatSlots[k] = -1; this.ride[i] = this.role[i] = -1; this.awaitingEjection[i] = 1;
      sim.velocityX[i] = this.vx[v] * 0.45; sim.velocityZ[i] = this.vz[v] * 0.45;
      crew.push(sim.id[i]);
    }
    this.wrecks.push({ x: this.x[v], y: this.y[v] + 0.44, z: this.z[v], radius: t.truckBlastRadius,
      damage: t.truckBlastDamage, impulse: t.truckBlastImpulse, yaw: this.yaw[v], crew });
    this.metrics.destructions++;
    this.byId.delete(this.id[v]); this.grid.remove(v);
    const index = this.activeIndex[v], last = this.active[--this.count];
    this.active[index] = last; this.activeIndex[last] = index; this.activeIndex[v] = -1;
    this.free[this.freeCount++] = v;
  }

  takeWreck() {
    const wreck = this.wrecks[this.wreckHead++];
    if (this.wreckHead === this.wrecks.length) { this.wrecks.length = this.wreckHead = 0; }
    else if (this.wreckHead >= 128) { this.wrecks.splice(0, this.wreckHead); this.wreckHead = 0; }
    return wreck;
  }

  blast(e: Explosion) {
    const grid = this.grid, radius = e.radius + TRUCK.reach;
    for (let row = grid.row(e.z - radius); row <= grid.row(e.z + radius); row++) for (let col = grid.column(e.x - radius); col <= grid.column(e.x + radius); col++) {
      for (let v = grid.heads[row * grid.columns + col]; v >= 0; v = grid.next[v]) {
        const rx = e.x - this.x[v], ry = e.y - this.y[v], rz = e.z - this.z[v], h = VEHICLE_TYPES[this.type[v]].hull;
        const dx = Math.max(0, Math.abs(rx * this.cos[v] - rz * this.sin[v]) - h.halfWidth);
        const dz = Math.max(0, Math.abs(rx * this.sin[v] + rz * this.cos[v]) - h.halfLength);
        const dy = Math.max(0, h.bottom - ry, ry - h.top);
        if (dx * dx + dy * dy + dz * dz <= e.radius * e.radius) this.pendingDamage[v] += e.damage;
      }
    }
  }

  castHull(x: number, y: number, z: number, dx: number, dy: number, dz: number, limit: number, ignoreId = 0, ignoreTeam = -1) {
    this.rayHit = -1;
    if (!this.count) return limit;
    if (++this.rayQuery === 0xffffffff) { this.rayStamp.fill(0); this.rayQuery = 1; }
    const g = this.grid, sx = dx >= 0 ? 1 : -1, sz = dz >= 0 ? 1 : -1;
    let col = g.column(x), row = g.row(z), t = 0;
    const ddx = Math.abs(dx) > 1e-9 ? g.cellSize / Math.abs(dx) : Infinity, ddz = Math.abs(dz) > 1e-9 ? g.cellSize / Math.abs(dz) : Infinity;
    let tx = ddx === Infinity ? Infinity : ((col + (sx > 0 ? 1 : 0)) * g.cellSize - g.halfWidth - x) / dx;
    let tz = ddz === Infinity ? Infinity : ((row + (sz > 0 ? 1 : 0)) * g.cellSize - g.halfDepth - z) / dz;
    // Camera rays can start outside the grid. Clip the DDA start to its horizontal envelope.
    if (Math.abs(x) > g.halfWidth || Math.abs(z) > g.halfDepth) {
      const entry = boxRay(x, 0, z, dx, 0, dz, g.halfWidth, -1, 1, g.halfDepth, limit);
      if (!Number.isFinite(entry)) return limit;
      t = entry;
      col = g.column(x + dx * t); row = g.row(z + dz * t);
      tx = ddx === Infinity ? Infinity : ((col + (sx > 0 ? 1 : 0)) * g.cellSize - g.halfWidth - x) / dx;
      tz = ddz === Infinity ? Infinity : ((row + (sz > 0 ? 1 : 0)) * g.cellSize - g.halfDepth - z) / dz;
    }
    while (t <= limit && col >= 0 && col < g.columns && row >= 0 && row < g.rows) {
      for (let r = Math.max(0, row - 1); r <= Math.min(g.rows - 1, row + 1); r++) for (let c = Math.max(0, col - 1); c <= Math.min(g.columns - 1, col + 1); c++) {
        for (let v = g.heads[r * g.columns + c]; v >= 0; v = g.next[v]) {
          if (this.id[v] === ignoreId || this.team[v] === ignoreTeam || this.rayStamp[v] === this.rayQuery) continue;
          this.rayStamp[v] = this.rayQuery;
          const rx = x - this.x[v], ry = y - this.y[v], rz = z - this.z[v], sn = this.sin[v], cs = this.cos[v];
          const lx = rx * cs - rz * sn, lz = rx * sn + rz * cs, ux = dx * cs - dz * sn, uz = dx * sn + dz * cs;
          const { hull: h, turret: gun } = VEHICLE_TYPES[this.type[v]];
          const d = Math.min(boxRay(lx, ry, lz, ux, dy, uz, h.halfWidth, h.bottom, h.top, h.halfLength, limit),
            boxRay(lx - gun.x, ry, lz - gun.z, ux, dy, uz, gun.radius, h.top, gun.y + 0.09, gun.radius, limit));
          if (d < limit) { limit = d; this.rayHit = v; }
        }
      }
      if (tx < tz) { t = tx; tx += ddx; col += sx; } else { t = tz; tz += ddz; row += sz; }
    }
    return limit;
  }
}
