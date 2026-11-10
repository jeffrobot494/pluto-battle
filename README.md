# Pluto — Mass Combat

A standalone Three.js battle prototype: 100 black Plutonian capsules with green lasers versus 100 brown Sectoid capsules with red lasers, on a purple/red alien battlefield.

## Run

Requires Node 22.14 or newer.

```sh
npm ci
npm run dev
```

Open **http://localhost:5180/**. For a phone on the same Wi-Fi, use the network address printed by Vite. The current workspace has a local copy of the matching `pluto-mobile` dependencies, so you can run `npm run dev` immediately. The lockfile supports an independent clean install.

```sh
npm test          # deterministic simulation and collision checks
npm run build    # TypeScript and production build
npm run preview  # production preview on port 4180
npm run test:browser
npm run test:tuning # all 25 controls, persistence, validation and responsive layout
npm run test:balance # 100 deterministic seeds; report under artifacts/
npm run test:audio:browser # sound output, mixer persistence and desktop/touch controls
npm run benchmark # sustained desktop combat with all 200 kept alive
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
- **Tuning / T:** expand or collapse all 25 battle controls. Each group also collapses independently. Live controls affect both armies immediately; controls labeled **NEW BATTLE** take effect when you deploy or restart. Changed values have a green dot, and settings persist in this browser. **Reset defaults** resets the values; **New battle** applies the full configuration. Invalid formations show an explanation and cannot deploy.
- **Sound effects:** expand the lower-left panel to adjust laser firing, Plutonian hit, Sectoid hit, Plutonian dying and Sectoid dying volumes independently. Each has a preview button; 0% mutes that effect. Levels save in this browser across reloads and restarts. Tap/click or press a key anywhere to enable audio on the first visit.

The white damage flash reproduces Pluto Mobile's emissive pulse, with a 0.12-second default duration. Deaths immediately stop blocking movement while a short capsule fall/shrink finishes. A result panel appears when either team is eliminated.

The tuning controls cover troop count, health, rifle damage/range/fire interval, speed, collision radius, field half-width/depth, frontline distance, formation columns, column/row spacing, horizontal/forward randomness, seed, search padding/interval/initial delay, avoidance distance/strength, shallow/wide detour angles, and hit-flash duration/intensity. Live health changes preserve each survivor's health fraction; they do not revive dead units. Live fire-interval changes preserve cooldown progress. Changing radius or field dimensions rebuilds the corresponding visuals and collision grid on the next deployment.

Crowd steering uses a separate seeded random stream to assign each soldier a stable left/right detour preference. IDs and column parity no longer decide which way a soldier sidesteps, and sideways escape attempts consider both directions. A regression test renumbers every unit ID and verifies identical movement, damage and outcome. In the same 100-seed sweep, the old implementation produced 16 Plutonian / 84 Sectoid wins; the corrected version produced 59 / 41, with every battle completing. This removes the identified steering bias without forcing a particular winner. Restart still reproduces the same seed and settings.

## Architecture

- `src/simulation.ts`: renderer-independent fixed 60 Hz simulation; compact reusable unit arrays, monotonic IDs, intrusive spatial grid, swept-circle movement checks, local steering, staggered targeting, grid-traversed hitscan weapons and simultaneous damage.
- `src/renderer.ts`: shared instanced capsules, guns, visors and contact shadows; per-instance hit timestamps; pooled laser/muzzle/impact effects; seeded low-poly terrain and boundary rocks. No skeletal animation, dynamic shot lights or per-unit DOM elements.
- `src/config.ts`: battlefield, unit and feedback constants, weapon definitions and pool budgets.
- `src/tuning.ts`, `src/tuning-panel.ts`: the 25-control schema, deployment validation, browser persistence, live/restart behavior and collapsible tuning UI. Each simulation owns its settings and rifle definition, so tuning one simulation does not mutate another.
- `src/audio.ts`: five original synthesized Web Audio effects, reusable PCM buffers, independent persisted mixer channels, stereo spread and compressed output. Combat notifications are bounded, rate-limited and capped at 24 simultaneous voices; pause, hidden tabs and restarts clear active sounds. Cosmetic event limits never affect combat damage.
- `src/main.ts`: responsive HUD, camera and battle controls, bounded fixed-step scheduling, visibility pausing, performance sampling and developer API.

Large rocks are scenery outside the walkable battlefield. Small gravel is only a ground detail. Interior blocking terrain and general route finding are deferred.

`window.__battle` is a developer API. Commands apply on the next simulation boundary:

```js
const battle = window.__battle;
battle.sim.queue({ type: 'spawn', team: 0, x: 18, z: 20 });
battle.sim.queue({ type: 'equip', ids: [battle.sim.id[0]], weapon: 1 });
```

Spawns reject occupied/out-of-bounds positions and full capacity. Existing IDs never identify replacement units after a slot is reused. Weapon changes preserve cooldowns. The queue owns its ID lists. These APIs prepare for later reinforcements and upgrades; player-facing purchases, jump jets, vehicles, bombs and missiles are deferred.

## Performance scope

The initial requirement is 200 active combatants at 60 FPS. The diagnostics show rolling frame p95/p99, simulation time, render submission time, draw calls, triangles, effects, resource counts and pixel ratio. Render submission measures CPU work, not GPU completion. Balanced quality caps pixel ratio at 1.5; Low caps it at 1. Cosmetic effects use a bounded buffer and never determine whether damage applies.

Stress presets are diagnostic tools, not a 60 FPS guarantee at 500 or 1,000 units. Emulated phone viewports check layout and touch controls; they do not benchmark a physical phone. Sustained target-phone testing, including thermal behavior, is still required before accepting mobile performance.

The initial NVIDIA RTX 3050 laptop baseline at 1440×1000, pixel ratio 1, measured approximately 56 FPS in normal headless Chromium with p95 18.5 ms. A subsequent uncapped throughput check with the tuning panel open, all 200 soldiers kept alive, and 480 captured frames measured p95 1.6 ms, with average render submission around 0.49 ms. The uncapped check measures available throughput; it does not establish display pacing or phone performance. Set `BATTLE_UNCAPPED=1` using your shell's syntax for an uncapped benchmark. Reports are written to `artifacts/benchmark*.json`. Browser screenshot/test timings include capture stalls and should not be used as the benchmark.

Validation includes deterministic simulation/audio/tuning tests, a 100-seed balance sweep and browser passes covering all 25 tuning controls, persistence, invalid deployment rejection, desktop/touch controls, both rendered laser colors, GPU hit-flash brightness/restoration, 1,000-unit stress deployment, battle completion and stable resource counts across restarts and battlefield rebuilds. Set `BATTLE_PANEL=1` when running the benchmark to include the open tuning panel.

The existing `../pluto-mobile` game is unchanged. No hosted deployment or backend is needed.
