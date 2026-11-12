import { random } from './random.ts';
import type { TuningValues } from './tuning.ts';
import { archetypeById, mirrored, pickArchetype, spires, type GenerationContext, type Landform, type TerrainPalette } from './terrain-archetypes.ts';
import { Noise, clamp, gradeProfile, lerp, polylineDistance, smooth } from './terrain-shapes.ts';
import type { TruckBlocker } from './vehicle-types.ts';

export type { Landform, TerrainPalette } from './terrain-archetypes.ts';
export interface Rock { x: number; z: number; radius: number; base: number; height: number; angle: number }
export const MAX_SLOPE = 0.85;
const SIDES = 8, APOTHEM = Math.cos(Math.PI / SIDES);

/** One triangulated support surface; small rocks are separate convex solids.
 * No Three.js dependency. All geometry queries use the mesh's actual triangles. */
export class Terrain {
  readonly columns: number;
  readonly rows: number;
  readonly dx: number;
  readonly dz: number;
  readonly heights: Float32Array;
  readonly slope: Float32Array;
  readonly maximum: Float32Array;
  readonly buckets: number[][];
  readonly rockStamp: Uint32Array;
  private stamp = 0;
  rayQueries = 0;
  rayCells = 0;
  maxHeight = 0;
  minHeight = 0;
  generationMs = 0;
  repairs = 0;
  /** True when every repair failed and the map was flattened. */
  fallback = false;
  readonly halfWidth: number;
  readonly halfDepth: number;
  readonly seed: number;
  readonly rocks: Rock[];
  readonly features: Landform[];
  /** Map identity and look; the flat fixture keeps the defaults. */
  archetype = 'flat';
  name = 'Flat';
  region = 'Test Range';
  palette: TerrainPalette | null = null;
  /** −1 on mirrored maps, otherwise the defending team. */
  defender = -1;
  /** Deployment pad heights for team 0 (+z) and team 1 (−z). */
  pads: [number, number] = [0, 0];
  /** Carved walkways: designed ramps first, then any repair ramps. */
  readonly ramps: { points: Float64Array; halfWidth: number; repair: boolean }[] = [];

  constructor(halfWidth: number, halfDepth: number, seed = 0,
    rocks: Rock[] = [], features: Landform[] = [], resolution = 0.65) {
    this.halfWidth = halfWidth; this.halfDepth = halfDepth; this.seed = seed; this.rocks = rocks; this.features = features;
    this.columns = Math.ceil(halfWidth * 2 / resolution); this.rows = Math.ceil(halfDepth * 2 / resolution);
    this.dx = halfWidth * 2 / this.columns; this.dz = halfDepth * 2 / this.rows;
    this.heights = new Float32Array((this.columns + 1) * (this.rows + 1));
    this.slope = new Float32Array(this.columns * this.rows * 2);
    this.maximum = new Float32Array(this.columns * this.rows);
    this.buckets = Array.from({ length: this.columns * this.rows }, () => []);
    this.rockStamp = new Uint32Array(256);
  }
  static flat(halfWidth = 28, halfDepth = 34) { return new Terrain(halfWidth, halfDepth); }
  column(x: number) { return Math.max(0, Math.min(this.columns - 1, Math.floor((x + this.halfWidth) / this.dx))); }
  row(z: number) { return Math.max(0, Math.min(this.rows - 1, Math.floor((z + this.halfDepth) / this.dz))); }
  cell(x: number, z: number) { return this.row(z) * this.columns + this.column(x); }
  heightAt(x: number, z: number) {
    const c = this.column(x), r = this.row(z), u = Math.max(0, Math.min(1, (x + this.halfWidth) / this.dx - c)), v = Math.max(0, Math.min(1, (z + this.halfDepth) / this.dz - r));
    const a = r * (this.columns + 1) + c, b = a + 1, cc = a + this.columns + 1, d = cc + 1, h = this.heights;
    return u + v <= 1 ? h[a] + (h[b] - h[a]) * u + (h[cc] - h[a]) * v
      : h[d] + (h[cc] - h[d]) * (1 - u) + (h[b] - h[d]) * (1 - v);
  }
  slopeAt(x: number, z: number) {
    const c = this.column(x), r = this.row(z), u = (x + this.halfWidth) / this.dx - c, v = (z + this.halfDepth) / this.dz - r;
    return this.slope[(r * this.columns + c) * 2 + (u + v > 1 ? 1 : 0)];
  }
  /** Rebuild once after generation or explicit test-fixture changes. */
  rebuild() {
    this.maxHeight = 0; this.minHeight = 0;
    for (const h of this.heights) { this.maxHeight = Math.max(this.maxHeight, h); this.minHeight = Math.min(this.minHeight, h); }
    for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.columns; c++) {
      const a = r * (this.columns + 1) + c, h = this.heights, b = a + 1, cc = a + this.columns + 1, d = cc + 1, cell = r * this.columns + c;
      this.slope[cell * 2] = Math.hypot((h[b] - h[a]) / this.dx, (h[cc] - h[a]) / this.dz);
      this.slope[cell * 2 + 1] = Math.hypot((h[d] - h[cc]) / this.dx, (h[d] - h[b]) / this.dz);
      this.maximum[cell] = Math.max(h[a], h[b], h[cc], h[d]); this.buckets[cell].length = 0;
    }
    if (this.rocks.length > this.rockStamp.length) throw new Error('Terrain rock capacity exceeded.');
    for (let i = 0; i < this.rocks.length; i++) {
      const rock = this.rocks[i]; this.maxHeight = Math.max(this.maxHeight, rock.base + rock.height);
      for (let r = this.row(rock.z - rock.radius); r <= this.row(rock.z + rock.radius); r++)
        for (let c = this.column(rock.x - rock.radius); c <= this.column(rock.x + rock.radius); c++) this.buckets[r * this.columns + c].push(i);
    }
  }
  private supports(x: number, z: number, radius: number, slope: number) {
    return this.slopeAt(x, z) <= slope && this.slopeAt(x - radius, z) <= slope && this.slopeAt(x + radius, z) <= slope
      && this.slopeAt(x, z - radius) <= slope && this.slopeAt(x, z + radius) <= slope;
  }
  canStand(x: number, z: number, radius: number) {
    if (Math.abs(x) > this.halfWidth - radius || Math.abs(z) > this.halfDepth - radius) return false;
    if (!this.supports(x, z, radius, MAX_SLOPE)) return false;
    for (let r = this.row(z - radius); r <= this.row(z + radius); r++) for (let c = this.column(x - radius); c <= this.column(x + radius); c++) {
      for (const i of this.buckets[r * this.columns + c]) {
        const rock = this.rocks[i], ox = x - rock.x, oz = z - rock.z;
        if (ox * ox + oz * oz >= (rock.radius + radius) ** 2) continue;
        let outside = false;
        for (let s = 0; s < SIDES; s++) {
          const a = rock.angle + (s + 0.5) * Math.PI * 2 / SIDES;
          if (ox * Math.cos(a) + oz * Math.sin(a) > rock.radius * APOTHEM + radius) { outside = true; break; }
        }
        if (!outside) return false;
      }
    }
    return true;
  }
  /** Ground clearance for one disk of a vehicle footprint. Clip the whole sweep against the expanded rock sides. */
  driveClear(x: number, z: number, tx: number, tz: number, radius: number, slope: number, blocker?: TruckBlocker) {
    const left = Math.min(x, tx) - radius, right = Math.max(x, tx) + radius;
    const near = Math.min(z, tz) - radius, far = Math.max(z, tz) + radius;
    if (left < -this.halfWidth || right > this.halfWidth || near < -this.halfDepth || far > this.halfDepth) {
      if (blocker) {
        const atStart = Math.abs(x) + radius > this.halfWidth || Math.abs(z) + radius > this.halfDepth;
        blocker.kind = 'map-edge'; blocker.id = null; blocker.atStart = atStart;
        blocker.x = atStart ? x : tx; blocker.z = atStart ? z : tz;
      }
      return false;
    }
    if (this.maxHeight === this.minHeight && !this.rocks.length) return true;
    const dx = tx - x, dz = tz - z;
    const samples = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 0.22));
    for (let s = 1; s <= samples; s++) {
      const qx = x + dx * s / samples, qz = z + dz * s / samples;
      if (this.supports(qx, qz, radius, slope)) continue;
      if (blocker) {
        blocker.kind = 'slope'; blocker.id = null; blocker.x = qx; blocker.z = qz;
        blocker.atStart = !this.supports(x, z, radius, slope);
      }
      return false;
    }
    if (!this.rocks.length) return true;
    if (++this.stamp === 0xffffffff) { this.rockStamp.fill(0); this.stamp = 1; }
    for (let r = this.row(near); r <= this.row(far); r++) for (let c = this.column(left); c <= this.column(right); c++) {
      for (const i of this.buckets[r * this.columns + c]) {
        if (this.rockStamp[i] === this.stamp) continue;
        this.rockStamp[i] = this.stamp;
        const rock = this.rocks[i];
        if (rock.x + rock.radius < left || rock.x - rock.radius > right || rock.z + rock.radius < near || rock.z - rock.radius > far) continue;
        let enter = 0, leave = 1;
        for (let s = 0; s < SIDES && enter <= leave; s++) {
          const angle = rock.angle + (s + 0.5) * Math.PI * 2 / SIDES;
          const nx = Math.cos(angle), nz = Math.sin(angle);
          const offset = (x - rock.x) * nx + (z - rock.z) * nz - rock.radius * APOTHEM - radius;
          const speed = dx * nx + dz * nz;
          if (speed < -1e-10) enter = Math.max(enter, -offset / speed);
          else if (speed > 1e-10) leave = Math.min(leave, -offset / speed);
          else if (offset > 0) leave = -1;
        }
        if (enter <= leave) {
          if (blocker) {
            blocker.kind = 'rock'; blocker.id = i; blocker.x = rock.x; blocker.z = rock.z;
            blocker.atStart = enter === 0 && Math.abs(x - rock.x) <= rock.radius + radius && Math.abs(z - rock.z) <= rock.radius + radius;
          }
          return false;
        }
      }
    }
    return true;
  }
  canTraverse(x: number, z: number, tx: number, tz: number, radius: number) {
    const length = Math.hypot(tx - x, tz - z), count = Math.max(1, Math.ceil(length / Math.min(0.2, radius * 0.75)));
    let py = this.heightAt(x, z);
    for (let i = 1; i <= count; i++) {
      const qx = x + (tx - x) * i / count, qz = z + (tz - z) * i / count;
      if (!this.canStand(qx, qz, radius)) return false;
      const y = this.heightAt(qx, qz);
      if (Math.abs(y - py) > MAX_SLOPE * length / count + 1e-5) return false;
      py = y;
    }
    return true;
  }
  private rockRay(rock: Rock, x: number, y: number, z: number, dx: number, dy: number, dz: number, limit: number) {
    let near = 0, far = limit;
    // Two tiers of convex planes form a broad base and an angular pointed roof.
    for (let s = -2; s < SIDES * 2; s++) {
      let distance: number, velocity: number;
      if (s === -2) { distance = rock.base - y; velocity = -dy; }
      else if (s === -1) { distance = y - rock.base - rock.height; velocity = dy; }
      else {
        const roof = s >= SIDES, a = rock.angle + (s % SIDES + 0.5) * Math.PI * 2 / SIDES, nx = Math.cos(a), nz = Math.sin(a);
        const k = rock.radius * APOTHEM * (roof ? 0.55 / 0.22 : 0.45 / 0.78) / rock.height;
        distance = nx * (x - rock.x) + nz * (z - rock.z) + k * (y - rock.base - (roof ? rock.height * 0.78 : 0)) - rock.radius * APOTHEM * (roof ? 0.55 : 1);
        velocity = nx * dx + nz * dz + k * dy;
      }
      if (Math.abs(velocity) < 1e-10) { if (distance > 0) return Infinity; }
      else { const t = -distance / velocity; if (velocity < 0) near = Math.max(near, t); else far = Math.min(far, t); }
      if (near > far) return Infinity;
    }
    return near;
  }
  /** Exact segment/triangle-height crossing, split at grid and triangle edges. */
  raycast(x: number, y: number, z: number, dx: number, dy: number, dz: number, limit: number) {
    this.rayQueries++;
    if (Math.min(y, y + dy * limit) > this.maxHeight + 1e-7) return limit;
    let closest = limit, c = this.column(x), r = this.row(z), t = 0;
    const sx = dx >= 0 ? 1 : -1, sz = dz >= 0 ? 1 : -1;
    const deltaX = Math.abs(dx) > 1e-10 ? this.dx / Math.abs(dx) : Infinity, deltaZ = Math.abs(dz) > 1e-10 ? this.dz / Math.abs(dz) : Infinity;
    let nextX = Math.abs(dx) > 1e-10 ? ((c + (sx > 0 ? 1 : 0)) * this.dx - this.halfWidth - x) / dx : Infinity;
    let nextZ = Math.abs(dz) > 1e-10 ? ((r + (sz > 0 ? 1 : 0)) * this.dz - this.halfDepth - z) / dz : Infinity;
    if (++this.stamp === 0xffffffff) { this.rockStamp.fill(0); this.stamp = 1; }
    while (t < closest && c >= 0 && c < this.columns && r >= 0 && r < this.rows) {
      this.rayCells++;
      const cell = r * this.columns + c;
      for (const i of this.buckets[cell]) if (this.rockStamp[i] !== this.stamp) {
        this.rockStamp[i] = this.stamp; closest = Math.min(closest, this.rockRay(this.rocks[i], x, y, z, dx, dy, dz, closest));
      }
      const end = Math.min(nextX, nextZ, closest);
      if (Math.min(y + dy * t, y + dy * end) <= this.maximum[cell] + 1e-7) {
        const diagonalVelocity = dx / this.dx + dz / this.dz;
        const cross = Math.abs(diagonalVelocity) > 1e-10 ? (1 + c + r - (x + this.halfWidth) / this.dx - (z + this.halfDepth) / this.dz) / diagonalVelocity : Infinity;
        let from = t;
        for (let part = 0; part < 2; part++) {
          const to = part === 0 && cross > t + 1e-8 && cross < end - 1e-8 ? cross : end;
          const a = y + dy * from - this.heightAt(x + dx * from, z + dz * from), b = y + dy * to - this.heightAt(x + dx * to, z + dz * to);
          if (a < -1e-7) return from;
          if (b <= -1e-7) return Math.min(closest, from + (to - from) * a / (a - b));
          if (to === end) break;
          from = to;
        }
      }
      if (nextX < nextZ) { t = nextX; nextX += deltaX; c += sx; } else { t = nextZ; nextZ += deltaZ; r += sz; }
    }
    return closest;
  }
  visible(x: number, y: number, z: number, tx: number, ty: number, tz: number) {
    const d = Math.hypot(tx - x, ty - y, tz - z);
    return d < 1e-8 || this.raycast(x, y, z, (tx - x) / d, (ty - y) / d, (tz - z) / d, d) >= d - 1e-5;
  }
}


export interface DeploymentBounds { spawnX: number; spawnNear: number; spawnFar: number }
/** Deployment rectangles shared by generation, repair and tests: |x| ≤ spawnX, spawnNear ≤ ±z ≤ spawnFar. */
export function deploymentBounds(tuning: TuningValues): DeploymentBounds {
  const columns = Math.min(tuning.columns, tuning.count), rows = Math.ceil(tuning.count / columns);
  return {
    spawnX: (columns - 1) / 2 * tuning.columnSpacing + tuning.jitterX + tuning.radius + 0.9,
    spawnNear: tuning.frontline - tuning.radius - 0.9,
    spawnFar: tuning.frontline + (rows - 1) * tuning.rowSpacing + tuning.jitterZ + tuning.radius + 0.9,
  };
}
/** Signed distance outside a team's deployment rectangle (negative inside). */
export function padDistance(x: number, z: number, team: number, b: DeploymentBounds) {
  const zz = team === 0 ? z : -z;
  return Math.max(Math.abs(x) - b.spawnX, b.spawnNear - zz, zz - b.spawnFar);
}
export const padClearance = (x: number, z: number, b: DeploymentBounds) => Math.min(padDistance(x, z, 0, b), padDistance(x, z, 1, b));

function polylineLength(points: ArrayLike<number>) {
  let length = 0;
  for (let i = 0; i + 3 < points.length; i += 2) length += Math.hypot(points[i + 2] - points[i], points[i + 3] - points[i + 1]);
  return length;
}
/** Evenly spaced samples along a polyline: flat [x, z, ...]. */
function resample(points: ArrayLike<number>, n: number) {
  const out = new Float64Array(n * 2), length = polylineLength(points);
  let segment = 0, travelled = 0;
  for (let i = 0; i < n; i++) {
    const s = n > 1 ? length * i / (n - 1) : 0;
    while (segment + 5 < points.length) {
      const l = Math.hypot(points[segment + 2] - points[segment], points[segment + 3] - points[segment + 1]);
      if (travelled + l >= s) break;
      travelled += l; segment += 2;
    }
    const l = Math.hypot(points[segment + 2] - points[segment], points[segment + 3] - points[segment + 1]), t = l > 1e-9 ? clamp((s - travelled) / l, 0, 1) : 0;
    out[i * 2] = lerp(points[segment], points[segment + 2], t); out[i * 2 + 1] = lerp(points[segment + 1], points[segment + 3], t);
  }
  return out;
}

/** Carving weight that leaves deployment pads untouched and blends back in just outside them. */
export const padGuard = (b: DeploymentBounds) => (x: number, z: number) => smooth(padClearance(x, z, b) / 0.3);

/** Grade a walkway along `points` (at most `grade` rise per unit) and blend it into
 * the surface: flat across `halfWidth`, then a `shoulder` blend. Cuts and fills.
 * Does not rebuild. Returns whether the whole climb fitted the grade. */
export function carveRamp(terrain: Terrain, points: ArrayLike<number>, halfWidth: number, grade = 0.5, shoulder = 2, protect?: (x: number, z: number) => number) {
  const length = polylineLength(points);
  if (length < 1e-6) return true;
  const n = Math.max(2, Math.ceil(length / (Math.min(terrain.dx, terrain.dz) * 0.5)) + 1), step = length / (n - 1), samples = resample(points, n), profile = new Float64Array(n);
  for (let i = 0; i < n; i++) profile[i] = terrain.heightAt(samples[i * 2], samples[i * 2 + 1]);
  const feasible = gradeProfile(profile, step, grade), reach = halfWidth + shoulder, out = new Float64Array(1);
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i + 1 < points.length; i += 2) { x0 = Math.min(x0, points[i]); x1 = Math.max(x1, points[i]); z0 = Math.min(z0, points[i + 1]); z1 = Math.max(z1, points[i + 1]); }
  const c0 = Math.max(0, Math.floor((x0 - reach + terrain.halfWidth) / terrain.dx)), c1 = Math.min(terrain.columns, Math.ceil((x1 + reach + terrain.halfWidth) / terrain.dx));
  const r0 = Math.max(0, Math.floor((z0 - reach + terrain.halfDepth) / terrain.dz)), r1 = Math.min(terrain.rows, Math.ceil((z1 + reach + terrain.halfDepth) / terrain.dz));
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
    const x = -terrain.halfWidth + c * terrain.dx, z = -terrain.halfDepth + r * terrain.dz, distance = polylineDistance(points, x, z, out);
    if (distance >= reach) continue;
    const f = clamp(out[0] / step, 0, n - 1), i = Math.min(n - 2, Math.floor(f)), target = lerp(profile[i], profile[i + 1], f - i);
    const index = r * (terrain.columns + 1) + c, keep = protect ? protect(x, z) : 1;
    if (keep > 0) terrain.heights[index] = lerp(terrain.heights[index], target, (1 - smooth((distance - halfWidth) / shoulder)) * keep);
  }
  return feasible;
}

/** Seeded map: archetype layout, modifiers, spawn pads, designed ramps, rocks.
 * `archetypeId` overrides the seed's own choice; `variant` re-rolls the layout for
 * repair while keeping the public seed and archetype. */
export function generateTerrain(tuning: TuningValues, seed: number, archetypeId?: string, variant = 0) {
  const start = performance.now(), w = tuning.halfWidth, d = tuning.halfDepth;
  const archetype = (archetypeId ? archetypeById(archetypeId) : undefined) ?? pickArchetype(seed);
  const stream = variant ? (Math.imul((seed >>> 0) ^ 0x27d4eb2f, 2 * variant + 1) >>> 0) : seed >>> 0;
  const rng = random(stream), terrain = new Terrain(w, d, seed >>> 0), bounds = deploymentBounds(tuning);
  const ctx: GenerationContext = { w, d, H: clamp(Math.min(w, d) * 0.45, 3, 13), rng, noise: new Noise(rng), detail: new Noise(random(stream ^ 0x5bd1e995)), ...bounds, radius: tuning.radius };
  const plan = archetype.build(ctx);
  const spire = plan.defender < 0 && archetype.id !== 'ice' && rng() < 0.3 ? spires(ctx, 1 + Math.floor(rng() * 3)) : null;
  const base = plan.defender < 0 ? mirrored(ctx, plan.height) : plan.height;
  const surface = spire ? (x: number, z: number) => base(x, z) + spire(x, z) : base, stride = terrain.columns + 1;
  for (let r = 0; r <= terrain.rows; r++) for (let c = 0; c <= terrain.columns; c++) terrain.heights[r * stride + c] = surface(-w + c * terrain.dx, -d + r * terrain.dz);

  // Spawn pads: flat at the archetype's height, or a gently tilted plane fitted to the raw surface.
  for (let team = 0; team < 2; team++) {
    let n = 0, mx = 0, mz = 0, mh = 0, sxh = 0, szh = 0, sxx = 0, szz = 0;
    for (let r = 0; r <= terrain.rows; r++) for (let c = 0; c <= terrain.columns; c++) {
      const x = -w + c * terrain.dx, z = -d + r * terrain.dz;
      if (padDistance(x, z, team, bounds) > 0) continue;
      const h = terrain.heights[r * stride + c]; n++; mx += x; mz += z; mh += h; sxh += x * h; szh += z * h; sxx += x * x; szz += z * z;
    }
    if (!n) continue;
    mx /= n; mz /= n; mh /= n;
    const vx = sxx / n - mx * mx, vz = szz / n - mz * mz, target = plan.pads[team];
    let bx = target === null && vx > 1e-6 ? (sxh / n - mx * mh) / vx : 0, bz = target === null && vz > 1e-6 ? (szh / n - mz * mh) / vz : 0;
    const tilt = Math.hypot(bx, bz), limit = 0.3; if (tilt > limit) { bx *= limit / tilt; bz *= limit / tilt; }
    const level = target ?? mh; terrain.pads[team] = level;
    for (let r = 0; r <= terrain.rows; r++) for (let c = 0; c <= terrain.columns; c++) {
      const x = -w + c * terrain.dx, z = -d + r * terrain.dz, distance = padDistance(x, z, team, bounds);
      if (distance >= plan.padBlend) continue;
      const index = r * stride + c, pad = level + bx * (x - mx) + bz * (z - mz) + ctx.detail.fbm(x * 0.3, z * 0.3, 2) * 0.05;
      terrain.heights[index] = lerp(terrain.heights[index], pad, 1 - smooth(distance / plan.padBlend));
    }
  }

  // Designed ramps; skip any that would run through the middle of a deployment.
  for (const ramp of plan.ramps) {
    const length = polylineLength(ramp.points), n = Math.max(2, Math.ceil(length / 0.5)), samples = resample(ramp.points, n);
    let crosses = false;
    for (let i = 0; i < n && !crosses; i++) { const s = length * i / (n - 1); if (s > 2 && s < length - 2 && padClearance(samples[i * 2], samples[i * 2 + 1], bounds) < ramp.halfWidth + 1) crosses = true; }
    if (crosses) continue;
    carveRamp(terrain, ramp.points, ramp.halfWidth, 0.5, 2, padGuard(bounds));
    terrain.ramps.push({ points: ramp.points, halfWidth: ramp.halfWidth, repair: false });
  }
  terrain.features.push(...plan.features);
  terrain.archetype = archetype.id; terrain.name = archetype.name; terrain.region = archetype.regions[Math.floor(rng() * archetype.regions.length)];
  terrain.palette = archetype.palette; terrain.defender = plan.defender;
  terrain.rebuild();
  placeRocks(terrain, plan.rocks, rng, bounds);
  terrain.rebuild(); terrain.generationMs = performance.now() - start;
  return terrain;
}

function placeRocks(terrain: Terrain, style: { density: number; radius: [number, number]; height: [number, number]; clusters: number }, rng: () => number, bounds: DeploymentBounds) {
  const w = terrain.halfWidth, d = terrain.halfDepth, count = Math.min(220, Math.floor(w * d / 23 * style.density)), rocks = terrain.rocks;
  for (let attempt = 0; rocks.length < count && attempt < count * 30; attempt++) {
    let x: number, z: number;
    if (rocks.length && rng() < style.clusters) {
      const b = rocks[Math.floor(rng() * rocks.length)], a = rng() * Math.PI * 2, r = b.radius + 1.2 + rng() * 2.2;
      x = b.x + Math.cos(a) * r; z = b.z + Math.sin(a) * r;
    } else { x = (rng() * 2 - 1) * (w - 1.5); z = (rng() * 2 - 1) * (d - 1.5); }
    let radius = lerp(style.radius[0], style.radius[1], rng());
    if (rng() < 0.06) radius = Math.min(2, radius * 1.7);
    const height = lerp(style.height[0], style.height[1], rng()) * (radius > 1.3 ? 1.3 : 1);
    if (Math.abs(x) > w - 1.5 || Math.abs(z) > d - 1.5 || padClearance(x, z, bounds) < 1.5 + radius || terrain.slopeAt(x, z) > 0.45) continue;
    if (terrain.ramps.some(p => polylineDistance(p.points, x, z) < p.halfWidth + radius + 0.7)) continue;
    if (terrain.features.some(f => f.climbable && Math.hypot(x - f.x, z - f.z) < radius + 1.8)) continue;
    if (rocks.some(b => Math.hypot(x - b.x, z - b.z) < radius + b.radius + 0.9)) continue;
    rocks.push({ x, z, radius, base: terrain.heightAt(x, z) - 0.22, height, angle: rng() * Math.PI });
  }
}
