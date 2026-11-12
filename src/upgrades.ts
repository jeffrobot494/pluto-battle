import { WEAPON_ID } from './config.ts';
import type { Team } from './simulation.ts';

/**
 * Battlefield upgrades the player can hand out mid-battle. Weapons and vehicle
 * deployments share the rail and painted zone.
 * `cost` is reserved for the resource system; nothing charges it yet.
 */
export const UPGRADES = [
  { id: 'sniper', kind: 'weapon', name: 'Sniper rifle', label: 'Sniper', weapon: WEAPON_ID.sniper, color: '#7fd6ff', key: '1', cost: 0,
    icon: '<circle cx="10" cy="10" r="5.5"/><path d="M10 1.5v5M10 13.5v5M1.5 10h5M13.5 10h5"/>' },
  { id: 'shotgun', kind: 'weapon', name: 'Shotgun', label: 'Shotgun', weapon: WEAPON_ID.shotgun, color: '#ffb35a', key: '2', cost: 0,
    icon: '<path d="M2 10h6M8 10l9-5.5M8 10h9.5M8 10l9 5.5"/>' },
  { id: 'rocket', kind: 'weapon', name: 'Rocket launcher', label: 'Rocket', weapon: WEAPON_ID.rocket, color: '#ff6b3d', key: '3', cost: 0,
    icon: '<path d="M3 17l3-3M5 12l3 3M8 15l7.5-7.5c1.5-1.5 2-4 2-5.5-1.5 0-4 .5-5.5 2L4.5 11.5z"/><circle cx="13" cy="7" r="1.2"/>' },
  { id: 'truck', kind: 'vehicle', name: 'Armored truck', label: 'Truck', color: '#f4d985', key: '4', cost: 0,
    icon: '<path d="M2 13V7h9v2h4l3 3v3h-2m-4 0H8m-4 0H2v-2m10-4v3h6M5 7V5h5"/><circle cx="6" cy="15" r="2"/><circle cx="14" cy="15" r="2"/>' },
] as const;
export type Upgrade = typeof UPGRADES[number];
export type UpgradeId = Upgrade['id'];

/**
 * Which army a held zone upgrades. The sandbox gives equal control over both sides;
 * a tap always upgrades the soldier tapped, whatever the target.
 */
export const UPGRADE_TARGETS = [
  { id: 'plutonians', label: 'PLU', name: 'Plutonians', teams: [0] as readonly Team[], color: 'var(--green)' },
  { id: 'sectoids', label: 'SEC', name: 'Sectoids', teams: [1] as readonly Team[], color: 'var(--red)' },
  { id: 'both', label: 'BOTH', name: 'both armies', teams: [0, 1] as readonly Team[], color: '#ece6f0' },
] as const;
export type UpgradeTarget = typeof UPGRADE_TARGETS[number];
export type UpgradeTargetId = UpgradeTarget['id'];
/** Key that cycles the upgrade target. */
export const TARGET_KEY = 'S';
/** Ability-zone colour when no action is armed. */
export const NEUTRAL_ZONE_COLOR = '#ece6f0';

/** Milliseconds a still press must last before it becomes a hold. */
export const HOLD_DELAY_MS = 220;
/** Accelerating growth: small zones are easy to aim, and a long hold can cover the whole map. */
export function zoneRadius(seconds: number, maxRadius = Infinity) {
  const t = Math.max(0, seconds);
  return Math.min(maxRadius, 0.6 + 4 * t + 3 * t * t);
}
