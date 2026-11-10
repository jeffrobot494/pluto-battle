import { CONFIG } from './config.ts';

/** First contact with an upright capsule's axis segment, for a unit ray direction. */
export function raySegmentCapsule(x: number, y: number, z: number, dx: number, dy: number, dz: number,
  cx: number, low: number, high: number, cz: number, radius: number): number {
  const ox = x - cx, oz = z - cz, oy = y - Math.max(low, Math.min(high, y));
  if (ox * ox + oy * oy + oz * oz <= radius * radius) return 0;
  let result = Infinity;
  const a = dx * dx + dz * dz, b = ox * dx + oz * dz;
  if (a > 1e-14) {
    const disc = b * b - a * (ox * ox + oz * oz - radius * radius);
    if (disc >= 0) {
      const t = (-b - Math.sqrt(disc)) / a, h = y + dy * t;
      if (t >= 0 && h >= low && h <= high) result = t;
    }
  }
  for (let end = 0; end < 2; end++) {
    const ey = y - (end ? high : low), dot = ox * dx + ey * dy + oz * dz;
    const disc = dot * dot - (ox * ox + ey * ey + oz * oz - radius * radius);
    if (disc >= 0) {
      const t = -dot - Math.sqrt(disc), h = y + dy * t;
      if (t >= 0 && (end ? h >= high : h <= low)) result = Math.min(result, t);
    }
  }
  return result;
}

/** Shared shape convention with the terrain prototype: Y is the capsule's feet. */
export function rayCapsule(x: number, y: number, z: number, dx: number, dy: number, dz: number,
  cx: number, base: number, cz: number, radius: number) {
  return raySegmentCapsule(x, y, z, dx, dy, dz, cx, base + radius, base + CONFIG.soldier.height - radius, cz, radius);
}
