import { Terrain, generateTerrain } from './terrain.ts';
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
class FlowField {
  readonly distance: Float32Array;
  readonly pending: Float32Array;
  readonly heap: Heap;
  ready = false;
  building = false;
  constructor(size: number) { this.distance = new Float32Array(size).fill(Infinity); this.pending = new Float32Array(size).fill(Infinity); this.heap = new Heap(this.pending); }
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
  constructor(terrain: Terrain, radius: number) {
    this.terrain = terrain; this.radius = radius;
    const start = performance.now(), size = terrain.columns * terrain.rows;
    this.walkable = new Uint8Array(size); this.edges = new Uint8Array(size); this.regions = new Int32Array(size).fill(-1); this.queue = new Int32Array(size);
    this.offsets = DX.map((x, i) => x + DZ[i] * terrain.columns);
    this.elevation = new Float32Array(size);
    this.costs = DX.map((x, i) => Math.hypot(x * terrain.dx, DZ[i] * terrain.dz));
    this.fields = [new FlowField(size), new FlowField(size)];
    this.pathScore = new Float32Array(size); this.pathPriority = new Float32Array(size); this.pathParent = new Int32Array(size); this.pathHeap = new Heap(this.pathPriority);
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
  beginField(team: number, goals: Int32Array, length: number) {
    const f = this.fields[team]; if (f.building) return;
    f.pending.fill(Infinity); f.heap.clear();
    for (let i = 0; i < length; i++) { const node = goals[i]; if (node >= 0 && this.walkable[node] && f.pending[node] !== 0) { f.pending[node] = 0; f.heap.push(node); } }
    f.building = f.heap.length > 0;
  }
  advance(budget = 1024) {
    this.expansions = 0;
    for (let turn = 0; turn < budget; turn++) {
      const f = this.fields[turn & 1].building ? this.fields[turn & 1] : this.fields[1 - (turn & 1)];
      if (!f.building) break;
      const node = f.heap.pop(); this.expansions++;
      for (let dir = 0; dir < 8; dir++) if (this.edges[node] & 1 << dir) {
        const next = node + this.offsets[dir], cost = f.pending[node] + this.costs[dir] + Math.abs(this.elevation[node] - this.elevation[next]) * 0.25;
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

/** Bounded slope repair guarantees one infantry-connected surface, not lucky seeds. */
export function prepareTerrain(tuning: TuningValues, seed: number) {
  const terrain = generateTerrain(tuning, seed);
  let navigation = new Navigation(terrain, tuning.radius);
  const connected = () => {
    const origin = navigation.nodeAt(0, tuning.frontline), region = origin >= 0 ? navigation.regions[origin] : -1;
    const other = navigation.nodeAt(0, -tuning.frontline);
    if (region < 0 || other < 0 || navigation.regions[other] !== region) return false;
    for (const f of terrain.features) if (f.kind === 'mesa') { const n = navigation.nodeAt(f.x, f.z); if (n < 0 || navigation.regions[n] !== region) return false; }
    return true;
  };
  for (let attempt = 0; !connected() && attempt < 5; attempt++) {
    for (let i = 0; i < terrain.heights.length; i++) terrain.heights[i] *= 0.8;
    for (const rock of terrain.rocks) rock.base = terrain.heightAt(rock.x, rock.z) - 0.22;
    terrain.repairs++; terrain.rebuild(); navigation = new Navigation(terrain, tuning.radius);
  }
  if (!connected()) {
    // Last-resort playable fallback: retain gentle varied relief, remove solids.
    // The seeded corpus should not need it; diagnostics expose any occurrence.
    terrain.rocks.length = 0;
    for (let i = 0; i < terrain.heights.length; i++) terrain.heights[i] *= 0.1;
    terrain.repairs++; terrain.rebuild(); navigation = new Navigation(terrain, tuning.radius);
    if (!connected()) throw new Error('Terrain could not produce connected infantry approaches.');
  }
  return { terrain, navigation };
}
