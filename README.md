# OPERATION GOLDENEYE — Tactical Strike

A Counter-Strike-style bomb-defusal FPS that runs entirely in the browser.
Three.js rendering, procedural textures, synthesized WebAudio, bot AI — no
build step.

Soldier character models are from the
[Quaternius "Toon Shooter Game Kit"](https://quaternius.com/packs/toonshootergamekit.html)
(CC0), processed headlessly in Blender (mesh pruning, per-loadout weapon
meshes, GLB export) into `assets/models/`. Everything else is procedural.

You play as a Counter-Terrorist with bot teammates against a Terrorist bot
squad trying to plant the bomb at site A or B. Full economy, buy menu,
rounds, radar, killfeed. First team to 8 round wins takes the match.

## Run

```sh
python3 -m http.server 8020
# then open http://localhost:8020
```

Any static file server works (the importmap resolves three.js from
`node_modules`, so run `npm install` once first).

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
| 1–4 / wheel | Switch weapons |
| Q | Last weapon |
| Tab (hold) | Scoreboard |

## Arsenal

Pistols: G-18, USP-S (silenced), Night Hawk .50 — SMG: MP-5 — Rifles: AK-47,
M4-A1 — Sniper: AWP — plus knife, HE grenade, flashbang, and smoke grenade.
Kevlar and defuse kits in the Gear tab of the buy menu.

## Architecture

See [SPEC.md](SPEC.md) — 11 decoupled modules (world, player, weapons,
viewmodel, combat, bots, rounds, HUD, audio, effects, input) communicating
over a synchronous event bus, wired in [src/main.js](src/main.js).
