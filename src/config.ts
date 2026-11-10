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
  { name: 'Sniper rifle', range: 24, damage: 60, interval: 1.8 },
  { name: 'Shotgun', range: 4, damage: 45, interval: 0.7 },
];
export const WEAPON_ID = { rifle: 0, heavy: 1, sniper: 2, shotgun: 3 } as const;
export const NO_WEAPON = 255;
export const TEAM_COLORS = ['#75ff32', '#ff352b'] as const;
