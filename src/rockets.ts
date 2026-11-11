import { CONFIG } from './config.ts';

/**
 * Rockets in flight: a dense, fixed-capacity pool (active rockets occupy 0..count-1, removal swaps the last in).
 * Each rocket flies a straight line; `limit` is the precomputed distance to the terrain (terrain is static,
 * so it is raycast once at launch) or to the fuse / field edge. Only soldiers are tested while in flight.
 */
export class Rockets {
  readonly capacity = CONFIG.rocket.maxInFlight;
  readonly x = new Float64Array(this.capacity);
  readonly y = new Float64Array(this.capacity);
  readonly z = new Float64Array(this.capacity);
  readonly previousX = new Float64Array(this.capacity);
  readonly previousY = new Float64Array(this.capacity);
  readonly previousZ = new Float64Array(this.capacity);
  readonly dx = new Float32Array(this.capacity);
  readonly dy = new Float32Array(this.capacity);
  readonly dz = new Float32Array(this.capacity);
  readonly travelled = new Float32Array(this.capacity);
  readonly limit = new Float32Array(this.capacity);
  /** 1 = explode on reaching `limit` (terrain or fuse); 0 = leaves the battlefield silently. */
  readonly detonate = new Uint8Array(this.capacity);
  /** Shooter's soldier ID. A rocket never collides with its own shooter (the blast still can hurt him). */
  readonly owner = new Uint32Array(this.capacity);
  readonly team = new Uint8Array(this.capacity);
  count = 0;

  add(x: number, y: number, z: number, dx: number, dy: number, dz: number, limit: number, detonate: boolean, owner: number, team: number) {
    if (this.count >= this.capacity) return false;
    const n = this.count++;
    this.x[n] = this.previousX[n] = x; this.y[n] = this.previousY[n] = y; this.z[n] = this.previousZ[n] = z;
    this.dx[n] = dx; this.dy[n] = dy; this.dz[n] = dz;
    this.travelled[n] = 0; this.limit[n] = limit; this.detonate[n] = +detonate; this.owner[n] = owner; this.team[n] = team;
    return true;
  }

  remove(n: number) {
    const last = --this.count;
    if (n === last) return;
    this.x[n] = this.x[last]; this.y[n] = this.y[last]; this.z[n] = this.z[last];
    this.previousX[n] = this.previousX[last]; this.previousY[n] = this.previousY[last]; this.previousZ[n] = this.previousZ[last];
    this.dx[n] = this.dx[last]; this.dy[n] = this.dy[last]; this.dz[n] = this.dz[last];
    this.travelled[n] = this.travelled[last]; this.limit[n] = this.limit[last]; this.detonate[n] = this.detonate[last];
    this.owner[n] = this.owner[last]; this.team[n] = this.team[last];
  }
}

/** Cosmetic smoke trail ring buffer. Overwriting the oldest puffs never affects combat. */
export class SmokeEvents {
  readonly capacity = CONFIG.rocket.smoke;
  readonly x = new Float32Array(this.capacity);
  readonly y = new Float32Array(this.capacity);
  readonly z = new Float32Array(this.capacity);
  readonly at = new Float64Array(this.capacity).fill(-Infinity);
  cursor = 0;
  emit(x: number, y: number, z: number, time: number) {
    const i = this.cursor++ % this.capacity;
    this.x[i] = x; this.y[i] = y; this.z[i] = z; this.at[i] = time;
  }
}
