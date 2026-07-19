// ============================================================================
// OPERATION GOLDENEYE — src/weapons/viewmodel.js (module E)
//
// First-person weapon viewmodels: eleven authored weapon GLBs plus one
// canonical skinned arm taken from the CT NPC. Primitive weapons remain only
// as synchronous loading/error fallbacks; rejected procedural hands are not
// used. Persistent wrappers copy the camera transform every frame (no second
// camera / layer tricks), and 'weapon:equip' toggles their visibility.
//
// Public API (per spec):
//   getMuzzleWorldPos(outVec3) -> world position of the current muzzle tip
//                                 (fallback: camera forward 0.4 m)
//   getWeaponGroup()           -> current visible weapon group (or null)
//   update(dt)                 -> copy camera transform, then apply animation
//
// Procedural animations:
//   - idle sway with mouse-look lag + breathing
//   - run/walk bob synced to game.player.moveSpeed2D
//   - fire kick (on 'weapon:fire' byPlayer), pistol slide cycling, AWP bolt
//   - reload drop/tilt/mag-swap choreography timed to the event's duration
//   - equip raise from below, knife slash arcs, grenade wind-up + throw
//   - landing dip ('player:land'), airborne float
//   - model hidden entirely while game.weapons.isScoped()
//
// Scene-graph layout:
//   rig (copies camera pos+quat)  -> added to game.scene
//     pivot (at PIVOT, camera space; all animation offsets applied here so
//            rotations pivot near the grip, not the camera origin)
//       one group per weapon id (posed lower-right, visible one at a time)
//
// No allocations in per-frame code; event handlers only set flags/timers.
// ============================================================================

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { WEAPONS } from './data.js';

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

// Animation pivot point in camera space — roughly where the firing hand grips.
const PIVOT_X = 0.15;
const PIVOT_Y = -0.145;
const PIVOT_Z = -0.24;

const KICK_RECOVER = 9.5;       // 1/s exponential recovery of fire kick
const KICK_MAX = 1.6;           // clamp on stacked kick impulses
const SWAY_VEL_SMOOTH = 14;     // 1/s smoothing of look velocity
const SWAY_POS_X = 0.0065;      // m per rad/s of yaw velocity
const SWAY_POS_Y = 0.005;
const SWAY_ROT_Y = 0.011;       // rad per rad/s
const SWAY_ROT_X = 0.009;
const SWAY_POS_CLAMP = 0.02;    // m
const SWAY_ROT_CLAMP = 0.055;   // rad
const BOB_STRIDE = 1.9;         // meters per full bob cycle
const BOB_AMP_X = 0.013;
const BOB_AMP_Y = 0.010;
const BOB_AMP_ROLL = 0.022;
const EQUIP_DUR_DEFAULT = 0.28; // visual raise time (event fires at raise start)
const SLASH_DUR = 0.26;
const THROW_DUR = 0.4;          // visual throw follow-through
const THROW_HIDE_AT = 0.11;     // grenade leaves the hand (matches weapons.js)
const BOLT_DUR = 0.85;          // AWP bolt-work choreography
const LAND_RECOVER = 6.5;       // 1/s land-dip recovery
const MUZZLE_FALLBACK_DIST = 0.4;

// Per-weapon pose (camera-space) + fire-kick scale + optional equip time.
const POSES = {
  ak47: { pos: [0.15, -0.270, -0.48], rot: [0.0, 0.04, -0.01], kick: 0.7 },
  m4a1: { pos: [0.15, -0.270, -0.47], rot: [0.0, 0.04, -0.01], kick: 0.6 },
  mp5: { pos: [0.14, -0.250, -0.42], rot: [0.0, 0.04, -0.01], kick: 0.45 },
  awp: { pos: [0.15, -0.270, -0.50], rot: [0.0, 0.035, -0.01], kick: 1.5 },
  deagle: { pos: [0.14, -0.200, -0.37], rot: [0.0, 0.0, 0.0], kick: 1.15 },
  usp: { pos: [0.14, -0.200, -0.36], rot: [0.0, 0.0, 0.0], kick: 0.55 },
  glock: { pos: [0.14, -0.200, -0.35], rot: [0.0, 0.0, 0.0], kick: 0.5 },
  knife: { pos: [0.15, -0.240, -0.35], rot: [-0.02, 0.50, 0.12], kick: 0, equip: 0.2 },
  hegrenade: { pos: [0.13, -0.240, -0.35], rot: [0.18, -0.12, -0.06], kick: 0, equip: 0.24 },
  flashbang: { pos: [0.13, -0.240, -0.35], rot: [0.18, -0.12, -0.06], kick: 0, equip: 0.24 },
  smokegrenade: { pos: [0.13, -0.240, -0.35], rot: [0.18, -0.12, -0.06], kick: 0, equip: 0.24 },
};

// ---------------------------------------------------------------------------
// GLB viewmodels (assets/models/viewmodels/<id>.glb, built in Blender).
// Conventions per asset build: real-world meter scale, origin at the
// right-hand grip point, barrel along -Z, +Y up, identity-rotation Empty
// named "Muzzle" at the barrel tip (top of body for grenades). The files are
// weapon-only; one NPC-derived skinned CT arm is loaded separately, then
// SkeletonUtils-cloned beside each weapon so every viewmodel uses the same
// authored hand proportions, materials, skeleton, and grip pose.
//
// GLB_POSES places each loaded model in camera space. Position/rotation apply
// to the shared wrapper; scale applies only to its weapon-content child so the
// player's hand size cannot vary with asset authoring scale.
// ---------------------------------------------------------------------------
const GLB_PATH = 'assets/models/viewmodels/';
const NPC_ARMS_PATH = GLB_PATH + 'npc-arms-ct.glb';
const NPC_ARM_SCALE = 0.25;

const GLB_POSES = {
  ak47: { pos: [0.15, -0.270, -0.48], rot: [0.0, 0.04, -0.01], scale: 1.0 },
  m4a1: { pos: [0.15, -0.270, -0.47], rot: [0.0, 0.04, -0.01], scale: 1.0 },
  mp5: { pos: [0.14, -0.250, -0.42], rot: [0.0, 0.04, -0.01], scale: 1.0 },
  awp: { pos: [0.15, -0.270, -0.50], rot: [0.0, 0.035, -0.01], scale: 0.95 },
  deagle: { pos: [0.14, -0.200, -0.37], rot: [0.0, 0.0, 0.0], scale: 1.1 },
  usp: { pos: [0.14, -0.200, -0.36], rot: [0.0, 0.0, 0.0], scale: 1.1 },
  glock: { pos: [0.14, -0.200, -0.35], rot: [0.0, 0.0, 0.0], scale: 1.1 },
  knife: { pos: [0.15, -0.240, -0.35], rot: [-0.02, 0.50, 0.12], scale: 1.0 },
  hegrenade: { pos: [0.13, -0.240, -0.35], rot: [0.18, -0.12, -0.06], scale: 1.05 },
  flashbang: { pos: [0.13, -0.240, -0.35], rot: [0.18, -0.12, -0.06], scale: 1.05 },
  smokegrenade: { pos: [0.13, -0.240, -0.35], rot: [0.18, -0.12, -0.06], scale: 1.05 },
};

// The arm GLB is authored in meters with VM_Grip at its identity origin. It
// stays outside the weapon-content scale node, so hand size is identical for
// every gun even though the weapon GLBs use different authoring scales.
//
// `pos` / `rot` / `scale` are deliberately family-level tuning controls. The
// fallback offset temporarily seats the same arm against the synchronous
// primitive weapon while its GLB streams in; it is removed when the real GLB
// (whose grip is at the wrapper origin) replaces that fallback.
const NPC_ARM_POSES = {
  rifle: {
    pos: [0, 0, 0], rot: [0, 0, 0], scale: NPC_ARM_SCALE,
    fallback: [0, -0.043, 0.051],
  },
  smg: {
    pos: [0, 0, 0], rot: [0, 0, 0], scale: NPC_ARM_SCALE,
    fallback: [0, -0.046, 0.020],
  },
  sniper: {
    pos: [0, 0, 0], rot: [0, 0, 0], scale: NPC_ARM_SCALE,
    fallback: [0, -0.045, 0.075],
  },
  pistol: {
    pos: [0, 0, 0], rot: [0, 0, 0], scale: NPC_ARM_SCALE,
    fallback: [0, -0.048, 0.038],
  },
  knife: {
    pos: [0, 0, 0], rot: [0, 0, 0], scale: NPC_ARM_SCALE,
    fallback: [0, 0, 0.050],
  },
  grenade: {
    pos: [0, 0, 0], rot: [0, 0, 0], scale: NPC_ARM_SCALE,
    fallback: [0, 0, 0],
  },
};

const NPC_ARM_FAMILY = {
  ak47: 'rifle',
  m4a1: 'rifle',
  mp5: 'smg',
  awp: 'sniper',
  deagle: 'pistol',
  usp: 'pistol',
  glock: 'pistol',
  knife: 'knife',
  hegrenade: 'grenade',
  flashbang: 'grenade',
  smokegrenade: 'grenade',
};

// ---------------------------------------------------------------------------
// Small math helpers (scalar only — no allocations)
// ---------------------------------------------------------------------------
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function smoothstep(a, b, x) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

// Gaussian-ish bump centered at c with width w (for reload jolts).
function bump(x, c, w) {
  const d = (x - c) / w;
  return Math.exp(-d * d);
}

function easeOutCubic(t) {
  const u = 1 - clamp(t, 0, 1);
  return 1 - u * u * u;
}

function easeOutQuad(t) {
  const u = clamp(t, 0, 1);
  return u * (2 - u);
}

// ============================================================================
// ViewModel
// ============================================================================
export default class ViewModel {
  constructor(game) {
    this.game = game;

    // ---- shared geometries / materials ------------------------------------
    this._initShared();

    // ---- rig --------------------------------------------------------------
    this.rig = new THREE.Group();
    this.rig.name = 'viewmodel-rig';
    this.rig.frustumCulled = false;
    this.rig.visible = false;

    this.pivot = new THREE.Group();
    this.pivot.name = 'viewmodel-pivot';
    this.pivot.position.set(PIVOT_X, PIVOT_Y, PIVOT_Z);
    this.rig.add(this.pivot);

    // ---- build every weapon model once ------------------------------------
    // Procedural box models are built synchronously as the always-available
    // fallback; GLB viewmodels stream in async and swap each group's content
    // in place when they arrive (the group node itself — which all animation
    // code manipulates — is preserved).
    this._models = {};
    this._npcArmsSource = null;
    this._buildAll();
    this._loadGLBModels();

    if (game.scene && typeof game.scene.add === 'function') {
      game.scene.add(this.rig);
    }

    // ---- animation state --------------------------------------------------
    this._currentId = null;       // adopted lazily from weapons / equip events
    this._t = 0;

    // fire kick
    this._kick = 0;
    this._kickYawV = 0;
    this._kickRollV = 0;

    // look sway
    this._lastYaw = 0;
    this._lastPitch = 0;
    this._haveLook = false;
    this._yawVel = 0;
    this._pitchVel = 0;

    // movement bob
    this._bobPhase = 0;
    this._bobAmp = 0;

    // landing dip / air float
    this._landK = 0;
    this._airY = 0;

    // equip raise
    this._equipT = 1;
    this._equipDur = EQUIP_DUR_DEFAULT;

    // reload choreography (timed to the event's duration)
    this._reload = { active: false, t: 0, dur: 2.5 };

    // knife slash
    this._slash = { active: false, t: 0, side: 1 };

    // grenade wind-up + throw
    this._wind = 0;
    this._throw = { active: false, t: 0 };
    this._payloadHidden = false;

    // AWP bolt cycle
    this._bolt = { active: false, t: 0 };

    // scratch vectors
    this._vDir = new THREE.Vector3();
    this._muzzleOut = new THREE.Vector3();

    // ---- events (handlers only set flags — cheap and re-entrant safe) -----
    const ev = game.events;
    if (ev && typeof ev.on === 'function') {
      ev.on('weapon:equip', (p) => this._onEquip(p));
      ev.on('weapon:fire', (p) => this._onFire(p));
      ev.on('weapon:reload:start', (p) => this._onReloadStart(p));
      ev.on('weapon:reload:end', () => this._onReloadEnd());
      ev.on('grenade:throw', () => this._onThrow());
      ev.on('player:land', (p) => this._onLand(p));
    }
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Writes the CURRENT world-space muzzle tip into `out` and returns it.
   * Falls back to camera-forward 0.4 m when no weapon model is visible.
   * Safe to call mid-frame (combat fires before our update): the rig is
   * re-synced to the camera before sampling.
   */
  getMuzzleWorldPos(out) {
    if (!out || !out.isVector3) out = this._muzzleOut;
    const g = this.game;
    const cam = g ? g.camera : null;
    const model = this._models ? this._models[this._currentId] : null;

    if (this.rig.visible && model && model.visible && model.userData.muzzle) {
      // Mid-frame callers (combat) need this frame's camera transform even
      // though our update() may not have run yet. Cheap: copy pos + quat.
      if (cam) {
        this.rig.position.copy(cam.position);
        this.rig.quaternion.copy(cam.quaternion);
      }
      model.userData.muzzle.getWorldPosition(out); // updates parent matrices
      return out;
    }

    if (cam) {
      cam.getWorldDirection(this._vDir);
      out.copy(cam.position).addScaledVector(this._vDir, MUZZLE_FALLBACK_DIST);
    } else {
      out.set(0, 0, 0);
    }
    return out;
  }

  /** The currently visible weapon group, or null when nothing is shown. */
  getWeaponGroup() {
    const model = this._models ? this._models[this._currentId] : null;
    return this.rig.visible && model && model.visible ? model : null;
  }

  // ==========================================================================
  // Per-frame update — camera copy FIRST, then animation offsets.
  // ==========================================================================
  update(dt) {
    const g = this.game;
    const cam = g.camera;
    if (!cam) return;
    this._t += dt;

    const player = g.player || null;      // lazy sibling lookups (rule 9)
    const weapons = g.weapons || null;
    const input = g.input || null;
    const state = g.state || null;

    // Missed-event safety net: adopt weapons' current id if out of sync
    // (covers boot order and any equip we did not observe).
    if (weapons && weapons.currentId && weapons.currentId !== this._currentId) {
      this._beginEquip(weapons.currentId);
    } else if (!this._currentId) {
      this._beginEquip('knife');
    }

    // ---- visibility --------------------------------------------------------
    const phase = state ? state.phase : 'menu';
    const scoped =
      !!(weapons && typeof weapons.isScoped === 'function' && weapons.isScoped());
    const alive = !player || player.alive !== false;
    const show = alive && !scoped && phase !== 'menu' && phase !== 'gameEnd';

    // ---- advance / decay all transient state (even while hidden, so the
    //      model never pops mid-animation when it reappears) -----------------
    const kickDecay = Math.exp(-KICK_RECOVER * dt);
    this._kick *= kickDecay;
    this._kickYawV *= kickDecay;
    this._kickRollV *= kickDecay;
    if (this._kick < 1e-4) this._kick = 0;

    this._landK *= Math.exp(-LAND_RECOVER * dt);
    if (this._landK < 1e-3) this._landK = 0;

    if (this._equipT < this._equipDur) this._equipT += dt;

    const rl = this._reload;
    if (rl.active) {
      rl.t += dt;
      if (rl.t >= rl.dur) rl.active = false;
    }

    const sl = this._slash;
    if (sl.active) {
      sl.t += dt;
      if (sl.t >= SLASH_DUR) sl.active = false;
    }

    const th = this._throw;
    if (th.active) {
      th.t += dt;
      if (th.t >= THROW_DUR) th.active = false;
    }

    const bo = this._bolt;
    if (bo.active) {
      bo.t += dt;
      if (bo.t >= BOLT_DUR) bo.active = false;
    }

    // Grenade wind-up: pin pulled while LMB is held on an equipped grenade.
    const curDef = WEAPONS[this._currentId];
    let windTarget = 0;
    if (
      curDef &&
      curDef.grenade &&
      !th.active &&
      input &&
      input.firing &&
      phase !== 'freeze' &&
      !(state && state.buyOpen)
    ) {
      const ca =
        weapons && typeof weapons.currentAmmo === 'function'
          ? weapons.currentAmmo()
          : null;
      if (ca && ca.mag > 0) windTarget = 1;
    }
    this._wind += (windTarget - this._wind) * (1 - Math.exp(-10 * dt));

    // ---- look-lag sway velocities ------------------------------------------
    const yaw = player ? player.yaw || 0 : 0;
    const pitch = player ? player.pitch || 0 : 0;
    if (!this._haveLook) {
      this._lastYaw = yaw;
      this._lastPitch = pitch;
      this._haveLook = true;
    }
    let dyaw = yaw - this._lastYaw;
    if (dyaw > Math.PI) dyaw -= Math.PI * 2;
    else if (dyaw < -Math.PI) dyaw += Math.PI * 2;
    const dpitch = pitch - this._lastPitch;
    this._lastYaw = yaw;
    this._lastPitch = pitch;
    const invDt = dt > 1e-4 ? 1 / dt : 0;
    const sm = 1 - Math.exp(-SWAY_VEL_SMOOTH * dt);
    this._yawVel += (clamp(dyaw * invDt, -10, 10) - this._yawVel) * sm;
    this._pitchVel += (clamp(dpitch * invDt, -10, 10) - this._pitchVel) * sm;

    // ---- movement bob ------------------------------------------------------
    const speed = player && typeof player.moveSpeed2D === 'number' ? player.moveSpeed2D : 0;
    const onGround = player ? player.onGround !== false : true;
    const cfg = g.config;
    const runSpeed = (cfg && cfg.PLAYER && cfg.PLAYER.RUN_SPEED) || 5.2;
    const speedFrac = clamp(speed / runSpeed, 0, 1);
    const bobTarget = onGround && speed > 0.35 ? speedFrac : 0;
    this._bobAmp += (bobTarget - this._bobAmp) * (1 - Math.exp(-8 * dt));
    this._bobPhase += speed * dt * ((Math.PI * 2) / BOB_STRIDE);

    // Air float: gun drifts opposite vertical velocity while airborne.
    const vy = player && player.velocity ? player.velocity.y || 0 : 0;
    const airTarget = onGround ? 0 : clamp(-vy * 0.0045, -0.018, 0.022);
    this._airY += (airTarget - this._airY) * (1 - Math.exp(-9 * dt));

    // ---- rig follows the camera (BEFORE animation offsets) -----------------
    this.rig.visible = show;
    this.rig.position.copy(cam.position);
    this.rig.quaternion.copy(cam.quaternion);
    if (!show) return; // hidden: skip pose composition + matrix flush

    // ---- compose pivot offsets --------------------------------------------
    let px = PIVOT_X;
    let py = PIVOT_Y;
    let pz = PIVOT_Z;
    let rx = 0;
    let ry = 0;
    let rz = 0;

    // idle breathing (fades out while moving)
    const idle = 1 - this._bobAmp;
    py += Math.sin(this._t * 1.5) * 0.0014 * idle;
    px += Math.sin(this._t * 0.9) * 0.0008 * idle;
    ry += Math.sin(this._t * 0.7) * 0.0022 * idle;

    // look-lag sway
    px += clamp(this._yawVel * SWAY_POS_X, -SWAY_POS_CLAMP, SWAY_POS_CLAMP);
    py += clamp(-this._pitchVel * SWAY_POS_Y, -SWAY_POS_CLAMP, SWAY_POS_CLAMP);
    ry += clamp(-this._yawVel * SWAY_ROT_Y, -SWAY_ROT_CLAMP, SWAY_ROT_CLAMP);
    rx += clamp(-this._pitchVel * SWAY_ROT_X, -SWAY_ROT_CLAMP, SWAY_ROT_CLAMP);

    // run/walk bob
    const ph = this._bobPhase;
    const amp = this._bobAmp;
    px += Math.sin(ph) * BOB_AMP_X * amp;
    py += -Math.abs(Math.sin(ph)) * BOB_AMP_Y * amp;
    rz += Math.sin(ph) * BOB_AMP_ROLL * amp;

    // airborne float + landing dip
    py += this._airY;
    py -= 0.05 * this._landK;
    rx -= 0.1 * this._landK;

    // fire kick — translate back toward the camera, muzzle rises
    const kick = this._kick;
    if (kick > 0) {
      pz += 0.05 * kick;
      py += 0.007 * kick;
      rx += 0.13 * kick;
      ry += this._kickYawV;
      rz += this._kickRollV;
    }

    // equip raise — from below, tilted down, over the raise window
    if (this._equipT < this._equipDur) {
      const raise = 1 - easeOutCubic(this._equipT / this._equipDur);
      py -= 0.24 * raise;
      rx -= 0.85 * raise;
      rz += 0.3 * raise;
    }

    // reload choreography — drop + tilt, mag-out / mag-in jolts, raise at end
    let magOut = 0;
    if (rl.active && rl.dur > 0) {
      const n = clamp(rl.t / rl.dur, 0, 1);
      const drop = smoothstep(0, 0.14, n) * (1 - smoothstep(0.72, 0.95, n));
      const j1 = bump(n, 0.3, 0.05);  // mag released
      const j2 = bump(n, 0.62, 0.05); // fresh mag seated
      py -= 0.045 * drop + 0.012 * j1 - 0.008 * j2;
      px += 0.014 * drop;
      pz += 0.018 * drop;
      rx -= 0.34 * drop + 0.05 * j2;
      rz += 0.16 * drop + 0.04 * j1;
      // busy-hands wobble while low
      rz += Math.sin(n * 43) * 0.016 * drop * bump(n, 0.48, 0.22);
      magOut = smoothstep(0.22, 0.34, n) * (1 - smoothstep(0.5, 0.62, n));
    }

    // knife slash — fast arc across the view, alternating sides
    if (sl.active) {
      const p = sl.t / SLASH_DUR;
      const arc = Math.sin(p * Math.PI);
      ry += sl.side * 0.62 * arc;
      rz += sl.side * 0.45 * arc;
      rx -= 0.3 * arc;
      pz -= 0.09 * arc;
      py += 0.02 * arc;
    }

    // grenade wind-up (cocked back over the shoulder) + throw sweep
    if (this._wind > 0.001) {
      const w = this._wind;
      px += 0.025 * w;
      py += 0.03 * w;
      pz += 0.075 * w;
      rx += 0.5 * w;
    }
    if (th.active) {
      const p = th.t / THROW_DUR;
      const swing = p < 0.3 ? easeOutQuad(p / 0.3) : 1 - smoothstep(0.3, 1, p);
      pz -= 0.13 * swing;
      rx -= 0.55 * swing;
      py += 0.035 * swing;
      // grenade leaves the hand — hide the payload meshes
      if (th.t >= THROW_HIDE_AT && !this._payloadHidden) {
        this._setPayloadVisible(false);
      }
    }

    // AWP bolt work — gun cants right while the bolt is cycled
    let boltPull = 0;
    if (bo.active && this._currentId === 'awp' && bo.t > 0) {
      const n = clamp(bo.t / BOLT_DUR, 0, 1);
      boltPull = bump(n, 0.45, 0.17);
      rz += 0.12 * boltPull;
      rx -= 0.05 * boltPull;
      py -= 0.008 * boltPull;
    }

    this.pivot.position.set(px, py, pz);
    this.pivot.rotation.set(rx, ry, rz);

    // ---- moving parts on the current model --------------------------------
    const model = this._models[this._currentId];
    if (model) {
      const ud = model.userData;
      if (ud.slide) {
        // pistol slide cycles back with the kick
        ud.slide.position.z = ud.slideBaseZ + Math.min(1, kick) * 0.022;
      }
      if (ud.mag) {
        ud.mag.position.y = ud.magBaseY - 0.09 * magOut;
      }
      if (ud.bolt) {
        ud.bolt.position.z = ud.boltBaseZ + 0.032 * boltPull;
      }
    }

    // Flush world matrices so effects (which updates after us) samples the
    // exact on-screen muzzle position this frame.
    this.rig.updateMatrixWorld(true);
  }

  // ==========================================================================
  // Event handlers — flags and timers only
  // ==========================================================================
  _onEquip(p) {
    if (p && p.id && WEAPONS[p.id]) this._beginEquip(p.id);
  }

  _onFire(p) {
    if (!p || !p.byPlayer) return;
    const def = WEAPONS[p.weaponId];
    if (def && def.melee) {
      this._slash.active = true;
      this._slash.t = 0;
      this._slash.side = -this._slash.side; // alternate slash direction
      return;
    }
    const pose = POSES[p.weaponId];
    const ks = pose ? pose.kick : 0.6;
    if (ks <= 0) return;
    this._kick = Math.min(KICK_MAX, this._kick + 0.55 * ks);
    this._kickYawV = clamp(
      this._kickYawV + (Math.random() - 0.5) * 0.05 * ks,
      -0.06,
      0.06
    );
    this._kickRollV = clamp(
      this._kickRollV + (Math.random() - 0.5) * 0.06 * ks,
      -0.08,
      0.08
    );
    if (p.weaponId === 'awp') {
      this._bolt.active = true;
      this._bolt.t = -0.18; // short beat before the bolt is worked
    }
  }

  _onReloadStart(p) {
    this._reload.active = true;
    this._reload.t = 0;
    this._reload.dur = Math.max(0.5, (p && p.duration) || 2.5);
  }

  _onReloadEnd() {
    // Natural end lines up with the choreography; just make sure it stops.
    this._reload.active = false;
    const model = this._models[this._currentId];
    if (model && model.userData.mag) {
      model.userData.mag.position.y = model.userData.magBaseY;
    }
  }

  _onThrow() {
    this._throw.active = true;
    this._throw.t = 0;
    this._wind = Math.max(this._wind, 0.6); // release from a cocked pose
  }

  _onLand(p) {
    const speed = p && typeof p.speed === 'number' ? p.speed : 3;
    this._landK = Math.min(0.6, 0.14 + speed * 0.04);
  }

  // ==========================================================================
  // Weapon switching
  // ==========================================================================
  _beginEquip(id) {
    if (!this._models[id]) return;
    this._currentId = id;

    for (const key in this._models) {
      this._models[key].visible = key === id;
    }

    // restore moving parts / payload of the incoming model
    const model = this._models[id];
    const ud = model.userData;
    if (ud.mag) ud.mag.position.y = ud.magBaseY;
    if (ud.slide) ud.slide.position.z = ud.slideBaseZ;
    if (ud.bolt) ud.bolt.position.z = ud.boltBaseZ;
    this._payloadHidden = false;
    if (ud.payload) {
      for (let i = 0; i < ud.payload.length; i++) ud.payload[i].visible = true;
    }

    // reset transient animation state (weapons cancels reloads silently on
    // switch — no reload:end event — so we must drop the anim here)
    const pose = POSES[id];
    this._equipDur = (pose && pose.equip) || EQUIP_DUR_DEFAULT;
    this._equipT = 0;
    this._reload.active = false;
    this._slash.active = false;
    this._throw.active = false;
    this._bolt.active = false;
    this._wind = 0;
    this._kick *= 0.25;
  }

  _setPayloadVisible(v) {
    const model = this._models[this._currentId];
    if (model && model.userData.payload) {
      const list = model.userData.payload;
      for (let i = 0; i < list.length; i++) list[i].visible = v;
    }
    this._payloadHidden = !v;
  }

  // ==========================================================================
  // Shared geometry / materials
  // ==========================================================================
  _initShared() {
    this.geo = {
      box: new THREE.BoxGeometry(1, 1, 1),
      cyl: new THREE.CylinderGeometry(0.5, 0.5, 1, 12),
      sph: new THREE.SphereGeometry(0.5, 14, 10),
      ring: new THREE.TorusGeometry(0.5, 0.11, 8, 18),
    };

    const MS = (o) => new THREE.MeshStandardMaterial(o);
    this.mats = {
      gunmetal: MS({ color: 0x3a3f45, metalness: 0.78, roughness: 0.38 }),
      gundark: MS({ color: 0x1e2124, metalness: 0.7, roughness: 0.45 }),
      polymer: MS({ color: 0x24272a, metalness: 0.12, roughness: 0.78 }),
      polymerLight: MS({ color: 0x33383d, metalness: 0.1, roughness: 0.85 }),
      wood: MS({ color: 0x7c4a24, metalness: 0.05, roughness: 0.55 }),
      woodDark: MS({ color: 0x59341a, metalness: 0.05, roughness: 0.6 }),
      // Note: keep metalness moderate — there is no environment map, and
      // fully metallic surfaces would render nearly black.
      chrome: MS({ color: 0xdfe3e8, metalness: 0.55, roughness: 0.25 }),
      steel: MS({ color: 0xc4cad0, metalness: 0.5, roughness: 0.3 }),
      awpGreen: MS({ color: 0x5d6b45, metalness: 0.25, roughness: 0.6 }),
      awpGreenDark: MS({ color: 0x49563a, metalness: 0.25, roughness: 0.62 }),
      lens: MS({ color: 0x0d1c2e, metalness: 0.9, roughness: 0.12 }),
      mag: MS({ color: 0x2c2c26, metalness: 0.6, roughness: 0.5 }),
      oliveHE: MS({ color: 0x3e4a2b, metalness: 0.35, roughness: 0.5 }),
      flashGray: MS({ color: 0x6b7178, metalness: 0.4, roughness: 0.4 }),
      smokeBody: MS({ color: 0x555e4c, metalness: 0.25, roughness: 0.6 }),
      band: MS({ color: 0x9aa1a7, metalness: 0.5, roughness: 0.5 }),
      blade: MS({ color: 0xd8dde2, metalness: 0.45, roughness: 0.28 }),
      edge: MS({ color: 0xf4f7f9, metalness: 0.35, roughness: 0.18 }),
      grip: MS({ color: 0x17191b, metalness: 0.1, roughness: 0.85 }),
    };
  }

  // ---- primitive helpers (every mesh: no shadows, never frustum-culled) ----
  _flags(m) {
    m.castShadow = false;
    m.receiveShadow = false;
    m.frustumCulled = false;
    return m;
  }

  _B(parent, mat, w, h, d, x, y, z, rx, ry, rz) {
    const m = new THREE.Mesh(this.geo.box, mat);
    m.scale.set(w, h, d);
    m.position.set(x || 0, y || 0, z || 0);
    if (rx || ry || rz) m.rotation.set(rx || 0, ry || 0, rz || 0);
    parent.add(this._flags(m));
    return m;
  }

  // Cylinder of radius r, length len, along axis 'y' | 'z' | 'x'.
  _C(parent, mat, r, len, x, y, z, axis) {
    const m = new THREE.Mesh(this.geo.cyl, mat);
    m.scale.set(r * 2, len, r * 2);
    if (axis === 'z') m.rotation.x = Math.PI / 2;
    else if (axis === 'x') m.rotation.z = Math.PI / 2;
    m.position.set(x || 0, y || 0, z || 0);
    parent.add(this._flags(m));
    return m;
  }

  _S(parent, mat, r, x, y, z, sx, sy, sz) {
    const m = new THREE.Mesh(this.geo.sph, mat);
    m.scale.set(r * 2 * (sx || 1), r * 2 * (sy || 1), r * 2 * (sz || 1));
    m.position.set(x || 0, y || 0, z || 0);
    parent.add(this._flags(m));
    return m;
  }

  // Torus ring of radius r, facing +Z by default.
  _R(parent, mat, r, x, y, z, rx, ry, rz) {
    const m = new THREE.Mesh(this.geo.ring, mat);
    const s = r * 2;
    m.scale.set(s, s, s);
    m.position.set(x || 0, y || 0, z || 0);
    if (rx || ry || rz) m.rotation.set(rx || 0, ry || 0, rz || 0);
    parent.add(this._flags(m));
    return m;
  }

  // ==========================================================================
  // Model construction — one distinct silhouette per weapon id
  // ==========================================================================
  _buildAll() {
    const builders = {
      knife: () => this._buildKnife(),
      glock: () => this._buildGlock(),
      usp: () => this._buildUSP(),
      deagle: () => this._buildDeagle(),
      mp5: () => this._buildMP5(),
      ak47: () => this._buildAK47(),
      m4a1: () => this._buildM4A1(),
      awp: () => this._buildAWP(),
      hegrenade: () => this._buildHE(),
      flashbang: () => this._buildFlashbang(),
      smokegrenade: () => this._buildSmoke(),
    };

    for (const id in WEAPONS) {
      const build = builders[id];
      if (!build) continue; // unknown future weapon: no model, muzzle falls back
      const group = build();
      group.name = 'vm-' + id;
      const pose = POSES[id] || { pos: [0.15, -0.14, -0.26], rot: [0, 0, 0] };
      group.position.set(
        pose.pos[0] - PIVOT_X,
        pose.pos[1] - PIVOT_Y,
        pose.pos[2] - PIVOT_Z
      );
      group.rotation.set(pose.rot[0], pose.rot[1], pose.rot[2]);
      group.userData.weaponSource = 'fallback';
      group.visible = false;
      this.pivot.add(group);
      this._models[id] = group;
    }
  }

  _muzzleAt(group, x, y, z) {
    const mz = new THREE.Object3D();
    mz.position.set(x, y, z);
    group.add(mz);
    group.userData.muzzle = mz;
  }

  _poseNPCArms(arms, id, weaponSource) {
    const family = NPC_ARM_FAMILY[id];
    const pose = family && NPC_ARM_POSES[family];
    if (!arms || !pose) return;

    let x = pose.pos[0];
    let y = pose.pos[1];
    let z = pose.pos[2];
    if (weaponSource === 'fallback') {
      x += pose.fallback[0];
      y += pose.fallback[1];
      z += pose.fallback[2];
    }
    arms.position.set(x, y, z);
    arms.rotation.set(pose.rot[0], pose.rot[1], pose.rot[2]);
    arms.scale.setScalar(pose.scale);
    arms.updateMatrixWorld(true);
  }

  _attachNPCArms(group, id) {
    if (!group || !this._npcArmsSource) return;

    const previous = group.userData.npcArms;
    if (previous && previous.parent === group) group.remove(previous);

    // Object3D.clone() leaves SkinnedMesh skeletons pointing at the source
    // bones. SkeletonUtils.clone() remaps every cloned mesh to its own cloned
    // bones while intentionally sharing the immutable geometry/material data.
    const arms = cloneSkeleton(this._npcArmsSource);
    arms.name = 'vm-npc-arms-' + id;
    arms.userData.isNPCViewmodelArms = true;
    arms.traverse((o) => {
      o.frustumCulled = false;
      if (o.isMesh) {
        o.castShadow = false;
        o.receiveShadow = false;
      }
    });
    this._poseNPCArms(arms, id, group.userData.weaponSource || 'fallback');
    group.userData.npcArms = arms;
    group.add(arms);
  }

  _applyNPCArms(gltf) {
    const source = gltf && (gltf.scene || (gltf.scenes && gltf.scenes[0]));
    if (!source) throw new Error('npc-arms-ct.glb has no scene');

    let hasSkinnedMesh = false;
    let grip = null;
    source.traverse((o) => {
      o.frustumCulled = false;
      if (o.isSkinnedMesh) hasSkinnedMesh = true;
      if (!grip && o.name === 'VM_Grip') grip = o;
      if (o.isMesh) {
        o.castShadow = false;
        o.receiveShadow = false;
      }
    });
    if (!hasSkinnedMesh) throw new Error('npc-arms-ct.glb has no SkinnedMesh');
    if (!grip) throw new Error('npc-arms-ct.glb has no VM_Grip origin');
    source.updateMatrixWorld(true);

    // VM_Grip is the actual clone root, not merely a marker. Reject exports
    // whose grip is transformed or whose visible skinned geometry has drifted
    // away from it; both conditions previously produced an invisible/offscreen
    // hand while still passing a name-only check.
    const identity = new THREE.Matrix4();
    const gripElements = grip.matrixWorld.elements;
    const identityElements = identity.elements;
    for (let i = 0; i < 16; i++) {
      if (Math.abs(gripElements[i] - identityElements[i]) > 1e-5) {
        throw new Error('npc-arms-ct.glb VM_Grip must be world-space identity');
      }
    }
    let gripHasSkinnedMesh = false;
    grip.traverse((o) => {
      if (o.isSkinnedMesh) gripHasSkinnedMesh = true;
    });
    if (!gripHasSkinnedMesh) {
      throw new Error('npc-arms-ct.glb SkinnedMesh must be parented under VM_Grip');
    }
    const armBounds = new THREE.Box3().setFromObject(grip);
    const armSize = armBounds.getSize(new THREE.Vector3());
    const gripPoint = new THREE.Vector3().setFromMatrixPosition(grip.matrixWorld);
    if (
      armBounds.isEmpty() ||
      armBounds.distanceToPoint(gripPoint) > 0.08 ||
      armSize.length() < 0.1 ||
      armSize.length() > 2.0
    ) {
      throw new Error('npc-arms-ct.glb hand bounds are not seated at VM_Grip');
    }
    this._npcArmsSource = grip;

    // Attach exactly one skeleton-safe clone to every persistent wrapper.
    // The wrappers are what equip/recoil/reload/throw animations manipulate,
    // so arm and weapon remain locked together for the whole animation.
    for (const id in this._models) {
      this._attachNPCArms(this._models[id], id);
    }
  }

  // ==========================================================================
  // GLB viewmodels — async load, swap group content in place on arrival.
  // Any failure (missing file, parse error, no loader) leaves the procedural
  // fallback model untouched for that weapon.
  // ==========================================================================
  _loadGLBModels() {
    let loader = null;
    try {
      loader = new GLTFLoader();
    } catch (e) {
      console.warn('[viewmodel] GLTFLoader unavailable — keeping procedural models', e);
      return;
    }

    // Load the authored CT arm once. All weapon wrappers receive
    // SkeletonUtils clones of this one source; there is no procedural hand
    // fallback if the asset is missing or invalid.
    loader.load(
      NPC_ARMS_PATH,
      (gltf) => {
        try {
          this._applyNPCArms(gltf);
        } catch (e) {
          console.warn('[viewmodel] NPC arm setup failed — keeping weapon-only viewmodels', e);
        }
      },
      undefined,
      (err) => {
        console.warn('[viewmodel] NPC arm GLB failed to load — keeping weapon-only viewmodels', err);
      }
    );

    for (const id in GLB_POSES) {
      if (!this._models[id]) continue; // no fallback group => nothing to swap
      loader.load(
        GLB_PATH + id + '.glb',
        (gltf) => {
          try {
            this._applyGLB(id, gltf);
          } catch (e) {
            console.warn('[viewmodel] GLB swap failed for ' + id + ' — keeping procedural model', e);
          }
        },
        undefined,
        (err) => {
          console.warn('[viewmodel] GLB load failed for ' + id + ' — keeping procedural model', err);
        }
      );
    }
  }

  _applyGLB(id, gltf) {
    const group = this._models[id];
    const content = gltf && (gltf.scene || (gltf.scenes && gltf.scenes[0]));
    if (!group || !content) return;

    // Viewmodel render flags on everything; keep materials as authored.
    let muzzle = null;
    const filledMaterials = new Set();
    content.traverse((o) => {
      o.frustumCulled = false;
      if (o.isMesh) {
        o.castShadow = false;
        o.receiveShadow = false;
        // World sunlight can sit behind the camera-space viewmodel and turn
        // an otherwise readable authored gun into a black silhouette. A very
        // small albedo-matched emissive fill preserves the original material
        // colors while keeping the weapon legible in every part of the map.
        const materials = Array.isArray(o.material) ? o.material : [o.material];
        for (const material of materials) {
          if (
            !material ||
            filledMaterials.has(material) ||
            !material.emissive ||
            !material.color
          ) continue;
          filledMaterials.add(material);
          material.emissive.copy(material.color);
          material.emissiveIntensity = 0.45;
          material.needsUpdate = true;
        }
      }
      if (!muzzle && o.name === 'Muzzle') muzzle = o;
    });

    // Grenade payload is selected before the independent NPC arm is added.
    // The weapon body leaves on throw while the skinned arm stays visible.
    const def = WEAPONS[id];
    let payload = null;
    if (def && def.grenade) {
      payload = [];
      for (let i = 0; i < content.children.length; i++) {
        const c = content.children[i];
        if (c.name !== 'Muzzle') payload.push(c);
      }
    }

    // Swap content in place: the group node (what all animation code and the
    // equip visibility toggle manipulate) is preserved.
    const oldMuzzle = group.userData.muzzle || null;
    const arms = group.userData.npcArms || null;
    for (let i = group.children.length - 1; i >= 0; i--) {
      group.remove(group.children[i]);
    }
    content.name = 'vm-glb-' + id;
    content.scale.setScalar(GLB_POSES[id].scale);
    group.add(content);
    group.userData.weaponSource = 'glb';
    // Reuse the already-cloned skeleton so the async weapon swap cannot cause
    // a one-frame arm flicker or strand a second clone. Re-seat it at the real
    // GLB's identity grip origin after removing the fallback grip correction.
    if (arms) {
      this._poseNPCArms(arms, id, 'glb');
      group.add(arms);
    } else {
      this._attachNPCArms(group, id);
    }

    // Re-pose for the real-scale GLB (same camera-space convention as POSES).
    const pose = GLB_POSES[id];
    group.position.set(
      pose.pos[0] - PIVOT_X,
      pose.pos[1] - PIVOT_Y,
      pose.pos[2] - PIVOT_Z
    );
    group.rotation.set(pose.rot[0], pose.rot[1], pose.rot[2]);
    // The NPC arm uses effective camera-space meters, independent of each
    // GLB's authoring scale. Only the weapon content is scaled.
    group.scale.setScalar(1);

    // Rebind userData handles. GLBs have no separate moving parts, so the
    // slide/mag/bolt micro-animations become no-ops (whole-group reload /
    // kick / bolt choreography still applies).
    const ud = group.userData;
    ud.slide = null;
    ud.mag = null;
    ud.bolt = null;
    ud.payload = payload;
    if (muzzle) {
      ud.muzzle = muzzle;
    } else if (oldMuzzle) {
      // The procedural muzzle is already authored in wrapper-space meters.
      group.add(oldMuzzle);
      ud.muzzle = oldMuzzle;
      console.warn('[viewmodel] no Muzzle empty in ' + id + '.glb — using fallback offset');
    } else {
      ud.muzzle = null;
    }

    // If this weapon is on screen mid-throw, keep the payload hidden.
    if (payload && this._currentId === id && this._payloadHidden) {
      for (let i = 0; i < payload.length; i++) payload[i].visible = false;
    }
  }

  // ---- AK-47: wood furniture, slab receiver, banana mag ---------------------
  _buildAK47() {
    const g = new THREE.Group();
    const M = this.mats;
    // receiver + raised dust cover
    this._B(g, M.gundark, 0.03, 0.046, 0.15, 0, 0, 0.01);
    this._B(g, M.gunmetal, 0.028, 0.013, 0.128, 0, 0.029, 0.004);
    // rear sight block + charging handle nub (right side)
    this._B(g, M.gundark, 0.012, 0.01, 0.025, 0, 0.04, -0.045);
    this._B(g, M.gunmetal, 0.008, 0.008, 0.02, 0.019, 0.012, 0.03);
    // wood handguard: lower + upper gas-tube cover
    this._B(g, M.wood, 0.032, 0.026, 0.088, 0, -0.006, -0.118);
    this._B(g, M.wood, 0.028, 0.018, 0.08, 0, 0.024, -0.112);
    // barrel, gas block, front sight post, slanted muzzle brake
    this._C(g, M.gundark, 0.006, 0.11, 0, 0.008, -0.21, 'z');
    this._B(g, M.gundark, 0.012, 0.018, 0.014, 0, 0.02, -0.175);
    this._B(g, M.gundark, 0.006, 0.022, 0.007, 0, 0.032, -0.243);
    this._C(g, M.gunmetal, 0.0085, 0.024, 0, 0.008, -0.262, 'z');
    // curved magazine — two angled segments suggest the banana profile
    const mag = new THREE.Group();
    mag.position.set(0, -0.028, -0.018);
    this._B(mag, M.mag, 0.024, 0.056, 0.04, 0, -0.026, -0.004, 0.3, 0, 0);
    this._B(mag, M.mag, 0.022, 0.05, 0.036, 0, -0.07, -0.028, 0.62, 0, 0);
    g.add(mag);
    g.userData.mag = mag;
    g.userData.magBaseY = mag.position.y;
    // grip + wood stock + butt plate
    this._B(g, M.woodDark, 0.022, 0.05, 0.03, 0, -0.044, 0.052, -0.35, 0, 0);
    this._B(g, M.wood, 0.026, 0.05, 0.115, 0, -0.012, 0.14, -0.08, 0, 0);
    this._B(g, M.gundark, 0.028, 0.054, 0.008, 0, -0.016, 0.198);
    this._muzzleAt(g, 0, 0.008, -0.276);
    return g;
  }

  // ---- M4-A1: black, carry handle, railed handguard, vertical grip ----------
  _buildM4A1() {
    const g = new THREE.Group();
    const M = this.mats;
    // receiver + ejection port hint (right side)
    this._B(g, M.gundark, 0.03, 0.044, 0.13, 0, 0, 0.008);
    this._B(g, M.gunmetal, 0.002, 0.016, 0.028, 0.0155, 0.002, -0.012);
    // carry handle: two posts + top bar
    this._B(g, M.gundark, 0.008, 0.016, 0.01, 0, 0.032, 0.05);
    this._B(g, M.gundark, 0.008, 0.016, 0.01, 0, 0.032, -0.03);
    this._B(g, M.gundark, 0.012, 0.012, 0.108, 0, 0.044, 0.01);
    // handguard with top/bottom rail strips + vertical grip
    this._B(g, M.polymer, 0.034, 0.034, 0.098, 0, -0.002, -0.118);
    this._B(g, M.gundark, 0.01, 0.006, 0.098, 0, 0.018, -0.118);
    this._B(g, M.gundark, 0.01, 0.006, 0.098, 0, -0.022, -0.118);
    this._B(g, M.polymer, 0.018, 0.042, 0.02, 0, -0.045, -0.13);
    // front sight tower, barrel, birdcage flash hider
    this._B(g, M.gundark, 0.008, 0.024, 0.01, 0, 0.026, -0.175);
    this._C(g, M.gundark, 0.0055, 0.075, 0, 0.006, -0.205, 'z');
    this._C(g, M.gunmetal, 0.007, 0.02, 0, 0.006, -0.25, 'z');
    // magazine (straight, slightly raked)
    const mag = new THREE.Group();
    mag.position.set(0, -0.024, -0.028);
    this._B(mag, M.mag, 0.023, 0.062, 0.035, 0, -0.03, -0.006, 0.18, 0, 0);
    g.add(mag);
    g.userData.mag = mag;
    g.userData.magBaseY = mag.position.y;
    // grip, buffer tube, telescoping stock
    this._B(g, M.polymer, 0.022, 0.048, 0.028, 0, -0.042, 0.05, -0.3, 0, 0);
    this._C(g, M.gundark, 0.01, 0.06, 0, 0.008, 0.105, 'z');
    this._B(g, M.polymer, 0.03, 0.046, 0.05, 0, 0.002, 0.15);
    this._B(g, M.polymer, 0.032, 0.05, 0.008, 0, 0.0, 0.178);
    this._muzzleAt(g, 0, 0.006, -0.262);
    return g;
  }

  // ---- AWP: long green body, fat scope, bolt handle, bipod nubs -------------
  _buildAWP() {
    const g = new THREE.Group();
    const M = this.mats;
    // long green stock/body + cheek riser + butt
    this._B(g, M.awpGreen, 0.032, 0.05, 0.21, 0, 0, 0.03);
    this._B(g, M.awpGreenDark, 0.03, 0.026, 0.09, 0, 0.036, 0.095);
    this._B(g, M.awpGreenDark, 0.034, 0.068, 0.045, 0, -0.004, 0.175);
    this._B(g, M.gundark, 0.036, 0.07, 0.008, 0, -0.004, 0.2);
    // green forend + long barrel + brake
    this._B(g, M.awpGreen, 0.032, 0.04, 0.14, 0, -0.004, -0.135);
    this._C(g, M.gundark, 0.007, 0.17, 0, 0.014, -0.275, 'z');
    this._C(g, M.gunmetal, 0.009, 0.028, 0, 0.014, -0.365, 'z');
    // fat scope: tube, objective bell + lens, ocular + lens, turrets, mounts
    this._C(g, M.gundark, 0.014, 0.115, 0, 0.056, -0.005, 'z');
    this._C(g, M.gundark, 0.02, 0.035, 0, 0.056, -0.075, 'z');
    this._C(g, M.lens, 0.017, 0.004, 0, 0.056, -0.0935, 'z');
    this._C(g, M.gundark, 0.017, 0.028, 0, 0.056, 0.055, 'z');
    this._C(g, M.lens, 0.014, 0.003, 0, 0.056, 0.0705, 'z');
    this._C(g, M.gunmetal, 0.007, 0.012, 0, 0.076, -0.005, 'y');
    this._C(g, M.gunmetal, 0.007, 0.012, 0.02, 0.056, -0.005, 'x');
    this._B(g, M.gundark, 0.012, 0.014, 0.016, 0, 0.036, -0.032);
    this._B(g, M.gundark, 0.012, 0.014, 0.016, 0, 0.036, 0.024);
    // bolt handle (right side, angled down) — animated during bolt work
    const bolt = this._B(g, M.steel, 0.006, 0.006, 0.028, 0.021, 0.018, 0.04, 0, 0, -0.6);
    g.userData.bolt = bolt;
    g.userData.boltBaseZ = bolt.position.z;
    // short magazine, grip, bipod nubs under the forend
    this._B(g, M.gundark, 0.022, 0.034, 0.05, 0, -0.036, -0.02);
    this._B(g, M.awpGreenDark, 0.022, 0.05, 0.03, 0, -0.045, 0.075, -0.32, 0, 0);
    this._B(g, M.gundark, 0.006, 0.034, 0.006, 0.012, -0.038, -0.19, 0, 0, -0.25);
    this._B(g, M.gundark, 0.006, 0.034, 0.006, -0.012, -0.038, -0.19, 0, 0, 0.25);
    this._muzzleAt(g, 0, 0.014, -0.385);
    return g;
  }

  // ---- Night Hawk (Deagle): chrome slide over a black frame -----------------
  _buildDeagle() {
    const g = new THREE.Group();
    const M = this.mats;
    // chrome slide (animated) + gunmetal top rib + sights
    const slide = this._B(g, M.chrome, 0.028, 0.03, 0.148, 0, 0.014, -0.012);
    g.userData.slide = slide;
    g.userData.slideBaseZ = slide.position.z;
    this._B(g, M.gunmetal, 0.01, 0.006, 0.14, 0, 0.032, -0.012);
    this._B(g, M.gundark, 0.006, 0.007, 0.006, 0, 0.038, -0.078);
    this._B(g, M.gundark, 0.012, 0.007, 0.008, 0, 0.038, 0.055);
    // rear slide serration hint (slightly proud, darker)
    this._B(g, M.gunmetal, 0.0295, 0.024, 0.028, 0, 0.012, 0.048);
    // black frame + squared trigger guard + grip + hammer
    this._B(g, M.gundark, 0.026, 0.024, 0.11, 0, -0.012, -0.01);
    this._B(g, M.gundark, 0.006, 0.005, 0.032, 0, -0.032, -0.008);
    this._B(g, M.gundark, 0.006, 0.018, 0.005, 0, -0.024, -0.025);
    this._B(g, M.polymer, 0.026, 0.06, 0.034, 0, -0.05, 0.038, -0.3, 0, 0);
    this._B(g, M.gunmetal, 0.008, 0.012, 0.008, 0, 0.022, 0.065);
    // huge bore
    this._C(g, M.gundark, 0.0075, 0.006, 0, 0.018, -0.085, 'z');
    this._muzzleAt(g, 0, 0.018, -0.09);
    return g;
  }

  // ---- USP-S: slim black pistol with the signature suppressor ---------------
  _buildUSP() {
    const g = new THREE.Group();
    const M = this.mats;
    const slide = this._B(g, M.gundark, 0.026, 0.028, 0.132, 0, 0.012, -0.008);
    g.userData.slide = slide;
    g.userData.slideBaseZ = slide.position.z;
    // sights
    this._B(g, M.polymer, 0.005, 0.006, 0.005, 0, 0.03, -0.068);
    this._B(g, M.polymer, 0.012, 0.006, 0.007, 0, 0.03, 0.052);
    // polymer frame + accessory rail + rounded trigger guard
    this._B(g, M.polymer, 0.026, 0.022, 0.104, 0, -0.01, -0.012);
    this._B(g, M.polymer, 0.02, 0.008, 0.04, 0, -0.025, -0.045);
    this._B(g, M.polymer, 0.006, 0.005, 0.03, 0, -0.031, -0.004);
    this._B(g, M.polymer, 0.006, 0.016, 0.005, 0, -0.023, -0.021, 0.25, 0, 0);
    // grip
    this._B(g, M.polymer, 0.025, 0.058, 0.032, 0, -0.048, 0.036, -0.26, 0, 0);
    // SUPPRESSOR — the USP-S silhouette
    this._C(g, M.gunmetal, 0.008, 0.014, 0, 0.012, -0.078, 'z');
    this._C(g, M.gundark, 0.0115, 0.078, 0, 0.012, -0.117, 'z');
    this._muzzleAt(g, 0, 0.012, -0.158);
    return g;
  }

  // ---- G-18: boxy polymer, squared trigger guard, tall slide ----------------
  _buildGlock() {
    const g = new THREE.Group();
    const M = this.mats;
    const slide = this._B(g, M.polymer, 0.028, 0.03, 0.122, 0, 0.013, -0.004);
    g.userData.slide = slide;
    g.userData.slideBaseZ = slide.position.z;
    // rear serration hint + sights
    this._B(g, M.grip, 0.0285, 0.022, 0.024, 0, 0.012, 0.045);
    this._B(g, M.grip, 0.005, 0.006, 0.005, 0, 0.031, -0.06);
    this._B(g, M.grip, 0.012, 0.006, 0.007, 0, 0.031, 0.05);
    // lighter polymer frame + squared trigger guard
    this._B(g, M.polymerLight, 0.027, 0.022, 0.1, 0, -0.009, -0.008);
    this._B(g, M.polymerLight, 0.007, 0.005, 0.034, 0, -0.03, -0.008);
    this._B(g, M.polymerLight, 0.007, 0.016, 0.005, 0, -0.022, -0.026);
    // upright boxy grip with backstrap hump
    this._B(g, M.polymerLight, 0.027, 0.058, 0.032, 0, -0.044, 0.036, -0.2, 0, 0);
    this._B(g, M.polymerLight, 0.024, 0.02, 0.01, 0, -0.022, 0.055);
    this._muzzleAt(g, 0, 0.013, -0.068);
    return g;
  }

  // ---- MP-5: stubby SMG, tube receiver, curved mag, front sight ring --------
  _buildMP5() {
    const g = new THREE.Group();
    const M = this.mats;
    // tube upper receiver over a boxy trigger group
    this._C(g, M.gundark, 0.015, 0.135, 0, 0.008, -0.045, 'z');
    this._B(g, M.polymer, 0.028, 0.03, 0.115, 0, -0.014, -0.02);
    // chunky polymer handguard
    this._B(g, M.polymer, 0.033, 0.034, 0.068, 0, -0.008, -0.115);
    // front sight ring + post, rear sight drum
    this._R(g, M.gundark, 0.011, 0, 0.034, -0.15);
    this._B(g, M.gundark, 0.004, 0.014, 0.004, 0, 0.032, -0.15);
    this._C(g, M.gundark, 0.008, 0.012, 0, 0.032, 0.01, 'x');
    // short barrel
    this._C(g, M.gundark, 0.005, 0.045, 0, 0.008, -0.172, 'z');
    // curved magazine (two raked segments)
    const mag = new THREE.Group();
    mag.position.set(0, -0.03, -0.055);
    this._B(mag, M.mag, 0.02, 0.052, 0.032, 0, -0.024, -0.006, 0.35, 0, 0);
    this._B(mag, M.mag, 0.018, 0.048, 0.028, 0, -0.064, -0.032, 0.7, 0, 0);
    g.add(mag);
    g.userData.mag = mag;
    g.userData.magBaseY = mag.position.y;
    // grip + slim stock rails + butt pad
    this._B(g, M.polymer, 0.022, 0.046, 0.028, 0, -0.046, 0.02, -0.3, 0, 0);
    this._B(g, M.gundark, 0.006, 0.008, 0.09, 0.011, 0.006, 0.075);
    this._B(g, M.gundark, 0.006, 0.008, 0.09, -0.011, 0.006, 0.075);
    this._B(g, M.polymer, 0.03, 0.044, 0.012, 0, 0.002, 0.122);
    this._muzzleAt(g, 0, 0.008, -0.198);
    return g;
  }

  // ---- Knife: blade with bright edge bevel, guard, wrapped grip -------------
  _buildKnife() {
    const g = new THREE.Group();
    const M = this.mats;
    // grip + pommel + guard
    this._B(g, M.grip, 0.02, 0.028, 0.088, 0, 0, 0.05);
    this._B(g, M.gunmetal, 0.022, 0.03, 0.012, 0, 0, 0.096);
    this._B(g, M.gunmetal, 0.03, 0.008, 0.012, 0, 0, 0.002);
    // blade: thin slab, bright edge bevel strip, tapered clip point
    this._B(g, M.blade, 0.006, 0.032, 0.15, 0, 0.001, -0.072);
    this._B(g, M.edge, 0.0026, 0.009, 0.146, 0, -0.0155, -0.07);
    this._B(g, M.blade, 0.0055, 0.024, 0.055, 0, 0.003, -0.162, -0.24, 0, 0);
    this._muzzleAt(g, 0, 0, -0.19);
    return g;
  }

  // ---- HE grenade: olive sphere, fuze, safety lever + pull ring -------------
  _buildHE() {
    const g = new THREE.Group();
    const M = this.mats;
    const payload = [];
    payload.push(this._S(g, M.oliveHE, 0.033, 0, 0, 0, 1, 1.12, 1));
    payload.push(this._C(g, M.gunmetal, 0.009, 0.016, 0, 0.043, 0, 'y'));
    payload.push(this._C(g, M.gunmetal, 0.006, 0.008, 0, 0.054, 0, 'y'));
    payload.push(this._B(g, M.steel, 0.01, 0.0035, 0.045, 0.006, 0.038, 0.016, -0.55, 0, 0.1));
    payload.push(this._R(g, M.steel, 0.008, 0.017, 0.045, 0.01, 1.2, 0, 0));
    g.userData.payload = payload;
    this._muzzleAt(g, 0, 0.01, -0.04);
    return g;
  }

  // ---- Flashbang: gray steel cylinder, vent band, lever ---------------------
  _buildFlashbang() {
    const g = new THREE.Group();
    const M = this.mats;
    const payload = [];
    payload.push(this._C(g, M.flashGray, 0.02, 0.075, 0, 0.002, 0, 'y'));
    payload.push(this._C(g, M.gundark, 0.0205, 0.01, 0, -0.012, 0, 'y')); // vent band
    payload.push(this._C(g, M.gunmetal, 0.014, 0.012, 0, 0.045, 0, 'y'));
    payload.push(this._C(g, M.gunmetal, 0.006, 0.01, 0, 0.056, 0, 'y'));
    payload.push(this._B(g, M.steel, 0.009, 0.0035, 0.042, 0.005, 0.042, 0.014, -0.55, 0, 0.1));
    payload.push(this._R(g, M.steel, 0.008, 0.016, 0.048, 0.008, 1.2, 0, 0));
    g.userData.payload = payload;
    this._muzzleAt(g, 0, 0.01, -0.04);
    return g;
  }

  // ---- Smoke: taller olive-drab canister with a pale marking band -----------
  _buildSmoke() {
    const g = new THREE.Group();
    const M = this.mats;
    const payload = [];
    payload.push(this._C(g, M.smokeBody, 0.022, 0.088, 0, 0, 0, 'y'));
    payload.push(this._C(g, M.band, 0.0225, 0.012, 0, 0.028, 0, 'y'));
    payload.push(this._C(g, M.gunmetal, 0.015, 0.012, 0, 0.05, 0, 'y'));
    payload.push(this._C(g, M.gunmetal, 0.006, 0.01, 0, 0.061, 0, 'y'));
    payload.push(this._B(g, M.steel, 0.009, 0.0035, 0.044, 0.005, 0.048, 0.015, -0.55, 0, 0.1));
    payload.push(this._R(g, M.steel, 0.008, 0.016, 0.054, 0.008, 1.2, 0, 0));
    g.userData.payload = payload;
    this._muzzleAt(g, 0, 0.01, -0.04);
    return g;
  }
}
