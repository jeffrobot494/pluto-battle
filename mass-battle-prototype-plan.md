# Mass battle prototype plan

## First playable

Build a new, separate game beside `pluto-mobile`, using its existing Three.js, TypeScript and Vite stack as the starting point. Working assumption: a mobile browser game that also runs on desktop. Keep the existing game unchanged.

The first playable opens directly onto an automatic 100-versus-100 battle:

- Plutonians: 100 small black capsules, simple guns, green lasers.
- Sectoids: 100 small brown capsules, simple guns, red lasers.
- World: red rocky ground, purple rock formations, a contrasting sky and simple directional lighting. Use lighting and ground contrast to keep black soldiers readable.
- Both armies approach enemies, stop when they can shoot within weapon range, and fire until the target dies or leaves range. They then acquire another target and continue.
- Living units cannot walk through teammates or enemies. Blocked units steer around neighbors or wait.
- Every damaging hit produces Pluto Mobile's white emissive flash. Death removes the unit from combat immediately and plays a brief, cheap capsule fall/fade.
- The battle ends when one army is eliminated, with a draw if both are eliminated in the same simulation step.
- Minimal controls: pause/resume, restart, camera pan/zoom, and living counts for both sides. Keep detailed diagnostics in a development overlay.

Use equal starting combat stats so the first task is readable, stable mass combat. Keep movement speed, radius, health, range, damage and fire rate in a small configuration file. Give units deterministic firing offsets so 200 soldiers do not all shoot on the same frame.

## Terrain and camera

Start with a broad, open battlefield and two separated, non-overlapping deployment areas. Keep gameplay on a flat X/Z plane. Create the alien landscape with a low-poly ground mesh, color variation, small surface details and instanced angular rocks.

Place large rock formations outside the walkable battle area in this first version. This gives us rocky scenery without adding maze navigation to the crowd prototype. Any later rock placed inside the battlefield must have an explicit movement and shot-blocking footprint.

Use an elevated, angled camera that shows both armies and their meeting line. Fit the initial view to the battlefield, with touch and mouse pan/zoom. Adapt the viewport to the available screen rather than cropping one army off a portrait display.

## Simulation

Keep combat independent of Three.js. Use a fixed 60 Hz simulation and interpolate presentation between steps. Cap catch-up work after a long frame; pause when the page is hidden and reset accumulated elapsed time on return.

Store frequently updated unit fields in compact reusable arrays: position, previous position, radius, team, health, target, weapon ID, cooldown and last-hit time. Give each unit a stable ID that is independent of its storage slot or render instance. Reuse vacated slots safely without making old target references point at a different unit.

Each step:

1. Apply queued commands at a defined simulation boundary.
2. Validate retained targets and refresh a staggered subset of target searches.
3. Calculate desired movement toward a target or opposing occupied area.
4. Resolve movement against units and battlefield bounds.
5. Recheck firing range from resolved positions, resolve shots, then apply damage and deaths.
6. Publish bounded presentation events for shots, hits and deaths.

Process the step's valid shots before committing their damage so iteration order does not grant one team a first-shot advantage. Use seeded randomness for deployments, tie breaks and firing offsets. Separate scenery randomness from combat randomness.

### Finding enemies

Use a reusable uniform spatial grid for local queries. Choose its cell size around the infantry collision diameter and query as many cells as each operation requires; weapon range will span more cells than collision queries.

Keep an existing valid target rather than sorting every enemy every frame. Stagger new acquisitions across units, initially around 5–10 searches per second per unit. Immediately stop firing at invalid targets. When no enemy is nearby, use occupied enemy cells to choose an approach direction, so distant armies still meet. Retarget blocked units periodically to avoid everyone chasing an inaccessible enemy behind the front line.

### Solid crowd movement

Represent grounded capsules as circles for gameplay. Use the grid to find nearby circles, steer gently around them, and enforce a minimum center distance equal to the sum of radii. Visual separation forces alone do not satisfy the collision requirement.

Use swept movement checks or sufficiently small movement substeps to prevent units swapping sides through each other. Resolve contacts with bounded local work, revalidate the final occupancy, and shorten or reject a movement that cannot be made legal. A congested soldier waits rather than overlapping another soldier. Rotate movement priority deterministically to reduce persistent ordering bias.

Rebuild or update the spatial index after position changes so queries never rely on stale cell membership. Keep spawn positions valid from the start. Remove dead units from movement collision immediately; their falling visuals do not block the army.

This is local crowd movement on an open field. Add route finding when interior obstacles or more complex maps actually require it.

## Weapons and hit feedback

For the first laser rifles, use immediate hit resolution with short-lived visible beams. Query gameplay circles along a shot segment and damage the first intersected enemy within range. Render the beam to the actual impact point. This avoids a simulated flying projectile for every laser while keeping later projectile weapons possible.

Initial rule: friendly fire is off, and teammates do not block lasers. They still block movement. This lets rear ranks contribute without requiring firing-lane tactics in the first prototype.

Keep range, damage, fire interval and laser color in weapon definitions. Resolve damage through one shared path that records hits, handles death and emits presentation events. Cosmetic pool limits must never cancel a shot or suppress gameplay damage.

Pluto Mobile's reference is `pluto-mobile/src/visual/objects.ts`, specifically `flashObject`, driven by `lastHit` in `src/visual/renderer.ts`. Its defaults in `content/tuning.json` are a 0.12-second white flash and intensity 1. Reproduce that emissive pulse using a per-instance hit-time attribute and a shared material, so one hit flashes only that capsule. Restore its normal black or brown appearance afterward; repeated hits refresh the flash.

Pool and batch beams, muzzle flashes and small impact effects. Bound corpse count and lifetime. Avoid per-shot lights, per-unit DOM health bars, cloned materials and unbounded event queues.

## Rendering and 60 FPS

Render capsules with one or two instanced batches and guns with shared batched geometry. Use shared low-poly geometry and per-instance transforms, colors and flash data. Batch terrain rocks and effects as well. Begin with inexpensive lighting and cheap ground contact shadows; add costly post-processing only after profiling.

Use reusable scratch storage and pools in simulation and rendering. Avoid allocations, full-array sorts and scene raycasts in the per-unit update loop. Reserve enough unit/effect capacity at startup; later growth should happen deliberately through the command path rather than unpredictably during rendering.

The baseline requirement is 200 active combatants at 60 FPS, including dense contact and simultaneous firing. A 60 Hz display provides approximately 16.7 ms per frame. Establish performance measurements with a minimal 200-capsule scene before layering on combat and scenery.

Record frame-time percentiles, simulation time, render submission time, draw calls, triangle count, active effects, live unit count and memory behavior. On a selected physical target phone, aim for near-60 FPS pacing, a 95th-percentile frame interval around 16.7 ms, and no recurring long stalls. Profile sustained combat, not just a quiet opening or the period after most units have died. Record device/browser, resolution, quality settings and thermal behavior with results.

The exact target phone is still unspecified. Desktop and emulated mobile checks can validate behavior and layout; they cannot establish the phone's performance result. Choose that device before accepting the performance milestone.

Add development-only stress presets for 250-versus-250 and 500-versus-500 to reveal the next bottleneck. These are measurements, not an initial promise of 60 FPS at those populations. Reduce visual cost first if the baseline misses budget; preserve collision and damage correctness. Add workers, GPU simulation or a more complex architecture only if measurements justify them.

## Make later features possible

Build only the small interfaces needed now:

| Later feature | Foundation in this prototype | Work deferred |
| --- | --- | --- |
| Add soldiers during battle | Stable IDs, reusable storage slots, validated spawn operation and commands applied between steps | Reinforcement controls, landing presentation and player costs |
| Upgrade many soldiers live | Weapon IDs, data-driven definitions and commands that accept collections of unit IDs | Selection interface, upgrade rules and purchase presentation |
| Jump jets | Keep ground movement behind a movement-mode boundary; reserve a clear distinction between simulation position and visual height | Flight, landing reservations, airborne collision and jet effects |
| Call vehicles | Radius and movement/weapon definitions belong to unit data | Larger footprints, mixed-size navigation, vehicle art and deployment |
| Missiles and bombs | Shared damage path, spatial queries and separate combat/presentation events | Projectile flight, area-damage queries, explosions and targeting controls |
| Blow hordes skyward | Death presentation is independent of grounded unit movement and has a bounded pool | Blast impulses, airborne debris/corpses and their collision rules |

Implement the spawn and weapon-change operations as simple simulation APIs, with focused checks that they work during a running battle. Expose only developer access initially. Do not build the future feature interfaces, economy or combat systems in this slice.

## Build order and acceptance

1. **Render and measure:** scaffold the separate project; show the red/purple battlefield and 100 black versus 100 brown capsules; add camera controls and timings. Establish the device baseline.
2. **Move solid crowds:** build stable unit storage, the spatial grid and non-overlapping deployments. Make both armies approach, steer and queue without walking through one another. Verify dense head-on contact before adding weapons.
3. **Complete automatic combat:** add target retention/acquisition, range checks, laser colors, health, death and battle outcome. Confirm both sides independently advance and fire.
4. **Match feedback:** add the instanced Pluto hit flash, readable gun direction, pooled shot/impact effects and bounded death presentation.
5. **Validate and tune:** run seeded battles, collision regressions, browser/touch checks and sustained physical-device profiling. Add scenery density and effects only while the 200-unit target holds.

Acceptance checks:

- Default deployment is exactly 100 living units per team, with the requested capsule and laser colors.
- Units approach distant enemies, stop to shoot at valid range, reacquire after death, and finish the battle without permanent targeting stalls on the open map.
- Teammates and opponents remain separated within a small numerical tolerance, including dense contact, crossing movement and validated reinforcements.
- Shots respect range, damage the correct enemy, and never lose gameplay damage because an effect pool is full.
- A hit flashes only the damaged capsule for the configured duration; repeated hits and lethal hits remain visible.
- Deaths stop blocking immediately; stale IDs never target a replacement unit. Restart reproduces the same initial state and seeded result.
- Queued spawns and weapon changes work without restarting or corrupting collision, targets or rendering.
- Repeated restarts and full battles do not accumulate objects, effects or memory.
- The 200-unit battle meets the agreed physical-device frame budget during sustained movement and firing. Record results and any remaining limit explicitly.

Use focused deterministic simulation tests for collision, range, damage, stale references and live commands, plus a browser smoke pass for rendering, controls and reset. Visually inspect the hit flash against Pluto Mobile. Performance acceptance requires a real device run.

Implementation is available in `pluto-battle/`, with the first playable, crowd collision, combat, instanced feedback, controls and development diagnostics implemented. The production build, 10 deterministic simulation tests and desktop/touch browser checks pass. Performance reports and screenshots are under `pluto-battle/artifacts/`; physical target-phone performance acceptance remains open. See `pluto-battle/README.md` for launch instructions, architecture and measured desktop limits.
