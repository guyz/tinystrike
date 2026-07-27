// src/ai/bots.js — Bot AI, humanoid bodies, and team behavior for TINY STRIKE.
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
import { weaponInstance, hasWeaponModel } from '../gfx/weapons/registry.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  SSAO_PARS_FRAGMENT,
  ssaoUniforms,
  registerSsaoConsumer,
} from '../gfx/post/ssao.js';
import {
  balancedDefenseIndices,
  balancedRouteIndices,
  selectDiversePointIndex,
} from './tactics.js';

// The operatives read the same screen-space AO buffer the world's materials do
// (see _surfaceOperativeMaterial). Module scope, matching materials/shader.js:
// the flag has to be set before main.js constructs PostChain.
registerSsaoConsumer();

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

/**
 * The quarter turn from our weapon convention (bore down -Z) to each held-mesh
 * group's own axis. Measured off the pack's geometry, not guessed: the AK,
 * Pistol and Sniper groups all run down their local +X, and the SMG down -X.
 */
const FAMILY_AXIS_FIX = {
  AK: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2),
  Pistol: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2),
  Sniper: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2),
  SMG: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2),
};

const _gunScale = new THREE.Vector3();

// ---------------------------------------------------------------------------
// Operative body merge (see _optimizeCharacterAsset)
// ---------------------------------------------------------------------------

/**
 * Which palette entry `_tintOperativeMaterials` writes onto a source material,
 * keyed by the pack's own material name (lower-cased).
 *
 * This table IS the merge key's first half. Two of the pack's sub-meshes may
 * only share one draw call if a palette would paint them the same colour —
 * merging `Character_Main` (the uniform) into `Pants` (the sleeve) would make a
 * remote player's two-tone kit impossible, which is a bug, not an optimisation.
 */
const OPERATIVE_TINT_SLOT = {
  skin: 'skin',
  character_main: 'uniform',
  enemy_red: 'uniform',
  pants: 'sleeve',
  grey: 'sleeve',
  darkgrey: 'dark',
  black: 'dark',
};

/**
 * The surface response `_surfaceOperativeMaterial` gives a material, and the
 * second half of the merge key: `skin` gets no normal map and roughness 0.68,
 * `hard` gets the rubber normal at 0.52, cloth gets the fabric weave at 0.94.
 * Merging across classes would flatten those three responses into one.
 */
function operativeSurfaceClass(name) {
  if (name === 'skin') return 'skin';
  if (name === 'darkgrey' || name === 'black') return 'hard';
  return 'cloth';
}

/**
 * Two sub-meshes are mergeable iff both halves agree. A material name neither
 * table knows about falls into a group of its own (`raw:<name>`), so an
 * unrecognised surface can never be silently folded into a tinted one.
 */
function operativeMergeKey(material) {
  const name = String((material && material.name) || '').toLowerCase();
  const slot = OPERATIVE_TINT_SLOT[name] || `raw:${name}`;
  return `${slot}|${operativeSurfaceClass(name)}`;
}

/**
 * The pack is a TOON kit (see CHAR_MODELS): its base colours were authored as the
 * FINISHED PIXEL of an unlit shader, not as reflectance for a lit one. Read as
 * albedo they sit far above anything the maps are built out of, and the soldiers
 * read as stickers laid over the scene.
 *
 * MEASURED on Dustyard per tools/MEASURING.md (world pumped 120 steps, camera at
 * chest height 3.4 m from a CT stood 4 m in front of a plaster wall in full sun).
 * Each number is the median luma of the pixels one merged body mesh actually
 * covers, taken from an exact silhouette mask, against the sunlit wall beside it
 * at 101.7:
 *
 *   slot              authored Y (linear)   lit median   vs sunlit wall
 *   skin                    0.316              170.9        1.68x
 *   sleeve / trouser        0.289              169.5        1.67x
 *   uniform (CT olive)      0.168              136.5        1.34x
 *   uniform (T red)         0.077               63.2        0.62x
 *   webbing / boots      0.067, 0.024           71.1        0.70x
 *
 * Inverting the wall back through the same lighting puts the map's plaster near
 * 0.09 linear, so the TOP of this palette is ~3.5x the brightest surface around
 * it while its BOTTOM is already at the physical floor for cloth (soot is
 * 0.02-0.04). The range is too wide at the top, not uniformly too bright, so the
 * correction is a gamma about the pack's own black rather than one scale for the
 * whole family:
 *
 *   Y' = PIVOT * (Y / PIVOT) ** GAMMA     applied as a SCALE on the linear
 *                                         colour, so hue and saturation never
 *                                         move — only value
 *
 * GAMMA 0.53 lands the brightest slot at 0.094, i.e. 0.9x a sunlit plaster wall,
 * and barely touches the dark end. A hard ceiling was measured first and
 * rejected: clamping every slot to one value collapsed the skin:uniform ratio
 * from 1.88 to 1.05 and the soldier lost all internal value contrast. This curve
 * keeps that ratio at 1.40 and the CT:T uniform ratio at 1.51.
 */
const OPERATIVE_ALBEDO_PIVOT = 0.024; // the pack's darkest authored value, linear Y
const OPERATIVE_ALBEDO_GAMMA = 0.53;

/** The hue-preserving scale that puts one authored linear colour on the curve. */
function operativeAlbedoScale(color) {
  const y = 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
  if (!(y > OPERATIVE_ALBEDO_PIVOT)) return 1;
  return Math.pow(y / OPERATIVE_ALBEDO_PIVOT, OPERATIVE_ALBEDO_GAMMA - 1);
}

/**
 * The screen-space AO term, for a plain MeshStandardMaterial.
 *
 * The world's own materials apply it inside the forge's shader (materials/
 * shader.js multiplies its `ambientOcclusion` by SSAO_APPLY), and that variable
 * only exists there — three's own aomap_fragment compiles to nothing without an
 * aoMap. So this is three's aomap_fragment body, driven by owScreenAO() instead
 * of a texture, inserted at the same point in the lighting flow.
 */
const OPERATIVE_AO_APPLY = /* glsl */ `
	float owAo = owScreenAO();
	reflectedLight.indirectDiffuse *= owAo;
	#if defined( USE_ENVMAP ) && defined( STANDARD )
		float owDotNV = saturate( dot( geometryNormal, geometryViewDir ) );
		reflectedLight.indirectSpecular *= computeSpecularOcclusion( owDotNV, owAo, material.roughness );
	#endif
`;

const DEG = Math.PI / 180;
const THINK_INTERVAL = 0.1;
// Stay close enough to the authored centre line to clear doorways and sharp
// corners.  The old 0.7 m radius let a 0.35 m bot cut a corner before its
// capsule had actually entered the opening.
const NODE_REACH = 0.42;
const FOOTSTEP_DIST = 2.6;
const WALK_SPEED = 2.2;
const CORPSE_FALL_TIME = 0.4;
const LOSE_TARGET_TIME = 2.2; // s unseen before target degrades to a memory
const PLANT_CLEAR_TIME = 1.5; // s without a visible enemy before planting starts
const TEAM_SEPARATION = 2.15;
const TEAM_QUEUE_DISTANCE = 2.75;
const NAV_SAMPLE_INTERVAL = 0.45;
const NAV_MIN_TRAVEL = 0.15;
const NAV_MIN_PROGRESS = 0.06;
const NAV_STUCK_TIME = 0.9;
const NAV_BLOCKED_TIME = 0.55;
const NAV_RECOVERY_TIME = 0.6;
const NAV_REPATH_COOLDOWN = 1.2;
const NAV_GOAL_REUSE_DISTANCE = 1.1;
const CT_HOLD_MIN = 6.5;
const CT_HOLD_MAX = 10.5;
const T_HOLD_MIN = 3.0;
const T_HOLD_MAX = 5.5;
const INVESTIGATE_HOLD_MIN = 2.0;
const INVESTIGATE_HOLD_MAX = 3.8;

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
const _moveStart = new THREE.Vector3();
const _navLeft = new THREE.Vector3();
const _navRight = new THREE.Vector3();

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
    this._lastTargetSite = null;
    this._sameSiteRounds = 0;
    this._radarBlips = [];
    this._sharedGeo = null; // built lazily (unit box reused for every body part)
    this._externalActors = new Set();
    this._root = new THREE.Group();
    this._root.name = 'bots';
    if (game.scene) game.scene.add(this._root);

    this._charAssets = { ct: null, t: null }; // GLB templates: { scene, clips }
    this._ctCount = Math.max(0, this._match.BOTS_PER_TEAM - 1);
    this._tCount = Math.max(0, this._match.BOTS_PER_TEAM);
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

  /** Rebuild the AI roster for humans-only or humans-plus-bots sessions. */
  configureRoster(ctCount, tCount) {
    this._ctCount = Math.max(0, Math.floor(ctCount || 0));
    this._tCount = Math.max(0, Math.floor(tCount || 0));
    while (this._root.children.length) this._root.remove(this._root.children[0]);
    this.all.length = 0;
    this.bombCarrier = null;
    this._buildRoster();
  }

  /**
   * Give a replicated human the exact same skinned operative presentation used
   * by AI. External actors deliberately start as an empty group instead of the
   * old block body while the shipped GLB finishes loading.
   */
  createOperativeVisual(actor, palette = null) {
    if (!actor) return new THREE.Group();
    actor.visualPalette = palette;
    actor.parts = null;
    actor.rig = null;
    actor.mixer = null;
    actor.actions = {};
    actor.actionName = null;
    actor.gunMeshes = {};
    actor.deathTime = Number.isFinite(actor.deathTime) ? actor.deathTime : -1;
    actor.deathPlayed = false;
    actor.corpseSettled = false;
    actor.fallAxis = actor.fallAxis === 'x' ? 'x' : 'z';
    actor.fallSign = Number(actor.fallSign) < 0 ? -1 : 1;
    actor.fireAnim = Number(actor.fireAnim) || 0;
    actor.burstLeft = Number(actor.burstLeft) || 0;
    actor.aimPitch = Number(actor.aimPitch) || 0;
    actor.aimBlend = 1;
    actor.mesh = new THREE.Group();
    actor.mesh.name = 'remote-operative';
    actor.mesh.visible = false;
    if (!this._externalActors) this._externalActors = new Set();
    this._externalActors.add(actor);
    this._attachGLB(actor);
    return actor.mesh;
  }

  rebuildOperativeVisual(actor, palette = actor && actor.visualPalette) {
    if (!actor) return null;
    this._disposeOperativeRig(actor);
    actor.visualPalette = palette;
    // Keep the root stable: combat, spectator and interpolation all retain a
    // reference to the actor while a team/model swap happens asynchronously.
    if (!actor.mesh) {
      actor.mesh = new THREE.Group();
      actor.mesh.name = 'remote-operative';
    }
    this._attachGLB(actor);
    return actor.mesh;
  }

  updateOperativeAppearance(actor, palette) {
    if (!actor) return;
    actor.visualPalette = palette;
    this._tintOperativeMaterials(actor);
  }

  updateOperativeVisual(actor, dt) {
    if (!actor || !actor.mesh) return;
    actor.moveSpeed = Number(actor.moveSpeed2D) || 0;
    actor.aimPitch = Number(actor.pitch) || 0;
    this._applyGunLook(actor);
    if (actor.alive === false) this._animateDeath(actor, dt);
    else this._animateBot(actor, dt);
  }

  setOperativeAlive(actor, alive, snapshot = {}) {
    return this._setVisualAlive(actor, alive !== false, snapshot);
  }

  destroyOperativeVisual(actor) {
    if (!actor) return;
    this._externalActors?.delete(actor);
    if (actor.mesh && actor.mesh.parent) actor.mesh.parent.remove(actor.mesh);
    this._disposeOperativeRig(actor);
    actor.mesh = null;
  }

  _setVisualAlive(actor, nextAlive, snapshot = {}) {
    if (!actor || actor.alive === nextAlive) return false;
    actor.alive = nextAlive;
    if (!nextAlive) {
      actor.deathTime = this.time;
      actor.deathPlayed = false;
      actor.corpseSettled = false;
      actor.moveSpeed = 0;
      actor.moveSpeed2D = 0;
      actor.fallAxis = snapshot.fallAxis === 'x' ? 'x' : 'z';
      actor.fallSign = Number(snapshot.fallSign) < 0 ? -1 : 1;
      return true;
    }

    actor.deathTime = -1;
    actor.deathPlayed = false;
    actor.corpseSettled = false;
    if (actor.mesh) {
      actor.mesh.rotation.x = 0;
      actor.mesh.rotation.z = 0;
    }
    if (actor.mixer) {
      actor.mixer.stopAllAction();
      actor.actionName = null;
      this._setBotAction(actor, 'Idle', 0);
      actor.mixer.update(0);
    }
    return true;
  }

  /** Apply host bot transforms on non-authoritative clients. */
  applyNetworkSnapshot(snapshot) {
    if (!Array.isArray(snapshot)) return false;
    let aliveChanged = false;
    let carrier = null;
    for (let i = 0; i < this.all.length; i++) {
      const b = this.all[i];
      const s = snapshot[i];
      if (!s) { if (b.mesh) b.mesh.visible = false; continue; }
      if (!b.netPos) b.netPos = b.pos.clone();
      if (s.pos) b.netPos.set(s.pos.x || 0, s.pos.y || 0, s.pos.z || 0);
      b.netYaw = Number.isFinite(s.yaw) ? s.yaw : b.yaw;
      b.netAimPitch = Number.isFinite(s.aimPitch) ? s.aimPitch : b.aimPitch;
      const nextAlive = s.alive !== false;
      if (this._setVisualAlive(b, nextAlive, s)) aliveChanged = true;
      b.health = Number.isFinite(s.health) ? s.health : b.health;
      b.armor = Number.isFinite(s.armor) ? s.armor : b.armor;
      b.crouching = !!s.crouching;
      b.weaponId = s.weaponId || b.weaponId;
      b.moveSpeed = nextAlive ? (Number(s.moveSpeed) || 0) : 0;
      b.state = s.state || b.state;
      b.plan = typeof s.plan === 'string' ? s.plan : b.plan;
      b.postPlantRole = typeof s.postPlantRole === 'string' ? s.postPlantRole : null;
      b.anchorReached = !!s.anchorReached;
      if (s.anchor) b.anchor.set(Number(s.anchor.x) || 0, Number(s.anchor.y) || 0, Number(s.anchor.z) || 0);
      if (typeof s.patrolArea === 'string') {
        b.patrolArea = s.patrolArea;
        const areas = this.game.world?.botTactics?.defenseAreas || [];
        const area = areas.find((candidate) => candidate.name === s.patrolArea);
        b.patrolPoints = area ? area.points : b.patrolPoints;
      }
      if (Number.isFinite(s.mag)) b.mag = Math.max(0, Math.floor(s.mag));
      if (Number.isFinite(s.fireCooldown)) b.fireCooldown = Math.max(0, s.fireCooldown);
      if (Number.isFinite(s.burstLeft)) b.burstLeft = Math.max(0, Math.floor(s.burstLeft));
      if (Number.isFinite(s.pauseTimer)) b.pauseTimer = Math.max(0, s.pauseTimer);
      if (Number.isFinite(s.reloadTimer)) b.reloadTimer = Math.max(0, s.reloadTimer);
      if (Number.isFinite(s.plantClearTimer)) b.plantClearTimer = Math.max(0, s.plantClearTimer);
      if (Number.isFinite(s.plantTimer)) b.plantTimer = Math.max(0, s.plantTimer);
      if (Number.isFinite(s.defuseTimer)) b.defuseTimer = Math.max(0, s.defuseTimer);
      if (Number.isFinite(s.blindRemaining)) {
        b.blindUntil = this.time + Math.max(0, s.blindRemaining);
        b.blindSpray = !!s.blindSpray;
      }
      if (s.isBombCarrier) carrier = b;
      if (b.mesh) b.mesh.visible = true;
      this._applyGunLook(b);
    }
    this.bombCarrier = carrier;
    return aliveChanged;
  }

  applyObjectiveSnapshot(bomb) {
    if (!bomb) return;
    this._bombPlanted = !!bomb.planted;
    if (bomb.pos) this._bombPos.set(bomb.pos.x || 0, bomb.pos.y || 0, bomb.pos.z || 0);
  }

  networkAuthoritySnapshot() {
    return {
      targetSite: this._targetSite?.name || null,
      bombDropped: !!this._bombDropped,
      droppedBombPos: this._bombDropped
        ? { x: this._droppedBombPos.x, y: this._droppedBombPos.y, z: this._droppedBombPos.z }
        : null,
    };
  }

  applyAuthoritySnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    if (typeof snapshot.targetSite === 'string') {
      const sites = this.game.world?.bombSites || [];
      this._targetSite = sites.find((site) => site.name === snapshot.targetSite) || this._targetSite;
    }
    this._bombDropped = !!snapshot.bombDropped;
    if (snapshot.droppedBombPos) {
      this._droppedBombPos.set(
        Number(snapshot.droppedBombPos.x) || 0,
        Number(snapshot.droppedBombPos.y) || 0,
        Number(snapshot.droppedBombPos.z) || 0,
      );
    }
  }

  /** Rebuild transient AI intent from the last canonical network frame. */
  resumeNetworkAuthority() {
    for (let i = 0; i < this.all.length; i++) {
      const bot = this.all[i];
      if (bot.netPos) bot.pos.copy(bot.netPos);
      if (Number.isFinite(bot.netYaw)) bot.yaw = bot.netYaw;
      if (Number.isFinite(bot.netAimPitch)) bot.aimPitch = bot.netAimPitch;
      bot.target = null;
      bot.targetBot = null;
      bot.targetHuman = null;
      bot.targetIsPlayer = false;
      bot.targetVisible = false;
      bot.lastSeenTime = -99;
      bot.trackTime = 0;
      bot.reactionTimer = 0;
      bot.path = null;
      bot.pathIndex = 0;
      bot.hasGoal = false;
      bot.routeQueue.length = 0;
      bot.routeActive = false;
      bot.routeName = null;
      bot.repathTimer = 0;
      bot.repathCooldown = 0;
      bot.recoveryUntil = 0;
      bot.recoveryDir.set(0, 0, 0);
      bot.recoveryCount = 0;
      bot.avoidUntil = 0;
      bot.navSampleTimer = 0;
      bot.navSamplePathIndex = -1;
      bot.navSampleDistance = Infinity;
      bot.navSamplePos.copy(bot.pos);
      bot.stuckTime = 0;
      bot.blockedTime = 0;
      bot.moveSpeed = 0;
      bot.velY = 0;
      bot.thinkTimer = (bot.slot % 5) * 0.02;
      if (bot.alive && bot.state !== 'plant' && bot.state !== 'defuse') {
        bot.state = 'hold';
        bot.holdTimer = 0.05 + (bot.slot % 3) * 0.03;
      }
      if (bot.mesh) bot.mesh.position.copy(bot.pos);
    }
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
    const humanCount = { ct: 0, t: 0 };
    const mp = this.game.multiplayer;
    if (mp && mp.active) {
      for (const p of mp.roster) if (p.team === 'ct' || p.team === 't') humanCount[p.team]++;
    } else {
      humanCount.ct = 1;
    }

    for (let i = 0; i < this.all.length; i++) {
      const b = this.all[i];
      const list = spawns ? spawns[b.team] : null;
      let spawn = null;
      if (list && list.length) {
        // Human players take the first team spawns; AI fills the remaining slots.
        const idx = (used[b.team] + humanCount[b.team]) % list.length;
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
    for (let i = 0; i < this._ctCount; i++) this.all.push(this._createBot(CT_NAMES[i % CT_NAMES.length], 'ct', i));
    for (let i = 0; i < this._tCount; i++) this.all.push(this._createBot(T_NAMES[i % T_NAMES.length], 't', i));
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

    // The carrier commits to a site for the whole round. Keep the slight A
    // preference, but cap streaks so several rounds cannot replay identically.
    const sites = world && world.bombSites ? world.bombSites : null;
    let site = null;
    if (sites && sites.length) {
      site = Math.random() < 0.55 ? sites[0] : sites[sites.length - 1];
      if (sites.length > 1 && site.name === this._lastTargetSite && this._sameSiteRounds >= 2) {
        site = sites.find((candidate) => candidate.name !== this._lastTargetSite) || site;
      }
      if (site.name === this._lastTargetSite) this._sameSiteRounds++;
      else this._sameSiteRounds = 1;
      this._lastTargetSite = site.name;
    }
    this._targetSite = site;

    // Each attacker gets an authored approach lane. Previously escorts ignored
    // their `planVia` entirely and chased the carrier, so the entire team chose
    // the same shortest path. Routes now cover all lanes before one is reused.
    const attackRoutes = site && world && world.botTactics
      ? (world.botTactics.attackRoutes[site.name] || [])
      : [];
    const attackOrder = this.bombCarrier
      ? [this.bombCarrier, ...ts.filter((bot) => bot !== this.bombCarrier)]
      : ts;
    const attackAssignments = balancedRouteIndices(
      attackOrder.length,
      attackRoutes.length,
      round * 13 + (site && site.name === 'B' ? 5 : 0)
    );
    for (let i = 0; i < attackOrder.length; i++) {
      const b = attackOrder[i];
      b.plan = i === 0 && b === this.bombCarrier ? 'carrier' : (i <= 2 ? 'escort' : 'control');
      b.planVia = null;
      b.patrolArea = null;
      b.patrolPoints = null;
      this._clearRoute(b);
      if (attackRoutes.length) this._assignRoute(b, attackRoutes[attackAssignments[i]]);
    }

    // CTs cover A, B and mid before adding a second defender to any sector.
    // Within each sector the exact post rotates by round.
    const cts = [];
    for (let i = 0; i < this.all.length; i++) if (this.all[i].team === 'ct') cts.push(this.all[i]);
    const defenseAreas = world && world.botTactics ? world.botTactics.defenseAreas : [];
    const defenseAssignments = balancedDefenseIndices(cts.length, defenseAreas, round - 1);
    for (let i = 0; i < cts.length; i++) {
      const b = cts[i];
      this._clearRoute(b);
      b.planVia = null;
      const area = defenseAreas[defenseAssignments[i]];
      if (area) {
        b.anchor.copy(area.anchor);
        b.patrolArea = area.name;
        b.patrolPoints = area.points;
      } else if (sites && sites.length >= 2) {
        if (i % 2 === 0) b.anchor.copy(sites[0].center);
        else b.anchor.copy(sites[1].center);
        if (i === 2 && sites.length >= 2) {
          // one CT loosely holds the middle ground between sites
          b.anchor.copy(sites[0].center).add(sites[1].center).multiplyScalar(0.5);
        }
      } else {
        b.anchor.copy(b.pos);
      }
      b.anchorReached = false;
      b.plan = 'defend';
    }
  }

  // -------------------------------------------------------------------------
  // Bot creation + bodies
  // -------------------------------------------------------------------------

  _createBot(name, team, index) {
    const self = this;
    const bot = {
      name, team,
      slot: index,
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
      postPlantRole: null,  // null | defuse | perimeter
      planVia: null,
      anchor: new THREE.Vector3(),
      routeQueue: [],
      routeActive: false,
      routeName: null,
      patrolArea: null,
      patrolPoints: null,
      anchorReached: false,
      destinationHistory: [],
      decisionSeq: 0,
      path: null,
      pathIndex: 0,
      goal: new THREE.Vector3(),
      hasGoal: false,
      repathTimer: 0,
      repathCooldown: 0,
      navSampleTimer: 0,
      navSamplePathIndex: -1,
      navSampleDistance: Infinity,
      navSamplePos: new THREE.Vector3(),
      stuckTime: 0,
      blockedTime: 0,
      recoveryUntil: 0,
      recoveryDir: new THREE.Vector3(),
      recoveryCount: 0,
      avoidSide: index % 2 === 0 ? -1 : 1,
      avoidUntil: 0,
      holdTimer: 0,
      scanTimer: 0,
      scanYaw: 0,

      target: null,          // { isPlayer, bot } — resolved each think
      targetIsPlayer: false,
      targetHuman: null,
      targetBot: null,
      targetVisible: false,
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
      formationSide: index % 2 === 0 ? -1 : 1,

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
    this._attachGLB(bot);
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
    // Same rule as the skinned body (_attachGLB): a soldier that cannot be
    // shadowed keeps the key light everywhere and floats out of the scene. This
    // is the pre-GLB fallback, so it is a handful of Lambert programs.
    m.receiveShadow = true;
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
          // Value-correct the authored paint BEFORE the merge bakes it into a
          // vertex attribute, and before any team palette exists, so there is
          // never a question of whether a colour is still the pack's paint.
          this._correctOperativeAlbedo(gltf.scene);
          // Collapse the pack's sub-meshes ONCE, here, on the shared source —
          // every bot then clones an already-merged body.
          const merged = this._optimizeCharacterAsset(team, gltf.scene);
          this._charAssets[team] = {
            scene: gltf.scene,
            clips: gltf.animations,
            sharedSkeleton: !!merged,
          };
          this._refreshCharacterVisuals();
        },
        undefined,
        (err) => {
          console.warn(`[bots] ${team} soldier model failed; using the other operative when available`, err);
          this._refreshCharacterVisuals();
        }
      );
    }
  }

  /**
   * Put the pack's authored colours on the reflectance curve (see
   * OPERATIVE_ALBEDO_GAMMA), once, on the shared source asset.
   *
   * Only the seven material names the merge key already knows are touched, so an
   * unrecognised surface — or a held weapon's own material — keeps its authored
   * value, exactly as it keeps its own merge group. The scale is applied to the
   * linear colour, so it is a pure VALUE move: `#66793e` olive stays that olive,
   * `#991c22` red stays that red, and the CT/T read stays intact.
   */
  _correctOperativeAlbedo(scene) {
    scene.traverse((object) => {
      if (!object.isMesh) return;
      for (const material of (Array.isArray(object.material) ? object.material : [object.material])) {
        if (!material || !material.color) continue;
        // Materials are shared between sub-meshes; scale each one once.
        if (material.userData.tsAlbedoOnCurve) continue;
        if (!OPERATIVE_TINT_SLOT[String(material.name || '').toLowerCase()]) continue;
        material.userData.tsAlbedoOnCurve = true;
        material.color.multiplyScalar(operativeAlbedoScale(material.color));
      }
    });
  }

  /**
   * Collapse one soldier GLB into four SkinnedMeshes, once, on the shared asset.
   *
   * WHY, measured on Dustyard with nine bots (r.info.autoReset = false;
   * r.info.reset(); r.render(scene, camera)), frustum culling forced off so the
   * count is camera-independent:
   *
   *   before  CT body 10 draws / 5 skeletons,  T body 8 draws / 8 skeletons
   *           80 body draws across the roster = 310 of the frame's 863 main-pass
   *           calls (each body mesh is drawn twice: main pass + shadow map)
   *   after   4 draws and 1 skeleton per bot, whichever team
   *
   * The pack authors one sub-mesh per material and hangs three more rigid props
   * off bones (CT: the helmet group under `Head`, `ShoulderPadL/R` under the
   * upper-arm bones), so a CT soldier costs ten draw calls for 5828 triangles —
   * 583 triangles per draw call, which is the definition of draw-call bound.
   *
   * Three things make the merge exact rather than approximate:
   *
   *  1. GROUPING. The key is (palette slot, surface class) — see
   *     operativeMergeKey. Both CT and T land on exactly four groups, so a
   *     palette-tinted remote still addresses skin / uniform / sleeve / dark
   *     independently, and the three surface responses stay separable.
   *  2. ALBEDO. The pack has no textures at all (13 materials, every one a bare
   *     baseColorFactor), so each source material's linear colour is baked into
   *     a per-vertex `color` attribute and the merged material carries white.
   *     `diffuse * vColor` reproduces the authored albedo bit for bit. A palette
   *     replaces the albedo outright, so `_tintOperativeMaterials` switches
   *     `vertexColors` off and the flat colour wins — also bit for bit.
   *  3. RIGID PROPS. A mesh parented to a bone is a skinned mesh with weight
   *     1.0 on that bone. Baking `inverse(boneInverse) * bone.matrixWorld^-1 *
   *     mesh.matrixWorld` into its vertices and giving it that bone index makes
   *     it animate identically — verified against this pack: rest pose equals
   *     bind pose to 1e-6, and every animation track targets a bone, never a
   *     mesh node, so removing the mesh nodes cannot orphan a track.
   *
   * @returns {boolean} true when the asset was merged
   */
  _optimizeCharacterAsset(team, scene) {
    try {
      scene.updateMatrixWorld(true);

      // One skeleton for the whole body, or this is not the asset we know.
      let skeleton = null;
      let mixedSkeletons = false;
      scene.traverse((o) => {
        if (!o.isSkinnedMesh) return;
        if (!skeleton) skeleton = o.skeleton;
        else if (o.skeleton !== skeleton) mixedSkeletons = true;
      });
      if (!skeleton || mixedSkeletons) return false;

      this._stripAuthoredHeldWeapons(scene);

      // Never merge anything under a held-weapon seat, whether or not the strip
      // above emptied them: those meshes hang off the hand bone and baking one
      // into the body would weld a rifle to the torso for good.
      const inHeldWeapon = (object) => {
        for (let node = object; node && node !== scene; node = node.parent) {
          if (CHAR_GUN_MESH_NAMES.has(node.name)) return true;
        }
        return false;
      };
      const sources = [];
      scene.traverse((o) => { if (o.isMesh && !inHeldWeapon(o)) sources.push(o); });
      if (!sources.length) return false;

      // mergeGeometries demands one consistent attribute set, one array type per
      // attribute and index-or-no-index across the whole batch. Borrow the skin
      // attribute layout from a real skinned sub-mesh so the synthetic ones we
      // build for the rigid props match it exactly.
      const skinnedRef = sources.find((o) => o.isSkinnedMesh);
      if (!skinnedRef) return false;
      const refIndex = skinnedRef.geometry.attributes.skinIndex;
      const refWeight = skinnedRef.geometry.attributes.skinWeight;
      if (!refIndex || !refWeight) return false;
      if (sources.some((o) => !o.geometry.index)) return false;

      const groups = new Map();
      for (const src of sources) {
        const material = Array.isArray(src.material) ? src.material[0] : src.material;
        if (!material || !material.color) return false;

        const geometry = src.geometry.clone();
        for (const name of Object.keys(geometry.attributes)) {
          // uv survives because _surfaceOperativeMaterial hangs a tangent-space
          // normal map on the pack's own UVs; nothing else is sampled.
          if (!['position', 'normal', 'uv', 'skinIndex', 'skinWeight'].includes(name)) {
            geometry.deleteAttribute(name);
          }
        }
        geometry.morphAttributes = {};

        if (src.isSkinnedMesh) {
          // The merged mesh binds with an identity bindMatrix, so every source
          // vertex is pre-multiplied by its own. (This pack's are all identity;
          // the multiply is here so a re-export with a placed mesh still works.)
          geometry.applyMatrix4(src.bindMatrix);
        } else if (!this._bakeRigidProp(geometry, src, skeleton, refIndex, refWeight)) {
          return false;
        }

        const count = geometry.attributes.position.count;
        const colors = new Float32Array(count * 3);
        // material.color is already in the renderer's working (linear) space,
        // which is also how three reads a float vertex-colour attribute, so this
        // is a straight copy — no conversion, no drift.
        for (let i = 0; i < count; i++) {
          colors[i * 3] = material.color.r;
          colors[i * 3 + 1] = material.color.g;
          colors[i * 3 + 2] = material.color.b;
        }
        geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

        const key = operativeMergeKey(material);
        let group = groups.get(key);
        if (!group) { group = { material, geometries: [] }; groups.set(key, group); }
        group.geometries.push(geometry);
      }

      // Height of the whole body in the bind pose, for the culling sphere below.
      const bounds = new THREE.Box3();
      const point = new THREE.Vector3();
      for (const group of groups.values()) {
        for (const geometry of group.geometries) {
          const position = geometry.attributes.position;
          for (let i = 0; i < position.count; i++) {
            bounds.expandByPoint(point.fromBufferAttribute(position, i));
          }
        }
      }
      const bodyHeight = Math.max(1e-3, bounds.max.y - Math.min(0, bounds.min.y));

      const built = [];
      for (const [key, group] of groups) {
        const geometry = group.geometries.length === 1
          ? group.geometries[0]
          : mergeGeometries(group.geometries, false);
        if (!geometry) return false;
        geometry.computeBoundingSphere();

        const material = group.material.clone();
        material.color.setRGB(1, 1, 1);
        material.vertexColors = true;
        material.userData = Object.assign({}, material.userData, { tsBakedAlbedo: true });
        material.needsUpdate = true;

        const mesh = new THREE.SkinnedMesh(geometry, material);
        mesh.name = `operative-${key.replace(/[|:]/g, '-')}`;
        mesh.castShadow = true;
        // A soldier has to darken when it steps out of the sun, and it is the
        // key that has to leave — see _attachGLB for the measurement. Four
        // materials per team, so this costs four extra shader programs and one
        // shadow-map fetch per body fragment.
        mesh.receiveShadow = true;
        // Identity bindMatrix: every source vertex was already baked into the
        // skeleton's bind space above, and the mesh sits on the rig root with an
        // identity local transform, so bindMatrixInverse * matrixWorld cancels.
        mesh.bind(skeleton, new THREE.Matrix4());
        // An explicit, deliberately over-sized culling sphere. Bots used to run
        // with frustumCulled = false because SkinnedMesh.computeBoundingSphere()
        // measures whatever pose the renderer first asks about and then never
        // updates, which pops. A sphere of radius 1.5x the body height centred
        // at half height covers every clip in the pack — including Death, which
        // lays the body flat about one body-height from the root — so it can
        // never pop, and a soldier behind the camera stops costing a draw call.
        mesh.boundingSphere = new THREE.Sphere(
          new THREE.Vector3(0, bodyHeight * 0.5, 0),
          bodyHeight * 1.5
        );
        mesh.frustumCulled = true;
        scene.add(mesh);
        built.push(mesh);
      }

      // Drop the source sub-meshes. Their parent groups/bones stay: animation
      // tracks address bones by name and removing a named node would orphan one.
      for (const src of sources) {
        if (src.parent) src.parent.remove(src);
        src.geometry.dispose();
      }
      return built.length > 0;
    } catch (e) {
      console.warn(`[bots] ${team} operative merge skipped; drawing the pack as authored`, e);
      return false;
    }
  }

  /**
   * Re-express a bone-parented rigid prop as skinned geometry with weight 1.0.
   *
   * A vertex rendered rigidly sits at `bone.matrixWorld * L * p`; the same
   * vertex skinned at full weight sits at `bone.matrixWorld * boneInverse * p'`.
   * Equating the two gives p' = inverse(boneInverse) * bone.matrixWorld^-1 *
   * mesh.matrixWorld * p, which is pose-independent — it holds on every frame of
   * every clip, not just the bind pose.
   */
  _bakeRigidProp(geometry, mesh, skeleton, refIndex, refWeight) {
    let bone = mesh.parent;
    while (bone && !bone.isBone) bone = bone.parent;
    const boneIndex = bone ? skeleton.bones.indexOf(bone) : -1;
    if (boneIndex < 0) return false;

    const toBindSpace = new THREE.Matrix4()
      .copy(skeleton.boneInverses[boneIndex]).invert()
      .multiply(new THREE.Matrix4().copy(bone.matrixWorld).invert())
      .multiply(mesh.matrixWorld);
    geometry.applyMatrix4(toBindSpace);

    const count = geometry.attributes.position.count;
    const IndexArray = refIndex.array.constructor;
    const WeightArray = refWeight.array.constructor;
    const indices = new IndexArray(count * refIndex.itemSize);
    const weights = new WeightArray(count * refWeight.itemSize);
    for (let i = 0; i < count; i++) {
      indices[i * refIndex.itemSize] = boneIndex;
      weights[i * refWeight.itemSize] = 1;
    }
    geometry.setAttribute('skinIndex',
      new THREE.BufferAttribute(indices, refIndex.itemSize, refIndex.normalized));
    geometry.setAttribute('skinWeight',
      new THREE.BufferAttribute(weights, refWeight.itemSize, refWeight.normalized));
    return true;
  }

  /**
   * Empty the pack's four held-weapon seats.
   *
   * They ship as 14 meshes and ~9k triangles per soldier that nothing ever
   * shows — `_attachHeldWeapon` puts the real procedurally modelled gun on the
   * same bone instead. The SEAT NODES stay: their authored position and
   * orientation on Index1R is what the real weapon inherits, and `gunMeshes`
   * still resolves through them.
   */
  _stripAuthoredHeldWeapons(scene) {
    // Every weapon a bot can carry has a procedural model, so the authored
    // meshes are unreachable as a fallback. game.materials (src/main.js:127)
    // exists before this class is constructed, hence before any GLB lands.
    if (!this.game || !this.game.materials) return 0;
    for (const id of Object.keys(CHAR_GUN_MESH)) {
      if (!hasWeaponModel(id)) return 0;
    }
    const seats = [];
    scene.traverse((o) => { if (CHAR_GUN_MESH_NAMES.has(o.name)) seats.push(o); });
    let stripped = 0;
    for (const seat of seats) {
      for (const child of [...seat.children]) {
        child.traverse((n) => { if (n.isMesh) { n.geometry.dispose(); stripped++; } });
        seat.remove(child);
      }
    }
    return stripped;
  }

  _characterAssetFor(team) {
    if (this._charAssets[team]) return { team, asset: this._charAssets[team] };
    const fallbackTeam = team === 'ct' ? 't' : 'ct';
    return this._charAssets[fallbackTeam]
      ? { team: fallbackTeam, asset: this._charAssets[fallbackTeam] }
      : null;
  }

  _refreshCharacterVisuals() {
    const actors = [...(this.all || []), ...(this._externalActors || [])];
    for (const actor of actors) {
      const source = this._characterAssetFor(actor.team);
      if (!source) continue;
      if (actor.rig && actor.visualAssetTeam !== source.team) this._disposeOperativeRig(actor);
      this._attachGLB(actor);
    }
  }

  _attachGLB(bot) {
    const source = this._characterAssetFor(bot.team);
    if (!source || !bot.mesh || bot.rig) return;
    const { asset } = source;

    while (bot.mesh.children.length) bot.mesh.remove(bot.mesh.children[0]);
    bot.parts = null; // disables every primitive-body animation path

    const inst = cloneSkeleton(asset.scene);
    inst.scale.setScalar(CHAR_TARGET_HEIGHT / CHAR_MODELS[source.team].bodyHeight);
    inst.rotation.y = Math.PI; // pack characters face +Z; the game rig faces -Z
    bot.gunMeshes = {};
    bot.ownedVisualMaterials = new Set();
    const materialClones = new Map();
    const belongsToHeldWeapon = (object) => {
      for (let node = object; node && node !== inst; node = node.parent) {
        if (CHAR_GUN_MESH_NAMES.has(node.name)) return true;
      }
      return false;
    };
    const skinnedMeshes = [];
    inst.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        /**
         * THE BODY RECEIVES SHADOWS. The single largest reason the operatives did
         * not look lit by the scene: with this false the key light reached them
         * whatever they were standing behind.
         *
         * MEASURED on Dustyard (tools/MEASURING.md), a CT stood at (-18, -27)
         * where a raycast to the sun is blocked, camera 3.4 m away at chest
         * height, torso-band median against the shaded wall beside it at 50.8:
         *
         *                       torso   with the key at 0   key's share   vs wall
         *   receiveShadow off   120.9        70.6              42%          2.38x
         *   receiveShadow on     71.9        71.9               0%          1.40x
         *
         * A soldier in geometric shade was taking 42% of its light from a sun it
         * could not see, and came out BRIGHTER (120.9) than the same soldier in
         * full sun (113.5). With this on it lands at 1.02x the surface directly
         * behind it. Held weapons stay off: their materials come from the forge
         * and are shared with the first-person viewmodel, and three keys shader
         * programs on receiveShadow, so flipping them here would compile a second
         * copy of the heaviest shaders in the game for a 40-pixel bot rifle.
         */
        o.receiveShadow = !belongsToHeldWeapon(o);
        // A merged body carries an explicit, over-sized culling sphere from
        // _optimizeCharacterAsset, so it can be culled without popping. Anything
        // else falls back to the old rule: three's skinned bounds lag the pose.
        o.frustumCulled = !!o.boundingSphere;
        if (o.isSkinnedMesh) skinnedMeshes.push(o);
        // SkeletonUtils intentionally shares geometry and authored materials.
        // Clone only body materials that this player's preset will tint; held
        // weapons retain their authored colors and remain shared/read-only.
        if (bot.visualPalette && !belongsToHeldWeapon(o)) {
          const cloneMaterial = (material) => {
            if (!material) return material;
            if (!materialClones.has(material)) materialClones.set(material, material.clone());
            return materialClones.get(material);
          };
          o.material = Array.isArray(o.material)
            ? o.material.map(cloneMaterial)
            : cloneMaterial(o.material);
        }
      }
      if (CHAR_GUN_MESH_NAMES.has(o.name)) bot.gunMeshes[o.name] = o;
    });
    for (const material of materialClones.values()) bot.ownedVisualMaterials.add(material);

    // SkeletonUtils.clone() hands every SkinnedMesh its own cloned Skeleton, and
    // the renderer walks 43 bones plus a bone-texture upload per distinct
    // Skeleton per frame (WebGLRenderer dedupes by Skeleton object, not by bone
    // list). The merged body's four meshes are one rig, so collapse them onto one
    // skeleton: 60 skeleton updates a frame across the roster becomes 9.
    if (asset.sharedSkeleton && skinnedMeshes.length > 1) {
      const shared = skinnedMeshes[0].skeleton;
      for (let i = 1; i < skinnedMeshes.length; i++) {
        skinnedMeshes[i].bind(shared, skinnedMeshes[i].bindMatrix);
      }
    }

    bot.rig = inst;
    bot.visualAssetTeam = source.team;
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
    this._tintOperativeMaterials(bot);
    // AI bots carry no palette, so _tintOperativeMaterials returns at its first
    // line for them and the surface response never used to run at all: every
    // soldier in a solo match was drawn at the pack's authored roughness 0.5 with
    // no normal map and no AO. The response is not a palette feature.
    this._surfaceOperativeRig(bot);
    this._setBotAction(bot, 'Idle', 0);
    bot.mesh.add(inst);
    // AFTER the rig is in the graph, and with world matrices current: the seat's
    // scale compensation reads the hand bone's WORLD scale, and reading it before
    // the rig root's 0.857 had propagated left every bot weapon 14 % undersized.
    bot.mesh.updateMatrixWorld(true);
    this._applyGunLook(bot);

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

  _tintOperativeMaterials(actor) {
    const palette = actor && actor.visualPalette;
    if (!palette || !actor.rig) return;
    // A merged material is shared by every operative on its team, so repainting
    // one that this actor does not own would recolour the whole side. _attachGLB
    // already clones when a palette is present; this covers the path where a
    // palette arrives after the rig was built.
    this._ensureOwnedVisualMaterials(actor);
    actor.rig.traverse((object) => {
      if (!object.isMesh) return;
      for (let node = object; node && node !== actor.rig; node = node.parent) {
        if (CHAR_GUN_MESH_NAMES.has(node.name)) return;
      }
      for (const material of (Array.isArray(object.material) ? object.material : [object.material])) {
        if (!material || !material.color) continue;
        const name = String(material.name || '').toLowerCase();
        let tint;
        if (name === 'skin') tint = palette.skin;
        else if (name === 'character_main' || name === 'enemy_red') tint = palette.uniform;
        else if (name === 'pants' || name === 'grey') tint = palette.sleeve || palette.dark;
        else if (name === 'darkgrey' || name === 'black') tint = palette.dark;
        if (tint !== undefined) {
          material.color.set(tint);
          // A merged body carries the pack's authored albedo per vertex so one
          // draw call can cover several source materials. A palette replaces that
          // albedo outright — exactly as it did before the merge — so the baked
          // attribute has to stop multiplying into the flat colour.
          if (material.userData.tsBakedAlbedo && material.vertexColors) {
            material.vertexColors = false;
            material.needsUpdate = true;
          }
        }
        this._surfaceOperativeMaterial(material, name);
      }
    });
  }

  /** Give a palette-carrying actor its own copy of every body material. */
  _ensureOwnedVisualMaterials(actor) {
    if (!actor.rig) return;
    if (!actor.ownedVisualMaterials) actor.ownedVisualMaterials = new Set();
    const owned = actor.ownedVisualMaterials;
    const clones = new Map();
    actor.rig.traverse((object) => {
      if (!object.isMesh) return;
      for (let node = object; node && node !== actor.rig; node = node.parent) {
        if (CHAR_GUN_MESH_NAMES.has(node.name)) return; // held weapons stay shared
      }
      const own = (material) => {
        if (!material || owned.has(material)) return material;
        if (!clones.has(material)) {
          const copy = material.clone();
          clones.set(material, copy);
          owned.add(copy);
        }
        return clones.get(material);
      };
      object.material = Array.isArray(object.material)
        ? object.material.map(own)
        : own(object.material);
    });
  }

  /**
   * Every body material on a rig, palette or no palette. Held weapons are left
   * alone: their materials come from the forge, which already surfaces them and
   * already reads the AO buffer, so patching one here would apply the term twice.
   */
  _surfaceOperativeRig(actor) {
    if (!actor || !actor.rig) return;
    actor.rig.traverse((object) => {
      if (!object.isMesh) return;
      for (let node = object; node && node !== actor.rig; node = node.parent) {
        if (CHAR_GUN_MESH_NAMES.has(node.name)) return;
      }
      for (const material of (Array.isArray(object.material) ? object.material : [object.material])) {
        if (!material || !material.color) continue;
        this._surfaceOperativeMaterial(material, String(material.name || '').toLowerCase());
      }
    });
  }

  /**
   * Give the character pack's flat materials a surface response.
   *
   * The soldiers ship as a toon kit: unlit-looking albedo, roughness 1, no
   * normal map, so beside procedurally modelled weapons and PBR architecture
   * they read as vinyl toys. The albedo stays exactly where the player's
   * palette puts it — that is their identity — but everything about how the
   * light comes back changes: cloth gets a real weave normal borrowed from the
   * material library and a high roughness, webbing and boots get a rubbery
   * sheen, skin gets the slight forward scatter that keeps a face from looking
   * like painted plastic.
   *
   * The library's `fabric` normal map is tangent-space, so it applies fine to
   * the pack's own UVs even though the library's albedo is world-projected and
   * would not.
   */
  _surfaceOperativeMaterial(material, name) {
    const skin = name === 'skin';
    const hard = name === 'darkgrey' || name === 'black';

    if (!material.userData.tsSurfaced) {
      material.userData.tsSurfaced = true;
      const lib = this.game && this.game.materials;

      material.roughness = skin ? 0.68 : hard ? 0.52 : 0.94;
      material.metalness = 0;
      // A no-op while these materials have no envMap of their own: three's
      // WebGLRenderer overwrites the uniform with scene.environmentIntensity for
      // anything lit by scene.environment alone (see world/map.js, where 0.42 is
      // set and why). MEASURED — 1.0 vs 0.0 on a sunlit CT moved the skin median
      // from 171.0 to 171.2, i.e. nothing. Kept as the value a character probe
      // would want if one ever gets its own.
      material.envMapIntensity = 0.85;
      if (material.emissive) material.emissive.setRGB(0, 0, 0);

      if (!skin && lib && typeof lib.getTextureSet === 'function') {
        const set = lib.getTextureSet(hard ? 'rubber' : 'fabric');
        if (set && set.normal) {
          // Shared with the world's own materials — read it, never retune it.
          material.normalMap = set.normal;
          // Half strength: the pack's UVs were laid out for flat colour, so the
          // weave lands coarser on a character than it does on a wall. At full
          // amplitude it reads as quilting; at 0.55 it reads as cloth.
          material.normalScale.set(0.55, 0.55);
        }
      }
      material.needsUpdate = true;
    }

    /**
     * THE SCREEN-SPACE AO TERM. Without it the soldiers were the only opaque
     * thing in the frame whose ambient was unoccluded — every wall, floor and
     * prop gets it inside the forge's shader, and a plain MeshStandardMaterial
     * never reads owSsaoTex. Ambient is most of a soldier's light (measured: a
     * sunlit CT torso reads 114, and 71.8 with the key at zero — 63% indirect),
     * so this is the term that was overfeeding them on the dark maps, where the
     * key is nearly all that is missing anyway.
     *
     * Guarded on the material's own uuid, not a boolean: Material.clone() deep
     * copies userData but does NOT copy onBeforeCompile, so a per-player clone
     * made by _ensureOwnedVisualMaterials arrives carrying `tsSurfaced` with an
     * unpatched shader. A uuid that does not match means "this is a clone" and
     * the patch is reapplied.
     */
    // isMeshStandardMaterial covers Standard and Physical, which are the only two
    // three shaders that declare `vViewPosition` unconditionally AND include
    // <aomap_fragment>. Both snippets need both, and a glTF import is always one
    // of the two — but a body material that somehow was not would fail to
    // COMPILE rather than look wrong, so the guard is worth its one line.
    if (material.isMeshStandardMaterial && material.userData.tsAoPatched !== material.uuid) {
      material.userData.tsAoPatched = material.uuid;
      material.onBeforeCompile = (shader) => {
        // By reference: ssao.js rewrites .value every frame for every consumer.
        shader.uniforms.owSsaoTex = ssaoUniforms.owSsaoTex;
        shader.uniforms.owSsaoP = ssaoUniforms.owSsaoP;
        shader.uniforms.owSsaoD = ssaoUniforms.owSsaoD;
        shader.fragmentShader = shader.fragmentShader
          .replace('void main() {', `${SSAO_PARS_FRAGMENT}\nvoid main() {`)
          .replace('#include <aomap_fragment>', `#include <aomap_fragment>${OPERATIVE_AO_APPLY}`);
      };
      // onBeforeCompile is invisible to three's program cache. Without a cache
      // key of its own, a patched material and an unpatched MeshStandardMaterial
      // with identical parameters would share one program — whichever compiled
      // first, silently.
      material.customProgramCacheKey = () => 'operative-ssao';
      material.needsUpdate = true;
    }
  }

  _disposeOperativeRig(actor) {
    if (!actor) return;
    if (actor.mixer) {
      actor.mixer.stopAllAction();
      if (actor.rig) actor.mixer.uncacheRoot(actor.rig);
    }
    if (actor.rig && actor.mesh) actor.mesh.remove(actor.rig);
    for (const material of (actor.ownedVisualMaterials || [])) material.dispose();
    actor.ownedVisualMaterials = null;
    // The held weapon lives on the OLD rig's hand bone, so it leaves with the
    // rig. Forgetting it here made _attachHeldWeapon's "already holding this"
    // early-out fire on the new rig and every CT bot walked the map empty-handed:
    // both soldier GLBs load asynchronously, so whichever arrives second sees its
    // bots swap off the other team's fallback rig, taking their guns with them.
    // Geometry and materials belong to the shared weapon template — never dispose.
    if (actor.heldWeapon) {
      actor.heldWeapon.parent?.remove(actor.heldWeapon);
      actor.heldWeapon = null;
      actor.heldWeaponId = null;
    }
    actor.rig = null;
    actor.visualAssetTeam = null;
    actor.mixer = null;
    actor.actions = {};
    actor.actionName = null;
    actor.gunMeshes = {};
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
    // GLB body: the character pack ships four crude held weapons on the index
    // finger bone. We keep the SEAT — its bone, its position, its orientation —
    // and swap in the same procedurally modelled weapon the player is holding,
    // so what a soldier carries across the map is the real thing at real scale.
    if (bot.gunMeshes) {
      const want = CHAR_GUN_MESH[bot.weaponId] || null;
      const attached = this._attachHeldWeapon(bot, want);
      for (const name in bot.gunMeshes) {
        bot.gunMeshes[name].visible = !attached && name === want;
      }
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

  /**
   * Put the real weapon in the soldier's hand.
   *
   * The seat comes from the character pack's own held-weapon group: it is
   * parented to the index-finger bone with an artist-authored position and
   * orientation that already works in every animation clip, so we reuse both
   * and only correct for the two things that differ.
   *
   *   axis   the pack's weapons point down their local +X (the SMG down -X);
   *          ours point down -Z. FAMILY_AXIS_FIX is that quarter turn.
   *   scale  the character is scaled to 1.8 m, which scales anything parented
   *          into its skeleton with it. Our weapons are modelled at true size,
   *          so the local scale cancels the bone's world scale exactly — an
   *          880 mm AK stays 880 mm in the world.
   *
   * @returns {boolean} true if a procedural weapon is now in the hand
   */
  _attachHeldWeapon(bot, family) {
    const library = this.game && this.game.materials;
    const anchor = family && bot.gunMeshes ? bot.gunMeshes[family] : null;
    if (!library || !anchor || !anchor.parent) return false;
    if (!hasWeaponModel(bot.weaponId)) return false;

    if (bot.heldWeaponId === bot.weaponId && bot.heldWeapon) return true;
    if (bot.heldWeapon) {
      bot.heldWeapon.parent?.remove(bot.heldWeapon);
      bot.heldWeapon = null;
      bot.heldWeaponId = null;
    }

    const weapon = weaponInstance(bot.weaponId, library, { viewmodel: false });
    if (!weapon) return false;

    anchor.parent.updateMatrixWorld(true);
    _gunScale.setFromMatrixScale(anchor.parent.matrixWorld);
    const inv = 1 / Math.max(1e-6, _gunScale.x);

    weapon.position.copy(anchor.position);
    weapon.quaternion.copy(anchor.quaternion).multiply(FAMILY_AXIS_FIX[family] ?? FAMILY_AXIS_FIX.AK);
    weapon.scale.setScalar(inv);
    weapon.name = `held:${bot.weaponId}`;
    anchor.parent.add(weapon);

    bot.heldWeapon = weapon;
    bot.heldWeaponId = bot.weaponId;
    return true;
  }

  _respawnBot(bot, spawn, round) {
    bot.health = this._cfg.HEALTH;
    bot.alive = true;
    bot.velY = 0;
    bot.onGround = true;
    bot.blindUntil = 0;
    bot.blindSpray = false;
    bot.state = 'idle';
    bot.postPlantRole = null;
    bot.path = null;
    bot.hasGoal = false;
    bot.routeQueue.length = 0;
    bot.routeActive = false;
    bot.routeName = null;
    bot.patrolArea = null;
    bot.patrolPoints = null;
    bot.anchorReached = false;
    bot.destinationHistory.length = 0;
    bot.decisionSeq = round * 31 + bot.slot * 7;
    bot.repathTimer = 0;
    bot.repathCooldown = 0;
    bot.navSampleTimer = 0;
    bot.navSamplePathIndex = -1;
    bot.navSampleDistance = Infinity;
    bot.navSamplePos.set(0, 0, 0);
    bot.stuckTime = 0;
    bot.blockedTime = 0;
    bot.recoveryUntil = 0;
    bot.recoveryDir.set(0, 0, 0);
    bot.recoveryCount = 0;
    bot.avoidSide = bot.formationSide || 1;
    bot.avoidUntil = 0;
    bot.holdTimer = rand(0.5, 2);
    bot.scanTimer = rand(0.4, 1.4);
    bot.target = null;
    bot.targetBot = null;
    bot.targetIsPlayer = false;
    bot.targetHuman = null;
    bot.targetVisible = false;
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
    // Navigation progress is measured from the actual new spawn.  Sampling
    // before this assignment made a round-to-round teleport look like useful
    // path progress and delayed stuck recovery.
    bot.navSamplePos.copy(bot.pos);
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
      this._clearRoute(best);
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
      this._hearSound(p.origin, (this.game.player && this.game.player.team) || 'ct', this._cfg.HEAR_RANGE * 1.6);
    });

    ev.on('bot:fire', (p) => {
      if (!p || !p.bot || !p.origin) return;
      this._hearSound(p.origin, p.bot.team, this._cfg.HEAR_RANGE * 1.5, p.bot);
    });

    ev.on('player:footstep', (p) => {
      if (!p || !p.pos || p.walking) return; // sneaking is quiet
      this._hearSound(p.pos, (this.game.player && this.game.player.team) || 'ct', this._cfg.HEAR_RANGE);
    });

    ev.on('bot:footstep', (p) => {
      if (!p || !p.pos || !p.bot) return;
      this._hearSound(p.pos, p.bot.team, this._cfg.HEAR_RANGE, p.bot);
    });

    ev.on('fx:explosion', (p) => {
      if (!p || !p.pos) return;
      this._hearSound(p.pos, null, this._cfg.HEAR_RANGE * 2.5);
    });

    ev.on('bomb:planted', (p) => {
      this._bombPlanted = true;
      if (p && p.pos) this._bombPos.copy(p.pos);
      // Every CT initially rotates with defuse urgency. As soon as one starts
      // the stick, the others become perimeter holders in _thinkCT.
      for (const bot of this.all) {
        if (bot.team !== 'ct' || !bot.alive) continue;
        bot.postPlantRole = 'defuse';
        bot.repathTimer = 0;
      }
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

    const mp = this.game.multiplayer;
    if (mp && mp.active && !mp.isAuthority()) {
      const blend = 1 - Math.exp(-18 * dt);
      for (const b of this.all) {
        if (b.netPos) b.pos.lerp(b.netPos, blend);
        if (Number.isFinite(b.netYaw)) b.yaw += angleDiff(b.netYaw, b.yaw) * blend;
        if (Number.isFinite(b.netAimPitch)) b.aimPitch += (b.netAimPitch - b.aimPitch) * blend;
        if (!b.alive) this._animateDeath(b, dt);
        else this._animateBot(b, dt);
      }
      return;
    }

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
        if (bot.strafeDir === 0) {
          // A feint used to negate zero forever, leaving the bot rooted for the
          // rest of the duel. Resume on its stable formation side instead.
          bot.strafeDir = bot.formationSide || 1;
          bot.strafeTimer = rand(0.45, 0.75);
        } else if (Math.random() < 0.18) {
          bot.strafeDir = 0;
          bot.strafeTimer = rand(0.18, 0.32);
        } else {
          bot.strafeDir = -bot.strafeDir;
          bot.strafeTimer = rand(0.6, 1.1);
        }
      }
      // Once line-of-sight breaks, move relative to the frozen memory instead
      // of tracking the opponent's live position through a wall.
      const tp = bot.targetVisible === false
        ? _v3.copy(bot.lastSeenPos)
        : this._targetPos(bot, _v3);
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
    } else if (!stationary && bot.path && bot.pathIndex < bot.path.length &&
               bot.recoveryUntil > this.time && bot.recoveryDir.lengthSq() > 0.01) {
      // A short, deliberate lateral move gets the capsule off a corner before
      // following/rebuilding the route. Team avoidance is suppressed during
      // this window so another bot cannot immediately steer it back.
      _delta.copy(bot.recoveryDir);
      wantSpeed = WALK_SPEED;
    } else if (!stationary && bot.path && bot.pathIndex < bot.path.length) {
      // Follow the current path.
      let node = bot.path[bot.pathIndex];
      _v1.set(node.x - bot.pos.x, 0, node.z - bot.pos.z);
      let d2 = _v1.lengthSq();
      let yGap = Math.abs(node.y - bot.pos.y);
      while (d2 < NODE_REACH * NODE_REACH && yGap < 0.9 &&
             bot.pathIndex < bot.path.length - 1) {
        bot.pathIndex++;
        node = bot.path[bot.pathIndex];
        _v1.set(node.x - bot.pos.x, 0, node.z - bot.pos.z);
        d2 = _v1.lengthSq();
        yGap = Math.abs(node.y - bot.pos.y);
      }
      if (d2 <= NODE_REACH * NODE_REACH && yGap < 0.9 &&
          bot.pathIndex >= bot.path.length - 1) {
        bot.path = null; // arrived
        bot.hasGoal = false;
      } else if (d2 > 0.0001) {
        _v1.normalize();
        wantSpeed = bot.sneak ? WALK_SPEED : this._cfg.RUN_SPEED;
        _delta.copy(_v1);
      } else if (yGap >= 0.9) {
        // A node directly above/below the capsule cannot be reached by walking
        // horizontally. Keep the navigation request visible to the progress
        // watchdog (with a zero step) so it recovers instead of deadlocking.
        wantSpeed = WALK_SPEED;
      }
    }

    // Blindness outside a fight: stumble slowly instead of running lanes.
    if (blind && bot.state !== 'engage' && wantSpeed > 0) wantSpeed *= 0.3;

    // Local separation plus queue spacing. Distinct tactical routes do most of
    // the team spreading; this prevents bots that temporarily share a choke
    // from occupying the same capsule or running shoulder-to-shoulder forever.
    if (wantSpeed > 0 && this.time >= bot.avoidUntil) {
      const travelX = _delta.x;
      const travelZ = _delta.z;
      let speedScale = 1;
      for (let i = 0; i < this.all.length; i++) {
        const o = this.all[i];
        if (o === bot || !o.alive) continue;
        if (Math.abs(bot.pos.y - o.pos.y) > 1.25) continue; // catwalk vs ground
        const dx = bot.pos.x - o.pos.x, dz = bot.pos.z - o.pos.z;
        const d2 = dx * dx + dz * dz;
        const teammate = o.team === bot.team;
        const separation = teammate ? TEAM_SEPARATION : 1.0;
        if (d2 > 0.0001 && d2 < separation * separation) {
          const d = Math.sqrt(d2);
          // Route assignments do the spreading. A restrained radial correction
          // avoids overlaps without producing a left-right slalom in doorways.
          const push = (separation - d) / separation * (teammate ? 0.62 : 0.5);
          _delta.x += (dx / d) * push;
          _delta.z += (dz / d) * push;
        } else if (teammate && d2 <= 0.0001) {
          // Deterministic escape direction if network correction stacks two bots.
          _delta.x += -travelZ * bot.formationSide;
          _delta.z += travelX * bot.formationSide;
        }

        if (teammate && bot.state !== 'engage' && d2 > 0.0001) {
          const ahead = (-dx) * travelX + (-dz) * travelZ;
          const lateral = Math.abs((-dx) * -travelZ + (-dz) * travelX);
          if (ahead > 0.15 && ahead < TEAM_QUEUE_DISTANCE && lateral < 1.05) {
            const gapScale = Math.max(0.28, Math.min(1,
              (ahead - 0.65) / (TEAM_QUEUE_DISTANCE - 0.65)));
            speedScale = Math.min(speedScale, gapScale);
          }
        }
      }
      wantSpeed *= speedScale;
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
    _moveStart.copy(bot.pos);

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

    const actualX = bot.pos.x - _moveStart.x;
    const actualZ = bot.pos.z - _moveStart.z;
    const actualTravel = Math.sqrt(actualX * actualX + actualZ * actualZ);
    // Animation, footsteps and weapon accuracy must describe what collision
    // actually allowed, not the velocity the brain requested.
    bot.moveSpeed = actualTravel / Math.max(dt, 1e-5);
    bot.height = bot.crouching ? this._cfg.HEIGHT * 0.7 : this._cfg.HEIGHT;
    this._updateNavigationProgress(bot, dt, wantSpeed, actualTravel);

    // Footsteps while moving fast on the ground.
    if (bot.onGround && bot.moveSpeed > 2.6) {
      bot.footAccum += bot.moveSpeed * dt;
      if (bot.footAccum >= FOOTSTEP_DIST) {
        bot.footAccum -= FOOTSTEP_DIST;
        this.game.events.emit('bot:footstep', {
          bot,
          team: bot.team,
          pos: bot.pos.clone(),
        });
      }
    } else if (bot.moveSpeed < 0.5) {
      bot.footAccum = 0;
    }
  }

  _navigationDistance(bot) {
    if (!bot.path || bot.pathIndex >= bot.path.length) return Infinity;
    const node = bot.path[bot.pathIndex];
    const dx = node.x - bot.pos.x;
    const dz = node.z - bot.pos.z;
    const dy = (node.y - bot.pos.y) * 0.6;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  _resetNavigationSample(bot) {
    bot.navSampleTimer = NAV_SAMPLE_INTERVAL;
    bot.navSamplePathIndex = bot.path ? bot.pathIndex : -1;
    bot.navSampleDistance = this._navigationDistance(bot);
    bot.navSamplePos.copy(bot.pos);
    bot.blockedTime = 0;
    bot.stuckTime = 0;
  }

  _updateNavigationProgress(bot, dt, wantSpeed, actualTravel) {
    const navigating = bot.state !== 'engage' && bot.path &&
      bot.pathIndex < bot.path.length && wantSpeed > 0.75;
    if (!navigating) {
      bot.blockedTime = 0;
      bot.stuckTime = Math.max(0, bot.stuckTime - dt * 2);
      bot.navSampleTimer = 0;
      bot.navSamplePathIndex = -1;
      bot.navSamplePos.copy(bot.pos);
      return;
    }

    const requestedTravel = wantSpeed * dt;
    const blockedThreshold = Math.min(0.012, Math.max(0.002, requestedTravel * 0.18));
    if (actualTravel < blockedThreshold) bot.blockedTime += dt;
    else bot.blockedTime = Math.max(0, bot.blockedTime - dt * 1.5);

    const currentDistance = this._navigationDistance(bot);
    if (bot.navSamplePathIndex !== bot.pathIndex ||
        !Number.isFinite(bot.navSampleDistance)) {
      this._resetNavigationSample(bot);
      return;
    }

    bot.navSampleTimer -= dt;
    if (bot.navSampleTimer <= 0) {
      const dx = bot.pos.x - bot.navSamplePos.x;
      const dz = bot.pos.z - bot.navSamplePos.z;
      const travelled = Math.sqrt(dx * dx + dz * dz);
      const progress = bot.navSampleDistance - currentDistance;
      if (travelled < NAV_MIN_TRAVEL || progress < NAV_MIN_PROGRESS) {
        bot.stuckTime += NAV_SAMPLE_INTERVAL;
      } else {
        bot.stuckTime = Math.max(0, bot.stuckTime - NAV_SAMPLE_INTERVAL * 2);
      }
      bot.navSampleTimer += NAV_SAMPLE_INTERVAL;
      bot.navSampleDistance = currentDistance;
      bot.navSamplePos.copy(bot.pos);
    }

    if (bot.blockedTime >= NAV_BLOCKED_TIME || bot.stuckTime >= NAV_STUCK_TIME) {
      this._recoverNavigation(bot);
    }
  }

  _recoverNavigation(bot) {
    if (!bot.path || bot.pathIndex >= bot.path.length) return;

    // First failure: make one short, collision-probed sidestep. This is enough
    // for a capsule caught on a crate corner, and avoids a visually noisy
    // sequence of alternating random turns.
    if (bot.recoveryCount === 0) {
      const node = bot.path[bot.pathIndex];
      _v1.set(node.x - bot.pos.x, 0, node.z - bot.pos.z);
      if (_v1.lengthSq() < 0.001) _v1.set(-Math.sin(bot.yaw), 0, -Math.cos(bot.yaw));
      else _v1.normalize();
      _navLeft.set(-_v1.z, 0, _v1.x);
      _navRight.copy(_navLeft).multiplyScalar(-1);

      const world = this.game.world;
      const height = bot.crouching ? this._cfg.HEIGHT * 0.7 : this._cfg.HEIGHT;
      const clearance = (dir) => {
        if (!world || typeof world.resolveMovement !== 'function') return 1;
        _v4.copy(dir).multiplyScalar(0.85);
        const res = world.resolveMovement(bot.pos, _v4, bot.radius, height);
        if (!res || !res.pos) return 0;
        const dx = res.pos.x - bot.pos.x;
        const dz = res.pos.z - bot.pos.z;
        return dx * dx + dz * dz;
      };
      const leftClear = clearance(_navLeft);
      const rightClear = clearance(_navRight);
      const preferred = bot.avoidSide < 0 ? _navLeft : _navRight;
      const alternate = preferred === _navLeft ? _navRight : _navLeft;
      const preferredClear = preferred === _navLeft ? leftClear : rightClear;
      const alternateClear = preferred === _navLeft ? rightClear : leftClear;

      if (Math.max(preferredClear, alternateClear) > 0.025) {
        bot.recoveryDir.copy(alternateClear > preferredClear + 0.02 ? alternate : preferred);
        bot.avoidSide *= -1;
        bot.recoveryUntil = this.time + NAV_RECOVERY_TIME;
        bot.avoidUntil = bot.recoveryUntil + 0.2;
        bot.recoveryCount = 1;
        bot.repathCooldown = bot.recoveryUntil;
        this._resetNavigationSample(bot);
        return;
      }
      // Neither side is open; skip directly to the route rebuild.
      bot.recoveryCount = 1;
    }

    // Second failure: rebuild from the bot's real post-collision position.
    if (bot.recoveryCount === 1 && this.time >= bot.repathCooldown) {
      _v5.copy(bot.goal);
      bot.recoveryCount = 2;
      bot.recoveryUntil = 0;
      bot.repathCooldown = this.time + NAV_REPATH_COOLDOWN;
      this._setGoal(bot, _v5, { force: true });
      bot.recoveryCount = 2; // same-goal repaths deliberately retain the stage
      this._resetNavigationSample(bot);
      return;
    }

    if (bot.recoveryCount === 1) {
      this._resetNavigationSample(bot);
      return;
    }

    // A route that still makes no progress after sidestep + repath is not a
    // useful tactical order. Drop it and hold instead of running at geometry
    // forever; the team brain will select the next authored post afterwards.
    this._abandonNavigationGoal(bot);
  }

  _abandonNavigationGoal(bot) {
    bot.path = null;
    bot.hasGoal = false;
    bot.pathIndex = 0;
    bot.recoveryUntil = 0;
    bot.recoveryDir.set(0, 0, 0);
    bot.recoveryCount = 0;
    bot.repathCooldown = this.time + NAV_REPATH_COOLDOWN;
    this._resetNavigationSample(bot);

    // Do not retry one unreachable defender anchor forever. Patrol points in
    // the same authored sector remain available after this shorter reset hold.
    if (bot.team === 'ct' && !bot.anchorReached) bot.anchorReached = true;
    bot.state = 'hold';
    bot.holdTimer = bot.team === 'ct' ? rand(3.5, 5.5) : rand(1.8, 3.2);
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
    const tp = bot.targetVisible === false
      ? _v3.copy(bot.lastSeenPos)
      : this._targetPos(bot, _v3);
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
    const seen = bot.targetVisible && this.time - bot.lastSeenTime < 0.35;
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
      const pl = bot.targetHuman || this.game.player;
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
        ? !(bot.targetHuman && bot.targetHuman.alive)
        : !(bot.targetBot && bot.targetBot.alive);
      if (targetGone) {
        bot.target = null;
        bot.targetBot = null;
        bot.targetIsPlayer = false;
        bot.targetHuman = null;
        bot.targetVisible = false;
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
      bot.targetVisible = this._canSee(
        bot,
        bot.targetIsPlayer ? bot.targetHuman : bot.targetBot,
        bot.targetIsPlayer
      );
      if (bot.targetVisible) {
        bot.lastSeenTime = this.time;
        this._targetPos(bot, bot.lastSeenPos);
      } else if (this.time - bot.lastSeenTime > LOSE_TARGET_TIME) {
        // Lost them — push toward their last known spot.
        bot.target = null;
        bot.targetBot = null;
        bot.targetIsPlayer = false;
        bot.targetHuman = null;
        bot.targetVisible = false;
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

    // Fresh enemy noise is a reason to leave a post; ordinary patrol timing is
    // not. Consume it before issuing another routine tactical destination.
    if (this.time - bot.heardTime < 3 &&
        bot.state !== 'plant' && bot.state !== 'defuse' &&
        bot.state !== 'investigate' &&
        !this._bombPlanted &&
        !(bot.plan === 'retrieve' && this._bombDropped) &&
        bot !== this.bombCarrier) {
      // Make the 60% reaction decision once. Leaving heardTime fresh on a miss
      // retried the roll ten times per second and made every sound effectively
      // mandatory, pulling whole teams onto the same coordinate.
      bot.heardTime = -99;
      if (Math.random() < 0.6) {
        bot.state = 'investigate';
        this._setGoal(bot, bot.heardPos);
        return;
      }
    }

    // Resolve arrival before team logic gets a chance to hand out a new goal.
    // Previously CT/T thinkers ran first, so this branch was practically
    // unreachable and bots bounced between two or three points without ever
    // watching an angle. Attack routes are the exception: intermediate lane
    // nodes should flow directly into the next authored node.
    const arrived = (bot.state === 'move' || bot.state === 'investigate') &&
      !bot.hasGoal && !bot.path;
    let activeDefuser = false;
    if (bot.team === 'ct' && this._bombPlanted) {
      for (const teammate of this.all) {
        if (teammate.team === 'ct' && teammate.alive && teammate.state === 'defuse') {
          activeDefuser = true;
          break;
        }
      }
    }
    const urgentObjective = (bot.team === 'ct' && this._bombPlanted &&
        (bot.postPlantRole === 'defuse' || !activeDefuser)) ||
      (bot === this.bombCarrier && !this._bombPlanted) ||
      (bot.plan === 'retrieve' && this._bombDropped);
    if (arrived && !urgentObjective && !(bot.team === 't' && bot.routeActive)) {
      const investigated = bot.state === 'investigate';
      bot.state = 'hold';
      if (bot.team === 'ct') {
        if (!bot.anchorReached && bot.pos.distanceToSquared(bot.anchor) < 4) {
          bot.anchorReached = true;
        }
        bot.holdTimer = investigated
          ? rand(INVESTIGATE_HOLD_MIN, INVESTIGATE_HOLD_MAX)
          : rand(CT_HOLD_MIN, CT_HOLD_MAX);
      } else {
        bot.holdTimer = investigated
          ? rand(INVESTIGATE_HOLD_MIN, INVESTIGATE_HOLD_MAX)
          : rand(T_HOLD_MIN, T_HOLD_MAX);
      }
      bot.scanTimer = Math.min(bot.scanTimer, 0.25);
      return;
    }

    // Objective logic per team.
    if (bot.team === 't') this._thinkT(bot);
    else this._thinkCT(bot);

    // Idle scanning while holding: sweep the head/body left-right.
    if (bot.state === 'hold' && !bot.hasGoal) {
      bot.holdTimer -= THINK_INTERVAL;
      bot.scanTimer -= THINK_INTERVAL;
      if (bot.scanTimer <= 0) {
        bot.scanTimer = rand(1.5, 4);
        bot.scanYaw = bot.yaw + rand(-1.2, 1.2);
      }
      bot.yaw += angleDiff(bot.scanYaw, bot.yaw) * 0.12;
    }

  }

  // ----- Terrorists -----

  _thinkT(bot) {
    const site = this._targetSite;

    if (this._bombPlanted) {
      // Post-plant: abandon unused approach steps and occupy distinct cover
      // around the bomb, rotating only after a short hold.
      if (bot.routeActive) {
        this._clearRoute(bot);
        bot.path = null;
        bot.hasGoal = false;
      }
      if (!bot.hasGoal && !bot.path &&
          (bot.state !== 'hold' || bot.holdTimer <= 0)) {
        if (this._setGoal(bot, this._diverseNear(bot, this._bombPos, 9))) {
          bot.state = 'move';
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
      } else if (!bot.hasGoal && this.time >= bot.repathCooldown) {
        if (this._setGoal(bot, this._droppedBombPos)) bot.state = 'move';
      }
      return;
    }

    if (bot === this.bombCarrier) {
      this._thinkCarrier(bot, site);
      return;
    }

    // Escorts and control players complete their assigned approach instead of
    // chasing the carrier's exact position. Every route still terminates at
    // the chosen objective, so the spread is purposeful rather than wandering.
    if (this._followRoute(bot)) return;

    if (!bot.hasGoal && !bot.path && site &&
        (bot.state !== 'hold' || bot.holdTimer <= 0)) {
      const radius = bot.plan === 'control' ? 13 : 10;
      if (this._setGoal(bot, this._diverseNear(bot, site.center, radius))) {
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
        bot.holdTimer = rand(2, 4);
        bot.plantTimer = 0;
        this._bombPlanted = true;
        this._bombPos.copy(bot.pos);
        this.game.events.emit('bomb:planted', { site: site.name, pos: bot.pos.clone() });
        this._setGoal(bot, this._diverseNear(bot, this._bombPos, 7));
      }
      return;
    }

    if (inSite) this._clearRoute(bot);
    else if (this._followRoute(bot)) return;

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
      } else if (!bot.hasGoal && !bot.path && this.time >= bot.repathCooldown) {
        this._setGoal(bot, this._diverseNear(bot, site.center, 3.5));
      }
    } else {
      bot.sneak = bot.pos.distanceToSquared(site.center) < 500; // quiet final approach
      bot.plantClearTimer = 0;
      if (this.time >= bot.repathCooldown && (!bot.hasGoal || bot.repathTimer <= 0)) {
        bot.repathTimer = 3;
        if (this._setGoal(bot, site.center)) bot.state = 'move';
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
        bot.postPlantRole = 'defuse';
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

      const nextRole = defuserBusy ? 'perimeter' : 'defuse';
      const roleChanged = bot.postPlantRole !== nextRole;
      bot.postPlantRole = nextRole;
      if (roleChanged) bot.repathTimer = 0;

      // Once a teammate owns the kit, arrive at cover and actually watch it.
      // If that defuser dies, this gate opens immediately and the survivor
      // rotates back with defuse urgency.
      if (defuserBusy && bot.state === 'hold' && bot.holdTimer > 0) return;

      if (!defuserBusy && d2 < 2.56 && !this._enemyVisibleQuick(bot)) {
        // At the bomb, clear to start the 10 s stick.
        bot.state = 'defuse';
        bot.postPlantRole = 'defuse';
        bot.defuseTimer = 0;
        bot.path = null;
        bot.hasGoal = false;
        return;
      }

      // Rotate hard to the site.
      if (!bot.hasGoal && this.time < bot.repathCooldown) return;
      const needsOrder = defuserBusy
        ? (roleChanged || !bot.hasGoal)
        : (!bot.hasGoal || bot.repathTimer <= 0);
      if (needsOrder) {
        bot.repathTimer = 2;
        if (this._setGoal(bot, defuserBusy ? this._diverseNear(bot, bombPos, 8) : bombPos)) {
          bot.state = 'move';
        }
      }
      bot.repathTimer -= THINK_INTERVAL;
      return;
    }

    // Pre-plant: take the assigned post first, then make infrequent compact
    // repositions inside that sector. This reads as defending an angle rather
    // than continuously touring a small loop of waypoints.
    if (!bot.hasGoal && !bot.path && bot.state !== 'hold') {
      const goal = bot.anchorReached ? this._patrolGoal(bot) : bot.anchor;
      if (this._setGoal(bot, goal)) bot.state = 'move';
    } else if (bot.state === 'hold' && bot.holdTimer <= 0) {
      const goal = bot.anchorReached ? this._patrolGoal(bot) : bot.anchor;
      if (this._setGoal(bot, goal)) bot.state = 'move';
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
    let bestHuman = null;
    let bestIsPlayer = false;

    // Any local or remote human on the opposing team is a valid target.
    const mp = this.game.multiplayer;
    const humans = mp && mp.active ? mp.humans() : [this.game.player];
    for (const human of humans) {
      if (!human || human.team === bot.team || !human.alive || !human.position) continue;
      const d2 = bot.pos.distanceToSquared(human.position);
      if (d2 < bestD2 && this._canSee(bot, human, true)) {
        bestD2 = d2;
        bestHuman = human;
        bestBot = null;
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
        bestHuman = null;
        bestIsPlayer = false;
      }
    }

    if (bestBot || bestHuman) {
      bot.target = bestIsPlayer ? bestHuman : bestBot;
      bot.targetBot = bestBot;
      bot.targetIsPlayer = bestIsPlayer;
      bot.targetHuman = bestHuman;
      bot.targetVisible = true;
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
      const pl = otherBot || this.game.player;
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
    const mp = this.game.multiplayer;
    const humans = mp && mp.active ? mp.humans() : [this.game.player];
    for (const human of humans) {
      if (!human || human.team === bot.team || !human.alive) continue;
      if (bot.pos.distanceToSquared(human.position) > 1600) continue;
      if (this._canSee(bot, human, true)) return true;
    }
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

  _assignRoute(bot, route) {
    bot.routeQueue.length = 0;
    bot.routeName = route ? route.name : null;
    if (route && Array.isArray(route.points)) {
      for (let i = 0; i < route.points.length; i++) {
        bot.routeQueue.push(route.points[i].clone());
      }
    }
    bot.routeActive = bot.routeQueue.length > 0;
  }

  _clearRoute(bot) {
    bot.routeQueue.length = 0;
    bot.routeActive = false;
    bot.routeName = null;
  }

  // Returns true while an assigned lane still owns this bot's travel. Combat,
  // damage investigations and sound checks may temporarily replace the current
  // path; the remaining route resumes naturally after that goal is reached.
  _followRoute(bot) {
    if (!bot.routeActive) return false;
    if (bot.hasGoal || bot.path) return true;
    if (bot.state === 'hold' && bot.holdTimer > 0) return true;

    const next = bot.routeQueue.shift();
    if (!next) {
      bot.routeActive = false;
      bot.routeName = null;
      bot.state = 'hold';
      bot.holdTimer = bot === this.bombCarrier
        ? rand(1.2, 2.0)
        : rand(T_HOLD_MIN, T_HOLD_MAX);
      bot.scanTimer = Math.min(bot.scanTimer, 0.25);
      return true;
    }
    if (this._setGoal(bot, next)) bot.state = 'move';
    return true;
  }

  _selectDiversePoint(bot, candidates) {
    if (!candidates || candidates.length === 0) return null;

    const occupied = [];
    for (let i = 0; i < this.all.length; i++) {
      const teammate = this.all[i];
      if (teammate === bot || !teammate.alive || teammate.team !== bot.team) continue;
      occupied.push(teammate.pos);
      if (teammate.hasGoal) occupied.push(teammate.goal);
    }

    const index = selectDiversePointIndex(candidates, {
      origin: bot.pos,
      occupied,
      recent: bot.destinationHistory,
      salt: bot.decisionSeq++,
      minTravel: 3.5,
    });
    if (index < 0) return null;

    const chosen = candidates[index].clone();
    bot.destinationHistory.unshift(chosen.clone());
    if (bot.destinationHistory.length > 3) bot.destinationHistory.length = 3;
    return chosen;
  }

  _diverseNear(bot, pos, r) {
    const world = this.game.world;
    const nodes = world && world.waypoints && world.waypoints.nodes;
    if (nodes && nodes.length) {
      const candidates = [];
      const r2 = r * r;
      for (let i = 0; i < nodes.length; i++) {
        const point = nodes[i].pos;
        const dx = point.x - pos.x;
        const dy = (point.y - pos.y) * 1.5;
        const dz = point.z - pos.z;
        if (dx * dx + dy * dy + dz * dz <= r2) candidates.push(point);
      }
      const chosen = this._selectDiversePoint(bot, candidates);
      if (chosen) return chosen;
    }
    return this._randomNear(pos, r);
  }

  _patrolGoal(bot) {
    const chosen = this._selectDiversePoint(bot, bot.patrolPoints);
    return chosen || this._diverseNear(bot, bot.anchor, 12);
  }

  _setGoal(bot, pos, { force = false } = {}) {
    if (!pos) return false;
    const world = this.game.world;
    const sameGoal = bot.hasGoal && bot.goal.distanceToSquared(pos) <=
      NAV_GOAL_REUSE_DISTANCE * NAV_GOAL_REUSE_DISTANCE;
    // Periodic objective refreshes should not restart A* from node zero while
    // the bot is already following the same route. Stuck recovery opts into a
    // forced rebuild from the real post-collision position.
    if (sameGoal && bot.path && !force) return true;
    bot.goal.copy(pos);
    bot.hasGoal = true;
    bot.pathIndex = 0;
    if (!sameGoal) {
      bot.recoveryCount = 0;
      bot.recoveryUntil = 0;
      bot.recoveryDir.set(0, 0, 0);
      bot.repathCooldown = 0;
    }
    if (world && typeof world.findPath === 'function') {
      const path = world.findPath(bot.pos, bot.goal);
      bot.path = path && path.length ? path : null;
    } else {
      bot.path = null;
    }
    if (!bot.path) {
      if (world && typeof world.findPath === 'function') {
        // A failed graph query is a failed order, not permission to walk in a
        // straight line through collision and hope for the best.
        bot.hasGoal = false;
        bot.state = 'hold';
        bot.holdTimer = bot.team === 'ct' ? rand(3, 5) : rand(1.5, 3);
        this._resetNavigationSample(bot);
        return false;
      }
      // Small test/custom worlds without navigation may still use direct
      // movement; production maps always provide findPath.
      bot.path = [bot.goal.clone()];
    }
    this._resetNavigationSample(bot);
    return true;
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
