# Pluto — Mass Combat

A standalone Three.js battle prototype: 100 black Plutonian capsules with green lasers versus 100 brown Sectoid capsules with red lasers, on a purple/red alien battlefield.

## Run

Requires Node 22.14 or newer.

```sh
npm ci
npm run dev
```

Open **http://localhost:5183/**. This is the `feature/explosions` worktree; the original prototype uses port 5180. For a phone on the same Wi-Fi, use the network address printed by Vite. The lockfile supports an independent clean install.

```sh
npm test          # deterministic simulation and collision checks
npm run build    # TypeScript and production build
npm run preview  # production preview on port 4180
npm run test:browser
npm run test:tuning # all 29 controls, persistence, validation and responsive layout
npm run test:balance # 100 deterministic seeds; report under artifacts/
npm run test:audio:browser # sound output, mixer persistence and desktop/touch controls
npm run benchmark # sustained desktop combat with all 200 kept alive
npm run test:explosions:browser # desktop/touch explosions and airborne rendering
npm run benchmark:simulation # 200/500/1,000 soldiers, with and without repeated blasts
npm run benchmark:explosions # sustained 1,000-soldier GPU capture with burst explosions
```

The browser smoke test uses Playwright Chromium. Set `BATTLE_CHROMIUM` to a browser executable if needed, `BATTLE_URL` to another local server URL, or `BATTLE_SOFTWARE=1` to use SwiftShader. It writes screenshots and a JSON report into `artifacts/`. Install Chromium with `npx playwright install chromium` if it is not already available.

## Play

The battle starts automatically. Soldiers acquire enemies, approach until in laser range, fire, and reacquire targets. Both teams use the same initial stats. Living soldiers block both teams' movement; teammates allow friendly shots through. Lasers hit the first enemy along the beam, and shots from both teams resolve before damage is committed.

- **Pause / Space:** pause or resume.
- **Restart / R:** replay the same deployment and seed.
- **Left-drag / one-finger drag:** pan. **Hold right-click and drag:** orbit the perspective camera.
- **Wheel / pinch / + / −:** zoom toward or away from the battlefield.
- **Center view / C:** reset the camera.
- **FPS badge / D:** diagnostics, quality controls and 250-vs-250 / 500-vs-500 stress deployments.
- **Tuning / T:** expand or collapse all 29 battle controls. Each group also collapses independently. Live controls affect both armies immediately; controls labeled **NEW BATTLE** take effect when you deploy or restart. Changed values have a green dot, and settings persist in this browser. **Reset defaults** resets the values; **New battle** applies the full configuration. Invalid formations show an explanation and cannot deploy.
- **Test explosions:** enable the toggle beside Tuning, then click or tap playable ground to detonate. A pointer hover shows the blast radius. Dragging still pans; right-drag and pinch keep their camera behavior. The tool works during active, unpaused combat and resets off on restart. Test explosions damage both armies.
- **Physics & explosions:** gravity, radius, damage, and impulse are live controls. Gravity defaults to 9.81 u/s²; an explosion defaults to radius 4, damage 35 HP, and impulse 10 u/s for unit-mass infantry. Zero damage enables motion-only testing; zero gravity preserves airborne velocity. New settings receive defaults when loading older saved tuning.
- **Sound effects:** expand the lower-left panel to adjust laser firing, Plutonian hit, Sectoid hit, Plutonian dying and Sectoid dying volumes independently. Each has a preview button; 0% mutes that effect. Levels save in this browser across reloads and restarts. Tap/click or press a key anywhere to enable audio on the first visit.

The white damage flash reproduces Pluto Mobile's emissive pulse, with a 0.12-second default duration. Deaths immediately stop blocking movement while a short capsule fall/shrink finishes. A result panel appears when either team is eliminated.

The tuning controls cover gravity and explosions, troop count, health, rifle damage/range/fire interval, speed, collision radius, field half-width/depth, frontline distance, formation columns, column/row spacing, horizontal/forward randomness, seed, search padding/interval/initial delay, avoidance distance/strength, shallow/wide detour angles, and hit-flash duration/intensity. Live health changes preserve each survivor's health fraction; they do not revive dead units. Live fire-interval changes preserve cooldown progress. Changing radius or field dimensions rebuilds the corresponding visuals and collision grids on the next deployment.

Crowd steering uses a separate seeded random stream to assign each soldier a stable left/right detour preference. IDs and column parity do not decide which way a soldier sidesteps, and sideways escape attempts consider both directions. A regression test renumbers every unit ID and verifies identical movement, damage and outcome. Restart reproduces the same seed, settings, and command sequence. The coarse target grid may change target selection among equally distant enemies compared with the earlier prototype.

Explosions use the full 3D distance from their center to each soldier capsule's center. Damage is applied once and is constant within the radius. Impulse points outward and falls linearly to zero at the edge. Overlapping blasts add, and a coincident body center receives an upward impulse. AI walking stops in the air; swept upright-capsule collision prevents tunneling, ground friction settles horizontal motion, and soldiers resume walking after landing. Dying bodies retain blast motion while fading. Combat stops at the result, while bodies and effects finish settling; the displayed battle duration stays fixed. The current support surface is flat, matching the main prototype. Terrain integration remains on its separate branch.

## Architecture

- `src/simulation.ts`: renderer-independent fixed 60 Hz simulation; typed-array body positions/velocities, swept capsule contacts, a fine collision grid and coarse target grid, local steering, 3D hitscan weapons and simultaneous laser/blast damage.
- `src/collision.ts`, `src/explosions.ts`: upright capsule ray tests, validated reusable explosion definitions, and a bounded presentation buffer. Infantry currently has unit mass. Scenery is static and blasts do not use occlusion.
- `src/explosion-input.ts`: pointer tap recognition shared with camera controls; ignores drags, multitouch, canceled gestures, and paused interactions.
- `src/renderer.ts`: shared instanced capsules, guns, visors and contact shadows; per-instance hit timestamps; pooled laser/muzzle/impact effects; seeded low-poly terrain and boundary rocks. No skeletal animation, dynamic shot lights or per-unit DOM elements.
- `src/config.ts`: battlefield, unit and feedback constants, weapon definitions and pool budgets.
- `src/tuning.ts`, `src/tuning-panel.ts`: the 29-control schema, deployment validation, browser persistence, live/restart behavior and collapsible tuning UI. Each simulation owns its settings and rifle definition, so tuning one simulation does not mutate another.
- `src/audio.ts`: five original synthesized Web Audio effects, reusable PCM buffers, independent persisted mixer channels, stereo spread and compressed output. Combat notifications are bounded, rate-limited and capped at 24 simultaneous voices; pause, hidden tabs and restarts clear active sounds. Cosmetic event limits never affect combat damage.
- `src/main.ts`: responsive HUD, camera and battle controls, bounded fixed-step scheduling, visibility pausing, performance sampling and developer API.

Large rocks are scenery outside the walkable battlefield. Small gravel is only a ground detail. Interior blocking terrain and general route finding are deferred.

`window.__battle` is a developer API. Commands apply on the next simulation boundary:

```js
const battle = window.__battle;
battle.sim.queue({ type: 'spawn', team: 0, x: 18, z: 20 });
battle.sim.queue({ type: 'equip', ids: [battle.sim.id[0]], weapon: 1 });
battle.sim.queue({ type: 'explode', x: 0, y: 0, z: 0, radius: 4, damage: 35, impulse: 10 });
// Use the current test-explosion tuning:
battle.explode({ x: 0, y: 0, z: 0 });
```

Spawns reject occupied/out-of-bounds positions and full capacity. Existing IDs never identify replacement units after a slot is reused. Weapon changes preserve cooldowns. The queue owns its ID lists. These APIs prepare for later reinforcements and upgrades; player-facing purchases, jump jets, vehicles, bombs and missiles are deferred.

## Performance scope

The acceptance target is 60 FPS with 500 soldiers per side, including repeated explosions, and real-time 60 Hz simulation. Diagnostics show frame p95/p99, simulation rate, CPU simulation/render time, airborne bodies, blast candidates, contact checks, effect pool saturation, draw calls, resource counts, and pixel ratio. Render submission measures CPU work, not GPU completion. Balanced quality caps pixel ratio at 1.5; Low caps it at 1. Explosion spheres are instanced in a 32-slot pool; cosmetic limits never affect damage or impulse.

Emulated phone viewports check layout and touch controls; they do not benchmark a physical phone. Sustained Pixel 10 testing, including thermal behavior, remains required before accepting mobile performance. See `explosion-validation.md` for measured desktop results and limits.

The initial NVIDIA RTX 3050 laptop baseline at 1440×1000, pixel ratio 1, measured approximately 56 FPS in normal headless Chromium with p95 18.5 ms. A subsequent uncapped throughput check with the tuning panel open, all 200 soldiers kept alive, and 480 captured frames measured p95 1.6 ms, with average render submission around 0.49 ms. The uncapped check measures available throughput; it does not establish display pacing or phone performance. Set `BATTLE_UNCAPPED=1` using your shell's syntax for an uncapped benchmark. Reports are written to `artifacts/benchmark*.json`. Browser screenshot/test timings include capture stalls and should not be used as the benchmark.

Validation includes deterministic simulation/audio/tuning/explosion tests and browser passes covering all 29 controls, persistence, invalid deployment rejection, desktop/touch controls, both rendered laser colors, GPU hit-flash brightness/restoration, airborne attachments, 1,000-unit stress deployment, battle completion and stable resources across restarts and explosions. Set `BATTLE_PANEL=1` for the original benchmark's open-panel case.

`benchmark:explosions` accepts `BATTLE_COUNT` (soldiers per team), `BATTLE_BLASTS` (`none`, `clicks`, `bursts`), `BATTLE_SECONDS`, `BATTLE_WARMUP`, `BATTLE_QUALITY`, `BATTLE_UNCAPPED`, `BATTLE_URL`, and `BATTLE_REPORT`. Defaults are 500 per side, burst mode, a 5-second warmup, and a 30-second capture. Burst mode injects four maximum-strength/radius blasts per tick for three ticks every two seconds. All soldiers retain extra health. Reports include simulation Hz, live counts, shots, blasts, CPU work, frame percentiles, and resource counts. Use five minutes of warmup and ten minutes of capture on the physical acceptance phone.

The existing `../pluto-mobile` game is unchanged. No hosted deployment or backend is needed.
