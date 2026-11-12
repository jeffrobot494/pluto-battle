import { CONFIG } from './config.ts';

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
  readonly teamCounts: Uint16Array[];
  private readonly teams: Uint8Array;
  constructor(capacity: number, halfWidth: number = CONFIG.field.halfWidth, halfDepth: number = CONFIG.field.halfDepth, teams?: Uint8Array) {
    this.halfWidth = halfWidth; this.halfDepth = halfDepth;
    this.columns = Math.ceil(halfWidth * 2 / this.cellSize); this.rows = Math.ceil(halfDepth * 2 / this.cellSize);
    this.heads = new Int32Array(this.columns * this.rows).fill(-1);
    this.next = new Int32Array(capacity).fill(-1);
    this.previous = new Int32Array(capacity).fill(-1);
    this.cell = new Int32Array(capacity).fill(-1);
    this.teams = teams ?? new Uint8Array(capacity);
    this.teamCounts = [new Uint16Array(this.heads.length), new Uint16Array(this.heads.length)];
  }
  column(x: number) { return Math.max(0, Math.min(this.columns - 1, Math.floor((x + this.halfWidth) / this.cellSize))); }
  row(z: number) { return Math.max(0, Math.min(this.rows - 1, Math.floor((z + this.halfDepth) / this.cellSize))); }
  remove(slot: number) {
    const cell = this.cell[slot];
    if (cell < 0) return;
    this.teamCounts[this.teams[slot]][cell]--;
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
    this.teamCounts[this.teams[slot]][cell]++;
  }
}
