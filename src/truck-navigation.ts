import { Navigation, NavigationBuild, type NavigationProfile } from './navigation.ts';
import type { Terrain } from './terrain.ts';
import { TRUCK } from './vehicle-types.ts';

/** Disk radius the truck graph is built at: the controller's footprint disk plus a little turning slack. */
export const TRUCK_GRAPH_RADIUS = TRUCK.radius + 0.05;
/** Cells of truck graph work per simulation tick (see NavigationBuild). Counted in cells, so builds stay deterministic. */
export const TRUCK_BUILD_CELLS_PER_TICK = 300;

/** Trucks: the controller's own clearance test (`driveClear`), with room to swing the reach while turning. */
export function truckProfile(slope: number): NavigationProfile & { slope: number } {
  const radius = TRUCK_GRAPH_RADIUS;
  return {
    slope,
    stand: (terrain, x, z) => terrain.driveClear(x, z, x, z, radius, slope),
    traverse: (terrain, x, z, tx, tz) => terrain.driveClear(x, z, tx, tz, radius, slope),
    snap: (terrain, x, z, tx, tz) => terrain.driveClear(x, z, tx, tz, TRUCK.radius, slope),
    radius, openClearance: TRUCK.reach + 0.6, narrowPenalty: 8, elevationCost: 0.25,
    fireEye: TRUCK.turret.y, fireRaysPerTick: 160, fireCellsPerTick: 600,
  };
}

/** Whether a battle needs a truck graph at all: on flat, rockless ground a straight line is already the best route. */
export function needsTruckGraph(terrain: Terrain) { return terrain.maxHeight !== terrain.minHeight || terrain.rocks.length > 0; }

/**
 * Owns the truck graph for one battle. The graph is built a slice per tick and only published when complete,
 * so trucks keep the previous graph (or none) until then. A `truckSlope` change starts a fresh build.
 */
export class TruckGraph {
  readonly terrain: Terrain;
  /** The published graph, or null before the first build finishes. */
  navigation: Navigation | null = null;
  /** Slope limit of the published graph. */
  slope = NaN;
  private build: NavigationBuild | null = null;
  builds = 0;
  constructor(terrain: Terrain) { this.terrain = terrain; }
  /** True while a build for `slope` is still running, or the published graph is for another slope. */
  stale(slope: number) { return this.slope !== slope; }
  /** Advances (or starts) the build for `slope` by `budget` cells, publishing it when it completes. */
  update(slope: number, budget = TRUCK_BUILD_CELLS_PER_TICK) {
    if (!this.stale(slope)) { this.build = null; return; }
    if (!this.build || (this.build.profile as ReturnType<typeof truckProfile>).slope !== slope) this.build = new NavigationBuild(this.terrain, truckProfile(slope));
    if (!this.build.step(budget)) return;
    this.navigation = new Navigation(this.terrain, this.build.profile, this.build);
    this.slope = slope; this.build = null; this.builds++;
  }
  /** Runs any pending build to completion now (tests and tools). */
  finish(slope: number) { this.update(slope, Infinity); return this.navigation!; }
  /** Share of the current build done, 0–1; 1 when nothing is pending. */
  get progress() { return this.build ? this.build.progress : 1; }
}
