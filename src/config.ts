export const CONFIG = {
  step: 1 / 60,
  capacity: 2048,
  defaultPerTeam: 100,
  seed: 74319,
  field: { halfWidth: 28, halfDepth: 34, cellSize: 1.1 },
  soldier: { radius: 0.29, height: 1.12, health: 100, speed: 3.0 },
  hit: { duration: 0.12, intensity: 1 },
  corpseLifetime: 1.8,
  maxEffects: 768,
  physics: { gravity: 9.81, friction: 8, contactIterations: 4 },
  explosion: { radius: 4, damage: 35, impulse: 10, maxRadius: 20, effects: 32, duration: 0.45 },
} as const;

export interface Weapon {
  name: string;
  range: number;
  damage: number;
  interval: number;
}
export const WEAPONS: readonly Weapon[] = [
  { name: 'Laser rifle', range: 10.5, damage: 9, interval: 0.46 },
  // Developer API fixture for live upgrades; no purchase/upgrade UI in this slice.
  { name: 'Heavy laser', range: 13, damage: 16, interval: 0.62 },
];
export const TEAM_COLORS = ['#75ff32', '#ff352b'] as const;
