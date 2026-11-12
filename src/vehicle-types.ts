/** Effect ID only; the mounted laser never enters an infantry inventory. */
export const TURRET_EFFECT = 5;

/** Local +Z is forward. The disks form the ground footprint; the boxes are the exposed hard parts. */
export const TRUCK = {
  name: 'Truck',
  controller: 'ground',
  disks: [-0.39, 0, 0.39],
  radius: 0.52,
  reach: 0.91,
  hull: { halfWidth: 0.49, halfLength: 0.85, bottom: 0.18, top: 0.76 },
  seats: [
    { name: 'Driver', x: -0.25, y: 0.29, z: 0.31 },
    { name: 'Gunner', x: 0, y: 0.48, z: -0.43 },
    { name: 'Passenger', x: 0.25, y: 0.36, z: 0.26 },
  ],
  turret: { effect: TURRET_EFFECT, damage: 'turretDamage', interval: 'turretInterval', x: 0, y: 0.97, z: -0.30, barrel: 0.58, radius: 0.24 },
} as const;

export const VEHICLE_TYPES = [TRUCK] as const;
export const DRIVER = 0, GUNNER = 1, PASSENGER = 2, SEAT_COUNT = 3;
export const TRUCK_TYPE = 0;
export const PULL_AWAY = 1.15;

export const Maneuver = { Exit: 0, Approach: 1, Pass: 2, Ram: 3, Escape: 4, Pickup: 5, Reverse: 6, Hold: 7, Detour: 8 } as const;
export type Maneuver = typeof Maneuver[keyof typeof Maneuver];

/** Optional output of a clearance check. A rock ID is its index in Terrain.rocks. */
export interface TruckBlocker {
  kind: 'map-edge' | 'rock' | 'slope' | 'infantry' | 'truck';
  id: number | null;
  x: number;
  z: number;
  atStart: boolean;
  padding: number;
}

export function angleDelta(to: number, from: number) {
  const d = (to - from) % (2 * Math.PI);
  return d > Math.PI ? d - 2 * Math.PI : d < -Math.PI ? d + 2 * Math.PI : d;
}
