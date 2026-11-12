# Pluto Battle hierarchical navigation plan

Make army routing cost depend on where the soldiers are instead of on map area, so battlefields can grow to about 10× their current width and depth (100× the area, roughly 560 × 680 units and 900k navigation cells) without slower routing or heavier ticks.

## Why the current fields stop scaling

[Navigation](src/navigation.ts) keeps two multi-source Dijkstra fields, one per team. Each field holds the distance from every cell to the nearest enemy (or to a firing position with a shot at one). [The simulation](src/simulation.ts) restarts both fields every 60 ticks and advances them by 1024 heap expansions per tick. Soldiers step toward the neighbouring cell with the lowest distance.

Everything in that loop covers the full map:

- **The sweep visits every reachable cell.** One full rebuild of both fields takes about 2 × cells / 1024 ticks. Measured on the default 100 v 100 battle, that is 9.1k cells and about 0.3 s now, 36k cells and 1.2 s at 2× scale, and 81k cells and 2.6 s at 3×. At 10× it would take about 30 s, so routing would always be out of date.
- **Setup work also covers the full map on every rebuild.** `beginField` fills `pending` and clears the heap's `positions`. `computeCongestion` fills and blurs map-sized arrays. The finished sweep copies `pending` into `distance`.
- **Memory grows with area.** Each field uses about 29 bytes per cell, and `Navigation` uses about 54 bytes per cell of its own. At 900k cells that adds up to about 100 MB, which is too much for a phone.
- **`findPath` gives up after 12,000 nodes.** It would fail on long routes across a large map.

Per-soldier work is already local: the spatial grid, sight rays, collisions and targeting don't depend on map size. Routing is the only system that has to change.

## Approach: sectors, portals and on-demand fine fields

This is the sector-based flow-field approach used in large-scale RTS games (Emerson, "Crowd Pathfinding and Steering Using Flow Field Tiles", *Game AI Pro*), adapted to fields with many goals.

- **Sectors.** Divide the navigation grid into square sectors of 16 × 16 cells, about 10.4 units on a side. The current map comes out at 6 × 7 sectors and a 10× map at about 55 × 66. Sectors at the map edge may be partial.
- **Portals.** Along each shared sector edge, find the runs of consecutive cells that have a navigation edge (`edges` bit) crossing the boundary. Split runs longer than 4 cells into segments. Each segment becomes one portal node, with a representative cell on each side of the boundary. Diagonal crossings at sector corners belong to the adjacent run.
- **Coarse graph.** Portal nodes are connected through the sectors they touch. The cost of a link inside a sector comes from a Dijkstra run confined to that sector, using exactly the current expansion cost (`costs[dir] × (crowding + congestion) + |Δelevation| × 0.25`). Crossing a portal costs the single boundary step. Build this graph once, in the `Navigation` constructor.
- **Field build, per team, per rebuild:**
  1. **Seeding.** Gather goals and firing seeds as now. Each sector that contains any of them is a *source sector*.
  2. **Source sweeps.** In each source sector, run a local Dijkstra from its seeds and read off the cost at each of its portals. That cost seeds the coarse search.
  3. **Coarse sweep.** Run Dijkstra over the portal graph, giving every portal its distance to the nearest goal. Stop early once every portal of every *demand sector* (below) is settled. When the armies are close together, this search stays small no matter how large the map is.
  4. **Fine sweeps.** A *demand sector* is a sector that holds a soldier who follows this field, or neighbours one (all 8 surrounding sectors). For each demand sector, run a local Dijkstra seeded with its in-sector goals and firing seeds, plus every boundary entry cell at an interpolated portal distance (below) plus the crossing cost. Write the result into the back buffer.
  - **Edge interpolation.** A portal's representative cell sits at the midpoint of its segment. A boundary cell's seed distance is interpolated linearly, by position along the edge, between the coarse distances of the two nearest representatives in the same run. Cells past the first or last representative take that end segment's value. Interpolation never crosses a gap between runs. Without this step, every cell in a segment would start at the same value. That leaves a flat stretch about 2.6 units wide where soldiers drift toward one end of the segment instead of crossing straight.
  5. **Publish.** Swap the front and back buffers once every demand sector is done. There is no copy.
- **Lookups.** `direction()` keeps its current contract. It reads the published distance of the soldier's cell and its 8 neighbours. Because neighbouring sectors are always demand sectors too, a soldier on a boundary reads valid values on both sides.
- **Accuracy.** Because portal segments are at most 4 cells long, a coarse distance can be off by about one segment width (≈ 1.3 units) per portal crossing along the route. Edge interpolation shrinks most of that error to a smooth slope between neighbouring segments. Fine distances are exact within a sector, given their seeds. A route that leaves a sector and comes back in is still captured, because the portal it exits through already carries the cost of that detour.

### Storage

- **Distance.** Each team gets two full-map `Float32Array` buffers (front and back), about 3.6 MB each at 900k cells. Add a per-sector build stamp (`Uint32Array`, one entry per sector) so pages never need clearing: a cell's value counts only when its sector's stamp matches the published build.
- **Per-sector scratch.** `pending`, the heap, congestion, screening and the occupancy blur move to scratch sized for one sector plus a 1-cell ring around it. The heap gets local `positions`, so clearing it costs O(256) instead of O(map).
- **Portal graph.** The coarse graph is stored in flat arrays: per-sector portal lists, plus link targets and costs. A 10× map has about 10k portals and about 100k links.
- **Cell-level data stays as it is.** `walkable`, `edges`, `regions`, `elevation`, `crowding` and `clearance` are still needed for map preparation and tests.
- **Memory target.** About 25 MB of navigation memory at 900k cells, down from roughly 100 MB if the current layout were simply scaled up.

### Dynamic costs

- **Congestion** is computed only in sectors that contain stationary friendlies (plus a 1-cell blur margin). Those sectors are *dirty* for that team. At build start, recompute the in-sector link costs of each dirty sector into a per-team override table, and let the coarse sweep read the override where one exists. A sector stops being dirty once its congestion is back to zero.
- **Firing seeds** stay exactly as they are (gather, budgeted sight rays, `FIRE_SLACK`). Candidate lists become bounded rather than map-sized. Any sector that receives a seed becomes a source sector. The "already cheap to reach" skip reads the previous published field through `distanceAt(team, node)`. Where no fine value exists, that lookup falls back to a coarse estimate (the cheapest portal of the cell's sector plus the straight-line distance to it).

### Budgets and latency

- Keep the single `advance(budget)` entry point. Spend the budget across the phases in order: source sweeps, coarse sweep, fine sweeps. Count every heap pop as one expansion, so `expansions` and the existing budget test keep their meaning.
- **Expected work per rebuild at 10×, 100 v 100:** about 50–80 demand sectors per team, at about 256 cells each, plus a coarse sweep that usually ends early. That is about 15–25k expansions per team, so a full rebuild of both teams fits in the 60-tick interval at the current per-tick budget.
- **Soldiers outside a published sector.** A soldier who walks into a sector the published field doesn't cover steers toward the representative cell of that sector's cheapest portal. The sector is then queued ahead of the others in the next rebuild. Soldiers walk about 1.5 units per second and a sector is 10.4 units wide, so the neighbour ring should make this rare. Count how often it happens.

### Point routes

Replace `findPath` with a hierarchical version: run A* over the coarse graph from the start sector to the goal sector, then refine each sector leg with local A*. Return the same list of cells. The full-map `pathScore`, `pathPriority`, `pathParent` and path heap go away.

## Phases

Each phase lands as its own commit with tests passing.

1. **Measurement harness.** Add `scripts/nav-scale-benchmark.ts`. It runs the default battle at 1×, 2×, 3×, 6× and 10× (lifting the size limit for the benchmark only) and reports map generation time, navigation ms per tick, ticks per full rebuild, total expansions, and the size of navigation arrays. Record the baseline in `hierarchical-navigation-validation.md`.
2. **Remove per-rebuild full-map work without changing behaviour.** Replace the `fill`s with stamps on `pending` and the heap, compute congestion sparsely, and swap distance buffers instead of copying. The fields must stay exactly equal to the current ones (assert equality across the terrain corpus). This step alone makes rebuilds cheaper at every map size.
3. **Sectors and portal graph (static).** Build them in the constructor. Add tests that every boundary-crossing edge is covered by exactly one portal, that link costs are symmetric where costs are symmetric, that in-sector link costs match a reference local Dijkstra, and that portal regions agree with `regions`.
4. **Hierarchical fields behind a switch.** Add `CONFIG.nav.mode: 'exact' | 'sectors'` with the full pipeline above (without congestion or firing seeds at first), including edge interpolation, plus `distanceAt`. Add a test with a wide open boundary and the goal straight ahead: soldiers spread along it must cross roughly straight, not converge on segment ends. Compare against the exact field with interpolation on and off, to confirm the step earns its place. Keep the current implementation as `exact`, the reference for tests.
5. **Congestion and firing seeds.** Add the dirty-sector overrides, sparse congestion, bounded candidate lists, and coarse-estimate fallbacks.
6. **Hierarchical `findPath`,** then remove the map-sized scratch arrays.
7. **Validate and switch the default to `sectors`.** Tune sector size (16 or 32), portal segment length and the neighbour ring against the targets below. Leave `exact` in place only as a test reference.

## Validation targets

- **Field accuracy.** Compare `sectors` against `exact` on the terrain corpus (every archetype, many seeds, mid-battle snapshots). At least 95% of occupied cells pick the same step direction, or one within 45° whose exact distance is within 2% of the best. The median relative distance error is under 3%.
- **Behaviour at 1× is unchanged.** `npm test` passes, including the stepping and vantage tests in `tests/terrain.test.ts` and `tests/vantage.test.ts`. `npm run test:balance` stays within its current tolerances. Browser smoke checks show no jitter along sector seams.
- **Scale.** At 10×, 100 v 100: a full rebuild finishes within 60 ticks, navigation time per tick is no higher than today's 1× figure, navigation memory is at most about 25 MB, and soldiers outside published sectors make up under 1% of soldier-ticks.
- **Determinism.** The same seeds produce the same battle, as the session replay plan requires. Sector order, heap tie-breaking and the order demand sectors are served in must all be deterministic.

## Out of scope

These are separate follow-ups:

- Raising the tuning limits on battlefield size.
- Chunked terrain rendering and level of detail.
- Worker-based or per-chunk generation, including running the ramp-repair Dijkstra (`cheapestCut`) on the sector graph.
- Storing rock buckets as flat arrays.
- Raising the rock caps.
- Camera framing for large maps.

## Open questions

- **Sector size.** 16 keeps fine sweeps cheap. 32 shrinks the coarse graph and means fewer seams. The decision should come from benchmark numbers.
- **Separate squad goals.** Large maps will probably want squads with their own goals. The coarse graph makes extra fields cheap, but that is a gameplay decision to make separately.
