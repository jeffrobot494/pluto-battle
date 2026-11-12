import { CONFIG, NO_WEAPON, WEAPON_ID, WEAPONS, type Weapon } from './config.ts';
import { DEFAULT_TUNING, TUNING, deploymentError, effectiveTurretRange, type TuningValues } from './tuning.ts';
import { ARMY_ITEMS, copyEquipment, defaultEquipment, recipientCount, validateEquipment, type EquipmentSettings } from './equipment.ts';
import { random } from './random.ts';
import { Terrain } from './terrain.ts';
import { Navigation } from './navigation.ts';
import { rayCapsule, raySegmentCapsule } from './collision.ts';
import { ExplosionEvents, validExplosion, type Explosion } from './explosions.ts';
import { Rockets, SmokeEvents } from './rockets.ts';
import { SpatialGrid } from './spatial-grid.ts';
import { VehicleFleet, type Wreck } from './vehicles.ts';
import { GUNNER, PASSENGER, VEHICLE_TYPES } from './vehicle-types.ts';
export { random } from './random.ts';
export { rayCapsule, rayCircle } from './collision.ts';
export { SpatialGrid } from './spatial-grid.ts';

/** Cached line-of-sight refresh on a held target. Only guides movement; every shot casts its own ray. */
const SIGHT_INTERVAL = 0.12;
const ROCKET_BIT = 1 << WEAPON_ID.rocket;
/** Rocket aim points above the target's feet, lowest first: a low miss still lands at his feet. */
const ROCKET_AIM = [0.12, 0.4, 0.7];
/** Rockets that hit nothing detonate after this multiple of rocket range. */
const ROCKET_FUSE = 1.5;
const WRECKS_PER_TICK = 8;

export type Team = 0 | 1;
export type Outcome = 'running' | 'plutonians' | 'sectoids' | 'draw';
export interface RetiredCorpse {
  readonly id: number;
  readonly at: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly velocityY: number;
  readonly yaw: number;
  readonly fallOffset: number;
  readonly roll: number;
  readonly aimPitch: number;
  readonly radius: number;
  readonly team: Team;
  readonly weapon: number;
}

export type Command =
  | { type: 'spawn'; team: Team; x: number; z: number; weapon?: number }
  | { type: 'equip'; ids: readonly number[]; weapon: number }
  /** Adds a weapon to each listed soldier's inventory; existing weapons are kept. */
  | { type: 'upgrade'; ids: readonly number[]; weapon: number }
  /** Adds a weapon to every living soldier of `team` within `radius` (ground distance) of x/z. */
  | { type: 'upgradeArea'; team: Team; x: number; z: number; radius: number; weapon: number }
  /** Team mask: bit 0 = Plutonians, bit 1 = Sectoids. Solo is used by the sparse benchmark. */
  | { type: 'deployTrucks'; teams: number; x: number; z: number; radius: number; solo?: boolean }
  | ({ type: 'explode' } & Explosion);

/** Bounded cosmetic event buffer: overwriting effects never changes combat. */
export class ShotEvents {
  readonly capacity = CONFIG.maxEffects;
  readonly x = new Float32Array(this.capacity);
  readonly z = new Float32Array(this.capacity);
  readonly y = new Float32Array(this.capacity);
  readonly endX = new Float32Array(this.capacity);
  readonly endZ = new Float32Array(this.capacity);
  readonly endY = new Float32Array(this.capacity);
  readonly team = new Uint8Array(this.capacity);
  readonly weapon = new Uint8Array(this.capacity);
  readonly at = new Float64Array(this.capacity).fill(-Infinity);
  cursor = 0;
  emit(x: number, z: number, endX: number, endZ: number, team: Team, at: number, y = 0.7, endY = y, weapon = 0) {
    const i = this.cursor++ % this.capacity;
    this.x[i] = x; this.z[i] = z; this.endX[i] = endX; this.endZ[i] = endZ; this.team[i] = team; this.at[i] = at;
    this.y[i] = y; this.endY[i] = endY; this.weapon[i] = weapon;
  }
}

/** Bounded combat notifications, independent of damage and visual effect pools. */
export class CombatEvents {
  readonly capacity = 256;
  readonly kind: ('shot' | 'hit' | 'death')[] = new Array(this.capacity).fill('shot');
  readonly team = new Uint8Array(this.capacity);
  readonly weapon = new Uint8Array(this.capacity);
  readonly x = new Float32Array(this.capacity);
  readonly at = new Float64Array(this.capacity);
  cursor = 0;
  emit(kind: 'shot' | 'hit' | 'death', team: Team, x: number, at: number, weapon = 0) {
    const i = this.cursor++ % this.capacity;
    this.kind[i] = kind; this.team[i] = team; this.x[i] = x; this.at[i] = at;
    this.weapon[i] = weapon;
  }
}

export class BattleSimulation {
  readonly capacity: number;
  readonly x: Float64Array;
  readonly z: Float64Array;
  readonly y: Float64Array;
  readonly previousY: Float64Array;
  readonly aimPitch: Float32Array;
  readonly visible: Uint8Array;
  readonly terrain: Terrain;
  readonly navigation: Navigation | null;
  private readonly goals: Int32Array[];
  private readonly goalCounts = new Uint16Array(2);
  /** Cells of each team's soldiers that barely moved since the last field rebuild: the piles the field should route around. */
  private readonly congested: Int32Array[];
  private readonly congestedCounts = new Uint16Array(2);
  /** Position at the last field rebuild, for the stationary test above. */
  private readonly rebuildX: Float64Array;
  private readonly rebuildZ: Float64Array;
  private readonly lastProgress: Float64Array;
  private readonly beamStamp: Uint32Array;
  private beamQuery = 0;
  private readonly avoidanceX: Float64Array;
  private readonly avoidanceZ: Float64Array;
  private readonly nextRetarget: Float64Array;
  /** Next cached line-of-sight refresh on the current target; independent of the (slower) search cadence. */
  private readonly nextSight: Float64Array;
  /** Until this time a soldier whose target just died holds position before picking another. */
  private readonly reactUntil: Float64Array;
  /** Until this time a soldier whose every move attempt failed waits instead of retrying. */
  private readonly moveRetryAt: Float64Array;
  private readonly detourCos = new Float64Array(6);
  private readonly detourSin = new Float64Array(6);
  // Flanking: progress anchors detect soldiers pinned behind their own line;
  // a committed waypoint beyond the line edge carries them around it.
  private readonly anchorX: Float32Array;
  private readonly anchorZ: Float32Array;
  private readonly anchorTime: Float64Array;
  private readonly flankX: Float32Array;
  private readonly flankZ: Float32Array;
  private readonly flankUntil: Float64Array;
  private readonly flankTries: Uint8Array;
  /** 0 = normal pursuit, 1 = flanking around the line edge, 2 = backing off to find space, 3 = sidestepping a friendly in the line of fire. */
  readonly flankState: Uint8Array;
  /** Until this time a soldier whose shot was blocked by an ally does not count as engaged. */
  readonly blockedUntil: Float64Array;
  private readonly engaged: Uint8Array;
  // Per-team line frame: forward axis toward the enemy, lateral extent and depth of the line.
  private readonly lineForwardX = new Float64Array(2);
  private readonly lineForwardZ = new Float64Array(2);
  private readonly lineMin = new Float64Array(2);
  private readonly lineMax = new Float64Array(2);
  private readonly lineDepth = new Float64Array(2);
  private flankBudget = 0;
  private flankDirX = 0;
  private flankDirZ = 0;
  private flankDistance = 0;
  totalFlanks = 0;
  readonly velocityX: Float64Array;
  readonly velocityY: Float64Array;
  readonly velocityZ: Float64Array;
  readonly grounded: Uint8Array;
  readonly previousX: Float64Array;
  readonly previousZ: Float64Array;
  readonly hp: Float32Array;
  readonly radius: Float32Array;
  readonly team: Uint8Array;
  readonly weapon: Uint8Array;
  readonly inventory: Uint32Array;
  /** Incremented whenever a soldier receives an upgrade; renderers watch it for feedback. */
  readonly upgrades: Uint16Array;
  /** Most recent weapon given to each soldier by an upgrade. */
  readonly upgradeWeapon: Uint8Array;
  readonly equipment: EquipmentSettings;
  readonly id: Uint32Array;
  readonly target: Uint32Array;
  readonly facing: Float32Array;
  readonly lastHit: Float64Array;
  readonly lastFire: Float64Array;
  readonly diedAt: Float64Array;
  readonly deathFallOffset: Float32Array;
  readonly deathRoll: Float32Array;
  readonly pendingCorpse: Uint8Array;
  /** Ring of final physics poses. The renderer can consume several retirements between frames. */
  readonly retiredCorpses: RetiredCorpse[] = [];
  retiredCorpseCount = 0;
  readonly nextFire: Float64Array;
  readonly nextSearch: Float64Array;
  readonly moving: Uint8Array;
  readonly pendingDamage: Float32Array;
  readonly detourSide: Int8Array;
  readonly tuning: TuningValues;
  readonly rifle: { name: string; range: number; damage: number; interval: number };
  /** Live rocket launcher stats (range from tuning). Its damage is the blast damage, shown for reference. */
  readonly rocket: Weapon;
  readonly rockets = new Rockets();
  readonly smoke = new SmokeEvents();
  totalRockets = 0;
  droppedRockets = 0;
  readonly byId = new Map<number, number>();
  readonly commands: Command[] = [];
  readonly grid: SpatialGrid;
  readonly vehicles: VehicleFleet;
  readonly shots = new ShotEvents();
  readonly events = new CombatEvents();
  readonly explosions = new ExplosionEvents();
  readonly alive = new Uint16Array(2);
  readonly rng: () => number;
  private readonly steeringRng: () => number;
  /** Jitter for decision timing (search cadence, reactions, retries); separate so it never shifts other streams. */
  private readonly aiRng: () => number;
  private readonly corpseRng: () => number;
  private retainedDeathInGroup = 0;
  readonly centerX = new Float64Array(2);
  readonly centerZ = new Float64Array(2);
  time = 0;
  tick = 0;
  used = 0;
  nextId = 1;
  totalShots = 0;
  totalUpgrades = 0;
  totalDeaths = 0;
  result: Outcome = 'running';
  weaponsEnabled = true;
  /** Allies stop shots; a blocked shooter holds fire and sidesteps for a clear lane. */
  friendlyBlocking = true;
  totalBlockedShots = 0;
  totalSidesteps = 0;
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
  private nearestVisible = false;
  private readonly candidates = new Int32Array(4);
  private readonly candidateDistances = new Float64Array(4);

  constructor(perTeam = CONFIG.defaultPerTeam as number, seed = CONFIG.seed as number, capacity = CONFIG.capacity as number, tuning?: TuningValues, terrain?: Terrain, navigation?: Navigation, equipment: EquipmentSettings = defaultEquipment()) {
    if (!validateEquipment(equipment)) throw new Error('Equipment percentages must be whole numbers from 0 to 100 for both armies.');
    this.equipment = copyEquipment(equipment);
    this.tuning = { ...DEFAULT_TUNING, ...tuning, count: perTeam, seed, columns: tuning?.columns ?? Math.max(1, Math.ceil(Math.sqrt(perTeam))) };
    const error = perTeam === 0 ? null : deploymentError(this.tuning);
    if (error) throw new Error(error);
    this.rifle = { ...WEAPONS[0], range: this.tuning.range, damage: this.tuning.damage, interval: this.tuning.fireInterval };
    this.rocket = { ...WEAPONS[WEAPON_ID.rocket], range: this.tuning.rocketRange, damage: this.tuning.rocketDamage };
    this.capacity = capacity;
    this.terrain = terrain ?? Terrain.flat(this.tuning.halfWidth, this.tuning.halfDepth);
    this.navigation = terrain ? navigation ?? new Navigation(terrain, this.tuning.radius) : null;
    this.y = new Float64Array(capacity); this.previousY = new Float64Array(capacity); this.aimPitch = new Float32Array(capacity); this.visible = new Uint8Array(capacity);
    this.goals = [new Int32Array(capacity), new Int32Array(capacity)];
    this.congested = [new Int32Array(capacity), new Int32Array(capacity)];
    this.rebuildX = new Float64Array(capacity).fill(Infinity); this.rebuildZ = new Float64Array(capacity).fill(Infinity); this.lastProgress = new Float64Array(capacity);
    this.beamStamp = new Uint32Array(capacity);
    this.avoidanceX = new Float64Array(capacity); this.avoidanceZ = new Float64Array(capacity); this.nextRetarget = new Float64Array(capacity);
    this.nextSight = new Float64Array(capacity); this.reactUntil = new Float64Array(capacity); this.moveRetryAt = new Float64Array(capacity);
    this.updateDetourAngles();
    this.x = new Float64Array(capacity); this.z = new Float64Array(capacity);
    this.velocityX = new Float64Array(capacity); this.velocityY = new Float64Array(capacity); this.velocityZ = new Float64Array(capacity);
    this.grounded = new Uint8Array(capacity);
    this.previousX = new Float64Array(capacity); this.previousZ = new Float64Array(capacity);
    this.hp = new Float32Array(capacity); this.radius = new Float32Array(capacity);
    this.team = new Uint8Array(capacity); this.weapon = new Uint8Array(capacity);
    this.inventory = new Uint32Array(capacity);
    this.upgrades = new Uint16Array(capacity); this.upgradeWeapon = new Uint8Array(capacity).fill(NO_WEAPON);
    this.id = new Uint32Array(capacity); this.target = new Uint32Array(capacity);
    this.facing = new Float32Array(capacity); this.lastHit = new Float64Array(capacity).fill(-Infinity);
    this.lastFire = new Float64Array(capacity).fill(-Infinity); this.diedAt = new Float64Array(capacity).fill(-Infinity);
    this.deathFallOffset = new Float32Array(capacity); this.deathRoll = new Float32Array(capacity);
    this.pendingCorpse = new Uint8Array(capacity);
    this.nextFire = new Float64Array(capacity); this.nextSearch = new Float64Array(capacity);
    this.moving = new Uint8Array(capacity); this.pendingDamage = new Float32Array(capacity);
    this.detourSide = new Int8Array(capacity);
    this.anchorX = new Float32Array(capacity); this.anchorZ = new Float32Array(capacity); this.anchorTime = new Float64Array(capacity);
    this.flankX = new Float32Array(capacity); this.flankZ = new Float32Array(capacity); this.flankUntil = new Float64Array(capacity);
    this.flankTries = new Uint8Array(capacity); this.flankState = new Uint8Array(capacity); this.engaged = new Uint8Array(capacity);
    this.blockedUntil = new Float64Array(capacity);
    this.grid = new SpatialGrid(capacity, this.tuning.halfWidth, this.tuning.halfDepth, this.team); this.rng = random(seed);
    this.vehicles = new VehicleFleet(this);
    // A separate stream preserves deployment/fire randomness. Handedness has no
    // relationship to unit IDs, team, column parity, or storage order.
    this.steeringRng = random(seed ^ 0x51ed270b);
    this.aiRng = random(seed ^ 0x2c1b3c6d);
    this.corpseRng = random(seed ^ 0x5e2d58d1);
    if (!Number.isInteger(perTeam) || perTeam < 0 || perTeam * 2 > capacity || perTeam > 500) throw new Error('Supported deployment: 0–500 per team within capacity.');
    const columns = Math.max(1, Math.min(perTeam, this.tuning.columns));
    for (let team = 0; team < 2; team++) for (let n = 0; n < perTeam; n++) {
      const column = n % columns, row = Math.floor(n / columns), sign = team === 0 ? 1 : -1;
      // 500-unit stress deployments still fit inside the field.
      const x = (column - (columns - 1) / 2) * this.tuning.columnSpacing + (this.rng() * 2 - 1) * this.tuning.jitterX;
      const z = sign * (this.tuning.frontline + row * this.tuning.rowSpacing + this.rng() * this.tuning.jitterZ);
      if (this.spawn(team as Team, x, z) === null) throw new Error('Invalid deployment.');
    }
    this.assignEquipment(perTeam, seed);
  }

  weaponFor(index: number): Weapon { return index === 0 ? this.rifle : index === WEAPON_ID.rocket ? this.rocket : WEAPONS[index]; }
  private updateDetourAngles() {
    for (let i = 0; i < 6; i++) { const angle = (i < 2 ? this.tuning.shallowAngle : i < 4 ? this.tuning.wideAngle : Math.PI / 2) * (i % 2 ? -1 : 1); this.detourCos[i] = Math.cos(angle); this.detourSin[i] = Math.sin(angle); }
  }
  get blockedUnits() {
    let count = 0;
    for (let i = 0; i < this.used; i++) if (this.hp[i] > 0 && this.vehicles.onFoot(i) && (!this.weaponsEnabled || !this.visible[i]) && this.time - this.lastProgress[i] > 2) count++;
    return count;
  }

  private assignEquipment(perTeam: number, seed: number) {
    this.inventory.fill(0, 0, this.used);
    for (const team of [0, 1] as const) for (const item of ARMY_ITEMS) {
      // Independent streams avoid changing formation, fire phases, or another item's recipients.
      const rng = random(seed ^ Math.imul(team + 1, 0x9e3779b9) ^ Math.imul(item.weapon + 1, 0x85ebca6b));
      const slots = Array.from({ length: perTeam }, (_, n) => team * perTeam + n);
      const count = recipientCount(perTeam, this.equipment[team][item.id]);
      for (let n = 0; n < count; n++) {
        const picked = n + Math.floor(rng() * (perTeam - n));
        [slots[n], slots[picked]] = [slots[picked], slots[n]];
        this.inventory[slots[n]] |= 1 << item.weapon;
      }
    }
    for (let i = 0; i < this.used; i++) {
      const weapon = this.selectWeapon(i, Infinity);
      // Reuse the original staggered phase, scaled to the initial weapon's interval.
      if (weapon !== NO_WEAPON) this.nextFire[i] *= this.weaponFor(weapon).interval / this.rifle.interval;
      this.weapon[i] = weapon;
    }
  }

  longestRange(i: number) {
    let range = 0;
    for (let w = 0; w < WEAPONS.length; w++) if (this.inventory[i] & (1 << w)) range = Math.max(range, this.weaponFor(w).range);
    return range;
  }

  /** Range of the highest-DPS weapon carried (ties favor reach). Soldiers advance until this weapon can fire. */
  preferredRange(i: number) {
    // A carried rocket is fired at the first chance, so close to rocket range first.
    if (this.inventory[i] & ROCKET_BIT) return this.rocket.range;
    let range = 0, score = -Infinity;
    for (let w = 0; w < WEAPONS.length; w++) if (this.inventory[i] & (1 << w)) {
      const gun = this.weaponFor(w), dps = gun.damage / gun.interval;
      if (dps > score || (dps === score && gun.range > range)) { score = dps; range = gun.range; }
    }
    return range;
  }

  /** A rocket within reach comes first; then best DPS within reach; otherwise carry the longest-range weapon while approaching. */
  selectWeapon(i: number, distance: number) {
    if ((this.inventory[i] & ROCKET_BIT) && distance <= this.rocket.range) return WEAPON_ID.rocket;
    let best = NO_WEAPON, longest = NO_WEAPON, score = -Infinity, range = -Infinity;
    for (let w = 0; w < WEAPONS.length; w++) if (this.inventory[i] & (1 << w)) {
      const gun = this.weaponFor(w), dps = gun.damage / gun.interval;
      if (gun.range > range) { range = gun.range; longest = w; }
      if (w !== WEAPON_ID.rocket && distance <= gun.range && dps > score) { score = dps; best = w; }
    }
    return best === NO_WEAPON ? longest : best;
  }

  applyLiveTuning(values: TuningValues) {
    const oldHealth = this.tuning.health, oldInterval = this.rifle.interval, oldHull = this.tuning.truckHealth;
    const rangesLocked = (this.vehicles.count > 0 || this.vehicles.pendingCrews > 0) && effectiveTurretRange(values) === null;
    for (const def of TUNING) if (!def.restart && !(rangesLocked && (def.key === 'range' || def.key === 'rocketRange' || def.key === 'turretRangePosition'))) {
      this.tuning[def.key] = values[def.key];
    }
    this.updateDetourAngles();
    this.rifle.range = this.tuning.range; this.rifle.damage = this.tuning.damage; this.rifle.interval = this.tuning.fireInterval;
    this.rocket.range = this.tuning.rocketRange; this.rocket.damage = this.tuning.rocketDamage;
    this.vehicles.rescaleHealth(oldHull);
    for (let i = 0; i < this.used; i++) if (this.hp[i] > 0) {
      if (oldHealth !== this.tuning.health) this.hp[i] = Math.min(this.tuning.health, this.hp[i] * this.tuning.health / oldHealth);
      if (this.weapon[i] === 0 && oldInterval !== this.rifle.interval) this.nextFire[i] = this.time + Math.max(0, this.nextFire[i] - this.time) * this.rifle.interval / oldInterval;
    }
  }

  queue(command: Command) {
    if (this.commands.length >= 4096) throw new Error('Battle command queue is full.');
    // Own the ID list: callers cannot change a queued command after submission.
    this.commands.push(command.type === 'equip' || command.type === 'upgrade' ? { ...command, ids: Array.from(command.ids) } : { ...command });
  }
  /** Applies noncombat commands between steps so upgrades and the first truck batch can show while paused. */
  flushCommands() {
    const paints = this.vehicles.metrics.paints;
    this.applyCommands(false);
    if (this.vehicles.metrics.paints !== paints) this.vehicles.place(true);
  }

  /** Living soldiers of `team` inside the zone who do not yet carry `weapon`. */
  upgradeCandidates(team: Team, x: number, z: number, radius: number, weapon: number) {
    let count = 0;
    if (!WEAPONS[weapon]) return 0;
    for (let i = 0; i < this.used; i++) if (this.inArea(i, team, x, z, radius) && !(this.inventory[i] & (1 << weapon))) count++;
    return count;
  }
  private inArea(i: number, team: Team, x: number, z: number, radius: number) {
    return this.hp[i] > 0 && this.team[i] === team && (this.x[i] - x) ** 2 + (this.z[i] - z) ** 2 <= radius * radius;
  }
  private upgradeSlot(i: number, weapon: number) {
    if (this.hp[i] <= 0) return;
    if (this.inventory[i] & (1 << weapon)) return;
    this.inventory[i] |= 1 << weapon;
    this.upgradeWeapon[i] = weapon; this.upgrades[i] = (this.upgrades[i] + 1) & 0xffff;
    this.totalUpgrades++;
    // Re-evaluate targets on the next tick so the new gun's reach is used immediately.
    this.nextSearch[i] = Math.min(this.nextSearch[i], this.time);
  }

  spawn(team: Team, x: number, z: number, weapon = 0): number | null {
    if ((team !== 0 && team !== 1) || !Number.isFinite(x) || !Number.isFinite(z) || !WEAPONS[weapon]) return null;
    const r = this.tuning.radius;
    if (Math.abs(x) > this.grid.halfWidth - r || Math.abs(z) > this.grid.halfDepth - r || !this.clearPosition(-1, x, z, r)) return null;
    let slot = -1;
    for (let i = 0; i < this.used; i++) if (this.hp[i] <= 0 && !this.vehicles.awaitingEjection[i] && this.time - this.diedAt[i] > CONFIG.corpseLifetime) { slot = i; break; }
    if (slot < 0) { if (this.used >= this.capacity) return null; slot = this.used++; }
    else this.archiveCorpse(slot);
    if (this.id[slot]) this.byId.delete(this.id[slot]);
    const id = this.nextId++;
    this.id[slot] = id; this.byId.set(id, slot);
    this.x[slot] = this.previousX[slot] = x; this.z[slot] = this.previousZ[slot] = z;
    this.y[slot] = this.previousY[slot] = this.terrain.heightAt(x, z); this.visible[slot] = 0; this.aimPitch[slot] = 0; this.lastProgress[slot] = this.time;
    this.avoidanceX[slot] = this.avoidanceZ[slot] = this.nextRetarget[slot] = 0;
    this.nextSight[slot] = this.reactUntil[slot] = this.moveRetryAt[slot] = 0;
    this.anchorX[slot] = x; this.anchorZ[slot] = z; this.anchorTime[slot] = this.time;
    this.flankState[slot] = this.flankTries[slot] = this.engaged[slot] = 0; this.flankUntil[slot] = this.blockedUntil[slot] = 0;
    this.velocityX[slot] = this.velocityY[slot] = this.velocityZ[slot] = 0; this.grounded[slot] = 1;
    this.hp[slot] = this.tuning.health; this.radius[slot] = r;
    this.detourSide[slot] = this.steeringRng() < 0.5 ? -1 : 1;
    this.team[slot] = team; this.weapon[slot] = weapon; this.inventory[slot] = 1 << weapon; this.target[slot] = 0; this.moving[slot] = 0;
    this.rebuildX[slot] = this.rebuildZ[slot] = Infinity;
    this.upgrades[slot] = 0; this.upgradeWeapon[slot] = NO_WEAPON;
    this.facing[slot] = team === 0 ? Math.PI : 0;
    this.lastHit[slot] = this.lastFire[slot] = this.diedAt[slot] = -Infinity;
    this.pendingCorpse[slot] = 0;
    this.nextFire[slot] = this.time + this.rng() * this.weaponFor(weapon).interval;
    this.nextSearch[slot] = this.time + this.rng() * this.tuning.initialSearchDelay;
    this.grid.insert(slot, x, z); this.alive[team]++;
    this.result = 'running';
    this.endedAt = Infinity;
    return id;
  }

  clearPosition(ignore: number, x: number, z: number, radius: number): boolean {
    if (this.navigation && !this.terrain.canStand(x, z, radius)) return false;
    const base = ignore >= 0 ? this.y[ignore] : this.terrain.heightAt(x, z);
    if (this.vehicles.count && this.vehicles.ground.blocksFoot(x, base, z, radius)) return false;
    const reach = radius + this.tuning.radius + 0.002;
    const minX = this.grid.column(x - reach), maxX = this.grid.column(x + reach);
    const minZ = this.grid.row(z - reach), maxZ = this.grid.row(z + reach);
    for (let cz = minZ; cz <= maxZ; cz++) for (let cx = minX; cx <= maxX; cx++) {
      for (let j = this.grid.heads[cz * this.grid.columns + cx]; j >= 0; j = this.grid.next[j]) {
        if (j === ignore || !this.vehicles.onFoot(j)) continue;
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
    const ox = this.x[i], oz = this.z[i], dx = x - ox, dz = z - oz, length = Math.hypot(dx, dz);
    if (length < 1e-9) return false;
    const ux = dx / length, uz = dz / length;
    if (this.vehicles.count && this.vehicles.ground.sweepFoot(ox, this.y[i], oz, ux, 0, uz, length, r) < length) return false;
    const midX = ox + dx * 0.5, midZ = oz + dz * 0.5, halfX = Math.abs(dx) * 0.5, halfZ = Math.abs(dz) * 0.5;
    const minX = this.grid.column(Math.min(ox, x) - r * 2 - 0.01), maxX = this.grid.column(Math.max(ox, x) + r * 2 + 0.01);
    const minZ = this.grid.row(Math.min(oz, z) - r * 2 - 0.01), maxZ = this.grid.row(Math.max(oz, z) + r * 2 + 0.01);
    for (let cz = minZ; cz <= maxZ; cz++) for (let cx = minX; cx <= maxX; cx++) {
      for (let j = this.grid.heads[cz * this.grid.columns + cx]; j >= 0; j = this.grid.next[j]) {
        if (j === i || !this.vehicles.onFoot(j)) continue;
        const minimum = r + this.radius[j] + 0.001;
        if (Math.abs(this.x[j] - midX) > minimum + halfX || Math.abs(this.z[j] - midZ) > minimum + halfZ) continue;
        if (!this.grounded[j]) {
          // Airborne bodies block only where their upright capsule overlaps the walker's.
          if (Math.abs(this.y[i] - this.y[j]) >= CONFIG.soldier.height + 0.002) continue;
          const axial = CONFIG.soldier.height - r - this.radius[j];
          if (raySegmentCapsule(ox, this.y[i], oz, ux, 0, uz, this.x[j], this.y[j] - axial, this.y[j] + axial, this.z[j], minimum) < length + 1e-9) return false;
          continue;
        }
        const jx = this.x[j] - ox, jz = this.z[j] - oz, along = Math.max(0, Math.min(length, jx * ux + jz * uz));
        const cx = jx - ux * along, cz = jz - uz * along;
        if (cx * cx + cz * cz < minimum * minimum - 1e-10) return false;
      }
    }
    if (this.navigation && !this.terrain.canTraverse(ox, oz, x, z, r)) return false;
    let groundY = this.terrain.heightAt(x, z);
    if (this.navigation) {
      const maximumTravel = this.tuning.speed * CONFIG.step;
      let shortened = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        const travel = Math.hypot(x - ox, z - oz, groundY - this.y[i]);
        if (travel <= maximumTravel + 1e-8) break;
        const ratio = maximumTravel / travel * 0.999999;
        x = ox + (x - ox) * ratio; z = oz + (z - oz) * ratio; groundY = this.terrain.heightAt(x, z);
        shortened = true;
      }
      if (Math.hypot(x - ox, z - oz, groundY - this.y[i]) > maximumTravel + 1e-7) return false;
      if (shortened && !this.terrain.canTraverse(ox, oz, x, z, r)) return false;
    }
    this.x[i] = x; this.z[i] = z; this.y[i] = groundY; this.grid.insert(i, x, z); this.lastProgress[i] = this.time;
    return true;
  }

  private nearest(i: number, radius: number, rangeOverride?: number, muzzleY = this.y[i] + 0.7): number {
    this.nearestSlot = -1; this.nearestDistance = radius * radius;
    this.nearestVisible = false; this.candidates.fill(-1); this.candidateDistances.fill(radius * radius);
    const grid = this.grid;
    const x = this.x[i], z = this.z[i];
    const minX = grid.column(x - radius), maxX = grid.column(x + radius);
    const minZ = grid.row(z - radius), maxZ = grid.row(z + radius);
    for (let cz = minZ; cz <= maxZ; cz++) for (let cx = minX; cx <= maxX; cx++) {
      if (!grid.teamCounts[1 - this.team[i]][cz * grid.columns + cx]) continue;
      for (let j = grid.heads[cz * grid.columns + cx]; j >= 0; j = grid.next[j]) {
        if (this.team[j] === this.team[i]) continue;
        const dx = this.x[j] - x, dz = this.z[j] - z, dy = this.y[j] - this.y[i], d = dx * dx + dz * dz + dy * dy;
        if (d < this.nearestDistance) { this.nearestDistance = d; this.nearestSlot = j; }
        if (this.navigation && d < this.candidateDistances[3]) {
          let at = 3;
          while (at > 0 && d < this.candidateDistances[at - 1]) { this.candidateDistances[at] = this.candidateDistances[at - 1]; this.candidates[at] = this.candidates[at - 1]; at--; }
          this.candidateDistances[at] = d; this.candidates[at] = j;
        }
      }
    }
    // Unarmed soldiers (empty inventory) have no gun range, so nothing counts as visible-in-range.
    const gunRange = rangeOverride ?? (this.weapon[i] === NO_WEAPON ? 0 : this.weaponFor(this.weapon[i]).range);
    if (this.navigation) for (let n = 0; n < 4; n++) {
      const j = this.candidates[n];
      if (j >= 0 && this.candidateDistances[n] <= gunRange ** 2
        && this.terrain.visible(x, muzzleY, z, this.x[j], this.y[j] + 0.7, this.z[j])) { this.nearestVisible = true; return j; }
    }
    return this.nearestSlot;
  }

  /** Shared damage path, independent of bounded cosmetic buffers. */
  damage(id: number, amount: number) {
    const i = this.byId.get(id);
    if (i === undefined || this.hp[i] <= 0 || !Number.isFinite(amount) || amount <= 0) return;
    this.applySoldierDamage(i, amount * this.armorFactor(i));
  }

  private armorFactor(i: number) { return this.vehicles.ride[i] >= 0 ? 1 - this.tuning.truckCrewArmor : 1; }
  queueDamage(i: number, amount: number) { this.pendingDamage[i] += amount * this.armorFactor(i); }

  private applySoldierDamage(i: number, amount: number) {
    this.hp[i] = Math.max(0, this.hp[i] - amount); this.lastHit[i] = this.time;
    this.events.emit(this.hp[i] === 0 ? 'death' : 'hit', this.team[i] as Team, this.x[i], this.time);
    if (this.hp[i] === 0) {
      this.vehicles.soldierDied(i);
      this.diedAt[i] = this.time; this.target[i] = 0; this.moving[i] = 0;
      // Pick one casualty from each group before it falls so the fade can start on time.
      const deathInGroup = this.totalDeaths % CONFIG.corpseRetentionGroup;
      if (deathInGroup === 0) this.retainedDeathInGroup = Math.floor(this.corpseRng() * CONFIG.corpseRetentionGroup);
      this.pendingCorpse[i] = Number(deathInGroup === this.retainedDeathInGroup);
      this.deathFallOffset[i] = (this.corpseRng() * 2 - 1) * Math.PI;
      this.deathRoll[i] = (this.corpseRng() * 2 - 1) * Math.PI;
      this.grid.remove(i); this.alive[this.team[i]]--; this.totalDeaths++;
    }
  }

  private fire(i: number, target: number) {
    if (this.weapon[i] === WEAPON_ID.rocket) return this.launch(i, target);
    const gun = this.weaponFor(this.weapon[i]), x = this.x[i], z = this.z[i], y = this.y[i] + 0.7;
    const distance = Math.hypot(this.x[target] - x, this.z[target] - z, this.y[target] - this.y[i]);
    if (distance > gun.range || distance < 1e-8) return false;
    const dx = (this.x[target] - x) / distance, dz = (this.z[target] - z) / distance, dy = (this.y[target] - this.y[i]) / distance;
    // A hit before terrain is valid even when the intended target is behind cover.
    const terrainHit = this.terrain.raycast(x, y, z, dx, dy, dz, distance);
    const closest = this.directLane(i, x, y, z, dx, dy, dz, terrainHit), hit = this.beamHit, hull = this.hullHit;
    if (hit < 0 && hull < 0 && terrainHit < distance - 1e-5) {
      this.visible[i] = 0;
      this.nextSearch[i] = Math.min(this.nextSearch[i], this.time);
      return false;
    }
    if (hit >= 0 && this.team[hit] === this.team[i]) { this.blockShot(i, hit, dx, dz); return false; }
    if (hull >= 0 && this.vehicles.team[hull] === this.team[i]) { this.totalBlockedShots++; return false; }
    this.blockedUntil[i] = 0;
    if (this.flankState[i] === 3) this.flankState[i] = 0;
    if (hit >= 0) this.queueDamage(hit, gun.damage);
    else if (hull >= 0) this.vehicles.pendingDamage[hull] += gun.damage;
    this.lastFire[i] = this.time; this.nextFire[i] = this.time + gun.interval;
    this.facing[i] = Math.atan2(dx, dz); this.totalShots++;
    this.aimPitch[i] = Math.atan2(dy, Math.hypot(dx, dz));
    this.events.emit('shot', this.team[i] as Team, x, this.time, this.weapon[i]);
    const muzzle = Math.min(0.44, closest);
    this.shots.emit(x + dx * muzzle, z + dz * muzzle, x + dx * closest, z + dz * closest, this.team[i] as Team, this.time, y + dy * muzzle, y + dy * closest, this.weapon[i]);
    return true;
  }

  private beamHit = -1;
  private hullHit = -1;
  private directLane(i: number, x: number, y: number, z: number, dx: number, dy: number, dz: number, distance: number) {
    const f = this.vehicles, v = f.ride[i];
    this.hullHit = -1;
    if (f.count) {
      distance = f.castHull(x, y, z, dx, dy, dz, distance, v >= 0 ? f.id[v] : 0, this.friendlyBlocking ? -1 : this.team[i]);
      this.hullHit = f.rayHit;
    }
    const closest = this.castBeam(i, x, y, z, dx, dy, dz, distance);
    if (this.beamHit >= 0) this.hullHit = -1;
    return closest;
  }

  /** Checks a planned firing position without changing cooldowns, aim, or damage. */
  turretLane(i: number, x: number, y: number, z: number, target: number, range: number) {
    const ax = this.x[target] - x, ay = this.y[target] + 0.7 - y, az = this.z[target] - z, d = Math.hypot(ax, ay, az);
    if (d < 1e-7 || d > range) return false;
    const dx = ax / d, dy = ay / d, dz = az / d;
    const terrain = this.terrain.raycast(x, y, z, dx, dy, dz, d);
    if (terrain < d - 1e-5) return false;
    this.directLane(i, x, y, z, dx, dy, dz, terrain);
    return this.beamHit >= 0 ? this.team[this.beamHit] !== this.team[i] : this.hullHit < 0 || this.vehicles.team[this.hullHit] !== this.team[i];
  }
  /** First soldier (enemy, or ally while friendly blocking is on) along a ray from shooter i: slot in beamHit, distance returned. */
  private castBeam(i: number, x: number, y: number, z: number, dx: number, dy: number, dz: number, distance: number) {
    let hit = -1, closest = distance;
    const blocking = this.friendlyBlocking, ride = this.vehicles.ride, own = ride[i];
    if (++this.beamQuery === 0xffffffff) { this.beamStamp.fill(0); this.beamQuery = 1; }
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
          const cellIndex = row * this.grid.columns + column;
          if (!this.grid.teamCounts[1 - this.team[i]][cellIndex] && !(blocking && this.grid.teamCounts[this.team[i]][cellIndex])) continue;
          for (let j = this.grid.heads[cellIndex]; j >= 0; j = this.grid.next[j]) {
            if (j === i || own >= 0 && ride[j] === own || (!blocking && this.team[j] === this.team[i])) continue;
            if (this.beamStamp[j] === this.beamQuery) continue;
            this.beamStamp[j] = this.beamQuery;
            const d = rayCapsule(x, y, z, dx, dy, dz, this.x[j], this.y[j], this.z[j], this.radius[j]);
            if (d < closest) { closest = d; hit = j; }
          }
        }
      }
      if (tX < tZ) { t = tX; tX += deltaX; cx += sx; } else { t = tZ; tZ += deltaZ; cz += sz; }
    }
    this.beamHit = hit;
    return closest;
  }

  /**
   * Launches the soldier's single rocket at the lowest point of the target he can see. The lane is checked for
   * allies exactly like a laser; allies (or the shooter) near the target are not considered. The launcher leaves his inventory.
   */
  private launch(i: number, target: number) {
    if (this.rockets.count >= this.rockets.capacity) { this.droppedRockets++; return false; }
    const x = this.x[i], z = this.z[i], y = this.y[i] + 0.7;
    let dx = 0, dy = 0, dz = 0, distance = 0;
    for (let n = 0; n < ROCKET_AIM.length && !distance; n++) {
      const ax = this.x[target] - x, ay = this.y[target] + ROCKET_AIM[n] - y, az = this.z[target] - z, d = Math.hypot(ax, ay, az);
      if (d < 1e-6) continue;
      if (this.terrain.raycast(x, y, z, ax / d, ay / d, az / d, d) >= d - 1e-5) { dx = ax / d; dy = ay / d; dz = az / d; distance = d; }
    }
    if (!distance) { this.visible[i] = 0; this.nextSearch[i] = Math.min(this.nextSearch[i], this.time); return false; }
    this.directLane(i, x, y, z, dx, dy, dz, distance);
    if (this.beamHit >= 0 && this.team[this.beamHit] === this.team[i]) { this.blockShot(i, this.beamHit, dx, dz); return false; }
    if (this.hullHit >= 0 && this.vehicles.team[this.hullHit] === this.team[i]) { this.totalBlockedShots++; return false; }
    this.blockedUntil[i] = 0;
    if (this.flankState[i] === 3) this.flankState[i] = 0;
    const muzzle = 0.44, mx = x + dx * muzzle, my = y + dy * muzzle, mz = z + dz * muzzle;
    // Terrain is static: one raycast now gives the impact distance, so flight only tests soldiers.
    const fuse = this.rocket.range * ROCKET_FUSE + 2;
    let limit = this.terrain.raycast(mx, my, mz, dx, dy, dz, fuse), detonate = true;
    const hw = this.grid.halfWidth, hd = this.grid.halfDepth;
    const exitX = Math.abs(dx) > 1e-9 ? ((dx > 0 ? hw : -hw) - mx) / dx : Infinity;
    const exitZ = Math.abs(dz) > 1e-9 ? ((dz > 0 ? hd : -hd) - mz) / dz : Infinity;
    if (Math.min(exitX, exitZ) < limit) { limit = Math.max(0, Math.min(exitX, exitZ)); detonate = false; }
    const v = this.vehicles.ride[i];
    this.rockets.add(mx, my, mz, dx, dy, dz, limit, detonate, this.id[i], this.team[i], v >= 0 ? this.vehicles.id[v] : 0);
    this.inventory[i] &= ~ROCKET_BIT; this.totalRockets++;
    this.lastFire[i] = this.time; this.nextFire[i] = this.time + this.rocket.interval;
    this.facing[i] = Math.atan2(dx, dz); this.totalShots++;
    this.aimPitch[i] = Math.atan2(dy, Math.hypot(dx, dz));
    this.events.emit('shot', this.team[i] as Team, x, this.time, WEAPON_ID.rocket);
    this.weapon[i] = this.selectWeapon(i, Math.hypot(this.x[target] - this.x[i], this.z[target] - this.z[i], this.y[target] - this.y[i]));
    return true;
  }

  /** Moves every rocket one tick. Hulls and soldiers stop it; terrain, fuse and field edge were resolved at launch. */
  private advanceRockets() {
    const r = this.rockets, stride = this.tuning.rocketSpeed * CONFIG.step, grid = this.grid, reach = this.tuning.radius + 0.01;
    for (let n = 0; n < r.count;) {
      const x = r.x[n], y = r.y[n], z = r.z[n], dx = r.dx[n], dy = r.dy[n], dz = r.dz[n];
      r.previousX[n] = x; r.previousY[n] = y; r.previousZ[n] = z;
      let travel = Math.max(0, Math.min(stride, r.limit[n] - r.travelled[n])), struck = false;
      const f = this.vehicles, owner = r.ownerVehicle[n];
      if (f.count) {
        travel = f.castHull(x, y, z, dx, dy, dz, travel, owner);
        struck = f.rayHit >= 0;
      }
      const ex = x + dx * travel, ez = z + dz * travel;
      const minX = grid.column(Math.min(x, ex) - reach), maxX = grid.column(Math.max(x, ex) + reach);
      const minZ = grid.row(Math.min(z, ez) - reach), maxZ = grid.row(Math.max(z, ez) + reach);
      for (let row = minZ; row <= maxZ; row++) for (let col = minX; col <= maxX; col++) {
        for (let j = grid.heads[row * grid.columns + col]; j >= 0; j = grid.next[j]) {
          if (this.id[j] === r.owner[n] || owner && f.ride[j] >= 0 && f.id[f.ride[j]] === owner) continue;
          const t = rayCapsule(x, y, z, dx, dy, dz, this.x[j], this.y[j], this.z[j], this.radius[j]);
          if (t <= travel) { travel = t; struck = true; }
        }
      }
      r.x[n] = x + dx * travel; r.y[n] = y + dy * travel; r.z[n] = z + dz * travel; r.travelled[n] += travel;
      if (struck || r.travelled[n] >= r.limit[n] - 1e-6) {
        if (struck || r.detonate[n]) this.explode({ x: r.x[n], y: r.y[n], z: r.z[n], radius: this.tuning.rocketRadius, damage: this.tuning.rocketDamage, impulse: this.tuning.rocketImpulse });
        r.remove(n); continue;
      }
      // A puff about every 0.35 u keeps fast rockets' trails continuous.
      const puffs = Math.min(4, Math.max(1, Math.ceil(travel / 0.35)));
      for (let p = 1; p <= puffs; p++) {
        const back = travel * (1 - p / puffs) + 0.2;
        this.smoke.emit(r.x[n] - dx * back, r.y[n] - dy * back, r.z[n] - dz * back, this.time - (1 - p / puffs) * CONFIG.step);
      }
      n++;
    }
  }

  /**
   * Holds fire behind an ally and, budget permitting, commits to a short sidestep away from it, perpendicular
   * to the shot. Deliberately no immediate retarget: the shot is retried on the normal fire interval.
   */
  private blockShot(i: number, ally: number, dx: number, dz: number) {
    this.totalBlockedShots++;
    this.blockedUntil[i] = this.time + 0.75;
    if (!this.vehicles.onFoot(i) || !this.grounded[i] || this.flankState[i] === 3 || this.flankBudget <= 0) return;
    // Step to the side of the ray the ally is not on; personal handedness breaks a dead-centre block.
    const lx = -dz, lz = dx, offset = (this.x[ally] - this.x[i]) * lx + (this.z[ally] - this.z[i]) * lz;
    const preferred = Math.abs(offset) < 0.05 ? this.detourSide[i] : offset > 0 ? -1 : 1;
    const distance = this.radius[ally] + this.radius[i] + 0.2;
    for (let n = 0; n < 2; n++) {
      const side = n === 0 ? preferred : -preferred;
      const wx = this.x[i] + lx * side * distance, wz = this.z[i] + lz * side * distance;
      if (!this.flankReachable(i, wx, wz)) continue;
      this.flankBudget--; this.totalSidesteps++;
      this.flankX[i] = wx; this.flankZ[i] = wz; this.flankState[i] = 3;
      this.flankUntil[i] = this.blockedUntil[i] = this.time + 0.75;
      this.resetAnchor(i);
      return;
    }
  }

  private fireTurrets() {
    const f = this.vehicles, range = f.range;
    if (range === null || !f.count) return;
    const started = performance.now();
    for (let n = 0; n < f.count; n++) {
      const v = f.active[n], i = f.seat(v, GUNNER);
      if (i < 0) continue;
      const gun = VEHICLE_TYPES[f.type[v]].turret, interval = this.tuning[gun.interval];
      const x = f.x[v] + f.cos[v] * gun.x + f.sin[v] * gun.z;
      const y = f.y[v] + gun.y, z = f.z[v] - f.sin[v] * gun.x + f.cos[v] * gun.z;
      let j = this.byId.get(this.target[i]) ?? -1;
      const valid = j >= 0 && this.hp[j] > 0 && this.team[j] !== this.team[i];
      if (this.time >= f.nextTurretSearch[v]) {
        if (!valid || Math.hypot(this.x[j] - x, this.z[j] - z, this.y[j] + 0.7 - y) > range) {
          j = this.nearest(i, range + 3.5, range, y);
          this.target[i] = j >= 0 ? this.id[j] : 0;
        }
        f.nextTurretSearch[v] = this.time + 0.28 + (f.id[v] % 13) * 0.012;
      } else if (!valid) j = -1;
      if (j < 0) continue;
      const ax = this.x[j] - x, ay = this.y[j] + 0.7 - y, az = this.z[j] - z, d = Math.hypot(ax, ay, az);
      if (d <= 1e-6) continue;
      f.turretYaw[v] = this.facing[i] = Math.atan2(ax, az); f.turretPitch[v] = Math.atan2(ay, Math.hypot(ax, az));
      if (d > range || f.nextTurretShot[v] > this.time) continue;
      const dx = ax / d, dy = ay / d, dz = az / d, terrain = this.terrain.raycast(x, y, z, dx, dy, dz, d);
      const hitAt = this.directLane(i, x, y, z, dx, dy, dz, terrain), hit = this.beamHit, hull = this.hullHit;
      if (hit >= 0 && this.team[hit] === this.team[i] || hull >= 0 && f.team[hull] === this.team[i]
        || hit < 0 && hull < 0 && terrain < d - 1e-5) {
        this.target[i] = 0; f.nextTurretShot[v] = this.time + Math.min(0.15, interval);
        continue;
      }
      const muzzle = Math.min(gun.barrel, hitAt);
      if (hit >= 0) this.queueDamage(hit, this.tuning[gun.damage]);
      else if (hull >= 0) f.pendingDamage[hull] += this.tuning[gun.damage];
      this.lastFire[i] = this.time; f.nextTurretShot[v] = this.time + interval;
      this.totalShots++; f.metrics.shots++;
      this.events.emit('shot', this.team[i] as Team, x, this.time, gun.effect);
      this.shots.emit(x + dx * muzzle, z + dz * muzzle, x + dx * hitAt, z + dz * hitAt, this.team[i] as Team, this.time, y + dy * muzzle, y + dy * hitAt, gun.effect);
    }
    f.metrics.firingMs += performance.now() - started;
  }

  /** O(n) per tick: each army's firing-line frame, from last tick's engaged soldiers (or the whole army before contact). */
  private updateLines() {
    for (let team = 0; team < 2; team++) {
      let fx = this.centerX[1 - team] - this.centerX[team], fz = this.centerZ[1 - team] - this.centerZ[team];
      const length = Math.hypot(fx, fz);
      if (length > 1e-6) { fx /= length; fz /= length; } else { fx = 0; fz = team === 0 ? -1 : 1; }
      this.lineForwardX[team] = fx; this.lineForwardZ[team] = fz;
    }
    let min0 = Infinity, max0 = -Infinity, depth0 = 0, count0 = 0, allMin0 = Infinity, allMax0 = -Infinity, front0 = -Infinity;
    let min1 = Infinity, max1 = -Infinity, depth1 = 0, count1 = 0, allMin1 = Infinity, allMax1 = -Infinity, front1 = -Infinity;
    for (let i = 0; i < this.used; i++) {
      if (this.hp[i] <= 0) continue;
      const team = this.team[i], fx = this.lineForwardX[team], fz = this.lineForwardZ[team];
      const rx = this.x[i] - this.centerX[team], rz = this.z[i] - this.centerZ[team];
      const lateral = fx * rz - fz * rx, forward = fx * rx + fz * rz;
      if (team === 0) {
        if (lateral < allMin0) allMin0 = lateral; if (lateral > allMax0) allMax0 = lateral; if (forward > front0) front0 = forward;
        if (this.engaged[i]) { if (lateral < min0) min0 = lateral; if (lateral > max0) max0 = lateral; depth0 += forward; count0++; }
      } else {
        if (lateral < allMin1) allMin1 = lateral; if (lateral > allMax1) allMax1 = lateral; if (forward > front1) front1 = forward;
        if (this.engaged[i]) { if (lateral < min1) min1 = lateral; if (lateral > max1) max1 = lateral; depth1 += forward; count1++; }
      }
    }
    if (count0) { this.lineMin[0] = min0; this.lineMax[0] = max0; this.lineDepth[0] = depth0 / count0; }
    else { this.lineMin[0] = allMin0; this.lineMax[0] = allMax0; this.lineDepth[0] = front0; }
    if (count1) { this.lineMin[1] = min1; this.lineMax[1] = max1; this.lineDepth[1] = depth1 / count1; }
    else { this.lineMin[1] = allMin1; this.lineMax[1] = allMax1; this.lineDepth[1] = front1; }
  }

  private resetAnchor(i: number) { this.anchorX[i] = this.x[i]; this.anchorZ[i] = this.z[i]; this.anchorTime[i] = this.time; }

  /** A soldier that is not walking this tick (airborne, idle or firing) is never stuck; firing also ends any flank. */
  private holdFlank(i: number, engaged: number) {
    this.engaged[i] = engaged;
    if (engaged) this.flankState[i] = this.flankTries[i] = 0;
    this.resetAnchor(i);
  }

  /**
   * Runs stuck detection and flank commitment for a walking soldier. Returns true while it should steer
   * toward its waypoint, leaving the unit direction in flankDirX/Z and the remaining distance in flankDistance.
   */
  private steerFlank(i: number): boolean {
    this.engaged[i] = 0;
    let state = this.flankState[i];
    if (state && this.time >= this.flankUntil[i]) { if (state === 1 && this.flankTries[i] < 255) this.flankTries[i]++; state = this.flankState[i] = 0; }
    // Too little net displacement over the window counts as stuck, even if it shuffled every tick.
    if (this.time - this.anchorTime[i] >= this.tuning.flankStuckTime) {
      const stuck = Math.hypot(this.x[i] - this.anchorX[i], this.z[i] - this.anchorZ[i]) < this.tuning.speed * this.tuning.flankStuckTime * 0.25;
      if (!stuck) this.resetAnchor(i);
      else if (this.flankBudget > 0) {
        this.flankBudget--;
        if (state === 1 && this.flankTries[i] < 255) this.flankTries[i]++;
        this.chooseFlank(i); state = this.flankState[i]; this.resetAnchor(i);
      }
    }
    if (!state) return false;
    const wx = this.flankX[i] - this.x[i], wz = this.flankZ[i] - this.z[i], wd = Math.hypot(wx, wz);
    // Arrival hands back to normal pursuit, now with open space beside the line.
    if (wd < (state === 3 ? 0.08 : 0.5)) {
      if (state === 2) this.flankTries[i] = 0;
      if (state === 3) this.blockedUntil[i] = 0;
      this.flankState[i] = 0; return false;
    }
    this.flankDirX = wx / wd; this.flankDirZ = wz / wd; this.flankDistance = wd;
    return true;
  }

  /** Bounded check of a flank waypoint: inside the field and, on terrain, walkable with a clear first stretch. */
  private flankReachable(i: number, wx: number, wz: number) {
    const r = this.radius[i];
    if (Math.abs(wx) > this.grid.halfWidth - r - 0.05 || Math.abs(wz) > this.grid.halfDepth - r - 0.05) return false;
    const nav = this.navigation; if (!nav) return true;
    if (!nav.walkable[this.terrain.cell(wx, wz)]) return false;
    const dx = wx - this.x[i], dz = wz - this.z[i], length = Math.hypot(dx, dz), probe = Math.min(1, 4 / (length || 1));
    return this.terrain.canTraverse(this.x[i], this.z[i], this.x[i] + dx * probe, this.z[i] + dz * probe, r);
  }

  /** Commit a blocked soldier to a point just beyond the nearer edge of its own line, or back off when boxed in. */
  private chooseFlank(i: number) {
    const team = this.team[i], fx = this.lineForwardX[team], fz = this.lineForwardZ[team], lx = -fz, lz = fx;
    const cx = this.centerX[team], cz = this.centerZ[team], rx = this.x[i] - cx, rz = this.z[i] - cz;
    const lateral = lx * rx + lz * rz, forward = fx * rx + fz * rz;
    const tries = this.flankTries[i];
    if (tries <= 3) {
      const gap = this.tuning.flankSpacing * (1 + tries), min = this.lineMin[team], max = this.lineMax[team];
      const toMin = lateral - min, toMax = max - lateral;
      // Split the pile down the middle; personal handedness breaks near-ties.
      const preferred = Math.abs(toMin - toMax) < 0.5 ? this.detourSide[i] : toMin < toMax ? -1 : 1;
      // Ease toward the line's depth while mostly travelling sideways around it.
      const depth = forward + Math.max(0, this.lineDepth[team] - 0.8 - forward) * 0.35;
      for (let n = 0; n < 2; n++) {
        const side = n === 0 ? preferred : -preferred, edge = side < 0 ? min - gap : max + gap;
        const wx = cx + lx * edge + fx * depth, wz = cz + lz * edge + fz * depth;
        if (this.flankReachable(i, wx, wz)) {
          this.flankX[i] = wx; this.flankZ[i] = wz; this.flankState[i] = 1;
          this.flankUntil[i] = this.time + this.tuning.flankTimeout; this.totalFlanks++;
          return;
        }
      }
    }
    // Boxed in or repeatedly re-blocked: step back and to one side to open space, then try again.
    const side = this.detourSide[i];
    let wx = this.x[i] - fx * 1.5 + lx * side * 0.75, wz = this.z[i] - fz * 1.5 + lz * side * 0.75;
    if (!this.flankReachable(i, wx, wz)) { wx = this.x[i] - fx * 1.5; wz = this.z[i] - fz * 1.5; }
    this.flankX[i] = wx; this.flankZ[i] = wz; this.flankState[i] = 2; this.flankTries[i] = 0;
    this.flankUntil[i] = this.time + 1;
  }

  private updateNavigation() {
    const nav = this.navigation; if (!nav) return;
    if (this.tick === 1 || this.tick % 60 === 0) {
      this.goalCounts.fill(0); this.congestedCounts.fill(0);
      // Stationary = covered under a quarter of a second's walk since the last rebuild (firing, holding or stuck).
      const still = this.tuning.speed * 0.25;
      for (let i = 0; i < this.used; i++) if (this.hp[i] > 0) {
        const team = 1 - this.team[i], cell = this.terrain.cell(this.x[i], this.z[i]);
        const node = nav.walkable[cell] ? cell : nav.nodeAt(this.x[i], this.z[i]);
        if (node >= 0) {
          this.goals[team][this.goalCounts[team]++] = node;
          if (Math.hypot(this.x[i] - this.rebuildX[i], this.z[i] - this.rebuildZ[i]) < still) this.congested[this.team[i]][this.congestedCounts[this.team[i]]++] = node;
        }
        this.rebuildX[i] = this.x[i]; this.rebuildZ[i] = this.z[i];
      }
      // Only stationary friendlies congest a team's field: a column on the march should not repel itself.
      // Rifle range also seeds vantage points with a shot at the enemy, whether or not a short walk reaches it.
      for (let team = 0; team < 2; team++) nav.beginField(team, this.goals[team], this.goalCounts[team], this.congested[team], this.congestedCounts[team], this.tuning.congestionCost, this.tuning.range);
    }
    nav.advance(1024);
  }

  /** Positions stay unchanged while commands accumulate, so simultaneous blasts add. Infantry mass = 1. */
  private explode(e: Explosion, formerCrew?: readonly number[]) {
    if (!validExplosion(e)) { this.rejectedExplosions++; return; }
    const minX = this.grid.column(e.x - e.radius), maxX = this.grid.column(e.x + e.radius);
    const minZ = this.grid.row(e.z - e.radius), maxZ = this.grid.row(e.z + e.radius);
    for (let row = minZ; row <= maxZ; row++) for (let col = minX; col <= maxX; col++) {
      for (let i = this.grid.heads[row * this.grid.columns + col]; i >= 0; i = this.grid.next[i]) if (!formerCrew?.includes(this.id[i])) this.blastBody(i, e);
    }
    // Corpses leave the combat grid immediately but retain their bounded physical lifetime.
    for (let i = 0; i < this.used; i++) if (this.hp[i] <= 0 && this.time - this.diedAt[i] < CONFIG.corpseLifetime && !formerCrew?.includes(this.id[i])) this.blastBody(i, e);
    if (this.vehicles.count && this.result === 'running') this.vehicles.blast(e);
    this.explosions.emit(e, this.time); this.totalExplosions++;
  }

  private blastBody(i: number, e: Explosion) {
    this.explosionCandidates++;
    const dx = this.x[i] - e.x, dy = this.y[i] + CONFIG.soldier.height / 2 - e.y, dz = this.z[i] - e.z;
    const d = Math.hypot(dx, dy, dz);
    if (d > e.radius) return;
    if (this.hp[i] > 0) this.queueDamage(i, e.damage);
    if (this.vehicles.ride[i] >= 0) return;
    const impulse = e.impulse * Math.max(0, 1 - d / e.radius);
    if (d > 1e-9) { this.velocityX[i] += dx / d * impulse; this.velocityY[i] += dy / d * impulse; this.velocityZ[i] += dz / d * impulse; }
    else this.velocityY[i] += impulse;
  }

  private wreckBlast(e: Wreck) {
    for (const id of e.crew) {
      const i = this.byId.get(id);
      if (i === undefined) continue;
      this.vehicles.awaitingEjection[i] = 0; this.grounded[i] = 0;
      if (this.hp[i] > 0) { this.vehicles.ejected[i] = 1; this.pendingDamage[i] += e.damage; }
      const dx = this.x[i] - e.x, dz = this.z[i] - e.z, len = Math.hypot(dx, dz);
      this.velocityX[i] += e.impulse * 0.62 * (len > 1e-6 ? dx / len : Math.sin(e.yaw));
      this.velocityZ[i] += e.impulse * 0.62 * (len > 1e-6 ? dz / len : Math.cos(e.yaw));
      this.velocityY[i] += e.impulse * 0.65;
    }
    this.explode(e, e.crew);
  }

  private applyPendingDamage() {
    const f = this.vehicles;
    if (f.count) f.applyDamage();
    for (let i = 0; i < this.used; i++) if (this.pendingDamage[i] > 0) {
      if (this.hp[i] > 0) this.applySoldierDamage(i, this.pendingDamage[i]);
      this.pendingDamage[i] = 0;
    }
  }

  private settleDamage() {
    const f = this.vehicles;
    this.applyPendingDamage();
    let budget = WRECKS_PER_TICK;
    while (budget && f.pendingDestructions) {
      const wave = Math.min(budget, f.pendingDestructions);
      for (let n = 0; n < wave; n++) this.wreckBlast(f.takeWreck());
      budget -= wave; this.applyPendingDamage();
    }
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
      const support = this.terrain.heightAt(x, z);
      if (dy < 0) { const t = Math.max(0, (support - y) / dy); if (t <= distance) { distance = t; ny = 1; } }
      const boundX = this.grid.halfWidth - r, boundZ = this.grid.halfDepth - r;
      if (Math.abs(dx) > 1e-12) { const t = Math.max(0, ((dx > 0 ? boundX : -boundX) - x) / dx); if (t <= distance) { distance = t; nx = dx > 0 ? -1 : 1; ny = nz = 0; } }
      if (Math.abs(dz) > 1e-12) { const t = Math.max(0, ((dz > 0 ? boundZ : -boundZ) - z) / dz); if (t <= distance) { distance = t; nz = dz > 0 ? -1 : 1; nx = ny = 0; } }
      // Rocks and unwalkable slopes act as walls, so landed soldiers always stay on navigable ground.
      if (this.navigation && (dx || dz) && !this.terrain.canStand(x + dx * distance, z + dz * distance, r)) {
        this.velocityX[i] = this.velocityZ[i] = 0;
        continue;
      }
      const fleet = this.vehicles;
      if (fleet.count && this.hp[i] > 0) {
        const hull = fleet.ground.sweepFoot(x, y, z, dx, dy, dz, distance, r);
        if (hull < distance) { distance = hull; nx = fleet.ground.footNX; ny = fleet.ground.footNY; nz = fleet.ground.footNZ; }
      }
      if (this.hp[i] > 0) {
        const reach = r + this.tuning.radius + 0.002, ex = x + dx * distance, ez = z + dz * distance;
        const minX = this.grid.column(Math.min(x, ex) - reach), maxX = this.grid.column(Math.max(x, ex) + reach);
        const minZ = this.grid.row(Math.min(z, ez) - reach), maxZ = this.grid.row(Math.max(z, ez) + reach);
        for (let row = minZ; row <= maxZ; row++) for (let col = minX; col <= maxX; col++) {
          for (let j = this.grid.heads[row * this.grid.columns + col]; j >= 0; j = this.grid.next[j]) {
            if (j === i || !fleet.onFoot(j)) continue;
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
      if (this.hp[i] > 0) this.grid.insert(i, this.x[i], this.z[i]);
      if (!(nx || ny || nz)) break;
      remaining *= Math.max(0, 1 - distance / length);
      const inward = vx * nx + vy * ny + vz * nz;
      if (inward >= 0) break;
      this.velocityX[i] -= inward * nx; this.velocityY[i] -= inward * ny; this.velocityZ[i] -= inward * nz;
      // Let a perfectly centered head landing slide off instead of balancing forever.
      if (ny > 0.5 && y > support + 0.01 && Math.hypot(this.velocityX[i], this.velocityZ[i]) < 0.01) this.velocityX[i] += this.detourSide[i] * 0.25;
    }
  }

  private archiveCorpse(i: number) {
    if (!this.pendingCorpse[i]) return;
    this.pendingCorpse[i] = 0;
    this.retiredCorpses[this.retiredCorpseCount++ % CONFIG.retainedCorpses] = {
      id: this.id[i], at: this.diedAt[i] + CONFIG.corpseLifetime,
      x: this.x[i], y: this.y[i], z: this.z[i], velocityY: this.velocityY[i],
      yaw: this.facing[i], fallOffset: this.deathFallOffset[i], roll: this.deathRoll[i],
      aimPitch: this.aimPitch[i], radius: this.radius[i],
      team: this.team[i] as Team, weapon: this.weapon[i],
    };
  }

  private integrateBodies() {
    this.activeBodies = this.airborne = 0;
    for (let n = 0; n < this.used; n++) {
      const i = (this.tick + (this.tick % 2 ? n : this.used - 1 - n)) % this.used;
      if (!this.vehicles.onFoot(i)) continue;
      if (this.hp[i] <= 0 && this.time - this.diedAt[i] >= CONFIG.corpseLifetime) {
        this.archiveCorpse(i);
        continue;
      }
      const ground = this.terrain.heightAt(this.x[i], this.z[i]);
      if (this.y[i] <= ground + 1e-5 && this.velocityY[i] <= 0) { this.y[i] = ground; this.velocityY[i] = 0; this.grounded[i] = 1; }
      else { this.grounded[i] = 0; this.velocityY[i] -= this.tuning.gravity * CONFIG.step; }
      if (this.velocityX[i] || this.velocityY[i] || this.velocityZ[i] || !this.grounded[i]) {
        this.activeBodies++; this.moveBody(i);
        const support = this.terrain.heightAt(this.x[i], this.z[i]);
        // Rising terrain lifts a sliding or falling body onto the surface.
        if (this.y[i] <= support + 1e-5 && this.velocityY[i] <= 0) { this.y[i] = support; this.velocityY[i] = 0; this.grounded[i] = 1; }
        else if (this.y[i] < support) this.y[i] = support;
        if (this.grounded[i]) {
          const speed = Math.hypot(this.velocityX[i], this.velocityZ[i]);
          const scale = speed > 0 ? Math.max(0, 1 - CONFIG.physics.friction * CONFIG.step / speed) : 0;
          this.velocityX[i] *= scale; this.velocityZ[i] *= scale;
        }
        if (this.hp[i] > 0) this.lastProgress[i] = this.time;
      }
      if (!this.grounded[i]) this.airborne++;
      else this.vehicles.ejected[i] = 0;
    }
  }

  step() {
    const fleet = this.vehicles;
    this.pendingDamage.fill(0, 0, this.used);
    this.explosionCandidates = this.collisionChecks = 0;
    this.time += CONFIG.step; this.tick++;
    fleet.savePrevious();
    this.centerX.fill(0); this.centerZ.fill(0);
    for (let i = 0; i < this.used; i++) {
      this.previousX[i] = this.x[i]; this.previousY[i] = this.y[i]; this.previousZ[i] = this.z[i]; this.moving[i] = 0;
      if (this.hp[i] > 0) { this.centerX[this.team[i]] += this.x[i]; this.centerZ[this.team[i]] += this.z[i]; }
    }
    this.applyCommands();
    fleet.place(true);
    this.updateNavigation();
    fleet.updateNavigation();
    this.integrateBodies();
    // Rockets already in flight keep flying after the result; their blasts then only move bodies.
    if (this.result !== 'running') { this.advanceRockets(); return; }
    for (let team = 0; team < 2; team++) if (this.alive[team]) { this.centerX[team] /= this.alive[team]; this.centerZ[team] /= this.alive[team]; }
    this.updateLines();
    // Caps waypoint selection so a sudden pile-up cannot spike a frame.
    this.flankBudget = Math.max(8, this.used >> 4);
    // Alternate direction and rotate priority to avoid a permanent first-mover advantage.
    for (let n = 0; n < this.used; n++) {
      const i = (this.tick + (this.tick % 2 ? n : this.used - 1 - n)) % this.used;
      if (this.hp[i] <= 0) continue;
      if (fleet.awaitingEjection[i] || fleet.ejected[i] || fleet.ride[i] >= 0 && fleet.role[i] !== PASSENGER) continue;
      let target = this.byId.get(this.target[i]) ?? -1;
      const range = this.longestRange(i);
      const distance = target >= 0 ? Math.hypot(this.x[target] - this.x[i], this.z[target] - this.z[i], this.y[target] - this.y[i]) : Infinity;
      const valid = target >= 0 && this.hp[target] > 0 && this.team[target] !== this.team[i];
      const multipleWeapons = (this.inventory[i] & (this.inventory[i] - 1)) !== 0;
      // A shooter whose target just fell takes a moment to notice and pick another, instead of snapping on the next tick.
      if (!valid && this.target[i] !== 0 && this.engaged[i] && this.tuning.reactionDelay > 0) {
        this.target[i] = 0;
        this.reactUntil[i] = this.nextSearch[i] = this.time + this.tuning.reactionDelay * (0.5 + this.aiRng());
      }
      if (!valid || ((distance > range || multipleWeapons || this.navigation && !this.visible[i] && this.time >= this.nextRetarget[i]) && this.time >= this.nextSearch[i])) {
        if (this.time >= this.nextSearch[i] || this.target[i] !== 0) {
          target = this.nearest(i, range + this.tuning.searchPadding);
          this.target[i] = target >= 0 ? this.id[target] : 0;
          // Random ±25% spreads searches across ticks and keeps soldiers from deciding in lockstep.
          this.nextSearch[i] = this.time + this.tuning.searchInterval * (0.75 + 0.5 * this.aiRng());
          this.nextSight[i] = this.time + SIGHT_INTERVAL * (1 + (i % 5) * 0.05);
          this.visible[i] = +(target >= 0 && (!this.navigation || this.nearestVisible));
          this.nextRetarget[i] = this.time + Math.max(0.48, this.tuning.searchInterval * 1.5);
        } else target = -1;
      } else if (this.navigation && this.time >= this.nextSight[i]) {
        this.visible[i] = +this.terrain.visible(this.x[i], this.y[i] + 0.7, this.z[i], this.x[target], this.y[target] + 0.7, this.z[target]);
        this.nextSight[i] = this.time + SIGHT_INTERVAL * (1 + (i % 5) * 0.05);
      }
      if (this.time < this.reactUntil[i]) { this.holdFlank(i, 1); continue; }
      const tx = target >= 0 ? this.x[target] : this.centerX[1 - this.team[i]];
      const tz = target >= 0 ? this.z[target] : this.centerZ[1 - this.team[i]];
      const dx = tx - this.x[i], dz = tz - this.z[i], d = Math.hypot(dx, dz);
      const reach = target >= 0 ? Math.hypot(d, this.y[target] - this.y[i]) : d;
      this.weapon[i] = this.selectWeapon(i, reach);
      // Fire whatever reaches (above), but keep closing until the best weapon carried can fire.
      const gunRange = this.weapon[i] === NO_WEAPON ? 0 : this.preferredRange(i);
      if (d > 0.001) this.facing[i] = Math.atan2(dx, dz);
      if (fleet.ride[i] >= 0) continue;
      // Airborne soldiers can still aim and fire, but cannot walk until they land.
      if (!this.grounded[i]) { this.holdFlank(i, 0); continue; }
      if (fleet.reservedVehicle[i] >= 0) { this.seekTruck(i, fleet.reservedVehicle[i]); continue; }
      const inRange = gunRange > 0 && target >= 0 && (!this.navigation || this.visible[i]) && reach <= gunRange - 0.12;
      const blocked = this.time < this.blockedUntil[i];
      const engage = inRange && !blocked;
      if (this.weaponsEnabled && engage) { this.holdFlank(i, 1); continue; }
      // Blocked with no sidestep committed: hold still rather than shove into the crowd (cheap, and the lane often clears).
      if (this.weaponsEnabled && inRange && this.flankState[i] !== 3) { this.holdFlank(i, 0); continue; }
      if (d < 0.001 || !this.alive[1 - this.team[i]]) { this.holdFlank(i, 0); continue; }
      let step = Math.min(this.tuning.speed * CONFIG.step, Math.max(0, this.weaponsEnabled && engage ? d - gunRange + 0.08 : d));
      if (step <= 0) { this.holdFlank(i, 0); continue; }
      // Boxed in last attempt: wait it out. The anchor is left alone so stuck detection still sees the stall,
      // and a soldier committed to a flank or sidestep keeps pushing, since that is how piles clear.
      if (this.time < this.moveRetryAt[i] && !this.flankState[i]) { this.engaged[i] = 0; continue; }
      let vx = dx / d, vz = dz / d, separationX = 0, separationZ = 0;
      if (this.steerFlank(i)) { vx = this.flankDirX; vz = this.flankDirZ; step = Math.min(this.tuning.speed * CONFIG.step, this.flankDistance); }
      else if (this.navigation) {
        if (this.navigation.direction(this.team[i], this.x[i], this.z[i])) {
          const length = Math.hypot(this.navigation.directionX, this.navigation.directionZ);
          vx = this.navigation.directionX / length; vz = this.navigation.directionZ / length;
        } else if (!this.navigation.fields[this.team[i]].ready) { this.holdFlank(i, 0); continue; }
      }
      const refreshAvoidance = !this.navigation || (this.tick + i) % 2 === 0;
      if (refreshAvoidance) {
        const reach = this.tuning.avoidanceDistance, minX = this.grid.column(this.x[i] - reach), maxX = this.grid.column(this.x[i] + reach);
        const minZ = this.grid.row(this.z[i] - reach), maxZ = this.grid.row(this.z[i] + reach);
        for (let row = minZ; row <= maxZ; row++) for (let column = minX; column <= maxX; column++) {
          for (let j = this.grid.heads[row * this.grid.columns + column]; j >= 0; j = this.grid.next[j]) {
            if (j === i || !fleet.onFoot(j)) continue;
            if (!this.grounded[j] && Math.abs(this.y[i] - this.y[j]) >= CONFIG.soldier.height) continue;
            const ox = this.x[i] - this.x[j], oz = this.z[i] - this.z[j], dd = Math.hypot(ox, oz);
            if (dd > 1e-6 && dd < reach) { const force = (reach - dd) / reach * this.tuning.avoidanceStrength; separationX += ox / dd * force; separationZ += oz / dd * force; }
          }
        }
        this.avoidanceX[i] = separationX; this.avoidanceZ[i] = separationZ;
      } else { separationX = this.avoidanceX[i]; separationZ = this.avoidanceZ[i]; }
      vx += separationX; vz += separationZ;
      const magnitude = Math.hypot(vx, vz); vx /= magnitude || 1; vz /= magnitude || 1;
      const ox = this.x[i], oz = this.z[i];
      let moved = this.safeMove(i, ox + vx * step, oz + vz * step);
      if (!moved) {
        const side = this.detourSide[i];
        // Bounded alternatives let columns spill sideways without contact penetration.
        for (let attempt = 0; attempt < 6 && !moved; attempt++) {
          const c = this.detourCos[attempt], s = this.detourSin[attempt] * side;
          moved = this.safeMove(i, ox + (vx * c - vz * s) * step, oz + (vx * s + vz * c) * step);
        }
      }
      if (moved) this.moving[i] = 1;
      else if (this.tuning.moveRetryDelay > 0) this.moveRetryAt[i] = this.time + this.tuning.moveRetryDelay * (0.5 + this.aiRng());
    }
    if (this.alive[0] && this.alive[1]) fleet.step();
    if (this.weaponsEnabled) for (let i = 0; i < this.used; i++) {
      if (this.hp[i] <= 0) continue;
      if (fleet.awaitingEjection[i] || fleet.ejected[i] || fleet.ride[i] >= 0 && fleet.role[i] !== PASSENGER) continue;
      const target = this.byId.get(this.target[i]);
      // Re-evaluate after movement so the gun fired always matches the resolved range.
      this.weapon[i] = this.selectWeapon(i, target === undefined ? Infinity : Math.hypot(this.x[target] - this.x[i], this.z[target] - this.z[i], this.y[target] - this.y[i]));
      if (this.weapon[i] === NO_WEAPON || this.nextFire[i] > this.time) continue;
      if (target !== undefined && this.hp[target] > 0 && this.team[target] !== this.team[i]
        && (!this.navigation || this.visible[i])
        && Math.hypot(this.x[target] - this.x[i], this.z[target] - this.z[i], this.y[target] - this.y[i]) <= this.weaponFor(this.weapon[i]).range
        && this.fire(i, target)) continue;
      // Preserve firing phases while approaching or covered, without firing into walls.
      const interval = this.weaponFor(this.weapon[i]).interval;
      this.nextFire[i] += (Math.floor((this.time - this.nextFire[i]) / interval) + 1) * interval;
    }
    if (this.weaponsEnabled && fleet.count) this.fireTurrets();
    // After firing, so a rocket that lands this tick adds its blast to the same simultaneous damage pass.
    this.advanceRockets();
    this.settleDamage();
    if ((!this.alive[0] || !this.alive[1]) && !fleet.pendingDestructions) {
      this.result = !this.alive[0] && !this.alive[1] ? 'draw' : this.alive[0] ? 'plutonians' : 'sectoids';
      this.endedAt = this.time; fleet.place();
    }
  }

  private seekTruck(i: number, v: number) {
    const f = this.vehicles, ox = this.x[i], oz = this.z[i], dx = f.x[v] - ox, dz = f.z[v] - oz;
    const distance = Math.hypot(dx, dz);
    this.holdFlank(i, 0);
    if (distance <= 1.1 + this.radius[i]) return;
    const stride = Math.min(distance, this.tuning.speed * CONFIG.step), sx = dx / distance * stride, sz = dz / distance * stride;
    let moved = this.safeMove(i, ox + sx, oz + sz);
    for (let n = 0; n < 6 && !moved; n++) {
      const c = this.detourCos[n], s = this.detourSin[n] * this.detourSide[i];
      moved = this.safeMove(i, ox + sx * c - sz * s, oz + sx * s + sz * c);
    }
    this.moving[i] = +moved;
  }

  private applyCommands(combat = true) {
    let deferred = 0;
    for (const command of this.commands) {
      if (command.type === 'spawn') { if (this.spawn(command.team, command.x, command.z, command.weapon) === null) this.rejectedSpawns++; }
      else if (command.type === 'explode') {
        if (!combat) this.commands[deferred++] = command;
        else if (this.result === 'running') this.explode(command);
      }
      else if (command.type === 'deployTrucks') { if (this.result === 'running') this.vehicles.paint(command.x, command.z, command.radius, command.teams, command.solo); }
      else if (!WEAPONS[command.weapon]) continue;
      else if (command.type === 'equip') for (const id of command.ids) {
        const i = this.byId.get(id);
        if (i !== undefined && this.hp[i] > 0) { this.inventory[i] = 1 << command.weapon; this.weapon[i] = command.weapon; }
      }
      else if (this.result !== 'running') continue;
      else if (command.type === 'upgrade') for (const id of command.ids) {
        const i = this.byId.get(id);
        if (i !== undefined) this.upgradeSlot(i, command.weapon);
      }
      else if (Number.isFinite(command.x) && Number.isFinite(command.z) && command.radius >= 0) {
        for (let i = 0; i < this.used; i++) if (this.inArea(i, command.team, command.x, command.z, command.radius)) this.upgradeSlot(i, command.weapon);
      }
    }
    this.commands.length = deferred;
  }
}
