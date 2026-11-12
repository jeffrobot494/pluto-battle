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
npm run test:tuning # all 29 controls, persistence, validation and responsive layout
npm run test:equipment # army loadouts, exact counts, persistence and desktop/touch controls
npm run test:balance # 100 deterministic seeds; report under artifacts/
npm run test:audio:browser # sound output, mixer persistence and desktop/touch controls
npm run benchmark # sustained desktop combat with all 200 kept alive
npm run test:terrain:browser # seeded terrain, 20 resets, 1,000 units, touch, capture controls
npm run test:browser:all     # isolated flat-scene combat/camera/audio/tuning regressions
npm run benchmark:terrain   # sustained 500 vs 500 (server on 5181)
npm run benchmark:compare -- <base> [head] # A/B frame benchmark between two commits; head defaults to the working tree
npm run test:explosions:browser # desktop/touch explosions and airborne rendering
npm run test:upgrades:browser # tap select, hold zone and upgrades on desktop and touch
npm run benchmark:simulation # 200/500/1,000 soldiers, with and without repeated blasts
npm run benchmark:explosions # sustained 1,000-soldier GPU capture with burst explosions
npm run benchmark:vehicles   # comparable infantry, packed, sparse, and mixed 500 vs 500 captures
```

The browser smoke test uses Playwright Chromium. Set `BATTLE_CHROMIUM` to a browser executable if needed, `BATTLE_URL` to another local server URL, or `BATTLE_SOFTWARE=1` to use SwiftShader. It writes screenshots and a JSON report into `artifacts/`. Install Chromium with `npx playwright install chromium` if it is not already available.

## Play

The battle starts automatically on a newly generated map. Every map is one of eleven landscape types (canyon, terraces, craters, massif, valley, mesas, blades, ice, badlands, fortress, escarpment), each with its own palette and real cliffs, plateaus and gorges; some are mirrored and fair, others give one army the high ground. The header names the map, its region and, on asymmetric maps, which army holds the heights. Soldiers navigate around solid boulders and steep faces, cross ridge passes, and walk up accessible rock shoulders. They approach a visible enemy in 3D weapon range and reposition when terrain hides a target. Ground, rocks, and the first enemy capsule intercept lasers; shots from both teams resolve before damage is committed. Living soldiers block movement, while teammates allow friendly shots through.

- **Pause / Space:** pause or resume.
- **Restart / R:** replay the battle on the same map.
- **New map / N / Play again:** a new battle on a fresh map, always of a different landscape type than the current one.
- **Left-drag / one-finger drag:** pan. **Hold right-click and drag:** orbit the perspective camera.
- **Tap / click a soldier:** select him. A ring marks him and a card above him shows his health and every gun he carries (the one in use is highlighted). Works for both armies; tap empty ground, × or Escape to deselect.
- **Tap and hold (ground):** a circle grows from the held point, faster the longer you hold, with no size limit. Release to apply the armed action inside it. With nothing armed the circle is neutral white and does nothing. Moving more than a few pixels before the circle appears pans instead; a second finger cancels it.
- **Upgrade rail / 1–4:** arm **Sniper**, **Shotgun**, **Rocket**, or **Truck**. Hold the field and release to paint an area for the selected army. **PLU / SEC / BOTH** (or **S** to cycle) sets the army for painted zones. A quick tap upgrades an individual soldier when a weapon is armed; with Truck armed, hold to deploy. The upgrades are free, work while paused, and disarm on restart.
- **Wheel / pinch / + / −:** zoom toward or away from the battlefield.
- **Center view / C:** reset the camera.
- **FPS badge / D:** diagnostics, adaptive quality controls, deployment presets through 500 vs 500, and the on-device performance capture.
- **Tuning / T:** open the grouped battle controls. Live controls affect both armies immediately; controls marked ↻ take effect in the next battle. Settings persist in this browser. Use **Reset all** or the reset button on an individual control. Invalid formations show an explanation before deployment.
- **Equipment / E:** expand or collapse army equipment. Assign 0–100% of each item independently to Plutonians and Sectoids using sliders or whole-number inputs. The preview shows the exact number of recipients for the next deployment. Changes save on this device and apply on **New battle / Restart**.
- **Test explosions:** enable the toggle beside Equipment (below Tuning on phones), then click or tap playable ground to detonate. A pointer hover shows the blast radius. Dragging still pans; right-drag and pinch keep their camera behavior. The tool works during active, unpaused combat and resets off on restart. Test explosions damage both armies.
- **Physics & explosions:** gravity, radius, damage, and impulse are live controls. Gravity defaults to 9.81 u/s²; an explosion defaults to radius 4, damage 35 HP, and impulse 10 u/s for unit-mass infantry. Zero damage enables motion-only testing; zero gravity preserves airborne velocity. New settings receive defaults when loading older saved tuning.
- **Sound effects:** expand the lower-left panel to adjust laser firing, Plutonian hit, Sectoid hit, Plutonian dying and Sectoid dying volumes independently. Each has a preview button; 0% mutes that effect. Levels save in this browser across reloads and restarts. Tap/click or press a key anywhere to enable audio on the first visit.

The white damage flash reproduces Pluto Mobile's emissive pulse, with a 0.12-second default duration. Deaths immediately stop blocking movement while a short capsule fall/shrink finishes. A result panel appears when either team is eliminated.

## Army equipment

Each item goes to `round(army size × percentage / 100)` randomly selected soldiers, without selecting the same soldier twice for that item. Percentages are independent: at 100% rifle, 100% sniper and 100% shotgun, every soldier carries all three. Defaults are 100% laser rifles and 0% of the new weapons. A soldier receiving no weapons remains unarmed; an entirely unarmed battle can keep running until restarted.

| Weapon | Damage | Range | Seconds between shots |
| --- | ---: | ---: | ---: |
| Laser rifle | 9 | 10.5 | 0.46 |
| Sniper rifle | 60 | 24 | 1.8 |
| Shotgun | 45 | 4 | 0.7 |
| Rocket launcher | 35 (blast) | 16 | single use |

Soldiers use the equipped weapon with the highest damage per second that can reach their target. With the default stats and all three weapons, they use a sniper at distance and a shotgun within 4 units. When nothing is in range they approach using their longest-range weapon; shotgun-only soldiers must move closer. Periodic target searches let soldiers notice closer threats. Switching retains the existing firing deadline, so it never grants a free shot. Live rifle tuning can change which weapon is preferred.

All three weapons use single-target hitscan with the existing first-enemy-hit, friendly-fire and simultaneous-damage rules. Active guns have different barrel proportions, shot widths and firing pitches. The existing firing-volume control covers every weapon.

### Rocket launcher

The rocket launcher carries one rocket. A soldier fires it at the first chance: as soon as a visible enemy is within rocket range he switches to it ahead of every other gun, and while he still carries it he advances only to rocket range. He aims at the lowest point of the target he can see (feet first, then waist, then chest), so near misses still land at the target's feet. Like a laser, he holds fire and sidesteps when an ally is in the flight path, but he does not check who is inside the blast radius, including himself. After firing, the launcher leaves his inventory and he switches to his best remaining gun; a soldier whose only weapon was the rocket becomes unarmed. Upgrades and equipment can give him another launcher.

The rocket flies in a straight line and explodes on the first soldier, hull, or terrain hit, using the Explosion Test blast (constant damage inside the radius, impulse falling off with distance). A rocket that hits nothing detonates after 1.5× rocket range; one that leaves the battlefield vanishes without a blast. Range, speed, blast radius, damage and impulse are live settings on the Tuning panel's **Rocket** tab.

For performance, terrain impact is ray-cast once at launch (terrain is static), so flight only tests soldiers and hulls in nearby grid cells. At most 512 rockets fly at once; a soldier who can't launch keeps his rocket and retries. Rockets, exhaust flames and smoke puffs are each one instanced draw call, and smoke fades in the shader from a bounded ring buffer (half density on low quality).

### Armored truck

Choose **Truck** and hold over a group. On release the battle assigns nearby unmounted soldiers to crews, keeping the armies separate. A truck needs one driver; the next two soldiers man the turret and ride as a passenger. Crews board together once there is space for the chassis and a short exit. Waiting soldiers stay in the fight while placement retries. The rail reports how many boarded and how many are still on foot. Pausing lets the first batch board at rest; trucks pull away and the remaining crews retry when play resumes.

Drivers look for a firing pass at the edge of turret range, retreat through open gaps, and consider charging if they have a run-up. Rams can hurt either army. The passenger uses their own weapons. Tap the chassis to inspect hull health and seats. If the driver dies, the passenger takes over first, then the gunner if needed. Empty seats can be filled by nearby allies when it is safe to slow down. Destroyed hulls are removed; their blast can eject surviving riders or set off other trucks.

**Tuning → Vehicles** shows the effective turret range in world units along with the chassis, crew, and driver controls. The turret's range stays between the live laser rifle and rocket launcher ranges. If an older save has those ranges out of order, correct them before deploying trucks.

For a stuck truck, open **Field Diagnostics** with **D** or the FPS badge and choose **Record trucks**. Let the battle run for at least two seconds, then choose **Save truck trace**. The export works while recording or after stopping. A new battle ends the recording and keeps its report available until you start another. The trace flags crewed trucks that stay within 0.25 world units for two seconds of simulation time. Look up their IDs in `stoppedTruckIds` and check `lastStop.preceding` for events just before the stop.

The compact export includes the latest driving intent, crew and pickup status, selected routes, route rejection counts, blockers, and recovery attempts. It rounds fractional measurements to four decimal places and keeps tuning values at full precision. Use **Save full trace** to get every route candidate and its original precision. In the full trace, a route check with a score of `null` failed. A blocked exit can lower the score of an otherwise usable route.

Run the same recorder without a browser with `npm run debug:trucks -- --map ice --terrain-seed 74319 --battle-seed 74319 --soldiers 30 --seconds 60`. It deploys both armies into trucks, prints a short list of stops, and writes a compact report to `artifacts/truck-trace.json` by default. Pass `--full` to export all route candidates and `--output` to keep multiple runs.

Recipients are fixed at deployment: casualties do not redistribute equipment. Independent random streams for each army/item make the same seed and settings reproduce the loadouts without changing formation randomness or another item's recipients. Change the battle seed in Tuning to shuffle recipients. Recipient previews round to whole soldiers, including zero when the army is too small for a low percentage.

The tuning controls cover gravity and explosions, troop count, health, rifle damage/range/fire interval, speed, collision radius, field half-width/depth, frontline distance, formation columns, column/row spacing, horizontal/forward randomness, seed, search padding/interval/initial delay, avoidance distance/strength, shallow/wide detour angles, and hit-flash duration/intensity. Live health changes preserve each survivor's health fraction; they do not revive dead units. Live fire-interval changes preserve cooldown progress. Changing radius or field dimensions rebuilds the corresponding visuals and collision grid on the next deployment.

Crowd steering uses a separate seeded random stream to assign each soldier a stable left/right detour preference. IDs and column parity no longer decide which way a soldier sidesteps, and sideways escape attempts consider both directions. A regression test renumbers every unit ID and verifies identical movement, damage and outcome. In the same 100-seed sweep, the old implementation produced 16 Plutonian / 84 Sectoid wins; the corrected version produced 59 / 41, with every battle completing. This removes the identified steering bias without forcing a particular winner. Restart still reproduces the same seed, settings, and command sequence.

Explosions use the full 3D distance from their center to each soldier capsule's center. Damage is applied once and is constant within the radius. Impulse points outward and falls linearly to zero at the edge. Overlapping blasts add, and a coincident body center receives an upward impulse. AI walking stops in the air; swept upright-capsule collision prevents tunneling, ground friction settles horizontal motion, and soldiers resume walking after landing. Dying bodies retain blast motion while fading. Combat stops at the result, while bodies and effects finish settling; the displayed battle duration stays fixed. Airborne bodies land on the terrain surface; boulders and unwalkable slopes stop their horizontal motion, so landed soldiers always remain on navigable ground.

## Architecture

- `src/terrain-archetypes.ts`, `src/terrain-shapes.ts`: the landscape types (layout plans of heights, spawn-pad levels, designed ramps, rock style and palette) and the noise, ridge and grading primitives they are built from.
- `src/terrain.ts`: seeded generation from an archetype plan (mirrored for symmetric maps), spawn pads, graded ramps and convex boulders. Shared triangle heights/slopes, support checks, swept traversal, spatially indexed cover rays, protected formations, and bounded repairs.
- `src/navigation.ts`: infantry clearance graph, connected regions, connectivity repair, two shared multi-source flow fields (narrow ground costs up to 5× so whole armies prefer wide approaches) rebuilt under a 1,024-node-per-tick budget, and bounded diagnostic A*. Soldiers use local steering and swept collision for crowd separation.
- `src/simulation.ts`: renderer-independent 60 Hz simulation; compact unit arrays including elevation, stable IDs, dynamic spatial grid, staggered target/visibility refreshes, 3D capsule/terrain hitscan, and simultaneous damage. Actual shots always check cover; repeated enemy tests within a shot are deduplicated.
- `src/renderer.ts`, `src/terrain-renderer.ts`: instanced capsules, guns, visors, sloped contact shadows and bounded effects; terrain meshes built from gameplay geometry, vertical gun/beam aiming, terrain-aware camera clearance, adaptive render scale, and GPU disposal on resets.
- `src/config.ts`: battlefield, unit and feedback constants, weapon definitions and pool budgets.
- `src/equipment.ts`, `src/equipment-panel.ts`: the item catalog, independent per-army percentages, validated browser persistence and collapsible deployment controls. Weapon definitions stay separate from army allocations. Inventories use compact masks alongside the active weapon array; the developer-only heavy laser remains available through the existing API.
- `src/tuning.ts`, `src/tuning-panel.ts`: the 29-control schema, deployment validation, browser persistence, live/restart behavior and collapsible tuning UI. Each simulation owns its settings and rifle definition, so tuning one simulation does not mutate another.
- `src/collision.ts`, `src/explosions.ts`: upright capsule ray tests, validated reusable explosion definitions, and a bounded presentation buffer. Infantry currently has unit mass. Scenery is static and blasts do not use occlusion.
- `src/battle-input.ts`: tap and tap-and-hold recognition shared with camera controls; drags pan, multitouch and canceled gestures abort, and an active hold locks panning.
- `src/upgrades.ts`, `src/upgrade-menu.ts`, `src/soldier-card.ts`: the upgrade catalog and zone growth curve, the right-edge upgrade rail, and the selected-soldier card.
- `src/audio.ts`: five original synthesized Web Audio effects, reusable PCM buffers, independent persisted mixer channels, stereo spread and compressed output. Combat notifications are bounded, rate-limited and capped at 24 simultaneous voices; pause, hidden tabs and restarts clear active sounds. Cosmetic event limits never affect combat damage.
- `src/main.ts`: responsive HUD, camera and battle controls, bounded fixed-step scheduling, visibility pausing, performance sampling and developer API.
- `src/vehicles.ts`, `src/vehicle-types.ts`: stable hull IDs, seat links, paint and recruitment queues, combat queries and destruction. `src/truck-controller.ts` handles ground contact and steering at 60 Hz. `src/truck-tactics.ts` budgets route decisions for the whole battle; the renderer uses one chassis batch and one turret batch.

Climbable rocks use a single support surface with natural sloped approaches. Vertical faces block movement. Terrain has no tunnels or overhangs. Maps protect both deployment envelopes and validate access between the armies and every climbable top. Where something is cut off, the generator carves a graded ramp (at most 0.5 rise per unit) along the cheapest route; it then checks that the armies are linked by ground at least 1.25 units from any cliff, and widens the route with a broader ramp if not. If a map still cannot be connected, its layout is re-rolled up to three times with the same seed and type. Only after that does a gentle obstacle-free fallback keep deployment playable, shown as 99 repairs in diagnostics; the terrain corpus tests forbid it.

`window.__battle` is a developer API. Commands apply on the next simulation boundary:

```js
const battle = window.__battle;
battle.sim.queue({ type: 'spawn', team: 0, x: 18, z: 20 });
battle.sim.queue({ type: 'equip', ids: [battle.sim.id[0]], weapon: 1 });
battle.replay(); // same terrain seed, deployment seed, and current tuning
battle.restart(500, 74319, 189423); // explicit count, battle seed, terrain seed
battle.restartMap(); // new battle on the current map
battle.newMap(); // new battle on a fresh map of a different type
battle.map; // { archetype, name, region, defender }
battle.startBenchmark(); // infantry baseline: 5-minute warmup + 10-minute capture
battle.startBenchmark(300, 600, 'packed'); // same map with a full Truck paint
battle.sim.queue({ type: 'explode', x: 0, y: 0, z: 0, radius: 4, damage: 35, impulse: 10 });
// Use the current test-explosion tuning:
battle.explode({ x: 0, y: 0, z: 0 });
```

Spawns reject occupied, out-of-bounds, steep, or rock-blocked positions and full capacity. Existing IDs never identify replacements after a slot is reused. Weapon changes preserve cooldowns. Add `?terrain=189423` to reproduce the initial map and `?map=<type>` (for example `?map=canyon`) to pin every battle to one landscape type. `?flat=1` selects an explicit flat QA fixture. It is used by the old isolated browser assertions, not normal gameplay.

`battle.sim.inventory[slot]` contains weapon ownership bits and `battle.sim.weapon[slot]` is the active weapon (`255` means unarmed). The existing `equip` command replaces that soldier's loadout with the requested weapon, preserving its cooldown. Explicit API spawns receive their requested weapon (laser rifle by default); percentage allocation applies to army deployment. `battle.equipment` returns a copy of pending percentages, and `battle.setEquipment([{ rifle: 100, sniper: 10, shotgun: 25, rocket: 0 }, { rifle: 100, sniper: 0, shotgun: 50, rocket: 20 }])` stages a validated loadout for the next restart.

## Performance scope

The requirement is **60 FPS at up to 500 soldiers per side (1,000 total) on Google Pixel 10**, assuming Chrome. Physical-device acceptance is still pending. Diagnostics expose frame p95/p99, CPU simulation/render submission, navigation work, blocked units, terrain seed/build timing, resource counts, render scale, and dropped simulation time. The fixed simulation remains 60 Hz; lost catch-up time is recorded rather than hidden.

Adaptive quality caps pixel ratio at 1.5 (Low at 1) and scales it between 65% and 100% based on sustained frame pacing. Reduced capsule tessellation and bounded sparks reduce GPU work without removing soldiers, cover, collision, or damage. Emulated phone viewports validate layout and touch behavior; they do not establish physical-phone performance.

The acceptance target is 60 FPS with 500 soldiers per side, including repeated explosions, and real-time 60 Hz simulation. Diagnostics show frame p95/p99, simulation rate, CPU simulation/render time, airborne bodies, blast candidates, contact checks, effect pool saturation, draw calls, resource counts, and pixel ratio. Render submission measures CPU work, not GPU completion. Explosion spheres are instanced in a 32-slot pool; cosmetic limits never affect damage or impulse.

Sustained Pixel 10 testing, including thermal behavior, remains required before accepting mobile performance. See `explosion-validation.md` for measured desktop results and limits.

For the Pixel 10 test, open the game over Wi-Fi, open diagnostics, choose a **Benchmark workload**, and tap **Benchmark 500 vs 500 · 15 min**. Run **Infantry baseline**, **Packed trucks** (334 crews), **Infantry baseline · spread**, **Solo trucks** (up to 1,000), and **Mixed** (one army painted, the other on foot). Use the same seed, device, orientation and quality for each pair. Run on flat ground (`?flat=1&terrain=74319`) and through chokepoints (`?map=canyon&terrain=74319`). The spread baseline and solo workload use the same wider spacing to give each truck room to start. Compare the mixed workload to the regular infantry baseline on the canyon.

Each run retains all 1,000 soldiers, alternates 30-second movement and combat phases, warms for 5 minutes, and records for 10 minutes. Vehicle runs exercise a full paint, repeat placement, and ignite clusters using the normal blast chain. Completion pauses the battle and enables **Save benchmark report**. Pause, hiding the page, or a reset cancels a capture. Record the device model, browser/OS versions, charging conditions, and orientation with the JSON. Check frame p95/p99, simulation Hz, dropped time, and frame stalls following a paint. The vehicle report includes actual boarding and peak counts, placement checks and time, tactical decision time and queue delay, contacts and rams, turret firing, destruction counts, and draw calls. A desktop or emulated-phone run does not establish the Pixel 10 result.

`benchmark:vehicles` runs the same capture profiles on desktop. Set `BATTLE_URL`, `BATTLE_SCENARIOS`, `BATTLE_WARMUP`, `BATTLE_SECONDS`, or `BATTLE_REPORT` to override defaults. In a workspace without loopback access, run `npm run build:browser-fixture` and set `BATTLE_STATIC=1`; the browser loads the standalone build from disk through the test harness.

See [the truck validation record](vehicle-validation.md) for the measured workload counts and the remaining physical-device check.

Desktop comparison results and the verification record are in `terrain-validation.md`. Raw reports/screenshots are generated in ignored `artifacts/`. Browser screenshots, explicit simulation stepping, and smoke-test timings include deliberate stalls and are not performance measurements. `BATTLE_SOURCE=<checkout>` makes `benchmark:terrain` start an isolated server on 5192 for that checkout (using its own `vite.config.ts`, with file watching off); `BATTLE_UNCAPPED=1` measures uncapped desktop throughput. `benchmark:compare` builds on this: it checks each ref out into a temporary worktree that borrows `node_modules`, alternates `COMPARE_RUNS` runs per side (default 3) at `BATTLE_COUNT` per team (default 500), uncapped by default, and prints medians with run ranges. A change counts only when the ranges don't overlap. Results go to `artifacts/benchmark-compare.json`. Measure uncapped: with vsync on, every build reads as the display's refresh rate. The original `benchmark` command retains its older 200-unit scope.

Validation includes deterministic simulation/audio/tuning/explosion tests and browser passes covering all 29 controls, persistence, invalid deployment rejection, desktop/touch controls, both rendered laser colors, GPU hit-flash brightness/restoration, airborne attachments, 1,000-unit stress deployment, battle completion and stable resources across restarts and explosions. Set `BATTLE_PANEL=1` for the original benchmark's open-panel case.

`benchmark:explosions` accepts `BATTLE_COUNT` (soldiers per team), `BATTLE_BLASTS` (`none`, `clicks`, `bursts`), `BATTLE_SECONDS`, `BATTLE_WARMUP`, `BATTLE_QUALITY`, `BATTLE_UNCAPPED`, `BATTLE_URL`, and `BATTLE_REPORT`. Defaults are 500 per side, burst mode, a 5-second warmup, and a 30-second capture. Burst mode injects four maximum-strength/radius blasts per tick for three ticks every two seconds. All soldiers retain extra health. Reports include simulation Hz, live counts, shots, blasts, CPU work, frame percentiles, and resource counts. Use five minutes of warmup and ten minutes of capture on the physical acceptance phone.

The existing `../pluto-mobile` game is unchanged. No hosted deployment or backend is needed.
