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

## Phase 8 validation (2026-11-12, partial)

Run on branch `truck-pathfinding` at eebf341. `scripts/truck-trace.mjs` now takes `--pathing on|off`. It also reports truck navigation time (graph slices plus truck fields) apart from infantry navigation, the peak step time, combat counters (contacts, rams, turret shots, wrecks) and recovery-ladder counts.

### Zero stuck trucks: fails

The corpus driver runs every archetype × 20 terrain seeds (101, 202, … 2020) × 4 workloads × areas 1 and 5, 180 s each. The system stopped it for low memory after 22 of 88 shards, all at ×5: packed and mixed on every map, about 1 h of wall time at 12 shards in parallel.

| | Runs | Runs failing | Stuck | Livelocks | Stops / truck-min | Stopped at end |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| packed ×5 | 220 | 104 | 42 | 116 | 0.011 | 84 |
| mixed ×5 | 220 | 36 | 20 | 33 | 0.010 | 47 |

Every map fails (failing runs out of 40, packed + mixed): blades 22, ice 21, badlands 18, terraces 16, canyon 13, craters 11, escarpment 10, fortress 10, mesas 8, massif 7, valley 4. Stops per truck-minute are far below the baseline (0.01 against 0.62), so the gate fails on short jams, not on trucks that stay parked.

**Pathing causes the stuck trucks; livelocks also happen without it.** Packed ×5 on canyon and blades, seeds 303 and 606:

| | Stuck | Livelocks |
| --- | ---: | ---: |
| pathing on | 4 | 4 |
| pathing off | 0 | 3 |

**What a stuck truck looks like.** The four stuck trucks above were traced at the moment they became stuck:

- **Truck against truck.** Each one is boxed in by an allied truck at one end, with another truck, rock or slope at the other. The planner returns `no-clear-route` and the truck holds. The ladder then retreats a few centimetres and crawls without moving.
- **Short jams.** Each jam clears 0.2–0.7 s after the 2 s stuck bound.
- **Why the ladder fails.** The yield step (`TruckRecovery.yieldOrder`) only sorts out two trucks that are *both* stalled. Here the blocking truck is idle (holding or parked, so its own stall clock keeps resetting), and no step asks it to move.
- **Blocker unknown while holding.** `blockerTruck` is only written while the truck is actually driving. A truck that holds because of a blocked plan keeps a stale blocker, or none.

The likely fix is a ladder step that asks an idle blocking truck (from the contact or from the planner's blocked check) to back out or replan. That is a behavior change, not tuning, so it is not in this pass. Routed trucks probably funnel into the same passes, which is why the jams appear only with pathing on.

### Navigation cost: fails (≤ +10% over infantry-only)

Mixed workload, canyon + blades, seeds 101 and 202, 120 s, ×1, both versions run side by side under the same load:

| | Infantry nav ms / tick | Truck nav ms / tick | Truck / infantry | Peak truck nav ms |
| --- | ---: | ---: | ---: | ---: |
| eebf341 | 0.629 | 0.483 | +77% | 14.7 |
| this commit | 0.621 | 0.294 | +47% | 17.2 |

Two changes in this commit; neither changes behavior:

- **Watched cells.** `TruckFields` used to snap every crewed truck to its cell with `nodeAt` on every tick. That is a full `driveClear` per cell tried, but the cells are only read when a field restarts, so it now snaps them only then.
- **Goal cells.** Enemy goal cells use `Navigation.goalAt`, which checks only walkability. The truck clearance test buys nothing for a cell that only marks where an enemy is.

Still over target. A profile of the remaining truck navigation time:

- **Firing seeds, 47%.** `seedFiring` scans every sight target for each candidate cell: about 57 targets × 5,400 candidates per build, at 600 cells per tick.
- **Field sweep, about 45%.**
- **Graph slices, about 9%.**

Field knobs, the same 4 runs measured together under heavier load (the ratio is the figure to compare):

| | Truck / infantry nav | Stops | Field exp / tick | Retreats |
| --- | ---: | ---: | ---: | ---: |
| period 60, budget 512 (current) | +47% | 10 | 171 | 71 |
| period 120 | +28% | 11 | 86 | 89 |
| budget 256 | +38% | 11 | 120 | 83 |

Neither knob reaches +10% on its own. Getting there needs a spatial index for the firing-seed search (or fewer truck firing seeds) together with a slower field cadence. Otherwise the target has to be restated against total step time. Left at current values pending that decision.

Over all ×5 corpus runs, which were on eebf341 before the fixes above, truck navigation was +127% over infantry on packed and +65% on mixed.

### Passing

- **Open field.** Flat maps build no truck graph, so pathing on and off are identical. Packed and sparse on flat, battle seeds 74319, 1 and 2, 26 s: same contacts, rams, shots and wrecks to the unit. Mixed on canyon, valley and ice (terrain seeds 74319, 1, 2, 26 s), on against off: contacts 22,203 / 22,309, rams 159 / 145, turret shots 8,220 / 8,478, wrecks 127 / 132. All within run-to-run noise.
- **Determinism.** Packed ×5 on blades and canyon, seed 202, 60 s, run twice: the summaries are identical apart from timings.
- **Suites.** `npm test` (130/130), `npm run test:balance` and `npm run test:upgrades:browser` pass with this commit.

### Still to run

- The other 66 corpus shards: sparse and trace at ×5, and everything at ×1.
- Stalls after a paint, from `peakStepMs` on the browser benchmark.
- The Pixel 10 capture.
- Re-running the stuck gate once the ladder can move an idle blocking truck.
