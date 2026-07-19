# OPERATION GOLDENEYE — Tactical Strike

A Counter-Strike-style bomb-defusal FPS that runs entirely in the browser.
Three.js rendering, procedural textures, synthesized WebAudio, bot AI — no
build step.

Soldier character models are from the
[Quaternius "Toon Shooter Game Kit"](https://quaternius.com/packs/toonshootergamekit.html)
(CC0), processed headlessly in Blender (mesh pruning, per-loadout weapon
meshes, GLB export) into `assets/models/`. Everything else is procedural.

Play solo with bots, host a humans-only match, or fill online teams with a
mix of humans and bots. Full economy, buy menu, rounds, radar, killfeed, and
bomb objectives are synchronized across the room. First team to 8 round wins
takes the match.

## Run

```sh
npm install
npm start
# then open http://localhost:8020
```

The Node server serves the game and hosts WebSocket rooms. A plain static
server still works for solo play, but online rooms require `npm start`.

## Game modes

- **Solo + bots:** the original offline game, with one human CT and bot teams.
- **Humans only:** create a room, share its six-character code, choose CT or T,
  and start after at least one human joins each team.
- **Humans + bots:** create or join a room; each side is filled to five players
  with bots. This mode may also be started by one human.

The room creator is the authority for bot AI, hit resolution, round timers,
and objectives. Other clients send movement and actions to the host and render
host snapshots. If the host disconnects, authority moves to another player.

Append `?test` to the URL for the automated-test mode (auto-starts the match
and simulates pointer lock for synthetic input).

## Controls

| Input | Action |
|---|---|
| WASD | Move |
| Mouse | Aim |
| LMB | Fire / throw grenade |
| RMB | AWP scope zoom |
| Space | Jump (mantles low crates) |
| Ctrl | Crouch |
| Shift | Walk (silent) |
| R | Reload |
| B | Buy menu (during buy time) |
| E (hold) | Defuse the bomb |
| E (hold, T carrier) | Plant at site A or B |
| 1–4 / wheel | Switch weapons |
| Q | Last weapon |
| Tab (hold) | Scoreboard |

## Arsenal

Pistols: G-18, USP-S (silenced), Night Hawk .50 — SMG: MP-5 — Rifles: AK-47,
M4-A1 — Sniper: AWP — plus knife, HE grenade, flashbang, and smoke grenade.
Kevlar and defuse kits in the Gear tab of the buy menu.

## Architecture

See [SPEC.md](SPEC.md) for the original gameplay architecture. The gameplay
modules (world, player, weapons, viewmodel, combat, bots, rounds, HUD, audio,
effects, input) communicate over a synchronous event bus and are wired in
[src/main.js](src/main.js). [src/network/multiplayer.js](src/network/multiplayer.js)
adds room UI, remote human entities, interpolation, client input forwarding,
and host snapshots. [server.mjs](server.mjs) owns rooms, teams, host selection,
and WebSocket message routing.

## Tests

```sh
npm test
```

The protocol test opens two real WebSocket clients and verifies room creation,
balanced teams, match start, state replication, and shot forwarding.
