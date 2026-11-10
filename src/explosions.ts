import { CONFIG } from './config.ts';

export interface Explosion {
  x: number; y: number; z: number; radius: number; damage: number; impulse: number;
}

export function validExplosion(e: Explosion) {
  return Number.isFinite(e.x) && Number.isFinite(e.y) && Number.isFinite(e.z)
    && Number.isFinite(e.radius) && e.radius > 0 && e.radius <= CONFIG.explosion.maxRadius
    && Number.isFinite(e.damage) && e.damage >= 0 && e.damage <= 1000
    && Number.isFinite(e.impulse) && e.impulse >= 0 && e.impulse <= 40;
}

/** Presentation only. Overwriting a slot never affects damage or velocity. */
export class ExplosionEvents {
  readonly capacity = CONFIG.explosion.effects;
  readonly x = new Float32Array(this.capacity);
  readonly y = new Float32Array(this.capacity);
  readonly z = new Float32Array(this.capacity);
  readonly radius = new Float32Array(this.capacity);
  readonly at = new Float64Array(this.capacity).fill(-Infinity);
  cursor = 0;
  overwritten = 0;
  emit(e: Explosion, time: number) {
    const i = this.cursor++ % this.capacity;
    if (time - this.at[i] < CONFIG.explosion.duration) this.overwritten++;
    this.x[i] = e.x; this.y[i] = e.y; this.z[i] = e.z; this.radius[i] = e.radius; this.at[i] = time;
  }
}
