# Truck validation

The production build and simulation suite pass. The upgrade browser smoke covers desktop and touch: a canceled paint does not deploy a truck; a completed paused paint boards a crew at rest; tapping the chassis shows hull HP and all three seats. A conflicting rifle edit leaves the active ranges unchanged. Browser screenshots and reports are generated under `artifacts/`.

In a 26-second fixed-step run per workload with seed 74319, all 500 soldiers per army stayed alive. The first 15 seconds were movement only, followed by 11 seconds with weapons enabled. This exercises the simulation and its event budgets without using frame timings as a device result:

| Workload | Opening placement | Truck contacts | Rams | Turret shots | Wrecks |
| --- | ---: | ---: | ---: | ---: | ---: |
| Packed, flat | 334 trucks, 1,000 boarded | 3,257 | 24 | 4,773 | 21 |
| Solo, flat | 1,000 trucks, 1,000 boarded | 3,825 | 6 | 0 | 28 |
| Mixed, canyon | 167 trucks, 500 boarded | 9,080 | 98 | 1,951 | 19 |

The desktop Chrome capture also completed all five workloads with a short recording and software WebGL. That run verifies frame, draw-call, placement, and queue metrics reach the JSON report. Its frame rates do not represent hardware-accelerated Chrome.

The physical Pixel 10 acceptance run is still open. Follow the [phone capture procedure](README.md#performance-scope) for the five-minute warmup and ten-minute recording on each matching baseline and vehicle workload. Check frame p95/p99 and dropped simulation time as well as FPS and simulation Hz.
