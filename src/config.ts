export const CONFIG = {
  step: 1 / 60,
  capacity: 2048,
  defaultPerTeam: 100,
  seed: 74319,
  field: { halfWidth: 28, halfDepth: 34, cellSize: 1.1 },
  soldier: { radius: 0.29, height: 1.12, health: 100, speed: 3.0 },
  hit: { duration: 0.12, intensity: 1 },
  corpseLifetime: 1.8,
  corpseRetentionGroup: 5,
  retainedCorpses: 1000,
  maxEffects: 768,
  physics: { gravity: 9.81, friction: 8, contactIterations: 4 },
  explosion: { radius: 4, damage: 35, impulse: 10, maxRadius: 20, effects: 64, duration: 0.45 },
  /** Rocket projectiles in flight and cosmetic smoke puffs; both are fixed pools. */
  rocket: { range: 16, speed: 18, radius: 4, damage: 35, impulse: 10, maxInFlight: 512, smoke: 1536, smokeLife: 0.9 },
} as const;

export interface Weapon {
  name: string;
  range: number;
  damage: number;
  interval: number;
  /** Single-use projectile weapon: removed from the inventory once fired. */
  consumable?: boolean;
}
export const WEAPONS: readonly Weapon[] = [
  { name: 'Laser rifle', range: 10.5, damage: 9, interval: 0.46 },
  // Developer API fixture for live upgrades; no purchase/upgrade UI in this slice.
  { name: 'Heavy laser', range: 13, damage: 16, interval: 0.62 },
  { name: 'Sniper rifle', range: 24, damage: 60, interval: 1.8 },
  { name: 'Shotgun', range: 4, damage: 45, interval: 0.7 },
  // Range and blast are live tuning; `interval` is the pause before the next gun can fire after launch.
  { name: 'Rocket launcher', range: 16, damage: 35, interval: 0.6, consumable: true },
];
export const WEAPON_ID = { rifle: 0, heavy: 1, sniper: 2, shotgun: 3, rocket: 4 } as const;
export const NO_WEAPON = 255;
export const TEAM_COLORS = ['#75ff32', '#ff352b'] as const;
