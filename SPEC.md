# TINY STRIKE — Architecture Spec (v1)

A Counter-Strike-style bomb-defusal FPS in the browser. Three.js (v0.166, ES modules via
importmap, import from `'three'`). No build step; textures are procedural canvas
textures and audio is WebAudio synthesis.

**Amendment (v1.1):** bot bodies are now skinned GLB soldiers (Quaternius "Toon Shooter
Game Kit", CC0, processed headlessly in Blender → `assets/models/soldier_ct.glb` /
`soldier_t.glb`, 17 animation clips each). `three/addons` imports are permitted for
exactly this pipeline (`GLTFLoader`, `SkeletonUtils`) via the `three/addons/` importmap
entry; the primitive-box bodies in bots.js remain as the loading/error fallback. Combat
hit detection is unchanged (analytic capsules — models are purely visual). Other modules
should still avoid addons.

The player is a **CT** with `CONFIG.MATCH.BOTS_PER_TEAM - 1` CT bot teammates against
`CONFIG.MATCH.BOTS_PER_TEAM` T bots. T bots try to plant the bomb at site A or B; the
player/CTs defend, retake, and defuse. Full economy, buy menu, rounds, HUD, effects, audio.

## Hard rules for every module

1. Plain JavaScript ES modules. Import three as `import * as THREE from 'three'`.
2. Each gameplay module **default-exports one class**. Constructor signature is exactly
   `constructor(game)`. Do not do heavy work outside the class.
3. Never reach into another module's internals beyond the APIs in this spec. Cross-module
   side effects go through `game.events` (an `EventBus` from `src/shared/events.js` with
   `on(type, fn)`, `off(type, fn)`, `emit(type, payload)` — synchronous).
4. Read constants from `game.config` (the `CONFIG` object in `src/shared/config.js`).
5. Reuse scratch `THREE.Vector3`s in per-frame code; do not allocate in hot loops.
6. If a module needs per-frame work it exposes `update(dt)`; `dt` is clamped ≤ 0.05 s.
7. All world geometry that blocks movement/bullets is **axis-aligned boxes**. Slopes are
   staircases of boxes (the player controller auto-steps `CONFIG.PLAYER.STEP_HEIGHT`).
8. Y is up. Positions of characters refer to **feet** (bottom of capsule). Meters/seconds.
9. Every module must be defensive at boot: if a DOM element or subsystem reference it
   wants is missing at construction time, look it up lazily in `update()`/handlers instead
   of crashing (construction order is fixed, listed below).
10. No `console.log` spam in the frame loop. `console.warn` for real anomalies only.

## The `game` context object (created in src/main.js)

```js
game = {
  config,            // CONFIG
  events,            // EventBus
  renderer,          // THREE.WebGLRenderer (shadows enabled, PCFSoft)
  scene,             // THREE.Scene
  camera,            // THREE.PerspectiveCamera (fov CONFIG.PLAYER.FOV)
  canvas,            // renderer.domElement (inside #app)
  hudRoot,           // document.getElementById('hud')
  debug,             // true when URL has ?test — see Test mode
  state: {
    phase: 'menu',   // 'menu' | 'freeze' | 'live' | 'planted' | 'roundEnd' | 'gameEnd'
    round: 0,        // 1-based once match starts
    scores: { ct: 0, t: 0 },
    timer: 0,        // seconds remaining in current phase (rounds module owns this)
    money: 800,      // player money (rounds/economy owns this)
    bomb: { planted: false, site: null, pos: null, defusingBy: null, defuseProgress: 0 },
  },
  // subsystem references, assigned by main.js in this construction order:
  input, world, effects, audio, player, weapons, viewmodel, combat, bots, rounds, hud,
}
```

Per-frame update order (main.js): `rounds, player, weapons, viewmodel, bots, combat,
effects, hud, audio, input` (input last — it clears one-frame state), then render.

## Test mode (`?test` in URL → `game.debug === true`)

- The match auto-starts ~0.5 s after load (rounds module emits the same flow as clicking
  START on the menu).
- Input module treats the mouse as captured without real pointer lock and still processes
  synthetic `keydown/keyup/mousedown/mouseup/mousemove` events dispatched on `window`.
- main.js exposes `window.__game = game` (always, not only in test mode).

---

## Module assignments

### A. `src/core/input.js` — class `Input`

Keyboard/mouse + pointer lock.

Public API:
- `locked` (bool) — pointer lock active (in `game.debug`, true once the canvas has been
  clicked once or immediately after `requestLock()`).
- `isDown(key)` — `key` is a lowercase single char (`'w'`,`'b'`), `' '` for space, or one
  of `'shift'`,`'control'`,`'tab'`,`'escape'`. Uses `e.key.toLowerCase()`.
- `consumeLook()` → `{ dx, dy }` accumulated mouse movement (pixels) since last call,
  then zeroed. Only accumulates while `locked`.
- `firing` (bool, LMB held), `aiming` (bool, RMB held).
- `requestLock()` — request pointer lock on `game.canvas`.
- `update(dt)` — clears one-frame state (wheel, just-pressed sets).

Events emitted on `game.events`:
- `'input:keydown' { key }` (lowercased, on physical keydown, no auto-repeat)
- `'input:mousedown' { button }` / `'input:mouseup' { button }` (0 left, 2 right) —
  only while `locked`.
- `'input:wheel' { dir }` — `dir` is +1 (down) / −1 (up), only while `locked`.
- `'input:lock'` / `'input:unlock'` on pointer-lock change. In `game.debug`, emit
  `'input:lock'` when lock is simulated.

Behavior: clicking the canvas when unlocked calls `requestLock()`. Tab must
`preventDefault()`. Also prevent default on `contextmenu` over the canvas. Listen on
`window` so synthetic events work in tests.

### B. `src/world/textures.js` + `src/world/map.js` — class `World` (map.js default export)

`textures.js` exports named functions producing `THREE.CanvasTexture`s (512×512 unless
noted), each accepting an options object: `makeWallTexture({ base, accent })` (sandstone
plaster with grime streaks and brick hints), `makeFloorTexture({ base })` (dusty
concrete/sand with cracks and pebbles), `makeCrateTexture()` (wooden crate planks with
frame), `makeMetalTexture({ base })` (brushed metal with rivets), `makeSkyTexture()`
(1024×512 vertical gradient, warm desert dusk sky with faint clouds; used on a sky dome
or `scene.background` equirect). Set `wrapS/wrapT = THREE.RepeatWrapping`,
`colorSpace = THREE.SRGBColorSpace`. Deterministic (seeded PRNG, no `Math.random`).

`World` builds a Dust2-inspired desert map into `game.scene` at construction:
- Playable bounds roughly 100 m × 80 m enclosed by tall boundary walls. Two elevated
  bomb sites (A via a long ramp/catwalk, B inside a tunnel-fed room), an open mid lane
  with a low "double doors" chokepoint, side corridors connecting T spawn ↔ mid ↔ both
  sites and CT spawn ↔ both sites. Crates (climbable via steps where useful), archways
  (box lintels), barrels, sandbag walls (box stacks), platforms, stairs (box steps per
  rule 7). Distinct look per zone (wall accent tints) so players can orient.
- Lighting: warm `THREE.DirectionalLight` sun (~35° elevation) with a single shadow map
  covering the whole map (2048², tuned bias), `THREE.HemisphereLight` sky/ground fill,
  subtle `scene.fog` (warm haze, far ~160), sky via `makeSkyTexture`.
- Materials: `MeshStandardMaterial` (or Lambert where cheaper), roughness ~0.9. Repeat
  textures to keep texel density sane. `castShadow`/`receiveShadow` on.
- Merge static geometry into few meshes where easy (`BufferGeometryUtils` is an addon —
  NOT allowed; instead just reuse geometries/materials and add many meshes; that is fine).

Public API:
- `colliders` — `THREE.Box3[]` of every solid (world-space, static).
- `solids` — `THREE.Group` containing all solid meshes (for raycasts). Every mesh in it
  has `userData.surface` = `'concrete' | 'wood' | 'metal' | 'sand'`.
- `resolveMovement(pos, delta, radius, height)` → returns `{ pos: Vector3, onGround:
  bool, hitCeiling: bool }`. Axis-separated AABB sweep of a capsule-as-box (footprint
  `radius`, height `height`, position = feet): apply `delta.x` then `delta.z` (with
  step-up ≤ `CONFIG.PLAYER.STEP_HEIGHT` when moving horizontally into a low ledge while
  starting on ground) then `delta.y`. Used by player AND bots.
- `raycast(origin, dir, maxDist)` → `{ point, normal, distance, mesh, surface } | null`
  against `solids` (use one shared `THREE.Raycaster`).
- `spawns` — `{ ct: [{ pos: Vector3, yaw }...], t: [...] }` ≥ 6 each, spread out.
- `bombSites` — `[{ name: 'A', center: Vector3, box: THREE.Box3 }, { name: 'B', ... }]`
  (box = the plantable zone, generous, ~8 m across).
- `waypoints` — `{ nodes: [{ id, pos: Vector3 }...], edges: [[idA, idB]...] }` — a
  hand-authored graph (~60+ nodes) covering every lane/room; edges only between mutually
  reachable nodes (no walls between them; verify visually when authoring).
- `findPath(from, to)` → `Vector3[]` (A* over waypoints; snap endpoints to nearest node;
  returned points are node positions ending with `to`). Cache per (fromNode,toNode) OK.
- `nearestWaypoint(pos)` → node object.
- `randomPointNear(pos, r)` → Vector3 on the nav graph within r (for bot wander).

Map authoring style: build a helper `box(x, y, z, w, h, d, material, surface)` that adds
mesh + collider. Author the layout as data tables. Keep sight lines: long A ramp lane,
mid lane, tight B tunnels.

### C. `src/player/player.js` — class `Player`

First-person controller + camera + health.

Public API:
- `position` (Vector3, feet), `velocity` (Vector3), `yaw`, `pitch` (radians),
  `health`, `armor`, `hasKit` (bool), `alive`, `team` (`'ct'`), `onGround`,
  `crouching`, `walking`, `moveSpeed2D` (horizontal speed, m/s), `eyeHeight` (current,
  lerps stand↔crouch), `radius`.
- `eyePos()` → Vector3 (world eye position; allocate-free getter into an internal temp
  is fine but return a Vector3 the caller may clone).
- `addViewPunch(pitchRad, yawRad)` — recoil kick; decays smoothly (~8/s toward zero).
  Punch offsets are applied to the camera on top of `yaw/pitch` (do not pollute aim
  state).
- `addShake(strength)` — brief camera shake (explosions).
- `takeDamage(amount, { from, weapon, headshot, part })` — armor math: if `armor > 0`,
  health takes `amount * CONFIG.ARMOR_DAMAGE_SCALE`... specifically
  `healthDmg = armor > 0 ? amount * 0.5 : amount`; `armor = max(0, armor - amount*0.5)`.
  Emits `'player:damage' { amount, from, dirYaw }` (`dirYaw` = world yaw angle from
  player to attacker for HUD direction indicator). At ≤0 health (once): `alive = false`,
  emit `'player:death' { killer, weapon, headshot }`.
- `resetForRound(spawn)` — `spawn` is `{ pos, yaw }`: full health, keep armor? No —
  armor persists between rounds only if bought (keep current armor), alive = true,
  velocity zeroed, position/yaw set.
- `update(dt)`:
  - If `game.state.phase` is `'menu'` do nothing. If not `alive`, run spectator-ish
    static camera (stay at death spot, slight downward tilt) and return.
  - Look: `input.consumeLook()` → yaw/pitch (sensitivity ~0.0022 rad/px, pitch clamped
    ±1.45 rad). During `'freeze'` phase, look is allowed but movement is locked.
  - Move: WASD wishdir in yaw space; target speed = RUN/WALK/CROUCH speed ×
    `game.weapons.currentMoveMult()` (guard: default 1 if weapons not ready). Ground:
    accelerate toward wishdir (ACCEL_GROUND), exponential friction (FRICTION_GROUND)
    when no input. Air: weak accel (ACCEL_AIR). Jump on space when `onGround` (velocity
    y = JUMP_VELOCITY) — emits `'player:jump'`. Crouch on ctrl (eye+hitbox height
    lerp ~12/s, can stay crouched under low ceilings — if uncrouching would collide,
    stay crouched). Walk on shift.
  - Gravity then `world.resolveMovement`. Landing after fall ≥ 3 m/s down: emit
    `'player:land' { speed }` and a small view dip.
  - Footsteps: while on ground and `moveSpeed2D > 2` accumulate distance; every ~2.5 m
    emit `'player:footstep' { pos, walking, surface }` (surface from a short down
    raycast, default `'concrete'`).
  - View bob: subtle sinusoidal bob scaled by speed (amplitude ≤ 0.02 m, disabled when
    aiming a scope — check `game.weapons.isScoped()` guarded); apply camera transform:
    position = eye + bob + shake, rotation = yaw/pitch + viewpunch + shake.
- Hitbox for enemy fire: expose `hitCapsule()` → `{ pos (feet), radius, height }`
  reflecting crouch state; head zone is top 0.3 m.

### D. `src/weapons/data.js` + `src/weapons/weapons.js` — class `Weapons` (weapons.js default)

`data.js` exports `WEAPONS` (object keyed by id) and `BUY_MENU` (array of
`{ category, items: [ids] }` for the HUD). Weapons (CS-inspired stats, prices in $):

| id | name | slot | price | dmg | rpm | mag | reserve | reload s | notes |
|---|---|---|---|---|---|---|---|---|---|
| knife | Knife | 3 | — | 34 (65 back) | 120 | — | — | — | 1.8 m melee ray |
| glock | G-18 | 2 | 200 | 26 | 400 | 20 | 120 | 2.2 | starting T pistol |
| usp | USP-S | 2 | 200 | 34 | 352 | 12 | 100 | 2.2 | starting CT pistol, quiet |
| deagle | Night Hawk | 2 | 700 | 58 | 267*0.6 | 7 | 35 | 2.2 | heavy recoil (rpm 160) |
| mp5 | MP-5 | 1 | 1500 | 26 | 750 | 30 | 120 | 2.6 | low recoil, fast move |
| ak47 | AK-47 | 1 | 2700 | 36 | 600 | 30 | 90 | 2.5 | 1-HS kill vs unarmored+armored |
| m4a1 | M4-A1 | 1 | 3100 | 33 | 666 | 30 | 90 | 3.0 | accurate |
| awp | AWP | 1 | 4750 | 115 | 41 | 10 | 30 | 3.6 | scoped, bolt action |
| hegrenade | HE Grenade | 4 | 300 | 98 max | — | 1 | — | — | radial falloff, radius 9 m |
| flashbang | Flashbang | 4 | 200 | — | — | 2 | — | — | blind by view angle/LOS |
| smokegrenade | Smoke | 4 | 300 | — | — | 1 | — | — | 15 s vision blocker |

Common fields per weapon: `id, name, slot, price, damage, headshotMult (4; awp 2.5),
rpm, magSize, reserve, reloadTime, killReward (300 default; knife 1500, awp 100,
mp5 600), auto (bool; ak/m4/mp5/glock? glock false, mp5/ak/m4 true), spreadBase (rad),
spreadMove (added at full speed), spreadJump, recoil { pitchPerShot, yawJitter,
recovery }, penetration (0–1; rifles/awp high, pistols low, knife 0), falloffStart (m),
falloffEnd, falloffMinScale, moveSpeedMult (knife 1.0, pistols 0.95, mp5 0.92, rifles
0.85, awp 0.72), zoomFov (awp: [26, 11]), fireSound profile id string, tracerEvery
(1 for rifles, 0 = none for usp? no—all 1), viewmodel hint string.

Values should feel CS-like: e.g. ak `spreadBase 0.0022`, `recoil.pitchPerShot ~0.0135`
with growing yaw sway after 5th shot (spray pattern: implement as recoilIndex-driven
lookup curve — first 4 shots mostly vertical, then horizontal drift alternating).

`Weapons` (player inventory + firing state machine):
- Slots: `{ 1: primaryId|null, 2: secondaryId|null, 3: 'knife', 4: [grenadeIds...] }`,
  `ammo` per owned weapon `{ mag, reserve }`, `currentId`.
- Public: `current()` → weapon def; `currentAmmo()`; `currentMoveMult()`;
  `currentSpread()` (rad — base + movement + jump + recoil bloom; HUD crosshair reads
  this); `isScoped()`; `scopeLevel` (0/1/2); `owns(id)`; `equip(id)` (0.6 s switch,
  emits `'weapon:equip' { id }` when raised); `give(id, free=false)`;
  `buy(id)` — checks phase (`freeze` or first 10 s of `live`... simplify: phase
  `'freeze'` only... no: allow while `phase==='freeze'` OR player within 12 m of own
  spawn during first 20 s of `live`; on success `game.state.money -= price`, auto-equip
  if slot empty, emits `'econ:buy' { id, price }`; also handles `'armor'` ($650 → armor
  100) and `'kit'` ($400 → player.hasKit=true) pseudo-items); `dropCurrent()` optional
  no-op; `resetForRound(lostRound)` — on match start give team pistol (usp) + knife;
  keep guns between rounds (CS-style: keep if survived; if died, lose primary+secondary
  back to usp) — implement: rounds module passes `{ died }`; refill mags free at round
  start; grenades cleared if died.
- `update(dt)`: handle equip timers, reload (R or auto on empty mag + fire attempt;
  emits `'weapon:reload:start' { id, duration }` / `'weapon:reload:end'`), firing:
  LMB via `input.firing` (auto) or `'input:mousedown'` (semi). Enforce rpm cooldown,
  block while `phase === 'freeze'` (raise/lower is fine) or menus (`game.hud?.buyOpen`
  guard read via `game.state` flag `buyOpen` — HUD sets `game.state.buyOpen`).
  On successful shot: decrement mag, compute dir = camera forward + spread cone sample
  (use spherical gaussian-ish jitter) + current recoil aim drift, emit
  `'weapon:fire' { weaponId: id, origin: player.eyePos().clone(), dir, byPlayer: true }`,
  call `player.addViewPunch(...)` per recoil pattern, advance recoilIndex (decays when
  not firing). Knife: LMB emits `'weapon:fire'` with `melee: true` (combat resolves
  1.8 m). Grenades: LMB winds up, on release (mouseup) emit
  `'grenade:throw' { type: id, origin: eyePos, dir: camera fwd, strength: 14 }`,
  consume the grenade, auto-switch to next weapon.
  AWP scope: RMB toggles zoom levels (0→1→2→0), emits `'weapon:scope' { level, fov }`;
  main camera fov handled by... **this module sets `game.camera.fov` + 
  `updateProjectionMatrix()`** directly between `CONFIG.PLAYER.FOV` and zoomFov levels
  (smooth lerp ~12/s). Unscoped AWP spread is huge (0.05). Scoped removes move penalty
  half. Firing unzooms briefly for bolt cycle.
  Wheel/number keys switch slots (subscribe `'input:wheel'`, `'input:keydown'` keys
  '1'..'4', 'q' = last weapon, 'r' reload, 'b' → emit `'ui:toggle-buy'`).
- Note: weapons module NEVER raycasts; combat listens to `'weapon:fire'`.

### E. `src/weapons/viewmodel.js` — class `ViewModel`

First-person weapon models + arm, procedural from primitives, parented to a rig that
follows the camera (add rig to `game.scene`, copy camera transform each frame in
`update` — render layer tricks not needed).

- One build function per weapon id in `WEAPONS` (knife, glock, usp, deagle, mp5, ak47,
  m4a1, awp, hegrenade, flashbang, smokegrenade). Distinctive silhouettes and materials
  (AK: wood tones + curved mag suggestion via angled box; M4: black + carry handle;
  AWP: long green body + big scope tube; deagle: chrome slide; knife: blade + guard;
  grenades: sphere/cylinder in hand). Sub-0.4 m sizes, positioned lower-right of view
  (right-handed), with simple arm/hand hint (skin-tone capsule-ish boxes).
- Each model exposes `muzzle` (empty `Object3D` at barrel tip). Public API:
  `getMuzzleWorldPos(outVec3)` → world position of current muzzle (fallback: camera
  forward 0.4 m). `getWeaponGroup()` → current visible group.
- Animations (all procedural, in `update(dt)`): idle sway (mouse-look lag), walk/run bob
  (reads `game.player.moveSpeed2D`), fire kick (on `'weapon:fire'` with
  `byPlayer: true`: recoil translate back + rotate up, recover ~10/s; muzzle flash is
  effects' job), reload (on `'weapon:reload:start'`: drop+tilt down, shake mid, raise at
  end), equip raise (on `'weapon:equip'`: from below over 0.25 s), knife swing (quick
  arc on fire), grenade wind-up + throw (on mousedown hold via `'input:mousedown'` when
  grenade equipped — simpler: subscribe `'grenade:throw'` for release anim), scope: hide
  model entirely while `game.weapons.isScoped()`.
- Keep it allocation-free per frame; build all models once at construction, toggle
  visibility on `'weapon:equip'`.

### F. `src/combat/combat.js` — class `Combat`

Hitscan, penetration, grenades, damage, kills, smoke LOS.

- Listens `'weapon:fire'` (from player) and `'bot:fire' { bot, weaponId, origin, dir }`
  (from bots). Resolve:
  - Melee (`melee: true`): 1.8 m ray, damage to first bot/player hit.
  - Bullet: build candidate hits = world.raycast + capsule intersection tests against
    all alive bots (`game.bots.all`) and the player (skip shooter; **no friendly fire**
    damage but still stop the ray... simplify: bullets stop on any character but only
    damage enemies). Head if hit point within top 0.30 m of capsule → part 'head'.
    Damage = weapon.damage × falloff(distance) × (head ? headshotMult : part 'legs'
    (bottom 0.5 m) ? 0.75 : 1). Armor handled inside takeDamage of target.
  - Penetration: if first hit is world geometry and weapon.penetration > 0, re-cast from
    exit (entry + dir × 0.4 max thickness probe); if the wall is ≤ 0.35 m thick,
    continue with damage × (0.5 + 0.5×penetration... just × 0.55) and spawn exit impact.
    One penetration max.
  - Emits per impact: `'fx:impact' { point, normal, surface }` (surface from hit),
    `'fx:tracer' { from, to, weaponId }` (from = muzzle for player shots — get via
    `game.viewmodel.getMuzzleWorldPos()`; for bots use their gun tip offset provided in
    the event or eye pos), `'fx:blood' { point, dir }` on character hit,
    `'audio' events are NOT emitted here — audio listens to the same fx/weapon events`.
  - Player hit feedback: emit `'hud:hitmarker' { headshot, kill }` when the player's
    shot damages a bot.
  - Kills: when a bot dies from player damage award `game.state.money += killReward`
    (clamp MAX_MONEY) and emit `'econ:kill' { weaponId, reward }`. Always emit
    `'kill' { killerName, victimName, weaponId, headshot, killerTeam, victimTeam }`
    (names: player = 'You'; HUD renders killfeed from this).
- Grenade projectiles: on `'grenade:throw'` spawn a small mesh (sphere ~0.07) with
  velocity = dir × strength + inherit thrower velocity×0.3; integrate gravity 20,
  bounce off world colliders (reflect with restitution 0.45, friction 0.7 — resolve via
  `world.raycast` along motion or AABB step), roll/stop. Fuse: HE & flash 1.6 s after
  throw; smoke pops on rest (or 3 s). Effects:
  - HE: `'fx:explosion' { pos, radius: 9 }`; damage all characters in radius with LOS
    (world.raycast center→target clear): `98 × (1 − d/9)^1.6`, armor-reduced;
    `player.addShake` if close; can kill (route through same kill flow — thrower is
    killer).
  - Flash: `'fx:flash' { pos }`; player blind amount = f(view angle to flash, LOS,
    distance ≤ 18): full blind 2.2 s + fade 1.5 s → emit
    `'hud:flash' { intensity 0..1, duration }`; also set `bot.blindUntil` on bots with
    LOS within 14 m (via `game.bots.applyFlash(pos)` — bots module implements).
  - Smoke: `'fx:smoke' { pos, duration: 15 }` and push `{ pos, radius: 3.2, until }`
    into `this.smokes` (public array). Public `losBlocked(a, b)` → true if segment
    a→b passes within radius of an active smoke (bots must use this; also world
    raycast users may). Prune expired each update.
- `update(dt)` advances projectiles, prunes smokes.
- Bots damaging player: on bot shot resolution hitting player →
  `player.takeDamage(dmg, { from: bot, weapon, headshot, part })`.
- If player dies: the `'player:death'` event is emitted by player module; combat emits
  the corresponding `'kill'` feed entry (bot killer name).

### G. `src/ai/bots.js` — class `Bots`

- Public: `all` — array of bot objects (both teams; includes dead until round reset);
  `aliveOf(team)` → count; `applyFlash(pos)`; `resetForRound()` (respawn everyone at
  team spawns, reassign weapons by a simple economy tier: pistol rounds 1, then mix of
  mp5/ak/m4/awp(≤1 per team) as rounds progress); `getRadarBlips()` →
  `[{ x, z, team, alive, isBombCarrier }]`; `bombCarrier` (a T bot or null).
- Bot object (plain object or class): `name` (from CS-flavored list: 'Viper', 'Ghost',
  'Sarge', 'Havoc', 'Wolf', 'Blitz', 'Cobra', 'Dune', 'Falcon', 'Rex'...), `team`,
  `health`, `alive`, `pos` (feet Vector3), `yaw`, `weaponId`, `mesh` (a `THREE.Group`
  humanoid: separate head mesh (`userData.part='head'`), torso, 2 arms, 2 legs, gun box;
  CT palette: navy/tan+helmet; T: olive/brown+beanie... distinct silhouettes), walk-cycle
  limb swing driven by speed, `blindUntil`, `takeDamage(amount, { from, weapon,
  headshot, part })` (same armor-less math: bots have armor from round 3+: field
  `armor`, same formula as player), on death: emit `'bot:death' { bot, killer, weapon,
  headshot }`, play fall-over animation (rotate to side over 0.4 s), corpse stays,
  remove from radar.
- Brain (per-bot FSM, tick staggered ~10 Hz + smooth movement every frame):
  - `freeze` phase: stand at spawn, face lane.
  - T team objective: bomb carrier (one random T) paths to a chosen site (weighted
    random, sticks per round) and plants when inside site box & no visible enemy for
    1.5 s → after `PLANT_TIME` emit `'bomb:planted' { site, pos }` (rounds owns state
    change). Other Ts escort or take map-control routes then converge. After plant:
    defend site.
  - CT bots: split between sites/mid patrol via waypoint wander; on bomb plant → rush
    bomb site; if bomb pos known & reachable & no enemies visible → defuse (stand at
    bomb 10 s... use DEFUSE_TIME, no kits for bots; emit `'bot:defusing' { bot }` start
    and rounds watches distance/alive to complete → actually: bots emit
    `'bomb:defused' { by: bot }` themselves after uninterrupted timer; interrupt if
    damaged or enemy visible).
  - Perception: every think tick, for each enemy (player + enemy bots): distance ≤
    ENGAGE_RANGE, within FOV of facing, `world.raycast` eye→eye clear, and
    `!game.combat.losBlocked(eyeA, eyeB)` → spotted (after reaction delay). Hearing:
    subscribe `'weapon:fire'`/`'player:footstep'` (running only) within HEAR_RANGE →
    investigate last-heard pos.
  - Engage: strafe-jiggle perpendicular (switch dir every 0.6–1.1 s), crouch sometimes
    at long range, aim toward target eye/chest with smoothed turn (TURN_SPEED) plus
    aim error (gaussian ~1.2° scaled by distance/blind/moving), fire in weapon-suitable
    bursts (auto: 3–7 rounds then 0.2–0.4 s pause; awp: single + 1.4 s bolt; enforce
    weapon rpm): emit `'bot:fire' { bot, weaponId, origin: eyePos, dir }` with
    per-shot spread like the player's. Ammo infinite but reload pauses (mag counts,
    2.5 s reload with no fire — emits nothing global; local timer). While
    `blindUntil > now`: stop, aim error ×6, maybe spray blindly 30% chance.
  - Movement: paths via `world.findPath`, advance node when within 0.7 m, move with
    `world.resolveMovement` at BOT.RUN_SPEED (walk 2.2 when sneaking near objective),
    jump not needed (map has stairs), avoid teammate crowding (small separation push).
  - Footsteps: emit `'bot:footstep' { pos }` every ~2.6 m while moving fast (audio
    uses for positional steps; bots also hear player's).
- Bots never process during `'menu'`; frozen during `'freeze'`.

### H. `src/game/rounds.js` — class `Rounds`

Match flow + economy + bomb + objectives. Owns `game.state` mutations for phase/timer/
scores/money/bomb.

- Menu: on construction, `phase = 'menu'`. Listen `'ui:start'` (HUD start button) →
  start match (round 1). In `game.debug`, auto-start after 0.5 s.
- Round start: `phase='freeze'`, timer=FREEZE_TIME; place bomb with a random T bot
  (`bots.resetForRound()` decides carrier), call `player.resetForRound(spawn)` with a CT
  spawn, `weapons.resetForRound({ died: playerDiedLastRound })`, clear corpses? (bots
  module clears in its reset), `effects` clears via `'round:start'`. Emit
  `'round:start' { round }` then `'round:phase' { phase: 'freeze' }`.
- freeze → live (`'round:phase' { phase: 'live' }`), timer=ROUND_TIME.
- Win conditions checked each update:
  - All Ts dead → CT win ('elimination') — but if bomb planted, bomb must still be
    defused (CS rule: planted bomb must be defused; keep it: T elimination with bomb
    planted does NOT end round).
  - All CTs dead (player counts) → T win ('elimination'); if bomb planted, T win
    happens on detonation anyway — elimination win for T is immediate.
  - Timer expires in 'live' with bomb not planted → CT win ('time').
  - `'bomb:planted'` → `phase='planted'`, timer=BOMB_TIME, `state.bomb = { planted:
    true, site, pos }`, emit `'round:phase' { phase:'planted', site }`. Spawn a visual
    bomb: small box + blinking light mesh added to scene (rounds owns this simple mesh),
    beeping handled by audio via phase awareness (beep cadence from `state.timer`).
  - Timer hits 0 in 'planted' → detonation: `'fx:explosion' { pos: bombPos, radius:
    16 }` + heavy damage nearby via combat's explosion path? Combat owns explosion
    damage — rounds emits `'bomb:detonated' { pos }` and combat applies the radial
    damage; T win ('bomb').
  - `'bomb:defused'` (from bots) or player defuse completes → CT win ('defuse').
- Player defuse: in `update`, if phase 'planted', player alive, within 1.6 m of bomb,
  looking roughly at it (dot > 0.4 optional — skip, proximity is enough) and holding E
  (`input.isDown('e')`) and on ground: accumulate `state.bomb.defuseProgress` toward
  DEFUSE_TIME (or _KIT); movement or releasing E resets progress to 0. Expose progress
  via state for HUD. Complete → CT win ('defuse'), `'bomb:defused' { by: 'player' }`.
  While defusing set `state.bomb.defusingBy = 'player'` (blocks firing? no—CS blocks
  moving only; weapons keep working if they release E).
- Round end: `phase='roundEnd'`, timer=ROUND_END_TIME, scores++, emit
  `'round:end' { winner, reason }`. Economy: player money += WIN_REWARD or loss bonus
  (track consecutive losses), plant/defuse bonuses. Then next round or
  `phase='gameEnd'` + `'game:end' { winner, scores }` at WIN_ROUNDS (HUD shows final;
  `'ui:restart'` → full match reset).
- Track `playerDiedLastRound` from `'player:death'`.
- Half-time team swap: skip (keep player CT all match) — note in HUD "First to 8".

### I. `src/ui/hud.js` — class `HUD`

All DOM/CSS inside `game.hudRoot`. Inject one `<style>` block; CS 1.6-flavored look:
darkened translucent panels, `#c8d6b9`-ish HUD green-tan text (classic CS HUD color
`rgb(136,145,80)` vibes → use `#9ab26b` family), monospace-ish numerals (system stack:
`"Rajdhani", "Arial Narrow", system-ui` — no external fonts; fine to just use bold
condensed system fonts).

Elements (ids prefixed `hud-`):
- Bottom-left: health cross icon + number, armor shield + number (hide armor at 0).
- Bottom-right: ammo `mag / reserve` big, weapon name small.
- Bottom-center-left: money `$ 800` (green).
- Top-center: round timer `m:ss` (turns red < 10 s; shows bomb icon pulsing when
  planted), scores `CT 3 : 5 T`, round number small.
- Top-right: killfeed (last 5, `killer [weapon] victim`, headshot marker `☠/HS`, player
  entries highlighted; fade after 4.5 s).
- Top-left: radar — 140×140 canvas, player-centered rotating map: draw world-bounds
  box + bomb sites A/B labels + blips from `bots.getRadarBlips()` (teammates always;
  enemies only if currently "spotted" — simplify: enemies shown if within 25 m OR fired
  within last 2 s (track via `'weapon:fire'`/`'bot:fire'`)), bomb icon when planted.
- Center: crosshair — 4 lines + optional dot, gap = f(`weapons.currentSpread()`)
  (map rad→px ~ spread×900), green, hidden when scoped/dead/menu. Hitmarker: white X
  flash on `'hud:hitmarker'` (red-tinged on kill, bigger on headshot + play nothing —
  audio handles sound).
- Damage: red vignette flash scaled by damage on `'player:damage'`; directional
  indicator arc toward `dirYaw` (a red wedge at screen edge, fades 1 s).
- Flash: full-white overlay div driven by `'hud:flash'` (opacity=intensity, fade out).
- Scope overlay: on `'weapon:scope'` level>0 → black vignette with circular cutout +
  crosshair lines + subtle lens ring; hides normal crosshair.
- Buy menu (B toggles via `'ui:toggle-buy'` event or own key listen; only during buy
  period — ask `game.rounds.canBuy()`... expose instead: rounds sets
  `game.state.canBuy` bool each frame; HUD reads it): centered panel, categories
  (Pistols/SMG/Rifles/Gear/Grenades) with name+price rows; click to buy (calls
  `game.weapons.buy(id)`); rows disabled when unaffordable (grey). Also number-key
  quick-nav optional (skip). Sets `game.state.buyOpen` true/false; Escape or B closes.
  **pointer-events: auto** on the panel only.
- Scoreboard (hold Tab): table of all 10 names/team/alive status/K-D (track kills via
  `'kill'` events; player row highlighted).
- Center messages: big text 2.5 s on round events ('BOMB HAS BEEN PLANTED', 'Round Won:
  Counter-Terrorists', match point, etc.) via `'round:phase'`/`'round:end'`; freeze
  phase shows 'BUY PHASE — press B'. Defuse progress bar (center-bottom) while
  `state.bomb.defuseProgress > 0` ("DEFUSING..." + fill bar; kit note).
- Death: grayscale-ish dark overlay + 'You are dead — spectating' when player dead.
- Menu screen (phase 'menu'): fullscreen dark gradient + title 'TINY STRIKE',
  subtitle 'Tactical Strike — Bomb Defusal', a START MISSION button (emits
  `'ui:start'`), controls list (WASD move, Mouse aim, LMB fire, RMB scope, R reload,
  B buy, E defuse, Shift walk, Ctrl crouch, Space jump, Tab score, 1-4 weapons), team
  note 'You are a Counter-Terrorist. First to 8 rounds.' Pointer-events auto. After
  start it requests pointer lock (`game.input.requestLock()`).
- Pause overlay when pointer unlocks mid-match ('Click to resume' → on click
  `requestLock()`; game does NOT hard-pause (single player vs bots, keep simple): show
  overlay only).
- Game end screen: winner, final score, player K/D, RESTART button (`'ui:restart'`).
- `update(dt)`: refresh dynamic numbers cheaply (only touch DOM on change), draw radar
  canvas at ~20 Hz.

### J. `src/audio/audio.js` — class `AudioSys`

WebAudio, all synthesized, no assets. Create `AudioContext` lazily on first
`'input:lock'` / `'ui:start'` / any keydown (autoplay policy), master `GainNode` (0.5) →
destination, plus a music/ambient bus and an SFX bus. Add a gentle master compressor
(`DynamicsCompressorNode`).

- Positional helper: `play3D(buildFn, pos, { refDist = 8, maxDist = 60, vol = 1 })` —
  compute distance/direction from `game.camera` position: gain = vol × clamp(refDist/d),
  stereo pan from camera-relative azimuth (`StereoPannerNode`). All world-space sounds
  route through it.
- Gunshots per profile (weapon `fireSound` id): layered — noise burst (bandpass swept
  600→200 Hz over ~80–200 ms) + resonant thump sine (110–160 Hz decaying) + crack
  (short high-pass noise 5 ms). Vary character: pistols short/snappy, usp muffled
  (lowpass 1.2 kHz, quieter), ak deeper/louder, awp huge boom + faint tail echo
  (feedback delay ~0.18 s ×2), mp5 tight rapid. Listen `'weapon:fire'` (player: full
  volume, no pan) and `'bot:fire'` (3D at origin).
- Other SFX: reload (2–3 clicks + slide, timed across `'weapon:reload:start'`
  duration), dry-fire click (listen `'weapon:dryfire'` — weapons emits it on empty
  trigger... **weapons module: also emit `'weapon:dryfire'`**), knife swish, footsteps
  (`'player:footstep'` soft noise taps, half volume when walking; `'bot:footstep'`
  3D), jump grunt skip, land thud (`'player:land'`), bullet impacts (`'fx:impact'`
  3D tick by surface: concrete chip / metal ping / wood knock), whiz for close misses
  (skip), blood hit thud (`'fx:blood'`), hitmarker tick + headshot ding
  (`'hud:hitmarker'`), explosion (`'fx:explosion'`: big noise boom + 50 Hz sub sine +
  muffle: momentarily duck master to 0.3 recover 2 s), flashbang (`'fx:flash'`: loud
  crack + 3.5 s 3 kHz sine ring + duck), smoke pop hiss (`'fx:smoke'`), plant beep
  start, bomb beeps (in `update`: while phase 'planted' schedule beeps at bomb pos,
  cadence accelerating as `state.timer → 0`: interval = clamp(timer/40,0.12,1)×1 s),
  defuse tick loop while defusing, kill confirm subtle, round stingers (`'round:end'`:
  win = rising major triad blips; lose = falling minor; `'round:phase'` freeze = short
  'go go go' style 3-note motif; planted = tense sting), match end fanfare, UI clicks
  (`'econ:buy'` cha-ching register + clack; buy open/close), death heartbeat-ish low
  thumps briefly.
- Ambient: soft filtered brown-noise wind loop (very quiet, lowpass 400 Hz, slow LFO)
  starts with context.
- `update(dt)` for scheduled loops (bomb beeps, defuse ticks). Keep every sound ≤ a few
  nodes, always envelope with `setTargetAtTime`/`linearRamp`, never leave nodes running
  (stop + disconnect on end via `source.onended`).

### K. `src/effects/effects.js` — class `Effects`

All visual FX; everything pooled and allocation-free per frame.

- Muzzle flash: on `'weapon:fire'` byPlayer → brief (40 ms) star-sprite (additive,
  procedural canvas radial) + `PointLight` (warm, intensity 4, decay fast) at
  `viewmodel.getMuzzleWorldPos()`; on `'bot:fire'` → smaller flash at origin.
- Tracers: `'fx:tracer' { from, to }` — thin additive elongated quad/box streaking
  from→to over ~50 ms then fade (pool 32). Skip when length < 3 m.
- Impacts: `'fx:impact' { point, normal, surface }` — 6–10 small particles (concrete:
  tan dust puff + sparks few; metal: bright sparks; wood: brown chips) with gravity,
  0.4 s life (pool). Decal: small dark bullet-hole sprite oriented to normal, offset
  0.01 m, pool 80 FIFO (oldest removed), cleared on `'round:start'`.
- Blood: `'fx:blood' { point, dir }` — dark red particle burst (8–12, gravity, 0.5 s).
  No decals on characters.
- Shells: on `'weapon:fire'` byPlayer (not knife/grenade/awp? awp too, after bolt) —
  tiny brass box ejected right+up with tumble, gravity, one bounce tick vs floor
  (approx y=camera... just fall to player floor y with a raycast once), fade after
  1.2 s (pool 24).
- Explosion: `'fx:explosion' { pos, radius }` — expanding fireball (additive sprite
  scale-up + fade 0.35 s), 20 spark streaks, gray smoke puffs rising (2.5 s), point
  light flash (intensity 30 → 0 in 0.3 s), camera shake via `player.addShake(f(dist))`.
- Smoke grenade: `'fx:smoke' { pos, duration }` — cluster of 10–14 big soft gray
  billboards (procedural radial-gradient sprite, ~2.5–3.5 m each) with slow swirl/rise,
  near-opaque core, fade in 0.6 s / out last 2 s. Depth-write off, normal blending.
- Flash effect visual is HUD's overlay (not here). But spawn brief white point light.
- Bomb visuals: on `'round:phase' phase 'planted'` — pulsing red point light at bomb
  pos synced ~ beeps (approx: pulse rate accelerate with `state.timer`); on
  `'bomb:detonated'` big explosion is triggered by combat's `'fx:explosion'` already.
- Grenade in-flight meshes are combat's; effects may add a small smoke trail for HE
  (skip if time).
- Cleanup on `'round:start'`: clear decals, active particles, smokes visuals, corpse
  cleanup is bots'.
- `update(dt)` advances all pools. Use additive `THREE.SpriteMaterial` / simple planes;
  build ~4 shared procedural textures (spark dot, soft puff, star flash, hole) at
  construction.

---

## Complete event reference (emitter → payload)

- `input:keydown {key}`, `input:mousedown {button}`, `input:mouseup {button}`,
  `input:wheel {dir}`, `input:lock`, `input:unlock` — Input
- `player:damage {amount, from, dirYaw}`, `player:death {killer, weapon, headshot}`,
  `player:jump`, `player:land {speed}`, `player:footstep {pos, walking, surface}` — Player
- `weapon:fire {weaponId, origin, dir, byPlayer, melee?}`, `weapon:dryfire`,
  `weapon:equip {id}`, `weapon:reload:start {id, duration}`, `weapon:reload:end`,
  `weapon:scope {level, fov}`, `grenade:throw {type, origin, dir, strength}`,
  `econ:buy {id, price}` — Weapons
- `bot:fire {bot, weaponId, origin, dir}`, `bot:death {bot, killer, weapon, headshot}`,
  `bot:footstep {pos}`, `bomb:planted {site, pos}`, `bomb:defused {by}`,
  `bot:defusing {bot}` — Bots
- `kill {killerName, victimName, weaponId, headshot, killerTeam, victimTeam}`,
  `fx:impact {point, normal, surface}`, `fx:tracer {from, to, weaponId}`,
  `fx:blood {point, dir}`, `fx:explosion {pos, radius}`, `fx:flash {pos}`,
  `fx:smoke {pos, duration}`, `hud:hitmarker {headshot, kill}`, `econ:kill {weaponId,
  reward}` — Combat
- `round:start {round}`, `round:phase {phase, site?}`, `round:end {winner, reason}`,
  `game:end {winner, scores}`, `bomb:detonated {pos}` — Rounds
- `hud:flash {intensity, duration}` — Combat; `ui:start`, `ui:restart`,
  `ui:toggle-buy` — HUD (and Weapons for toggle-buy via B key)

## State fields modules may READ freely

`game.state.*` (phase, timer, round, scores, money, bomb, canBuy, buyOpen). Writers:
rounds (phase/timer/round/scores/money/bomb/canBuy), HUD (buyOpen), combat (money on
kills — allowed exception).

## Acceptance checklist (what "done" means per module)

Boots with zero console errors alongside stubs of other modules; no unhandled events;
all public APIs of this spec implemented with exact names; visually/aurally polished,
CS-flavored feel; 60 fps target on integrated GPU (pool everything hot).
