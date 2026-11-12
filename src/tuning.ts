import { CONFIG, WEAPONS } from './config.ts';
import { readSetting, writeSetting } from './settings-store.ts';

export const DEFAULT_TUNING = {
  count: CONFIG.defaultPerTeam as number, health: CONFIG.soldier.health as number,
  damage: WEAPONS[0].damage, range: WEAPONS[0].range, fireInterval: WEAPONS[0].interval,
  speed: CONFIG.soldier.speed as number, radius: CONFIG.soldier.radius as number,
  halfWidth: CONFIG.field.halfWidth as number, halfDepth: CONFIG.field.halfDepth as number,
  frontline: 10.4, columns: 10, columnSpacing: 1.04, rowSpacing: 0.88,
  jitterX: 0.04, jitterZ: 0.06, seed: CONFIG.seed as number,
  searchPadding: 5, searchInterval: 1, initialSearchDelay: 0.14, reactionDelay: 0.5,
  avoidanceDistance: 1.05, avoidanceStrength: 0.75, shallowAngle: 0.65, wideAngle: 1.2,
  moveRetryDelay: 0.2, flankStuckTime: 0.5, flankTimeout: 4, flankSpacing: 0.9, congestionCost: 5,
  flashDuration: CONFIG.hit.duration as number, flashIntensity: CONFIG.hit.intensity as number,
  gravity: CONFIG.physics.gravity as number, explosionRadius: CONFIG.explosion.radius as number,
  keepCorpses: 0,
  explosionDamage: CONFIG.explosion.damage as number, explosionImpulse: CONFIG.explosion.impulse as number,
  twistThreshold: 12, twistCoast: 0.4,
  rocketRange: CONFIG.rocket.range as number, rocketSpeed: CONFIG.rocket.speed as number,
  rocketRadius: CONFIG.rocket.radius as number, rocketDamage: CONFIG.rocket.damage as number, rocketImpulse: CONFIG.rocket.impulse as number,
  truckPlacementDistance: 6, truckPlacementRetry: 14, truckRecruitRadius: 5, truckBoardingSpeed: 1.4, truckReservationTime: 3,
  truckHealth: 260, truckCrewArmor: 0.42, truckSpeed: 10.5, truckAcceleration: 8, truckBraking: 15,
  truckReverseSpeed: 3.8, truckTurnRate: 2.8, truckGrip: 9, truckSlope: 0.68, truckPathing: 1, truckRouteLookahead: 8,
  turretRangePosition: 77, turretDamage: 20, turretInterval: 0.36,
  truckStandoff: 0.65, truckCrowdRisk: 1, truckFriendlyRisk: 3.5, truckRamAggression: 1.1,
  truckDecisionInterval: 1, truckCommitment: 0.8, truckDecisionsPerTick: 8,
  truckRamSpeed: 4.5, truckRamDamage: 19, truckRamImpulse: 2.2, truckImpactLoss: 0.18,
  truckBlastRadius: 3.4, truckBlastDamage: 64, truckBlastImpulse: 10,
};
export type TuningKey = keyof typeof DEFAULT_TUNING;
export type TuningValues = Record<TuningKey, number>;
export interface TuningDefinition {
  key: TuningKey; label: string; group: string; min: number; max: number; step: number;
  unit: string; restart: boolean; help: string; checkbox?: boolean;
}

function vehicle(key: TuningKey, label: string, min: number, max: number, step: number, unit: string, help: string): TuningDefinition {
  return { key, label, group: 'Vehicles', min, max, step, unit, restart: false, help };
}

export const TUNING: readonly TuningDefinition[] = [
  { key: 'gravity', label: 'Gravity strength', group: 'Physics & explosions', min: 0, max: 50, step: 0.1, unit: 'u/s²', restart: false, help: 'Downward acceleration. Applies immediately to airborne bodies; zero enables weightless testing.' },
  { key: 'keepCorpses', label: 'Keep settled corpses', group: 'Physics & explosions', min: 0, max: 1, step: 1, unit: '', restart: false, checkbox: true, help: 'Keep one in five fallen soldiers visible until the next battle. Toggle anytime to show or hide settled bodies.' },
  { key: 'explosionRadius', label: 'Explosion radius', group: 'Physics & explosions', min: 0.5, max: 20, step: 0.1, unit: 'u', restart: false, help: 'Radius of the next test explosion, measured in all three dimensions.' },
  { key: 'explosionDamage', label: 'Explosion damage', group: 'Physics & explosions', min: 0, max: 1000, step: 1, unit: 'HP', restart: false, help: 'Damage once to every living soldier inside the sphere, including allies. Zero tests motion only.' },
  { key: 'explosionImpulse', label: 'Explosion impulse', group: 'Physics & explosions', min: 0, max: 40, step: 0.1, unit: 'u/s', restart: false, help: 'Peak velocity change for unit-mass infantry. Falls linearly to zero at the sphere edge.' },
  { key: 'count', label: 'Soldiers per army', group: 'Deployment', min: 1, max: 500, step: 1, unit: '', restart: true, help: 'Changes both armies. Allow enough columns and field depth for the deployment.' },
  { key: 'seed', label: 'Battle seed', group: 'Deployment', min: 0, max: 4294967295, step: 1, unit: '', restart: true, help: 'Controls deployment and combat randomness. Terrain seed appears in diagnostics; explicit replay preserves both seeds.' },
  { key: 'halfWidth', label: 'Battlefield half-width', group: 'Deployment', min: 6, max: 50, step: 0.5, unit: 'u', restart: true, help: 'Room on each side of the center line. Full width is twice this.' },
  { key: 'halfDepth', label: 'Battlefield half-depth', group: 'Deployment', min: 8, max: 65, step: 0.5, unit: 'u', restart: true, help: 'Room in each direction of advance. Full depth is twice this.' },
  { key: 'health', label: 'Soldier health', group: 'Soldiers & weapons', min: 10, max: 1000, step: 1, unit: 'HP', restart: false, help: 'Rescales surviving soldiers proportionally. Dead soldiers stay dead.' },
  { key: 'damage', label: 'Rifle damage', group: 'Soldiers & weapons', min: 1, max: 100, step: 1, unit: 'HP', restart: false, help: 'Damage per hit for both armies’ standard rifles.' },
  { key: 'range', label: 'Rifle range', group: 'Soldiers & weapons', min: 2, max: 30, step: 0.1, unit: 'u', restart: false, help: 'Longer range lets more ranks fire simultaneously.' },
  { key: 'fireInterval', label: 'Time between shots', group: 'Soldiers & weapons', min: 0.05, max: 3, step: 0.01, unit: 's', restart: false, help: 'Lower means faster fire. Preserves progress through the current cooldown.' },
  { key: 'speed', label: 'Movement speed', group: 'Soldiers & weapons', min: 0.2, max: 10, step: 0.1, unit: 'u/s', restart: false, help: 'Speed of advance and movement around neighbors.' },
  { key: 'radius', label: 'Collision radius', group: 'Soldiers & weapons', min: 0.1, max: 0.5, step: 0.01, unit: 'u', restart: true, help: 'Changes capsule size and solid footprint. Deployment spacing must accommodate it.' },
  { key: 'rocketRange', label: 'Rocket range', group: 'Rocket launcher', min: 2, max: 40, step: 0.1, unit: 'u', restart: false, help: 'Distance at which a soldier fires his single rocket. He uses it at the first chance, before any other gun.' },
  { key: 'rocketSpeed', label: 'Rocket speed', group: 'Rocket launcher', min: 2, max: 80, step: 0.5, unit: 'u/s', restart: false, help: 'Flight speed. Rockets fly straight at the lowest visible part of the target, so slow rockets land where he was standing.' },
  { key: 'rocketRadius', label: 'Rocket blast radius', group: 'Rocket launcher', min: 0.5, max: 20, step: 0.1, unit: 'u', restart: false, help: 'Explosion radius on impact, measured in all three dimensions. Hits friends, foes and the shooter.' },
  { key: 'rocketDamage', label: 'Rocket blast damage', group: 'Rocket launcher', min: 0, max: 1000, step: 1, unit: 'HP', restart: false, help: 'Damage once to every living soldier inside the blast, including allies.' },
  { key: 'rocketImpulse', label: 'Rocket blast impulse', group: 'Rocket launcher', min: 0, max: 40, step: 0.1, unit: 'u/s', restart: false, help: 'Peak velocity change at the blast center, falling linearly to zero at the edge.' },
  { key: 'frontline', label: 'Frontline distance', group: 'Formation', min: 0.6, max: 30, step: 0.1, unit: 'u', restart: true, help: 'Each army starts this far from center; the initial gap is twice this.' },
  { key: 'columns', label: 'Formation columns', group: 'Formation', min: 1, max: 64, step: 1, unit: '', restart: true, help: 'More columns give a wider, shallower formation.' },
  { key: 'columnSpacing', label: 'Column spacing', group: 'Formation', min: 0.25, max: 4, step: 0.01, unit: 'u', restart: true, help: 'Distance between adjacent columns.' },
  { key: 'rowSpacing', label: 'Row spacing', group: 'Formation', min: 0.25, max: 4, step: 0.01, unit: 'u', restart: true, help: 'Distance between ranks; affects congestion behind the frontline.' },
  { key: 'jitterX', label: 'Horizontal randomness', group: 'Formation', min: 0, max: 0.5, step: 0.01, unit: '±u', restart: true, help: 'Maximum random sideways offset from the deployment grid.' },
  { key: 'jitterZ', label: 'Forward randomness', group: 'Formation', min: 0, max: 0.5, step: 0.01, unit: 'u', restart: true, help: 'Random additional distance behind the starting frontline.' },
  { key: 'searchPadding', label: 'Search beyond range', group: 'Targeting', min: 0, max: 15, step: 0.1, unit: 'u', restart: false, help: 'Extra distance at which soldiers can pick an enemy to approach.' },
  { key: 'searchInterval', label: 'Target search interval', group: 'Targeting', min: 0.03, max: 3, step: 0.01, unit: 's', restart: false, help: 'Average time between looks around for a better or nearer enemy (each look varies ±25%). Longer is cheaper and less robotic; valid firing targets are retained.' },
  { key: 'initialSearchDelay', label: 'Initial search delay', group: 'Targeting', min: 0, max: 2, step: 0.01, unit: 's', restart: true, help: 'Maximum random delay before each newly deployed soldier’s first search.' },
  { key: 'reactionDelay', label: 'Reaction delay', group: 'Targeting', min: 0, max: 2, step: 0.01, unit: 's', restart: false, help: 'Average pause after a firing target dies before a soldier picks the next one (varies ±50%). Zero retargets on the next tick.' },
  { key: 'avoidanceDistance', label: 'Neighbor avoidance distance', group: 'Crowd steering', min: 0.3, max: 3, step: 0.05, unit: 'u', restart: false, help: 'Distance at which neighbors influence steering. Solid collision always remains active.' },
  { key: 'avoidanceStrength', label: 'Neighbor avoidance strength', group: 'Crowd steering', min: 0, max: 3, step: 0.05, unit: '', restart: false, help: 'Higher values encourage spreading; lower values allow tighter crowds.' },
  { key: 'shallowAngle', label: 'Shallow detour angle', group: 'Crowd steering', min: 0.1, max: 1.5, step: 0.05, unit: 'rad', restart: false, help: 'First pair of left/right alternatives when forward motion is blocked.' },
  { key: 'wideAngle', label: 'Wide detour angle', group: 'Crowd steering', min: 0.2, max: 1.57, step: 0.05, unit: 'rad', restart: false, help: 'Wider left/right alternatives, followed by a sideways attempt in both directions.' },
  { key: 'moveRetryDelay', label: 'Blocked-move wait', group: 'Crowd steering', min: 0, max: 2, step: 0.01, unit: 's', restart: false, help: 'Average wait before trying to move again after every way forward was blocked (varies ±50%). Zero retries every tick.' },
  { key: 'flankStuckTime', label: 'Flank stuck time', group: 'Crowd steering', min: 0.1, max: 3, step: 0.05, unit: 's', restart: false, help: 'How long a soldier must make almost no progress before it heads around the edge of its own firing line.' },
  { key: 'flankTimeout', label: 'Flank commitment', group: 'Crowd steering', min: 0.5, max: 12, step: 0.1, unit: 's', restart: false, help: 'Maximum time spent pursuing one flank position before choosing again.' },
  { key: 'flankSpacing', label: 'Flank spacing', group: 'Crowd steering', min: 0.4, max: 4, step: 0.05, unit: 'u', restart: false, help: 'Distance beyond the firing line edge where blocked soldiers aim; each repeated block adds more.' },
  { key: 'congestionCost', label: 'Congestion avoidance', group: 'Crowd steering', min: 0, max: 10, step: 0.1, unit: '', restart: false, help: 'Extra path cost through densely packed friendly cells, so soldiers spread onto alternate routes. Zero routes everyone down the single shortest path.' },
  { key: 'flashDuration', label: 'Damage-flash duration', group: 'Hit feedback', min: 0.02, max: 0.5, step: 0.01, unit: 's', restart: false, help: 'Duration of Pluto’s white hit flash.' },
  { key: 'flashIntensity', label: 'Damage-flash intensity', group: 'Hit feedback', min: 0.1, max: 3, step: 0.1, unit: '', restart: false, help: 'Brightness of the emissive hit flash.' },
  { key: 'twistThreshold', label: 'Twist start angle', group: 'Camera', min: 0, max: 45, step: 1, unit: '°', restart: false, help: 'How far two fingers must twist before the camera starts turning. Higher keeps pinch-to-zoom from rotating the view by accident.' },
  { key: 'twistCoast', label: 'Twist coasting', group: 'Camera', min: 0, max: 2, step: 0.05, unit: 's', restart: false, help: 'How long the camera keeps spinning after a twist is released mid-motion. Zero stops the moment fingers lift; touching the screen always stops it.' },
  vehicle('truckPlacementDistance', 'Placement distance', 0.5, 15, 0.1, 'u', 'How far from a crew the game searches for open ground and a clear exit.'),
  vehicle('truckPlacementRetry', 'Placement retry window', 0.5, 60, 0.1, 's', 'How long a painted crew waits for a spot. Waiting soldiers keep fighting.'),
  vehicle('truckRecruitRadius', 'Recruitment radius', 0.5, 12, 0.1, 'u', 'How far a truck looks for soldiers to fill empty seats.'),
  vehicle('truckBoardingSpeed', 'Boarding speed limit', 0.1, 5, 0.1, 'u/s', 'Maximum chassis speed at which a recruit can board.'),
  vehicle('truckReservationTime', 'Seat reservation timeout', 0.5, 12, 0.1, 's', 'How long a truck waits for a recruit to reach a reserved seat.'),
  vehicle('truckHealth', 'Hull health', 25, 1500, 1, 'HP', 'Rescales surviving hulls proportionally.'),
  vehicle('truckCrewArmor', 'Crew armor', 0, 0.95, 0.01, '', 'Fraction of incoming damage absorbed while seated. Does not protect against the truck’s own destruction.'),
  vehicle('truckSpeed', 'Top speed', 2, 24, 0.1, 'u/s', 'Maximum forward speed on open ground.'),
  vehicle('truckAcceleration', 'Acceleration', 1, 24, 0.1, 'u/s²', 'How quickly a driver can build forward or reverse speed.'),
  vehicle('truckBraking', 'Braking', 1, 32, 0.1, 'u/s²', 'How quickly the truck slows when a driver brakes or the driver’s seat is empty.'),
  vehicle('truckReverseSpeed', 'Reverse speed', 0.5, 10, 0.1, 'u/s', 'Maximum speed while backing out.'),
  vehicle('truckTurnRate', 'Turn rate', 0.5, 5, 0.05, 'rad/s', 'Maximum steering rate. Faster travel makes turns wider.'),
  vehicle('truckGrip', 'Lateral grip', 1, 24, 0.1, '/s', 'How quickly the tires pull a slide back in line with the chassis.'),
  vehicle('truckSlope', 'Slope limit', 0.1, 1.2, 0.01, '', 'Steepest grade the chassis can cross, in rise per unit of run.'),
  { ...vehicle('truckPathing', 'Truck pathfinding', 0, 1, 1, '', 'Drivers follow a driving-distance map around walls, cliffs and canyons. Off aims straight at the enemy, as before, for A/B checks.'), checkbox: true },
  vehicle('truckRouteLookahead', 'Route lookahead', 3, 20, 0.5, 'u', 'How far along the truck route a driver aims, in driving distance. Longer cuts corners harder but checks more ground.'),
  vehicle('turretRangePosition', 'Turret range', 1, 99, 1, '%', 'Position between the live rifle and rocket ranges. The effective range is shown in world units.'),
  vehicle('turretDamage', 'Turret damage', 1, 150, 1, 'HP', 'Damage per mounted laser hit, before crew armor.'),
  vehicle('turretInterval', 'Turret shot interval', 0.05, 3, 0.01, 's', 'Cooldown of the mounted laser, separate from the crew’s weapons.'),
  vehicle('truckStandoff', 'Turret standoff', 0.1, 0.99, 0.01, '', 'Desired firing distance within the gap between rifle and turret range. Higher values keep more distance.'),
  vehicle('truckCrowdRisk', 'Crowd risk', 0, 5, 0.05, '', 'How strongly drivers avoid return fire and dense groups along a route.'),
  vehicle('truckFriendlyRisk', 'Friendly risk', 0, 15, 0.1, '', 'How strongly drivers avoid driving through allied soldiers.'),
  vehicle('truckRamAggression', 'Ram aggression', 0, 4, 0.05, '', 'How much drivers favor a charge when they have a run-up. Zero disables deliberate charges.'),
  vehicle('truckDecisionInterval', 'Decision interval', 0.2, 4, 0.05, 's', 'Time between routine driving decisions, staggered across trucks.'),
  vehicle('truckCommitment', 'Route commitment', 0.2, 4, 0.05, 's', 'How long drivers stick to a clear route before considering a change.'),
  vehicle('truckDecisionsPerTick', 'Decisions per tick', 1, 32, 1, '', 'Shared limit on detailed driving decisions in one simulation tick.'),
  vehicle('truckRamSpeed', 'Ram threshold', 1, 15, 0.1, 'u/s', 'Closing speed in the contact direction needed to deal ram damage.'),
  vehicle('truckRamDamage', 'Ram damage scaling', 0, 80, 0.1, 'HP/(u/s)', 'Damage per unit of closing speed above the threshold.'),
  vehicle('truckRamImpulse', 'Ram impulse scaling', 0, 8, 0.1, '', 'Knockback per unit of closing speed above the threshold.'),
  vehicle('truckImpactLoss', 'Impact speed loss', 0, 0.9, 0.01, '', 'Fraction of chassis speed lost with each ram.'),
  vehicle('truckBlastRadius', 'Destruction blast radius', 0.5, CONFIG.explosion.maxRadius, 0.1, 'u', 'Radius of the blast when the hull is destroyed.'),
  vehicle('truckBlastDamage', 'Destruction blast damage', 0, 1000, 1, 'HP', 'Damage to each former rider and to nearby soldiers and hulls.'),
  vehicle('truckBlastImpulse', 'Destruction blast impulse', 0, 40, 0.1, 'u/s', 'Peak blast velocity change. Former riders are thrown from their seats.'),
];

export function effectiveTurretRange(values: Pick<TuningValues, 'range' | 'rocketRange' | 'turretRangePosition'>): number | null {
  const range = values.range + (values.rocketRange - values.range) * values.turretRangePosition / 100;
  return range > values.range && range < values.rocketRange ? range : null;
}

// A legacy save with conflicting ranges still works for infantry battles.
export const TURRET_RANGE_ERROR = 'Laser rifle range must be shorter than rocket range to deploy trucks.';

export function validValue(key: TuningKey, value: number) {
  const def = TUNING.find(d => d.key === key)!;
  return Number.isFinite(value) && value >= def.min && value <= def.max && (def.step !== 1 || Number.isInteger(value));
}
export function deploymentError(v: TuningValues): string | null {
  for (const def of TUNING) if (!validValue(def.key, v[def.key])) return `${def.label} must be between ${def.min} and ${def.max}.`;
  const diameter = v.radius * 2 + 0.002;
  const columns = Math.min(v.columns, v.count), rows = Math.ceil(v.count / v.columns);
  if (columns > 1 && v.columnSpacing - v.jitterX * 2 < diameter) return 'Increase column spacing or reduce radius / horizontal randomness to avoid overlapping spawns.';
  if (rows > 1 && v.rowSpacing - v.jitterZ < diameter) return 'Increase row spacing or reduce radius / forward randomness to avoid overlapping spawns.';
  // Conservative envelope includes every possible seeded offset, not only one lucky seed.
  const halfFormation = (columns - 1) / 2 * v.columnSpacing;
  if (halfFormation + v.jitterX + v.radius > v.halfWidth) return 'The formation is wider than the battlefield. Increase half-width or reduce columns / column spacing.';
  if (v.frontline + (rows - 1) * v.rowSpacing + v.jitterZ + v.radius > v.halfDepth) return 'The formation is deeper than the battlefield. Increase half-depth / columns, or reduce frontline distance / row spacing.';
  if (v.frontline * 2 < diameter) return 'Increase frontline distance so the opposing armies do not overlap.';
  return null;
}
const storageKey = 'pluto-battle-tuning-v1';
export function loadTuning(): TuningValues {
  try {
    const saved = JSON.parse(readSetting(storageKey) ?? '{}'), values = { ...DEFAULT_TUNING };
    for (const { key } of TUNING) if (validValue(key, saved[key])) values[key] = saved[key];
    return deploymentError(values) ? { ...DEFAULT_TUNING } : values;
  } catch { return { ...DEFAULT_TUNING }; }
}
export function saveTuning(values: TuningValues) {
  if (deploymentError(values)) return;
  try { writeSetting(storageKey, JSON.stringify(values)); } catch { /* In-memory tuning still works when browser storage is unavailable. */ }
}
