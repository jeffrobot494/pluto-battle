# Terrain implementation and validation

Implementation worktree: `pluto-battle-terrain`, branch `terrain/randomized-battlefield`.
Baseline commit: `64ebc77` (current game snapshot before terrain changes).
Development port: 5181; production preview port: 4181.

## Delivered behavior

- Fresh, separately seeded terrain on initial load, Restart, R, Play again, and new deployments. Explicit replay preserves the active simulation settings and both seeds.
- Basins, hills, small solid angular rocks, larger raised formations with walkable approaches, and field-spanning ridges with passes.
- Shared triangulated terrain and convex rock geometry for rendering, ground height, slope limits, clearance, navigation, cover, and laser impacts.
- Two shared, incrementally built navigation fields serving the entire crowd; connected-region rejection and a bounded A* query are available for diagnostics. Crowd preferences refresh on alternating ticks; actual swept collision and movement still run at 60 Hz. Dynamic unit occupancy stays separate from static terrain.
- Vertical weapon aiming, 3D range and capsule hits, terrain-blocked shots, cover-aware retargeting/repositioning, simultaneous damage, and terrain-aligned bodies, effects, shadows, and corpses.
- Fixed-capacity query storage, team occupancy rejection, per-shot enemy deduplication, reduced capsule tessellation, bounded cosmetic effects, adaptive render resolution, and reset disposal.
- An on-device capture button with five minutes of warmup and ten minutes of recording at 500 per side. It keeps all soldiers alive, alternates crowd congestion and firing phases, records simulation progression and render scale, exports JSON, and cancels on pause, hidden page, tuning change, or reset.

Climbing uses walkable slopes on one support surface per X/Z coordinate. There are no overhangs, tunnels, vertical-wall climbing, or cliff jumps. The static clearance grid uses approximately 0.65-unit cells; runtime sweeps still enforce continuous movement legality. Initial fields can take several ticks to become ready; units wait legally during that initial preparation.

## Automated verification

- `npm test`: 27 passing tests, including the existing simulation/audio/tuning suite, exact seeded terrain, occupancy acceleration, a 100-map deployment/connectivity corpus, accessible mesa tops, convex cover, terrain crest intersections, U-shaped routing, covered-target repositioning, cliff rejection, bounded surface speed while climbing, separation, completed seeded battles, and exact replay.
- `npm run build`: TypeScript check and Vite production build pass.
- `npm run test:terrain:browser`: terrain rendering, explicit replay, 20 unique randomized resets with stable GPU resources (10 geometries / 1 texture), 500-per-side deployment, desktop and touch layouts, diagnostics, and short capture completion/cancellation.
- `npm run test:browser:all`: isolated flat fixtures preserve the existing camera controls, pause/reset/outcome, laser colors, GPU damage flash/restoration, audio mixer/persistence, and all 25 tuning controls/validation.
- `npm run test:terrain:campaign`: complete normal-health 500-versus-500 battles on three fixed terrain seeds, with periodic support and nearby-unit separation checks. Results are generated in `artifacts/terrain-campaign.json`.

The final 1,000-soldier campaigns completed at ticks 2,351 (terrain seed 1), 3,389 (189423), and 10,458 (74319), with no support or separation violations. This longer check caught a shortened-slope-move endpoint issue; shortened moves now revalidate their final support before being committed.

The terrain browser suite saves desktop deployment/combat, 1,000-soldier and phone-layout PNGs under `artifacts/`; these were visually inspected. Browser smoke timing fields include screenshots, explicit multi-tick stepping, page startup and deliberate pauses. They are not performance captures, and the short capture-control test does not satisfy the physical-phone protocol.

## Desktop performance evidence

Hardware reported by Chromium: NVIDIA GeForce RTX 3050 6GB Laptop GPU, ANGLE D3D11. Viewport 1440 by 1000, device pixel ratio 1. Each measurement keeps 500 soldiers per side alive, advances into combat, warms for three additional seconds, and captures ten seconds. Final terrain comparisons fix the render scale at 100% and use the Low profile's pixel cap of 1.

| Workload | FPS | Frame p95 / p99 | CPU simulation / rendered frame | Simulation rate |
| --- | ---: | ---: | ---: | ---: |
| Original 1,000-unit build | 56.2 | 18.4 / 18.7 ms | 6.67 ms | 60.10 Hz |
| Terrain, normal presentation | 56.3 | 18.4 / 18.9 ms | 3.75 ms | 60.09 Hz |
| Terrain, uncapped throughput | 154.3 | 11.7 / 12.8 ms | 2.43 ms | 60.10 Hz |

Both final terrain captures recorded **zero dropped simulation seconds during the measurement window**, with all 1,000 soldiers alive. Approximately 158,000 rendered triangles and 11 active draw calls were reported in the final reference scene. The normal terrain window produced 5,077 shots versus 2,121 in the original window; terrain changes the encounter and firing workload. Per-rendered-frame simulation averages also depend on render frequency, so the uncapped average is not a per-tick CPU cost.

Raw evidence: `artifacts/baseline-1000.json`, `artifacts/terrain-1000-final.json`, and `artifacts/terrain-1000-uncapped.json`. The original and terrain normal runs both presented below 60 FPS in this headless environment. Uncapped throughput shows desktop headroom; it does not establish mobile frame pacing. Startup and deliberately fast-forwarded simulation can produce lost-time diagnostics outside the capture window; the report includes a separate in-window delta.

Reproduce the terrain reference from PowerShell:

```powershell
$env:BATTLE_SOURCE = '.'
$env:BATTLE_FIXED_RESOLUTION = '1'
npm run benchmark:terrain
# Add this for uncapped desktop throughput:
$env:BATTLE_UNCAPPED = '1'
npm run benchmark:terrain
```

Set `BATTLE_REPORT` to select a report filename. To measure the baseline worktree, set `BATTLE_SOURCE` to `../pluto-battle`. The benchmark starts and closes an isolated Vite server when `BATTLE_SOURCE` is supplied. Without it, `BATTLE_URL` defaults to `http://localhost:5181/`.

`node --experimental-strip-types --no-warnings scripts/profile-terrain.mjs` records a warmed simulation CPU profile for 1,000 units under `artifacts/terrain.cpuprofile`.

## Remaining acceptance

**The requirement of sustained 60 FPS on Google Pixel 10 is not yet verified.** No physical Pixel 10 was connected during this work. The normal desktop run also does not itself demonstrate a 60-FPS pass. Physical-device measurements and any optimization they reveal remain required before accepting the performance milestone.

On the Pixel 10 in Chrome, open the development server's Wi-Fi address on port 5181, open diagnostics, and use **Benchmark 500 vs 500 · 15 min**. Leave the page visible, save the report, and record the device/browser/OS, orientation, render scale, and charging conditions. Check warmed frame p95/p99 and recurring stalls together with real-time 60 Hz simulation and zero lost simulation time. The saved report records actual results rather than declaring a performance pass automatically.
