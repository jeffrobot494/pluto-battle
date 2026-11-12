# Pluto Battle vehicle plan

Add a fast, armored truck with a driver, a gunner, and a passenger. One driver is enough to operate it. The gunner fires the mounted turret, and the passenger uses their own weapons. The player deploys trucks through the same painted zone used for weapon upgrades.

## 1. Deploy and board

- Add **Truck** to the upgrade rail and use the existing tap-and-hold gesture, zone growth, and `PLU / SEC / BOTH` targeting. Snapshot the living, unmounted soldiers in the zone when the simulation handles the release. Group nearby soldiers by army and aim for three per truck. Fill driver, gunner, then passenger. Seven soldiers on one side ideally form crews of three, three, and one.
- In a packed crowd, place trucks from the outside inward. Search near each crew, favoring open ground they can reach and a heading with a short clear pull-away path. Test the hull footprint and exit against terrain, other soldiers, and existing trucks. Treat the assigned crew's space as vacated during this check. Commit the placement and boarding together so a failed placement leaves the crew on foot.
- Budget large deployments across simulation ticks. Waiting soldiers keep fighting on foot. Retry as earlier trucks pull away, within a tunable placement radius and retry window. Recheck that each candidate is alive and available before boarding, and give each soldier at most one pending seat. Report how many boarded and how many are still on foot when the window closes.
- Start each truck at rest. Its driver takes control immediately and follows the checked exit slowly until there is room to accelerate. While paused, apply the first placement batch through the existing command flush. Begin driving and continue deferred placement on resume.

Reuse [the upgrade catalog](src/upgrades.ts), [the gesture handler](src/battle-input.ts), and [the command dispatch in the game](src/main.ts).

## 2. Move and ram

- Model throttle, braking, reverse, steering, and lateral grip at the existing 60 Hz simulation rate. Use a simple chassis footprint, terrain height and slope for support, and swept contacts against rocks, bounds, infantry, and other trucks. Use vehicle clearance for route and placement checks.
- For a truck moving into a soldier, measure closing speed in the contact direction before impact. Above the ram threshold, scale damage and knockback with the excess speed. Use the existing infantry impulse path. Slow contacts use normal separation and yielding. Apply the ram once per contact until the bodies separate. A parked truck is a solid obstacle.
- Friendly and enemy soldiers take ram damage under the same rules. Each impact slows the truck. It can keep going through displaced soldiers while it has momentum. If it bogs down, the driver can brake or reverse to recover.

## 3. Choose a driving maneuver

Use one route scoring policy. The driver weighs approaching, making a firing pass, charging, or pulling out. Score short, drivable paths for turret line of sight, likely return fire, and where the truck can go next. With a gunner aboard, aim for the outer part of turret range and stay outside laser rifle range where terrain and the fight allow. A solo driver looks for a safe crew pickup and can still charge.

- **Scattered groups.** Pick a group the truck can pass on its open side with a turret shot and little crossfire from other groups. Keep moving through the pass, then choose the next opening. If groups close from several sides, drive through the least exposed gap toward open ground.
- **One large crowd.** Approach an exposed flank at an angle and drive along the edge. Measure standoff from the nearest enemies along that edge. Peel away when the firing lane closes or enemies start to cut off the exit.
- **Deliberate rams.** Consider a charge even with a working turret. Use local counts to estimate how many hits the truck can make above the threshold, how much speed it will lose on contact, the risk to hull and crew, and where it is likely to end up. Give potential hits on allies a strong penalty. A healthy truck with a run-up may plow through a group. A surrounded truck may charge the thinnest part of the line to break out. Tune how readily drivers take that risk with **ram aggression**.

Give each driver about **one tactical decision per second** to start. Stagger decisions and hold a chosen route briefly so trucks finish their turns. Reuse the gunner's current target and the spatial grid's local team counts. Sample a handful of short paths and reserve detailed terrain and sight checks for the best candidates under a shared budget. Movement and contact response still run at 60 Hz. A blocked truck can brake and request one new decision. Give urgent requests priority while serving older requests in turn.

Start with **eight tactical decisions per simulation tick** across the whole battle. A fully packed deployment of 334 trucks needs about 5.6 decisions per tick at the one-second interval. At the cap, a full pass through 1,000 trucks takes about 2.1 seconds. Trucks follow their current route between decisions and slow or stop if it becomes blocked. Tune the interval, commitment time, and work budget after measuring them.

## 4. Fight, fill vacant seats, and destroy trucks

- Give the hull its own HP. Seated soldiers keep individual HP, use the truck's seat positions, and receive tunable armor against incoming hits. Their truck footprint handles ground occupancy. Include the hull and exposed crew in combat queries so enemies can hit either. Use the first valid hit across terrain, hulls, and soldiers for direct fire. Resolve rocket impacts and blasts through the existing combat and simultaneous damage paths.
- The driver steers. The gunner fires from the turret with its own cooldown. The passenger uses normal weapon selection and cooldowns from their seat. Check the muzzle's firing lane, including friendly blockers, and exclude the firing truck and its crew from its own outgoing ray. The turret's effective range must sit strictly between the live laser rifle and rocket launcher ranges.
- Free a seat when its rider dies. When the driver dies, promote the passenger first to keep the turret manned, then the gunner if needed. A truck without a driver brakes to a stop. Nearby allies seek vacancies, with driver seats first. Reserve one seat per recruit, release expired or invalid reservations, and board only when the soldier is close and the truck is moving slowly enough. Drivers can slow briefly for a safe pickup.
- At zero hull HP, remove the truck permanently from the battle, clear its seats and reservations, and emit one gameplay explosion. Deal the configured explosion damage once to each former crew member and apply the normal blast to nearby units. Count crew members once even if their seat positions are also inside the blast radius. Eject survivors with blast impulse and return them to infantry control when they land. Process chain explosions within a tick budget and settle the battle outcome after pending destruction blasts resolve.

## 5. Tune and render

Add a **Vehicles** group to the [tuning panel schema](src/tuning.ts), using the existing persistence, reset, and defaults for older saves.

| Controls | Values to expose |
| --- | --- |
| Deployment and boarding | Placement distance, retry window, recruitment radius, boarding speed, reservation timeout |
| Chassis and protection | Hull HP, crew armor, top speed, acceleration, braking, reverse, turn rate, grip, slope limit |
| Turret | Range within the current rifle-to-rocket interval, damage, shot interval |
| Driver | Standoff, crowd and friendly risk weights, ram aggression, decision interval, route commitment, decisions per tick |
| Impacts and destruction | Ram speed threshold, damage and impulse scaling, speed loss on impact, destruction blast radius, damage, impulse |

Show the effective turret range in world units. Validate the interval when either weapon range changes. If a saved rifle range meets or exceeds the rocket range, show the conflict before deploying a truck. Require valid ordering for live range edits while trucks are active.

Store vehicle state in reusable arrays with stable IDs and explicit seat links. Define hulls, seat positions, and mounted weapons by vehicle type. Use a ground controller for the truck so a future flight controller can share crew, health, combat, and destruction. Batch chassis and rotating turrets with instanced meshes, draw riders at interpolated seat positions, and reuse bounded blast effects. Show hull HP and seat occupancy on inspection.

## 6. Verify gameplay and 60 FPS

- Verify deterministic grouping and placement on flat ground and in crowded terrain, including small crews, both armies, overlapping painted zones, interrupted gestures, and paused deployment. Check that blocked placements retry and report the actual result.
- Verify crew death and promotion, replacement boarding, armor and hull hits, turret range ordering, friendly and enemy rams, speed-dependent damage, and swept contacts at maximum speed. Test that a single truck explosion damages each rider once, can leave survivors, and removes the truck permanently. Exercise chain explosions near the end of a battle.
- Extend the [existing phone benchmark](README.md#performance-scope) with a full paint at 500 soldiers per side (334 trucks with packed crews), sparse deployments approaching one truck per soldier, and mixed infantry and vehicles in chokepoints. Include mass placement, repeated contacts, turret fire, and chain explosions. Compare against the infantry baseline on the same maps and device.
- Measure sustained **60 FPS and 60 Hz simulation on a physical Pixel 10 in Chrome** using the existing five-minute warmup and ten-minute capture. Check frame p95/p99, paint-release stalls, and dropped simulation time. Record driver planning time, queue delay, placement work, contacts, firing, and draw calls so performance work can target the actual cost. The planning budget is an initial setting. Physical phone performance still needs measurement.
