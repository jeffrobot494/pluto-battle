/** Seeded noise and terrain-shaping primitives. Pure math: no Three.js and no
 * allocation inside per-vertex calls. All functions are deterministic. */

export const smooth = (v: number) => { const t = Math.max(0, Math.min(1, v)); return t * t * (3 - 2 * t); };
export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** 2D gradient noise with a seeded permutation, roughly in [-1, 1]. */
export class Noise {
  private readonly perm = new Uint8Array(512);
  private readonly gx = new Float32Array(256);
  private readonly gz = new Float32Array(256);
  constructor(rng: () => number) {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) { p[i] = i; const a = rng() * Math.PI * 2; this.gx[i] = Math.cos(a); this.gz[i] = Math.sin(a); }
    for (let i = 255; i > 0; i--) { const j = Math.floor(rng() * (i + 1)), t = p[i]; p[i] = p[j]; p[j] = t; }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }
  noise(x: number, z: number) {
    const xi = Math.floor(x), zi = Math.floor(z), fx = x - xi, fz = z - zi;
    const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10), v = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
    const a = xi & 255, b = zi & 255, p = this.perm;
    const g00 = p[p[a] + b], g10 = p[p[a + 1] + b], g01 = p[p[a] + b + 1], g11 = p[p[a + 1] + b + 1];
    const n00 = this.gx[g00] * fx + this.gz[g00] * fz, n10 = this.gx[g10] * (fx - 1) + this.gz[g10] * fz;
    const n01 = this.gx[g01] * fx + this.gz[g01] * (fz - 1), n11 = this.gx[g11] * (fx - 1) + this.gz[g11] * (fz - 1);
    return 1.41 * lerp(lerp(n00, n10, u), lerp(n01, n11, u), v);
  }
  /** Fractal sum, normalized to roughly [-1, 1]. */
  fbm(x: number, z: number, octaves = 4, lacunarity = 2.03, gain = 0.5) {
    let sum = 0, amp = 1, norm = 0, f = 1;
    for (let o = 0; o < octaves; o++) { sum += this.noise(x * f + o * 17.3, z * f - o * 9.1) * amp; norm += amp; amp *= gain; f *= lacunarity; }
    return sum / norm;
  }
  /** Ridged fractal in [0, 1]: sharp crests along noise zero-crossings. */
  ridged(x: number, z: number, octaves = 4) {
    let sum = 0, amp = 1, norm = 0, f = 1;
    for (let o = 0; o < octaves; o++) { const n = 1 - Math.abs(this.noise(x * f + o * 31.7, z * f + o * 12.9)); sum += n * n * amp; norm += amp; amp *= 0.5; f *= 2.1; }
    return sum / norm;
  }
}

/** Distance from a point to a polyline stored as flat [x0, z0, x1, z1, ...].
 * Also reports the arc-length position of the closest point via `out[0]`. */
export function polylineDistance(points: ArrayLike<number>, x: number, z: number, out?: Float64Array) {
  let best = Infinity, along = 0, travelled = 0;
  for (let i = 0; i + 3 < points.length; i += 2) {
    const ax = points[i], az = points[i + 1], bx = points[i + 2], bz = points[i + 3];
    const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz, len = Math.sqrt(l2);
    const t = l2 > 1e-12 ? clamp(((x - ax) * dx + (z - az) * dz) / l2, 0, 1) : 0;
    const px = ax + dx * t - x, pz = az + dz * t - z, d = px * px + pz * pz;
    if (d < best) { best = d; along = travelled + t * len; }
    travelled += len;
  }
  if (out) out[0] = along;
  return Math.sqrt(best);
}

/** Smooth, seeded meander from (x0, z0) to (x1, z1) sampled as a flat polyline. */
export function meander(rng: () => number, x0: number, z0: number, x1: number, z1: number, wiggle: number, samples = 48) {
  const out = new Float64Array((samples + 1) * 2), dx = x1 - x0, dz = z1 - z0, len = Math.hypot(dx, dz) || 1;
  const nx = -dz / len, nz = dx / len, waves = 1 + Math.floor(rng() * 3);
  const phases = [rng() * 6.283, rng() * 6.283, rng() * 6.283], amps = [1, 0.45 * rng(), 0.25 * rng()];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples, envelope = Math.sin(Math.PI * t) ** 0.6;
    let offset = 0;
    for (let k = 0; k < 3; k++) offset += amps[k] * Math.sin(t * Math.PI * (waves + k * 1.7) + phases[k]);
    offset *= wiggle * envelope;
    out[i * 2] = x0 + dx * t + nx * offset; out[i * 2 + 1] = z0 + dz * t + nz * offset;
  }
  return out;
}

/** Quantize height into flat treads separated by steep risers. `riser` is the
 * fraction of each step used by the rise (small = cliff-like). */
export function terrace(h: number, step: number, riser = 0.18) {
  const t = h / step, f = Math.floor(t), frac = t - f;
  return step * (f + smooth((frac - (1 - riser)) / riser));
}

/** Rounded superellipse distance: < 1 inside, 1 at the edge. */
export function superellipse(dx: number, dz: number, rx: number, rz: number, angle: number, power = 4) {
  const c = Math.cos(angle), s = Math.sin(angle), u = Math.abs((dx * c + dz * s) / rx), v = Math.abs((-dx * s + dz * c) / rz);
  return (u ** power + v ** power) ** (1 / power);
}

/** Impact crater profile around normalized radius q = distance / radius. */
export function crater(q: number, depth: number, rim: number, peak: number) {
  let h = 0;
  if (q < 1) h -= depth * (1 - q * q);
  const r = (q - 1) / (q < 1 ? 0.12 : 0.32); h += rim * Math.exp(-r * r);
  if (peak > 0 && q < 0.3) h += peak * smooth(1 - q / 0.3);
  return h;
}

/** Worley F1/F2 distances for a jittered grid of cells; writes [f1, f2]. */
export function worley(x: number, z: number, cell: number, seed: number, out: Float64Array) {
  const cx = Math.floor(x / cell), cz = Math.floor(z / cell);
  let f1 = Infinity, f2 = Infinity;
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const gx = cx + i, gz = cz + j;
    let h = Math.imul(gx * 374761393 + gz * 668265263, 1274126177) ^ seed;
    h = Math.imul(h ^ (h >>> 13), 1103515245); const rx = ((h >>> 8) & 0xffff) / 65536;
    h = Math.imul(h ^ (h >>> 15), 2654435761); const rz = ((h >>> 8) & 0xffff) / 65536;
    const px = (gx + 0.15 + rx * 0.7) * cell - x, pz = (gz + 0.15 + rz * 0.7) * cell - z, d = Math.hypot(px, pz);
    if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
  }
  out[0] = f1; out[1] = f2;
}

/** Lipschitz profile through `heights` (sampled at arc spacing `ds`), pinned to
 * the first and last samples where feasible: every step changes by at most
 * `grade * ds`. Values are clamped into the cone allowed by both endpoints and
 * then slope-limited forward, which keeps the end pinned. Returns false when the
 * endpoint difference cannot be reached at this grade. */
export function gradeProfile(heights: Float64Array, ds: number, grade: number) {
  const n = heights.length; if (n < 2) return true;
  const h0 = heights[0], h1 = heights[n - 1], total = ds * (n - 1);
  const feasible = Math.abs(h1 - h0) <= grade * total + 1e-6;
  for (let i = 1; i < n; i++) {
    const s = i * ds;
    let lo = Math.max(h0 - grade * s, h1 - grade * (total - s)), hi = Math.min(h0 + grade * s, h1 + grade * (total - s));
    if (lo > hi) { const m = (lo + hi) / 2; lo = hi = m; }
    const step = grade * ds, prev = heights[i - 1];
    heights[i] = clamp(clamp(heights[i], lo, hi), prev - step, prev + step);
  }
  return feasible;
}
