import { Terrain, carveRamp, deploymentBounds, generateTerrain, padClearance, padGuard, type DeploymentBounds } from './terrain.ts';
import { clamp, polylineDistance } from './terrain-shapes.ts';
import type { TuningValues } from './tuning.ts';

const DX = [1, 0, -1, 0, 1, -1, -1, 1], DZ = [0, 1, 0, -1, 1, 1, -1, -1];
/** Indexed decrease-key heap: fixed capacity and no allocations while searching. */
class Heap {
  readonly nodes: Int32Array;
  readonly positions: Int32Array;
  length = 0;
  readonly scores: Float32Array;
  constructor(scores: Float32Array) { this.scores = scores; this.nodes = new Int32Array(scores.length); this.positions = new Int32Array(scores.length).fill(-1); }
  clear() { this.length = 0; this.positions.fill(-1); }
  push(node: number) {
    let p = this.positions[node];
    if (p < 0) { p = this.length++; this.nodes[p] = node; }
    while (p > 0) { const up = (p - 1) >> 1, other = this.nodes[up]; if (this.scores[other] <= this.scores[node]) break; this.nodes[p] = other; this.positions[other] = p; p = up; }
    this.nodes[p] = node; this.positions[node] = p;
  }
  pop() {
    const result = this.nodes[0], last = this.nodes[--this.length]; this.positions[result] = -1;
    if (this.length) {
      let p = 0;
      while (p * 2 + 1 < this.length) {
        let child = p * 2 + 1;
        if (child + 1 < this.length && this.scores[this.nodes[child + 1]] < this.scores[this.nodes[child]]) child++;
        if (this.scores[last] <= this.scores[this.nodes[child]]) break;
        this.nodes[p] = this.nodes[child]; this.positions[this.nodes[p]] = p; p = child;
      }
      this.nodes[p] = last; this.positions[last] = p;
    }
    return result;
  }
}
/** Field cost multiplier rises from 1 in the open to 1 + NARROW_PENALTY in a one-cell slot. */
const OPEN_CLEARANCE = 2.6, NARROW_PENALTY = 4;
/** Clearance an army approach must keep end to end (distance from a cell centre to the nearest blocked cell). */
export const WIDE_CLEARANCE = 1.25;
/** Friendly density (soldiers per cell, 3x3-averaged) where the congestion cost starts and where it saturates.
 * The starting formation sits just under the start; a jammed crowd reaches the full cost. */
const CONGESTION_START = 0.5, CONGESTION_FULL = 1.4;
/** Chamfer distance from each cell to the nearest blocked cell or map edge. */
function clearanceMap(walkable: Uint8Array, columns: number, rows: number, dx: number, dz: number) {
  const size = columns * rows, d = new Float32Array(size), diagonal = Math.hypot(dx, dz);
  for (let n = 0; n < size; n++) d[n] = walkable[n] ? Infinity : 0;
  const at = (c: number, r: number) => c < 0 || r < 0 || c >= columns || r >= rows ? 0 : d[r * columns + c];
  for (let r = 0; r < rows; r++) for (let c = 0; c < columns; c++) {
    const n = r * columns + c; if (!d[n]) continue;
    d[n] = Math.min(d[n], at(c - 1, r) + dx, at(c, r - 1) + dz, at(c - 1, r - 1) + diagonal, at(c + 1, r - 1) + diagonal);
  }
  for (let r = rows - 1; r >= 0; r--) for (let c = columns - 1; c >= 0; c--) {
    const n = r * columns + c; if (!d[n]) continue;
    d[n] = Math.min(d[n], at(c + 1, r) + dx, at(c, r + 1) + dz, at(c + 1, r + 1) + diagonal, at(c - 1, r + 1) + diagonal);
  }
  return d;
}

class FlowField {
  readonly distance: Float32Array;
  readonly pending: Float32Array;
  readonly heap: Heap;
  /** Extra cost multiplier per node from friendly crowding, snapshotted when the build begins. */
  readonly congestion: Float32Array;
  ready = false;
  building = false;
  constructor(size: number) { this.distance = new Float32Array(size).fill(Infinity); this.pending = new Float32Array(size).fill(Infinity); this.heap = new Heap(this.pending); this.congestion = new Float32Array(size); }
}

/** Static clearance graph + two shared, incrementally rebuilt multi-source fields.
 * Soldiers are handled by local collision; they never invalidate this graph. */
export class Navigation {
  readonly walkable: Uint8Array;
  readonly edges: Uint8Array;
  readonly regions: Int32Array;
  readonly fields: FlowField[];
  readonly queue: Int32Array;
  readonly offsets: number[];
  readonly costs: number[];
  readonly elevation: Float32Array;
  /** Field cost multiplier per node: >1 in narrow slots so whole armies prefer wide approaches. */
  readonly crowding: Float32Array;
  readonly clearance: Float32Array;
  readonly terrain: Terrain;
  readonly radius: number;
  regionCount = 0;
  buildMs = 0;
  expansions = 0;
  totalExpansions = 0;
  directionX = 0;
  directionZ = 0;
  // A* scratch is reserved once for exceptional routes and deterministic fixtures.
  private readonly pathScore: Float32Array;
  private readonly pathPriority: Float32Array;
  private readonly pathParent: Int32Array;
  private readonly pathHeap: Heap;
  private readonly occupancy: Float32Array;
  private readonly blur: Float32Array;
  constructor(terrain: Terrain, radius: number) {
    this.terrain = terrain; this.radius = radius;
    const start = performance.now(), size = terrain.columns * terrain.rows;
    this.walkable = new Uint8Array(size); this.edges = new Uint8Array(size); this.regions = new Int32Array(size).fill(-1); this.queue = new Int32Array(size);
    this.offsets = DX.map((x, i) => x + DZ[i] * terrain.columns);
    this.elevation = new Float32Array(size);
    this.costs = DX.map((x, i) => Math.hypot(x * terrain.dx, DZ[i] * terrain.dz));
    this.fields = [new FlowField(size), new FlowField(size)];
    this.pathScore = new Float32Array(size); this.pathPriority = new Float32Array(size); this.pathParent = new Int32Array(size); this.pathHeap = new Heap(this.pathPriority);
    this.occupancy = new Float32Array(size); this.blur = new Float32Array(size);
    for (let node = 0; node < size; node++) { this.walkable[node] = +terrain.canStand(this.x(node), this.z(node), radius + 0.035); this.elevation[node] = terrain.heightAt(this.x(node), this.z(node)); }
    for (let node = 0; node < size; node++) if (this.walkable[node]) {
      const c = node % terrain.columns, r = Math.floor(node / terrain.columns), x = this.x(node), z = this.z(node);
      for (const dir of [0, 1, 4, 5]) {
        if (c + DX[dir] < 0 || c + DX[dir] >= terrain.columns || r + DZ[dir] < 0 || r + DZ[dir] >= terrain.rows) continue;
        const next = node + this.offsets[dir];
        if (!this.walkable[next]) continue;
        if (dir >= 4 && (!this.walkable[node + DX[dir]] || !this.walkable[node + DZ[dir] * terrain.columns])) continue;
        if (terrain.canTraverse(x, z, this.x(next), this.z(next), radius + 0.02)) {
          this.edges[node] |= 1 << dir;
          this.edges[next] |= 1 << (dir < 4 ? (dir + 2) % 4 : 4 + (dir - 4 + 2) % 4);
        }
      }
    }
    for (let node = 0; node < size; node++) if (this.walkable[node] && this.regions[node] < 0) {
      let head = 0, tail = 0; this.queue[tail++] = node; this.regions[node] = this.regionCount;
      while (head < tail) { const current = this.queue[head++]; for (let dir = 0; dir < 8; dir++) if (this.edges[current] & 1 << dir) { const next = current + this.offsets[dir]; if (this.regions[next] < 0) { this.regions[next] = this.regionCount; this.queue[tail++] = next; } } }
      this.regionCount++;
    }
    this.clearance = clearanceMap(this.walkable, terrain.columns, terrain.rows, terrain.dx, terrain.dz);
    this.crowding = this.clearance.map(d => { const t = Math.max(0, 1 - d / OPEN_CLEARANCE); return 1 + NARROW_PENALTY * t * t; });
    this.buildMs = performance.now() - start;
  }
  x(node: number) { return -this.terrain.halfWidth + (node % this.terrain.columns + 0.5) * this.terrain.dx; }
  z(node: number) { return -this.terrain.halfDepth + (Math.floor(node / this.terrain.columns) + 0.5) * this.terrain.dz; }
  nodeAt(x: number, z: number) {
    const node = this.terrain.cell(x, z);
    if (this.walkable[node] && this.terrain.canTraverse(x, z, this.x(node), this.z(node), this.radius)) return node;
    const c = node % this.terrain.columns, r = Math.floor(node / this.terrain.columns);
    for (let ring = 1; ring <= 3; ring++) for (let rz = Math.max(0, r - ring); rz <= Math.min(this.terrain.rows - 1, r + ring); rz++) for (let cx = Math.max(0, c - ring); cx <= Math.min(this.terrain.columns - 1, c + ring); cx++) {
      const n = rz * this.terrain.columns + cx;
      if (this.walkable[n] && this.terrain.canTraverse(x, z, this.x(n), this.z(n), this.radius)) return n;
    }
    return -1;
  }
  /**
   * Starts an incremental rebuild toward `goals`. Optional `occupants` (cells of the team that will follow
   * this field) add a congestion cost so overflow spreads onto alternate routes instead of piling into one lane.
   */
  beginField(team: number, goals: Int32Array, length: number, occupants?: Int32Array, occupantCount = 0, weight = 0) {
    const f = this.fields[team]; if (f.building) return;
    this.computeCongestion(f.congestion, occupants, occupantCount, weight);
    f.pending.fill(Infinity); f.heap.clear();
    for (let i = 0; i < length; i++) { const node = goals[i]; if (node >= 0 && this.walkable[node] && f.pending[node] !== 0) { f.pending[node] = 0; f.heap.push(node); } }
    f.building = f.heap.length > 0;
  }
  private computeCongestion(out: Float32Array, occupants: Int32Array | undefined, count: number, weight: number) {
    out.fill(0);
    if (!occupants || count <= 0 || weight <= 0) return;
    const columns = this.terrain.columns, rows = this.terrain.rows, occ = this.occupancy, blur = this.blur;
    occ.fill(0);
    for (let i = 0; i < count; i++) { const node = occupants[i]; if (node >= 0) occ[node]++; }
    // Separable 3x3 box average: per-cell counts are too noisy to route around.
    for (let r = 0; r < rows; r++) {
      const row = r * columns;
      for (let c = 0; c < columns; c++) blur[row + c] = (c > 0 ? occ[row + c - 1] : 0) + occ[row + c] + (c + 1 < columns ? occ[row + c + 1] : 0);
    }
    const span = CONGESTION_FULL - CONGESTION_START;
    for (let r = 0; r < rows; r++) for (let c = 0; c < columns; c++) {
      const n = r * columns + c, density = ((r > 0 ? blur[n - columns] : 0) + blur[n] + (r + 1 < rows ? blur[n + columns] : 0)) / 9;
      out[n] = density > CONGESTION_START ? weight * Math.min(1, (density - CONGESTION_START) / span) : 0;
    }
  }
  advance(budget = 1024) {
    this.expansions = 0;
    for (let turn = 0; turn < budget; turn++) {
      const f = this.fields[turn & 1].building ? this.fields[turn & 1] : this.fields[1 - (turn & 1)];
      if (!f.building) break;
      const node = f.heap.pop(); this.expansions++;
      for (let dir = 0; dir < 8; dir++) if (this.edges[node] & 1 << dir) {
        const next = node + this.offsets[dir], cost = f.pending[node] + this.costs[dir] * (this.crowding[next] + f.congestion[next]) + Math.abs(this.elevation[node] - this.elevation[next]) * 0.25;
        if (cost < f.pending[next] - 1e-5) { f.pending[next] = cost; f.heap.push(next); }
      }
      if (!f.heap.length) { f.distance.set(f.pending); f.ready = true; f.building = false; }
    }
    this.totalExpansions += this.expansions;
  }
  direction(team: number, x: number, z: number) {
    const node = this.terrain.cell(x, z), f = this.fields[team];
    this.directionX = this.directionZ = 0;
    if (!f.ready) return false;
    if (!this.walkable[node]) {
      const legal = this.nodeAt(x, z);
      if (legal < 0) return false;
      this.directionX = this.x(legal) - x; this.directionZ = this.z(legal) - z;
      return Math.hypot(this.directionX, this.directionZ) > 1e-6;
    }
    let best = node, score = f.distance[node];
    for (let dir = 0; dir < 8; dir++) if (this.edges[node] & 1 << dir) {
      const next = node + this.offsets[dir];
      if (f.distance[next] < score - 1e-5) { score = f.distance[next]; best = next; }
    }
    if (best === node) return false;
    this.directionX = this.x(best) - x; this.directionZ = this.z(best) - z;
    return true;
  }
  /** Bounded A* for diagnostic/exceptional point routes; shared fields handle the army. */
  findPath(x: number, z: number, tx: number, tz: number, budget = 12000): number[] | null {
    const start = this.nodeAt(x, z), goal = this.nodeAt(tx, tz);
    if (start < 0 || goal < 0 || this.regions[start] !== this.regions[goal]) return null;
    this.pathScore.fill(Infinity); this.pathParent.fill(-1); this.pathPriority.fill(Infinity); this.pathHeap.clear();
    this.pathScore[start] = this.pathPriority[start] = 0; this.pathHeap.push(start);
    while (this.pathHeap.length && budget-- > 0) {
      const node = this.pathHeap.pop();
      if (node === goal) { const path: number[] = []; for (let n = goal; n >= 0; n = this.pathParent[n]) path.push(n); return path.reverse(); }
      for (let dir = 0; dir < 8; dir++) if (this.edges[node] & 1 << dir) {
        const next = node + this.offsets[dir], cost = this.pathScore[node] + this.costs[dir];
        if (cost < this.pathScore[next] - 1e-5) { this.pathParent[next] = node; this.pathScore[next] = cost; this.pathPriority[next] = cost + Math.hypot(this.x(next) - tx, this.z(next) - tz); this.pathHeap.push(next); }
      }
    }
    return null;
  }
}

/** Points every map must connect: both deployment fronts and each climbable top. */
function requirements(terrain: Terrain, tuning: TuningValues) {
  const points: [number, number][] = [[0, tuning.frontline], [0, -tuning.frontline]];
  for (const f of terrain.features) if (f.climbable && Math.abs(f.x) < terrain.halfWidth - 1 && Math.abs(f.z) < terrain.halfDepth - 1) points.push([f.x, f.z]);
  return points;
}
/** Requirements outside the main region, one per foreign region: empty when connected, `undefined` when the front itself is unusable. */
function missing(navigation: Navigation, points: [number, number][]) {
  const origin = navigation.nodeAt(points[0][0], points[0][1]);
  if (origin < 0) return undefined;
  const gaps: { x: number; z: number }[] = [], seen = new Set<number>();
  for (const [x, z] of points) {
    const n = navigation.nodeAt(x, z), region = n < 0 ? -1 - navigation.terrain.cell(x, z) : navigation.regions[n];
    if (region !== navigation.regions[origin] && !seen.has(region)) { seen.add(region); gaps.push({ x, z }); }
  }
  return { origin, gaps };
}

const regionMask = (navigation: Navigation, origin: number) => navigation.regions.map(r => +(r === navigation.regions[origin])) as unknown as Uint8Array;
/** Cells reachable from `origin` through ground with WIDE_CLEARANCE, or null when `goal` is among them. */
function wideReach(navigation: Navigation, origin: number, goal: number) {
  const size = navigation.walkable.length, mask = new Uint8Array(size), queue = navigation.queue, wide = (n: number) => navigation.clearance[n] >= WIDE_CLEARANCE;
  if (!wide(origin)) return mask;
  let head = 0, tail = 0; queue[tail++] = origin; mask[origin] = 1;
  while (head < tail) {
    const node = queue[head++]; if (node === goal) return null;
    for (let dir = 0; dir < 8; dir++) if (navigation.edges[node] & 1 << dir) { const next = node + navigation.offsets[dir]; if (!mask[next] && wide(next)) { mask[next] = 1; queue[tail++] = next; } }
  }
  return mask;
}

/** Cheapest place to cut a walkway from the main region to (tx, tz): Dijkstra
 * over every cell, where steep steps cost in proportion to the excess climb. */
function cheapestCut(navigation: Navigation, source: Uint8Array, tx: number, tz: number, halfWidth: number, bounds: DeploymentBounds) {
  const terrain = navigation.terrain, size = terrain.columns * terrain.rows, goal = terrain.cell(tx, tz);
  const score = new Float32Array(size).fill(Infinity), parent = new Int32Array(size).fill(-1), heap = new Heap(score), height = navigation.elevation;
  for (let n = 0; n < size; n++) if (source[n]) { score[n] = 0; heap.push(n); }
  const edgeX = terrain.halfWidth - halfWidth - 0.6, edgeZ = terrain.halfDepth - halfWidth - 0.6;
  while (heap.length) {
    const node = heap.pop();
    if (node === goal) break;
    const c = node % terrain.columns, r = Math.floor(node / terrain.columns);
    for (let dir = 0; dir < 8; dir++) {
      const nc = c + DX[dir], nr = r + DZ[dir];
      if (nc < 0 || nc >= terrain.columns || nr < 0 || nr >= terrain.rows) continue;
      const next = node + navigation.offsets[dir], length = navigation.costs[dir], climb = Math.abs(height[next] - height[node]);
      const x = navigation.x(next), z = navigation.z(next), edge = (Math.abs(x) > edgeX || Math.abs(z) > edgeZ ? 3 * length : 0) + (padClearance(x, z, bounds) < halfWidth ? 2 * length : 0);
      const cost = score[node] + length + 25 * Math.max(0, climb - 0.45 * length) + (navigation.walkable[next] ? 0 : 0.3 * length) + edge;
      if (cost < score[next] - 1e-5) { score[next] = cost; parent[next] = node; heap.push(next); }
    }
  }
  if (parent[goal] < 0 && !source[goal]) return null;
  const cells: number[] = [];
  for (let n = goal; n >= 0; n = parent[n]) cells.push(n);
  cells.reverse();
  // End at the edge of a deployment pad, which is already level: the guard keeps carving out of pads.
  const inPad = (n: number) => padClearance(navigation.x(n), navigation.z(n), bounds) < 0.4;
  while (cells.length > 2 && inPad(cells[cells.length - 1]) && inPad(cells[cells.length - 2])) cells.pop();
  while (cells.length > 2 && inPad(cells[0]) && inPad(cells[1])) cells.shift();
  // Thin and smooth the 8-way staircase into a gentle polyline.
  const keep = cells.filter((_, i) => i % 3 === 0 || i === cells.length - 1);
  const raw = keep.map(n => [navigation.x(n), navigation.z(n)]);
  const smoothed = raw.map((p, i) => i === 0 || i === raw.length - 1 ? p : [(raw[i - 1][0] + 2 * p[0] + raw[i + 1][0]) / 4, (raw[i - 1][1] + 2 * p[1] + raw[i + 1][1]) / 4]);
  if (smoothed.length === 1) smoothed.push([smoothed[0][0] + 0.01, smoothed[0][1]]);
  // A climb steeper than the ramp grade needs a longer run: extend the low and high ends straight out.
  const grade = 0.5, start = smoothed[0], end = smoothed[smoothed.length - 1];
  let length = 0; for (let i = 1; i < smoothed.length; i++) length += Math.hypot(smoothed[i][0] - smoothed[i - 1][0], smoothed[i][1] - smoothed[i - 1][1]);
  const need = Math.abs(terrain.heightAt(end[0], end[1]) - terrain.heightAt(start[0], start[1])) / (grade * 0.9) - length;
  const extend = (from: number[], toward: number[], amount: number) => {
    const dx = from[0] - toward[0], dz = from[1] - toward[1], l = Math.hypot(dx, dz) || 1;
    return [clamp(from[0] + dx / l * amount, -edgeX, edgeX), clamp(from[1] + dz / l * amount, -edgeZ, edgeZ)];
  };
  if (need > 0) {
    // Never push a ramp end into a deployment pad: give that share to the other end.
    const startFree = padClearance(start[0], start[1], bounds) > halfWidth, endFree = padClearance(end[0], end[1], bounds) > halfWidth;
    const share = startFree && endFree ? 0.6 : startFree ? 1 : endFree ? 0 : 0.5;
    if (share > 0) smoothed.unshift(extend(start, smoothed[1], need * share + 1));
    if (share < 1) smoothed.push(extend(end, smoothed[smoothed.length - 2], need * (1 - share) + 1));
  }
  return Float64Array.from(smoothed.flat());
}

/** Connectivity repair that keeps relief: carve graded ramps where the map is cut off,
 * then re-roll the layout (same seed and archetype) and only flatten as a last resort. */
export function prepareTerrain(tuning: TuningValues, seed: number, archetypeId?: string) {
  const halfWidth = Math.max(1.6, tuning.radius * 5), attempts = 6, bounds = deploymentBounds(tuning), guard = padGuard(bounds);
  for (let variant = 0; variant < 4; variant++) {
    const terrain = generateTerrain(tuning, seed, archetypeId, variant), points = requirements(terrain, tuning);
    terrain.repairs = variant;
    for (let attempt = 0; ; attempt++) {
      const navigation = new Navigation(terrain, tuning.radius), state = missing(navigation, points);
      if (!state) break;
      let paths: Float64Array[], width = halfWidth;
      if (!state.gaps.length) {
        // Connected; now make sure whole armies are not funnelled through a one-file slot.
        const other = navigation.nodeAt(points[1][0], points[1][1]), reach = other < 0 ? null : wideReach(navigation, state.origin, other);
        // Width repair is best effort: a connected map is kept rather than re-rolled.
        if (reach && attempt >= attempts - 2) (globalThis as { narrowMaps?: number }).narrowMaps = ((globalThis as { narrowMaps?: number }).narrowMaps ?? 0) + 1;
        if (!reach || attempt >= attempts - 2) { return { terrain, navigation }; }
        // Army approaches get a broader road than a connectivity link: unit radius eats into a cut's edges.
        width = halfWidth * 1.5;
        const path = cheapestCut(navigation, reach, points[1][0], points[1][1], width, bounds);
        paths = path ? [path] : [];
      } else {
        if (attempt === attempts) break;
        // One ramp per cut-off region per round; each round rebuilds navigation once.
        const source = regionMask(navigation, state.origin);
        paths = state.gaps.map(g => cheapestCut(navigation, source, g.x, g.z, halfWidth, bounds)).filter(p => p !== null);
      }
      if (!paths.length) break;
      for (const path of paths) {
        carveRamp(terrain, path, width, 0.5, 2, guard);
        for (let i = terrain.rocks.length - 1; i >= 0; i--) { const rock = terrain.rocks[i]; if (polylineDistance(path, rock.x, rock.z) < width + rock.radius + 0.6) terrain.rocks.splice(i, 1); }
        terrain.ramps.push({ points: path, halfWidth: width, repair: true }); terrain.repairs++;
      }
      for (const rock of terrain.rocks) rock.base = terrain.heightAt(rock.x, rock.z) - 0.22;
      terrain.rebuild();
    }
  }
  // Last-resort playable fallback: gentle relief and no solids. The corpus tests forbid it.
  const terrain = generateTerrain(tuning, seed, archetypeId);
  terrain.rocks.length = 0;
  for (let i = 0; i < terrain.heights.length; i++) terrain.heights[i] *= 0.1;
  terrain.repairs = 99; terrain.fallback = true; terrain.rebuild();
  const navigation = new Navigation(terrain, tuning.radius);
  if (missing(navigation, requirements(terrain, tuning))?.gaps.length !== 0) throw new Error('Terrain could not produce connected infantry approaches.');
  return { terrain, navigation };
}
