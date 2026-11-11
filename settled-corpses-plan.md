# Settled corpses

## Player behavior

- Add **Keep settled corpses** under **Tuning → Physics**. Default to off and save it with the other tuning settings. The checkbox works during play, while paused, and on the results screen.
- With the checkbox on, soldiers fall and respond to blasts as they do today. Once settled, they stay visible on the terrain until the next battle.
- Turning the checkbox off hides settled bodies immediately and restores the current fade for recent deaths. Turning it back on shows the retained bodies from this battle, including deaths from before the checkbox was enabled. Restart, replay, and new deployment start with a clean field.

## Implementation

1. **Wire up the checkbox.** Add an off/on definition to `src/tuning.ts` and render it as a checkbox in `src/tuning-panel.ts`. Use the existing live update, search, per-control reset, Reset all, and settings storage paths. Older settings files should load with the checkbox off.
2. **Capture each body when it leaves physics.** In `src/simulation.ts`, snapshot its final position and motion, soldier ID, team, facing, and equipment at the existing 1.8-second cutoff. Capture before the slot can be reused, including when a command spawns a reinforcement on the cutoff tick. Preserve the armor rank from the death appearance by soldier ID. Keep up to 1,000 snapshots per battle, enough for every casualty in a standard 500-vs.-500 battle. If reinforcements push the count past that limit, reuse the oldest snapshot.
3. **Finish landing and align to terrain.** In `src/renderer.ts`, keep the existing fall animation and draw the body at full size while the checkbox is on. If a strong blast leaves a body airborne at the cutoff, finish its descent visually at its last horizontal position. Bound the landing time so it can finish at zero gravity. Sample the ground under the body to choose its resting angle and height. Place the weapon, visor, armor, and shadow from that final pose. Advance the visual landing on the existing presentation clock so it can finish after victory and freezes while paused.
4. **Draw settled bodies from instanced buffers.** Give settled bodies their own mesh instances so a soldier-slot reuse can neither move nor recolor a corpse. Write each matrix and appearance attribute once at landing. Upload the changed ranges as bodies settle or the pool wraps. The checkbox can show or hide those batches directly. Preserve the existing combat grid, blast eligibility window, and slot reuse timing.

## Verification

- Exercise the checkbox on desktop and touch. Check search, live toggling, persistence, Reset all, and cleanup on restart and replay.
- Kill soldiers on flat ground and on a slope. Check that bodies rest on the surface with their original equipment and armor. Test a blast that leaves a corpse airborne at the cutoff, including at zero gravity, and let the final casualty settle after victory.
- Reuse a dead soldier's slot for a reinforcement and check that the corpse stays in place with its original appearance. Exceed the snapshot limit and check that the oldest entry is evicted and the batch count stays bounded.
- Compare the same seeded 500-vs.-500 battle with the checkbox on and off. Check frame times, triangles, and instance-buffer updates as casualties accumulate. Once the scene settles, the corpse buffers should stop uploading. Verify the 60 FPS target on a physical Pixel 10 with casualties enabled.
