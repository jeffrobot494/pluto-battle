import { CONFIG } from './config.ts';
import { DRIVER, GUNNER, PASSENGER, Maneuver, TRUCK, angleDelta } from './vehicle-types.ts';
import type { VehicleFleet } from './vehicles.ts';
import { maneuverName, type RecoveryCheck, type RouteBlock, type RouteCheck } from './truck-trace.ts';

const SAMPLES = 4, STRIDE = 0.28, SHORTLIST = 3, MAX_ROUTES = 26;
const MAX_DECISIONS = 32;
const TRAFFIC = 2;
const DETOUR_ANGLES = [0.50, -0.50, 0.95, -0.95, 1.50, -1.50];
const RECOVERY_DIRECTIONS = [-1, 1];
const RECOVERY_STEERING = [0.4, -0.4];
const RECOVERY_DISTANCE = 0.85;
const RECOVERY_STEPS = Math.ceil(0.7 / CONFIG.step);

class Route {
  mode: Maneuver = Maneuver.Hold;
  yaw = 0;
  speed = 0;
  target = -1;
  score = -Infinity;
  readonly x = new Float64Array(SAMPLES);
  readonly z = new Float64Array(SAMPLES);
  readonly heading = new Float64Array(SAMPLES);
  readonly velocity = new Float64Array(SAMPLES);
}

/** One score for approaches, passes, charges and exits. The expensive checks only run on the shortlist. */
export class TruckTactics {
  private readonly selected = new Int32Array(MAX_DECISIONS);
  private readonly priority = new Float64Array(MAX_DECISIONS);
  private readonly density: Uint32Array[];
  private readonly footCounts: Uint16Array;
  private readonly truckCells: Int32Array;
  private readonly width: number;
  private densityTick = -Infinity;
  private readonly threats = new Int32Array(8);
  private readonly threatDistance = new Float64Array(8);
  private readonly groups = new Int32Array(3);
  private readonly routes = Array.from({ length: MAX_ROUTES }, () => new Route());
  private readonly ramStamp: Uint32Array;
  private ramQuery = 0;
  private routeCount = 0;
  private detailLeft = 0;

  private readonly f: VehicleFleet;
  constructor(f: VehicleFleet) {
    this.f = f;
    this.width = f.sim.grid.columns + 1;
    this.density = Array.from({ length: 3 }, () => new Uint32Array(this.width * (f.grid.rows + 1)));
    this.footCounts = new Uint16Array(f.grid.heads.length);
    this.truckCells = new Int32Array(f.active.length);
    this.ramStamp = new Uint32Array(f.sim.capacity);
  }

  private refreshDensity() {
    const sim = this.f.sim;
    if (sim.tick - this.densityTick < 6) return;
    this.densityTick = sim.tick;
    const g = sim.grid, trucks = this.f.grid, w = this.width, [a, b, traffic] = this.density;
    this.footCounts.fill(0);
    this.truckCells.set(trucks.cell);
    for (let i = 0; i < sim.used; i++) {
      const cell = g.cell[i];
      if (cell >= 0 && sim.grounded[i] && this.f.onFoot(i)) this.footCounts[cell]++;
    }
    for (let r = 0; r < g.rows; r++) {
      let sumA = 0, sumB = 0, sumTraffic = 0;
      for (let c = 0; c < g.columns; c++) {
        const src = r * g.columns + c, dst = (r + 1) * w + c + 1;
        sumA += g.teamCounts[0][src]; sumB += g.teamCounts[1][src];
        sumTraffic += this.footCounts[src] + trucks.teamCounts[0][src] + trucks.teamCounts[1][src];
        a[dst] = a[dst - w] + sumA; b[dst] = b[dst - w] + sumB;
        traffic[dst] = traffic[dst - w] + sumTraffic;
      }
    }
  }

  private count(x: number, z: number, population: number, radius: number, ownCell = -1) {
    const g = this.f.sim.grid, w = this.width, a = this.density[population];
    const l = g.column(x - radius), r = g.column(x + radius) + 1;
    const firstRow = g.row(z - radius), lastRow = g.row(z + radius);
    const t = firstRow * w, b = (lastRow + 1) * w;
    let total = a[b + r] + a[t + l] - a[t + r] - a[b + l];
    if (ownCell >= 0 && total) {
      const row = Math.floor(ownCell / g.columns), col = ownCell % g.columns;
      if (row >= firstRow && row <= lastRow && col >= l && col < r) total--;
    }
    return total;
  }
  enemiesNear(x: number, z: number, team: number, radius: number) {
    return this.count(x, z, 1 - team, radius);
  }

  schedule() {
    const f = this.f, sim = f.sim, t = sim.tuning, now = sim.time, cap = Math.max(1, Math.min(MAX_DECISIONS, t.truckDecisionsPerTick | 0));
    const started = performance.now();
    this.refreshDensity();
    let size = 0;
    for (let n = 0; n < f.count; n++) {
      const v = f.active[n];
      if (f.due[v] > now || !f.urgent[v] && (f.exitLeft[v] > 0 || f.committedUntil[v] > now)) continue;
      // A short priority boost gets a blocked truck moving. Age eventually outranks urgency.
      const key = f.urgent[v] ? f.due[v] - 0.4 : Math.max(f.due[v], f.committedUntil[v]);
      if (size >= cap && key >= this.priority[size - 1]) continue;
      let i = Math.min(size, cap - 1);
      while (i > 0 && key < this.priority[i - 1]) {
        this.priority[i] = this.priority[i - 1]; this.selected[i] = this.selected[i - 1]; i--;
      }
      this.priority[i] = key; this.selected[i] = v; size = Math.min(cap, size + 1);
    }
    if (!size) { f.metrics.planningMs += performance.now() - started; return; }
    this.detailLeft = size * SHORTLIST;
    // Stranded trucks reserve drivers before any of this batch's support seats.
    for (let n = 0; n < size; n++) if (f.seat(this.selected[n], DRIVER) < 0) f.recruit(this.selected[n]);
    for (let n = 0; n < size; n++) {
      const v = this.selected[n], ready = f.urgent[v] ? f.due[v] : Math.max(f.due[v], f.committedUntil[v]), waiting = Math.max(0, now - ready);
      f.metrics.decisions++; f.metrics.queueDelay += waiting; f.metrics.maxQueueDelay = Math.max(f.metrics.maxQueueDelay, waiting);
      f.due[v] = now + t.truckDecisionInterval; f.urgent[v] = 0;
      f.recoverAt[v] = now + Math.min(t.truckDecisionInterval, 0.36);
      if (f.seat(v, DRIVER) >= 0) {
        if (f.seat(v, GUNNER) < 0 || f.seat(v, PASSENGER) < 0) f.recruit(v);
        this.plan(v, waiting);
      }
    }
    f.metrics.planningMs += performance.now() - started;
  }

  private locateGroups(v: number, reach: number, gunner: number) {
    const f = this.f, sim = f.sim, g = sim.grid, team = 1 - f.team[v], x = f.x[v], z = f.z[v];
    this.threats.fill(-1); this.threatDistance.fill(Infinity); this.groups.fill(-1);
    const left = g.column(x - reach), right = g.column(x + reach), near = g.row(z - reach), far = g.row(z + reach);
    for (let row = near; row <= far; row++) for (let col = left; col <= right; col++) {
      const cell = row * g.columns + col;
      if (!g.teamCounts[team][cell]) continue;
      for (let i = g.heads[cell]; i >= 0; i = g.next[i]) {
        if (sim.team[i] !== team) continue;
        const dx = sim.x[i] - x, dz = sim.z[i] - z, d = dx * dx + dz * dz;
        const sector = +(dx < 0) + 2 * +(dz < 0) + 4 * +(Math.abs(dx) > Math.abs(dz));
        if (d < this.threatDistance[sector]) { this.threatDistance[sector] = d; this.threats[sector] = i; }
      }
    }
    const target = gunner < 0 ? -1 : sim.byId.get(sim.target[gunner]) ?? -1;
    let found = 0;
    if (target >= 0 && sim.hp[target] > 0 && sim.team[target] === team && Math.hypot(sim.x[target] - x, sim.z[target] - z) <= reach) this.groups[found++] = target;
    for (let n = 0; n < 8 && found < this.groups.length; n++) {
      let best = -1, distance = Infinity;
      for (let k = 0; k < 8; k++) if (this.threatDistance[k] < distance) { distance = this.threatDistance[k]; best = k; }
      if (best < 0) break;
      const i = this.threats[best]; this.threatDistance[best] = Infinity;
      let same = false;
      for (let k = 0; k < found; k++) {
        const j = this.groups[k];
        if (Math.hypot(sim.x[i] - sim.x[j], sim.z[i] - sim.z[j]) < 3.2) { same = true; break; }
      }
      if (!same) this.groups[found++] = i;
    }
  }

  private plan(v: number, waiting: number) {
    const f = this.f, sim = f.sim, t = sim.tuning, gunner = f.seat(v, GUNNER), range = f.range ?? 0;
    const trace = f.trace;
    const x = f.x[v], z = f.z[v], yaw = f.yaw[v], enemy = 1 - f.team[v];
    // A truck with no clear cruise route can work its way out on a shorter sweep.
    const recovering = f.speed(v) < 1.5 && (f.blocked[v] || f.mode[v] === Maneuver.Hold);
    const speed = recovering ? Math.min(t.truckSpeed, 2.8) : t.truckSpeed;
    const reverse = recovering ? Math.min(t.truckReverseSpeed, 1.7) : t.truckReverseSpeed;
    const armed = gunner >= 0 && sim.weaponsEnabled && range > 0;
    const standoff = this.standoff(range);
    this.locateGroups(v, Math.max(range + 3, 13), gunner);
    this.routeCount = 0;
    if (f.hasReservation(v) && f.canWaitForPickup(v)) {
      this.commit(v, Maneuver.Pickup, yaw, 0);
      trace?.decision(v, 'pickup', waiting, 0, [], null);
      return;
    }
    let trafficAhead = 0;
    for (let n = 0; n < this.groups.length; n++) {
      const i = this.groups[n];
      if (n && i < 0) break;
      const tx = i < 0 ? sim.centerX[enemy] : sim.x[i], tz = i < 0 ? sim.centerZ[enemy] : sim.z[i];
      const toward = Math.atan2(tx - x, tz - z), distance = Math.hypot(tx - x, tz - z);
      if (n === 0) trafficAhead = this.add(v, Maneuver.Approach, toward, speed * 0.75, i);
      else if (distance > standoff + 0.6) this.add(v, Maneuver.Approach, toward, speed * 0.75, i);
      if (armed) {
        const offset = distance > standoff + 3 ? 0.72 : distance > standoff ? 1.12 : distance < standoff - 2.3 ? 2.10 : 1.59;
        this.add(v, Maneuver.Pass, toward + offset, speed * 0.72, i);
        this.add(v, Maneuver.Pass, toward - offset, speed * 0.72, i);
      }
      if (i >= 0 && t.truckRamAggression > 0 && distance < t.truckSpeed * 1.4 + 2) this.add(v, Maneuver.Ram, toward, t.truckSpeed, i);
    }
    const toward = this.groups[0] < 0 ? Math.atan2(sim.centerX[enemy] - x, sim.centerZ[enemy] - z)
      : Math.atan2(sim.x[this.groups[0]] - x, sim.z[this.groups[0]] - z);
    if (trafficAhead > 0 || f.blocked[v] || f.mode[v] === Maneuver.Detour) {
      for (const angle of DETOUR_ANGLES) this.add(v, Maneuver.Detour, toward + angle, speed * 0.66, this.groups[0]);
    }
    this.add(v, Maneuver.Escape, toward + Math.PI, speed * 0.8, this.groups[0]);
    this.add(v, Maneuver.Escape, yaw, speed * 0.72, this.groups[0]);
    this.add(v, Maneuver.Escape, yaw + 0.62, speed * 0.66, this.groups[0]);
    this.add(v, Maneuver.Escape, yaw - 0.62, speed * 0.66, this.groups[0]);
    this.add(v, Maneuver.Reverse, yaw, -reverse, this.groups[0]);
    this.add(v, Maneuver.Reverse, yaw + 0.75, -reverse, this.groups[0]);
    this.add(v, Maneuver.Reverse, yaw - 0.75, -reverse, this.groups[0]);
    let best: Route | null = null, score = -Infinity, selectedCheck: number | null = null;
    const checks: RouteCheck[] | undefined = trace ? [] : undefined;
    // Keep some of the global budget for later trucks even if this one has no clear route.
    for (let n = 0; n < SHORTLIST && this.detailLeft > 0; n++) {
      let candidate: Route | null = null;
      for (let k = 0; k < this.routeCount; k++) if (this.routes[k].score > (candidate?.score ?? -Infinity)) candidate = this.routes[k];
      if (!candidate) break;
      const coarse = candidate.score; candidate.score = -Infinity;
      this.detailLeft--; f.metrics.detailedPaths++;
      const check: RouteCheck | undefined = checks && {
        mode: maneuverName(candidate.mode), yaw: candidate.yaw, speed: candidate.speed,
        targetId: candidate.target < 0 ? null : sim.id[candidate.target], coarseScore: coarse, score: null, blockedBy: null,
      };
      const detail = this.detail(v, candidate, armed, range, check);
      if (check) {
        check.score = Number.isFinite(detail) ? coarse + detail : null;
        checks!.push(check);
      }
      if (coarse + detail > score) { best = candidate; score = coarse + detail; selectedCheck = n; }
    }
    if (best) {
      this.commit(v, best.mode, best.yaw, best.speed);
      if (gunner >= 0 && best.target >= 0 && (best.mode === Maneuver.Pass || best.mode === Maneuver.Approach)) sim.target[gunner] = sim.id[best.target];
      if (trace && checks) trace.decision(v, 'route-selected', waiting, this.routeCount, checks, selectedCheck);
      return;
    }
    // A truck can stop inside the planner's extra clearance after a collision.
    // Test straight, slow recovery at the physical footprint so it can leave that margin.
    const recovery: RecoveryCheck[] | undefined = trace ? [] : undefined;
    const blocker = f.ground.lastBlocker;
    let reverseRock: number | null = null;
    for (const direction of RECOVERY_DIRECTIONS) {
      const tx = x + direction * f.sin[v] * RECOVERY_DISTANCE, tz = z + direction * f.cos[v] * RECOVERY_DISTANCE;
      const clear = f.ground.clear(v, x, z, yaw, tx, tz, yaw, 0, 'all', undefined, blocker);
      const reverse = direction < 0;
      if (recovery) recovery.push({
        direction: reverse ? 'reverse' : 'forward',
        blockedBy: clear ? null : this.routeBlock(reverse ? 'reverse-fallback' : 'forward-fallback', x, z, tx, tz),
      });
      if (!clear) {
        if (reverse) reverseRock = blocker.kind === 'rock' ? blocker.id : null;
        continue;
      }
      const speed = direction * Math.min(2, reverse ? t.truckReverseSpeed : t.truckSpeed);
      this.commit(v, reverse ? Maneuver.Reverse : Maneuver.Escape, yaw, speed);
      if (trace && checks) trace.decision(v, reverse ? 'fallback-reverse' : 'fallback-forward', waiting, this.routeCount, checks, null, recovery);
      return;
    }
    // A rock alongside the chassis can cut off both straight paths.
    if (reverseRock !== null && blocker.kind === 'rock' && blocker.id === reverseRock) {
      const reverseSpeed = -Math.min(2, t.truckReverseSpeed);
      for (const steering of RECOVERY_STEERING) {
        if (!this.checkSteeredReverse(v, steering, reverseSpeed, recovery)) continue;
        this.commit(v, Maneuver.Reverse, yaw + steering, reverseSpeed);
        if (trace && checks) trace.decision(v, 'fallback-reverse', waiting, this.routeCount, checks, null, recovery);
        return;
      }
    }
    this.commit(v, Maneuver.Hold, yaw, 0);
    if (trace && checks) trace.decision(v, 'no-clear-route', waiting, this.routeCount, checks, null, recovery);
  }

  private checkSteeredReverse(v: number, steering: number, speed: number, recovery?: RecoveryCheck[]) {
    const f = this.f, startX = f.x[v], startZ = f.z[v], heading = f.yaw[v] + steering;
    let x = startX, z = startZ, yaw = f.yaw[v], vx = f.vx[v], vz = f.vz[v];
    // Near a rock, one long chord can cross the obstacle even when the actual turn clears it.
    for (let n = 0; n < RECOVERY_STEPS; n++) {
      const next = f.ground.nextMotion(yaw, vx, vz, Math.hypot(vx, vz), heading, speed);
      const tx = x + next.vx * CONFIG.step, tz = z + next.vz * CONFIG.step;
      if (!f.ground.clear(v, x, z, yaw, tx, tz, next.yaw, 0, 'all')) {
        recovery?.push({ direction: 'reverse', steering, blockedBy: this.routeBlock('reverse-fallback', x, z, tx, tz) });
        return false;
      }
      x = tx; z = tz; yaw = next.yaw; vx = next.vx; vz = next.vz;
      if ((x - startX) ** 2 + (z - startZ) ** 2 >= RECOVERY_DISTANCE ** 2) break;
    }
    recovery?.push({ direction: 'reverse', steering, blockedBy: null });
    return true;
  }

  private standoff(range: number) {
    const sim = this.f.sim, gap = range - sim.rifle.range;
    return Math.min(range - Math.min(0.12, gap * 0.12), sim.rifle.range + gap * sim.tuning.truckStandoff);
  }

  private commit(v: number, mode: Maneuver, yaw: number, speed: number) {
    const f = this.f;
    f.mode[v] = mode; f.desiredYaw[v] = yaw; f.desiredSpeed[v] = speed; f.exitLeft[v] = 0; f.blocked[v] = f.stalledTicks[v] = 0;
    f.committedUntil[v] = f.sim.time + (mode === Maneuver.Pickup ? 0.35 : f.sim.tuning.truckCommitment);
  }

  private routeBlock(segment: RouteBlock['segment'], x: number, z: number, tx: number, tz: number): RouteBlock {
    return { segment, from: { x, z }, to: { x: tx, z: tz }, blocker: { ...this.f.ground.lastBlocker } };
  }

  private add(v: number, mode: Maneuver, heading: number, targetSpeed: number, target: number) {
    const f = this.f, sim = f.sim, t = sim.tuning, route = this.routes[this.routeCount++];
    route.mode = mode; route.yaw = heading; route.speed = targetSpeed; route.target = target;
    let x = f.x[v], z = f.z[v], yaw = f.yaw[v], speed = f.vx[v] * f.sin[v] + f.vz[v] * f.cos[v];
    const team = f.team[v], range = f.range ?? 0, rifle = sim.rifle.range, armed = f.seat(v, GUNNER) >= 0 && sim.weaponsEnabled;
    const tx = target < 0 ? sim.centerX[1 - team] : sim.x[target], tz = target < 0 ? sim.centerZ[1 - team] : sim.z[target];
    const initial = Math.hypot(tx - x, tz - z), stand = armed ? this.standoff(range) : 0;
    let risk = 0, congestion = 0, lane = 0, wall = 0, nearest = initial, traffic = 0;
    const clearance = TRUCK.radius + t.radius;
    const ownCell = this.truckCells[v];
    for (let n = 0; n < SAMPLES; n++) {
      const delta = angleDelta(heading, yaw), turn = t.truckTurnRate * STRIDE / (1 + 0.075 * Math.abs(speed));
      const next = yaw + Math.max(-turn, Math.min(turn, delta));
      const wanted = targetSpeed * Math.max(0.14, Math.cos(delta));
      const accel = (Math.sign(wanted) === Math.sign(speed) && Math.abs(wanted) > Math.abs(speed) || !speed ? t.truckAcceleration : t.truckBraking) * STRIDE;
      const after = speed + Math.max(-accel, Math.min(accel, wanted - speed)), travel = (speed + after) * STRIDE * 0.5;
      const mid = (yaw + next) * 0.5;
      const oldX = x, oldZ = z;
      x += Math.sin(mid) * travel; z += Math.cos(mid) * travel; yaw = next; speed = after;
      route.x[n] = x; route.z[n] = z; route.heading[n] = yaw; route.velocity[n] = Math.abs(speed);
      if (Math.abs(x) + TRUCK.reach * 0.73 > sim.grid.halfWidth || Math.abs(z) + TRUCK.reach * 0.73 > sim.grid.halfDepth) wall += 4;
      let nearestSquare = Infinity;
      for (const i of this.threats) if (i >= 0) nearestSquare = Math.min(nearestSquare, (sim.x[i] - x) ** 2 + (sim.z[i] - z) ** 2);
      nearest = Math.sqrt(nearestSquare);
      const exposure = this.enemiesNear(x, z, team, rifle * 0.76);
      risk += Math.log1p(exposure) * (nearest < rifle ? 1 : 0.26);
      congestion += Math.max(0, this.count(x, z, team, 1.05) - 3);
      if (mode !== Maneuver.Ram) {
        const occupancy = this.count(x, z, TRAFFIC, clearance, ownCell);
        const midway = Math.abs(travel) > clearance ? this.count((x + oldX) * 0.5, (z + oldZ) * 0.5, TRAFFIC, clearance, ownCell) : 0;
        traffic += Math.log1p(Math.max(occupancy, midway));
      }
      if (armed && nearest < range + 0.7) {
        // Measure the edge of the crowd, not the distance to the center of the chosen group.
        lane += Math.max(-2, 1.25 - Math.abs(nearest - stand) * 0.48);
      }
    }
    const finish = Math.hypot(tx - x, tz - z), advance = initial - finish;
    const exitX = x + Math.sin(yaw) * Math.sign(targetSpeed) * 2.2, exitZ = z + Math.cos(yaw) * Math.sign(targetSpeed) * 2.2;
    const ahead = Math.log1p(this.enemiesNear(exitX, exitZ, team, 2));
    if (mode !== Maneuver.Ram) traffic += Math.log1p(this.count(exitX, exitZ, TRAFFIC, clearance, ownCell));
    const traveled = Math.hypot(x - f.x[v], z - f.z[v]);
    let score = 0.2 * traveled - wall - congestion * t.truckFriendlyRisk * 0.09 - traffic * 2.0;
    score += lane * 0.72 - t.truckCrowdRisk * (risk * 0.31 + ahead * 0.65);
    if (mode === Maneuver.Approach || mode === Maneuver.Pass) {
      if (initial > stand + 0.8) {
        score += advance * (advance < 0 ? 0.35 : armed ? 0.55 : 0.83);
        // Give a turn back toward the fight credit even while momentum still carries the truck away.
        score += 1.5 * (Math.cos(angleDelta(heading, yaw)) - Math.cos(angleDelta(heading, f.yaw[v])));
      } else score += (nearest - stand) * (nearest < stand ? 0.65 : -0.34);
      if (mode === Maneuver.Pass && initial < range + 1.5) score += 0.6;
    } else if (mode === Maneuver.Detour) {
      const toward = Math.atan2(tx - f.x[v], tz - f.z[v]);
      score += advance * 0.24 + traveled * 0.22;
      if (f.mode[v] === Maneuver.Detour && angleDelta(f.desiredYaw[v], toward) * angleDelta(heading, toward) > 0) score += 0.9;
    } else if (mode === Maneuver.Escape || mode === Maneuver.Reverse) {
      score -= mode === Maneuver.Reverse ? (f.blocked[v] ? -1.6 : 2.6) : 0.9;
      if (armed && initial < rifle * 0.85) score += Math.min(3, nearest - initial) * 0.76;
      else score += Math.min(0, advance) * 0.45;
    } else if (mode === Maneuver.Ram) {
      score += this.chargeValue(v, route, initial);
    }
    if (f.blocked[v] && mode !== Maneuver.Reverse && Math.abs(angleDelta(heading, f.yaw[v])) < 0.28) score -= 2;
    route.score = score;
    return traffic;
  }

  private chargeValue(v: number, route: Route, distance: number) {
    const f = this.f, sim = f.sim, g = sim.grid, t = sim.tuning, team = f.team[v];
    if (++this.ramQuery === 0xffffffff) { this.ramStamp.fill(0); this.ramQuery = 1; }
    let x = f.x[v], z = f.z[v], hits = 0, allies = 0, speedFactor = 1;
    const reach = TRUCK.radius + t.radius;
    for (let n = 0; n < SAMPLES; n++) {
      const tx = route.x[n], tz = route.z[n], dx = tx - x, dz = tz - z, length2 = dx * dx + dz * dz;
      if (length2 < 0.0025) continue;
      const l = g.column(Math.min(x, tx) - reach), r = g.column(Math.max(x, tx) + reach);
      const a = g.row(Math.min(z, tz) - reach), b = g.row(Math.max(z, tz) + reach);
      let enemies = 0;
      for (let row = a; row <= b; row++) for (let col = l; col <= r; col++) {
        const cell = row * g.columns + col;
        if (!g.teamCounts[0][cell] && !g.teamCounts[1][cell]) continue;
        for (let i = g.heads[cell]; i >= 0; i = g.next[i]) {
          if (this.ramStamp[i] === this.ramQuery || !f.onFoot(i)) continue;
          const rx = sim.x[i] - x, rz = sim.z[i] - z;
          const u = Math.max(0, Math.min(1, (rx * dx + rz * dz) / length2));
          if ((rx - dx * u) ** 2 + (rz - dz * u) ** 2 > reach * reach) continue;
          if (sim.team[i] === team) { allies++; this.ramStamp[i] = this.ramQuery; }
          else if (route.velocity[n] > t.truckRamSpeed) { enemies++; this.ramStamp[i] = this.ramQuery; }
        }
      }
      for (let j = 0; j < Math.min(5, enemies) && route.velocity[n] * speedFactor > t.truckRamSpeed; j++) {
        hits++; speedFactor *= 1 - t.truckImpactLoss;
      }
      x = tx; z = tz;
    }
    const hull = Math.min(1, f.hp[v] / t.truckHealth);
    const exposed = this.enemiesNear(f.x[v], f.z[v], team, sim.rifle.range * 0.64);
    const breakout = exposed >= 9 && this.enemiesNear(x, z, team, 2) <= exposed / 4;
    // Give a clear run-up a chance even if its first contact is just beyond the sampled path.
    const runup = distance >= t.truckRamSpeed ** 2 / (2 * t.truckAcceleration) + 0.8
      && distance < Math.hypot(x - f.x[v], z - f.z[v]) + 2.4 && route.velocity[SAMPLES - 1] > t.truckRamSpeed;
    if (!hits && !runup && !breakout) return -7 - allies * t.truckFriendlyRisk;
    const crew = f.seat(v, GUNNER) >= 0 ? 2 + Number(f.seat(v, PASSENGER) >= 0) : 1 + Number(f.seat(v, PASSENGER) >= 0);
    return t.truckRamAggression * (hits * (2 + hull * 1.9) + (runup ? 2.2 : 0) + (breakout ? 2.3 : 0))
      - allies * t.truckFriendlyRisk * 2.2 - (1 - hull) * (2.6 + exposed * 0.10) - crew * (1 - t.truckCrewArmor) * exposed * 0.022;
  }

  private detail(v: number, route: Route, armed: boolean, range: number, check?: RouteCheck) {
    const f = this.f, sim = f.sim;
    let x = f.x[v], z = f.z[v], yaw = f.yaw[v];
    for (let n = 0; n < SAMPLES; n++) {
      const tx = route.x[n], tz = route.z[n], a = route.heading[n];
      const startSpeed = n === 0 ? f.speed(v) : route.velocity[n - 1];
      const ramming = route.mode === Maneuver.Ram && Math.min(startSpeed, route.velocity[n]) > sim.tuning.truckRamSpeed;
      if (!f.ground.clear(v, x, z, yaw, tx, tz, a, 0.02, ramming ? 'allies' : 'all')) {
        if (check) check.blockedBy = this.routeBlock(n + 1, x, z, tx, tz);
        return -Infinity;
      }
      x = tx; z = tz; yaw = a;
    }
    const direction = Math.sign(route.speed), ex = x + Math.sin(yaw) * direction * 1.3, ez = z + Math.cos(yaw) * direction * 1.3;
    const ramming = route.mode === Maneuver.Ram && route.velocity[SAMPLES - 1] > sim.tuning.truckRamSpeed;
    const exitClear = f.ground.clear(v, x, z, yaw, ex, ez, yaw, 0.03, ramming ? 'allies' : 'all');
    if (!exitClear && check) check.blockedBy = this.routeBlock('exit', x, z, ex, ez);
    let score = exitClear ? 0.5 : -2.3;
    if (armed && route.target >= 0 && route.mode !== Maneuver.Ram) {
      const i = route.target, h = sim.y[i] + 0.7;
      for (let n = 1; n < SAMPLES; n += 2) {
        const x = route.x[n], z = route.z[n], y = sim.terrain.heightAt(x, z) + TRUCK.turret.y;
        if (Math.hypot(sim.x[i] - x, h - y, sim.z[i] - z) <= range) {
          score += sim.turretLane(f.seat(v, GUNNER), x, y, z, i, range) ? 1.45 : -1.25;
        }
      }
    }
    return score;
  }
}
