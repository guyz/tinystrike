# Tiny Strike — open tasks handoff (2026-07-27)

Session ended mid-work at the user's request. Main @ `718197b` is green (262 tests) and deployed to
https://guyzyskind.com/tinystrike. This file is the work queue for the next agent, with the context
needed to act without the prior conversation. **Read `tools/MEASURING.md` before measuring anything
rendered** — the rAF/lighting trap in it has produced false bug reports twice.

Run locally with `node server.mjs` (port 8020, static + WebSocket rooms + leaderboard). NOT
`tools/dev-server.mjs` — that is static-only and makes online play report "discovery offline".
Deploy: `npm run build:pages -- --service-url https://tiny-strike-service.guyz-apps.workers.dev`,
rsync `dist/tinystrike/` over `../guyzyskind-website/tinystrike/`, commit + push both repos.
The production Worker was NOT redeployed this session and nothing below requires it except item 5.

## 1. Callsign leak — "Operative" / "Operative2" shown in matches (user-reported, in progress)

Randomized callsigns exist and work in the menu (`SilentFalcon-521` style, from
`src/player/profile.js`; commit `8ed670b` added them). Somewhere in the MATCH display path a
placeholder "Operative" + dedupe suffix leaks — most likely the multiplayer join path rendering a
player before their profile syncs. Grep `Operative` across src/, trace scoreboard, kill feed,
nameplates, roster, spectator HUD; close every fallback so humans always show their randomized
callsign (request/generate rather than placeholder).

**A stopped agent's partial work is in `git stash`** ("WIP callsign-leak fix… do not apply blind"):
`profile.js` edit complete, `multiplayer.js` edit incomplete. Inspect with `git stash show -p`;
finish or redo — do not pop blind. Verify live with two tabs in one room (the seat-steal fix in
`718197b` makes two same-origin tabs coexist properly). Tests must stay ≥262 pass.

## 2. Main menu map-switch sluggishness (user-reported, not started)

"The game runs well, but the main menu does not — switching from one map to another is sluggish."
UNVERIFIED hypothesis: the map-card click triggers the full procedural world build (teardown + GPU
material bake + sky LUTs + dressing ≈ 6–9 s). Instrument the click handler first
(`_selectMap` in `src/ui/hud.js`), name the real cost, then decouple SELECTION (instant: selected
state, PLAY sub-label, localStorage; <100 ms) from LOADING (once, at PLAY, or async-debounced).
Keep all of the redesigned menu's behaviour (career drawer, PLAY ONLINE auto-expand observer,
controls toggle) and hud-*/mobile tests green. Verify a match still boots on all five maps.

## 3. Substantial props must collide (user decision, not started — reverses an old rule)

User, 2026-07-27: crates/wagons/barrels etc. that you can walk through are "not realistic" — they
must block movement AND bullets, like authored crates. This deliberately REVERSES the graphics
amendment's "never add a collider" rule; amend SPEC.md rule 1 to record the decision so it is not
"fixed" back. Scope: solid props with footprint ≥ ~0.25 m radius and top above the player's step
height (read the real constant in `src/player/player.js`). Never collide: cloth/awnings/laundry,
cables, signage, wall-mounted items, vegetation, sub-step-height clutter.

Hard contracts, in priority order — work happens in `src/world/dressing.js` (+ tests + SPEC only):
- **Cross-client determinism.** Every client builds dressing locally; nondeterministic colliders
  desync multiplayer. Verify the seeding (`src/gfx/kit/rng.js` + how dressing seeds per map), pin
  with a build-twice byte-identical-AABB-list test. Any nondeterminism found is a blocking finding.
- **Solids contracts.** `world.solids.children` is index-locked to `world.colliders`;
  `test/world-solid-batching.test.mjs` + `test/world-environment-batching.test.mjs` pin lockstep,
  batch-group-last, rays-never-hit-a-batch, drawn-object caps. `_dress()` runs before
  `_batchSolids()`/`_batchEnvironment()` in `loadMap`. New colliders must join movement AND the
  invisible raycast layer so bullets and movement agree.
- **Navigation.** Every new collider needs nav-lane clearance (bot capsule radius + 0.2 m) via the
  existing `navClearance()`; spawns and bomb-site pads stay clear. If a prop cannot clear, the prop
  moves/shrinks/loses its collider — the lane never moves. Run `test/bot-navigation.test.mjs` and
  watch a live bot round per map (bots reach both sites, no snagging).
- Verify live per map: walk into crate/wagon/stall/barrel (blocked), shoot a crate (bullet stops),
  step over sub-step-height items (passes), and quote collider counts (~50–150/map expected).

## 4. Finish the WAN multiplayer consistency verification (half done)

Question: is state consistent across devices over the internet? Same-browser two-tab play is fixed
and proven (`718197b`). A headless probe against the production Worker completed **step 1 only**:
room `EF8E07` created + joined over WAN, rosters consistent, ~170–200 ms RTT. Still unverified:
live-match positional consistency over minutes, **authority handoff when the lease-holder goes
silent without closing its socket**, hard disconnect + resume inside the 120 s grace, mid-match
third join receiving canonical (not round-start) state. Drive the real WS protocol from Node
(reference: `src/network/multiplayer.js`, `src/shared/rooms-core.mjs`; message shapes in
`test/rounds-authority.test.mjs`). Worker allows no-Origin or `https://guyzyskind.com`. Use
synthetic callsigns (PROBE-A/B), few rooms, clean up. Report verdict with numbers; fix nothing
without a repro + diagnosis first.

## 5. Optional server hardening (written up, deliberately unshipped)

From `718197b`'s commit message: `reconnectToRoom` (shared `rooms-core`) could refuse to replace a
socket that is OPEN and recently active unless the hello carries an explicit takeover flag — making
same-origin seat theft impossible rather than merely losing the client-side contest. Touching it
changes local server AND prod Worker behaviour: needs `npm run deploy:worker` and a compatibility
think-through. Do not piggyback it on an unrelated deploy.

## Known open defects (user-visible, not yet scheduled)

- Dustyard CT-ramp crate floats 0.9 m in air — **authored map data** (`src/world/map.js`,
  `this.crate(20.7, -19.0, 0.9, 0.9)` never touches the crate below). Fixing moves a collider and
  restores the intended crate-climb onto A; the user was told and has not yet decided.
- Backdrop silhouettes are untextured grey boxes; fog washes their bases ("hovering cutouts").
- Repeating pale "coin" stains tile visibly on concrete pads.
- Red brick reads foreign in Dustyard's warm beige palette (tunnels, arch jambs).
- Final blind review verdict: "AAA: no — the space is generated, not authored" (even corbel/window
  spacing, no landmarks). Needs an authorship/composition pass — hero props, asymmetry, focal
  points — not more shader work.
- Frame is now fill-bound on the dev machine: next perf lever is capping `pixelRatio` ≈1.5 on
  Retina (real ms, slight sharpness cost — user approval needed, they drew the "no visual cost"
  line).

## Unknown-origin files (do not delete blind)

`tools/trailer.js` modified + `test/trailer-current-renderer.test.mjs` +
`trailer-graphics-2026-07-27*.mp4` were in the tree at session end and did not come from this
session's agents. Investigate ownership before touching.
