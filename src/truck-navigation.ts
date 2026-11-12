import { Navigation, NavigationBuild, type NavigationProfile } from './navigation.ts';
import type { Terrain } from './terrain.ts';
import { DRIVER as DRIVER_SEAT, TRUCK } from './vehicle-types.ts';
import type { VehicleFleet } from './vehicles.ts';

/** Disk radius the truck graph is built at: the controller's footprint disk plus a little turning slack. */
export const TRUCK_GRAPH_RADIUS = TRUCK.radius + 0.05;
/** Cells of truck graph work per simulation tick (see NavigationBuild). Counted in cells, so builds stay deterministic. */
export const TRUCK_BUILD_CELLS_PER_TICK = 300;
/** Field expansions per tick, both teams together. Counted in heap pops, so field builds stay deterministic. */
export const TRUCK_FIELD_BUDGET = 512;
/** Ticks between truck field restarts (the infantry cadence). */
export const TRUCK_FIELD_PERIOD = 60;
/** Field units settled past the farthest truck beyond its lookahead, so a truck's route never runs into unknown cells. */
export const TRUCK_FIELD_MARGIN = 4;

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

/**
 * The two truck fields (driving distance to the nearest enemy, per team) on the published truck graph.
 * Seeds are enemy soldiers on foot and enemy trucks, snapped to truck-usable cells, plus cells with a turret
 * shot at them. A team's field only runs while it has a crewed truck, and each build stops once it has
 * settled the cells around that team's trucks.
 */
export class TruckFields {
  private readonly fleet: VehicleFleet;
  private readonly goals: Int32Array[];
  private readonly watch: Int32Array[];
  private readonly goalCount = [0, 0];
  private readonly watchCount = [0, 0];
  private navigation: Navigation | null = null;
  /** Field builds started, per team (diagnostics and tests). */
  readonly builds = [0, 0];
  constructor(fleet: VehicleFleet) {
    this.fleet = fleet;
    const n = fleet.sim.capacity;
    this.goals = [new Int32Array(2 * n), new Int32Array(2 * n)]; this.watch = [new Int32Array(n), new Int32Array(n)];
  }
  /** The published field for `team`, or null while it has none yet (or the graph is still building). */
  ready(team: number) { return this.navigation?.fields[team].ready ? this.navigation : null; }
  /** Restarts due fields and advances the running ones by the shared budget. Call once per tick. */
  update(navigation: Navigation | null) {
    if (!navigation) return;
    const fleet = this.fleet, sim = fleet.sim, fresh = navigation !== this.navigation;
    this.navigation = navigation;
    const restart = (team: number) => {
      const f = navigation.fields[team];
      return !f.building && (fresh || !f.ready || sim.tick % TRUCK_FIELD_PERIOD === 0);
    };
    const due = [restart(0), restart(1)];
    if (due[0] || due[1]) {
      // Crewed trucks per team; their cells are where the field must be known. A team with none skips its field.
      // Snapped only on a restart: stopWhenSettled reads them once, and nodeAt is a driveClear per cell tried.
      this.watchCount[0] = this.watchCount[1] = 0;
      for (let k = 0; k < fleet.count; k++) {
        const v = fleet.active[k], team = fleet.team[v];
        if (!due[team] || fleet.hp[v] <= 0 || fleet.seat(v, DRIVER_SEAT) < 0) continue;
        this.watch[team][this.watchCount[team]++] = navigation.nodeAt(fleet.x[v], fleet.z[v]);
      }
      for (let team = 0; team < 2; team++) if (!this.watchCount[team]) due[team] = false;
    }
    if (due[0] || due[1]) {
      this.goalCount[0] = this.goalCount[1] = 0;
      for (let i = 0; i < sim.used; i++) if (sim.hp[i] > 0 && fleet.ride[i] < 0) {
        const team = 1 - sim.team[i]; if (!due[team]) continue;
        this.goals[team][this.goalCount[team]++] = navigation.goalAt(sim.x[i], sim.z[i]);
      }
      for (let k = 0; k < fleet.count; k++) {
        const v = fleet.active[k], team = 1 - fleet.team[v];
        if (due[team] && fleet.hp[v] > 0) this.goals[team][this.goalCount[team]++] = navigation.goalAt(fleet.x[v], fleet.z[v]);
      }
      const range = fleet.range ?? 0, margin = sim.tuning.truckRouteLookahead + TRUCK_FIELD_MARGIN;
      for (let team = 0; team < 2; team++) if (due[team] && navigation.beginField(team, this.goals[team], this.goalCount[team], undefined, 0, 0, range)) {
        navigation.stopWhenSettled(team, this.watch[team], this.watchCount[team], margin);
        this.builds[team]++;
      }
    }
    const [a, b] = navigation.fields;
    if (!a.building && !b.building) { navigation.expansions = 0; return; }
    const wasBuilding = [a.building, b.building];
    navigation.advance(TRUCK_FIELD_BUDGET);
    const m = fleet.metrics;
    m.fieldExpansions += navigation.expansions; m.peakFieldExpansions = Math.max(m.peakFieldExpansions, navigation.expansions);
    for (let team = 0; team < 2; team++) {
      const f = navigation.fields[team];
      if (wasBuilding[team] && !f.building) { if (f.complete) m.fieldFullSweeps++; else m.fieldEarlyStops++; }
    }
  }
}
