# Randomized battlefield terrain plan

## Goal

Give every new battle a visibly different, playable alien landscape: depressions, hills, small solid boulders that interrupt sight and fire, larger boulders soldiers can ascend, and occasional formations extending across the battlefield. Terrain must affect combat and movement consistently.

Maintain 60 FPS with up to **500 soldiers per side / 1,000 living soldiers total**, including sustained movement, congestion, targeting, and firing on the generated terrain. This replaces the earlier 200-unit performance target; 500-versus-500 is a required workload.

This is an implementation plan. No terrain implementation or worktree creation is part of this planning change.

## Performance contract

- Acceptance device: **Google Pixel 10**. Assume Chrome unless a different browser is requested. Record the actual browser/OS versions, viewport, orientation, resolution scale, and display refresh mode in results.
- Target a 16.67 ms frame budget with the full 60 Hz simulation advancing in real time. Report FPS, frame p95/p99, missed deadlines, simulation steps, and recurring stalls. Stable rendering must not conceal slowed simulation or skipped gameplay work.
- Establish a 1,000-unit baseline before adding terrain. Profile early; improvements needed to meet the requirement belong in this worktree even if they concern existing movement, targeting, effects, or rendering.
- Initial engineering budgets: 5 ms for CPU simulation including navigation/visibility, 3 ms for CPU rendering preparation/audio/UI, 6 ms for GPU rendering, and about 2.7 ms of margin. These are provisional allocations to measure and rebalance, not measured performance claims. CPU/GPU work overlaps; use actual frame pacing and separate CPU/GPU measurements for acceptance.
- Keep 1,000 soldiers alive and actively moving/firing throughout performance captures. Include dense contact, narrow passes, broad sight lines, large formations, and a simultaneous-fire fixture. Do not let fast casualties or universal occlusion create an artificially easy benchmark.
- Test all supported populations through 500 per side. Include expensive exposed tuning settings, particularly fast firing, long range, and large navigation bounds, in profiling and regression coverage.
- Use a mobile graphics profile with instancing, bounded effects, static terrain detail, and a measured pixel-ratio/render-scale cap. Adaptive resolution and cosmetic density can protect frame time while preserving terrain silhouettes, cover geometry, all soldiers, collision, and damage correctness. Record the minimum scale used and inspect readability.
- Warm the physical phone for at least 5 minutes, then capture at least 10 minutes of sustained 1,000-unit activity to check thermal behavior. Record power/charging conditions. Desktop and phone-viewport emulation support development; physical-device measurements determine completion.

## Current code and implications

- `src/renderer.ts` creates fixed-seed scenery. Interior ground variation is cosmetic; large rocks are deliberately outside the playable rectangle.
- `src/simulation.ts` stores X/Z positions, resolves unit circles with swept movement, and steers locally toward enemies. It has no route planner or static obstacle collision.
- Units currently stop advancing when an enemy is within horizontal weapon range, regardless of visibility. Adding shot blockers without changing this rule would produce stalled battles.
- Laser intersections and shot events are two-dimensional. Bodies, weapons, effects, and contact shadows use fixed elevations.
- Restart currently reuses the battle seed. Terrain will need its own seed and rebuild lifecycle.
- Formation dimensions, battlefield size, and soldier radius are tunable. Generation and navigation must use the active values rather than fixed default dimensions.
- Git currently has no commits; the game files are untracked. A baseline commit is required before a conventional linked worktree can be created.

## Worktree setup

1. At implementation time, inspect the latest working files and any repository instructions, then validate the existing game with `npm test` and `npm run build`. Capture an initial sustained 1,000-unit profile before designing around any assumed headroom.
2. Snapshot the current source, assets, lockfile, documentation, and `.gitignore` in an initial commit. Leave generated output and dependencies ignored. Capture any tuning changes completed before this snapshot.
3. Create branch `terrain/randomized-battlefield` in the sibling worktree `../pluto-battle-terrain`. Make all terrain implementation changes there.
4. Install dependencies from the lockfile in that worktree. Run its development server on port 5181 so the original game can remain open on 5180.
5. Compare performance and behavior against the recorded baseline, pass the 500-versus-500 performance requirement on the Pixel 10, and deliver the branch/worktree for review.

## Terrain behavior

| Feature | Movement | Sight and fire |
| --- | --- | --- |
| Dips and shallow basins | Walkable floor and slopes within the infantry slope limit | Basin rims and intervening ground can obscure soldiers |
| Hills | Walkable gentle slopes; steep faces block movement | Elevation can expose or conceal targets |
| Small boulders | Solid footprint; soldiers walk around them | Solid geometry blocks rays; sufficiently high shots pass over |
| Large climbable boulders | Broad tops reached by natural ramps, sloped shoulders, or short stepped approaches | Elevated firing positions; solid faces block lower shots |
| Very large formations | Irregular ridges, mesas, or connected outcrops, sometimes crossing the full field; include usable passes or traversable saddles | Break the battlefield into distinct sight lines and approaches |

Climbing means automatic ground movement up a legal approach. Initial terrain has one supported surface at each X/Z position, with no overhangs or tunnels. This supports climbable rock tops while retaining the current efficient crowd representation. Infantry remains upright; guns and beams aim vertically. Steep faces cannot be climbed or descended, and units do not jump off cliffs.

Keep the current red/purple, faceted visual style. Make ramps and passes readable through shape and shading. Use a mixture of broad terrain forms and clustered rocks so maps feel composed rather than uniformly noisy. Feature dimensions scale with the field and soldier size. Each map should contain the requested feature families where space allows; compact fields reduce counts rather than squeezing armies into invalid terrain.

## Implementation order

### 1. Shared terrain data and generation

Add a renderer-independent `src/terrain.ts` with seeded generation and a shared description of ground triangles, rock shapes, elevations, bounds, and feature classifications. Move reusable seeded randomness into a small shared module if needed to avoid circular imports.

- Build a triangulated heightfield for basins, hills, raised rock tops, ramps, and large formations. Rendering, height queries, slope queries, collision, and ground-ray intersections use the same triangulation.
- Represent discrete small boulders as simple faceted convex solids with matching visible and gameplay geometry. Keep them in a static spatial index.
- Generate broad features first, then approaches/passes, then rock clusters and decorative gravel. Place decoration on the actual surface.
- Reserve the full possible deployment envelopes, including jitter, unit radius, and a movement margin. Keep spawn areas gently graded and clear of blockers.
- Validate every actual spawn footprint, connected routes between armies, access to climbable tops, and corridor clearance. Favor multiple approaches with room for crowds rather than a single infantry-width opening.
- Repair failed passes or regenerate with a bounded attempt count. Use a known playable varied fallback if necessary; never loop indefinitely during reset. Record generation attempts and fallback use for diagnostics.
- Generate terrain and build static query/navigation structures before active combat resumes. If preparation is too slow for one responsive frame, split it into bounded chunks with a brief preparing state; do not run full map construction in the live combat loop.

### 2. Grounded movement and static collision

Extend simulation state with current and previous ground elevation. Spawn height comes from terrain, and queued reinforcements reject obstructed or unsupported positions.

- Preserve existing unit separation and swept-circle checks against other soldiers.
- Keep dynamic neighbor queries spatially bounded with reusable scratch data and no all-pairs crowd passes. Profile crowded cells and repeated movement alternatives at the full 1,000-unit load.
- Add radius-aware swept checks against boulders, steep faces, and battlefield edges. Validate the movement segment, not only its endpoint, so tuning speed cannot cause tunneling.
- Define configurable maximum slope and step height, with the same limits applied to navigation and actual movement. Use surface distance for travel so climbing does not increase effective speed.
- Check support and clearance across the soldier footprint at ledges and ramps. Never snap a soldier to an inaccessible higher surface.
- Derive rendered elevation from the shared surface at interpolated X/Z, avoiding straight interpolation through ridges. Keep corpse presentation on its final supporting surface.

### 3. Route finding and crowd integration

Add `src/navigation.ts`. Local detours alone cannot solve long ridges, concave obstacles, or ramps whose entrances lead away from the target.

- Start with a static navigation grid at approximately 0.5 world units per cell, separate from the existing dynamic soldier grid. The default 56-by-68 field is roughly 15,000 cells; profile resolution and clearance before finalizing it.
- Mark usable cells and edges using terrain slope, step limits, soldier radius, and support. Include climbable tops and their approaches. Block diagonal corner cutting and check clearance along edges.
- Label connected regions once per map. Use them to reject impossible goals quickly and validate generated terrain.
- Use shared routes and flow fields toward a small, bounded set of enemy-frontline regions so hundreds of soldiers can reuse the same navigation work. Cache fields by destination region and terrain version; do not create a separate field for every enemy.
- Use incremental A* for exceptional detours and final firing-position approaches, with reusable typed-array scratch data, path caching, and deterministic node-expansion budgets per simulation tick. Budget shared-field construction as well. Avoid 1,000 independent full searches or mass invalidation when one target dies.
- Follow field directions and waypoints with the existing local crowd steering and final swept collision checks. Smooth paths only across segments confirmed traversable by the same movement rules.
- Do not bake living soldiers into the static grid. Handle them locally, detect sustained lack of progress, and queue bounded replans or alternative goals instead of constant path churn.
- Route to reachable firing positions with range and sight to an enemy, rather than the enemy's occupied cell. Before enemies are nearby, approach reachable enemy-occupied regions rather than a possibly obstructed army centroid.
- Invalidate or refresh goals when targets die, move significantly, weapon range changes, a unit remains blocked, or terrain resets. Clear stale requests when slots/IDs are reused.
- Apply fair request scheduling with bounded queue size, cancellation of obsolete requests, and measured queue latency. Pending replans must retain a safe usable route or wait legally; repeated global replanning cannot become a source of frame spikes or starvation.

### 4. Elevation-aware targeting and shooting

- Compute muzzle and target positions in three dimensions. Weapon range uses actual 3D distance; vertical aiming follows the shot direction.
- Introduce a shared terrain visibility/raycast query that traverses relevant ground cells and indexed rock solids. Avoid Three.js scene raycasts in simulation.
- Precompute static cell bounds and obstacle candidate lists, and use coarse rejection before exact ray tests. Refresh target candidates and advisory visibility on staggered schedules, cache results with position/terrain validity, and cap candidates per search. Avoid per-frame all-pairs sight queries.
- Compare the closest terrain intersection with enemy capsule intersections. The beam ends at the first valid impact; no damage travels through ground or rocks. Preserve friendly-fire rules and simultaneous damage resolution.
- Give bounded shot events start/end Y coordinates so beams, muzzle flashes, and impacts match the gameplay ray.
- Soldiers stop advancing only when they can engage a valid enemy. An enemy inside range but hidden behind a rock causes repositioning or retargeting. Bound candidate searches and stagger visibility work; recheck occlusion when actually firing.
- Keep actual shot collision authoritative even when advisory visibility is cached. Optimize the worst simultaneous-fire case with acceleration structures; neither effect-pool saturation nor performance adaptation may discard or postpone damage to pass the benchmark.
- Test hill crests, basin rims, firing over low rocks, and elevation differences explicitly. Use consistent numerical tolerances for grazing intersections.

### 5. Rendering, camera, and reset lifecycle

- Replace cosmetic playable ground with the shared terrain mesh. Batch rocks, retain instanced soldiers/effects, and bound geometry/material counts and upload work. Profile draw calls, triangles, fill rate, and transparent laser/shadow overdraw with all 1,000 soldiers visible.
- Ground capsules, weapons, visors, contact shadows, corpses, and terrain decorations correctly. Align or conform cheap contact shadows to slopes to avoid floating planes.
- Fit the initial camera to terrain bounds including height. Prevent camera near-ground clipping while orbiting, and keep important approaches visible at desktop and portrait aspect ratios.
- Initial load and every player reset entry point generate a fresh terrain seed: Restart, R, Play again, and new battles from deployment/tuning controls.
- Keep terrain randomness separate from deployment, steering, and firing streams. Display the terrain seed in diagnostics and expose explicit same-seed replay in the developer API. Reproduction requires the terrain seed, battle seed, and tuning values.
- Preserve persisted audio and tuning settings. Rebuild terrain, navigation, and simulation together before resuming the new battle; dispose or reuse replaced GPU resources and clear old routes/effects/audio.
- Update seed help text and README restart instructions so they describe randomized resets and explicit replay accurately.

### 6. Verification and performance

Keep existing collision, damage, audio, ID-reuse, and command tests using explicit flat terrain fixtures where appropriate. Add focused terrain/navigation tests for:

- Identical terrain seeds producing identical maps and explicit full replay producing identical simulations.
- A fixed corpus of at least 100 terrain seeds, including supported compact and stress deployments, producing legal spawns, connected approaches, reachable rock tops, and bounded generation time.
- No tunneling, corner cutting, steep-face climbing, illegal ledge descent, or invalid reinforcement spawns.
- A U-shaped blocker, a field-spanning ridge with passes, a ramped boulder, and congested passages producing successful routes and visible progress.
- Covered in-range enemies causing repositioning, terrain intercepting shots before enemies, elevation permitting shots over cover, and preserved simultaneous damage.
- Bounded route request work, stale-ID cleanup, live range changes, and reset invalidation.
- Bounded shared-field rebuilds, fair request latency, simultaneous firing, and sustained 1,000-unit congestion without starvation or simulation slowdown.

Run `npm test`, `npm run build`, the updated Playwright smoke suite, and sustained benchmarks at 100, 250, and 500 soldiers per side. The 500-versus-500 run is the primary acceptance case. Browser fixtures should use explicit terrain seeds; existing flat-scene assertions must not silently depend on the randomized map.

Visually inspect basins, crests, climbable tops, tall formations, beam impacts, and shadows. Check desktop and phone layouts, repeated random resets, and exact-seed replay. Repeat resets at least 20 times and verify GPU resource counts settle instead of growing.

Compare baseline and terrain builds under the same device/browser, resolution, and quality settings. Add diagnostics for terrain-generation time, navigation rebuild time, path queue depth/latency/node expansions, visibility work, simulation progression, GPU cost where available, render scale, and blocked units. Measure worst representative maps as well as averages, and confirm seeded battles finish without permanent navigation or cover-related stalls. Use both sustained high-health activity captures and normal-health complete battles. Follow the Pixel 10 warmup and sustained capture protocol in the performance contract; attach the measured results before marking the performance requirement complete.

## Completion criteria

- Resets visibly change the landscape while exact-seed replay remains available.
- Dips, hills, sight-blocking small boulders, accessible large boulders, and occasional field-spanning formations all participate in gameplay.
- Terrain rendering, collision, support, navigation, targeting, and damage agree about the same world.
- Both armies find approaches around or over formations, engage from valid firing positions, and complete the tested battles.
- Existing controls, tuning, audio, collision guarantees, simultaneous damage, and developer commands continue to work.
- Sustained 500-versus-500 terrain battles meet the 60-FPS requirement on a Google Pixel 10 with real-time 60 Hz simulation, acceptable visual readability, and recorded warmed-device results.
- Tests, visual evidence, reset resource checks, and comparative performance results are recorded in the terrain worktree before review.
