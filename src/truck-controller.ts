import { CONFIG } from './config.ts';
import { rayCircle } from './collision.ts';
import { DRIVER, Maneuver, TRUCK, angleDelta, type TruckBlocker } from './vehicle-types.ts';
import type { VehicleFleet } from './vehicles.ts';

const SKIN = 0.002;
type FootTraffic = 'all' | 'allies' | 'none';

/** Ground physics for the truck. Crew, weapons, and damage belong to the fleet. */
export class TruckController {
  private readonly ax = new Float64Array(TRUCK.disks.length);
  private readonly az = new Float64Array(TRUCK.disks.length);
  private readonly bx = new Float64Array(TRUCK.disks.length);
  private readonly bz = new Float64Array(TRUCK.disks.length);
  private readonly motion = { yaw: 0, vx: 0, vz: 0 };
  private readonly contactLatch = new Map<number, { truck: number; soldier: number }>();
  private contactFoot = -1;
  private contactTruck = -1;
  private contactNX = 0;
  private contactNZ = 0;
  private contactSpeed = 0;
  /** Scratch output. Copy it after a failed sweep when a trace is active. */
  readonly lastBlocker: TruckBlocker = { kind: 'map-edge', id: null, x: 0, z: 0, atStart: false, padding: 0 };
  footNX = 0;
  footNY = 0;
  footNZ = 0;

  private readonly fleet: VehicleFleet;
  constructor(fleet: VehicleFleet) { this.fleet = fleet; }

  supportHeight(x: number, z: number, sn: number, cs: number) {
    const terrain = this.fleet.sim.terrain, axle = TRUCK.disks[2], dx = sn * axle, dz = cs * axle;
    return Math.max(terrain.heightAt(x, z), (terrain.heightAt(x + dx, z + dz) + terrain.heightAt(x - dx, z - dz)) * 0.5);
  }

  /** Exact disk sweeps for translation; the short rotation chord is padded by its arc sagitta. */
  private sweep(v: number, x: number, z: number, yaw: number, tx: number, tz: number, tyaw: number,
    clearance: number, feet: FootTraffic, ignore?: readonly number[], truncate = false,
    blocker = this.fleet.trace && v >= 0 ? this.lastBlocker : undefined) {
    const f = this.fleet, sim = f.sim, grid = sim.grid, trucks = f.grid;
    const sin = Math.sin(yaw), cos = Math.cos(yaw), sn = Math.sin(tyaw), cs = Math.cos(tyaw);
    const radius = TRUCK.radius + clearance + TRUCK.reach * (1 - Math.cos(angleDelta(tyaw, yaw) * 0.5));
    if (blocker) blocker.padding = radius - TRUCK.radius;
    this.contactFoot = this.contactTruck = -1;
    let fraction = 1;
    for (let k = 0; k < TRUCK.disks.length; k++) {
      const d = TRUCK.disks[k];
      this.ax[k] = x + sin * d; this.az[k] = z + cos * d;
      this.bx[k] = tx + sn * d; this.bz[k] = tz + cs * d;
      const ax = this.ax[k], az = this.az[k], dx = this.bx[k] - ax, dz = this.bz[k] - az;
      if (!sim.terrain.driveClear(ax, az, ax + dx * fraction, az + dz * fraction, radius, sim.tuning.truckSlope, blocker)) {
        if (!truncate) return 0;
        let lo = 0, hi = fraction;
        for (let n = 0; n < 5; n++) {
          const m = (lo + hi) * 0.5;
          if (sim.terrain.driveClear(ax, az, ax + dx * m, az + dz * m, radius, sim.tuning.truckSlope)) lo = m;
          else hi = m;
        }
        fraction = lo;
      }
    }
    const y = v < 0 ? sim.terrain.heightAt(x, z) : sim.terrain.heightAt(tx, tz);
    const reach = radius + 0.39 + Math.max(TRUCK.reach, sim.tuning.radius);
    const left = grid.column(Math.min(x, tx) - reach), right = grid.column(Math.max(x, tx) + reach);
    const near = grid.row(Math.min(z, tz) - reach), far = grid.row(Math.max(z, tz) + reach);
    for (let row = near; row <= far; row++) for (let col = left; col <= right; col++) {
      const cell = row * grid.columns + col;
      for (let i = feet === 'none' ? -1 : grid.heads[cell]; i >= 0; i = grid.next[i]) {
        if (feet === 'allies' && sim.team[i] !== f.team[v]) continue;
        if (!f.onFoot(i) || ignore?.includes(i) || sim.y[i] > y + TRUCK.hull.top + 0.02 || sim.y[i] + CONFIG.soldier.height < y) continue;
        const dist = this.sweepDisks(sim.x[i], sim.z[i], radius + sim.radius[i] + SKIN, fraction);
        if (dist >= fraction) continue;
        if (blocker) {
          blocker.kind = 'infantry'; blocker.id = sim.id[i]; blocker.x = sim.x[i]; blocker.z = sim.z[i]; blocker.atStart = dist === 0;
        }
        if (!truncate) return dist;
        fraction = dist; this.contactFoot = i; this.contactTruck = -1;
      }
      for (let other = trucks.heads[cell]; other >= 0; other = trucks.next[other]) {
        if (other === v || Math.abs(f.y[other] - y) > TRUCK.hull.top + 0.24) continue;
        for (const offset of TRUCK.disks) {
          const dist = this.sweepDisks(f.x[other] + f.sin[other] * offset, f.z[other] + f.cos[other] * offset,
            radius + TRUCK.radius + SKIN, fraction);
          if (dist >= fraction) continue;
          if (blocker) {
            blocker.kind = 'truck'; blocker.id = f.id[other]; blocker.x = f.x[other]; blocker.z = f.z[other]; blocker.atStart = dist === 0;
          }
          if (!truncate) return dist;
          fraction = dist; this.contactFoot = -1; this.contactTruck = other;
        }
      }
    }
    return fraction;
  }

  private sweepDisks(x: number, z: number, radius: number, fraction: number) {
    for (let k = 0; k < TRUCK.disks.length; k++) {
      const ax = this.ax[k], az = this.az[k], dx = this.bx[k] - ax, dz = this.bz[k] - az;
      const ox = x - ax, oz = z - az;
      if (Math.abs(ox) > radius + Math.abs(dx) || Math.abs(oz) > radius + Math.abs(dz)) continue;
      this.fleet.metrics.contactChecks++;
      const square = ox * ox + oz * oz, inward = ox * dx + oz * dz, len = Math.hypot(dx, dz);
      let t: number;
      if (square <= radius * radius) {
        // A touching disk can move away or slide tangent, including when backing out.
        if (len > 1e-8 && inward <= 1e-10) continue;
        t = 0;
      } else {
        if (len < 1e-8 || inward <= 0) continue;
        t = rayCircle(ax, az, dx / len, dz / len, x, z, radius) / len;
      }
      if (t >= fraction) continue;
      fraction = t;
      const nx = ox - dx * t, nz = oz - dz * t, d = Math.hypot(nx, nz);
      this.contactNX = d > 1e-8 ? nx / d : len > 0 ? dx / len : 0;
      this.contactNZ = d > 1e-8 ? nz / d : len > 0 ? dz / len : 0;
      this.contactSpeed = (dx * this.contactNX + dz * this.contactNZ) / CONFIG.step;
    }
    return fraction;
  }

  clear(v: number, x: number, z: number, yaw: number, tx: number, tz: number, tyaw: number,
    margin: number, feet: FootTraffic, ignore?: readonly number[], blocker?: TruckBlocker) {
    // Placement starts with a static footprint test; the sweep then checks the exit.
    return this.sweep(v, x, z, yaw, tx, tz, tyaw, margin, feet, ignore, false, blocker) === 1;
  }

  blocksFoot(x: number, y: number, z: number, radius: number) {
    const f = this.fleet, grid = f.grid, reach = TRUCK.reach + radius + SKIN, r = TRUCK.radius + radius + SKIN;
    for (let row = grid.row(z - reach); row <= grid.row(z + reach); row++) for (let col = grid.column(x - reach); col <= grid.column(x + reach); col++) {
      for (let v = grid.heads[row * grid.columns + col]; v >= 0; v = grid.next[v]) {
        if (y >= f.y[v] + TRUCK.hull.top || y + CONFIG.soldier.height <= f.y[v]) continue;
        for (const offset of TRUCK.disks) {
          if ((x - f.x[v] - f.sin[v] * offset) ** 2 + (z - f.z[v] - f.cos[v] * offset) ** 2 < r * r) return true;
        }
      }
    }
    return false;
  }

  /** Sweep a soldier's feet against the solid chassis extrusions. Also used by airborne bodies. */
  sweepFoot(x: number, y: number, z: number, dx: number, dy: number, dz: number, limit: number, radius: number) {
    const f = this.fleet, grid = f.grid, reach = TRUCK.reach + radius + SKIN;
    const tx = x + dx * limit, tz = z + dz * limit, r = TRUCK.radius + radius + SKIN;
    const left = grid.column(Math.min(x, tx) - reach), right = grid.column(Math.max(x, tx) + reach);
    const near = grid.row(Math.min(z, tz) - reach), far = grid.row(Math.max(z, tz) + reach);
    const a = dx * dx + dz * dz;
    this.footNX = this.footNY = this.footNZ = 0;
    for (let row = near; row <= far; row++) for (let col = left; col <= right; col++) {
      for (let v = grid.heads[row * grid.columns + col]; v >= 0; v = grid.next[v]) {
        const bottom = f.y[v] - CONFIG.soldier.height, top = f.y[v] + TRUCK.hull.top;
        let lo = 0, hi = limit;
        if (Math.abs(dy) < 1e-10) { if (y < bottom || y >= top - 1e-7) continue; }
        else {
          const l = (bottom - y) / dy, h = (top - y) / dy;
          lo = Math.max(lo, Math.min(l, h)); hi = Math.min(hi, Math.max(l, h));
          if (lo > hi || (lo === 0 && (dy > 0 && y >= top || dy < 0 && y <= bottom))) continue;
        }
        for (const offset of TRUCK.disks) {
          const ox = x - f.x[v] - f.sin[v] * offset, oz = z - f.z[v] - f.cos[v] * offset;
          const c = ox * ox + oz * oz - r * r, b = ox * dx + oz * dz;
          let enter = lo, leave = hi;
          if (a < 1e-12) { if (c > 0) continue; }
          else {
            if (c <= 1e-8 && b >= 0 && lo === 0 && a > 0) continue;
            const d = b * b - a * c;
            if (d < 0) continue;
            const s = Math.sqrt(d);
            enter = Math.max(enter, (-b - s) / a); leave = Math.min(leave, (-b + s) / a);
          }
          if (enter > leave || enter >= limit) continue;
          const hx = ox + dx * enter, hz = oz + dz * enter, len = Math.hypot(hx, hz);
          const vertical = (lo > 0 || dy < 0 && y >= top - 1e-7) && enter === lo && len < r - 1e-7;
          if (!vertical && len < 1e-8) continue;
          limit = enter; hi = Math.min(hi, limit);
          this.footNX = vertical ? 0 : hx / len; this.footNZ = vertical ? 0 : hz / len;
          this.footNY = vertical ? (dy < 0 ? 1 : -1) : 0;
        }
      }
    }
    return limit;
  }

  releaseContacts() {
    const f = this.fleet, sim = f.sim;
    for (const [key, id] of this.contactLatch) {
      const v = Math.floor(key / sim.capacity), i = key % sim.capacity;
      const reach = TRUCK.radius + sim.radius[i] + 0.04;
      if (f.hp[v] <= 0 || f.id[v] !== id.truck || sim.id[i] !== id.soldier || sim.hp[i] <= 0 || !f.onFoot(i) || sim.y[i] > f.y[v] + TRUCK.hull.top + 0.04
        || !TRUCK.disks.some(d => (sim.x[i] - f.x[v] - f.sin[v] * d) ** 2 + (sim.z[i] - f.z[v] - f.cos[v] * d) ** 2 <= reach * reach)) {
        this.contactLatch.delete(key);
      }
    }
  }

  /** Calculate one physics step without changing the truck. The result is reused. */
  nextMotion(yaw: number, vx: number, vz: number, speed: number, heading: number, wanted: number) {
    const t = this.fleet.sim.tuning, dt = CONFIG.step;
    const angle = wanted ? angleDelta(heading, yaw) : 0;
    const turn = t.truckTurnRate * dt / (1 + 0.075 * speed);
    const nextYaw = yaw + Math.max(-turn, Math.min(turn, angle));
    const sn = Math.sin(nextYaw), cs = Math.cos(nextYaw);
    wanted = Math.max(-t.truckReverseSpeed, Math.min(t.truckSpeed, wanted)) * Math.max(0.14, Math.cos(angle));
    const forward = vx * sn + vz * cs, sideways = (vx * cs - vz * sn) * Math.max(0, 1 - t.truckGrip * dt);
    const limit = (Math.sign(wanted) === Math.sign(forward) && Math.abs(wanted) > Math.abs(forward) || !forward && wanted ? t.truckAcceleration : t.truckBraking) * dt;
    const nextForward = forward + Math.max(-limit, Math.min(limit, wanted - forward));
    this.motion.yaw = nextYaw;
    this.motion.vx = nextForward * sn + sideways * cs;
    this.motion.vz = nextForward * cs - sideways * sn;
    return this.motion;
  }

  drive(v: number) {
    const f = this.fleet, sim = f.sim, t = sim.tuning, dt = CONFIG.step;
    const driven = f.seat(v, DRIVER) >= 0;
    let wanted = driven && !f.blocked[v] ? f.desiredSpeed[v] : 0;
    if (f.hasReservation(v) && f.canWaitForPickup(v)) wanted = 0;
    if (f.exitLeft[v] > 0) wanted = Math.min(wanted, 2.25);
    const x = f.x[v], z = f.z[v], yaw = f.yaw[v], vx = f.vx[v], vz = f.vz[v];
    if (wanted === 0 && Math.abs(vx) + Math.abs(vz) < 1e-6) return;
    const speed = Math.hypot(vx, vz);
    const { yaw: nextYaw, vx: sx, vz: sz } = this.nextMotion(yaw, vx, vz, speed, f.desiredYaw[v], wanted);
    const dx = sx * dt, dz = sz * dt;
    const fraction = this.sweep(v, x, z, yaw, x + dx, z + dz, nextYaw, 0, 'all', undefined, true);
    const travel = fraction < 1 ? Math.max(0, fraction - 0.0001) : 1;
    f.setPose(v, x + dx * travel, z + dz * travel, yaw + angleDelta(nextYaw, yaw) * travel);
    if (f.exitLeft[v] > 0) {
      f.exitLeft[v] = Math.max(0, f.exitLeft[v] - Math.hypot(dx, dz) * travel);
      if (f.exitLeft[v] === 0) f.due[v] = Math.max(sim.time, f.due[v]);
    }
    f.vx[v] = sx; f.vz[v] = sz;
    f.recovery.blockerTruck[v] = this.contactTruck;
    if (fraction === 1) { f.stalledTicks[v] = 0; return; }
    f.stalledTicks[v] = travel > 0.35 ? 0 : Math.min(255, f.stalledTicks[v] + 1);
    f.metrics.contacts++;
    f.trace?.contact(v, this.lastBlocker, Math.hypot(sx, sz), fraction);
    const i = this.contactFoot;
    if (i >= 0) {
      const nx = this.contactNX, nz = this.contactNZ;
      const ix = sim.moving[i] ? (sim.x[i] - sim.previousX[i]) / dt : sim.velocityX[i];
      const iz = sim.moving[i] ? (sim.z[i] - sim.previousZ[i]) / dt : sim.velocityZ[i];
      const excess = this.contactSpeed - ix * nx - iz * nz - t.truckRamSpeed, key = v * sim.capacity + i;
      if (this.contactSpeed > 0.15 && excess > 0) {
        if (!this.contactLatch.has(key)) {
          this.contactLatch.set(key, { truck: f.id[v], soldier: sim.id[i] });
          f.metrics.rams++;
          sim.queueDamage(i, excess * t.truckRamDamage);
          const impulse = excess * t.truckRamImpulse;
          sim.velocityX[i] += nx * impulse; sim.velocityZ[i] += nz * impulse; sim.velocityY[i] += impulse * 0.34;
          f.vx[v] *= 1 - t.truckImpactLoss; f.vz[v] *= 1 - t.truckImpactLoss;
        }
        if (f.stalledTicks[v] < 12) return;
        if (driven) f.requestRecovery(v);
        return;
      }
      // At low speeds the pedestrian yields; never push the footprint through them.
      if (this.contactSpeed > 0.05 && sim.grounded[i]) {
        sim.velocityX[i] += nx * 0.75 + nz * sim.detourSide[i] * 0.6;
        sim.velocityZ[i] += nz * 0.75 - nx * sim.detourSide[i] * 0.6;
      }
      f.vx[v] *= 0.45; f.vz[v] *= 0.45;
      if (f.stalledTicks[v] < 12 && (f.mode[v] === Maneuver.Exit || speed < 0.9 && f.mode[v] === Maneuver.Ram)) return;
    } else f.vx[v] = f.vz[v] = 0;
    if (driven) f.requestRecovery(v);
  }
}
