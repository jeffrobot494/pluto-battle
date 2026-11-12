# Pluto Battle truck pathfinding plan

Give armored trucks real routes around walls, cliffs, rock fields and canyon chokepoints, and make sure no truck ever stays stuck (see [Zero stuck trucks](#6-zero-stuck-trucks)). Battlefields are growing to about 5× their current area (about 2.24× each side). Pathfinding must add no measurable frame cost and must stay deterministic so replays still work.

## Why trucks get stuck today

[Truck tactics](src/truck-tactics.ts) picks a heading from a short list of candidates every `truckDecisionInterval`. It simulates each one for 4 × 0.28 s, about 1.1 s or up to roughly 11 units at full speed. Every candidate is aimed relative to the straight line to an enemy group (`toward = atan2(target − truck)`). Then [the controller](src/truck-controller.ts) steers and sweeps the footprint each tick.

This works in the open, but nothing in it knows the map beyond that 1.1 s horizon:

- **Walls and cliffs.** A truck aiming at an enemy behind a ridge scores Approach as "progress" until the ridge blocks it. It then cycles through Detour, Reverse and Hold. Detour angles are at most ±1.5 rad from the straight line, so a route that first leads *away* from the enemy is never considered.
- **Canyons and chokepoints.** The only gap may lie well outside the sampled horizon.
- **Bigger maps make this worse.** At 5× area, more of the battle happens beyond the planner's horizon.

Moving obstacles are not the problem. Soldiers, other trucks, rams and crowd risk are already handled well by the local planner and the controller's sweeps, and this plan keeps all of that.

## Approach: truck flow fields on the existing navigation class

[Navigation](src/navigation.ts) already gives soldiers what trucks need:

- a static traversal graph over the terrain grid (0.65-unit cells)
- two multi-source Dijkstra fields, one per team, holding each cell's distance to the nearest enemy
- incremental rebuilds on a per-tick expansion budget, which is deterministic because the budget counts heap pops, not milliseconds

Trucks get a **second `Navigation` instance built with a truck profile**. They do not get a separate pathfinder. Sharing the class has one major benefit: when the [hierarchical navigation plan](hierarchical-navigation-plan.md) lands, trucks get sectors and portals for free.

### 1. Navigation profiles

Today `Navigation` is hard-wired to infantry: `canStand(radius + 0.035)` with `MAX_SLOPE`, `canTraverse` for edges, the `OPEN_CLEARANCE` and `NARROW_PENALTY` crowding constants, and firing-seed constants tuned to rifles. Replace these with a `NavigationProfile` passed to the constructor:

```ts
interface NavigationProfile {
  stand(terrain: Terrain, x: number, z: number): boolean;           // cell is usable
  traverse(terrain: Terrain, x: number, z: number, tx: number, tz: number): boolean; // edge is usable
  radius: number;            // snapping and nodeAt clearance
  openClearance: number;     // crowding: full speed above this
  narrowPenalty: number;     // crowding: cost multiplier at a one-cell slot
  elevationCost: number;     // currently 0.25 per unit climbed
  pathScratch: boolean;      // allocate findPath scratch (infantry only)
}
```

- **The infantry profile** reproduces today's behaviour exactly. Lock this down with an equality test across the terrain corpus before any truck work.
- **The truck profile:**
  - `stand` uses the controller's own clearance test, `driveClear` from the cell to itself, at radius `TRUCK.radius + 0.05` and slope limit `tuning.truckSlope`.
  - `traverse` runs `terrain.driveClear` between the two cell centres with the same radius and slope.
  - `openClearance` is about `TRUCK.reach + 0.6`. A truck needs room to swing its 0.91-unit reach while turning.
  - `narrowPenalty` is higher than infantry's, so trucks strongly prefer wide lanes.

  Because the field and the controller use the same predicate, the field never routes a truck somewhere the controller would refuse. The footprint's length is not part of the grid; it stays the job of the local sweeps.
- **Allocate path scratch lazily.** `pathScore`, `pathPriority`, `pathParent` and the path heap are only allocated when `findPath` is first called. Trucks never call it.

### 2. Building and owning the truck graph

- `VehicleFleet` owns a `truckNavigation: Navigation | null`. It stays `null` on flat, rockless battles, where a straight line is already optimal (matching `sim.navigation`, which is `null` without terrain).
- **Build it with the terrain, not on the first deploy.** Trucks can be painted mid-battle, and a build at that moment would stall the frame. Record `buildMs`. The infantry graph currently builds within map preparation. Measure both at 5× area in phase 1, and if the truck build exceeds about 40 ms on desktop, split it across the first frames of the battle.
- **`truckSlope` is a live tuning value.** When it changes, mark the truck graph stale and rebuild it on the next field restart. The new graph is published only when it is complete; until then trucks keep the old one. The rebuild is a rare tuning action, so a one-off cost is acceptable, but it must never run every tick.
- **Disconnected regions are expected.** The repair in `prepareTerrain` guarantees *infantry* connectivity. Slopes soldiers can climb may still be too steep for trucks, so `regions` on the truck graph are informational. Unreachable cells remain at `Infinity`, and trucks there fall back to today's behaviour (section 4).

### 3. Truck fields

One field per team, holding the driving distance to the nearest enemy.

- **Seeds.**
  - Every living enemy soldier, snapped to a truck-usable cell with the profile's `nodeAt` (ring search up to 3 cells). Soldiers often stand right next to rocks, in cells a truck cannot use.
  - Enemy trucks, which are soldiers' vehicles and targets for the turret.
  - Gather seeds in the same pass that collects infantry goals in `Simulation`, so soldier positions are read once.
- **Firing seeds at turret range.** Pass `effectiveTurretRange(tuning)` as `fireRange`, so cells with a turret shot at an enemy are seeded as vantage points. A truck can then drive to the foot of a cliff and shoot up at infantry it can never reach by road, which is exactly what armed trucks do today in the open. This uses the existing budgeted sight rays (`FIRE_RAYS_PER_TICK`, `FIRE_CELLS_PER_TICK`), which are per instance. Turret range is longer than rifle range, so cap candidate cells for the truck instance separately and check the count in the benchmark.
- **No congestion term.** Friendly crowding is already in the tactics score (`traffic`, `congestion`). Adding it to the field would count it twice and make headings jitter between rebuilds. Pass `weight = 0`.
- **Run fields only when trucks exist.** Skip `beginField` and `advance` for a team with no active crewed truck. With no trucks on the field, the cost is zero.
- **Rebuild cadence and budget.** Restart every 60 ticks like the infantry fields, with a separate budget of **512 expansions per tick** for both truck fields together. The real numbers come from phase 1, but at 5× area the grid is about 45k cells, of which about 70–80% are truck-usable.
- **Early stop, the main saving.** A multi-source sweep settles cells in order of distance from the enemy. Trucks only need values near themselves and along their lookahead. When a build starts, snapshot the cells of the team's active trucks. Stop the sweep once every one of those cells has been settled *and* the heap's minimum exceeds the largest of their distances by a margin (lookahead + 4 units). Until then, keep going, up to the full map. Unsettled cells are left at `Infinity` and treated as "unknown" (section 4). When the armies are engaged, most trucks are close to the enemy and a rebuild touches only a small part of the map. At 512 expansions per tick it then finishes in a handful of ticks. The worst case is a lone truck across the map from every enemy, which needs a full sweep: about 70k expansions for both teams, or about 140 ticks (2.3 s). That is acceptable because a distant truck needs heading accuracy, not freshness.
- **Publish by swapping buffers, not copying.** Today `distance.set(pending)` copies the whole map each rebuild. Swap front and back buffers instead, which is phase 2 of the hierarchical plan. If that phase hasn't landed when this work starts, do it here for both profiles and coordinate on `navigation.ts`.

### 4. Using the field in truck tactics

All changes are in `TruckTactics`. The controller doesn't change.

- **`routeHeading(v)`.** Call it once per `plan`. From the truck's cell, follow the steepest descent through the field for up to `truckRouteLookahead` units (default 8): at each step, take the neighbour with the lowest distance through an existing edge. Then string-pull: walk back from the end of that chain and pick the farthest cell whose straight segment from the truck passes `terrain.driveClear` at `TRUCK.radius`. Static obstacles only; moving ones are handled by the sweeps. The heading points at that cell. Cost: about 15 cell steps and 1–4 `driveClear` calls for each truck that plans, and at most `truckDecisionsPerTick` (8) trucks plan per tick.
- **When the field is used.** For each target group:
  - If the straight line to the group's nearest truck-usable cell is static-clear for the first 1.5× lookahead, keep today's `toward`. The open-field behaviour is unchanged.
  - Otherwise use `routeHeading`. Approach, both Pass offsets and the Detour fan are all built around this heading, not around `toward`.
  - Once a group is within turret range plus 2 units, the fight is local, and the existing standoff and lane logic aims at the group directly.
- **Scoring progress along the route.** In `add`, the `advance` term for Approach, Pass and Detour becomes `fieldDistance(start) − fieldDistance(end)` whenever both values are finite; otherwise it falls back to the straight-line distance. Each sample is one array read. Shortcuts across cells (a straight leg the field approximates with a staircase) score the same as following the staircase, so there's no reason to drive in a zig-zag. This removes the main trap of today's scoring: driving into a dead end no longer counts as progress.
- **Escape.** Add one Escape candidate that climbs the field: the neighbour of largest finite distance, string-pulled the same way. It retreats along drivable ground, not straight back into a wall.
- **Fallbacks, all tested.** The truck goes back to exactly today's behaviour when:
  - the field isn't ready yet
  - the truck's cell is unknown or unreachable (`Infinity`)
  - the truck graph is `null`
  - `truckPathing` is turned off

  Report the fallback reason in the trace.
- **Recovery is unchanged.** Blocked trucks still re-plan urgently. Their Detour fan now opens around `routeHeading`, so recovery searches toward the gap instead of toward the enemy behind the wall.

### 5. Tuning and diagnostics

- Add two entries to the **Vehicles** group in the Tuning panel, built with the existing `vehicle(...)` helper. Neither needs a restart.
  - `truckPathing`: a checkbox, on by default, for A/B checks.
  - `truckRouteLookahead`: 3–20 units.
- Add a `route` block to the truck trace: field ready or not, the truck cell's field distance, the chosen route heading, the string-pull target, and the fallback reason. Add metrics: `routeQueries`, `routeFallbacks` by reason, truck-field expansions per tick, early stops, full-sweep builds and graph `buildMs`.
- `npm run debug:trucks` prints how many stops happened with an active route compared with a fallback.

### 6. Zero stuck trucks

Pathfinding fixes the commonest cause, routing into a dead end, but it doesn't remove every cause. Getting to zero needs a precise definition of "stuck" and a fix for each cause that can't be routed around.

**Definition.** A truck is *stuck* when it has a driver, wants to move, and covers less than 0.25 units in 2 s of simulation time. "Wants to move" means `desiredSpeed ≠ 0`, or a Hold chosen as `no-clear-route`. The 0.25-unit, 2 s rule is the trace's existing one. Deliberate stops are excluded and reported separately:

- waiting at a pickup (`Pickup`, bounded by `truckReservationTime`)
- standing still while boarding
- driverless trucks

If any deliberate stop runs past its bound, it counts as stuck.

**Every cause and its fix.**

| Cause | Fix | Why it can't recur |
|---|---|---|
| Route into a static dead end | The truck fields (sections 1–4) | The field only leads through cells and edges that pass `driveClear` |
| Deployed where no route leads to the fight (an isolated plateau, a pocket between rocks) | **Placement uses the truck graph.** A truck may only be placed on a cell whose truck region reaches an enemy-reachable cell or a turret firing position. Placement retries as it does now if no such cell is nearby. | Every placed truck starts with a finite field distance |
| Long footprint wedged in a bend or slot that the disk-based grid let through | **Trail retreat.** Each truck records its last 40 poses, one every 0.5 units driven (about 20 units of road). When escalation reaches this step, the truck reverses along the recorded poses. The field also adds a penalty for cells narrower than `TRUCK.reach`. | Terrain doesn't change, so the poses the truck already drove through are statically clear |
| Two trucks blocking each other | **Yield order.** When the controller's blocker is another truck that is also blocked, the truck with the higher `id` yields: it trail-retreats while the other holds for 0.5 s. | One side always moves, and the order is deterministic |
| A friendly crowd that won't step aside | **Make way.** Allied soldiers in the truck's planned path receive a yield request. They get a sideways move through the existing `detourSide` push, at full strength. | Infantry already make way at low speed; this makes it active, not only a reaction to contact |
| Boxed in by bodies (soldiers of either army, against a wall or another truck) with nowhere to step | **Last resort, 1.5 s into a stall.** The truck creeps forward at crawl speed, and each soldier it touches is displaced to the nearest free standing spot found by the existing placement search. Soldiers take no damage. | There's always a spot: the search widens until it finds one, and soldiers never block static terrain |
| Field not ready, or the truck in an unknown cell | Fallback to today's planner, and trail retreat if that stalls | Same escalation as above |

**Escalation ladder.** The stall timer counts simulation time without 0.25 units of progress. Each step must hand over well before the 2 s threshold:

1. 0.2 s: urgent re-plan (the existing `requestRecovery`), with Detour now built around the route heading.
2. 0.6 s: yield order against other trucks, and a make-way request to allies.
3. 1.0 s: trail retreat for up to 3 units, then re-plan.
4. 1.5 s: last-resort crawl.

Any 0.25 units of progress resets the timer. A truck that keeps re-entering the ladder at the same spot is a *loop*, not a stall; the trace reports it as `livelock` and the validation counts it as stuck.

**Decided: the truck moves the soldiers.** The last-resort step displaces soldiers who could not move on their own. It's the only way to guarantee no stalls when a truck is physically surrounded, and it should be rare. Having the crew dismount after 4 s boxed in was considered and rejected.

## Cost summary at 5× area

All figures are estimates to be replaced by phase 1 measurements.

| | Cost |
|---|---|
| Truck graph build | One-off at map preparation. About the same as the infantry graph build, which is the same loop with a different predicate. |
| Truck fields per tick | ≤ 512 expansions while building; zero with no trucks; usually done in a few ticks with the early stop. |
| Planning per decision | One descent of about 15 cells and 1–4 `driveClear` calls, plus one array read per scored sample. |
| Memory | About 45k cells × roughly 80–110 B per cell for the graph plus two fields (path scratch not allocated) ≈ 4–5 MB. |
| Determinism | Expansion-counted budgets, a deterministic seed order (slot order) and deterministic heap tie-breaking. No time-based budgets. |

## Phases

Each phase lands as its own commit with `npm test` passing.

1. **Measurement.** Extend `scripts/vehicle-benchmark.mjs` and `scripts/truck-trace.mjs` with a 5× area map (lift the tuning limits for the scripts only). Record the baseline in `truck-pathfinding-validation.md`:
   - stops per truck-minute on canyon and on two archetypes with long walls
   - share of time in Hold and Reverse
   - tactics planning ms
   - infantry navigation build ms and the infantry ms per tick
2. **Profiles with no behaviour change.** Add `NavigationProfile` and the infantry profile, and allocate path scratch lazily. Assert that infantry `walkable`, `edges`, `regions` and field distances are identical to the current ones across the terrain corpus.
3. **Truck graph.** Add the truck profile and build it in `VehicleFleet` alongside the terrain. Tests:
   - every truck-graph edge passes the controller's `driveClear`
   - each truck-usable cell's clearance is at least the truck radius
   - a `truckSlope` change rebuilds and publishes atomically
   - `null` on flat battles
4. **Truck fields.** Seeding, turret firing seeds, the separate budget, early stop and buffer swap. Tests:
   - fields match a reference full Dijkstra on every cell the early stop settles
   - the budget is respected
   - no work happens without trucks
   - same seeds give identical fields
5. **Tactics integration behind `truckPathing`.** Add `routeHeading`, the straight-line-first rule, field-based `advance`, the field Escape candidate and the fallbacks. Tests in `tests/vehicles.test.ts`:
   - a truck behind a U-shaped rock wall reaches an enemy on the far side; it fails or stops today
   - a canyon entrance outside the old horizon is found
   - the open field picks the same routes as before
   - an unreachable plateau leads to a firing position at its foot
   - each fallback reason is triggered
6. **Zero stuck trucks.** Add the stuck definition to the trace and metrics, placement on the truck graph, the pose trail and trail retreat, truck yield order, make-way requests, the last-resort crawl and livelock detection. Tests in `tests/vehicles.test.ts`, one for each row of the cause table:
   - a truck placed on a truck-isolated plateau is rejected
   - a truck wedged in a bend it drove into backs out along its trail
   - two trucks nose to nose in a one-lane gap both get through
   - a truck inside a packed allied crowd moves within 2 s
   - a truck surrounded by soldiers against a wall moves within 2 s, and no soldier ends up overlapping anything
   - none of these tests ever reaches the 2 s stuck threshold
7. **Diagnostics and tuning.** Add the trace `route` block, the metrics and the two Tuning entries, then update the README's truck and diagnostics sections.
8. **Validate and tune.** Tune lookahead, `narrowPenalty`, the early-stop margin and the per-tick budget against the targets below, then record the results in the validation file.

## Validation targets

- **Zero stuck trucks.** Using the definition in section 6, no truck is stuck and no livelock occurs anywhere in the corpus:
  - every terrain archetype, with at least 20 terrain seeds each
  - all three vehicle workloads, plus a 5× area variant of each
  - runs of at least 3 minutes of simulation time

  This is a hard gate, not a percentage. Add it to `npm run debug:trucks` as a failing exit code, and keep a smaller version in `npm test`. Any stuck truck found later becomes a new regression test and a new row in the cause table.
- **No open-field regression.** On flat and open maps, contacts, rams, turret shots and wrecks in `vehicle-validation.md`'s three workloads stay within noise of today's numbers.
- **Performance.**
  - Navigation ms per tick, infantry and trucks together, rises by no more than 10% over the infantry-only figure at the same map size.
  - Tactics `planningMs` rises by no more than 15%.
  - No new frame stalls after a truck paint.
  - Desktop first; the Pixel 10 run follows the existing phone capture procedure.
- **Determinism.** Same seeds give the same battle, including session replays with trucks.
- **`npm test`, `npm run test:balance` and `npm run test:upgrades:browser` pass.**

## Out of scope

- Raising the battlefield size limits in Tuning, which is a separate change.
- Hierarchical sectors. The 5× area doesn't need them, and the [hierarchical plan](hierarchical-navigation-plan.md) covers both profiles once it lands.
- Per-truck or per-squad goals (for example, a truck routed to a specific soldier).
- Moving vehicles in the field, such as wrecks as obstacles. The local sweeps handle these.

## Open questions

- **Lookahead length.** About 8 units matches the old horizon at cruise speed. Longer cuts corners more aggressively but string-pulls more `driveClear` calls.
- **Firing seeds for unarmed trucks.** A truck with no gunner currently follows the same team field toward turret-range vantage points. If unarmed trucks look odd stopping at range, they could fall back to the straight-line logic once within range.
- **Ordering with the hierarchical plan.** Both change `navigation.ts`. If the hierarchical work starts first, phases 2 and 4 here (profiles and buffer swap) should merge into its phase 2 and not be duplicated.
