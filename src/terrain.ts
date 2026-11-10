import { random } from './random.ts';
import type { TuningValues } from './tuning.ts';

export interface Rock { x: number; z: number; radius: number; base: number; height: number; angle: number }
export interface Landform { kind: 'basin' | 'hill' | 'mesa' | 'ridge'; x: number; z: number; rx: number; rz: number; height: number }
const smooth = (v: number) => { const t = Math.max(0, Math.min(1, v)); return t * t * (3 - 2 * t); };
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
  readonly halfWidth: number;
  readonly halfDepth: number;
  readonly seed: number;
  readonly rocks: Rock[];
  readonly features: Landform[];

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
  canStand(x: number, z: number, radius: number) {
    if (Math.abs(x) > this.halfWidth - radius || Math.abs(z) > this.halfDepth - radius) return false;
    if (this.slopeAt(x, z) > MAX_SLOPE || this.slopeAt(x - radius, z) > MAX_SLOPE || this.slopeAt(x + radius, z) > MAX_SLOPE
      || this.slopeAt(x, z - radius) > MAX_SLOPE || this.slopeAt(x, z + radius) > MAX_SLOPE) return false;
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

export function generateTerrain(tuning: TuningValues, seed: number) {
  const start = performance.now(), rng = random(seed), w = tuning.halfWidth, d = tuning.halfDepth;
  const terrain = new Terrain(w, d, seed >>> 0), columns = Math.min(tuning.columns, tuning.count), rows = Math.ceil(tuning.count / columns);
  const spawnX = (columns - 1) / 2 * tuning.columnSpacing + tuning.jitterX + tuning.radius + 0.9;
  const spawnNear = tuning.frontline - tuning.radius - 0.9, spawnFar = tuning.frontline + (rows - 1) * tuning.rowSpacing + tuning.jitterZ + tuning.radius + 0.9;
  const safe = (x: number, z: number) => smooth(Math.max(Math.abs(x) - spawnX, spawnNear - Math.abs(z), Math.abs(z) - spawnFar) / 1.8);
  const span = Math.min(w, d), features = terrain.features;
  features.push({ kind: 'ridge', x: 0, z: (rng() - 0.5) * Math.min(5, tuning.frontline * 0.5), rx: w * 1.3, rz: Math.min(4.2, span * 0.34), height: Math.min(3.7, span * 0.3) });
  features.push({ kind: 'basin', x: -w * (0.22 + rng() * 0.25), z: (rng() - 0.5) * d * 0.5, rx: span * 0.33, rz: span * 0.36, height: -Math.min(2, span * 0.17) });
  features.push({ kind: 'hill', x: w * (0.2 + rng() * 0.2), z: -d * (0.12 + rng() * 0.18), rx: span * 0.4, rz: span * 0.45, height: Math.min(2.7, span * 0.23) });
  for (let i = 0; i < 3; i++) features.push({ kind: 'mesa', x: (i % 2 ? -1 : 1) * Math.min(w - Math.min(3.5, span * 0.24) - 0.8, Math.max(spawnX + 4, w * (0.58 + rng() * 0.15))), z: (i % 2 ? -1 : 1) * d * (0.36 + rng() * 0.12), rx: Math.min(3.5, span * 0.24), rz: Math.min(5.5, span * 0.38), height: Math.min(2.8, span * 0.24) });
  const pass1 = -w * (0.25 + rng() * 0.15), pass2 = w * (0.25 + rng() * 0.15), passWidth = Math.max(2, tuning.radius * 6);
  for (let r = 0; r <= terrain.rows; r++) for (let c = 0; c <= terrain.columns; c++) {
    const x = -w + c * terrain.dx, z = -d + r * terrain.dz;
    let y = 0.12 * Math.sin(x * 0.29 + rng() * 0.08) * Math.cos(z * 0.23);
    for (const f of features) {
      if (f.kind === 'ridge') {
        const center = f.z + Math.sin(x / w * 3 + seed % 7) * Math.min(2.4, d * 0.15);
        const profile = smooth(1 - Math.abs(z - center) / f.rz);
        const gap = smooth(Math.min(Math.abs(x - pass1), Math.abs(x - pass2)) / passWidth);
        y += f.height * profile * (0.12 + 0.88 * gap);
      } else {
        const qx = Math.abs((x - f.x) / f.rx), qz = Math.abs((z - f.z) / f.rz);
        const shape = f.kind === 'mesa' ? smooth((1 - qx) * 5) * smooth(1 - qz) : smooth(1 - Math.hypot(qx, qz));
        if (f.kind === 'mesa') { if (shape > 0) y = Math.max(y, f.height * shape); }
        else y += f.height * shape;
      }
    }
    // Broad protected shoulders connect the deployments to the middle.
    terrain.heights[r * (terrain.columns + 1) + c] = y * safe(x, z);
  }
  terrain.rebuild();
  const count = Math.min(62, Math.floor(w * d / 23));
  for (let attempt = 0; terrain.rocks.length < count && attempt < count * 30; attempt++) {
    const x = (rng() * 2 - 1) * (w - 1.5), z = (rng() * 2 - 1) * (d - 1.5), radius = 0.42 + rng() * 0.65;
    if (safe(x, z) < 0.99 || Math.min(Math.abs(x - pass1), Math.abs(x - pass2)) < passWidth + radius + 0.7 || terrain.slopeAt(x, z) > 0.45) continue;
    if (features.some(f => f.kind === 'mesa' && Math.hypot(x - f.x, z - f.z) < radius + 1.8)) continue;
    if (terrain.rocks.some(b => Math.hypot(x - b.x, z - b.z) < radius + b.radius + 1.4)) continue;
    terrain.rocks.push({ x, z, radius, base: terrain.heightAt(x, z) - 0.22, height: 0.95 + rng() * 1.15, angle: rng() * Math.PI });
  }
  terrain.rebuild(); terrain.generationMs = performance.now() - start;
  return terrain;
}
