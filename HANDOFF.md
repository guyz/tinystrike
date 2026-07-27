# Tiny Strike — session handoff (2026-07-27)

## Repository, runtime, and deploy truth

The latest shipped code is source commit `e47ebe0` (startup loading screen),
which includes the callsign, map-selection, and dressing-collision work from
`95912ea`. It passes **287/287 tests**. GitHub Pages was built with the
production service URL and deployed from website commit `28d7c51`.

Production at https://guyzyskind.com/tinystrike now serves that artifact. GitHub
Pages reported `built` for the full
`28d7c51cc8f49c507a0e4437e7b0805600bd255a` commit. Cache-busted live copies of
the manifest, `index.html`, and `src/main.js` matched the website artifact
byte-for-byte. A fresh production browser boot showed the loader, reached the
menu with no console errors, and started a Dustyard bot match. The production
Worker and `rooms-core` were not changed or redeployed.

The local full server is running at http://localhost:8020. Restart it with
`node server.mjs` (static files + WebSocket rooms + leaderboard), **not**
`tools/dev-server.mjs`, whose static-only runtime makes online play report
"discovery offline".

Before measuring rendered output, read `tools/MEASURING.md`. Hidden or
non-compositing rAF tabs do not run the lighting update and have produced false
regression reports twice.

Deploy, only when explicitly requested:

1. `npm run build:pages -- --service-url https://tiny-strike-service.guyz-apps.workers.dev`
2. Rsync `dist/tinystrike/` over `../guyzyskind-website/tinystrike/`.
3. Commit and push this repo and the website repo.

## Startup loading screen — complete and deployed

The black wait before the menu is replaced by a dependency-free tactical loading
screen that exists in `index.html` before the game module graph starts. The
entrypoint is launched only after two animation frames, so even a warm-cache boot
paints the loader before the synchronous renderer, sky, material, and world work
begins. The progress copy is tied to real startup boundaries; the long phase
reports `BUILDING BATTLEGROUND`.

The overlay clears only after the first successful call through
`game.renderFrame()`, which also covers the trailer renderer's alternate loop. A
failed module fetch or boot exception leaves an accessible `LOAD INTERRUPTED`
state with a focused Retry button instead of a permanent black screen. The
layout accounts for safe areas and phone breakpoints and disables animation for
reduced-motion users.

Verification covered desktop, 390 x 844 portrait, 844 x 390 landscape,
warm-cache reload, normal menu dismissal, starting a bot match, `?trailer`, and a
forced `/src/main.js` 404. The Pages builder now injects runtime configuration
through an explicit HTML marker while preserving the paint-gated dynamic import.
The new loading/build contracts pass alongside the complete **287/287** suite.

## 1. Callsign leak — complete and deployed

Legacy human placeholders (`Operative`, `Operative2`, and `Operative 2`) now heal
to a stable ID-derived callsign at profile migration and at every match ingress or
display boundary: lobby/roster, remote actors, combat events, kill feed, scoreboard,
damage feedback, death UI, and spectator HUD.

Empty join fields use the profile callsign rather than a protocol placeholder.
When a duplicate tab conflicts with a ranked identity, it retries as a randomized
unranked guest. That guest identity remains isolated from the shared ranked profile
through profile edits, in-memory reconnects, and hard reloads; the resume ticket now
persists its bounded name and conflict state. Appearance changes still propagate.
An explicitly user-chosen local callsign of `Operative` remains valid and is not
"repaired" away.

Live two-tab verification used room `EEA1FC`: `NightViper-542` and unranked
`BraveZenith-110` saw matching rosters through round 1 with no placeholder names.
The focused callsign/menu suite passed 68/68; the complete suite passes 286/286.

`stash@{0}` still contains the stopped agent's obsolete partial version:
`WIP callsign-leak fix ... do not apply blind`. Do not pop or apply it; the current
worktree supersedes it.

## 2. Main-menu map selection — complete and deployed

The old 6–9 second hypothesis was false. Measured synchronous rebuild costs were:

| Map | Rebuild |
|---|---:|
| Neon Foundry | 556 ms |
| Harbor | 588 ms |
| Citadel | 1,971 ms |
| Dustyard | 2,036 ms |
| Frostline | ~2,081 ms |

Map-card selection now updates the pressed card, PLAY subtitle, game state, and
local storage immediately (the unit contract is under 100 ms). World-selection
publication is coalesced behind a 180 ms debounce. Solo PLAY flushes a pending
selection before starting, and online START does the same before sending
`start_match`, so neither path can launch the previously selected map.

All five maps reached BUY PHASE during live verification; persistence, career and
online drawers, and controls toggles stayed intact. After the final collision edits,
a fresh browser boot also reached Harbor BUY PHASE on the exact current tree.

## 3. Substantial dressing props collide — complete and deployed

This implements the user's 2026-07-27 decision and amends SPEC rule 1. The measured
thresholds are a roughly 0.25 m footprint and
`CONFIG.PLAYER.STEP_HEIGHT == 0.55 m`. Substantial free-standing dressing blocks
both movement and bullets. Cloth, cables, signage, wall fittings, vegetation, and
genuinely sub-step clutter remain non-solid.

Implemented contracts:

- Dressing is seeded and byte-identical across repeat builds and across high/low
  graphics modes.
- Every proxy has an identical, index-locked `THREE.Box3` in `world.colliders` and
  invisible raycast mesh in `world.solids`; the solid batch remains last.
- Ordinary props use a measured AABB. Tall/diagonal composites use deterministic
  contiguous segments where one envelope would incorrectly seal an open frame.
- Stacks are judged by their union, including tyre, pallet, facade, shop-stock,
  shop-table, and roof stacks. A staged singleton keeps its original ID and
  non-solid semantics.
- Nav-required proxies clear their measured footprint plus bot radius + 0.2 m,
  and stay out of spawns and plant pads. Unsafe props are omitted atomically.
- Inaccessible roof objects still stop bullets but correctly skip ground-nav XZ
  checks. Duct, extractor, hatch, water-tank stand, and roof stacks are covered.
- Open shop counters and safe slab pedestals have composite proxies. Citadel's
  fountain basin is omitted because the authored `m3 -> cs0` route intersects it.
- Harbor's floating-container stand now relocates its one unsafe corner post
  inward; admitted posts and diagonal braces have matching segmented collision
  while the intended under-container gap stays open.

Final dressing-proxy counts:

| Map | Proxies |
|---|---:|
| Dustyard | 155 |
| Frostline | 167 |
| Neon Foundry | 214 |
| Harbor | 221 |
| Citadel | 157 |

The original "~50–150" expectation predated complete composite coverage. Tests now
pin a measured cap of 225. In the worst benchmarked cases, the change added at most
about 2.42 microseconds per movement-resolution call and 19.6 microseconds per
raycast. The focused collider/batching/navigation suite passes 35/35; the full
suite passes 286/286. The final collision review found no correctness blockers.

Two verification/performance follow-ups remain:

- Do the requested live manual pass on every map: walk into a crate/wagon/stall/
  barrel, shoot a substantial prop, step over low clutter, and watch a full bot
  round for snagging. Automated movement/raycast/nav contracts pass, and the exact
  current tree boots Harbor, but pointer-lock automation did not permit a complete
  human walk/shoot pass.
- Restore a meaningful render-only low-quality dressing LOD. Prop placement is
  gameplay state now, so low and high must preserve RNG, claims, visible solid
  silhouettes, and colliders. The safe optimization is simpler meshes or isolated
  non-solid passes; the current low setting renders essentially the high-quality
  dressing (Dustyard saves only about 1.3%, the other maps are effectively equal).

## 4. WAN multiplayer consistency — PASS, Worker unchanged

The production Worker passed the previously missing authority and resume milestones.
Important caveat: these were raw Node WebSocket clients using one network egress,
not two physical browsers/devices.

Room `A4B4BA` ran for 121.032 seconds at a 200 ms cadence:

- A -> B: 602/602 exact updates; mean 191.9 ms, p50 178 ms, p95 252 ms,
  max 270 ms.
- B -> A: 602/602 exact updates; mean 171.0 ms, p50 156 ms, p95 234 ms,
  max 262 ms.
- Authority snapshots: 602/602 exact; mean 199.1 ms, p50 184 ms, p95 261 ms,
  max 288 ms. Sequence 2 through 603 had zero gaps, duplicates, mismatches, or
  regressions; replica lag was zero at the end.
- A third join received canonical sequence 604 in round 3/live with the current
  poses, host, and epoch rather than the round-start baseline.
- A silent-open authority handed off in 1,610 ms server time / 1,595 ms client
  time. Epoch advanced 2 -> 3, the shared timer advanced 1.610 seconds, the stale
  authority was fenced, and the replacement was accepted.
- After a hard WebSocket close (1006), the original client resumed after 3,044 ms
  with the same identity and match. The surviving peer remained authority; round
  3, pose, and health 73 persisted. Canonical sync RTT was 151 ms.

All probe sockets were closed, all rooms were deleted, and `/api/rooms` returned
`[]`. Verdict: same-browser coexistence and basic cross-internet play are proven,
and canonical state, silent authority handoff, third join, hard disconnect, and
resume passed this protocol probe. A true two-device/browser field test remains
useful, but there is no reproduced Worker consistency defect to fix.

## 5. Optional server hardening — deliberately unshipped

From `718197b`'s commit message: `reconnectToRoom` (shared `rooms-core`) could refuse
to replace a socket that is OPEN and recently active unless the hello carries an
explicit takeover flag, making same-origin seat theft impossible rather than merely
losing the client-side contest. Touching it changes the local server **and**
production Worker behaviour; it needs `npm run deploy:worker` and a compatibility
review. Do not piggyback it on an unrelated deploy.

## Known open defects (user-visible, not yet scheduled)

- Dustyard CT-ramp crate floats 0.9 m in air — **authored map data**
  (`src/world/map.js`, `this.crate(20.7, -19.0, 0.9, 0.9)` never touches the crate
  below). Fixing moves a collider and restores the intended crate climb onto A;
  the user was told and has not yet decided.
- Backdrop silhouettes are untextured grey boxes; fog washes their bases
  ("hovering cutouts").
- Repeating pale "coin" stains tile visibly on concrete pads.
- Red brick reads foreign in Dustyard's warm beige palette (tunnels, arch jambs).
- Final blind review verdict: "AAA: no — the space is generated, not authored"
  (even corbel/window spacing, no landmarks). It needs an authorship/composition
  pass—hero props, asymmetry, and focal points—not more shader work.
- Frame is now fill-bound on the dev machine. The next performance lever is
  capping `pixelRatio` around 1.5 on Retina (real milliseconds, slight sharpness
  cost); user approval is needed because the user drew the "no visual cost" line.

## Trailer provenance — resolved

The former unknown-origin trailer files are resolved and pushed:

- `dff27a6` refreshed the trailer renderer test and regenerated both current
  graphics videos.
- `c5c08a7` replaced the jerky grenade beat and regenerated both MP4s.

Those commits are trailer work only. The subsequent Pages deployment at `ce578bb`
includes the current trailer utility alongside the shipped feature work.
