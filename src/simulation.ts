import { CONFIG, WEAPONS } from './config.ts';
import { DEFAULT_TUNING, TUNING, deploymentError, type TuningValues } from './tuning.ts';
import { rayCapsule, raySegmentCapsule } from './collision.ts';
import { ExplosionEvents, validExplosion, type Explosion } from './explosions.ts';

export type Team = 0 | 1;
export type Outcome = 'running' | 'plutonians' | 'sectoids' | 'draw';
export type Command =
  | { type: 'spawn'; team: Team; x: number; z: number; weapon?: number }
  | { type: 'equip'; ids: readonly number[]; weapon: number }
  | ({ type: 'explode' } & Explosion);

export function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/** First distance along a unit direction to a circle. */
export function rayCircle(x: number, z: number, dx: number, dz: number, cx: number, cz: number, radius: number): number {
  const ox = x - cx, oz = z - cz, b = ox * dx + oz * dz;
  const c = ox * ox + oz * oz - radius * radius;
  if (c <= 0) return 0;
  if (b >= 0) return Infinity;
  const d = b * b - c;
  if (d < 0) return Infinity;
  const t = -b - Math.sqrt(d);
  return t >= 0 ? t : Infinity;
}

/** Intrusive fixed grid. Movement updates membership immediately. No per-query allocations. */
export class SpatialGrid {
  readonly columns: number;
  readonly rows: number;
  readonly heads: Int32Array;
  readonly halfWidth: number;
  readonly halfDepth: number;
  readonly cellSize: number;
  readonly next: Int32Array;
  readonly previous: Int32Array;
  readonly cell: Int32Array;
  constructor(capacity: number, halfWidth: number = CONFIG.field.halfWidth, halfDepth: number = CONFIG.field.halfDepth, cellSize: number = CONFIG.field.cellSize) {
    this.cellSize = cellSize;
    this.halfWidth = halfWidth; this.halfDepth = halfDepth;
    this.columns = Math.ceil(halfWidth * 2 / this.cellSize); this.rows = Math.ceil(halfDepth * 2 / this.cellSize);
    this.heads = new Int32Array(this.columns * this.rows).fill(-1);
    this.next = new Int32Array(capacity).fill(-1);
    this.previous = new Int32Array(capacity).fill(-1);
    this.cell = new Int32Array(capacity).fill(-1);
  }
  column(x: number) { return Math.max(0, Math.min(this.columns - 1, Math.floor((x + this.halfWidth) / this.cellSize))); }
  row(z: number) { return Math.max(0, Math.min(this.rows - 1, Math.floor((z + this.halfDepth) / this.cellSize))); }
  remove(slot: number) {
    const cell = this.cell[slot];
    if (cell < 0) return;
    const p = this.previous[slot], n = this.next[slot];
    if (p < 0) this.heads[cell] = n; else this.next[p] = n;
    if (n >= 0) this.previous[n] = p;
    this.cell[slot] = this.next[slot] = this.previous[slot] = -1;
  }
  insert(slot: number, x: number, z: number) {
    const cell = this.row(z) * this.columns + this.column(x);
    if (this.cell[slot] === cell) return;
    this.remove(slot);
    const first = this.heads[cell];
    this.next[slot] = first; this.previous[slot] = -1;
    if (first >= 0) this.previous[first] = slot;
    this.heads[cell] = slot; this.cell[slot] = cell;
  }
}

/** Bounded cosmetic event buffer: overwriting effects never changes combat. */
export class ShotEvents {
  readonly capacity = CONFIG.maxEffects;
  readonly x = new Float32Array(this.capacity);
  readonly z = new Float32Array(this.capacity);
  readonly endX = new Float32Array(this.capacity);
  readonly endZ = new Float32Array(this.capacity);
  readonly y = new Float32Array(this.capacity);
  readonly endY = new Float32Array(this.capacity);
  readonly team = new Uint8Array(this.capacity);
  readonly at = new Float64Array(this.capacity).fill(-Infinity);
  cursor = 0;
  emit(x: number, z: number, endX: number, endZ: number, team: Team, at: number, y = 0.7, endY = 0.7) {
    const i = this.cursor++ % this.capacity;
    this.x[i] = x; this.z[i] = z; this.endX[i] = endX; this.endZ[i] = endZ; this.team[i] = team; this.at[i] = at;
    this.y[i] = y; this.endY[i] = endY;
  }
}

/** Bounded combat notifications, independent of damage and visual effect pools. */
export class CombatEvents {
  readonly capacity = 256;
  readonly kind: ('shot' | 'hit' | 'death')[] = new Array(this.capacity).fill('shot');
  readonly team = new Uint8Array(this.capacity);
  readonly x = new Float32Array(this.capacity);
  readonly at = new Float64Array(this.capacity);
  cursor = 0;
  emit(kind: 'shot' | 'hit' | 'death', team: Team, x: number, at: number) {
    const i = this.cursor++ % this.capacity;
    this.kind[i] = kind; this.team[i] = team; this.x[i] = x; this.at[i] = at;
  }
}

export class BattleSimulation {
  readonly capacity: number;
  readonly x: Float64Array;
  readonly z: Float64Array;
  readonly y: Float64Array;
  readonly previousY: Float64Array;
  readonly velocityX: Float64Array;
  readonly velocityY: Float64Array;
  readonly velocityZ: Float64Array;
  readonly grounded: Uint8Array;
  readonly aimPitch: Float32Array;
  readonly previousX: Float64Array;
  readonly previousZ: Float64Array;
  readonly hp: Float32Array;
  readonly radius: Float32Array;
  readonly team: Uint8Array;
  readonly weapon: Uint8Array;
  readonly id: Uint32Array;
  readonly target: Uint32Array;
  readonly facing: Float32Array;
  readonly lastHit: Float64Array;
  readonly lastFire: Float64Array;
  readonly diedAt: Float64Array;
  readonly nextFire: Float64Array;
  readonly nextSearch: Float64Array;
  readonly moving: Uint8Array;
  readonly pendingDamage: Float32Array;
  readonly detourSide: Int8Array;
  readonly tuning: TuningValues;
  readonly rifle: { name: string; range: number; damage: number; interval: number };
  readonly byId = new Map<number, number>();
  readonly commands: Command[] = [];
  readonly grid: SpatialGrid;
  /** Larger cells keep long-range target searches from walking hundreds of empty fine cells. */
  readonly targetGrid: SpatialGrid;
  private readonly shotStamp: Uint32Array;
  private shotQuery = 0;
  private readonly detourCos = new Float64Array(3);
  private readonly detourSin = new Float64Array(3);
  readonly shots = new ShotEvents();
  readonly events = new CombatEvents();
  readonly explosions = new ExplosionEvents();
  /** Compatible with the terrain branch's heightAt convention; currently flat. */
  readonly ground = { heightAt: (_x: number, _z: number) => 0 };
  readonly alive = new Uint16Array(2);
  readonly rng: () => number;
  private readonly steeringRng: () => number;
  readonly centerX = new Float64Array(2);
  readonly centerZ = new Float64Array(2);
  time = 0;
  tick = 0;
  used = 0;
  nextId = 1;
  totalShots = 0;
  totalDeaths = 0;
  result: Outcome = 'running';
  weaponsEnabled = true;
  rejectedSpawns = 0;
  rejectedExplosions = 0;
  totalExplosions = 0;
  explosionCandidates = 0;
  collisionChecks = 0;
  activeBodies = 0;
  airborne = 0;
  endedAt = Infinity;
  get battleTime() { return Math.min(this.time, this.endedAt); }
  // Shared query scratch: all queries are synchronous.
  private nearestSlot = -1;
  private nearestDistance = Infinity;

  constructor(perTeam = CONFIG.defaultPerTeam as number, seed = CONFIG.seed as number, capacity = CONFIG.capacity as number, tuning?: TuningValues) {
    this.tuning = { ...DEFAULT_TUNING, ...tuning, count: perTeam, seed, columns: tuning?.columns ?? Math.max(1, Math.ceil(Math.sqrt(perTeam))) };
    const error = perTeam === 0 ? null : deploymentError(this.tuning);
    if (error) throw new Error(error);
    this.rifle = { ...WEAPONS[0], range: this.tuning.range, damage: this.tuning.damage, interval: this.tuning.fireInterval };
    this.capacity = capacity;
    this.x = new Float64Array(capacity); this.z = new Float64Array(capacity);
    this.y = new Float64Array(capacity); this.previousY = new Float64Array(capacity);
    this.velocityX = new Float64Array(capacity); this.velocityY = new Float64Array(capacity); this.velocityZ = new Float64Array(capacity);
    this.grounded = new Uint8Array(capacity); this.aimPitch = new Float32Array(capacity);
    this.previousX = new Float64Array(capacity); this.previousZ = new Float64Array(capacity);
    this.hp = new Float32Array(capacity); this.radius = new Float32Array(capacity);
    this.team = new Uint8Array(capacity); this.weapon = new Uint8Array(capacity);
    this.id = new Uint32Array(capacity); this.target = new Uint32Array(capacity);
    this.facing = new Float32Array(capacity); this.lastHit = new Float64Array(capacity).fill(-Infinity);
    this.lastFire = new Float64Array(capacity).fill(-Infinity); this.diedAt = new Float64Array(capacity).fill(-Infinity);
    this.nextFire = new Float64Array(capacity); this.nextSearch = new Float64Array(capacity);
    this.moving = new Uint8Array(capacity); this.pendingDamage = new Float32Array(capacity);
    this.detourSide = new Int8Array(capacity);
    this.grid = new SpatialGrid(capacity, this.tuning.halfWidth, this.tuning.halfDepth); this.rng = random(seed);
    this.targetGrid = new SpatialGrid(capacity, this.tuning.halfWidth, this.tuning.halfDepth, CONFIG.field.cellSize * 4);
    this.shotStamp = new Uint32Array(capacity);
    // A separate stream preserves deployment/fire randomness. Handedness has no
    // relationship to unit IDs, team, column parity, or storage order.
    this.steeringRng = random(seed ^ 0x51ed270b);
    if (!Number.isInteger(perTeam) || perTeam < 0 || perTeam * 2 > capacity || perTeam > 500) throw new Error('Supported deployment: 0–500 per team within capacity.');
    const columns = Math.max(1, Math.min(perTeam, this.tuning.columns));
    for (let team = 0; team < 2; team++) for (let n = 0; n < perTeam; n++) {
      const column = n % columns, row = Math.floor(n / columns), sign = team === 0 ? 1 : -1;
      // 500-unit stress deployments still fit inside the field.
      const x = (column - (columns - 1) / 2) * this.tuning.columnSpacing + (this.rng() * 2 - 1) * this.tuning.jitterX;
      const z = sign * (this.tuning.frontline + row * this.tuning.rowSpacing + this.rng() * this.tuning.jitterZ);
      if (this.spawn(team as Team, x, z) === null) throw new Error('Invalid deployment.');
    }
  }

  weaponFor(index: number) { return index === 0 ? this.rifle : WEAPONS[index]; }

  applyLiveTuning(values: TuningValues) {
    const oldHealth = this.tuning.health, oldInterval = this.rifle.interval;
    for (const def of TUNING) if (!def.restart) this.tuning[def.key] = values[def.key];
    this.rifle.range = this.tuning.range; this.rifle.damage = this.tuning.damage; this.rifle.interval = this.tuning.fireInterval;
    for (let i = 0; i < this.used; i++) if (this.hp[i] > 0) {
      if (oldHealth !== this.tuning.health) this.hp[i] = Math.min(this.tuning.health, this.hp[i] * this.tuning.health / oldHealth);
      if (this.weapon[i] === 0 && oldInterval !== this.rifle.interval) this.nextFire[i] = this.time + Math.max(0, this.nextFire[i] - this.time) * this.rifle.interval / oldInterval;
    }
  }

  queue(command: Command) {
    if (this.commands.length >= 4096) throw new Error('Battle command queue is full.');
    // Own the ID list: callers cannot change a queued command after submission.
    this.commands.push(command.type === 'equip' ? { ...command, ids: Array.from(command.ids) } : { ...command });
  }

  spawn(team: Team, x: number, z: number, weapon = 0): number | null {
    if ((team !== 0 && team !== 1) || !Number.isFinite(x) || !Number.isFinite(z) || !WEAPONS[weapon]) return null;
    const r = this.tuning.radius;
    if (Math.abs(x) > this.grid.halfWidth - r || Math.abs(z) > this.grid.halfDepth - r || !this.clearPosition(-1, x, z, r)) return null;
    let slot = -1;
    for (let i = 0; i < this.used; i++) if (this.hp[i] <= 0 && this.time - this.diedAt[i] > CONFIG.corpseLifetime) { slot = i; break; }
    if (slot < 0) { if (this.used >= this.capacity) return null; slot = this.used++; }
    if (this.id[slot]) this.byId.delete(this.id[slot]);
    const id = this.nextId++;
    this.id[slot] = id; this.byId.set(id, slot);
    this.x[slot] = this.previousX[slot] = x; this.z[slot] = this.previousZ[slot] = z;
    this.y[slot] = this.previousY[slot] = this.ground.heightAt(x, z);
    this.velocityX[slot] = this.velocityY[slot] = this.velocityZ[slot] = this.aimPitch[slot] = 0; this.grounded[slot] = 1;
    this.hp[slot] = this.tuning.health; this.radius[slot] = r;
    this.detourSide[slot] = this.steeringRng() < 0.5 ? -1 : 1;
    this.team[slot] = team; this.weapon[slot] = weapon; this.target[slot] = 0; this.moving[slot] = 0;
    this.facing[slot] = team === 0 ? Math.PI : 0;
    this.lastHit[slot] = this.lastFire[slot] = this.diedAt[slot] = -Infinity;
    this.nextFire[slot] = this.time + this.rng() * this.weaponFor(weapon).interval;
    this.nextSearch[slot] = this.time + this.rng() * this.tuning.initialSearchDelay;
    this.grid.insert(slot, x, z); this.alive[team]++;
    this.targetGrid.insert(slot, x, z);
    this.result = 'running';
    this.endedAt = Infinity;
    return id;
  }

  clearPosition(ignore: number, x: number, z: number, radius: number): boolean {
    // Current prototype supports a common infantry radius. Increase query reach when adding vehicles.
    const reach = radius + this.tuning.radius + 0.002;
    const minX = this.grid.column(x - reach), maxX = this.grid.column(x + reach);
    const minZ = this.grid.row(z - reach), maxZ = this.grid.row(z + reach);
    for (let cz = minZ; cz <= maxZ; cz++) for (let cx = minX; cx <= maxX; cx++) {
      for (let j = this.grid.heads[cz * this.grid.columns + cx]; j >= 0; j = this.grid.next[j]) {
        if (j === ignore) continue;
        const base = ignore >= 0 ? this.y[ignore] : this.ground.heightAt(x, z);
        const verticalGap = Math.max(0, Math.abs(base - this.y[j]) - (CONFIG.soldier.height - radius - this.radius[j]));
        const dx = x - this.x[j], dz = z - this.z[j], minimum = radius + this.radius[j] + 0.001;
        if (dx * dx + dz * dz + verticalGap * verticalGap < minimum * minimum - 1e-10) return false;
      }
    }
    return true;
  }

  private safeMove(i: number, x: number, z: number): boolean {
    const r = this.radius[i];
    if (Math.abs(x) > this.grid.halfWidth - r || Math.abs(z) > this.grid.halfDepth - r) return false;
    const ox = this.x[i], oz = this.z[i], dx = x - ox, dz = z - oz, lengthSquared = dx * dx + dz * dz;
    if (lengthSquared < 1e-18) return false;
    const minX = this.grid.column(Math.min(ox, x) - r * 2 - 0.01), maxX = this.grid.column(Math.max(ox, x) + r * 2 + 0.01);
    const minZ = this.grid.row(Math.min(oz, z) - r * 2 - 0.01), maxZ = this.grid.row(Math.max(oz, z) + r * 2 + 0.01);
    for (let cz = minZ; cz <= maxZ; cz++) for (let cx = minX; cx <= maxX; cx++) {
      for (let j = this.grid.heads[cz * this.grid.columns + cx]; j >= 0; j = this.grid.next[j]) {
        if (j === i) continue;
        const radius = r + this.radius[j] + 0.001;
        if (this.y[i] === this.y[j]) {
          // Exact segment/circle overlap needs no square roots or normalized direction.
          const t = Math.max(0, Math.min(1, ((this.x[j] - ox) * dx + (this.z[j] - oz) * dz) / lengthSquared));
          const ex = ox + dx * t - this.x[j], ez = oz + dz * t - this.z[j];
          if (ex * ex + ez * ez <= radius * radius) return false;
        } else if (Math.abs(this.y[i] - this.y[j]) < CONFIG.soldier.height + 0.002) {
          const axial = CONFIG.soldier.height - r - this.radius[j], length = Math.sqrt(lengthSquared);
          if (raySegmentCapsule(ox, this.y[i], oz, dx / length, 0, dz / length, this.x[j], this.y[j] - axial, this.y[j] + axial, this.z[j], radius) < length + 1e-9) return false;
        }
      }
    }
    this.x[i] = x; this.z[i] = z; this.grid.insert(i, x, z);
    this.targetGrid.insert(i, x, z);
    return true;
  }

  private nearest(i: number, radius: number): number {
    this.nearestSlot = -1; this.nearestDistance = radius * radius;
    const grid = this.targetGrid;
    const x = this.x[i], z = this.z[i];
    const minX = grid.column(x - radius), maxX = grid.column(x + radius);
    const minZ = grid.row(z - radius), maxZ = grid.row(z + radius);
    for (let cz = minZ; cz <= maxZ; cz++) for (let cx = minX; cx <= maxX; cx++) {
      const left = cx * grid.cellSize - grid.halfWidth, back = cz * grid.cellSize - grid.halfDepth;
      const cellDx = Math.max(left - x, 0, x - left - grid.cellSize), cellDz = Math.max(back - z, 0, z - back - grid.cellSize);
      if (cellDx * cellDx + cellDz * cellDz > this.nearestDistance) continue;
      for (let j = grid.heads[cz * grid.columns + cx]; j >= 0; j = grid.next[j]) {
        if (this.team[j] === this.team[i]) continue;
        const dx = this.x[j] - x, dz = this.z[j] - z, dy = this.y[j] - this.y[i], d = dx * dx + dz * dz + dy * dy;
        if (d < this.nearestDistance) { this.nearestDistance = d; this.nearestSlot = j; }
      }
    }
    return this.nearestSlot;
  }

  /** Shared damage path, independent of bounded cosmetic buffers. */
  damage(id: number, amount: number) {
    const i = this.byId.get(id);
    if (i === undefined || this.hp[i] <= 0 || !Number.isFinite(amount) || amount <= 0) return;
    this.hp[i] = Math.max(0, this.hp[i] - amount); this.lastHit[i] = this.time;
    this.events.emit(this.hp[i] === 0 ? 'death' : 'hit', this.team[i] as Team, this.x[i], this.time);
    if (this.hp[i] === 0) {
      this.diedAt[i] = this.time; this.target[i] = 0; this.moving[i] = 0;
      this.grid.remove(i); this.targetGrid.remove(i); this.alive[this.team[i]]--; this.totalDeaths++;
    }
  }

  private fire(i: number, target: number) {
    const gun = this.weaponFor(this.weapon[i]), x = this.x[i], z = this.z[i];
    const y = this.y[i] + 0.7;
    const distance = Math.hypot(this.x[target] - x, this.y[target] + 0.7 - y, this.z[target] - z);
    if (distance > gun.range || distance < 1e-8) return;
    const dx = (this.x[target] - x) / distance, dy = (this.y[target] + 0.7 - y) / distance, dz = (this.z[target] - z) / distance;
    let hit = -1, closest = gun.range;
    if (++this.shotQuery === 4294967296) { this.shotStamp.fill(0); this.shotQuery = 1; }
    // Traverse just the cells crossed by the beam. Neighboring cells account for circle radius.
    let cx = this.grid.column(x), cz = this.grid.row(z);
    const sx = dx >= 0 ? 1 : -1, sz = dz >= 0 ? 1 : -1, cell = this.grid.cellSize;
    const deltaX = Math.abs(dx) > 1e-9 ? cell / Math.abs(dx) : Infinity;
    const deltaZ = Math.abs(dz) > 1e-9 ? cell / Math.abs(dz) : Infinity;
    let tX = Math.abs(dx) > 1e-9 ? ((cx + (sx > 0 ? 1 : 0)) * cell - this.grid.halfWidth - x) / dx : Infinity;
    let tZ = Math.abs(dz) > 1e-9 ? ((cz + (sz > 0 ? 1 : 0)) * cell - this.grid.halfDepth - z) / dz : Infinity;
    let t = 0;
    while (t <= closest && cx >= 0 && cx < this.grid.columns && cz >= 0 && cz < this.grid.rows) {
      for (let row = Math.max(0, cz - 1); row <= Math.min(this.grid.rows - 1, cz + 1); row++) {
        for (let column = Math.max(0, cx - 1); column <= Math.min(this.grid.columns - 1, cx + 1); column++) {
          for (let j = this.grid.heads[row * this.grid.columns + column]; j >= 0; j = this.grid.next[j]) {
            if (this.team[j] === this.team[i]) continue;
            if (this.shotStamp[j] === this.shotQuery) continue;
            this.shotStamp[j] = this.shotQuery;
            const d = dy === 0 && this.y[i] === this.y[j]
              ? rayCircle(x, z, dx, dz, this.x[j], this.z[j], this.radius[j])
              : rayCapsule(x, y, z, dx, dy, dz, this.x[j], this.y[j], this.z[j], this.radius[j]);
            if (d < closest) { closest = d; hit = j; }
          }
        }
      }
      if (tX < tZ) { t = tX; tX += deltaX; cx += sx; } else { t = tZ; tZ += deltaZ; cz += sz; }
    }
    if (hit >= 0) this.pendingDamage[hit] += gun.damage;
    this.lastFire[i] = this.time; this.nextFire[i] = this.time + gun.interval;
    this.facing[i] = Math.atan2(dx, dz); this.totalShots++;
    this.aimPitch[i] = -Math.asin(Math.max(-1, Math.min(1, dy)));
    this.events.emit('shot', this.team[i] as Team, x, this.time);
    this.shots.emit(x + dx * 0.44, z + dz * 0.44, x + dx * closest, z + dz * closest, this.team[i] as Team, this.time, y + dy * 0.44, y + dy * closest);
  }

  /** Positions stay unchanged while commands accumulate, so simultaneous blasts add. Infantry mass = 1. */
  private explode(e: Explosion) {
    if (!validExplosion(e)) { this.rejectedExplosions++; return; }
    const minX = this.grid.column(e.x - e.radius), maxX = this.grid.column(e.x + e.radius);
    const minZ = this.grid.row(e.z - e.radius), maxZ = this.grid.row(e.z + e.radius);
    for (let row = minZ; row <= maxZ; row++) for (let col = minX; col <= maxX; col++) {
      for (let i = this.grid.heads[row * this.grid.columns + col]; i >= 0; i = this.grid.next[i]) this.blastBody(i, e);
    }
    // Corpses leave the combat grid immediately but retain their bounded physical lifetime.
    for (let i = 0; i < this.used; i++) if (this.hp[i] <= 0 && this.time - this.diedAt[i] < CONFIG.corpseLifetime) this.blastBody(i, e);
    this.explosions.emit(e, this.time); this.totalExplosions++;
  }

  private blastBody(i: number, e: Explosion) {
    this.explosionCandidates++;
    const dx = this.x[i] - e.x, dy = this.y[i] + CONFIG.soldier.height / 2 - e.y, dz = this.z[i] - e.z;
    const d = Math.hypot(dx, dy, dz);
    if (d > e.radius) return;
    if (this.hp[i] > 0) this.pendingDamage[i] += e.damage;
    const impulse = e.impulse * Math.max(0, 1 - d / e.radius);
    if (d > 1e-9) { this.velocityX[i] += dx / d * impulse; this.velocityY[i] += dy / d * impulse; this.velocityZ[i] += dz / d * impulse; }
    else this.velocityY[i] += impulse;
  }

  /** Swept upright capsules: their Minkowski sum is another vertical capsule. */
  private moveBody(i: number) {
    let remaining = CONFIG.step;
    const r = this.radius[i], height = CONFIG.soldier.height;
    for (let attempt = 0; attempt < CONFIG.physics.contactIterations && remaining > 1e-8; attempt++) {
      const vx = this.velocityX[i], vy = this.velocityY[i], vz = this.velocityZ[i], speed = Math.hypot(vx, vy, vz);
      if (speed < 1e-8) break;
      const dx = vx / speed, dy = vy / speed, dz = vz / speed, length = speed * remaining;
      const x = this.x[i], y = this.y[i], z = this.z[i];
      let distance = length, nx = 0, ny = 0, nz = 0;
      const support = this.ground.heightAt(x, z);
      if (dy < 0) { const t = Math.max(0, (support - y) / dy); if (t <= distance) { distance = t; ny = 1; } }
      const boundX = this.grid.halfWidth - r, boundZ = this.grid.halfDepth - r;
      if (Math.abs(dx) > 1e-12) { const t = Math.max(0, ((dx > 0 ? boundX : -boundX) - x) / dx); if (t <= distance) { distance = t; nx = dx > 0 ? -1 : 1; ny = nz = 0; } }
      if (Math.abs(dz) > 1e-12) { const t = Math.max(0, ((dz > 0 ? boundZ : -boundZ) - z) / dz); if (t <= distance) { distance = t; nz = dz > 0 ? -1 : 1; nx = ny = 0; } }
      if (this.hp[i] > 0) {
        const reach = r + this.tuning.radius + 0.002, ex = x + dx * distance, ez = z + dz * distance;
        const minX = this.grid.column(Math.min(x, ex) - reach), maxX = this.grid.column(Math.max(x, ex) + reach);
        const minZ = this.grid.row(Math.min(z, ez) - reach), maxZ = this.grid.row(Math.max(z, ez) + reach);
        for (let row = minZ; row <= maxZ; row++) for (let col = minX; col <= maxX; col++) {
          for (let j = this.grid.heads[row * this.grid.columns + col]; j >= 0; j = this.grid.next[j]) {
            if (j === i) continue;
            this.collisionChecks++;
            const axial = height - r - this.radius[j], radius = r + this.radius[j] + 0.001;
            const low = this.y[j] - axial, high = this.y[j] + axial;
            const ox = x - this.x[j], oy = y - Math.max(low, Math.min(high, y)), oz = z - this.z[j];
            // A touching body can move away or tangent; it must not glue to its neighbor.
            if (ox * ox + oy * oy + oz * oz <= (radius + 1e-6) ** 2 && ox * dx + oy * dy + oz * dz >= -1e-9) continue;
            const t = raySegmentCapsule(x, y, z, dx, dy, dz, this.x[j], low, high, this.z[j], radius);
            if (t > distance) continue;
            const tx = x + dx * t - this.x[j], ty = y + dy * t - Math.max(low, Math.min(high, y + dy * t)), tz = z + dz * t - this.z[j];
            const norm = Math.hypot(tx, ty, tz);
            if (norm < 1e-9) continue;
            distance = t; nx = tx / norm; ny = ty / norm; nz = tz / norm;
          }
        }
      }
      const travel = Math.max(0, distance - (nx || ny || nz ? 1e-6 : 0));
      this.x[i] += dx * travel; this.y[i] += dy * travel; this.z[i] += dz * travel;
      if (this.hp[i] > 0) { this.grid.insert(i, this.x[i], this.z[i]); this.targetGrid.insert(i, this.x[i], this.z[i]); }
      if (!(nx || ny || nz)) break;
      remaining *= Math.max(0, 1 - distance / length);
      const inward = vx * nx + vy * ny + vz * nz;
      if (inward >= 0) break;
      this.velocityX[i] -= inward * nx; this.velocityY[i] -= inward * ny; this.velocityZ[i] -= inward * nz;
      // Let a perfectly centered head landing slide off instead of balancing forever.
      if (ny > 0.5 && y > support + 0.01 && Math.hypot(this.velocityX[i], this.velocityZ[i]) < 0.01) this.velocityX[i] += this.detourSide[i] * 0.25;
    }
  }

  private integrateBodies() {
    this.activeBodies = this.airborne = 0;
    for (let n = 0; n < this.used; n++) {
      const i = (this.tick + (this.tick % 2 ? n : this.used - 1 - n)) % this.used;
      if (this.hp[i] <= 0 && this.time - this.diedAt[i] >= CONFIG.corpseLifetime) continue;
      const ground = this.ground.heightAt(this.x[i], this.z[i]);
      if (this.y[i] <= ground + 1e-5 && this.velocityY[i] <= 0) { this.y[i] = ground; this.velocityY[i] = 0; this.grounded[i] = 1; }
      else { this.grounded[i] = 0; this.velocityY[i] -= this.tuning.gravity * CONFIG.step; }
      if (this.velocityX[i] || this.velocityY[i] || this.velocityZ[i] || !this.grounded[i]) {
        this.activeBodies++; this.moveBody(i);
        const support = this.ground.heightAt(this.x[i], this.z[i]);
        if (this.y[i] <= support + 1e-5 && this.velocityY[i] <= 0) { this.y[i] = support; this.velocityY[i] = 0; this.grounded[i] = 1; }
        if (this.grounded[i]) {
          const speed = Math.hypot(this.velocityX[i], this.velocityZ[i]);
          const scale = speed > 0 ? Math.max(0, 1 - CONFIG.physics.friction * CONFIG.step / speed) : 0;
          this.velocityX[i] *= scale; this.velocityZ[i] *= scale;
        }
      }
      if (!this.grounded[i]) this.airborne++;
    }
  }

  step() {
    this.pendingDamage.fill(0, 0, this.used);
    this.explosionCandidates = this.collisionChecks = 0;
    this.time += CONFIG.step; this.tick++;
    this.centerX.fill(0); this.centerZ.fill(0);
    for (let i = 0; i < this.used; i++) {
      this.previousX[i] = this.x[i]; this.previousY[i] = this.y[i]; this.previousZ[i] = this.z[i]; this.moving[i] = 0;
      if (this.hp[i] > 0) { this.centerX[this.team[i]] += this.x[i]; this.centerZ[this.team[i]] += this.z[i]; }
    }
    this.applyCommands();
    this.integrateBodies();
    if (this.result !== 'running') return;
    this.detourCos[0] = Math.cos(this.tuning.shallowAngle); this.detourSin[0] = Math.sin(this.tuning.shallowAngle);
    this.detourCos[1] = Math.cos(this.tuning.wideAngle); this.detourSin[1] = Math.sin(this.tuning.wideAngle);
    this.detourCos[2] = Math.cos(Math.PI / 2); this.detourSin[2] = 1;
    for (let team = 0; team < 2; team++) if (this.alive[team]) { this.centerX[team] /= this.alive[team]; this.centerZ[team] /= this.alive[team]; }
    // Alternate direction and rotate priority to avoid a permanent first-mover advantage.
    for (let n = 0; n < this.used; n++) {
      const i = (this.tick + (this.tick % 2 ? n : this.used - 1 - n)) % this.used;
      if (this.hp[i] <= 0) continue;
      let target = this.byId.get(this.target[i]) ?? -1;
      const gun = this.weaponFor(this.weapon[i]);
      const distance = target >= 0 ? Math.hypot(this.x[target] - this.x[i], this.y[target] - this.y[i], this.z[target] - this.z[i]) : Infinity;
      const valid = target >= 0 && this.hp[target] > 0 && this.team[target] !== this.team[i];
      if (!valid || (distance > gun.range && this.time >= this.nextSearch[i])) {
        if (this.time >= this.nextSearch[i] || this.target[i] !== 0) {
          target = this.nearest(i, gun.range + this.tuning.searchPadding);
          this.target[i] = target >= 0 ? this.id[target] : 0;
          this.nextSearch[i] = this.time + this.tuning.searchInterval * (1 + (i % 5) * 0.05);
        } else target = -1;
      }
      const tx = target >= 0 ? this.x[target] : this.centerX[1 - this.team[i]];
      const tz = target >= 0 ? this.z[target] : this.centerZ[1 - this.team[i]];
      const dx = tx - this.x[i], dz = tz - this.z[i], d = Math.hypot(dx, dz);
      const vertical = target >= 0 ? this.y[target] - this.y[i] : 0;
      const targetDistance = Math.hypot(d, vertical);
      if (d > 0.001) this.facing[i] = Math.atan2(dx, dz);
      this.aimPitch[i] = -Math.atan2(vertical, d);
      if (!this.grounded[i]) continue;
      if (this.weaponsEnabled && target >= 0 && targetDistance <= gun.range - 0.12) continue;
      if (d < 0.001 || !this.alive[1 - this.team[i]]) continue;
      const horizontalRange = Math.sqrt(Math.max(0, gun.range * gun.range - vertical * vertical));
      const step = Math.min(this.tuning.speed * CONFIG.step, Math.max(0, this.weaponsEnabled && target >= 0 ? d - horizontalRange + 0.08 : d));
      if (step <= 0) continue;
      let vx = dx / d, vz = dz / d, separationX = 0, separationZ = 0;
      const reach = this.tuning.avoidanceDistance, minX = this.grid.column(this.x[i] - reach), maxX = this.grid.column(this.x[i] + reach);
      const minZ = this.grid.row(this.z[i] - reach), maxZ = this.grid.row(this.z[i] + reach);
      for (let row = minZ; row <= maxZ; row++) for (let column = minX; column <= maxX; column++) {
        for (let j = this.grid.heads[row * this.grid.columns + column]; j >= 0; j = this.grid.next[j]) {
          if (j === i) continue;
          if (Math.abs(this.y[i] - this.y[j]) >= CONFIG.soldier.height) continue;
          const ox = this.x[i] - this.x[j], oz = this.z[i] - this.z[j], ddSquared = ox * ox + oz * oz;
          if (ddSquared > 1e-12 && ddSquared < reach * reach) { const dd = Math.sqrt(ddSquared), force = (reach - dd) / reach * this.tuning.avoidanceStrength; separationX += ox / dd * force; separationZ += oz / dd * force; }
        }
      }
      vx += separationX; vz += separationZ;
      const magnitude = Math.hypot(vx, vz); vx /= magnitude || 1; vz /= magnitude || 1;
      const ox = this.x[i], oz = this.z[i];
      let moved = this.safeMove(i, ox + vx * step, oz + vz * step);
      if (!moved) {
        const side = this.detourSide[i];
        // Bounded alternatives let columns spill sideways without contact penetration.
        for (let attempt = 0; attempt < 6 && !moved; attempt++) {
          const pair = attempt >> 1;
          const c = this.detourCos[pair], s = this.detourSin[pair] * (attempt % 2 ? -1 : 1) * side;
          moved = this.safeMove(i, ox + (vx * c - vz * s) * step, oz + (vx * s + vz * c) * step);
        }
      }
      if (moved) this.moving[i] = 1;
    }
    if (this.weaponsEnabled) for (let i = 0; i < this.used; i++) {
      if (this.hp[i] <= 0 || this.nextFire[i] > this.time) continue;
      const target = this.byId.get(this.target[i]);
      if (target !== undefined && this.hp[target] > 0 && this.team[target] !== this.team[i]
        && Math.hypot(this.x[target] - this.x[i], this.y[target] - this.y[i], this.z[target] - this.z[i]) <= this.weaponFor(this.weapon[i]).range) this.fire(i, target);
      else {
        // Preserve each rifle's firing phase while approaching. Otherwise every expired
        // cooldown fires together at first contact, despite a staggered deployment.
        const interval = this.weaponFor(this.weapon[i]).interval;
        this.nextFire[i] += (Math.floor((this.time - this.nextFire[i]) / interval) + 1) * interval;
      }
    }
    for (let i = 0; i < this.used; i++) if (this.pendingDamage[i] > 0) this.damage(this.id[i], this.pendingDamage[i]);
    if (!this.alive[0] || !this.alive[1]) { this.result = !this.alive[0] && !this.alive[1] ? 'draw' : this.alive[0] ? 'plutonians' : 'sectoids'; this.endedAt = this.time; }
  }

  private applyCommands() {
    for (const command of this.commands) {
      if (command.type === 'spawn') { if (this.spawn(command.team, command.x, command.z, command.weapon) === null) this.rejectedSpawns++; }
      else if (command.type === 'explode') { if (this.result === 'running') this.explode(command); }
      else if (WEAPONS[command.weapon]) for (const id of command.ids) {
        const i = this.byId.get(id);
        if (i !== undefined && this.hp[i] > 0) this.weapon[i] = command.weapon;
      }
    }
    this.commands.length = 0;
  }
}
