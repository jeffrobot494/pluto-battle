# Terrain variety and verticality plan

Make every battle look very different and add much more vertical relief. Keep the guarantees from `terrain-plan.md`: one support surface per X/Z, shared gameplay/render geometry, connected approaches, legal spawns, deterministic seeds, and 60 FPS at 500 vs 500 on a Pixel 10.

This document is only the plan.

## Why every map looks the same now

`generateTerrain` in `src/terrain.ts` follows one fixed recipe:

- **Same features every time.** Each map gets one `ridge`, one `basin` on the left, one `hill` on the right, and three `mesa`s on alternating flanks. Only position and size change, within narrow ranges.
- **The S-shaped mound** is the ridge: a full-width band near z≈0 whose centerline is `sin(x / w * 3 + seed % 7)`. Only 7 phase values exist, so it looks almost the same on every map.
- **Low heights.** Heights are capped at about 2–3.7 units, roughly 2–3 soldiers tall (`soldier.height` = 1.12). Terrain can't get far above that.
- **Large flat areas.** `safe()` multiplies height by 0 over both deployment areas plus a 1.8-unit margin. With default formations, that's most of the field's depth.
- **Repair flattens the map.** When connectivity fails, `prepareTerrain` multiplies all heights by 0.8, up to 5 times (0.33× in total), then falls back to 0.1×. The maps with the most relief are the ones most likely to fail, so they get flattened.
- **Little surface detail.** The base noise is one 0.12-amplitude sine. Rock placement is uniform.
- **Same look.** Colors and fog are the same on every map. The renderer only recognizes the `mesa` kind.

## Design

### 1. Archetypes instead of a fixed recipe

Each map picks an **archetype** from the seed. An archetype is a recipe: which primitives to use, how many, how tall, how they're arranged, and how rocks are placed. All parameters are randomized. Archetypes are themed on real Pluto terrain so the look differs as well as the layout.

| Archetype | Character | Verticality |
| --- | --- | --- |
| **Canyon** | One or two winding gorges cut through a high plateau. Armies start on opposite rims or on the canyon floor | 6–10u walls; ramps down the walls |
| **Terraces** | Stepped tiers rise from one side or from the centre, like a stepped pyramid or amphitheatre | 4–6 tiers, ~1.5u each, cliff faces with switchback ramps |
| **Crater field** | Overlapping impact craters with raised rims, bowl floors and central peaks | Rims up to 4u, bowls down to −4u |
| **Central massif** | A large mountain or spire cluster in the middle. Fighting wraps around it or crosses a saddle | Summit 10–14u, a climbable shoulder plateau |
| **Valley** | Both armies start on high ground and descend into a central valley (or the reverse: a central rise) | 6–8u drop |
| **Mesa archipelago** | Many flat-topped mesas of different heights, some linked by land bridges | 3–8u tops |
| **Bladed terrain** | Parallel, steep, narrow blade ridges at an angle (like Pluto's Tartarus Dorsa). Gaps form lanes | 3–6u blades |
| **Ice plains** | Mostly smooth nitrogen-ice cells in a convection pattern, separated by trenches, with isolated drifting "iceberg" blocks | Low ground with sharp 2–4u blocks and trenches. This is the deliberate "open" map |
| **Badlands** | Domain-warped, terraced noise, eroded gullies and dense boulder clusters | Mid-range, very irregular |

Add a **modifier layer** (0–2 per map) on top of the archetype: rotated layout (no more always-horizontal features), a diagonal fault scarp across the field, scattered spires, a lone crater, river-style trench, boulder density override. Archetype × modifiers × parameters should keep consecutive maps visibly different.

Selection: pick the archetype by weighted random from the terrain seed, avoiding the previous map's archetype (`main.ts` passes the last archetype on reset). Explicit seeds still reproduce exactly. Developer API and URL override: `?terrain=canyon`.

### 2. Primitive library (`src/terrain-shapes.ts`)

Pure functions with no Three.js and no allocation in inner loops. Each writes into, or combines with, the heights array:

- **Noise:** seeded value/simplex noise, fBm, ridged fBm and domain warp. This provides the base surface detail every archetype currently lacks.
- **Stamps:** plateau (flat top with a cliff or bevel edge profile), crater (bowl, rim, optional central peak), cone/spire, dome, blade ridge.
- **Spline carving:** canyons, trenches, ramps and roads along seeded Catmull-Rom paths, with a width and a target height or grade profile.
- **Terrace operator:** quantizes height into steps with sharp risers and flat treads.
- **Combine operators:** add, max, min, smooth-max and carve (min toward a target).
- **Grade operator:** clamps slope along a path to ≤ `MAX_SLOPE × 0.8`. This one function both makes ramps and repairs connectivity (§4).

Replace the `Landform` type with a tagged feature list (`kind`, bounds, `top` height, `climbable`, `material`). Navigation validation and the renderer read it instead of looking for `mesa` by name.

### 3. Raise the height budget and stop flattening spawns

- Raise the height cap to about 12–14u (about 11 soldiers tall), scaled by `min(halfWidth, halfDepth)` so compact fields stay playable.
- Replace "flatten spawn to 0" with **spawn pads**: a graded pad for each army at a target height chosen by the archetype (rim, plateau, valley floor). Blend outward over a shorter margin. Pads only need to be within the infantry slope limit, not perfectly flat. Gentle undulation is fine as long as every spawn footprint passes `canStand`.
- **Fairness:** each archetype declares a symmetry mode: point-mirror (most maps), X-mirror, or *asymmetric*. Asymmetric maps must pass a fairness check: route length from each spawn to the centre within ±15%, and spawn heights within ±1.5u unless the archetype says otherwise (Valley flips which side has the high ground). Generate the noise for one half and mirror it so symmetric maps don't look copy-pasted. Mirror the macro layout only, and use independent fine detail on each half.

### 4. Repair that keeps verticality

Replace global height scaling in `prepareTerrain`:

1. Build navigation and label regions as today.
2. If a spawn or a required climbable top is disconnected, run a **cost-weighted A\*** on the height grid. Steep edges are allowed at a high cost proportional to excess slope. This finds the cheapest place to cut a ramp.
3. **Grade** that path into a ramp at least `6 × radius` wide, or wide enough for a crowd (see `terrain-plan.md`), using the §2 grade operator. Rebuild only the affected cells and navigation.
4. Repeat for each disconnected requirement, up to a fixed number of ramps. If that's still not enough, regenerate with a derived sub-seed (bounded, e.g. 3 attempts) and then fall back to a known-good archetype preset. Keep the 0.1× flatten only as a last resort, and treat it as a test failure across the corpus.

Most archetypes should also *design in* their access: canyon ramps, terrace switchbacks and massif shoulders. Repair should be uncommon. `terrain.repairs` and a new `terrain.ramps` diagnostic track it.

### 5. Rocks and set dressing

Each archetype supplies a rock distribution: clustered (boulder fields at cliff bases, on crater rims), scattered, lined along blade gaps, or sparse. Allow a wider size range, including a few large rocks of about 2u. Keep the 256-rock capacity and the static bucket index. Place rocks after grading so they never block a carved ramp. Ramp paths are kept clear the same way the current pass gaps are.

### 6. Rendering and look

- **Per-archetype palette and lighting.** Use Pluto's real colour range: pale blue-white nitrogen ice (Ice plains), tholin reds and browns (Badlands, Canyon), grey-violet highlands. Set fog colour and distance, sky colour and sun angle per archetype, scaled to the taller relief.
- **Shading by slope and height:** cliff faces (slope > `MAX_SLOPE`) get a distinct rock colour, flat treads get a dust/ice colour, and height bands add strata. Players should see at a glance what is climbable and what is a wall.
- **Cliff resolution:** at 0.65u cells, 10u walls render as tall faceted triangles. This suits the faceted style, but check grazing intersections and shadow artefacts. If ramps look jagged, try 0.5u resolution and measure the nav/ray cost before switching.
- **Camera:** extend the framing distance in `renderer.ts` to `maxHeight`, and keep the ground clamp. Check that tall massifs don't hide the frontline from the default view. Choose the default camera azimuth per map so the main feature is visible rather than blocking the view.

### 7. Gameplay interactions to watch

- More relief means more occlusion. Soldiers that can't see an enemy reposition, so check for stalemates where armies camp on opposite rims out of sight. The battle campaign (`scripts/terrain-campaign.mjs`) must finish for every archetype.
- Elevated positions with 10.5u rifle range: a soldier 10u up has very little horizontal reach. Range is 3D, so high ground is a trade-off. Tune heights so dominant positions stay contestable.
- Ray cost: the `maxHeight` early-out in `raycast` is less effective when maps are tall. Add a coarse per-block max-height mip (e.g. 8×8 cells) so rays skip open areas quickly.
- `explosion-plan.md` adds airborne bodies. Landing must use the same support surface, and bodies knocked off cliffs fall. Steep terrain will exercise this.

## Implementation order

1. **Visual harness first.** Add `scripts/terrain-gallery.mjs`, which generates N seeds and writes an HTML contact sheet of shaded top-down heightmaps with archetype, height range, steep %, repairs and generation time. Run it on the current generator to get a "before" baseline.
2. **Primitives + noise** (`terrain-shapes.ts`) with unit tests: determinism, the grade operator never exceeding its slope limit, and mirror symmetry.
3. **Archetype framework.** Refactor `generateTerrain` into select archetype → build macro layout → modifiers → spawn pads → base detail → grade designed ramps → rocks. Port the current recipe as one archetype, "Rolling", to keep the existing tests stable.
4. **Path-carving repair** in `prepareTerrain`, replacing global scaling.
5. **Archetypes one at a time.** Start with Canyon, Terraces and Crater field (most different from today), then Massif, Valley, Mesa archipelago, Bladed, Ice plains and Badlands. Check each in the gallery before moving on.
6. **Rendering:** palettes, slope/strata shading, fog/sky, camera framing.
7. **Performance:** add the raycast height mip, re-profile with the tallest archetypes, run the 500 v 500 benchmark on each archetype, and record the worst case.
8. **Docs:** update the README, `terrain-validation.md` and the in-game help text.

## Verification

- **Variety:** across 200 seeds, every archetype appears, and no two consecutive resets share an archetype. Median height range ≥ 6u and 90th percentile ≥ 10u. Add a simple dissimilarity metric: the mean normalized height difference between sampled map pairs, which must exceed a threshold. Flag any pair of gallery maps that look near-identical.
- **Playability (existing corpus test, extended):** 100 seeds *per archetype* with legal spawns, connected approaches and reachable climbable tops. Final-fallback use = 0. Repair ramps ≤ 3 per map on average. Generation time is bounded.
- **Fairness:** route-length and spawn-height checks pass on symmetric and asymmetric archetypes.
- **Battles:** the campaign script runs across all archetypes and finishes without stalls. Soldiers stay supported and never overlap.
- **Determinism:** the same seed and archetype give byte-identical heights, rocks and replays.
- **Performance:** 500 v 500 at 60 FPS on the worst archetype (likely Massif or Canyon, because of occlusion-driven repathing and long rays), using the existing benchmark scripts plus Pixel 10 acceptance.
- **Visual:** gallery review and in-game screenshots of each archetype on desktop and in phone portrait.

## Decisions

- **Asymmetric maps: yes.** Add attacker vs defender archetypes or variants (e.g. a defender on a fortified plateau or a canyon rim, an attacker below with several ramps up). Randomize which army defends. These maps skip the fairness check in §3. Instead, track how often each side wins in campaign runs, so that one-sided layouts can be tuned rather than blocked.
- **Camera: yes.** The default camera may sit higher and further back to frame tall terrain.

- **Map name + reroll: yes.** Before and during a battle, show the map's name (e.g. "Crater Field", "Canyon") and, on lopsided maps, which army is defending. Add a **Reroll map** button that makes a fresh random map with a new terrain seed and restarts the battle. Reroll uses the same reset path as Restart/R (rebuild terrain, navigation and simulation together, then clean up the old map's GPU resources). It also never repeats the archetype just shown. The terrain seed stays visible in diagnostics for exact replay. Add this to step 6 of the implementation order, and add a browser smoke test that rerolls several times and checks that the name changes and resources settle.
