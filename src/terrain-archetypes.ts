import { Noise, clamp, crater, lerp, meander, polylineDistance, smooth, superellipse, terrace, worley } from './terrain-shapes.ts';

/** Colours for one map type. Strings are CSS colours consumed by the renderer. */
export interface TerrainPalette {
  low: string; high: string; cliff: string; ramp: string; rocks: readonly string[];
  sky: string; hemiSky: string; hemiGround: string; sun: string; sunIntensity: number;
  skirt: string; backdrop: string; strata: number;
}
export interface Landform { kind: string; x: number; z: number; rx: number; rz: number; height: number; climbable: boolean }
export interface RampPlan { points: Float64Array; halfWidth: number }
export interface RockStyle { density: number; radius: [number, number]; height: [number, number]; clusters: number }

/** Everything an archetype decides; the generator applies it in a fixed order. */
export interface MapPlan {
  height(x: number, z: number): number;
  /** Deployment pad heights for team 0 (+z) and team 1 (−z); null = average of the raw surface. */
  pads: [number | null, number | null];
  padBlend: number;
  features: Landform[];
  ramps: RampPlan[];
  rocks: RockStyle;
  /** −1 for mirrored, fair maps; otherwise the defending team. */
  defender: -1 | 0 | 1;
}
export interface GenerationContext {
  w: number; d: number; H: number; rng: () => number; noise: Noise; detail: Noise;
  spawnX: number; spawnNear: number; spawnFar: number; radius: number;
}
export interface Archetype {
  id: string; name: string; weight: number; regions: readonly string[]; palette: TerrainPalette;
  build(ctx: GenerationContext): MapPlan;
}

const range = (rng: () => number, a: number, b: number) => a + (b - a) * rng();
const pick = <T>(rng: () => number, items: readonly T[]) => items[Math.floor(rng() * items.length)];
/** Point-symmetric blend: h(x, z) = h(−x, −z), so each army sees the same battlefield. */
export function mirrored(ctx: GenerationContext, f: (x: number, z: number) => number) {
  const band = ctx.d * 0.7;
  return (x: number, z: number) => { const t = smooth(0.5 + z / band); return t * f(x, z) + (1 - t) * f(-x, -z); };
}
/** A straight ramp leaving (x, z) toward (dx, dz), long enough to drop `drop` at a walkable grade. */
function ramp(x: number, z: number, dx: number, dz: number, drop: number, halfWidth: number, ctx: GenerationContext): RampPlan {
  const len = Math.hypot(dx, dz) || 1, length = Math.max(4, drop / 0.42 + 2), ex = clamp(x + dx / len * length, -ctx.w + 1, ctx.w - 1), ez = clamp(z + dz / len * length, -ctx.d + 1, ctx.d - 1);
  return { points: Float64Array.of(x, z, ex, ez), halfWidth };
}
const mirrorRamp = (r: RampPlan): RampPlan => ({ points: r.points.map(v => -v), halfWidth: r.halfWidth });
const rampWidth = (ctx: GenerationContext) => Math.max(1.3, ctx.radius * 5.5);
const ROCKS: RockStyle = { density: 1, radius: [0.42, 1.07], height: [0.95, 2.1], clusters: 0.3 };

const canyon: Archetype = {
  id: 'canyon', name: 'Canyon', weight: 1, regions: ['Virgil Fossae', 'Tartarus Rim', 'Pioneer Gorge', 'Inanna Chasm'],
  palette: { low: '#5a2d2a', high: '#a5634a', cliff: '#7a3b31', ramp: '#b98564', rocks: ['#6d3a33', '#83493a', '#5b302c', '#94604a'], sky: '#b88472', hemiSky: '#f3d6c4', hemiGround: '#5a2a25', sun: '#ffd0a6', sunIntensity: 3.2, skirt: '#4a2422', backdrop: '#7a4537', strata: 0.6 },
  build(ctx) {
    const { w, d, H, rng, noise } = ctx, top = H * range(rng, 0.55, 0.8), along = rng() < 0.4 && ctx.spawnX < w * 0.6;
    const half = along ? ctx.spawnX + range(rng, 1.5, 4) : range(rng, 1.6, 3.2), wall = range(rng, 0.9, 2.2), wiggle = along ? w * 0.18 : Math.max(0, ctx.spawnNear - half - wall - 1.2) * 0.8;
    const paths: Float64Array[] = [];
    if (along) paths.push(meander(rng, 0, -d - 2, 0, d + 2, wiggle));
    else {
      const offset = (rng() - 0.5) * wiggle * 0.5;
      paths.push(meander(rng, -w - 2, offset, w + 2, -offset, wiggle));
    }
    const tributaries: Float64Array[] = [];
    for (let i = 0, n = 1 + Math.floor(rng() * 3); i < n; i++) {
      const x0 = range(rng, -0.6, 0.6) * w, z0 = along ? range(rng, -0.4, 0.4) * d : 0, dir = rng() < 0.5 ? -1 : 1;
      const p = along ? meander(rng, x0 * 0.2, z0, dir * (w + 2), z0 + range(rng, -0.4, 0.4) * d, 3) : meander(rng, x0, z0, x0 + range(rng, -0.4, 0.4) * w, dir * range(rng, 0.25, 0.4) * d, 2.5, 24);
      tributaries.push(p, p.map(v => -v));
    }
    const benches = rng() < 0.6 ? 2 + Math.floor(rng() * 2) : 0, tribHalf = half * 0.55;
    const height = (x: number, z: number) => {
      const jag = noise.fbm(x * 0.13, z * 0.13, 3) * 1.4;
      let cut = 0;
      for (const p of paths) cut = Math.max(cut, 1 - smooth((polylineDistance(p, x, z) + jag - half) / wall));
      for (const p of tributaries) cut = Math.max(cut, (1 - smooth((polylineDistance(p, x, z) + jag - tribHalf) / wall)) * 0.85);
      let h = top * (1 - cut) + noise.fbm(x * 0.05 + 7, z * 0.05, 3) * H * 0.07;
      if (benches) h = lerp(h, terrace(h, top / benches, 0.35), 0.75);
      return h + ctx.detail.fbm(x * 0.4, z * 0.4, 2) * 0.12;
    };
    const ramps: RampPlan[] = [], hw = rampWidth(ctx);
    if (!along) for (let i = 0, n = 1 + Math.floor(rng() * 2); i < n; i++) {
      const x = range(rng, -0.75, 0.75) * w, r = ramp(x, ctx.spawnNear - 0.5, rng() < 0.5 ? -1 : 1, -0.4, top, hw, ctx);
      ramps.push(r, mirrorRamp(r));
    } else for (let i = 0, n = 1 + Math.floor(rng() * 2); i < n; i++) {
      const z = range(rng, -0.5, 0.5) * d, r = ramp(half + 3.5, z, -0.6, rng() < 0.5 ? -1 : 1, top, hw, ctx);
      ramps.push(r, mirrorRamp(r));
    }
    const rimX = Math.min(w - 2, half + wall + 3.5), features: Landform[] = along && rimX > half + wall + 1 ? [{ kind: 'rim', x: rimX, z: 0, rx: 3, rz: 3, height: top, climbable: true }, { kind: 'rim', x: -rimX, z: 0, rx: 3, rz: 3, height: top, climbable: true }] : [];
    return { height, pads: along ? [0, 0] : [top, top], padBlend: 3, features, ramps, rocks: { ...ROCKS, density: 0.8, clusters: 0.6 }, defender: -1 };
  },
};

const terraces: Archetype = {
  id: 'terraces', name: 'Terraces', weight: 1, regions: ['Tombaugh Steps', 'Hayabusa Terra', 'Voyager Benches', 'Venera Tiers'],
  palette: { low: '#6b4a57', high: '#c3a4a8', cliff: '#7f5a66', ramp: '#d2b4a8', rocks: ['#7b5a68', '#94707a', '#5f4452', '#a07f84'], sky: '#9c8aa4', hemiSky: '#ece0f5', hemiGround: '#5a3b48', sun: '#ffe2c4', sunIntensity: 3, skirt: '#4f3542', backdrop: '#76596b', strata: 0.9 },
  build(ctx) {
    const { w, d, H, rng, noise } = ctx, mode = pick(rng, ['ziggurat', 'amphitheatre', 'waves'] as const);
    const steps = 3 + Math.floor(rng() * 3), angle = rng() * Math.PI, power = range(rng, 1.1, 2.6), scale = H * range(rng, 0.75, 1);
    const ax = Math.min(w * 0.85, Math.max(6, w * range(rng, 0.4, 0.75))), az = Math.min(d * 0.7, Math.max(5, ctx.spawnNear * range(rng, 0.9, 1.6)));
    const k = Math.PI * 2 / range(rng, 14, 26), wa = rng() * Math.PI;
    const height = (x: number, z: number) => {
      let base: number;
      if (mode === 'ziggurat') base = scale * Math.max(0, 1 - superellipse(x, z, ax, az, angle, power));
      else if (mode === 'amphitheatre') base = scale * clamp((Math.abs(x) / w) ** 1.4 * 0.8 + (Math.abs(z) / d) ** 2 * 0.5, 0, 1);
      else base = scale * 0.55 * (1 + Math.cos(k * (x * Math.cos(wa) + z * Math.sin(wa))));
      base += noise.fbm(x * 0.08, z * 0.08, 3) * scale / steps * 0.6;
      return terrace(Math.max(0, base), scale / steps, 0.2) + ctx.detail.fbm(x * 0.5, z * 0.5, 2) * 0.08;
    };
    const features: Landform[] = [], ramps: RampPlan[] = [], hw = rampWidth(ctx);
    if (mode === 'ziggurat') {
      features.push({ kind: 'summit', x: 0, z: 0, rx: 2, rz: 2, height: scale, climbable: true });
      const a = rng() * Math.PI * 2, r = ramp(0, 0, Math.cos(a), Math.sin(a), scale, hw, ctx); ramps.push(r, mirrorRamp(r));
    } else if (mode === 'amphitheatre') {
      const x = w * 0.8; features.push({ kind: 'tier', x, z: 0, rx: 2, rz: 2, height: scale * 0.8, climbable: true }, { kind: 'tier', x: -x, z: 0, rx: 2, rz: 2, height: scale * 0.8, climbable: true });
    }
    return { height, pads: [null, null], padBlend: 3.5, features, ramps, rocks: { ...ROCKS, density: 0.6 }, defender: -1 };
  },
};

const craters: Archetype = {
  id: 'craters', name: 'Crater Field', weight: 1, regions: ['Burney Basin', 'Edgeworth Field', 'Elliot Craters', 'Oort Scar'],
  palette: { low: '#4d3f4f', high: '#9b8a92', cliff: '#6b5866', ramp: '#a99aa0', rocks: ['#5f5060', '#776673', '#4b3e4c', '#8a7a84'], sky: '#7d7a92', hemiSky: '#dcd8f0', hemiGround: '#3f3141', sun: '#fff0dc', sunIntensity: 3.2, skirt: '#3a2f3b', backdrop: '#5f5162', strata: 0.25 },
  build(ctx) {
    const { w, d, H, rng, noise } = ctx, span = Math.min(w, d), list: [number, number, number, number, number, number][] = [];
    if (rng() < 0.4) { const R = span * range(rng, 0.45, 0.7); list.push([0, 0, R, Math.min(H * 0.55, R * 0.3), Math.min(H * 0.35, R * 0.16), H * range(rng, 0.4, 0.8)]); }
    for (let i = 0, n = 3 + Math.floor(rng() * 5); i < n; i++) {
      const R = span * range(rng, 0.1, 0.4), x = range(rng, -1, 1) * w, z = range(rng, -1, 1) * d;
      const crater = [x, z, R, Math.min(H * 0.5, R * range(rng, 0.25, 0.45)), Math.min(H * 0.4, R * range(rng, 0.12, 0.22)), R > span * 0.28 && rng() < 0.6 ? R * 0.3 : 0] as [number, number, number, number, number, number];
      list.push(crater, [-x, -z, ...crater.slice(2)] as typeof crater);
    }
    const height = (x: number, z: number) => {
      let h = noise.fbm(x * 0.05, z * 0.05, 4) * H * 0.12 + noise.fbm(-x * 0.05, -z * 0.05, 4) * H * 0.12;
      for (const [cx, cz, R, depth, rim, peak] of list) { const q = Math.hypot(x - cx, z - cz) / R; if (q < 2.2) h += crater(q, depth, rim, peak); }
      return h + ctx.detail.fbm(x * 0.6, z * 0.6, 2) * 0.1;
    };
    const features = list.filter(c => c[5] > 1.2).map(([x, z, R, , , peak]) => ({ kind: 'peak', x, z, rx: R * 0.2, rz: R * 0.2, height: peak, climbable: false }));
    return { height, pads: [null, null], padBlend: 3, features, ramps: [], rocks: { ...ROCKS, density: 1.3, clusters: 0.5 }, defender: -1 };
  },
};

const massif: Archetype = {
  id: 'massif', name: 'Mountain', weight: 1, regions: ['Wright Mons', 'Piccard Mons', 'Tenzing Montes', 'Hillary Montes'],
  palette: { low: '#56404a', high: '#d8cfd6', cliff: '#6e5560', ramp: '#b49a98', rocks: ['#6a535e', '#806772', '#58434e', '#9a8590'], sky: '#8f86a8', hemiSky: '#e6e2fa', hemiGround: '#4a3540', sun: '#ffe6cc', sunIntensity: 3.3, skirt: '#44323b', backdrop: '#6a5664', strata: 0.45 },
  build(ctx) {
    const { w, d, H, rng, noise } = ctx, mode = pick(rng, ['central', 'twin', 'diagonal'] as const), peaks: [number, number, number, number, number][] = [];
    const tall = H * range(rng, 1, 1.2);
    if (mode === 'central') peaks.push([0, 0, Math.min(w * 0.75, Math.max(7, w * range(rng, 0.4, 0.65))), Math.max(4, ctx.spawnNear * range(rng, 0.9, 1.25)), rng() * 0.6 - 0.3]);
    else if (mode === 'twin') { const x = w * range(rng, 0.35, 0.55), r = Math.max(4.5, Math.min(w * 0.4, ctx.spawnNear * 1.3)); peaks.push([x, 0, r, r * range(rng, 0.8, 1.2), rng() * 3], [-x, 0, r, r, rng() * 3]); }
    else { const x = w * range(rng, 0.3, 0.55), z = ctx.spawnNear * range(rng, 0.2, 0.6), r = Math.max(4.5, Math.min(w * 0.4, ctx.spawnNear * 1.2)); peaks.push([x, z, r, r * 0.8, rng() * 3], [-x, -z, r, r * 0.8, rng() * 3]); }
    const shoulder = tall * range(rng, 0.3, 0.45);
    const height = (x: number, z: number) => {
      let h = noise.fbm(x * 0.06, z * 0.06, 3) * H * 0.06;
      for (const [px, pz, rx, rz, a] of peaks) {
        const warp = noise.fbm(x * 0.1 + px, z * 0.1, 3) * 0.25, q = superellipse(x - px, z - pz, rx, rz, a, 2) + warp;
        if (q >= 1) continue;
        const ridges = 0.7 + 0.45 * noise.ridged(x * 0.09 + px, z * 0.09 + pz, 3);
        let m = tall * Math.pow(smooth(1 - q), 1.4) * ridges;
        // A broad bench partway up gives a reachable high-ground platform.
        if (m > shoulder && q > 0.35) m = lerp(shoulder, m, smooth((m - shoulder) / (tall * 0.25)) * 0.35);
        h = Math.max(h, m);
      }
      return h + ctx.detail.fbm(x * 0.45, z * 0.45, 2) * 0.12;
    };
    const features: Landform[] = [], ramps: RampPlan[] = [], hw = rampWidth(ctx);
    for (const [px, pz, rx, rz] of peaks) {
      const sx = px + (px === 0 ? rx * 0.55 : Math.sign(px) * rx * 0.5), sz = pz;
      features.push({ kind: 'bench', x: sx, z: sz, rx: 2, rz: 2, height: shoulder, climbable: true });
      void rz;
    }
    if (mode === 'central') { const r = ramp(peaks[0][2] * 0.55, 0, 0.3, 1, shoulder, hw, ctx); ramps.push(r, mirrorRamp(r)); }
    return { height, pads: [null, null], padBlend: 3.5, features, ramps, rocks: { ...ROCKS, density: 0.9, clusters: 0.7, radius: [0.5, 1.3] }, defender: -1 };
  },
};

const valley: Archetype = {
  id: 'valley', name: 'Rift Valley', weight: 1, regions: ['Sputnik Rift', 'Djanggawul Fossae', 'Krun Valley', 'Hyecho Gap'],
  palette: { low: '#a5b4c8', high: '#7d4f48', cliff: '#6b403b', ramp: '#c09a86', rocks: ['#734a44', '#8e5e52', '#5f3c38', '#a07466'], sky: '#8a96b3', hemiSky: '#e2ebff', hemiGround: '#4d3436', sun: '#ffe9d2', sunIntensity: 3.1, skirt: '#47302f', backdrop: '#6e4a46', strata: 0.55 },
  build(ctx) {
    const { w, d, H, rng, noise } = ctx, inverse = rng() < 0.35, top = H * range(rng, 0.5, 0.75);
    const floorHalf = Math.max(1.5, ctx.spawnNear * range(rng, 0.25, 0.5)), slope = Math.max(4, d * 0.92 - floorHalf);
    // The fall continues under both deployments (tilted pads), so the drop is large but walkable.
    const river = meander(rng, -w - 2, 0, w + 2, 0, floorHalf * 0.5), gapScale = range(rng, 0.08, 0.16);
    const height = (x: number, z: number) => {
      const wz = Math.abs(z + noise.fbm(x * 0.06, 3.3, 2) * floorHalf * 0.8);
      let t = smooth((wz - floorHalf) / slope);
      if (inverse) t = 1 - t;
      const terraced = terrace(t * top, top / 2, 0.22), gentle = t * top;
      const pass = smooth(noise.noise(x * gapScale, 11.7) * 2.2 + 0.2);
      let h = lerp(terraced, gentle, pass);
      if (!inverse) h -= (1 - smooth(polylineDistance(river, x, z) / 1.2)) * 0.6;
      return h + noise.fbm(x * 0.07, z * 0.07, 3) * H * 0.05 + ctx.detail.fbm(x * 0.5, z * 0.5, 2) * 0.1;
    };
    const features: Landform[] = inverse ? [{ kind: 'plateau', x: 0, z: 0, rx: w, rz: floorHalf, height: top, climbable: true }] : [];
    return { height, pads: [null, null], padBlend: 3, features, ramps: [], rocks: { ...ROCKS, density: 0.8, clusters: 0.6 }, defender: -1 };
  },
};

const mesas: Archetype = {
  id: 'mesas', name: 'Mesa Archipelago', weight: 1, regions: ['Cthulhu Mesas', 'Krun Buttes', 'Belton Heights', 'Lowell Tablelands'],
  palette: { low: '#5e2f36', high: '#b06a55', cliff: '#7d3d3c', ramp: '#c58b6c', rocks: ['#743a3b', '#8b4c45', '#5c2e33', '#a0624f'], sky: '#a87a7e', hemiSky: '#f0d4d6', hemiGround: '#55262d', sun: '#ffcfa0', sunIntensity: 3.3, skirt: '#4b2429', backdrop: '#73403f', strata: 0.75 },
  build(ctx) {
    const { w, d, H, rng, noise } = ctx, list: [number, number, number, number, number, number, number][] = [], span = Math.min(w, d);
    for (let i = 0, n = 3 + Math.floor(rng() * 4); i < n; i++) {
      const m = [range(rng, -0.85, 0.85) * w, range(rng, -0.85, 0.85) * d, span * range(rng, 0.1, 0.28), span * range(rng, 0.1, 0.28), rng() * Math.PI, H * range(rng, 0.25, 0.75), range(rng, 2.5, 6)] as [number, number, number, number, number, number, number];
      list.push(m, [-m[0], -m[1], ...m.slice(2)] as typeof m);
    }
    const height = (x: number, z: number) => {
      let h = (noise.fbm(x * 0.05, z * 0.05, 3) + noise.fbm(-x * 0.05, -z * 0.05, 3)) * H * 0.05;
      for (const [mx, mz, rx, rz, a, top, p] of list) {
        const q = superellipse(x - mx, z - mz, rx, rz, a, p) + noise.fbm(x * 0.2 + mx, z * 0.2 + mz, 2) * 0.12;
        if (q < 1.3) h = Math.max(h, top * smooth((1.05 - q) / 0.14) + (q < 1 ? noise.fbm(x * 0.3, z * 0.3, 2) * 0.15 : 0));
      }
      return h + ctx.detail.fbm(x * 0.5, z * 0.5, 2) * 0.1;
    };
    const features: Landform[] = [], ramps: RampPlan[] = [], hw = rampWidth(ctx);
    for (let i = 0; i < list.length; i += 2) {
      const [mx, mz, rx, rz, , top] = list[i];
      if (rng() < 0.55) {
        features.push({ kind: 'mesa', x: mx, z: mz, rx, rz, height: top, climbable: true }, { kind: 'mesa', x: -mx, z: -mz, rx, rz, height: top, climbable: true });
        const a = rng() * Math.PI * 2, edge = Math.min(rx, rz) * 0.8, r = ramp(mx + Math.cos(a) * edge * 0.5, mz + Math.sin(a) * edge * 0.5, Math.cos(a), Math.sin(a), top, hw, ctx);
        ramps.push(r, mirrorRamp(r));
      }
    }
    // Causeways join some neighbouring tops into raised walkways.
    for (let i = 0; i + 2 < list.length; i += 2) if (rng() < 0.35) {
      const a = list[i], b = list[i + 2];
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) < span * 0.9) { const r = { points: Float64Array.of(a[0], a[1], b[0], b[1]), halfWidth: hw * 0.8 }; ramps.push(r, mirrorRamp(r)); }
    }
    return { height, pads: [null, null], padBlend: 3, features, ramps, rocks: { ...ROCKS, density: 0.7, clusters: 0.8 }, defender: -1 };
  },
};

const blades: Archetype = {
  id: 'blades', name: 'Bladed Ridges', weight: 1, regions: ['Tartarus Dorsa', 'Coleridge Blades', 'Hyecho Spines', 'Eastern Dorsa'],
  palette: { low: '#6f5a6d', high: '#e0d6e2', cliff: '#8a7488', ramp: '#b9a3b3', rocks: ['#7c6679', '#93808f', '#64525f', '#a8949f'], sky: '#9a95b5', hemiSky: '#f0ecff', hemiGround: '#4e3f4e', sun: '#fff0e0', sunIntensity: 3.1, skirt: '#463947', backdrop: '#6d5c6c', strata: 0.3 },
  build(ctx) {
    const { H, rng, noise } = ctx, angle = range(rng, -1.2, 1.2) + (rng() < 0.5 ? Math.PI / 2 : 0), spacing = range(rng, 3.6, 6.5);
    const sharp = range(rng, 2.5, 5), tall = H * range(rng, 0.35, 0.6), gaps = range(rng, 0.05, 0.12), cut = range(rng, 0.1, 0.45);
    const c = Math.cos(angle), s = Math.sin(angle);
    const height = (x: number, z: number) => {
      const p = x * c + z * s, along = -x * s + z * c, k = Math.floor(p / spacing), key = k >= 0 ? k : -k - 1, a = k >= 0 ? along : -along;
      const f = p / spacing - k, tri = 1 - Math.abs(f - 0.5) * 2;
      const mask = smooth((noise.noise(a * gaps, key * 3.71 + 0.5) + cut) * 3);
      const blade = Math.pow(tri, sharp) * tall * mask * (0.7 + 0.3 * noise.noise(a * 0.3, key * 1.3));
      const base = (noise.fbm(x * 0.05, z * 0.05, 3) + noise.fbm(-x * 0.05, -z * 0.05, 3)) * H * 0.06;
      return base + blade + ctx.detail.fbm(x * 0.5, z * 0.5, 2) * 0.08;
    };
    return { height, pads: [null, null], padBlend: 2.5, features: [], ramps: [], rocks: { ...ROCKS, density: 0.5 }, defender: -1 };
  },
};

const ice: Archetype = {
  id: 'ice', name: 'Nitrogen Plains', weight: 1, regions: ['Sputnik Planitia', 'Tombaugh Regio', 'Al-Idrisi Shore', 'Baret Ice'],
  palette: { low: '#b9c7d9', high: '#eef2f8', cliff: '#7f8ea6', ramp: '#d8dfe9', rocks: ['#8d9bb1', '#a7b3c5', '#76839a', '#c2ccd9'], sky: '#7d8fb3', hemiSky: '#eef4ff', hemiGround: '#55607a', sun: '#fff4e6', sunIntensity: 2.6, skirt: '#76839a', backdrop: '#8b97ad', strata: 0.15 },
  build(ctx) {
    const { w, H, rng, noise } = ctx, cell = range(rng, 6.5, 11), seed = Math.floor(rng() * 1e9), out = new Float64Array(2), bergs: [number, number, number, number, number, number][] = [];
    const flanks = w > 16 && rng() < 0.7, span = Math.min(w, ctx.d);
    for (let i = 0, n = 2 + Math.floor(rng() * 4); i < n; i++) {
      const b = [range(rng, -0.8, 0.8) * w, range(rng, -0.8, 0.8) * ctx.d, span * range(rng, 0.05, 0.14), span * range(rng, 0.05, 0.14), rng() * 3, H * range(rng, 0.2, 0.45)] as [number, number, number, number, number, number];
      bergs.push(b, [-b[0], -b[1], ...b.slice(2)] as typeof b);
    }
    const plains = (x: number, z: number) => {
      worley(x + noise.noise(x * 0.1, z * 0.1) * 1.5, z, cell, seed, out);
      const edge = out[1] - out[0];
      let h = 0.55 * smooth(edge / cell * 2.5) - 0.75 * (1 - smooth(edge / 2.4));
      if (flanks) h += H * 0.9 * smooth((Math.abs(x) / w - 0.66) / 0.3) * (0.35 + 0.65 * noise.ridged(x * 0.12, z * 0.12, 3));
      return h;
    };
    const height = (x: number, z: number) => {
      let h = plains(x, z);
      for (const [bx, bz, rx, rz, a, top] of bergs) { const q = superellipse(x - bx, z - bz, rx, rz, a, 6); if (q < 1.25) h = Math.max(h, top * smooth((1.05 - q) / 0.12)); }
      return h + ctx.detail.fbm(x * 0.6, z * 0.6, 2) * 0.05;
    };
    return { height, pads: [null, null], padBlend: 3, features: [], ramps: [], rocks: { density: 0.6, radius: [0.5, 1.4], height: [0.8, 2.4], clusters: 0.4 }, defender: -1 };
  },
};

const badlands: Archetype = {
  id: 'badlands', name: 'Badlands', weight: 1, regions: ['Cthulhu Macula', 'Krun Macula', 'Meng-P’o Wastes', 'Balrog Breaks'],
  palette: { low: '#3f2326', high: '#9a5a45', cliff: '#5c2f2c', ramp: '#a87a62', rocks: ['#5a302d', '#704036', '#482628', '#86503f'], sky: '#94626a', hemiSky: '#efcfcf', hemiGround: '#3d1f22', sun: '#ffc796', sunIntensity: 3.4, skirt: '#331c1e', backdrop: '#5e3532', strata: 1 },
  build(ctx) {
    const { H, rng, noise } = ctx, layers = 3 + Math.floor(rng() * 3), freq = range(rng, 0.045, 0.08), warp = range(rng, 4, 9), amp = H * range(rng, 0.45, 0.7);
    const height = (x: number, z: number) => {
      const wx = x + noise.fbm(x * 0.04 + 3, z * 0.04, 3) * warp, wz = z + noise.fbm(x * 0.04, z * 0.04 + 8, 3) * warp;
      let h = amp * (0.5 + 0.5 * noise.fbm(wx * freq, wz * freq, 5));
      h -= amp * 0.35 * Math.pow(noise.ridged(wx * freq * 1.6, wz * freq * 1.6, 3), 3);
      return terrace(Math.max(0, h), amp / layers, 0.28) + ctx.detail.fbm(x * 0.5, z * 0.5, 2) * 0.12;
    };
    return { height, pads: [null, null], padBlend: 3, features: [], ramps: [], rocks: { density: 1.6, radius: [0.4, 1.2], height: [0.9, 2.4], clusters: 0.85 }, defender: -1 };
  },
};

const fortress: Archetype = {
  id: 'fortress', name: 'Fortress Plateau', weight: 0.8, regions: ['Wright Citadel', 'Charon Bastion', 'Kiladze Keep', 'Tombaugh Redoubt'],
  palette: { low: '#5b3640', high: '#a8848a', cliff: '#6c4650', ramp: '#c49c94', rocks: ['#6d4752', '#835b64', '#58363f', '#9a747b'], sky: '#9b7d8e', hemiSky: '#efdcea', hemiGround: '#4f2c35', sun: '#ffd9b8', sunIntensity: 3.2, skirt: '#462a32', backdrop: '#6e4c58', strata: 0.7 },
  build(ctx) {
    const { w, H, rng, noise } = ctx, defender = (rng() < 0.5 ? 0 : 1) as 0 | 1, ds = defender === 0 ? 1 : -1;
    const top = H * range(rng, 0.45, 0.65), edge = ctx.spawnNear * range(rng, 0.15, 0.55), wall = range(rng, 0.8, 1.6);
    const bastions = range(rng, 0.12, 0.3), bastionDepth = range(rng, 1, 3), craters2: [number, number, number][] = [];
    for (let i = 0, n = 2 + Math.floor(rng() * 4); i < n; i++) craters2.push([range(rng, -0.8, 0.8) * w, -ds * range(rng, 0.1, 0.8) * ctx.d, range(rng, 2, 5)]);
    const height = (x: number, z: number) => {
      const front = edge + Math.sin(x * bastions + 1.3) * bastionDepth * 0.5 + noise.fbm(x * 0.1, 4.4, 2) * 1.2;
      let h = top * smooth((ds * z - front) / wall);
      for (const [cx, cz, R] of craters2) { const q = Math.hypot(x - cx, z - cz) / R; if (q < 2) h += crater(q, R * 0.3, R * 0.15, 0); }
      // Trench lines give the attacker staged cover on the approach.
      const t = -ds * z;
      if (t > 0) h -= 0.5 * (1 - smooth(Math.abs(((t + 2) % 7) - 3.5) / 0.9)) * smooth(t / 3);
      return h + noise.fbm(x * 0.06, z * 0.06, 3) * H * 0.05 + ctx.detail.fbm(x * 0.5, z * 0.5, 2) * 0.1;
    };
    const ramps: RampPlan[] = [], hw = rampWidth(ctx);
    for (let i = 0, n = 2 + Math.floor(rng() * 2); i < n; i++) {
      const x = ((i + 0.5) / n * 2 - 1) * w * 0.75 + range(rng, -2, 2);
      ramps.push(ramp(x, ds * (edge + 2.5), range(rng, -0.4, 0.4), -ds, top, hw, ctx));
    }
    const pads: [number, number] = defender === 0 ? [top, 0] : [0, top];
    return { height, pads, padBlend: 3, features: [], ramps, rocks: { ...ROCKS, density: 1.1, clusters: 0.5 }, defender };
  },
};

const escarpment: Archetype = {
  id: 'escarpment', name: 'Escarpment', weight: 0.8, regions: ['Hillary Slope', 'Norgay Ascent', 'Pioneer Scarp', 'Venera Rise'],
  palette: { low: '#68443e', high: '#c9b2ac', cliff: '#7b524a', ramp: '#cfa98f', rocks: ['#7a524a', '#93685c', '#61403b', '#a98072'], sky: '#a2879a', hemiSky: '#f6e3ea', hemiGround: '#523431', sun: '#ffdcbc', sunIntensity: 3.2, skirt: '#4a302d', backdrop: '#755550', strata: 0.85 },
  build(ctx) {
    const { d, H, rng, noise } = ctx, defender = (rng() < 0.5 ? 0 : 1) as 0 | 1, ds = defender === 0 ? 1 : -1;
    const top = H * range(rng, 0.55, 0.85), steps = 2 + Math.floor(rng() * 3), gully = range(rng, 0.07, 0.14);
    const height = (x: number, z: number) => {
      const t = smooth((ds * z + d * 0.55) / (d * 1.25) + noise.fbm(x * 0.05, 1.7, 2) * 0.12);
      const terraced = terrace(t * top, top / steps, 0.2), ramped = t * top;
      const pass = smooth(noise.noise(x * gully, 5.5) * 2.4 - 0.1);
      return lerp(terraced, ramped, pass) + noise.fbm(x * 0.07, z * 0.07, 3) * H * 0.05 + ctx.detail.fbm(x * 0.5, z * 0.5, 2) * 0.1;
    };
    return { height, pads: [null, null], padBlend: 3, features: [], ramps: [], rocks: { ...ROCKS, density: 1.1, clusters: 0.6 }, defender };
  },
};

export const ARCHETYPES: readonly Archetype[] = [canyon, terraces, craters, massif, valley, mesas, blades, ice, badlands, fortress, escarpment];
export const archetypeById = (id: string) => ARCHETYPES.find(a => a.id === id);

/** Seed → archetype, independent of the generation stream so overrides do not shift other choices. */
export function pickArchetype(seed: number) {
  let h = Math.imul((seed >>> 0) ^ 0x9e3779b9, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  const total = ARCHETYPES.reduce((sum, a) => sum + a.weight, 0);
  let roll = (h >>> 0) / 4294967296 * total;
  for (const a of ARCHETYPES) { roll -= a.weight; if (roll < 0) return a; }
  return ARCHETYPES[ARCHETYPES.length - 1];
}

/** Optional scattered spires: tall, unclimbable sight blockers on any mirrored map. */
export function spires(ctx: GenerationContext, count: number) {
  const list: [number, number, number, number][] = [];
  for (let i = 0; i < count; i++) {
    const s = [range(ctx.rng, -0.9, 0.9) * ctx.w, range(ctx.rng, -0.9, 0.9) * ctx.d, range(ctx.rng, 0.9, 1.7), ctx.H * range(ctx.rng, 0.35, 0.7)] as [number, number, number, number];
    list.push(s, [-s[0], -s[1], s[2], s[3]]);
  }
  return (x: number, z: number) => {
    let h = 0;
    for (const [sx, sz, r, top] of list) { const q = Math.hypot(x - sx, z - sz) / r; if (q < 1) h = Math.max(h, top * Math.pow(1 - q, 0.55)); }
    return h;
  };
}
