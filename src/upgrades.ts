import { WEAPON_ID } from './config.ts';
import type { Team } from './simulation.ts';

/**
 * Battlefield upgrades the player can hand out mid-battle. Adding a weapon here
 * (after defining it in WEAPONS) adds a button to the upgrade menu.
 * `cost` is reserved for the resource system; nothing charges it yet.
 */
export const UPGRADES = [
  { id: 'sniper', name: 'Sniper rifle', label: 'Sniper', weapon: WEAPON_ID.sniper, color: '#7fd6ff', key: '1', cost: 0,
    icon: '<circle cx="10" cy="10" r="5.5"/><path d="M10 1.5v5M10 13.5v5M1.5 10h5M13.5 10h5"/>' },
  { id: 'shotgun', name: 'Shotgun', label: 'Shotgun', weapon: WEAPON_ID.shotgun, color: '#ffb35a', key: '2', cost: 0,
    icon: '<path d="M2 10h6M8 10l9-5.5M8 10h9.5M8 10l9 5.5"/>' },
] as const;
export type Upgrade = typeof UPGRADES[number];
export type UpgradeId = Upgrade['id'];

/** The army the player commands. */
export const PLAYER_TEAM: Team = 0;
/** Ability-zone colour when no action is armed. */
export const NEUTRAL_ZONE_COLOR = '#ece6f0';

/** Milliseconds a still press must last before it becomes a hold. */
export const HOLD_DELAY_MS = 220;
/** Accelerating growth: small zones are easy to aim, and a long hold can cover the whole map. */
export function zoneRadius(seconds: number, maxRadius = Infinity) {
  const t = Math.max(0, seconds);
  return Math.min(maxRadius, 0.6 + 4 * t + 3 * t * t);
}
