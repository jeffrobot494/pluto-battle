# Truck pathfinding validation

Measurements for the [truck pathfinding plan](truck-pathfinding-plan.md). Every figure here is from a desktop development machine in Node unless stated otherwise. The Pixel 10 run follows the existing phone capture procedure.

## How to reproduce

```sh
# Default size, then 5× area (about 2.24× each side; width, depth and frontline all scale)
node --experimental-strip-types --no-warnings scripts/truck-trace.mjs --map canyon,blades,escarpment \
  --terrain-seed 74319,101,202,303,404 --seconds 90 --quiet --area 1
node --experimental-strip-types --no-warnings scripts/truck-trace.mjs --map canyon,blades,escarpment \
  --terrain-seed 74319,101,202,303,404 --seconds 90 --quiet --area 5
```

`npm run debug:trucks` runs the same script. Under PowerShell, call `node` directly as shown, because npm drops the `--` separator. `--area` lifts the battlefield size limits for the script's process only. The browser benchmark takes `BATTLE_AREA=5` for the same purpose (`npm run benchmark:vehicles`).

Each run deploys 30 soldiers per army (battle seed 74319), paints every soldier of both armies into trucks at the start, and runs for 90 s or until one army wins. The metrics are:

- **Stops per truck-minute.** Stop episodes in the truck trace (a driven truck moves less than 0.25 units in 2 s), divided by minutes of crewed-truck time. This baseline still includes deliberate stops such as pickups. Phase 6 separates them.
- **Hold and Reverse share.** The share of crewed-truck ticks spent in `Maneuver.Hold` and `Maneuver.Reverse`.
- **Planning.** `metrics.planningMs` from truck tactics, per detailed decision and per simulation tick.
- **Navigation build.** One clean `new Navigation(terrain, radius)` on the final repaired terrain. `prepareTerrain` may build several graphs while it repairs a map.
- **Navigation per tick.** Wall time spent in `Simulation.updateNavigation` (infantry fields: seeding and Dijkstra sweep), divided by simulated ticks.

## Baseline (before truck pathfinding)

Canyon plus two archetypes with long walls (Bladed Ridges, Escarpment), five terrain seeds each: 15 runs per size.

| Area | Truck-min | Stops / truck-min | Stopped at end | Hold | Reverse | Planning µs / decision | Planning ms / tick | Nav build ms (mean / max) | Nav ms / tick | Cells (mean) |
|---|---|---|---|---|---|---|---|---|---|---|
| ×1 | 287.7 | 0.65 | 37 | 11.6% | 42.1% | 184 | 0.067 | 56.5 / 118.7 | 0.180 | 9,135 |
| ×5 | 296.0 | 0.62 | 45 | 9.0% | 44.8% | 358 | 0.133 | 334.5 / 540.5 | 0.543 | 45,162 |

By map at ×1 (stops per truck-minute, mean over five seeds): canyon 0.80, blades 0.72, escarpment 0.39. At ×5: canyon 0.69, blades 0.67, escarpment 0.41.

### What the baseline shows

- **Trucks spend over 40% of their time reversing** at both sizes, and a further 9–12% holding. That is the dead-end cycling the plan describes: Approach, contact, Reverse, Detour and back again.
- **37–45 trucks out of 300 were stuck when the run ended.** The zero-stuck gate in phase 6 is measured against these.
- **The infantry graph build is 6× slower at 5× area** (mean 335 ms, max 540 ms). It's far over the plan's 40 ms threshold, so the truck graph build must be split across the first frames of a battle and not run in one go, as section 2 of the plan requires. The truck predicate (`driveClear`) costs more than `canStand`/`canTraverse`, so expect the truck build to be slower again.
- **Planning per decision roughly doubles at 5× area** (184 → 358 µs). Larger maps put more groups and trucks in scope.
- **Infantry navigation per tick triples** (0.18 → 0.54 ms). That's the reference for the target "navigation ms per tick rises by no more than 10%".
