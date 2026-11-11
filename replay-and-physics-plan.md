# Replay recording and physics engine plan

## Decisions (2026-11-10)

- **Why replays:** the developer wants to watch real player sessions to see what players do and
  where they quit or give up. Replays are recorded on players' phones (Android Chrome or iOS WebKit)
  and watched on the developer's PC. That means **replays must reproduce exactly on other devices**.
- **How:** our own lightweight replay system ("Option A"), not SyncPlay. Our sim is already
  deterministic from a seed plus commands (`tests/simulation.test.ts:115`), so a replay is just
  the session config plus a list of commands stamped with ticks, a few KB per battle. SyncPlay
  would have meant:
  - A full rewrite of the game logic in fixed-point math
  - About 2.5 KiB per tick of replay data
  - Builds that break old replays with each release-candidate (RC) update
- Battles will play somewhat differently, and re-balancing them is acceptable.
- A 30 Hz sim tick is acceptable if testing shows it looks fine.

## Part 1: Replays

### 1. Cross-device deterministic sim
- Basic float maths gives the same bits in every JS engine: `+ - * /`, `Math.sqrt`, `Math.fround`,
  `Math.floor` and similar.
- Transcendental functions do not. In sim code, replace `Math.sin/cos/atan2/hypot/pow/exp/log`
  with pure-JS versions in a new `src/det-math.ts` that use only exact operations.
- Add a test that bans those `Math.*` calls in sim files. It should cover simulation,
  navigation, rockets, equipment, upgrades and the sim side of terrain.
- Route every input that currently bypasses the command queue through `Command`:
  - Live tuning: `src/main.ts:403`
  - `weaponsEnabled`: `main.ts:441`
  - Direct `sim.hp[i]` writes: `main.ts:379`
  - Commands flushed while paused: `main.ts:158`
  - Restarts: `main.ts:268`
- Stamp each command with the tick it applies on.

### 2. Recorder
- **Header:**
  - Build version
  - Seed and terrain parameters
  - Army composition and roster/equipment snapshot
  - Tuning values
  - Every value the `BattleSimulation` constructor needs
- **Body:** a list of `(tick, command)` entries.
- **Checksums:** a state hash every 60 ticks (positions, hp, rocket state). The viewer can then
  tell exactly when a replay drifts.
- **Chunked saving:** flush in chunks, and flush on `onPause` and on hide. Players who give up
  often close the app partway through a battle; this is the case we care about most.

### 3. Getting replays to the developer
- **Save on the device:** write the compressed chunks to the player's `appStorage`.
  - Each player gets 10 MiB and 128 items. Each value is 256 KiB comfortable, 1 MB at most
    (`STORAGE.md:100-119`).
  - Use one key per battle (`replay:<n>`), rewritten every ~10 s of play and on
    `visibilitychange` → hidden.
  - Keep the last N battles as a ring.
  - A write still in flight when the app is killed can be lost, so we lose at most the last
    ~10 s.
  - Switch to the Files API (private, up to 50 MB, paid from creator storage) only if replays
    outgrow this.
- **Index of players with replays: a hidden leaderboard** (decided 2026-11-11).
  - Analytics can't serve as the index. All 25 `rundot analytics export` queries return totals
    only (counts, percentiles, funnels), with no per-player rows. Storage is per-player only, so
    there is no game-wide list to write to.
  - Add a `replays` board in `rundot/leaderboard.config.json`, with alltime period and higher score
    ranking first. The game never shows it.
  - When a replay is saved, submit score = current time in minutes (about 29M, under the
    999,999,999 cap), so the newest players come first. `metadata` carries
    `{ replayKeys, battles, lastScreen }`.
  - The game can submit once per 60 s per player; submit on save and skip if the cooldown is
    still running.
  - Developer side: `rundot leaderboard scores replays --limit 500 --save players.json` gives the
    profile IDs.
- **Analytics events:** still send `replay_saved {key, battle, ticks, outcome}` for totals.
- **Where players quit:** send the `session_end {screen, trigger, duration_seconds}` event.
  RUN's `session_end_summary_30d` export reports from it (`ANALYTICS.md:95`).
- **Developer side:** the creator CLI can read any player's data:
  - `rundot storage data <profile-id> --format json`
  - `rundot files get <profile-id> <key>`
  - (`cli-reference.md:463-505`)
  - A `scripts/fetch-replays.mjs` script pulls replays into a gitignored `replays/` folder for
    the viewer.
  - The script reads `players.json` from the leaderboard, then runs `rundot storage get <id> <key>`
    for each key in each entry's `replayKeys`.
- **Privacy:** check what RUN.world's terms say about recording player sessions, and disclose it.
  Snapshots contain player personal data (PII), so keep `replays/` out of git.

### 4. Session log: menus as well as battles (decided 2026-11-11)
- The menus are important too, so a replay covers the whole session, from launch to quit, as one
  timeline. Battles are segments inside it.
- **Header:** the player's save snapshot at launch, the build version and the screen size.
- **Events, each stamped with ms since launch:**
  - Every tap: normalized position, the hit element's id/label and the current screen. This
    includes taps that hit nothing, which show confusion.
  - Every menu action: open or close a screen, buy an upgrade, equip an item, change the roster,
    start a battle.
  - Battle segments: the battle replay from sections 1–2, embedded by reference.
  - Session end: screen, and trigger (hidden, pause or quit).
- **Refactor:** route every menu state change through one recordable `dispatchMenuAction()`. This
  covers `upgrade-menu.ts`, `soldiers-panel.ts`, `equipment-panel.ts` and the handlers in
  `main.ts`. It is the menu-side counterpart of the battle `Command` work.
- Record meaning, not pixels. That keeps a session to tens of KB and makes it work across screen
  sizes.
- **Rejected:** rrweb DOM recording. It needs less code, but it captures the 3D canvas poorly,
  produces much larger files (risking the 1 MB per-value limit), and battles would still need their
  own format.
- Saved with the same chunking, keys and ring as battle replays (section 3).

### 5. Viewer
- A dev-only route (`?replay=<url>`) that loads a session.
- **Menus:** rebuild the real menu panels from the save snapshot, then apply the recorded menu
  actions in time. Draw finger dots for taps, so taps on nothing stand out.
- **Battles:** play the embedded battle replay inline.
- It runs the sim at 0.5–8x speed with the normal renderer and a free camera, plus a timeline
  scrubber. To scrub, re-simulate from tick 0, or keep periodic snapshots.
- It shows a "desync at tick N" banner if a checksum does not match.

### 6. Funnel analytics
- Use `RundotGameAPI.analytics` custom events and funnel steps for screens, upgrades, the roster,
  battle start/end and quits.
- Session replays show *how* a player gave up. The funnel shows *where*, totalled across all
  players.

## Part 2: Physics engine evaluation

**Constraint:** if physics affects gameplay, it must also be deterministic across platforms.
Otherwise replays drift.

| Engine | Web build | Cross-platform deterministic? | Notes |
| --- | --- | --- | --- |
| Box3D (via `@series-inc/rundot-syncplay/physics/3d`) | WASM | Yes, by design | Erin Catto's 2026 engine (Box2D author), still alpha. Only available through SyncPlay's RC packages. S9+ 3D p99: 39 ms at 500 bodies, 88 ms at 1000 (unversioned, `SYNCPLAY-PHYSICS.md:1891`). |
| Rapier | `@dimforge/rapier3d-deterministic` | Yes, as an official build | Mature and well documented. The deterministic build is slower than the standard SIMD build. |
| Jolt (JoltPhysics.js) | WASM | Only if built yourself with `CROSS_PLATFORM_DETERMINISTIC=ON` | Very fast and production-proven. The prebuilt npm packages are not deterministic. Building needs Linux and Emscripten. |
| Havok (`@babylonjs/havok`) | WASM | Not documented | Fast, free to use, but closed source and lightly documented. |
| cannon-es, ammo.js, oimo | JS / old WASM | No guarantee | Slower; not candidates. |

**Physics spike** (1–2 days, throwaway code under `scripts/` or a dev route):
- Use the same workload in Box3D (SyncPlay), `rapier3d-deterministic` and, if feasible, a
  deterministic Jolt build:
  - The terrain as a heightfield and the rocks as hulls
  - 200, 500 and 1000 kinematic soldier capsules
  - About 50 dynamic bodies from blasts
  - 200 raycasts per tick
- Measure the p95/p99 of each step on the developer's phone and on a mid-range Android phone.
- Cross-device test: record the same scene on the phone and on the PC, and compare the hashes of
  body positions after 1,800 steps.
- Visual prototype in the game:
  - Blasts turn soldiers into dynamic capsules or simple ragdolls that tumble on the terrain.
  - Corpses settle on slopes.
  - Rocket debris.
  - Walking stays on our kinematic steering.
- **Decide:** keep our hand-written knockback, or adopt the winning engine for airborne and dead
  bodies only. A body for every walking soldier is probably too expensive on phones.
