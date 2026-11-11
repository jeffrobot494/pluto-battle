# SyncPlay physics and recording integration plan

Goal: run pluto-battle's battle simulation on RUN.world SyncPlay so we can use SyncPlay's
deterministic replay recording, with SyncPlay's 3D physics (Box3D compiled to WASM) as our
physics engine.

Sources: the SDK docs in `node_modules/@series-inc/rundot-game-sdk/docs/rundot-developer-platform/api/`,
mainly `SYNCPLAY.md`, `SYNCPLAY-PHYSICS.md`, `SYNCPLAY-MOVEMENT.md` and `SYNCPLAY-RUNTIME-COMPOSITIONS.md`.

## Key findings

1. **Recording does not need the physics engine. It needs a deterministic `step`.**
   - A SyncPlay replay (v2) stores the runtime identity, the session-config bytes, the inputs and
     commands for each frame, and checksums. To play it back, the sim is re-run (`verifyReplay`,
     `session.exportReplay()` with `replayRecordingMode: 'memory'`).
   - So every piece of gameplay state has to be produced inside SyncPlay's `step(inputs, commands, ctx)`.
     That covers AI, targeting, damage, upgrades, equipment, rockets and the outcome, not only the physics.
   - This is the biggest cost of the project, and we pay it whether or not we use Box3D.
2. **Game logic has to use deterministic math.** The determinism gate blocks
   `Math.sin/cos/tan/atan2/sqrt/hypot/pow`, `Math.random` and `Date.now` in sim code
   (`SYNCPLAY-MOVEMENT.md:482`).
   - The replacement is `ctx.math`: integer or fixed-point values, with angles in *turns*.
   - Our sim uses these functions heavily: steering, separation, aiming, flanking and flow-field
     costs. Inside the WASM, physics uses ordinary SI floats with unit-typed vectors (`meters3`, `vec3`).
3. **Phones are the hard limit.**
   - The only phone figures are from one Galaxy S9+, for the 3D step: p99 of 9.2 ms at 100 bodies,
     39 ms at 500 and 88 ms at 1000 (`SYNCPLAY-PHYSICS.md:1891`).
   - The docs don't say which SDK version those figures come from, and iOS hasn't been measured.
   - Our cap is 500 per team, or 1000 soldiers. A rigid body per soldier, all simulated, would be
     too slow on mid-range phones. Box3D has to be used selectively.
4. **We already have a good starting point.**
   - The sim runs on a fixed 1/60 tick (`src/config.ts:2`).
   - State is structure-of-arrays (SoA) typed arrays.
   - It uses seeded mulberry32 RNG streams and has no `Math.random` in `step`.
   - Player actions are already a serializable `Command` queue (`src/simulation.ts:23`).
   - Determinism tests already exist (`tests/simulation.test.ts:115`).
5. **The package is a release candidate (RC).**
   - `@series-inc/rundot-syncplay` is not installed yet, and it is only published as `@rc`
     (the docs reference 6.0.0-rc.81).
   - Any change to the runtime, the physics ABI or the package version invalidates saved replays.
     For example, rc.78 rejects rc.77 replays.
   - Pin the version exactly. Treat each replay as belonging to one build.
6. **The RTS (provisional), Pathfinding (beta) and Firearm modules** don't fit how our crowd works
   (navmesh agents with string ids; flow fields that can only be built offline). We keep our own
   flow field, AI and firing logic, ported to `ctx.math`.
7. `CLIPS.md` is a different system. It records video with MediaRecorder; it is not deterministic replay.

## Target architecture

```
SyncplayRunner (offline mode, local slot, replayRecordingMode: 'memory')
 └─ installed runtime adapter
     ├─ step(inputs, commands, ctx)   ← BattleSimulation.step, deterministic
     │    ├─ commands: spawn/equip/upgrade/upgradeArea/explode/tune/restart (tick-stamped)
     │    ├─ AI, steering, flow field, firing   (TS, ctx.math, ctx.random)
     │    └─ PhysicsWorld3D                     (Box3D WASM)
     │         ├─ static heightfield  ← cooked from terrain.ts
     │         ├─ static rock colliders (hulls)
     │         ├─ soldiers: kinematic capsules while walking,
     │         │            dynamic while knocked back / airborne / dead
     │         └─ queries: raycastBatch (hitscan, LOS), shapeCast (rockets), explode()
     ├─ captureState / restoreState  ← SoA arrays + physics checkpoint (binary serializeState)
     └─ checksum ← our state hash mixed with world.digest()
presentation.project / interpolate → renderer.ts (replaces our accumulator lerp)
```

How soldiers are represented (decided in Phase 0):
- **Plan A:** every soldier is a body.
  - Kinematic capsules while walking, moved with `setBodyTargetTransform` from our steering result.
  - Switch to dynamic for knockback.
  - Box3D then handles soldier-soldier contact, terrain contact, hitscan and blasts.
- **Plan B:** only airborne, knocked-back and dead soldiers are bodies.
  - Use this if Plan A is too slow on phones.
  - Walking soldiers stay on our spatial grid with `safeMove`.
  - The physics world holds the terrain and rocks, airborne bodies and debris, and answers the
    terrain raycasts.

## Phases

### Phase 0: Spike and go/no-go (about 1–2 days)
- Run `npm install --save-exact @series-inc/rundot-syncplay@rc`.
  - Add `rundotSyncplayPlugin()` (or `optimizeDeps.exclude`) to `vite.config.ts` so `physics.wasm`
    gets shipped.
  - Check that `rundot deploy` still works.
- Write a throwaway scene with these parts:
  - `initPhysics3D()`
  - The terrain cooked into a `heightfield` (columns, rows, scale; one-sided, +y up)
  - Rocks as hulls
  - 200, 500 and 1000 kinematic capsules driven by random walks
  - A batch of `raycastBatch` calls and some `explode()` calls each tick
- Measure the step, `digest()` and checkpoint capture on a real mid-range Android phone and on an
  iPhone, at 30 Hz and at 60 Hz.
- **Decide:** Plan A or Plan B, and the tick rate. 30 Hz halves the per-second cost; allowed rates are
  10, 20, 30 and 60.

### Phase 1: Make the sim a pure function of seed and commands
- Route every input that currently bypasses the command queue through `Command`. The code-mapping
  pass found these:
  - Live tuning: `applyLiveTuning`, `src/main.ts:403`
  - `weaponsEnabled`, toggled by performance capture: `main.ts:441`
  - Direct `sim.hp[i]` writes: `main.ts:379`
  - Commands flushed while paused: `main.ts:158`
  - Restarts: `main.ts:268`
- Change AI timers from accumulated float seconds to integer ticks.
- Move all battle setup into a session config (under 64 KB):
  - Seed, terrain archetype and parameters, army compositions, roster levels, equipment.
  - The terrain is regenerated from this config, never stored.
- Keep `performance.now` (navigation metrics) and audio and visual effects outside `step`.
- Exit check: the existing two-sim determinism tests pass with commands fed in through a recorded log.

### Phase 2: Wrap the existing sim in a SyncPlay runtime (no Box3D yet)
- `createInstalledRuntimeAdapter`, with these parts:
  - `deriveCustomRuntimeIdentity` (tick rate, input and state schema, deterministic version)
  - A binary `serializeState`/`hydrateState` that writes the SoA typed arrays directly, so we don't
    capture canonical JSON for 1000 soldiers
  - `captureState`, `restoreState`, `frameOf`
- Replace the `requestAnimationFrame` accumulator in `main.ts` with `createSyncplayRunner` in offline
  mode. Input encoding: one command list per tick.
- The renderer reads `presentation.project`/`interpolate`.
- Turn on `replayRecordingMode: 'memory'`.
  - Prove that `exportReplay()` followed by `verifyReplay` reproduces a battle on the same device.
  - **This is the first point where recording works.** It still uses JS float math, so replays may
    not play back identically on other devices or browsers.

### Phase 3: Port game logic to `ctx.math`
- Replace `Math.hypot/sqrt/atan2/sin/cos` in the sim with `ctx.math`. This touches:
  - Steering, separation, aim and facing (turns)
  - Flanking and sidestep angles
  - Flow-field costs
  - The terrain sampling the AI uses
- Positions the game owns become fixed-point (`fixedScale` 1000 means millimetres). Values Box3D owns
  stay SI floats inside the WASM.
- Replace mulberry32 with `ctx.random` forks, or keep it: it is pure-integer and deterministic.
  Confirm the certifier accepts it.
- Run `certifyModule` (from `/tools`) over `src/simulation.ts`, `navigation.ts`, `rockets.ts`,
  `equipment.ts`, `upgrades.ts`, `soldiers.ts` and the sim-side parts of `terrain.ts`.
  - It bans `Math.*`, `Date`, Three.js imports and unordered key iteration.
  - Split any modules that mix renderer and sim code.
- Expect behaviour drift. Re-run `npm run test:balance` and re-tune.

### Phase 4: Box3D becomes the physics engine
Do these in this order, so each step can be checked and benchmarked on its own:
1. **Terrain queries:**
   - `terrain.raycast` and `visible` become `world.raycast`/`raycastBatch` against the heightfield
     and rock hulls.
   - `heightAt`/`canStand` stay as cheap analytic sampling for steering, but must agree with the
     cooked heightfield. Add a test that compares them.
2. **Knockback:**
   - Delete `integrateBodies`/`moveBody` and the capsule slide code (`simulation.ts:861-938`).
   - A blast turns the soldier into a dynamic capsule: `world.explode()` or `applyImpulse`.
   - When the soldier lands and settles (sleep or contact events), it returns to kinematic or
     grid movement.
3. **Hitscan:** `castBeam`/`rayCapsule` become `raycastBatch` against soldier capsules.
   - Use collision filters (`categoryBits`/`maskBits` per team) for allies blocking shots.
   - Damage is still applied in a batch at the end of the tick.
   - Only on Plan A or a hybrid; on Plan B we keep our DDA grid walk.
4. **Rockets:**
   - `shapeCast` each tick, which fixes the "terrain is only checked at launch" shortcut.
   - Optionally add real ballistic gravity.
   - The impact calls `world.explode()`.
5. **Walking (Plan A only):** steering output goes to `setBodyTargetTransform` on kinematic capsules.
   Contact is resolved by Box3D or `collideMover`, replacing `safeMove` and the detour probes.
6. **Corpses and ragdolls (optional):** `ragdoll3D` or a dynamic capsule with sleep. Bodies are
   disabled once at rest.

Supporting work:
- Store a physics checkpoint (`captureCheckpoint`/`serializeCheckpoint`) inside our captured state.
- Mix `world.digest()` into the checksum.
- Resolve body handles again after every restore.
- Use the stable body id = soldier `id[]` slot mapping.

### Phase 5: Recording UX
- Choose a retention cap. Full retention costs about 2.5 KiB per tick per client. That is roughly
  4.5 MB for a 5-minute battle at 30 Hz.
  - Setting `maxInputRetentionFrames` makes `exportReplay()` throw.
  - So recorded battles need full retention, which is fine for battles of a few minutes.
- At the end of a battle, export the replay. Save it through appStorage or UGC, together with the
  build/runtime identity.
- Replay viewer: feed the recorded commands into a runner and use the normal renderer. The camera
  stays free.
- Replays from older builds show "made with an older version".

### Phase 6: Tests and benchmarks
- Port the determinism tests to the SyncPlay `/testing` kit:
  - `assertDeterministic`
  - `assertReplayVerifies`
  - `runSyncplaySynctest` (rollback and restore, for future multiplayer)
  - `assertPresentationParity`
- Extend `scripts/simulation-benchmark.mjs` to measure step, digest, capture and serialize at
  100, 250 and 500 per team, and add a phone run to the browser benchmark.
- Add a cross-browser replay test: record in Chromium, verify in WebKit with Playwright. This is
  the real exit check for Phase 3.

## Risks

- **Performance:** Box3D on phones at our soldier counts is the biggest unknown. Phase 0 exists
  to answer it before we commit.
- **Fixed-point rewrite:** the Phase 3 port is large and changes gameplay feel and balance.
  - If replays only need to play back on the device that recorded them, we could stop after
    Phase 2 or 4 and skip most of Phase 3.
  - Cross-device sharing needs Phase 3.
- **RC churn:** API and ABI changes between RCs break replays and may break code. Pin the version
  and upgrade on purpose.
- **Verification:** leaderboard `requiresReplay` is "not currently available"
  (`LEADERBOARD.md:212`). Replays are for playback and sharing, not for verified scores.
- **Live tuning panel:** every change becomes a command and is recorded. If tuning is changed
  mid-battle, the replay still reproduces it, but the tuning values are part of the runtime state.

## Open questions

1. What are recordings for: replaying on your own device, sharing with other players, or future
   multiplayer? This decides whether Phase 3 (cross-device determinism) is needed.
2. Is it acceptable that battles won't play exactly as they do today and will need re-balancing?
3. Is a 30 Hz sim tick, with rendering interpolated between ticks, acceptable?
