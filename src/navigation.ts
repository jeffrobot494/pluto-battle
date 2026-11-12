import { Terrain, carveRamp, deploymentBounds, generateTerrain, padClearance, padGuard, type DeploymentBounds } from './terrain.ts';
import { clamp, polylineDistance } from './terrain-shapes.ts';
import type { TuningValues } from './tuning.ts';

const DX = [1, 0, -1, 0, 1, -1, -1, 1], DZ = [0, 1, 0, -1, 1, 1, -1, -1];
/** Indexed decrease-key heap: fixed capacity and no allocations while searching. */
class Heap {
  readonly nodes: Int32Array;
  readonly positions: Int32Array;
  length = 0;
  /** Not readonly: a field publishing by buffer swap points its heap at the new back buffer. */
  scores: Float32Array;
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
/** Clearance an army approach must keep end to end (distance from a cell centre to the nearest blocked cell). */
export const WIDE_CLEARANCE = 1.25;
/** Friendly density (soldiers per cell, 3x3-averaged) where the congestion cost starts and where it saturates.
 * The starting formation sits just under the start; a jammed crowd reaches the full cost. */
const CONGESTION_START = 0.5, CONGESTION_FULL = 1.4;
/** Firing positions: enemies are bucketed into FIRE_BLOCK x FIRE_BLOCK cell blocks (one sight target each).
 * A cell with a shot at one is seeded at its straight-line distance + FIRE_SLACK, so it only beats walking
 * where the route is much longer than the shot (cliff tops, ledges, across gaps). FIRE_MARGIN keeps seeds
 * inside real range while enemies move between rebuilds; the profile's fireEye is the sight height. */
const FIRE_BLOCK = 4, FIRE_SLACK = 3, FIRE_MARGIN = 0.6;
/** A sight line is screened when it passes a cell next to a stationary friendly, ignoring this much at each end. */
const SCREEN_CLEAR = 0.9;
/** What one kind of mover can use: the graph predicates and the field's cost and seeding constants. */
export interface NavigationProfile {
  /** Whether a mover can stand on the cell centre (x, z). */
  stand(terrain: Terrain, x: number, z: number): boolean;
  /** Whether a mover can cross the edge between two usable cell centres. */
  traverse(terrain: Terrain, x: number, z: number, tx: number, tz: number): boolean;
  /** Whether a mover at an arbitrary point (x, z) can reach the usable cell centre (tx, tz). Used by `nodeAt`. */
  snap(terrain: Terrain, x: number, z: number, tx: number, tz: number): boolean;
  /** Mover radius, for callers and diagnostics. */
  radius: number;
  /** Field cost multiplier rises from 1 at `openClearance` or more to 1 + `narrowPenalty` in a one-cell slot. */
  openClearance: number;
  narrowPenalty: number;
  /** Extra field cost per unit of height change along an edge. */
  elevationCost: number;
  /** Sight height above the ground at firing positions and their targets. */
  fireEye: number;
  /** Per-tick work cap for the seeding phase (shared by both fields): sight rays, and candidate cells visited. */
  fireRaysPerTick: number;
  fireCellsPerTick: number;
}

/** Soldiers: the predicates and constants infantry navigation has always used. */
export function infantryProfile(radius: number): NavigationProfile {
  return {
    stand: (terrain, x, z) => terrain.canStand(x, z, radius + 0.035),
    traverse: (terrain, x, z, tx, tz) => terrain.canTraverse(x, z, tx, tz, radius + 0.02),
    snap: (terrain, x, z, tx, tz) => terrain.canTraverse(x, z, tx, tz, radius),
    radius, openClearance: 2.6, narrowPenalty: 4, elevationCost: 0.25,
    fireEye: 0.7, fireRaysPerTick: 160, fireCellsPerTick: 1200,
  };
}

class FlowField {
  /** The published field (front buffer). Swapped with `pending` on publish, never copied. */
  distance: Float32Array;
  /** The field being built (back buffer), and the heap's scores. */
  pending: Float32Array;
  readonly heap: Heap;
  /** Extra cost multiplier per node from friendly crowding, snapshotted when the build begins. */
  readonly congestion: Float32Array;
  /** Build number in which each node was last seeded as a firing position. */
  readonly firing: Uint32Array;
  /** 1 where a stationary friendly stands in the 3x3 neighbourhood: shots through here would hit our own line. */
  readonly screen: Uint8Array;
  build = 0;
  firingSeeds = 0;
  /** Seeding phase state: sight targets (one goal cell per block) and the cells still to test, in order. */
  readonly reps: Int32Array;
  readonly candidates: Int32Array;
  repCount = 0;
  candidateCount = 0;
  cursor = 0;
  range2 = 0;
  /** True while firing positions are still being seeded; the Dijkstra sweep waits until they are all in. */
  seeding = false;
  ready = false;
  building = false;
  /** Early stop (see `stopWhenSettled`): watched cells are stamped with the build number. */
  watchMark: Uint32Array | null = null;
  watchBuild = 0;
  watchLeft = 0;
  watchMax = 0;
  watchMargin = 0;
  watching = false;
  /** Whether the published field covers every reachable cell (false after an early stop). */
  complete = false;
  /** Builds that ended early, and cells settled by the last build (diagnostics). */
  earlyStops = 0;
  settled = 0;
  constructor(size: number, blocks: number) {
    this.distance = new Float32Array(size).fill(Infinity); this.pending = new Float32Array(size).fill(Infinity); this.heap = new Heap(this.pending);
    this.congestion = new Float32Array(size); this.firing = new Uint32Array(size); this.screen = new Uint8Array(size); this.reps = new Int32Array(blocks); this.candidates = new Int32Array(size);
  }
}

/** Build passes, in order. The first two run the profile's predicates; the rest are cheap array sweeps. */
const STAND = 0, EDGES = 1, REGIONS = 2, CLEAR_FORWARD = 3, CLEAR_BACKWARD = 4, BUILT = 5;
/** Cells of a cheap pass that cost one budget unit (one predicate cell). */
const CHEAP_CELLS = 16;

/** A graph build (stand tests, edge tests, regions, clearance and crowding), resumable on a work budget.
 * A budget unit is one cell of a predicate pass (a stand test, or up to four edge tests) or CHEAP_CELLS cells of
 * an array sweep. Budgets count cells, never time, so a build split across ticks finishes on the same tick every run,
 * and the result is the same however the work is split. */
export class NavigationBuild {
  readonly terrain: Terrain;
  readonly profile: NavigationProfile;
  readonly walkable: Uint8Array;
  readonly edges: Uint8Array;
  readonly elevation: Float32Array;
  readonly regions: Int32Array;
  readonly queue: Int32Array;
  /** Chamfer distance from each cell to the nearest blocked cell or map edge. */
  readonly clearance: Float32Array;
  /** Field cost multiplier per node: >1 in narrow slots so movers prefer wide approaches. */
  readonly crowding: Float32Array;
  readonly offsets: number[];
  regionCount = 0;
  /** Wall time spent in `step` (diagnostics only). */
  ms = 0;
  private pass = STAND;
  /** Next cell (or row, for the clearance passes) of the current pass. */
  private cursor = 0;
  private head = 0;
  private tail = 0;
  constructor(terrain: Terrain, profile: NavigationProfile) {
    this.terrain = terrain; this.profile = profile;
    const size = terrain.columns * terrain.rows;
    this.walkable = new Uint8Array(size); this.edges = new Uint8Array(size); this.elevation = new Float32Array(size);
    this.regions = new Int32Array(size).fill(-1); this.queue = new Int32Array(size);
    this.clearance = new Float32Array(size); this.crowding = new Float32Array(size);
    this.offsets = DX.map((x, i) => x + DZ[i] * terrain.columns);
  }
  get done() { return this.pass === BUILT; }
  /** Share of the build done, 0–1, weighted by budget units. */
  get progress() {
    const size = this.walkable.length, rows = this.terrain.rows, cheap = size / CHEAP_CELLS, total = 2 * size + 3 * cheap;
    const at = this.pass === STAND ? this.cursor : this.pass === EDGES ? size + this.cursor
      : this.pass === REGIONS ? 2 * size + this.cursor / CHEAP_CELLS
      : this.pass === CLEAR_FORWARD ? 2 * size + cheap + this.cursor / rows * cheap
      : this.pass === CLEAR_BACKWARD ? 2 * size + 2 * cheap + this.cursor / rows * cheap : total;
    return at / total;
  }
  /** Runs up to `budget` units of work; returns true once the build is complete. */
  step(budget = Infinity) {
    const start = performance.now();
    while (budget > 0 && this.pass !== BUILT) {
      if (this.pass === STAND) budget = this.stand(budget);
      else if (this.pass === EDGES) budget = this.link(budget);
      else if (this.pass === REGIONS) budget = this.label(budget * CHEAP_CELLS) / CHEAP_CELLS;
      else budget = this.clear(budget * CHEAP_CELLS) / CHEAP_CELLS;
    }
    this.ms += performance.now() - start;
    return this.done;
  }
  private x(n: number) { return -this.terrain.halfWidth + (n % this.terrain.columns + 0.5) * this.terrain.dx; }
  private z(n: number) { return -this.terrain.halfDepth + (Math.floor(n / this.terrain.columns) + 0.5) * this.terrain.dz; }
  private next() { this.pass++; this.cursor = 0; }
  private stand(budget: number) {
    const t = this.terrain, end = Math.min(this.walkable.length, this.cursor + budget);
    for (let node = this.cursor; node < end; node++) { this.walkable[node] = +this.profile.stand(t, this.x(node), this.z(node)); this.elevation[node] = t.heightAt(this.x(node), this.z(node)); }
    budget -= end - this.cursor; this.cursor = end;
    if (end === this.walkable.length) this.next();
    return budget;
  }
  private link(budget: number) {
    const t = this.terrain, columns = t.columns, end = Math.min(this.walkable.length, this.cursor + budget);
    for (let node = this.cursor; node < end; node++) if (this.walkable[node]) {
      const c = node % columns, r = Math.floor(node / columns), x = this.x(node), z = this.z(node);
      for (const dir of [0, 1, 4, 5]) {
        if (c + DX[dir] < 0 || c + DX[dir] >= columns || r + DZ[dir] < 0 || r + DZ[dir] >= t.rows) continue;
        const next = node + this.offsets[dir];
        if (!this.walkable[next]) continue;
        if (dir >= 4 && (!this.walkable[node + DX[dir]] || !this.walkable[node + DZ[dir] * columns])) continue;
        if (this.profile.traverse(t, x, z, this.x(next), this.z(next))) {
          this.edges[node] |= 1 << dir;
          this.edges[next] |= 1 << (dir < 4 ? (dir + 2) % 4 : 4 + (dir - 4 + 2) % 4);
        }
      }
    }
    budget -= end - this.cursor; this.cursor = end;
    if (end === this.walkable.length) this.next();
    return budget;
  }
  /** Breadth-first region labels in node order. A unit is one cell scanned or dequeued. */
  private label(cells: number) {
    const size = this.walkable.length, queue = this.queue, regions = this.regions, edges = this.edges;
    while (cells > 0) {
      if (this.head < this.tail) {
        const current = queue[this.head++]; cells--;
        for (let dir = 0; dir < 8; dir++) if (edges[current] & 1 << dir) { const next = current + this.offsets[dir]; if (regions[next] < 0) { regions[next] = this.regionCount; queue[this.tail++] = next; } }
        if (this.head === this.tail) this.regionCount++;
        continue;
      }
      if (this.cursor === size) { this.head = this.tail = 0; this.next(); break; }
      const node = this.cursor++; cells--;
      if (this.walkable[node] && regions[node] < 0) { this.head = this.tail = 0; queue[this.tail++] = node; regions[node] = this.regionCount; }
    }
    return cells;
  }
  /** Two-pass chamfer clearance, a row at a time; the backward pass also fills crowding. */
  private clear(cells: number) {
    const t = this.terrain, columns = t.columns, rows = t.rows, d = this.clearance, dx = t.dx, dz = t.dz, diagonal = Math.hypot(dx, dz);
    const at = (c: number, r: number) => c < 0 || r < 0 || c >= columns || r >= rows ? 0 : d[r * columns + c];
    const { openClearance, narrowPenalty } = this.profile;
    while (cells > 0 && this.pass !== BUILT) {
      if (this.pass === CLEAR_FORWARD) {
        const r = this.cursor;
        for (let c = 0; c < columns; c++) { const n = r * columns + c; d[n] = this.walkable[n] ? Infinity : 0; }
        for (let c = 0; c < columns; c++) {
          const n = r * columns + c; if (!d[n]) continue;
          d[n] = Math.min(d[n], at(c - 1, r) + dx, at(c, r - 1) + dz, at(c - 1, r - 1) + diagonal, at(c + 1, r - 1) + diagonal);
        }
      } else {
        const r = rows - 1 - this.cursor;
        for (let c = columns - 1; c >= 0; c--) {
          const n = r * columns + c; if (!d[n]) continue;
          d[n] = Math.min(d[n], at(c + 1, r) + dx, at(c, r + 1) + dz, at(c + 1, r + 1) + diagonal, at(c - 1, r + 1) + diagonal);
        }
        for (let c = 0; c < columns; c++) { const n = r * columns + c, k = Math.max(0, 1 - d[n] / openClearance); this.crowding[n] = 1 + narrowPenalty * k * k; }
      }
      cells -= columns;
      if (++this.cursor === rows) this.next();
    }
    return cells;
  }
}

/** Static clearance graph + two shared, incrementally rebuilt multi-source fields, for one mover profile.
 * Moving bodies are handled by local collision; they never invalidate this graph. */
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
  readonly profile: NavigationProfile;
  readonly radius: number;
  regionCount = 0;
  buildMs = 0;
  expansions = 0;
  totalExpansions = 0;
  directionX = 0;
  directionZ = 0;
  // A* scratch is allocated on the first findPath, for exceptional routes and deterministic fixtures.
  private pathScore: Float32Array | null = null;
  private pathPriority: Float32Array | null = null;
  private pathParent: Int32Array | null = null;
  private pathHeap: Heap | null = null;
  // Congestion scratch is allocated on the first field with occupants.
  private occupancy: Float32Array | null = null;
  private blur: Float32Array | null = null;
  // Firing-position gather scratch, stamped per query so nothing is cleared or allocated per rebuild.
  private readonly fireBlocks: Uint32Array;
  private readonly fireCells: Uint32Array;
  private fireQuery = 0;
  /** Running total of sight rays cast while seeding firing positions (diagnostics/benchmarks). */
  fireRays = 0;
  /** A number is an infantry radius. A finished `NavigationBuild` supplies the graph; otherwise one runs to completion here. */
  constructor(terrain: Terrain, profile: NavigationProfile | number, build?: NavigationBuild) {
    if (typeof profile === 'number') profile = infantryProfile(profile);
    if (build && (build.terrain !== terrain || build.profile !== profile || !build.done)) throw new Error('Navigation needs a finished build of the same terrain and profile.');
    this.terrain = terrain; this.profile = profile; this.radius = profile.radius;
    const start = performance.now(), size = terrain.columns * terrain.rows;
    const prebuilt = build?.ms ?? 0;
    if (!build) { build = new NavigationBuild(terrain, profile); build.step(); }
    this.walkable = build.walkable; this.edges = build.edges; this.elevation = build.elevation; this.offsets = build.offsets;
    this.regions = build.regions; this.queue = build.queue; this.regionCount = build.regionCount;
    this.clearance = build.clearance; this.crowding = build.crowding;
    this.costs = DX.map((x, i) => Math.hypot(x * terrain.dx, DZ[i] * terrain.dz));
    const blocks = Math.ceil(terrain.columns / FIRE_BLOCK) * Math.ceil(terrain.rows / FIRE_BLOCK);
    this.fields = [new FlowField(size, blocks), new FlowField(size, blocks)];
    this.fireBlocks = new Uint32Array(blocks); this.fireCells = new Uint32Array(size);
    // A build stepped across earlier ticks counts its own time too.
    this.buildMs = performance.now() - start + prebuilt;
  }
  x(node: number) { return -this.terrain.halfWidth + (node % this.terrain.columns + 0.5) * this.terrain.dx; }
  z(node: number) { return -this.terrain.halfDepth + (Math.floor(node / this.terrain.columns) + 0.5) * this.terrain.dz; }
  nodeAt(x: number, z: number) {
    const node = this.terrain.cell(x, z);
    if (this.walkable[node] && this.profile.snap(this.terrain, x, z, this.x(node), this.z(node))) return node;
    const c = node % this.terrain.columns, r = Math.floor(node / this.terrain.columns);
    for (let ring = 1; ring <= 3; ring++) for (let rz = Math.max(0, r - ring); rz <= Math.min(this.terrain.rows - 1, r + ring); rz++) for (let cx = Math.max(0, c - ring); cx <= Math.min(this.terrain.columns - 1, c + ring); cx++) {
      const n = rz * this.terrain.columns + cx;
      if (this.walkable[n] && this.profile.snap(this.terrain, x, z, this.x(n), this.z(n))) return n;
    }
    return -1;
  }
  /**
   * Starts an incremental rebuild toward `goals`. Optional `occupants` (cells of the team that will follow
   * this field) add a congestion cost so overflow spreads onto alternate routes instead of piling into one lane.
   * A positive `fireRange` also seeds cells that have a shot at the goals, so the field leads to vantage
   * points (e.g. a cliff overlooking the enemy) that have no short walking route to them.
   * Returns whether a new build started (false while the previous one is still running, or with no goals).
   */
  beginField(team: number, goals: Int32Array, length: number, occupants?: Int32Array, occupantCount = 0, weight = 0, fireRange = 0) {
    const f = this.fields[team]; if (f.building) return false;
    this.computeCongestion(f, occupants, occupantCount, weight);
    f.pending.fill(Infinity); f.heap.clear(); f.build++; f.firingSeeds = 0; f.candidateCount = f.cursor = 0; f.watching = false; f.settled = 0;
    for (let i = 0; i < length; i++) { const node = goals[i]; if (node >= 0 && this.walkable[node] && f.pending[node] !== 0) { f.pending[node] = 0; f.heap.push(node); } }
    f.building = f.heap.length > 0;
    if (fireRange > FIRE_MARGIN && f.building) this.gatherFiring(f, goals, length, fireRange - FIRE_MARGIN);
    f.seeding = f.candidateCount > 0;
    return f.building;
  }
  /**
   * Lets the build just begun for `team` stop early: once every walkable cell in `nodes` is settled and the next
   * cell would be more than `margin` beyond the farthest of them. Cells left unsettled publish as Infinity
   * (unknown); settled cells hold exactly what a full sweep would give. Unreachable watched cells keep the
   * sweep running to the end. Call right after `beginField`; it has no effect if that build did not start.
   */
  stopWhenSettled(team: number, nodes: Int32Array, count: number, margin: number) {
    const f = this.fields[team]; if (!f.building || f.watchBuild === f.build) return;
    f.watchBuild = f.build;
    const mark = f.watchMark ??= new Uint32Array(this.walkable.length);
    f.watchLeft = 0; f.watchMax = 0; f.watchMargin = margin;
    for (let i = 0; i < count; i++) { const node = nodes[i]; if (node >= 0 && this.walkable[node] && mark[node] !== f.build) { mark[node] = f.build; f.watchLeft++; } }
    f.watching = f.watchLeft > 0;
  }
  /** Picks one sight target per FIRE_BLOCK block of goals and lists the walkable cells within `range` of any. */
  private gatherFiring(f: FlowField, goals: Int32Array, length: number, range: number) {
    const t = this.terrain, columns = t.columns, rows = t.rows, blockColumns = Math.ceil(columns / FIRE_BLOCK);
    const reps = f.reps, blocks = this.fireBlocks, cells = this.fireCells, candidates = f.candidates;
    if (++this.fireQuery === 0xffffffff) { blocks.fill(0); cells.fill(0); this.fireQuery = 1; }
    const query = this.fireQuery;
    let repCount = 0, candidateCount = 0;
    for (let i = 0; i < length; i++) {
      const node = goals[i]; if (node < 0) continue;
      const c = node % columns, r = (node - c) / columns, block = Math.floor(r / FIRE_BLOCK) * blockColumns + Math.floor(c / FIRE_BLOCK);
      if (blocks[block] !== query) { blocks[block] = query; reps[repCount++] = node; }
    }
    const reachC = Math.ceil(range / t.dx), reachR = Math.ceil(range / t.dz);
    for (let k = 0; k < repCount; k++) {
      const node = reps[k], c = node % columns, r = (node - c) / columns;
      for (let rr = Math.max(0, r - reachR); rr <= Math.min(rows - 1, r + reachR); rr++) for (let cc = Math.max(0, c - reachC); cc <= Math.min(columns - 1, c + reachC); cc++) {
        const n = rr * columns + cc;
        if (cells[n] !== query && this.walkable[n] && f.pending[n] !== 0 && f.congestion[n] === 0) { cells[n] = query; candidates[candidateCount++] = n; }
      }
    }
    f.repCount = repCount; f.candidateCount = candidateCount; f.range2 = range * range;
  }
  /**
   * Seeds listed cells that have clear sight (eye to eye, within range in 3D) to one of their two nearest sight
   * targets, until the shared budgets run out; returns the rays left. Cells the previous field already reaches
   * for less than the seed would cost skip their rays unless they were seeded last build (keeps seeds stable).
   */
  private seedFiring(f: FlowField, rays: number, visits: number) {
    const t = this.terrain, reps = f.reps, previous = f.build - 1, eye = this.profile.fireEye;
    for (; f.cursor < f.candidateCount && rays > 0 && visits > 0; f.cursor++, visits--) {
      const n = f.candidates[f.cursor], x = this.x(n), z = this.z(n), y = this.elevation[n];
      let a = -1, b = -1, da = Infinity, db = Infinity;
      for (let q = 0; q < f.repCount; q++) {
        const m = reps[q], d = (this.x(m) - x) ** 2 + (this.z(m) - z) ** 2 + (this.elevation[m] - y) ** 2;
        if (d > f.range2) continue;
        if (d < da) { b = a; db = da; a = m; da = d; } else if (d < db) { b = m; db = d; }
      }
      if (a < 0) continue;
      // Already cheap to reach: a seed would change nothing, so skip the rays.
      if (f.firing[n] !== previous && f.distance[n] <= Math.sqrt(da) + FIRE_SLACK) continue;
      let cost = -1;
      for (let pass = 0; pass < 2 && cost < 0; pass++) {
        const m = pass ? b : a, d = pass ? db : da;
        if (m < 0) break;
        // Standing behind our own firing line is no vantage point (shots there are blocked by friendlies).
        if (this.screened(f.screen, x, z, this.x(m), this.z(m))) continue;
        rays--; this.fireRays++;
        if (t.visible(x, y + eye, z, this.x(m), this.elevation[m] + eye, this.z(m))) cost = Math.sqrt(d) + FIRE_SLACK;
      }
      if (cost < 0 || cost >= f.pending[n]) continue;
      f.pending[n] = cost; f.heap.push(n); f.firing[n] = f.build; f.firingSeeds++;
    }
    if (f.cursor >= f.candidateCount) f.seeding = false;
    return { rays, visits };
  }
  /** Whether the ground track from (x, z) to (tx, tz) crosses a screened cell, away from both ends. */
  private screened(screen: Uint8Array, x: number, z: number, tx: number, tz: number) {
    const length = Math.hypot(tx - x, tz - z), step = 0.5 * Math.min(this.terrain.dx, this.terrain.dz);
    for (let s = SCREEN_CLEAR; s < length - SCREEN_CLEAR; s += step) {
      const k = s / length;
      if (screen[this.terrain.cell(x + (tx - x) * k, z + (tz - z) * k)]) return true;
    }
    return false;
  }
  private computeCongestion(f: FlowField, occupants: Int32Array | undefined, count: number, weight: number) {
    const out = f.congestion;
    out.fill(0); f.screen.fill(0);
    if (!occupants || count <= 0) return;
    const columns = this.terrain.columns, rows = this.terrain.rows;
    const occ = this.occupancy ??= new Float32Array(out.length), blur = this.blur ??= new Float32Array(out.length);
    occ.fill(0);
    for (let i = 0; i < count; i++) { const node = occupants[i]; if (node >= 0) occ[node]++; }
    // Separable 3x3 box average: per-cell counts are too noisy to route around.
    for (let r = 0; r < rows; r++) {
      const row = r * columns;
      for (let c = 0; c < columns; c++) blur[row + c] = (c > 0 ? occ[row + c - 1] : 0) + occ[row + c] + (c + 1 < columns ? occ[row + c + 1] : 0);
    }
    const span = CONGESTION_FULL - CONGESTION_START;
    for (let r = 0; r < rows; r++) for (let c = 0; c < columns; c++) {
      const n = r * columns + c, around = (r > 0 ? blur[n - columns] : 0) + blur[n] + (r + 1 < rows ? blur[n + columns] : 0), density = around / 9;
      f.screen[n] = +(around > 0);
      out[n] = weight > 0 && density > CONGESTION_START ? weight * Math.min(1, (density - CONGESTION_START) / span) : 0;
    }
  }
  advance(budget = 1024) {
    this.expansions = 0;
    const elevationCost = this.profile.elevationCost;
    // Seeding comes first and is capped per tick; a field's sweep starts once all its seeds are in.
    let rays = this.profile.fireRaysPerTick, visits = this.profile.fireCellsPerTick;
    for (const f of this.fields) if (f.seeding && rays > 0 && visits > 0) ({ rays, visits } = this.seedFiring(f, rays, visits));
    const sweeping = (f: FlowField) => f.building && !f.seeding;
    for (let turn = 0; turn < budget; turn++) {
      const f = sweeping(this.fields[turn & 1]) ? this.fields[turn & 1] : this.fields[1 - (turn & 1)];
      if (!sweeping(f)) break;
      const node = f.heap.pop(); this.expansions++; f.settled++;
      for (let dir = 0; dir < 8; dir++) if (this.edges[node] & 1 << dir) {
        const next = node + this.offsets[dir], cost = f.pending[node] + this.costs[dir] * (this.crowding[next] + f.congestion[next]) + Math.abs(this.elevation[node] - this.elevation[next]) * elevationCost;
        if (cost < f.pending[next] - 1e-5) { f.pending[next] = cost; f.heap.push(next); }
      }
      if (!f.heap.length) this.publish(f, true);
      else if (f.watching) {
        if (f.watchMark![node] === f.build) { f.watchLeft--; f.watchMax = Math.max(f.watchMax, f.pending[node]); }
        if (!f.watchLeft && f.pending[f.heap.nodes[0]] > f.watchMax + f.watchMargin) {
          // Tentative values are only upper bounds: publish them as unknown, not as distances.
          for (let k = 0; k < f.heap.length; k++) f.pending[f.heap.nodes[k]] = Infinity;
          f.heap.clear(); f.earlyStops++; this.publish(f, false);
        }
      }
    }
    this.totalExpansions += this.expansions;
  }
  private publish(f: FlowField, complete: boolean) {
    const front = f.distance; f.distance = f.pending; f.pending = front; f.heap.scores = front;
    f.ready = true; f.building = false; f.watching = false; f.complete = complete;
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
    const size = this.walkable.length;
    const score = this.pathScore ??= new Float32Array(size), parent = this.pathParent ??= new Int32Array(size);
    const priority = this.pathPriority ??= new Float32Array(size), heap = this.pathHeap ??= new Heap(priority);
    score.fill(Infinity); parent.fill(-1); priority.fill(Infinity); heap.clear();
    score[start] = priority[start] = 0; heap.push(start);
    while (heap.length && budget-- > 0) {
      const node = heap.pop();
      if (node === goal) { const path: number[] = []; for (let n = goal; n >= 0; n = parent[n]) path.push(n); return path.reverse(); }
      for (let dir = 0; dir < 8; dir++) if (this.edges[node] & 1 << dir) {
        const next = node + this.offsets[dir], cost = score[node] + this.costs[dir];
        if (cost < score[next] - 1e-5) { parent[next] = node; score[next] = cost; priority[next] = cost + Math.hypot(this.x(next) - tx, this.z(next) - tz); heap.push(next); }
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
