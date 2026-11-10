# Pluto — Mass Combat

A standalone Three.js battle prototype: 100 black Plutonian capsules with green lasers versus 100 brown Sectoid capsules with red lasers, on a purple/red alien battlefield.

## Run

Requires Node 22.14 or newer.

```sh
npm ci
npm run dev
```

Open **http://localhost:5181/**. For a phone on the same Wi-Fi, use the network address printed by Vite and port 5181. This terrain worktree is on branch `terrain/randomized-battlefield`; the original game remains separate. The lockfile supports an independent clean install.

```sh
npm test          # deterministic simulation and collision checks
npm run build    # TypeScript and production build
npm run preview  # production preview on port 4180
npm run test:browser
npm run test:tuning # all 25 controls, persistence, validation and responsive layout
npm run test:equipment # army loadouts, exact counts, persistence and desktop/touch controls
npm run test:balance # 100 deterministic seeds; report under artifacts/
npm run test:audio:browser # sound output, mixer persistence and desktop/touch controls
npm run benchmark # sustained desktop combat with all 200 kept alive
npm run test:terrain:browser # seeded terrain, 20 resets, 1,000 units, touch, capture controls
npm run test:browser:all     # isolated flat-scene combat/camera/audio/tuning regressions
npm run benchmark:terrain   # sustained 500 vs 500 (server on 5181)
```

The browser smoke test uses Playwright Chromium. Set `BATTLE_CHROMIUM` to a browser executable if needed, `BATTLE_URL` to another local server URL, or `BATTLE_SOFTWARE=1` to use SwiftShader. It writes screenshots and a JSON report into `artifacts/`. Install Chromium with `npx playwright install chromium` if it is not already available.

## Play

The battle starts automatically on newly generated terrain. Soldiers navigate around solid boulders and steep faces, cross ridge passes, and walk up accessible rock shoulders. They approach a visible enemy in 3D weapon range and reposition when terrain hides a target. Ground, rocks, and the first enemy capsule intercept lasers; shots from both teams resolve before damage is committed. Living soldiers block movement, while teammates allow friendly shots through.

- **Pause / Space:** pause or resume.
- **Restart / R:** generate a new landscape using a fresh terrain seed. Deployment/combat keep their separate tuning seed.
- **Left-drag / one-finger drag:** pan. **Hold right-click and drag:** orbit the perspective camera.
- **Wheel / pinch / + / −:** zoom toward or away from the battlefield.
- **Center view / C:** reset the camera.
- **FPS badge / D:** diagnostics, adaptive quality controls, deployment presets through 500 vs 500, and the on-device performance capture.
- **Tuning / T:** expand or collapse all 25 battle controls. Each group also collapses independently. Live controls affect both armies immediately; controls labeled **NEW BATTLE** take effect when you deploy or restart. Changed values have a green dot, and settings persist in this browser. **Reset defaults** resets the values; **New battle** applies the full configuration. Invalid formations show an explanation and cannot deploy.
- **Equipment / E:** expand or collapse army equipment. Assign 0–100% of each item independently to Plutonians and Sectoids using sliders or whole-number inputs. The preview shows the exact number of recipients for the next deployment. Changes save on this device and apply on **New battle / Restart**.
- **Sound effects:** expand the lower-left panel to adjust laser firing, Plutonian hit, Sectoid hit, Plutonian dying and Sectoid dying volumes independently. Each has a preview button; 0% mutes that effect. Levels save in this browser across reloads and restarts. Tap/click or press a key anywhere to enable audio on the first visit.

The white damage flash reproduces Pluto Mobile's emissive pulse, with a 0.12-second default duration. Deaths immediately stop blocking movement while a short capsule fall/shrink finishes. A result panel appears when either team is eliminated.

## Army equipment

Each item goes to `round(army size × percentage / 100)` randomly selected soldiers, without selecting the same soldier twice for that item. Percentages are independent: at 100% rifle, 100% sniper and 100% shotgun, every soldier carries all three. Defaults are 100% laser rifles and 0% of the new weapons. A soldier receiving no weapons remains unarmed; an entirely unarmed battle can keep running until restarted.

| Weapon | Damage | Range | Seconds between shots |
| --- | ---: | ---: | ---: |
| Laser rifle | 9 | 10.5 | 0.46 |
| Sniper rifle | 60 | 24 | 1.8 |
| Shotgun | 45 | 4 | 0.7 |

Soldiers use the equipped weapon with the highest damage per second that can reach their target. With the default stats and all three weapons, they use a sniper at distance and a shotgun within 4 units. When nothing is in range they approach using their longest-range weapon; shotgun-only soldiers must move closer. Periodic target searches let soldiers notice closer threats. Switching retains the existing firing deadline, so it never grants a free shot. Live rifle tuning can change which weapon is preferred.

All three weapons use single-target hitscan with the existing first-enemy-hit, friendly-fire and simultaneous-damage rules. Active guns have different barrel proportions, shot widths and firing pitches. The existing firing-volume control covers every weapon.

Recipients are fixed at deployment: casualties do not redistribute equipment. Independent random streams for each army/item make the same seed and settings reproduce the loadouts without changing formation randomness or another item's recipients. Change the battle seed in Tuning to shuffle recipients. Recipient previews round to whole soldiers, including zero when the army is too small for a low percentage.

The tuning controls cover troop count, health, rifle damage/range/fire interval, speed, collision radius, field half-width/depth, frontline distance, formation columns, column/row spacing, horizontal/forward randomness, seed, search padding/interval/initial delay, avoidance distance/strength, shallow/wide detour angles, and hit-flash duration/intensity. Live health changes preserve each survivor's health fraction; they do not revive dead units. Live fire-interval changes preserve cooldown progress. Changing radius or field dimensions rebuilds the corresponding visuals and collision grid on the next deployment.

Crowd steering uses a separate seeded random stream to assign each soldier a stable left/right detour preference. IDs and column parity no longer decide which way a soldier sidesteps, and sideways escape attempts consider both directions. A regression test renumbers every unit ID and verifies identical movement, damage and outcome. In the same 100-seed sweep, the old implementation produced 16 Plutonian / 84 Sectoid wins; the corrected version produced 59 / 41, with every battle completing. This removes the identified steering bias without forcing a particular winner. Restart still reproduces the same seed and settings.

## Architecture

- `src/terrain.ts`: seeded basins, hills, climbable mesas, field-spanning ridges with passes, and convex small boulders. Shared triangle heights/slopes, support checks, swept traversal, spatially indexed cover rays, protected formations, and bounded repairs.
- `src/navigation.ts`: infantry clearance graph, connected regions, two shared multi-source flow fields rebuilt under a 1,024-node-per-tick budget, and bounded diagnostic A*. Soldiers use local steering and swept collision for crowd separation.
- `src/simulation.ts`: renderer-independent 60 Hz simulation; compact unit arrays including elevation, stable IDs, dynamic spatial grid, staggered target/visibility refreshes, 3D capsule/terrain hitscan, and simultaneous damage. Actual shots always check cover; repeated enemy tests within a shot are deduplicated.
- `src/renderer.ts`, `src/terrain-renderer.ts`: instanced capsules, guns, visors, sloped contact shadows and bounded effects; terrain meshes built from gameplay geometry, vertical gun/beam aiming, terrain-aware camera clearance, adaptive render scale, and GPU disposal on resets.
- `src/config.ts`: battlefield, unit and feedback constants, weapon definitions and pool budgets.
- `src/equipment.ts`, `src/equipment-panel.ts`: the item catalog, independent per-army percentages, validated browser persistence and collapsible deployment controls. Weapon definitions stay separate from army allocations. Inventories use compact masks alongside the active weapon array; the developer-only heavy laser remains available through the existing API.
- `src/tuning.ts`, `src/tuning-panel.ts`: the 25-control schema, deployment validation, browser persistence, live/restart behavior and collapsible tuning UI. Each simulation owns its settings and rifle definition, so tuning one simulation does not mutate another.
- `src/audio.ts`: five original synthesized Web Audio effects, reusable PCM buffers, independent persisted mixer channels, stereo spread and compressed output. Combat notifications are bounded, rate-limited and capped at 24 simultaneous voices; pause, hidden tabs and restarts clear active sounds. Cosmetic event limits never affect combat damage.
- `src/main.ts`: responsive HUD, camera and battle controls, bounded fixed-step scheduling, visibility pausing, performance sampling and developer API.

Climbable rocks use a single support surface with natural sloped approaches. Vertical faces block movement. Terrain has no tunnels or overhangs. Maps protect both deployment envelopes and validate access between armies and mesa tops. If a rare map cannot be repaired within five slope reductions, a gentle obstacle-free fallback keeps deployment playable and is exposed as six repairs in diagnostics.

`window.__battle` is a developer API. Commands apply on the next simulation boundary:

```js
const battle = window.__battle;
battle.sim.queue({ type: 'spawn', team: 0, x: 18, z: 20 });
battle.sim.queue({ type: 'equip', ids: [battle.sim.id[0]], weapon: 1 });
battle.replay(); // same terrain seed, deployment seed, and current tuning
battle.restart(500, 74319, 189423); // explicit count, battle seed, terrain seed
battle.startBenchmark(); // physical-device 5-minute warmup + 10-minute capture
```

Spawns reject occupied, out-of-bounds, steep, or rock-blocked positions and full capacity. Existing IDs never identify replacements after a slot is reused. Weapon changes preserve cooldowns. Add `?terrain=189423` to reproduce initial terrain; each ordinary restart still randomizes. `?flat=1` selects an explicit flat QA fixture. It is used by the old isolated browser assertions, not normal gameplay.

`battle.sim.inventory[slot]` contains weapon ownership bits and `battle.sim.weapon[slot]` is the active weapon (`255` means unarmed). The existing `equip` command replaces that soldier's loadout with the requested weapon, preserving its cooldown. Explicit API spawns receive their requested weapon (laser rifle by default); percentage allocation applies to army deployment. `battle.equipment` returns a copy of pending percentages, and `battle.setEquipment([{ rifle: 100, sniper: 10, shotgun: 25 }, { rifle: 100, sniper: 0, shotgun: 50 }])` stages a validated loadout for the next restart.

## Performance scope

The requirement is **60 FPS at up to 500 soldiers per side (1,000 total) on Google Pixel 10**, assuming Chrome. Physical-device acceptance is still pending. Diagnostics expose frame p95/p99, CPU simulation/render submission, navigation work, blocked units, terrain seed/build timing, resource counts, render scale, and dropped simulation time. The fixed simulation remains 60 Hz; lost catch-up time is recorded rather than hidden.

Adaptive quality caps pixel ratio at 1.5 (Low at 1) and scales it between 65% and 100% based on sustained frame pacing. Reduced capsule tessellation and bounded sparks reduce GPU work without removing soldiers, cover, collision, or damage. Emulated phone viewports validate layout and touch behavior; they do not establish physical-phone performance.

For the Pixel 10 test, open the game over Wi-Fi, open diagnostics, and tap **Benchmark 500 vs 500 · 15 min**. Keep the page visible. It retains all 1,000 soldiers, alternates 30-second movement/congestion and combat phases, warms for 5 minutes, and records for 10 minutes. Completion pauses the battle and enables **Save benchmark report**. Pause, hiding the page, or a reset cancels an active capture. Save the JSON and record the device model, browser/OS versions, charging conditions, and orientation. Inspect FPS/p95/p99 together with simulation Hz and dropped simulation seconds. No mobile-performance pass is claimed until the warmed phone result meets the requirement.

Desktop comparison results and the verification record are in `terrain-validation.md`. Raw reports/screenshots are generated in ignored `artifacts/`. Browser screenshots, explicit simulation stepping, and smoke-test timings include deliberate stalls and are not performance measurements. `BATTLE_SOURCE=.` makes `benchmark:terrain` start an isolated local server; `BATTLE_UNCAPPED=1` measures uncapped desktop throughput. The original `benchmark` command retains its older 200-unit scope.

The existing `../pluto-mobile` game is unchanged. No hosted deployment or backend is needed.
