// src/ai/bots.js — Bot AI, humanoid bodies, and team behavior for OPERATION GOLDENEYE.
// Section G of SPEC.md. Default-exports class Bots (constructor(game)).
//
// Design notes:
// - Think ticks run at ~10 Hz, staggered per bot so 10 brains never share one frame.
// - Movement/animation runs every frame with scratch vectors (no per-frame allocs).
// - Bodies are primitive humanoids with pivoted limbs: walk-cycle swing, aim pose,
//   crouch bend and a fall-over death animation. Head is its own mesh with
//   userData.part = 'head' so combat can score headshots by mesh if it wants to.
// - All cross-module effects go through game.events per the contract.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';

// ---------------------------------------------------------------------------
// Static data
// ---------------------------------------------------------------------------

const CT_NAMES = ['Sarge', 'Ghost', 'Blitz', 'Falcon', 'Rex', 'Maverick', 'Duke'];
const T_NAMES = ['Viper', 'Havoc', 'Wolf', 'Cobra', 'Dune', 'Jackal', 'Scorpion'];

// Internal handling stats for bot trigger discipline. Damage/falloff live in the
// weapons/combat modules — bots only need cadence, magazine and cone data.
const GUN = {
  glock: { rpm: 400, mag: 20, reload: 2.2, auto: false, burst: [2, 5], pause: [0.22, 0.45], spread: 0.011, prefer: 26 },
  usp: { rpm: 352, mag: 12, reload: 2.2, auto: false, burst: [2, 4], pause: [0.25, 0.5], spread: 0.010, prefer: 26 },
  deagle: { rpm: 160, mag: 7, reload: 2.2, auto: false, burst: [1, 2], pause: [0.45, 0.75], spread: 0.012, prefer: 30 },
  mp5: { rpm: 750, mag: 30, reload: 2.6, auto: true, burst: [4, 8], pause: [0.16, 0.35], spread: 0.013, prefer: 22 },
  ak47: { rpm: 600, mag: 30, reload: 2.5, auto: true, burst: [3, 7], pause: [0.2, 0.4], spread: 0.011, prefer: 34 },
  m4a1: { rpm: 666, mag: 30, reload: 3.0, auto: true, burst: [3, 7], pause: [0.2, 0.4], spread: 0.010, prefer: 34 },
  awp: { rpm: 41, mag: 10, reload: 3.6, auto: false, burst: [1, 1], pause: [1.45, 1.7], spread: 0.004, prefer: 55, bolt: 1.4 },
};
const GUN_FALLBACK = GUN.usp;

// Skinned soldier bodies (Quaternius "Toon Shooter Game Kit", CC0), processed
// in Blender to keep only the body + the four held-weapon meshes we toggle.
// bodyHeight = measured body-only height of each source model (feet at y=0).
const CHAR_MODELS = {
  ct: { url: 'assets/models/soldier_ct.glb', bodyHeight: 2.2699 },
  t: { url: 'assets/models/soldier_t.glb', bodyHeight: 2.1358 },
};
const CHAR_TARGET_HEIGHT = 1.83;
const CHAR_GUN_MESH_NAMES = new Set(['AK', 'SMG', 'Sniper', 'Pistol']);
const CHAR_GUN_MESH = {
  ak47: 'AK', m4a1: 'AK', mp5: 'SMG', awp: 'Sniper',
  glock: 'Pistol', usp: 'Pistol', deagle: 'Pistol',
};

const DEG = Math.PI / 180;
const THINK_INTERVAL = 0.1;
const NODE_REACH = 0.7; // advance path node when within this horizontal distance
const FOOTSTEP_DIST = 2.6;
const WALK_SPEED = 2.2;
const CORPSE_FALL_TIME = 0.4;
const LOSE_TARGET_TIME = 2.2; // s unseen before target degrades to a memory
const PLANT_CLEAR_TIME = 1.5; // s without a visible enemy before planting starts

// ---------------------------------------------------------------------------
// Scratch objects (module-level, reused every frame — no hot-loop allocation)
// ---------------------------------------------------------------------------

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _eyeA = new THREE.Vector3();
const _eyeB = new THREE.Vector3();

function rand(a, b) { return a + Math.random() * (b - a); }
function randInt(a, b) { return Math.floor(rand(a, b + 0.999)); }
function gauss() {
  // Box-Muller, cheap approximation is fine for aim error.
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function angleDiff(a, b) {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
// Yaw convention matches three.js: rotation.y = yaw makes the model (built facing
// -Z) look along (-sin yaw, 0, -cos yaw).
function yawFromDir(dx, dz) { return Math.atan2(-dx, -dz); }

// ---------------------------------------------------------------------------

export default class Bots {
  constructor(game) {
    this.game = game;
    this.all = [];
    this.bombCarrier = null;
    this.time = 0;

    this._cfg = game.config.BOT;
    this._match = game.config.MATCH;
    this._lastResetAt = -10;
    this._bombPlanted = false;
    this._bombPos = new THREE.Vector3();
    this._droppedBombPos = new THREE.Vector3();
    this._bombDropped = false;
    this._radarBlips = [];
    this._sharedGeo = null; // built lazily (unit box reused for every body part)
    this._root = new THREE.Group();
    this._root.name = 'bots';
    if (game.scene) game.scene.add(this._root);

    this._charAssets = { ct: null, t: null }; // GLB templates: { scene, clips }
    this._buildRoster();
    this._bindEvents();
    this._loadCharacterModels();
  }

  // -------------------------------------------------------------------------
  // Public API (spec section G)
  // -------------------------------------------------------------------------

  aliveOf(team) {
    let n = 0;
    for (let i = 0; i < this.all.length; i++) {
      if (this.all[i].team === team && this.all[i].alive) n++;
    }
    return n;
  }

  applyFlash(pos) {
    const world = this.game.world;
    for (let i = 0; i < this.all.length; i++) {
      const b = this.all[i];
      if (!b.alive) continue;
      const d = _v1.set(pos.x - b.pos.x, 0, pos.z - b.pos.z).length();
      if (d > 14) continue;
      // LOS from flash to bot eye — a wall between them protects the bot.
      if (world && typeof world.raycast === 'function') {
        _eyeA.set(pos.x, pos.y + 0.2, pos.z);
        this._botEye(b, _eyeB);
        _v2.copy(_eyeB).sub(_eyeA);
        const dist = _v2.length();
        if (dist > 0.001) {
          _v2.multiplyScalar(1 / dist);
          const hit = world.raycast(_eyeA, _v2, dist);
          if (hit && hit.distance < dist - 0.25) continue;
        }
      }
      // Facing the flash hurts more.
      const toFlashYaw = yawFromDir(pos.x - b.pos.x, pos.z - b.pos.z);
      const facing = Math.abs(angleDiff(toFlashYaw, b.yaw)) < 1.1;
      let dur = (2.2 * (1 - d / 16) + 0.7) * (facing ? 1.35 : 0.75);
      dur = Math.max(0.4, Math.min(3.4, dur));
      b.blindUntil = Math.max(b.blindUntil, this.time + dur);
      b.blindSpray = Math.random() < 0.3;
      // Blindness breaks concentration on objectives.
      b.plantClearTimer = 0;
      if (b.state === 'defuse') this._cancelDefuse(b);
    }
  }

  getRadarBlips() {
    const blips = this._radarBlips;
    for (let i = 0; i < this.all.length; i++) {
      const b = this.all[i];
      let blip = blips[i];
      if (!blip) { blip = { x: 0, z: 0, team: b.team, alive: true, isBombCarrier: false }; blips[i] = blip; }
      blip.x = b.pos.x;
      blip.z = b.pos.z;
      blip.team = b.team;
      blip.alive = b.alive;
      blip.isBombCarrier = b === this.bombCarrier;
    }
    blips.length = this.all.length;
    return blips;
  }

  resetForRound() {
    const world = this.game.world;
    this._lastResetAt = this.time;
    this._bombPlanted = false;
    this._bombDropped = false;

    const round = Math.max(1, this.game.state.round || 1);
    const spawns = world && world.spawns ? world.spawns : null;
    const used = { ct: 0, t: 0 };

    for (let i = 0; i < this.all.length; i++) {
      const b = this.all[i];
      const list = spawns ? spawns[b.team] : null;
      let spawn = null;
      if (list && list.length) {
        // Player takes a CT spawn too; offset bot CT spawns by one so we do not
        // stack on top of the player.
        const idx = (used[b.team] + (b.team === 'ct' ? 1 : 0)) % list.length;
        spawn = list[idx];
        used[b.team]++;
      }
      this._respawnBot(b, spawn, round);
    }

    this._assignLoadouts(round);
    this._pickCarrierAndPlans(round);
  }

  // -------------------------------------------------------------------------
  // Roster / loadout / plans
  // -------------------------------------------------------------------------

  _buildRoster() {
    const perTeam = this._match.BOTS_PER_TEAM;
    const ctCount = perTeam - 1; // player fills the last CT slot
    for (let i = 0; i < ctCount; i++) this.all.push(this._createBot(CT_NAMES[i % CT_NAMES.length], 'ct', i));
    for (let i = 0; i < perTeam; i++) this.all.push(this._createBot(T_NAMES[i % T_NAMES.length], 't', i));
  }

  _assignLoadouts(round) {
    // Weapon economy tiers: pistols on round 1, eco-ish round 2, rifles + at most
    // one AWP per team from round 3-4 on. Armor from round 3.
    let ctAwp = false, tAwp = false;
    for (let i = 0; i < this.all.length; i++) {
      const b = this.all[i];
      const pistol = b.team === 'ct' ? 'usp' : 'glock';
      let id = pistol;
      if (round === 2) {
        const r = Math.random();
        id = r < 0.35 ? 'mp5' : (r < 0.55 ? 'deagle' : pistol);
      } else if (round >= 3) {
        const rifle = b.team === 'ct' ? 'm4a1' : 'ak47';
        const canAwp = round >= 4 && (b.team === 'ct' ? !ctAwp : !tAwp);
        const r = Math.random();
        if (canAwp && r < 0.3) {
          id = 'awp';
          if (b.team === 'ct') ctAwp = true; else tAwp = true;
        } else if (r < 0.82) {
          id = rifle;
        } else {
          id = 'mp5';
        }
      }
      b.weaponId = id;
      const stats = GUN[id] || GUN_FALLBACK;
      b.mag = stats.mag;
      b.armor = round >= 3 ? 100 : 0;
      this._applyGunLook(b);
    }
  }

  _pickCarrierAndPlans(round) {
    const world = this.game.world;
    const ts = [];
    for (let i = 0; i < this.all.length; i++) if (this.all[i].team === 't') ts.push(this.all[i]);

    this.bombCarrier = ts.length ? ts[randInt(0, ts.length - 1)] : null;

    // The carrier commits to a site for the whole round (weighted random).
    const sites = world && world.bombSites ? world.bombSites : null;
    let site = null;
    if (sites && sites.length) {
      site = Math.random() < 0.55 ? sites[0] : sites[sites.length - 1];
    }
    this._targetSite = site;

    // Terrorist plans: carrier + escorts head for the site (varied routes),
    // remaining Ts take map control first, then converge.
    let escortCount = 0;
    for (let i = 0; i < ts.length; i++) {
      const b = ts[i];
      if (b === this.bombCarrier) { b.plan = 'carrier'; continue; }
      if (escortCount < 2) { b.plan = 'escort'; escortCount++; }
      else b.plan = 'control';
      b.planVia = this._randomNodePos();
    }

    // CT plans: split coverage between the two sites (and a mid roamer).
    const cts = [];
    for (let i = 0; i < this.all.length; i++) if (this.all[i].team === 'ct') cts.push(this.all[i]);
    for (let i = 0; i < cts.length; i++) {
      const b = cts[i];
      if (sites && sites.length >= 2) {
        if (i % 2 === 0) b.anchor.copy(sites[0].center);
        else b.anchor.copy(sites[1].center);
        if (i === 2 && sites.length >= 2) {
          // one CT loosely holds the middle ground between sites
          b.anchor.copy(sites[0].center).add(sites[1].center).multiplyScalar(0.5);
        }
      } else {
        b.anchor.copy(b.pos);
      }
      b.plan = 'defend';
    }
  }

  _randomNodePos() {
    const world = this.game.world;
    const wp = world && world.waypoints;
    if (wp && wp.nodes && wp.nodes.length) {
      return wp.nodes[randInt(0, wp.nodes.length - 1)].pos;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Bot creation + bodies
  // -------------------------------------------------------------------------

  _createBot(name, team, index) {
    const self = this;
    const bot = {
      name, team,
      health: this._cfg.HEALTH,
      armor: 0,
      alive: true,
      pos: new THREE.Vector3(0, 0, index * 2),
      yaw: 0,
      weaponId: team === 'ct' ? 'usp' : 'glock',
      mesh: null,
      blindUntil: 0,
      blindSpray: false,

      // physique
      radius: this._cfg.RADIUS,
      height: this._cfg.HEIGHT,
      crouching: false,
      velY: 0,
      onGround: true,

      // brain
      state: 'idle',        // idle | move | engage | plant | defuse | hold | investigate
      plan: 'control',
      planVia: null,
      anchor: new THREE.Vector3(),
      path: null,
      pathIndex: 0,
      goal: new THREE.Vector3(),
      hasGoal: false,
      repathTimer: 0,
      holdTimer: 0,
      scanYaw: 0,

      target: null,          // { isPlayer, bot } — resolved each think
      targetIsPlayer: false,
      targetBot: null,
      lastSeenTime: -99,
      lastSeenPos: new THREE.Vector3(),
      trackTime: 0,
      reactionTimer: 0,
      heardTime: -99,
      heardPos: new THREE.Vector3(),
      damageTime: -99,
      damageFromPos: new THREE.Vector3(),

      // trigger discipline
      fireCooldown: 0,
      burstLeft: 0,
      pauseTimer: 0,
      mag: 12,
      reloadTimer: 0,

      // movement feel
      moveSpeed: 0,
      strafeDir: 1,
      strafeTimer: 0,
      wantCrouch: false,
      crouchLerp: 0,
      sneak: false,

      // objective timers
      plantClearTimer: 0,
      plantTimer: 0,
      defuseTimer: 0,
      defusingAnnounced: false,

      // animation
      walkPhase: Math.random() * Math.PI * 2,
      aimBlend: 0,           // 0 = relaxed carry, 1 = full aim pose
      aimPitch: 0,
      deathTime: -1,
      fallAxis: 'z',
      fallSign: 1,
      footAccum: 0,

      thinkTimer: index * (THINK_INTERVAL / 5) + Math.random() * 0.05,

      takeDamage(amount, info) {
        self._damageBot(this, amount, info || {});
      },
    };

    bot.mesh = this._buildBotMesh(team, bot);
    bot.mesh.visible = false; // hidden until first round reset places it
    this._root.add(bot.mesh);
    if (this._charAssets[team]) this._attachGLB(bot);
    return bot;
  }

  _geo() {
    if (!this._sharedGeo) this._sharedGeo = new THREE.BoxGeometry(1, 1, 1);
    return this._sharedGeo;
  }

  _mat(color) {
    this._matCache = this._matCache || new Map();
    if (!this._matCache.has(color)) {
      this._matCache.set(color, new THREE.MeshLambertMaterial({ color }));
    }
    return this._matCache.get(color);
  }

  _part(parent, color, w, h, d, x, y, z) {
    const m = new THREE.Mesh(this._geo(), this._mat(color));
    m.scale.set(w, h, d);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = false;
    parent.add(m);
    return m;
  }

  _buildBotMesh(team, bot) {
    // Distinct silhouettes: CTs are bulky (vest slab + square helmet), Ts are
    // leaner with a low beanie. Model faces -Z; rotation.y = bot.yaw.
    const ct = team === 'ct';
    const SKIN = 0xc9987a;
    const torsoCol = ct ? 0x2e3f5c : 0x565b36; // navy vs olive
    const limbCol = ct ? 0xb59d72 : 0x6b4a2f;  // tan vs brown
    const legCol = ct ? 0x33415a : 0x4c4a30;
    const bootCol = 0x24211c;
    const gearCol = ct ? 0x1d2a40 : 0x3c3524;

    const g = new THREE.Group();
    g.userData.bot = bot;

    const parts = {};

    // Legs pivot at the hip so the walk cycle swings from the joint.
    const hipY = 0.9;
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.11, hipY, 0);
      const leg = this._part(pivot, legCol, 0.16, 0.78, 0.18, 0, -0.45, 0);
      leg.userData.part = 'legs';
      const boot = this._part(pivot, bootCol, 0.17, 0.14, 0.24, 0, -0.85, -0.02);
      boot.userData.part = 'legs';
      g.add(pivot);
      parts[side < 0 ? 'legL' : 'legR'] = pivot;
    }

    // Torso block + chest gear. CTs get a fat vest slab for silhouette bulk.
    const torsoGrp = new THREE.Group();
    torsoGrp.position.set(0, hipY, 0);
    const torso = this._part(torsoGrp, torsoCol, ct ? 0.46 : 0.4, 0.6, ct ? 0.3 : 0.24, 0, 0.3, 0);
    torso.userData.part = 'body';
    const vest = this._part(torsoGrp, gearCol, ct ? 0.4 : 0.3, ct ? 0.34 : 0.22, ct ? 0.36 : 0.28, 0, 0.34, 0);
    vest.userData.part = 'body';
    // belt
    this._part(torsoGrp, bootCol, 0.42, 0.07, 0.26, 0, 0.02, 0).userData.part = 'body';
    g.add(torsoGrp);
    parts.torso = torsoGrp;

    // Arms pivot at the shoulder. The gun hangs off the right arm so the whole
    // assembly points where the arm aims.
    const shoulderY = 0.56; // relative to torso group (hipY + 0.56 = 1.46 world)
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * (ct ? 0.29 : 0.26), shoulderY, 0);
      const arm = this._part(pivot, limbCol, 0.11, 0.52, 0.13, 0, -0.26, 0);
      arm.userData.part = 'body';
      const hand = this._part(pivot, SKIN, 0.09, 0.1, 0.11, 0, -0.54, 0);
      hand.userData.part = 'body';
      torsoGrp.add(pivot);
      parts[side < 0 ? 'armL' : 'armR'] = pivot;
    }

    // Weapon: dark receiver + barrel, child of the right arm pivot, oriented so
    // that rotating the arm to horizontal points the muzzle down -Z.
    const gun = new THREE.Group();
    gun.position.set(-0.02, -0.5, -0.06);
    const receiver = this._part(gun, 0x1c1c20, 0.06, 0.11, 0.34, 0, 0, -0.12);
    receiver.userData.part = 'body';
    const barrel = this._part(gun, 0x2a2a2e, 0.035, 0.045, 0.3, 0, 0.02, -0.4);
    barrel.userData.part = 'body';
    const magBox = this._part(gun, 0x2f2b22, 0.05, 0.12, 0.07, 0, -0.1, -0.14);
    magBox.userData.part = 'body';
    parts.armR.add(gun);
    parts.gun = gun;
    parts.gunBarrel = barrel;

    // Head — separate mesh, tagged for headshot detection.
    const headGrp = new THREE.Group();
    headGrp.position.set(0, 0.73, 0); // hip-relative: 0.9 + 0.73 = 1.63 world
    const head = this._part(headGrp, SKIN, 0.26, 0.27, 0.26, 0, 0, 0);
    head.userData.part = 'head';
    if (ct) {
      // Square-jawed kevlar helmet + visor strip.
      const helm = this._part(headGrp, 0x27334a, 0.32, 0.15, 0.33, 0, 0.13, 0);
      helm.userData.part = 'head';
      const visor = this._part(headGrp, 0x101418, 0.24, 0.05, 0.02, 0, 0.03, -0.14);
      visor.userData.part = 'head';
    } else {
      // Low knit beanie rolled at the brow.
      const beanie = this._part(headGrp, 0x35301f, 0.28, 0.1, 0.28, 0, 0.12, 0);
      beanie.userData.part = 'head';
      const brim = this._part(headGrp, 0x2b2718, 0.29, 0.05, 0.29, 0, 0.075, 0);
      brim.userData.part = 'head';
    }
    torsoGrp.add(headGrp);
    parts.head = headGrp;
    parts.headMesh = head;

    g.userData.parts = parts;
    bot.parts = parts;
    return g;
  }

  // -------------------------------------------------------------------------
  // Skinned GLB soldier bodies (loaded async; primitive bodies are the fallback)
  // -------------------------------------------------------------------------

  _loadCharacterModels() {
    const loader = new GLTFLoader();
    for (const team of ['ct', 't']) {
      loader.load(
        CHAR_MODELS[team].url,
        (gltf) => {
          this._charAssets[team] = { scene: gltf.scene, clips: gltf.animations };
          for (let i = 0; i < this.all.length; i++) {
            if (this.all[i].team === team) this._attachGLB(this.all[i]);
          }
        },
        undefined,
        (err) => console.warn(`[bots] ${team} soldier model failed; keeping fallback bodies`, err)
      );
    }
  }

  _attachGLB(bot) {
    const asset = this._charAssets[bot.team];
    if (!asset || bot.rig) return;

    while (bot.mesh.children.length) bot.mesh.remove(bot.mesh.children[0]);
    bot.parts = null; // disables every primitive-body animation path

    const inst = cloneSkeleton(asset.scene);
    inst.scale.setScalar(CHAR_TARGET_HEIGHT / CHAR_MODELS[bot.team].bodyHeight);
    inst.rotation.y = Math.PI; // pack characters face +Z; the game rig faces -Z
    bot.gunMeshes = {};
    inst.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = false;
        o.frustumCulled = false; // skinned bounds lag the pose; never cull-pop
      }
      if (CHAR_GUN_MESH_NAMES.has(o.name)) bot.gunMeshes[o.name] = o;
    });

    bot.rig = inst;
    bot.mixer = new THREE.AnimationMixer(inst);
    bot.actions = {};
    for (const clip of asset.clips) {
      const key = clip.name.split('|').pop();
      const action = bot.mixer.clipAction(clip);
      if (key === 'Death' || key === 'HitReact') {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      }
      bot.actions[key] = action;
    }
    bot.actionName = null;
    bot.deathPlayed = false;
    this._setBotAction(bot, 'Idle', 0);
    this._applyGunLook(bot);
    bot.mesh.add(inst);

    // Assets can arrive mid-round: if this bot is already a corpse, snap the
    // death pose instead of standing the body back up.
    if (!bot.alive) {
      this._setBotAction(bot, 'Death', 0);
      bot.deathPlayed = true;
      const death = bot.actions.Death;
      if (death) death.time = death.getClip().duration;
      bot.mixer.update(0);
      bot.mesh.rotation.x = 0;
      bot.mesh.rotation.z = 0;
    }
  }

  _setBotAction(bot, name, fade = 0.16) {
    if (!bot.actions || bot.actionName === name) return;
    const next = bot.actions[name];
    if (!next) return;
    const prev = bot.actions[bot.actionName];
    next.enabled = true;
    next.reset().fadeIn(fade).play();
    if (prev && prev !== next) prev.fadeOut(fade);
    bot.actionName = name;
  }

  _applyGunLook(bot) {
    // GLB body: show exactly the pack's held-weapon mesh matching the loadout.
    if (bot.gunMeshes) {
      const want = CHAR_GUN_MESH[bot.weaponId] || 'AK';
      for (const name in bot.gunMeshes) bot.gunMeshes[name].visible = name === want;
      return;
    }
    // Cheap per-weapon silhouette tweak: AWP long barrel, pistols stubby.
    const p = bot.parts;
    if (!p || !p.gunBarrel) return;
    const id = bot.weaponId;
    if (id === 'awp') { p.gunBarrel.scale.z = 0.55; p.gunBarrel.position.z = -0.52; }
    else if (id === 'usp' || id === 'glock' || id === 'deagle') { p.gunBarrel.scale.z = 0.12; p.gunBarrel.position.z = -0.3; }
    else { p.gunBarrel.scale.z = 0.3; p.gunBarrel.position.z = -0.4; }
  }

  _respawnBot(bot, spawn, round) {
    bot.health = this._cfg.HEALTH;
    bot.alive = true;
    bot.velY = 0;
    bot.onGround = true;
    bot.blindUntil = 0;
    bot.blindSpray = false;
    bot.state = 'idle';
    bot.path = null;
    bot.hasGoal = false;
    bot.repathTimer = 0;
    bot.holdTimer = rand(0.5, 2);
    bot.target = null;
    bot.targetBot = null;
    bot.targetIsPlayer = false;
    bot.lastSeenTime = -99;
    bot.trackTime = 0;
    bot.reactionTimer = 0;
    bot.heardTime = -99;
    bot.damageTime = -99;
    bot.fireCooldown = 0;
    bot.burstLeft = 0;
    bot.pauseTimer = 0;
    bot.reloadTimer = 0;
    bot.plantClearTimer = 0;
    bot.plantTimer = 0;
    bot.defuseTimer = 0;
    bot.defusingAnnounced = false;
    bot.crouching = false;
    bot.wantCrouch = false;
    bot.crouchLerp = 0;
    bot.sneak = false;
    bot.moveSpeed = 0;
    bot.deathTime = -1;
    bot.corpseSettled = false;
    bot.fireAnim = 0;
    bot.footAccum = 0;
    bot.height = this._cfg.HEIGHT;

    if (spawn && spawn.pos) {
      bot.pos.copy(spawn.pos);
      bot.yaw = spawn.yaw || 0;
    } else {
      bot.pos.set((Math.random() - 0.5) * 8, 0, bot.team === 'ct' ? -30 : 30);
      bot.yaw = bot.team === 'ct' ? Math.PI : 0;
    }
    bot.scanYaw = bot.yaw;

    // Restore body pose from any previous death.
    const m = bot.mesh;
    m.visible = true;
    m.rotation.set(0, bot.yaw, 0);
    m.position.copy(bot.pos);
    if (bot.mixer) {
      bot.deathPlayed = false;
      bot.mixer.stopAllAction();
      bot.actionName = null;
      this._setBotAction(bot, 'Idle', 0);
      bot.mixer.update(0);
    }
    if (bot.parts) {
      bot.parts.legL.rotation.set(0, 0, 0);
      bot.parts.legR.rotation.set(0, 0, 0);
      bot.parts.armL.rotation.set(0, 0, 0);
      bot.parts.armR.rotation.set(0, 0, 0);
      bot.parts.head.rotation.set(0, 0, 0);
      bot.parts.torso.position.y = 0.9;
      bot.parts.torso.rotation.set(0, 0, 0);
    }
    bot.aimBlend = 0;
    bot.aimPitch = 0;
  }

  // -------------------------------------------------------------------------
  // Damage / death
  // -------------------------------------------------------------------------

  _damageBot(bot, amount, info) {
    if (!bot.alive) return;
    let dmg = amount;
    if (bot.armor > 0) {
      // Headshots punch through helmets (0.85) so AK/M4 one-taps stay lethal.
      dmg = amount * (info.headshot ? 0.85 : (this.game.config.ARMOR_DAMAGE_SCALE || 0.5));
      bot.armor = Math.max(0, bot.armor - amount * 0.5);
    }
    bot.health -= dmg;
    bot.damageTime = this.time;

    // Remember roughly where the pain came from so the brain can react.
    const from = info.from;
    let fromPos = null;
    if (from) {
      if (from.pos) fromPos = from.pos;
      else if (from.position) fromPos = from.position;
    }
    if (fromPos) bot.damageFromPos.copy(fromPos);
    else bot.damageFromPos.copy(bot.pos);

    // Getting shot cancels plant/defuse concentration.
    bot.plantClearTimer = 0;
    if (bot.state === 'plant') { bot.plantTimer = 0; bot.state = 'engage'; }
    if (bot.state === 'defuse') this._cancelDefuse(bot);

    if (bot.health <= 0) {
      bot.health = 0;
      bot.alive = false;
      bot.deathTime = this.time;
      bot.fallAxis = Math.random() < 0.5 ? 'x' : 'z';
      bot.fallSign = Math.random() < 0.5 ? -1 : 1;
      this.game.events.emit('bot:death', {
        bot,
        killer: info.from || null,
        weapon: info.weapon || null,
        headshot: !!info.headshot,
      });
      this._onCarrierCheck(bot);
    }
  }

  _onCarrierCheck(deadBot) {
    if (deadBot !== this.bombCarrier || this._bombPlanted) return;
    // The bomb drops where the carrier fell; the nearest living T retrieves it.
    this.bombCarrier = null;
    this._bombDropped = true;
    this._droppedBombPos.copy(deadBot.pos);
    this._assignRetriever();
  }

  _assignRetriever() {
    let best = null, bestD = Infinity;
    for (let i = 0; i < this.all.length; i++) {
      const b = this.all[i];
      if (b.team !== 't' || !b.alive) continue;
      const d = b.pos.distanceToSquared(this._droppedBombPos);
      if (d < bestD) { bestD = d; best = b; }
    }
    if (best) {
      best.plan = 'retrieve';
      best.hasGoal = false;
      best.path = null;
    }
  }

  _cancelDefuse(bot) {
    bot.defuseTimer = 0;
    bot.defusingAnnounced = false;
    if (bot.state === 'defuse') bot.state = 'engage';
    const st = this.game.state;
    if (st && st.bomb && st.bomb.defusingBy === bot) st.bomb.defusingBy = null;
  }

  // -------------------------------------------------------------------------
  // Event wiring (hearing, bookkeeping)
  // -------------------------------------------------------------------------

  _bindEvents() {
    const ev = this.game.events;

    ev.on('weapon:fire', (p) => {
      if (!p || !p.byPlayer || !p.origin) return;
      this._hearSound(p.origin, 'ct', this._cfg.HEAR_RANGE * 1.6);
    });

    ev.on('bot:fire', (p) => {
      if (!p || !p.bot || !p.origin) return;
      this._hearSound(p.origin, p.bot.team, this._cfg.HEAR_RANGE * 1.5, p.bot);
    });

    ev.on('player:footstep', (p) => {
      if (!p || !p.pos || p.walking) return; // sneaking is quiet
      this._hearSound(p.pos, 'ct', this._cfg.HEAR_RANGE);
    });

    ev.on('fx:explosion', (p) => {
      if (!p || !p.pos) return;
      this._hearSound(p.pos, null, this._cfg.HEAR_RANGE * 2.5);
    });

    ev.on('bomb:planted', (p) => {
      this._bombPlanted = true;
      if (p && p.pos) this._bombPos.copy(p.pos);
    });

    // Defensive: if rounds only announces round starts by event, still reset.
    ev.on('round:start', () => {
      if (this.time - this._lastResetAt > 0.5) this.resetForRound();
    });
  }

  _hearSound(pos, sourceTeam, range, sourceBot) {
    for (let i = 0; i < this.all.length; i++) {
      const b = this.all[i];
      if (!b.alive || b === sourceBot) continue;
      if (sourceTeam && b.team === sourceTeam) continue; // own team's noise is expected
      const dx = pos.x - b.pos.x, dz = pos.z - b.pos.z;
      if (dx * dx + dz * dz > range * range) continue;
      b.heardPos.copy(pos);
      b.heardTime = this.time;
    }
  }

  // -------------------------------------------------------------------------
  // Frame update
  // -------------------------------------------------------------------------

  update(dt) {
    this.time += dt;
    const phase = this.game.state.phase;
    if (phase === 'menu') return;

    const frozen = phase === 'freeze';
    const over = phase === 'roundEnd' || phase === 'gameEnd';

    // Watchdog: if the retriever died on the way to a dropped bomb, hand the
    // job to the next nearest living T so the bomb is never orphaned.
    if (this._bombDropped && !this._bombPlanted && !frozen && !over) {
      this._retrieveCheckTimer = (this._retrieveCheckTimer || 0) - dt;
      if (this._retrieveCheckTimer <= 0) {
        this._retrieveCheckTimer = 1;
        let hasRetriever = false;
        for (let i = 0; i < this.all.length; i++) {
          const b = this.all[i];
          if (b.alive && b.team === 't' && b.plan === 'retrieve') { hasRetriever = true; break; }
        }
        if (!hasRetriever) this._assignRetriever();
      }
    }

    for (let i = 0; i < this.all.length; i++) {
      const b = this.all[i];
      if (!b.alive) {
        this._animateDeath(b, dt);
        continue;
      }
      if (frozen || over) {
        b.moveSpeed = 0;
        b.burstLeft = 0;
        this._animateBot(b, dt);
        continue;
      }

      // Staggered brain tick (~10 Hz per bot).
      b.thinkTimer -= dt;
      if (b.thinkTimer <= 0) {
        b.thinkTimer += THINK_INTERVAL + rand(-0.015, 0.015);
        this._think(b);
      }

      this._moveBot(b, dt);
      this._combatFrame(b, dt);
      this._animateBot(b, dt);
    }
  }

  // -------------------------------------------------------------------------
  // Movement (every frame)
  // -------------------------------------------------------------------------

  _botEye(bot, out) {
    const eye = bot.crouching ? this._cfg.EYE * 0.68 : this._cfg.EYE;
    return out.set(bot.pos.x, bot.pos.y + eye, bot.pos.z);
  }

  _moveBot(bot, dt) {
    const world = this.game.world;
    const blind = bot.blindUntil > this.time;

    _delta.set(0, 0, 0);
    let wantSpeed = 0;

    const stationary = bot.state === 'plant' || bot.state === 'defuse' ||
      (bot.state === 'hold' && !bot.hasGoal) || bot.state === 'idle';

    if (blind && bot.state === 'engage') {
      // Blind: freeze and pray.
      wantSpeed = 0;
    } else if (bot.state === 'engage' && bot.target) {
      // Strafe-jiggle perpendicular to the enemy; occasionally crouch at range.
      bot.strafeTimer -= dt;
      if (bot.strafeTimer <= 0) {
        bot.strafeTimer = rand(0.6, 1.1);
        bot.strafeDir = -bot.strafeDir;
        if (Math.random() < 0.18) bot.strafeDir = 0; // brief stand-still feint
      }
      const tp = this._targetPos(bot, _v3);
      if (tp) {
        _v1.set(tp.x - bot.pos.x, 0, tp.z - bot.pos.z);
        const dist = _v1.length();
        if (dist > 0.01) _v1.multiplyScalar(1 / dist);
        // perpendicular
        _v2.set(-_v1.z, 0, _v1.x).multiplyScalar(bot.strafeDir);
        // AWP holds ground; others jiggle at ~55% run speed and close distance
        // when far beyond their weapon's comfort range.
        const stats = GUN[bot.weaponId] || GUN_FALLBACK;
        const advance = dist > stats.prefer ? 0.75 : (dist < stats.prefer * 0.4 ? -0.4 : 0);
        _v2.addScaledVector(_v1, advance);
        if (_v2.lengthSq() > 0.001) {
          _v2.normalize();
          wantSpeed = this._cfg.RUN_SPEED * (bot.weaponId === 'awp' ? 0.35 : 0.62);
          if (bot.crouching) wantSpeed *= 0.45;
          _delta.copy(_v2);
        }
      }
    } else if (!stationary && bot.path && bot.pathIndex < bot.path.length) {
      // Follow the current path.
      let node = bot.path[bot.pathIndex];
      _v1.set(node.x - bot.pos.x, 0, node.z - bot.pos.z);
      let d2 = _v1.lengthSq();
      while (d2 < NODE_REACH * NODE_REACH && bot.pathIndex < bot.path.length - 1) {
        bot.pathIndex++;
        node = bot.path[bot.pathIndex];
        _v1.set(node.x - bot.pos.x, 0, node.z - bot.pos.z);
        d2 = _v1.lengthSq();
      }
      if (d2 <= NODE_REACH * NODE_REACH && bot.pathIndex >= bot.path.length - 1) {
        bot.path = null; // arrived
        bot.hasGoal = false;
      } else if (d2 > 0.0001) {
        _v1.normalize();
        wantSpeed = bot.sneak ? WALK_SPEED : this._cfg.RUN_SPEED;
        _delta.copy(_v1);
      }
    }

    // Blindness outside a fight: stumble slowly instead of running lanes.
    if (blind && bot.state !== 'engage' && wantSpeed > 0) wantSpeed *= 0.3;

    // Teammate separation — a gentle push so squads do not stack.
    if (wantSpeed > 0) {
      for (let i = 0; i < this.all.length; i++) {
        const o = this.all[i];
        if (o === bot || !o.alive) continue;
        const dx = bot.pos.x - o.pos.x, dz = bot.pos.z - o.pos.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > 0.0001 && d2 < 1.44) {
          const d = Math.sqrt(d2);
          const push = (1.2 - d) / 1.2;
          _delta.x += (dx / d) * push * 0.9;
          _delta.z += (dz / d) * push * 0.9;
        }
      }
      if (_delta.lengthSq() > 0.001) _delta.normalize();
    }

    // Face movement direction when not aiming at someone.
    if (wantSpeed > 0 && bot.state !== 'engage' && _delta.lengthSq() > 0.01) {
      const targetYaw = yawFromDir(_delta.x, _delta.z);
      const diff = angleDiff(targetYaw, bot.yaw);
      bot.yaw += diff * Math.min(1, 10 * dt);
    }

    // Integrate: horizontal move + gravity through world collision.
    const grav = this.game.config.PLAYER.GRAVITY || 20;
    bot.velY -= grav * dt;
    const stepX = _delta.x * wantSpeed * dt;
    const stepZ = _delta.z * wantSpeed * dt;
    const stepY = bot.velY * dt;

    if (world && typeof world.resolveMovement === 'function') {
      _v4.set(stepX, stepY, stepZ);
      const height = bot.crouching ? this._cfg.HEIGHT * 0.7 : this._cfg.HEIGHT;
      const res = world.resolveMovement(bot.pos, _v4, bot.radius, height);
      if (res && res.pos) bot.pos.copy(res.pos);
      bot.onGround = !!(res && res.onGround);
      if (bot.onGround) bot.velY = Math.max(bot.velY, 0);
      if (res && res.hitCeiling) bot.velY = Math.min(bot.velY, 0);
    } else {
      bot.pos.x += stepX;
      bot.pos.z += stepZ;
      bot.pos.y = Math.max(0, bot.pos.y + stepY);
      bot.onGround = bot.pos.y <= 0.001;
      if (bot.onGround) bot.velY = 0;
    }

    bot.moveSpeed = Math.sqrt(stepX * stepX + stepZ * stepZ) / Math.max(dt, 1e-5);
    bot.height = bot.crouching ? this._cfg.HEIGHT * 0.7 : this._cfg.HEIGHT;

    // Footsteps while moving fast on the ground.
    if (bot.onGround && bot.moveSpeed > 2.6) {
      bot.footAccum += bot.moveSpeed * dt;
      if (bot.footAccum >= FOOTSTEP_DIST) {
        bot.footAccum -= FOOTSTEP_DIST;
        this.game.events.emit('bot:footstep', { pos: bot.pos.clone() });
      }
    } else if (bot.moveSpeed < 0.5) {
      bot.footAccum = 0;
    }
  }

  // -------------------------------------------------------------------------
  // Per-frame combat: aim smoothing + trigger
  // -------------------------------------------------------------------------

  _combatFrame(bot, dt) {
    bot.fireCooldown = Math.max(0, bot.fireCooldown - dt);
    if (bot.reloadTimer > 0) {
      bot.reloadTimer -= dt;
      if (bot.reloadTimer <= 0) {
        const stats = GUN[bot.weaponId] || GUN_FALLBACK;
        bot.mag = stats.mag;
        bot.burstLeft = 0;
        bot.pauseTimer = rand(0.1, 0.25);
      }
      bot.aimBlend = Math.max(0, bot.aimBlend - dt * 2);
      return;
    }

    const blind = bot.blindUntil > this.time;

    if (bot.state !== 'engage' || !bot.target) {
      bot.aimBlend = Math.max(0, bot.aimBlend - dt * 2.5);
      bot.aimPitch += (0 - bot.aimPitch) * Math.min(1, 6 * dt);
      return;
    }

    bot.aimBlend = Math.min(1, bot.aimBlend + dt * 5);
    bot.reactionTimer = Math.max(0, bot.reactionTimer - dt);
    bot.trackTime += dt;

    // Where is the enemy?
    const tp = this._targetPos(bot, _v3);
    if (!tp) return;
    this._botEye(bot, _eyeA);
    const aimY = tp.y + (bot.targetIsPlayer ? 1.35 : 1.3); // chest-high
    _v1.set(tp.x - _eyeA.x, aimY - _eyeA.y, tp.z - _eyeA.z);
    const dist = _v1.length();
    if (dist < 0.05) return;
    _v1.multiplyScalar(1 / dist);

    // Smoothed turn toward the target (TURN_SPEED rad/s exponential chase).
    const wantYaw = yawFromDir(_v1.x, _v1.z);
    const wantPitch = Math.asin(Math.max(-1, Math.min(1, _v1.y)));
    const k = 1 - Math.exp(-this._cfg.TURN_SPEED * dt);
    bot.yaw += angleDiff(wantYaw, bot.yaw) * k;
    bot.aimPitch += (wantPitch - bot.aimPitch) * k;

    // Can we actually see them right now?
    const seen = this.time - bot.lastSeenTime < 0.35;
    if (!seen && !blind) return;
    if (bot.reactionTimer > 0) return;
    if (blind && !bot.blindSpray) return;

    // On-target check: only fire once the barrel is roughly aligned.
    const offYaw = Math.abs(angleDiff(wantYaw, bot.yaw));
    const offPitch = Math.abs(wantPitch - bot.aimPitch);
    if (!blind && (offYaw > 0.12 || offPitch > 0.12)) return;

    // Burst discipline.
    const stats = GUN[bot.weaponId] || GUN_FALLBACK;
    if (bot.pauseTimer > 0) { bot.pauseTimer -= dt; return; }
    if (bot.burstLeft <= 0) {
      bot.burstLeft = randInt(stats.burst[0], stats.burst[1]);
    }
    if (bot.fireCooldown > 0) return;
    if (bot.mag <= 0) {
      bot.reloadTimer = stats.reload;
      return;
    }

    this._fireShot(bot, dist, blind);
    bot.mag--;
    bot.burstLeft--;
    bot.fireCooldown = 60 / stats.rpm;
    if (stats.bolt) bot.fireCooldown = Math.max(bot.fireCooldown, stats.bolt);
    if (bot.burstLeft <= 0) {
      bot.pauseTimer = rand(stats.pause[0], stats.pause[1]);
      // Long-range discipline: sometimes take a knee for the next burst.
      const farFight = dist > 26;
      bot.wantCrouch = farFight && Math.random() < 0.35;
    }
  }

  _fireShot(bot, dist, blind) {
    const stats = GUN[bot.weaponId] || GUN_FALLBACK;
    // Aim error: gaussian ~1.2 deg, worse when moving/blind/newly spotted,
    // slightly tighter up close.
    let err = 1.2 * DEG * (0.55 + 0.45 * Math.min(1, dist / 30));
    err *= 1 + 0.9 * Math.exp(-bot.trackTime * 2.2); // settle-in period
    if (bot.moveSpeed > 1.5) err *= 1.55;
    if (bot.crouching) err *= 0.8;
    if (blind) err *= 6;
    err += stats.spread;

    const yaw = bot.yaw + gauss() * err;
    const pitch = bot.aimPitch + gauss() * err * 0.8;
    const cp = Math.cos(pitch);
    const dir = new THREE.Vector3(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
    const origin = this._botEye(bot, _eyeA).clone();

    this.game.events.emit('bot:fire', { bot, weaponId: bot.weaponId, origin, dir });
    bot.fireAnim = 1; // viewkick for the body pose
  }

  _targetPos(bot, out) {
    if (bot.targetIsPlayer) {
      const pl = this.game.player;
      if (!pl || !pl.alive) return null;
      return out.copy(pl.position);
    }
    if (bot.targetBot && bot.targetBot.alive) return out.copy(bot.targetBot.pos);
    return null;
  }

  // -------------------------------------------------------------------------
  // Brain (staggered ~10 Hz)
  // -------------------------------------------------------------------------

  _think(bot) {
    const phase = this.game.state.phase;
    if (phase !== 'live' && phase !== 'planted') return;

    this._perceive(bot);

    // Drop a target that just died — no staring at corpses.
    if (bot.target) {
      const targetGone = bot.targetIsPlayer
        ? !(this.game.player && this.game.player.alive)
        : !(bot.targetBot && bot.targetBot.alive);
      if (targetGone) {
        bot.target = null;
        bot.targetBot = null;
        bot.targetIsPlayer = false;
        bot.trackTime = 0;
        bot.crouching = false;
        bot.wantCrouch = false;
        bot.state = 'hold';
        bot.holdTimer = rand(0.6, 1.6);
      }
    }

    const blind = bot.blindUntil > this.time;
    const hasTarget = bot.target !== null;

    // Engagement supersedes everything except an in-progress defuse race.
    if (hasTarget) {
      if (bot.state !== 'engage') {
        bot.state = 'engage';
        bot.strafeTimer = 0;
      }
      bot.crouching = bot.wantCrouch && !blind;
      // Refresh visibility timestamp for the trigger.
      if (this._canSee(bot, bot.targetIsPlayer ? null : bot.targetBot, bot.targetIsPlayer)) {
        bot.lastSeenTime = this.time;
        this._targetPos(bot, bot.lastSeenPos);
      } else if (this.time - bot.lastSeenTime > LOSE_TARGET_TIME) {
        // Lost them — push toward their last known spot.
        bot.target = null;
        bot.targetBot = null;
        bot.targetIsPlayer = false;
        bot.trackTime = 0;
        bot.crouching = false;
        bot.wantCrouch = false;
        bot.state = 'investigate';
        this._setGoal(bot, bot.lastSeenPos);
      }
      return;
    }

    bot.crouching = false;
    bot.wantCrouch = false;

    // React to recent damage from an unseen attacker: face and hunt the spot.
    if (this.time - bot.damageTime < 1.2 && bot.state !== 'investigate') {
      bot.state = 'investigate';
      this._setGoal(bot, bot.damageFromPos);
      return;
    }

    // Objective logic per team.
    if (bot.team === 't') this._thinkT(bot);
    else this._thinkCT(bot);

    // Fresh noise trumps idle wandering (not objectives in progress).
    if (this.time - bot.heardTime < 3 &&
        bot.state !== 'plant' && bot.state !== 'defuse' &&
        bot !== this.bombCarrier &&
        Math.random() < 0.6) {
      bot.state = 'investigate';
      this._setGoal(bot, bot.heardPos);
      bot.heardTime = -99; // consume
    }

    // Idle scanning while holding: sweep the head/body left-right.
    if (bot.state === 'hold' && !bot.hasGoal) {
      bot.holdTimer -= THINK_INTERVAL;
      if (bot.holdTimer <= 0) {
        bot.holdTimer = rand(1.5, 4);
        bot.scanYaw = bot.yaw + rand(-1.2, 1.2);
      }
      bot.yaw += angleDiff(bot.scanYaw, bot.yaw) * 0.12;
    }

    // Arrived-at-goal state resolution.
    if ((bot.state === 'move' || bot.state === 'investigate') && !bot.hasGoal && !bot.path) {
      bot.state = 'hold';
      bot.holdTimer = rand(1, 3);
    }
  }

  // ----- Terrorists -----

  _thinkT(bot) {
    const site = this._targetSite;

    if (this._bombPlanted) {
      // Post-plant: crash defensive positions around the bomb.
      if (bot.state !== 'hold' || !bot.hasGoal) {
        if (bot.state !== 'hold') {
          this._setGoal(bot, this._randomNear(this._bombPos, 8));
          bot.state = 'hold';
        } else if (!bot.path && Math.random() < 0.04) {
          this._setGoal(bot, this._randomNear(this._bombPos, 8));
        }
      }
      return;
    }

    if (bot.plan === 'retrieve' && this._bombDropped) {
      // Grab the dropped bomb.
      const d2 = bot.pos.distanceToSquared(this._droppedBombPos);
      if (d2 < 1.2) {
        this._bombDropped = false;
        this.bombCarrier = bot;
        bot.plan = 'carrier';
        bot.hasGoal = false;
        bot.path = null;
      } else if (!bot.hasGoal) {
        this._setGoal(bot, this._droppedBombPos);
        bot.state = 'move';
      }
      return;
    }

    if (bot === this.bombCarrier) {
      this._thinkCarrier(bot, site);
      return;
    }

    // Escorts shadow the carrier from a different route; control players roam
    // via their assigned map-control node, then converge on the site.
    if (bot.plan === 'escort' && this.bombCarrier && this.bombCarrier.alive) {
      const carrier = this.bombCarrier;
      const d2 = bot.pos.distanceToSquared(carrier.pos);
      if (d2 > 100) { // > 10 m: catch up
        if (!bot.hasGoal || bot.repathTimer <= 0) {
          bot.repathTimer = 1.4;
          this._setGoal(bot, carrier.pos);
          bot.state = 'move';
        }
        bot.repathTimer -= THINK_INTERVAL;
      } else if (!bot.hasGoal && site) {
        this._setGoal(bot, this._randomNear(site.center, 10));
        bot.state = 'move';
      }
      return;
    }

    // Map control: hit the via node first, then rotate toward the site.
    if (!bot.hasGoal && !bot.path) {
      if (bot.planVia) {
        this._setGoal(bot, bot.planVia);
        bot.planVia = null;
        bot.state = 'move';
      } else if (site) {
        this._setGoal(bot, this._randomNear(site.center, 9));
        bot.state = 'move';
      }
    }
  }

  _thinkCarrier(bot, site) {
    if (!site) return;
    const inSite = site.box && site.box.containsPoint
      ? site.box.containsPoint(_v1.set(bot.pos.x, site.center.y, bot.pos.z))
      : bot.pos.distanceToSquared(site.center) < 16;

    if (bot.state === 'plant') {
      // Plant progress is timed here in think ticks; interrupted by damage or a
      // visible enemy (damage resets state in _damageBot).
      if (this._enemyVisibleQuick(bot)) {
        bot.plantTimer = 0;
        bot.state = 'hold';
        return;
      }
      bot.plantTimer += THINK_INTERVAL;
      if (bot.plantTimer >= this._match.PLANT_TIME) {
        bot.state = 'hold';
        bot.plantTimer = 0;
        this._bombPlanted = true;
        this._bombPos.copy(bot.pos);
        this.game.events.emit('bomb:planted', { site: site.name, pos: bot.pos.clone() });
        this._setGoal(bot, this._randomNear(this._bombPos, 7));
      }
      return;
    }

    if (inSite) {
      bot.sneak = true;
      // Settle: only start planting after 1.5 s with no enemy in sight.
      if (this._enemyVisibleQuick(bot)) {
        bot.plantClearTimer = 0;
      } else {
        bot.plantClearTimer += THINK_INTERVAL;
      }
      if (bot.plantClearTimer >= PLANT_CLEAR_TIME) {
        bot.state = 'plant';
        bot.plantTimer = 0;
        bot.crouching = true;
        bot.path = null;
        bot.hasGoal = false;
      } else if (!bot.hasGoal && !bot.path) {
        this._setGoal(bot, this._randomNear(site.center, 2.5));
      }
    } else {
      bot.sneak = bot.pos.distanceToSquared(site.center) < 500; // quiet final approach
      bot.plantClearTimer = 0;
      if (!bot.hasGoal || bot.repathTimer <= 0) {
        bot.repathTimer = 3;
        this._setGoal(bot, site.center);
        bot.state = 'move';
      }
      bot.repathTimer -= THINK_INTERVAL;
    }
  }

  // ----- Counter-Terrorists -----

  _thinkCT(bot) {
    if (this._bombPlanted) {
      const bombPos = this._bombPos;
      const d2 = bot.pos.distanceToSquared(bombPos);

      if (bot.state === 'defuse') {
        if (this._enemyVisibleQuick(bot)) { this._cancelDefuse(bot); return; }
        if (d2 > 4) { this._cancelDefuse(bot); return; } // shoved off the bomb
        if (!bot.defusingAnnounced) {
          bot.defusingAnnounced = true;
          this.game.events.emit('bot:defusing', { bot });
        }
        bot.crouching = true;
        bot.defuseTimer += THINK_INTERVAL;
        if (bot.defuseTimer >= this._match.DEFUSE_TIME) {
          bot.defuseTimer = 0;
          bot.defusingAnnounced = false;
          bot.crouching = false;
          this.game.events.emit('bomb:defused', { by: bot });
        }
        return;
      }

      // Someone already on the kit? Then hold a perimeter instead.
      let defuserBusy = false;
      for (let i = 0; i < this.all.length; i++) {
        const o = this.all[i];
        if (o.team === 'ct' && o.alive && o.state === 'defuse') { defuserBusy = true; break; }
      }

      if (!defuserBusy && d2 < 2.56 && !this._enemyVisibleQuick(bot)) {
        // At the bomb, clear to start the 10 s stick.
        bot.state = 'defuse';
        bot.defuseTimer = 0;
        bot.path = null;
        bot.hasGoal = false;
        return;
      }

      // Rotate hard to the site.
      if (!bot.hasGoal || bot.repathTimer <= 0) {
        bot.repathTimer = 2;
        this._setGoal(bot, defuserBusy ? this._randomNear(bombPos, 7) : bombPos);
        bot.state = 'move';
      }
      bot.repathTimer -= THINK_INTERVAL;
      return;
    }

    // Pre-plant: patrol the assigned zone, pausing to watch angles.
    if (!bot.hasGoal && !bot.path && bot.state !== 'hold') {
      this._setGoal(bot, this._randomNear(bot.anchor, 10));
      bot.state = 'move';
    } else if (bot.state === 'hold' && bot.holdTimer <= 0 && Math.random() < 0.5) {
      this._setGoal(bot, this._randomNear(bot.anchor, 10));
      bot.state = 'move';
    }
  }

  // -------------------------------------------------------------------------
  // Perception
  // -------------------------------------------------------------------------

  _perceive(bot) {
    if (bot.target) return; // keep the current fight; loss handled in _think
    const engage2 = this._cfg.ENGAGE_RANGE * this._cfg.ENGAGE_RANGE;

    let bestD2 = engage2;
    let bestBot = null;
    let bestIsPlayer = false;

    // Player is an enemy of T bots only.
    const pl = this.game.player;
    if (bot.team === 't' && pl && pl.alive && pl.position) {
      const d2 = bot.pos.distanceToSquared(pl.position);
      if (d2 < bestD2 && this._canSee(bot, null, true)) {
        bestD2 = d2;
        bestIsPlayer = true;
      }
    }

    for (let i = 0; i < this.all.length; i++) {
      const o = this.all[i];
      if (o.team === bot.team || !o.alive) continue;
      const d2 = bot.pos.distanceToSquared(o.pos);
      if (d2 >= bestD2) continue;
      if (this._canSee(bot, o, false)) {
        bestD2 = d2;
        bestBot = o;
        bestIsPlayer = false;
      }
    }

    if (bestBot || bestIsPlayer) {
      bot.target = bestIsPlayer ? 'player' : bestBot;
      bot.targetBot = bestBot;
      bot.targetIsPlayer = bestIsPlayer;
      bot.lastSeenTime = this.time;
      this._targetPos(bot, bot.lastSeenPos);
      bot.trackTime = 0;
      bot.reactionTimer = rand(this._cfg.REACTION_MIN, this._cfg.REACTION_MAX);
    }
  }

  _canSee(bot, otherBot, isPlayer) {
    const world = this.game.world;
    this._botEye(bot, _eyeA);

    if (isPlayer) {
      const pl = this.game.player;
      if (!pl || !pl.alive) return false;
      if (typeof pl.eyePos === 'function') _eyeB.copy(pl.eyePos());
      else _eyeB.set(pl.position.x, pl.position.y + 1.6, pl.position.z);
    } else {
      if (!otherBot || !otherBot.alive) return false;
      this._botEye(otherBot, _eyeB);
    }

    _v5.copy(_eyeB).sub(_eyeA);
    const dist = _v5.length();
    if (dist > this._cfg.ENGAGE_RANGE || dist < 0.001) return false;
    _v5.multiplyScalar(1 / dist);

    // FOV cone around current facing.
    const facingX = -Math.sin(bot.yaw), facingZ = -Math.cos(bot.yaw);
    const flat = Math.hypot(_v5.x, _v5.z);
    if (flat > 0.05) {
      const dot = (_v5.x / flat) * facingX + (_v5.z / flat) * facingZ;
      const cosHalf = Math.cos((this._cfg.FOV_DEG * DEG) / 2);
      if (dot < cosHalf && dist > 2.2) return false; // point-blank ignores FOV
    }

    // Smoke check.
    const combat = this.game.combat;
    if (combat && typeof combat.losBlocked === 'function' && combat.losBlocked(_eyeA, _eyeB)) {
      return false;
    }

    // World geometry check.
    if (world && typeof world.raycast === 'function') {
      const hit = world.raycast(_eyeA, _v5, dist);
      if (hit && hit.distance < dist - 0.3) return false;
    }
    return true;
  }

  _enemyVisibleQuick(bot) {
    // Cheaper wide check used by plant/defuse gating — any enemy in view?
    const pl = this.game.player;
    if (bot.team === 't' && pl && pl.alive && this._canSee(bot, null, true)) return true;
    for (let i = 0; i < this.all.length; i++) {
      const o = this.all[i];
      if (o.team === bot.team || !o.alive) continue;
      if (bot.pos.distanceToSquared(o.pos) > 1600) continue; // 40 m quick reject
      if (this._canSee(bot, o, false)) return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Pathing helpers
  // -------------------------------------------------------------------------

  _setGoal(bot, pos) {
    if (!pos) return;
    const world = this.game.world;
    bot.goal.copy(pos);
    bot.hasGoal = true;
    bot.pathIndex = 0;
    if (world && typeof world.findPath === 'function') {
      const path = world.findPath(bot.pos, bot.goal);
      bot.path = path && path.length ? path : null;
    } else {
      bot.path = null;
    }
    if (!bot.path) {
      // No nav available — walk straight at it and hope collision slides us.
      bot.path = [bot.goal.clone()];
    }
  }

  _randomNear(pos, r) {
    const world = this.game.world;
    if (world && typeof world.randomPointNear === 'function') {
      const p = world.randomPointNear(pos, r);
      if (p) return p;
    }
    _v2.set(pos.x + rand(-r, r), pos.y, pos.z + rand(-r, r));
    return _v2;
  }

  // -------------------------------------------------------------------------
  // Body animation
  // -------------------------------------------------------------------------

  _animateBot(bot, dt) {
    const m = bot.mesh;
    const p = bot.parts;
    if (!m) return;

    m.position.copy(bot.pos);
    m.rotation.y = bot.yaw;
    m.rotation.x = 0;
    m.rotation.z = 0;

    if (bot.mixer) {
      // GLB soldier: choose a clip from the pack's locomotion set and let the
      // mixer drive the skeleton.
      const firing = bot.burstLeft > 0 || (bot.fireAnim || 0) > 0;
      const speed = bot.moveSpeed;
      let name;
      if (bot.crouching) name = 'Duck';
      else if (speed > 3.2) name = firing ? 'Run_Shoot' : 'Run_Gun';
      else if (speed > 0.5) name = firing ? 'Walk_Shoot' : 'Walk';
      else name = firing ? 'Idle_Shoot' : 'Idle';
      this._setBotAction(bot, name);
      const act = bot.actions[bot.actionName];
      if (act) {
        // Foot-sync run playback with actual speed; everything else at 1x.
        act.timeScale = (name === 'Run_Gun' || name === 'Run_Shoot')
          ? Math.max(0.7, Math.min(1.4, speed / this._cfg.RUN_SPEED + 0.25))
          : 1;
      }
      bot.fireAnim = Math.max(0, (bot.fireAnim || 0) - dt * 8);
      bot.mixer.update(dt);
      return;
    }

    if (!p) return; // primitive fallback body needs its parts rig

    // Crouch blend.
    const crouchTarget = bot.crouching ? 1 : 0;
    bot.crouchLerp += (crouchTarget - bot.crouchLerp) * Math.min(1, 8 * dt);
    const c = bot.crouchLerp;

    // Walk cycle driven by actual speed.
    const speedNorm = Math.min(1, bot.moveSpeed / this._cfg.RUN_SPEED);
    bot.walkPhase += bot.moveSpeed * dt * 2.4;
    const swing = Math.sin(bot.walkPhase) * 0.72 * speedNorm * (1 - c * 0.6);

    // Legs: opposite swing, plus a kneel bend while crouched.
    p.legL.rotation.x = swing + c * -1.0;
    p.legR.rotation.x = -swing + c * 0.55;

    // Torso: lower on crouch, breathe at idle, tiny bounce while running.
    const bounce = Math.abs(Math.sin(bot.walkPhase)) * 0.035 * speedNorm;
    const breathe = Math.sin(this.time * 1.7 + bot.walkPhase) * 0.008 * (1 - speedNorm);
    p.torso.position.y = 0.9 - 0.36 * c + bounce + breathe;
    p.torso.rotation.x = c * 0.12 + speedNorm * 0.06;

    // Fire kick decay.
    bot.fireAnim = Math.max(0, (bot.fireAnim || 0) - dt * 8);

    // Arms: blend between relaxed carry (with walk swing) and full aim pose.
    const aim = bot.aimBlend;
    const armSwing = Math.sin(bot.walkPhase) * 0.4 * speedNorm * (1 - aim);
    const aimX = Math.PI / 2 + bot.aimPitch;
    const relaxedR = 0.55 + armSwing;   // gun low-ready at the hip
    const relaxedL = 0.35 - armSwing;
    p.armR.rotation.x = relaxedR + (aimX - relaxedR) * aim + bot.fireAnim * 0.22;
    p.armL.rotation.x = relaxedL + (aimX * 0.94 - relaxedL) * aim + bot.fireAnim * 0.12;
    p.armR.rotation.y = 0;
    p.armL.rotation.y = 0.45 * aim; // support hand reaches across to the fore-grip

    // Head: track aim pitch, jitter when flashed.
    p.head.rotation.x = -bot.aimPitch * 0.7 * aim;
    if (bot.blindUntil > this.time) {
      p.head.rotation.z = Math.sin(this.time * 31) * 0.07;
      p.head.rotation.x += Math.sin(this.time * 23) * 0.05;
    } else {
      p.head.rotation.z = 0;
    }
  }

  _animateDeath(bot, dt) {
    const m = bot.mesh;
    if (!m || bot.deathTime < 0) return;

    if (bot.mixer) {
      // GLB soldier: the pack's Death clip does the falling; freeze when done.
      m.position.copy(bot.pos);
      m.rotation.set(0, bot.yaw, 0);
      if (!bot.deathPlayed) {
        bot.deathPlayed = true;
        this._setBotAction(bot, 'Death', 0.08);
      }
      if (!bot.corpseSettled) {
        bot.mixer.update(dt);
        const death = bot.actions.Death;
        if (death && death.time >= death.getClip().duration - 1e-3) {
          bot.corpseSettled = true;
        }
      }
      return;
    }

    const t = Math.min(1, (this.time - bot.deathTime) / CORPSE_FALL_TIME);
    const e = t * t * (3 - 2 * t); // smoothstep ease
    const ang = bot.fallSign * (Math.PI / 2) * 0.97 * e;
    if (bot.fallAxis === 'x') m.rotation.x = ang;
    else m.rotation.z = ang;
    m.rotation.y = bot.yaw;
    m.position.copy(bot.pos);
    m.position.y = bot.pos.y + 0.03 * e; // avoid z-fighting with the floor

    if (t >= 1 && !bot.corpseSettled) {
      bot.corpseSettled = true;
      const p = bot.parts;
      if (p) { // limp limbs
        p.armR.rotation.x = 0.25;
        p.armL.rotation.x = -0.2;
        p.armL.rotation.y = 0;
        p.legL.rotation.x = 0.18;
        p.legR.rotation.x = -0.12;
        p.head.rotation.x = 0.15;
        p.head.rotation.z = 0.1;
      }
    }
  }
}
