# Explosions and gravity plan

Add a reusable spherical explosion that damages soldiers and pushes their bodies away from its center. Test it with an opt-in ground-click tool. Keep the simulation at 60 Hz and maintain 60 FPS through 500 soldiers per side, following the Pixel 10 acceptance target in `terrain-plan.md`.

This change documents the implementation plan only.

## Behavior and scope

- An explosion has a world-space X/Y/Z center, radius, damage, and peak impulse. The same simulation entry point will later accept projectile detonations.
- Test explosions affect both armies. Scenery remains static. Projectile flight, rocket launchers, terrain destruction, full ragdolls, and blast occlusion are later work.
- Use the soldier capsule's center for the initial spherical distance test. A body is affected when its center is inside the radius, including when airborne. This is a documented approximation rather than a horizontal circle test.
- Apply damage once per explosion to each affected living soldier. Initially damage is constant inside the sphere; the requested distance falloff applies to impulse. Keep these parameters separate so damage falloff can be added deliberately later.
- For distance `d` and radius `R`, use `falloff = max(0, 1 - d / R)`. Apply `deltaVelocity = direction * peakImpulse * falloff / mass`, where direction points from the explosion center to the body center. Infantry initially uses unit mass. At exactly coincident centers, use a deterministic upward direction to avoid division by zero.
- An explosion is an instantaneous impulse, independent of render frame rate. Overlapping explosions add their velocity changes. Lethal blasts still throw the dying body before its existing fade and cleanup.
- Start with radius 4 world units, damage 35 HP, peak impulse 10 for unit-mass infantry, and gravity 9.81 world units/s². These are initial gameplay values to tune, not a requirement to reproduce Pluto's real gravity.

## Current architecture and integration

The main `pluto-battle` simulation stores X/Z positions, uses swept-circle crowd collision, and renders capsules and lasers at fixed heights. It has a fixed-step command queue, shared damage handling, typed-array storage, a spatial grid, and bounded presentation events that can support this feature.

The sibling terrain implementation already has Y positions, terrain height queries, and 3D capsule/laser intersections. At implementation time, inspect the active branch and reuse those interfaces if integrated. Keep ground support behind a shared query: the current prototype supplies a flat surface; terrain supplies its actual support and solid geometry. Avoid a competing terrain or capsule implementation.

## Implementation order

### 1. Establish the performance baseline

- Run the existing simulation tests and production build before changing gameplay.
- Capture sustained 100-, 250-, and 500-per-side battles with soldiers alive and actively moving/firing. Record frame p95/p99, missed frame deadlines, simulation progress, simulation/render CPU time, draw calls, effects, and memory.
- Establish the 1,000-soldier baseline early. Any existing bottleneck that prevents the required workload belongs in the performance work for this feature.

### 2. Add gravity and external velocity

Extend `src/simulation.ts` with Y/previous-Y positions, external X/Y/Z velocity, and grounded state using reusable typed arrays. Initialize and clear all fields on spawn, slot reuse, and restart.

- Integrate gravity and external velocity at the existing fixed 1/60-second timestep. Normal grounded soldiers remain supported without jitter or sinking.
- Keep crowd steering distinct from external velocity so AI movement cannot overwrite a blast. Suspend walking and ground avoidance while airborne; restore them after a valid landing. Use ground friction to settle horizontal motion.
- Resolve fast blast movement with swept collision against relevant bodies, terrain, and battlefield bounds. Use the spatial grid for candidate discovery and height-aware capsule tests for contact. Units separated vertically may pass above one another; landing must restore legal occupancy without overlaps or tunneling.
- Reuse terrain support and solid-collision queries when available. Reconcile each landing with the current surface and nearby units, rather than snapping through a crowded patch or a rock.
- Retain external motion for dying bodies through their bounded visual lifetime. They remain nonblocking, as in the existing prototype.
- Separate combat completion from physical settling. Record the battle duration when the result is decided, then let existing airborne bodies and effects finish. Pause and hidden-tab behavior must freeze the appropriate clocks consistently.

### 3. Add the reusable explosion command

Add an explosion definition/helper, preferably in `src/explosions.ts`, and an `explode` variant to the simulation command queue.

- Validate finite coordinates and nonnegative damage/impulse; require a positive bounded radius. Copy the command's data when queued.
- Resolve commands on a simulation boundary. Query nearby grid cells, then perform the full 3D distance test. Each body receives each blast once, regardless of grid traversal or cosmetic capacity.
- Accumulate blast impulses and damage from a consistent tick state. Combine blast damage with the existing pending-damage phase before committing deaths, preserving simultaneous resolution. Do not let the existing pending-damage reset erase queued explosions.
- Emit a separate bounded explosion presentation event after gameplay resolution. Exhausting or overwriting visual events must never suppress damage or motion.
- Expose the command through `window.__battle` for deterministic fixtures and eventual projectile integration.

### 4. Add live tuning

Extend `src/config.ts`, `src/tuning.ts`, and the existing tuning UI with a Physics & explosions group:

| Control | Initial value | Proposed range | Application |
| --- | --- | --- | --- |
| Gravity strength | 9.81 u/s² | 0–50 | Live, including airborne bodies |
| Explosion radius | 4 u | 0.5–20 | Subsequent test explosions |
| Explosion damage | 35 HP | 0–1,000 | Subsequent test explosions |
| Explosion impulse | 10 for unit mass | 0–40 | Subsequent test explosions |

Use existing validation, persistence, changed indicators, and reset behavior. Older saved settings receive defaults for the new values. Zero gravity is valid and leaves bodies moving until contact or other applicable damping. Zero damage enables motion-only testing and sustained benchmarks.

Derive the panel badge count from the tuning schema, replacing the hard-coded 25. Update count-dependent tests and documentation.

### 5. Add the ground-click test tool and rendering

Update `src/main.ts`, `src/renderer.ts`, and `src/style.css`.

- Add an accessible **Test explosions** toggle, off by default, with a clear active state. While enabled, a primary click or single-finger tap on playable ground queues a blast at the picked world position.
- Distinguish taps from drags using pointer tracking and a movement threshold. Preserve pan, right-drag orbit, zoom, and pinch. Cancel detonation for canceled pointers, multitouch gestures, and interactions with HUD controls.
- Pick the shared gameplay surface and check battlefield bounds. On the flat prototype this is the support plane; on terrain it is the visible gameplay surface. Provide a lightweight radius preview on pointer devices.
- Accept test detonations during active, unpaused combat. Reset the tool and clear pending input on restart; pausing must not accumulate delayed clicks.
- Interpolate Y alongside X/Z for capsules and attached guns/visors. Keep shadows on the support surface, with height-dependent size/fade. Airborne soldiers must not play a walking bob.
- Reuse or extend 3D aiming, range, capsule intersections, and shot-event endpoints so lasers track airborne bodies correctly. Preserve existing friendly-fire rules for rifles.
- Render a short expanding spherical flash with a bounded pool of low-poly shared geometry, plus inexpensive sparks if the measured budget allows. Include explosion effects in diagnostics and resource cleanup.

### 6. Enforce the 60-FPS budget

- Keep spatial queries local, use allocation-free scratch storage, and integrate only active dynamic bodies beyond the normal grounded path. Avoid all-pairs collision and per-body scene raycasts.
- Batch explosion visuals, reuse materials, and bound particles, effect lifetime, and simultaneous rendered blasts. Measure transparent overdraw as well as draw calls. Reduce cosmetic density or resolution when necessary while preserving all bodies, damage, impulses, and collision.
- Add diagnostics for active airborne bodies, blast queries/candidates, collision work, explosion effects, pool saturation, and actual simulation ticks per second.
- Benchmark dense crowds, field edges, airborne crossings and landings, maximum exposed blast strength/radius, and multiple blasts in the same tick. Use a repeatable stress fixture of four overlapping blasts per tick in bursts, repeated throughout the capture, alongside ordinary click-rate use. Keep all 1,000 soldiers active with a motion-only/high-health fixture; also test normal damage through battle completion.
- Target a 16.67 ms frame budget with real-time 60 Hz simulation. Compare warmed baseline and feature builds at the same device/browser, resolution, and quality. Track frame p95/p99 and recurring stalls; an average FPS alone does not establish success.
- Follow the terrain plan's physical Pixel 10 protocol: at least five minutes of warmup and ten minutes of sustained capture. Record browser/OS, orientation, refresh mode, render scale, and power conditions. Desktop or emulated-phone results support development; the physical phone determines mobile acceptance.

### 7. Verify behavior and regressions

Add deterministic simulation tests for radius boundaries and vertical exclusion, outward directions, monotonic impulse falloff, the coincident-center case, damage once per blast, overlapping explosions, and both armies receiving debug damage.

Cover gravity and live changes, zero gravity, friction/settling, fast swept contacts, height-separated bodies, crowded landings, field boundaries, lethal-body motion, physics after the final kill, and clean slot reuse/restarts. Verify identical seeds and command sequences reproduce damage and trajectories. Saturate visual pools and confirm gameplay remains identical.

Extend browser coverage for toggle state, accurate ground picking, tap versus drag, pinch and HUD isolation, pause/restart, gravity persistence/reset, airborne attachments and lasers, and stable memory after repeated explosions and restarts. Run the existing unit tests, production build, browser/tuning checks, and the sustained performance fixture.

## Completion criteria

- Ground clicks create spherical explosions only while the test toggle is active.
- Affected soldiers take damage once and move outward, with stronger impulses nearer the center; gravity returns them to supported surfaces when gravity is positive.
- Movement, landing, damage, death, aiming, and presentation remain consistent, including blasts that end a battle.
- Gravity and explosion settings use the existing live tuning and persistence system.
- A projectile can later invoke the same explosion command without duplicating damage or physics logic.
- Sustained 500-versus-500 captures with repeated blasts satisfy the 60-FPS requirement on the physical Pixel 10, with real-time simulation and recorded results. If that device is unavailable during implementation, report mobile acceptance as unverified.
