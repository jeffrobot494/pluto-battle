# Explosion validation — November 10, 2026

Implemented in the `pluto-battle-explosions` linked worktree on branch `feature/explosions`, based on prototype commit `64ebc77`. The original prototype, terrain worktree, and equipment worktree are separate. Run this prototype at http://localhost:5183/. These measurements were taken on the flat-ground branch before it was merged into `master` with terrain; on `master`, run the game at http://localhost:5181/.

## Behavior and build checks

- `npm test`: **32 tests passed**, including spherical membership, vertical exclusion, impulse falloff/addition, gravity/live changes, zero gravity, swept contacts, crowded landings, lethal motion after victory, corpse/slot lifecycle, deterministic replay, visual pool saturation, 3D lasers, and legal capsule occupancy with 1,000 soldiers.
- `npm run build`: TypeScript and production build passed.
- `npm run test:explosions:browser`: desktop and touch interactions passed; tap/drag/pinch/HUD separation, pointer cancellation, pause/restart, gravity persistence/reset, body/gun/visor elevations, ground shadows, spherical effects, and stable resources across repeated bursts/restarts.
- `npm run test:browser`: existing battle controls, camera pan/orbit/zoom, both laser colors, GPU hit flashes, stress deployments, and battle completion passed.
- `npm run test:tuning`: all **29 controls**, persistence, live values, invalid deployment rejection, and responsive layouts passed.
- `npm run test:audio:browser`: existing five-channel sound behavior, independent levels, persistence, and mute passed.
- `npm run test:balance`: all **100 seeded battles completed**, with 59 Plutonian wins and 41 Sectoid wins. The ID-renumbering regression also passes.
- `git diff --check`: clean.

Browser screenshots and JSON reports are in the ignored `artifacts/` directory. Screenshots include paused fixtures and capture stalls; their FPS badges are not performance measurements.

## Desktop performance

Machine: Windows laptop, NVIDIA RTX 3050 6 GB, Chromium through ANGLE/D3D11. Captures used a 1440×1000 viewport, pixel ratio 1, Balanced quality, five seconds of warmup, and 30 seconds of uninterrupted capture. Browser interaction tests and other benchmarks were not run concurrently with the reported captures.

All final captures retained **500 living soldiers per side**, with normal targeting/firing and extra health to prevent the workload shrinking. Click mode injects two ordinary explosions per second. Burst mode injects four radius-20, impulse-40 explosions per tick for three ticks every two seconds. Both modes use zero blast damage to retain all bodies; normal damaging/lethal behavior is covered separately by simulation/browser tests.

| Capture | FPS | Frame p95 / p99 | Simulation Hz | Blasts / shots during capture | Raw CPU work p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Ordinary combat, no blasts | 56.3 | 18.3 / 18.7 ms | 60.03 | 0 / 6,713 | See note below |
| Click-rate explosions | 56.1 | 18.5 / 18.8 ms | 60.04 | 60 / 15,244 | 9.0 ms |
| Maximum-strength burst explosions | 55.9 | 18.5 / 18.9 ms | 60.00 | 180 / 60,530 | 8.1 ms |
| Burst explosions, uncapped throughput | 153.1 | 9.8 / 11.2 ms | 60.03 | 180 / 60,511 | 8.9 ms |

The no-blast capture preceded raw CPU instrumentation; its CPU timing samples were smoothed HUD measurements and are not used for raw-work claims. The three explosion captures use raw CPU frame work. CPU work includes simulation and render submission; it excludes GPU completion. The click and burst captures had no frame intervals above 33.4 ms. Uncapped capture had no frame intervals above 16.67 ms. Burst captures reached 562 airborne soldiers and 12 simultaneously visible explosion events. GPU resources stayed at 13 geometries and one texture throughout.

Normal headless frame pacing was approximately 56 FPS even in the unchanged baseline, which measured 56.0 FPS at 500 soldiers total and 53.7 FPS at 1,000 soldiers. The final build improves the heavy workload and demonstrates processing headroom under the 16.67 ms budget in the uncapped capture. **These measurements do not verify 60 FPS display pacing.** Uncapped throughput is a separate measurement, not a physical-display guarantee.

Profiling identified crowd sweeps and target search as the main CPU costs. The implementation adds a coarse target grid, exact segment/circle checks without square roots for grounded crowd sweeps, cached detour trigonometry, and per-shot candidate stamps. Standalone 1,000-soldier simulation measurements after these changes averaged 4.96 ms/tick without blasts and 1.35 ms/tick with repeated burst blasts, compared with 9.23 and 3.07 ms/tick before optimization. Different blast trajectories change congestion; compare each fixture against itself. Full details and percentiles are in `artifacts/simulation-benchmark.json`.

Final browser capture files are `artifacts/explosions-500-none.json`, `artifacts/explosions-500-clicks.json`, `artifacts/explosions-500-bursts.json`, and `artifacts/explosions-500-bursts-uncapped.json`. Baselines are `artifacts/baseline-100.json`, `baseline-250.json`, and `baseline-500.json`. Discard `feature-500-initial.json` for performance conclusions because it overlapped browser interaction checks.

## Remaining acceptance measurement

**Physical Pixel 10 performance is unverified.** No connected physical acceptance device was available. The required five-minute warmup and ten-minute capture on that phone remain outstanding, including its real browser/OS, resolution/render scale, refresh setting, orientation, and power conditions. The implementation and desktop checks are complete; the mobile 60-FPS requirement must remain open until that capture passes.
