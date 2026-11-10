import { CONFIG, WEAPONS } from './config.ts';
import { DEFAULT_TUNING, TUNING, deploymentError, type TuningValues } from './tuning.ts';

export type Team = 0 | 1;
export type Outcome = 'running' | 'plutonians' | 'sectoids' | 'draw';
export type Command =
  | { type: 'spawn'; team: Team; x: number; z: number; weapon?: number }
  | { type: 'equip'; ids: readonly number[]; weapon: number };

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
  readonly cellSize = CONFIG.field.cellSize;
  readonly next: Int32Array;
  readonly previous: Int32Array;
  readonly cell: Int32Array;
  constructor(capacity: number, halfWidth: number = CONFIG.field.halfWidth, halfDepth: number = CONFIG.field.halfDepth) {
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
  readonly team = new Uint8Array(this.capacity);
  readonly at = new Float64Array(this.capacity).fill(-Infinity);
  cursor = 0;
  emit(x: number, z: number, endX: number, endZ: number, team: Team, at: number) {
    const i = this.cursor++ % this.capacity;
    this.x[i] = x; this.z[i] = z; this.endX[i] = endX; this.endZ[i] = endZ; this.team[i] = team; this.at[i] = at;
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
  readonly shots = new ShotEvents();
  readonly events = new CombatEvents();
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
    this.hp[slot] = this.tuning.health; this.radius[slot] = r;
    this.detourSide[slot] = this.steeringRng() < 0.5 ? -1 : 1;
    this.team[slot] = team; this.weapon[slot] = weapon; this.target[slot] = 0; this.moving[slot] = 0;
    this.facing[slot] = team === 0 ? Math.PI : 0;
    this.lastHit[slot] = this.lastFire[slot] = this.diedAt[slot] = -Infinity;
    this.nextFire[slot] = this.time + this.rng() * this.weaponFor(weapon).interval;
    this.nextSearch[slot] = this.time + this.rng() * this.tuning.initialSearchDelay;
    this.grid.insert(slot, x, z); this.alive[team]++;
    this.result = 'running';
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
        const dx = x - this.x[j], dz = z - this.z[j], minimum = radius + this.radius[j] + 0.001;
        if (dx * dx + dz * dz < minimum * minimum - 1e-10) return false;
      }
    }
    return true;
  }

  private safeMove(i: number, x: number, z: number): boolean {
    const r = this.radius[i];
    if (Math.abs(x) > this.grid.halfWidth - r || Math.abs(z) > this.grid.halfDepth - r) return false;
    const ox = this.x[i], oz = this.z[i], dx = x - ox, dz = z - oz, length = Math.hypot(dx, dz);
    if (length < 1e-9) return false;
    const minX = this.grid.column(Math.min(ox, x) - r * 2 - 0.01), maxX = this.grid.column(Math.max(ox, x) + r * 2 + 0.01);
    const minZ = this.grid.row(Math.min(oz, z) - r * 2 - 0.01), maxZ = this.grid.row(Math.max(oz, z) + r * 2 + 0.01);
    for (let cz = minZ; cz <= maxZ; cz++) for (let cx = minX; cx <= maxX; cx++) {
      for (let j = this.grid.heads[cz * this.grid.columns + cx]; j >= 0; j = this.grid.next[j]) {
        if (j === i) continue;
        if (rayCircle(ox, oz, dx / length, dz / length, this.x[j], this.z[j], r + this.radius[j] + 0.001) < length + 1e-9) return false;
      }
    }
    this.x[i] = x; this.z[i] = z; this.grid.insert(i, x, z);
    return true;
  }

  private nearest(i: number, radius: number): number {
    this.nearestSlot = -1; this.nearestDistance = radius * radius;
    const x = this.x[i], z = this.z[i];
    const minX = this.grid.column(x - radius), maxX = this.grid.column(x + radius);
    const minZ = this.grid.row(z - radius), maxZ = this.grid.row(z + radius);
    for (let cz = minZ; cz <= maxZ; cz++) for (let cx = minX; cx <= maxX; cx++) {
      for (let j = this.grid.heads[cz * this.grid.columns + cx]; j >= 0; j = this.grid.next[j]) {
        if (this.team[j] === this.team[i]) continue;
        const dx = this.x[j] - x, dz = this.z[j] - z, d = dx * dx + dz * dz;
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
      this.grid.remove(i); this.alive[this.team[i]]--; this.totalDeaths++;
    }
  }

  private fire(i: number, target: number) {
    const gun = this.weaponFor(this.weapon[i]), x = this.x[i], z = this.z[i];
    const distance = Math.hypot(this.x[target] - x, this.z[target] - z);
    if (distance > gun.range || distance < 1e-8) return;
    const dx = (this.x[target] - x) / distance, dz = (this.z[target] - z) / distance;
    let hit = -1, closest = gun.range;
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
            const d = rayCircle(x, z, dx, dz, this.x[j], this.z[j], this.radius[j]);
            if (d < closest) { closest = d; hit = j; }
          }
        }
      }
      if (tX < tZ) { t = tX; tX += deltaX; cx += sx; } else { t = tZ; tZ += deltaZ; cz += sz; }
    }
    if (hit >= 0) this.pendingDamage[hit] += gun.damage;
    this.lastFire[i] = this.time; this.nextFire[i] = this.time + gun.interval;
    this.facing[i] = Math.atan2(dx, dz); this.totalShots++;
    this.events.emit('shot', this.team[i] as Team, x, this.time);
    this.shots.emit(x + dx * 0.44, z + dz * 0.44, x + dx * closest, z + dz * closest, this.team[i] as Team, this.time);
  }

  step() {
    this.applyCommands();
    if (this.result !== 'running') return;
    this.time += CONFIG.step; this.tick++;
    this.centerX.fill(0); this.centerZ.fill(0);
    for (let i = 0; i < this.used; i++) {
      this.previousX[i] = this.x[i]; this.previousZ[i] = this.z[i]; this.moving[i] = 0;
      if (this.hp[i] > 0) { this.centerX[this.team[i]] += this.x[i]; this.centerZ[this.team[i]] += this.z[i]; }
    }
    for (let team = 0; team < 2; team++) if (this.alive[team]) { this.centerX[team] /= this.alive[team]; this.centerZ[team] /= this.alive[team]; }
    // Alternate direction and rotate priority to avoid a permanent first-mover advantage.
    for (let n = 0; n < this.used; n++) {
      const i = (this.tick + (this.tick % 2 ? n : this.used - 1 - n)) % this.used;
      if (this.hp[i] <= 0) continue;
      let target = this.byId.get(this.target[i]) ?? -1;
      const gun = this.weaponFor(this.weapon[i]);
      const distance = target >= 0 ? Math.hypot(this.x[target] - this.x[i], this.z[target] - this.z[i]) : Infinity;
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
      if (d > 0.001) this.facing[i] = Math.atan2(dx, dz);
      if (this.weaponsEnabled && target >= 0 && d <= gun.range - 0.12) continue;
      if (d < 0.001 || !this.alive[1 - this.team[i]]) continue;
      const step = Math.min(this.tuning.speed * CONFIG.step, Math.max(0, this.weaponsEnabled && target >= 0 ? d - gun.range + 0.08 : d));
      if (step <= 0) continue;
      let vx = dx / d, vz = dz / d, separationX = 0, separationZ = 0;
      const reach = this.tuning.avoidanceDistance, minX = this.grid.column(this.x[i] - reach), maxX = this.grid.column(this.x[i] + reach);
      const minZ = this.grid.row(this.z[i] - reach), maxZ = this.grid.row(this.z[i] + reach);
      for (let row = minZ; row <= maxZ; row++) for (let column = minX; column <= maxX; column++) {
        for (let j = this.grid.heads[row * this.grid.columns + column]; j >= 0; j = this.grid.next[j]) {
          if (j === i) continue;
          const ox = this.x[i] - this.x[j], oz = this.z[i] - this.z[j], dd = Math.hypot(ox, oz);
          if (dd > 1e-6 && dd < reach) { const force = (reach - dd) / reach * this.tuning.avoidanceStrength; separationX += ox / dd * force; separationZ += oz / dd * force; }
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
          const magnitude = attempt < 2 ? this.tuning.shallowAngle : attempt < 4 ? this.tuning.wideAngle : Math.PI / 2;
          const angle = magnitude * (attempt % 2 ? -1 : 1) * side;
          const c = Math.cos(angle), s = Math.sin(angle);
          moved = this.safeMove(i, ox + (vx * c - vz * s) * step, oz + (vx * s + vz * c) * step);
        }
      }
      if (moved) this.moving[i] = 1;
    }
    this.pendingDamage.fill(0, 0, this.used);
    if (this.weaponsEnabled) for (let i = 0; i < this.used; i++) {
      if (this.hp[i] <= 0 || this.nextFire[i] > this.time) continue;
      const target = this.byId.get(this.target[i]);
      if (target !== undefined && this.hp[target] > 0 && this.team[target] !== this.team[i]
        && Math.hypot(this.x[target] - this.x[i], this.z[target] - this.z[i]) <= this.weaponFor(this.weapon[i]).range) this.fire(i, target);
      else {
        // Preserve each rifle's firing phase while approaching. Otherwise every expired
        // cooldown fires together at first contact, despite a staggered deployment.
        const interval = this.weaponFor(this.weapon[i]).interval;
        this.nextFire[i] += (Math.floor((this.time - this.nextFire[i]) / interval) + 1) * interval;
      }
    }
    for (let i = 0; i < this.used; i++) if (this.pendingDamage[i] > 0) this.damage(this.id[i], this.pendingDamage[i]);
    if (!this.alive[0] || !this.alive[1]) this.result = !this.alive[0] && !this.alive[1] ? 'draw' : this.alive[0] ? 'plutonians' : 'sectoids';
  }

  private applyCommands() {
    for (const command of this.commands) {
      if (command.type === 'spawn') { if (this.spawn(command.team, command.x, command.z, command.weapon) === null) this.rejectedSpawns++; }
      else if (WEAPONS[command.weapon]) for (const id of command.ids) {
        const i = this.byId.get(id);
        if (i !== undefined && this.hp[i] > 0) this.weapon[i] = command.weapon;
      }
    }
    this.commands.length = 0;
  }
}
