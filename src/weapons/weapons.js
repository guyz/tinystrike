// ============================================================================
// OPERATION GOLDENEYE — src/weapons/weapons.js (module D)
//
// Player inventory + firing state machine. This module NEVER raycasts — it
// emits 'weapon:fire' and combat resolves hits. It owns:
//   - slots / ammo / current weapon, equip + reload + throw state machine
//   - CS-style recoil: recoilIndex-driven spray pattern (aim drift), bloom
//     that recovers on trigger discipline, movement/jump inaccuracy
//   - AWP scope: RMB zoom levels with smooth camera fov lerp (this module
//     writes game.camera.fov), shot forces brief unscope + bolt delay
//   - buy() with money / canBuy / slot-replacement rules + armor & kit
//
// Events emitted: weapon:fire, weapon:dryfire, weapon:equip,
// weapon:reload:start, weapon:reload:end, weapon:scope, grenade:throw,
// econ:buy, ui:toggle-buy.
// ============================================================================

import * as THREE from 'three';
import { WEAPONS, GEAR, BUY_MENU } from './data.js';

const SWITCH_TIME = 0.6;        // standard raise time
const FAST_SWITCH_TIME = 0.35;  // post-throw / round-start raise
const THROW_DUR = 0.5;          // full throw animation length
const THROW_RELEASE = 0.11;     // seconds into the throw when grenade leaves hand
const DRYFIRE_INTERVAL = 0.35;  // min gap between dry-fire clicks
const RESCOPE_DELAY = 1.05;     // AWP: bolt time before auto re-scope
const FOV_LERP_RATE = 12;       // per-second exponential fov approach
const DRIFT_CLAMP = 0.22;       // max accumulated aim drift (rad)
const SCOPED_MOVE_SCALE = 0.55; // extra move slowdown while scoped (feel)

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// Box-Muller gaussian (per-shot only — never in a hot loop).
function gauss() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export default class Weapons {
  constructor(game) {
    this.game = game;

    // ---- public inventory state -------------------------------------------
    this.slots = { 1: null, 2: null, 3: 'knife', 4: [] };
    this.ammo = {};              // id -> { mag, reserve }
    this.currentId = 'knife';
    this.lastWeaponId = null;
    this.scopeLevel = 0;         // 0 / 1 / 2

    // ---- internal state machine -------------------------------------------
    this._now = 0;
    this._state = 'idle';        // idle | equipping | reloading | winding | throwing
    this._stateT = 0;
    this._stateDur = 0;
    this._thrown = false;

    this._nextFireAt = 0;
    this._lastShotAt = -10;
    this._dryAt = 0;

    // Recoil: spray-pattern aim drift + bloom (extra spread from firing).
    this._recoilIndexF = 0;      // continuous; floor() indexes the pattern
    this._driftP = 0;            // accumulated pitch drift (rad, + = up)
    this._driftY = 0;            // accumulated yaw drift (rad)
    this._bloom = 0;

    // One-frame input queues (set by event handlers, consumed in update).
    this._semiQueued = false;
    this._rmbQueued = false;
    this._releaseQueued = false;

    // AWP scope / fov.
    const baseFov =
      (game.config && game.config.PLAYER && game.config.PLAYER.FOV) || 74;
    this._fovTarget = baseFov;
    this._fovCurrent = baseFov;
    this._rescopeAt = -1;
    this._rescopeLevel = 0;

    this._everReset = false;

    // Scratch vectors (never allocated per frame).
    this._fwd = new THREE.Vector3();

    const ev = game.events;
    this._onMouseDown = this._onMouseDown.bind(this);
    this._onMouseUp = this._onMouseUp.bind(this);
    this._onWheel = this._onWheel.bind(this);
    this._onKey = this._onKey.bind(this);
    ev.on('input:mousedown', this._onMouseDown);
    ev.on('input:mouseup', this._onMouseUp);
    ev.on('input:wheel', this._onWheel);
    ev.on('input:keydown', this._onKey);
    ev.on('ui:restart', () => {
      // Full match reset: next resetForRound() deals a fresh loadout.
      this._everReset = false;
    });
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  current() {
    return WEAPONS[this.currentId] || WEAPONS.knife;
  }

  currentAmmo() {
    const def = this.current();
    if (!def || def.melee) return null;
    if (def.slot === 4) {
      const a = this.ammo[def.id];
      return a || { mag: 0, reserve: 0 };
    }
    return this.ammo[def.id] || null;
  }

  currentMoveMult() {
    const def = this.current();
    let mult = def && typeof def.moveSpeedMult === 'number' ? def.moveSpeedMult : 1;
    if (this.scopeLevel > 0) mult *= SCOPED_MOVE_SCALE;
    return mult;
  }

  // Total cone half-angle (rad). HUD crosshair gap reads this every frame.
  currentSpread() {
    const def = this.current();
    if (!def || def.melee || def.slot === 4) return 0;
    const g = this.game;
    const p = g.player;
    const scoped = this.scopeLevel > 0;

    let spread;
    if (def.zoomFov && !scoped) {
      spread = def.spreadUnscoped !== undefined ? def.spreadUnscoped : 0.05;
    } else {
      spread = def.spreadBase;
    }

    // Movement inaccuracy — rewards stopping to shoot. Superlinear so a slow
    // counter-strafe shoulder-peek stays usable while full sprint is punished.
    if (p && typeof p.moveSpeed2D === 'number') {
      const run = (g.config && g.config.PLAYER && g.config.PLAYER.RUN_SPEED) || 5.2;
      const frac = clamp(p.moveSpeed2D / run, 0, 1);
      let movePen = def.spreadMove * Math.pow(frac, 1.35);
      if (scoped) movePen *= 0.5; // scoped halves the move penalty
      spread += movePen;
    }
    if (p && p.onGround === false) spread += def.spreadJump;

    spread += this._bloom;

    if (p && p.crouching) spread *= 0.8;
    return spread;
  }

  isScoped() {
    return this.scopeLevel > 0;
  }

  owns(id) {
    if (!id) return false;
    if (this.slots[1] === id || this.slots[2] === id || this.slots[3] === id) return true;
    return this.slots[4].indexOf(id) !== -1;
  }

  // Switch to an owned weapon (0.6 s raise). Emits 'weapon:equip'.
  equip(id) {
    if (!id || !WEAPONS[id] || !this.owns(id)) return false;
    if (id === this.currentId && this._state !== 'throwing') return false;
    this._forceEquip(id, SWITCH_TIME, true);
    return true;
  }

  // Grant a weapon without charging (round-start loadouts, debug).
  give(id, free) {
    void free; // grants are always free; param kept for API compatibility
    const def = WEAPONS[id];
    if (!def) return false;
    if (def.slot === 4) {
      const max = def.maxCarry || def.magSize || 1;
      if (this._grenadeCount(id) >= max) return false;
      this.slots[4].push(id);
      this._syncGrenadeAmmo(id);
      return true;
    }
    if (def.slot === 3) {
      this.slots[3] = 'knife';
      return true;
    }
    const old = this.slots[def.slot];
    if (old && old !== id) delete this.ammo[old];
    this.slots[def.slot] = id;
    this.ammo[id] = { mag: def.magSize, reserve: def.reserve };
    return true;
  }

  // Robust purchase: money, buy window (game.state.canBuy from rounds), slot
  // replacement, grenade carry caps, and 'armor' / 'kit' pseudo-items.
  buy(id) {
    const g = this.game;
    const state = g.state;
    if (!state) return false;

    const canBuy =
      typeof state.canBuy === 'boolean' ? state.canBuy : state.phase === 'freeze';
    if (!canBuy) return false;

    const player = g.player;
    if (player && player.alive === false) return false;

    const econ = (g.config && g.config.ECON) || {};

    // ---- gear pseudo-items ------------------------------------------------
    if (id === 'armor') {
      const price = econ.ARMOR_PRICE !== undefined ? econ.ARMOR_PRICE : 650;
      const maxArmor =
        (g.config && g.config.PLAYER && g.config.PLAYER.MAX_ARMOR) || 100;
      if (state.money < price) return false;
      if (player && player.armor >= maxArmor) return false;
      if (player) player.armor = maxArmor;
      state.money = Math.max(0, state.money - price);
      g.events.emit('econ:buy', { id: id, price: price });
      return true;
    }
    if (id === 'kit') {
      const price = econ.KIT_PRICE !== undefined ? econ.KIT_PRICE : 400;
      if (state.money < price) return false;
      if (player && player.hasKit) return false;
      if (player) player.hasKit = true;
      state.money = Math.max(0, state.money - price);
      g.events.emit('econ:buy', { id: id, price: price });
      return true;
    }

    // ---- real weapons -----------------------------------------------------
    const def = WEAPONS[id];
    if (!def || !def.price) return false;
    if (state.money < def.price) return false;

    if (def.slot === 4) {
      const max = def.maxCarry || def.magSize || 1;
      if (this._grenadeCount(id) >= max) return false;
      this.slots[4].push(id);
      this._syncGrenadeAmmo(id);
    } else if (def.slot === 1 || def.slot === 2) {
      const old = this.slots[def.slot];
      if (old === id) return false; // already own this exact weapon
      if (old) delete this.ammo[old];
      this.slots[def.slot] = id;
      this.ammo[id] = { mag: def.magSize, reserve: def.reserve };
      // CS-style: a freshly bought gun goes straight into your hands (this
      // also covers the spec's "auto-equip if slot empty" case).
      this._forceEquip(id, SWITCH_TIME, true);
    } else {
      return false;
    }

    state.money = Math.max(0, state.money - def.price);
    g.events.emit('econ:buy', { id: id, price: def.price });
    return true;
  }

  dropCurrent() {
    // Optional per spec — intentional no-op.
    return false;
  }

  // Round-start loadout. rounds passes { died }: survivors keep guns (mags
  // refilled free, grenades kept); on death (or match start) back to USP+knife.
  resetForRound(opts) {
    const died = !!(opts && typeof opts === 'object' ? opts.died : opts);
    const fresh = !this._everReset || died;
    this._everReset = true;

    if (fresh) {
      this.slots = { 1: null, 2: 'usp', 3: 'knife', 4: [] };
      this.ammo = {};
      const usp = WEAPONS.usp;
      this.ammo.usp = { mag: usp.magSize, reserve: usp.reserve };
    } else {
      const s1 = this.slots[1];
      const s2 = this.slots[2];
      if (s1 && WEAPONS[s1]) {
        this.ammo[s1] = { mag: WEAPONS[s1].magSize, reserve: WEAPONS[s1].reserve };
      }
      if (s2 && WEAPONS[s2]) {
        this.ammo[s2] = { mag: WEAPONS[s2].magSize, reserve: WEAPONS[s2].reserve };
      }
      this._syncGrenadeAmmo('hegrenade');
      this._syncGrenadeAmmo('flashbang');
      this._syncGrenadeAmmo('smokegrenade');
    }

    // Wipe transient combat state.
    this._nextFireAt = 0;
    this._lastShotAt = -10;
    this._dryAt = 0;
    this._semiQueued = false;
    this._rmbQueued = false;
    this._releaseQueued = false;
    this._recoilIndexF = 0;
    this._driftP = 0;
    this._driftY = 0;
    this._bloom = 0;
    this._cancelActivity(); // also unscopes + resets fov target to base

    // Snap fov instantly across the round transition (no visible zoom-out).
    this._fovCurrent = this._fovTarget;
    const cam = this.game.camera;
    if (cam && Math.abs(cam.fov - this._fovCurrent) > 0.01) {
      cam.fov = this._fovCurrent;
      cam.updateProjectionMatrix();
    }

    const target = fresh
      ? this.slots[2] || 'knife'
      : this.owns(this.currentId)
        ? this.currentId
        : this.slots[1] || this.slots[2] || 'knife';
    this.lastWeaponId = null;
    this._forceEquip(target, FAST_SWITCH_TIME, false);
  }

  // ==========================================================================
  // Per-frame update
  // ==========================================================================
  update(dt) {
    this._now += dt;

    const g = this.game;
    const state = g.state;
    const player = g.player;   // lazy sibling lookup every frame (rule 9)
    const input = g.input;

    this._updateFov(dt);

    const def = this.current();
    const phase = state ? state.phase : 'menu';
    const canAct =
      player &&
      player.alive !== false &&
      phase !== 'menu' &&
      phase !== 'gameEnd';

    if (!canAct) {
      // Dead / menu: no shooting, no scope. Drop any in-progress action.
      if (this.scopeLevel > 0 || this._fovTarget !== this._baseFov()) this._unscope();
      if (this._state === 'winding' || this._state === 'throwing') this._state = 'idle';
      this._semiQueued = false;
      this._rmbQueued = false;
      this._releaseQueued = false;
      this._decayRecoil(dt, def);
      return;
    }

    // ---- advance state machine timers -------------------------------------
    if (this._state === 'equipping') {
      this._stateT += dt;
      if (this._stateT >= this._stateDur) this._state = 'idle';
    } else if (this._state === 'reloading') {
      this._stateT += dt;
      if (this._stateT >= this._stateDur) {
        const rdef = this.current();
        const ammo = this.ammo[rdef.id];
        if (ammo && rdef.magSize > 0) {
          const take = Math.min(rdef.magSize - ammo.mag, ammo.reserve);
          ammo.mag += take;
          ammo.reserve -= take;
        }
        this._state = 'idle';
        g.events.emit('weapon:reload:end', { id: rdef.id });
      }
    } else if (this._state === 'throwing') {
      this._stateT += dt;
      if (!this._thrown && this._stateT >= THROW_RELEASE) {
        this._thrown = true;
        this._emitThrow(def, player);
      }
      if (this._stateT >= this._stateDur) {
        this._state = 'idle';
        const next = this.owns(def.id)
          ? def.id
          : this.slots[1] || this.slots[2] || 'knife';
        this._forceEquip(next, FAST_SWITCH_TIME, false);
      }
    }

    // ---- AWP auto re-scope after bolt cycle --------------------------------
    if (this._rescopeAt > 0 && this._now >= this._rescopeAt) {
      this._rescopeAt = -1;
      const d = this.current();
      if (d.zoomFov && this._state === 'idle') {
        this.scopeLevel = this._rescopeLevel;
        const fov = d.zoomFov[this.scopeLevel - 1];
        this._fovTarget = fov;
        g.events.emit('weapon:scope', { level: this.scopeLevel, fov: fov });
      }
    }

    // ---- RMB: scope toggle -------------------------------------------------
    if (this._rmbQueued) {
      this._rmbQueued = false;
      this._toggleScope();
    }

    const buyOpen = !!(state && state.buyOpen);
    const held = !!(input && input.firing && input.locked !== false);
    const isGrenade = def.slot === 4;

    // ---- grenade wind-up / release ----------------------------------------
    if (this._state === 'winding') {
      if (!isGrenade || phase === 'freeze' || buyOpen) {
        this._state = 'idle'; // cancelled, grenade not consumed
      } else if (this._releaseQueued || !held) {
        this._state = 'throwing';
        this._stateT = 0;
        this._stateDur = THROW_DUR;
        this._thrown = false;
      }
    }

    const fireBlocked =
      phase === 'freeze' ||
      buyOpen ||
      this._state === 'equipping' ||
      this._state === 'reloading' ||
      this._state === 'winding' ||
      this._state === 'throwing';

    // ---- trigger -----------------------------------------------------------
    if (!fireBlocked) {
      if (isGrenade) {
        // Fresh click pulls the pin; release throws.
        if (this._semiQueued && this._grenadeCount(def.id) > 0) {
          this._state = 'winding';
          this._stateT = 0;
          this._stateDur = 0;
        }
      } else if (this._semiQueued || (def.auto && held)) {
        this._tryFire(def, player);
      }
    }
    this._semiQueued = false;
    this._releaseQueued = false;

    // ---- recoil / bloom recovery (trigger discipline pays off) -------------
    this._decayRecoil(dt, def);
  }

  // ==========================================================================
  // Input event handlers (queue only; consumed in update)
  // ==========================================================================
  _onMouseDown(e) {
    if (!e) return;
    if (e.button === 0) this._semiQueued = true;
    else if (e.button === 2) this._rmbQueued = true;
  }

  _onMouseUp(e) {
    if (e && e.button === 0) this._releaseQueued = true;
  }

  _onWheel(e) {
    const dir = e && e.dir ? e.dir : 0;
    if (!dir) return;
    const list = this._equipList();
    if (list.length < 2) return;
    let idx = list.indexOf(this.currentId);
    if (idx === -1) idx = 0;
    const next = list[(idx + (dir > 0 ? 1 : -1) + list.length) % list.length];
    this.equip(next);
  }

  _onKey(e) {
    const key = e && e.key;
    if (!key) return;
    switch (key) {
      case '1':
        if (this.slots[1]) this.equip(this.slots[1]);
        break;
      case '2':
        if (this.slots[2]) this.equip(this.slots[2]);
        break;
      case '3':
        this.equip('knife');
        break;
      case '4':
        this._cycleGrenade();
        break;
      case 'q': {
        const last = this.lastWeaponId;
        if (last && this.owns(last)) this.equip(last);
        break;
      }
      case 'r':
        this._startReload();
        break;
      case 'b':
        this.game.events.emit('ui:toggle-buy');
        break;
      default:
        break;
    }
  }

  // ==========================================================================
  // Firing
  // ==========================================================================
  _tryFire(def, player) {
    if (this._now < this._nextFireAt) return;

    if (def.melee) {
      this._nextFireAt = this._now + 60 / def.rpm;
      this._fireShot(def, player, true);
      return;
    }

    const ammo = this.ammo[def.id];
    if (!ammo || ammo.mag <= 0) {
      this._tryDryFire(def, ammo);
      return;
    }

    ammo.mag -= 1;
    this._nextFireAt = this._now + 60 / def.rpm;
    this._fireShot(def, player, false);

    // AWP: shot forces a brief unscope while the bolt cycles, then re-scopes.
    if (def.zoomFov && this.scopeLevel > 0) {
      this.scopeLevel = 0;
      const base = this._baseFov();
      this._fovTarget = base;
      this.game.events.emit('weapon:scope', { level: 0, fov: base });
      this._rescopeAt = this._now + RESCOPE_DELAY;
      this._rescopeLevel = 1;
    }
  }

  _tryDryFire(def, ammo) {
    // The click sound is rate-limited; the auto-reload is not — an empty
    // trigger pull always racks a reload when there's reserve ammo.
    if (this._now >= this._dryAt) {
      this._dryAt = this._now + DRYFIRE_INTERVAL;
      this.game.events.emit('weapon:dryfire', { id: def.id });
    }
    if (ammo && ammo.reserve > 0) this._startReload();
  }

  _fireShot(def, player, melee) {
    const cam = this.game.camera;
    cam.getWorldDirection(this._fwd);

    // Decompose camera forward into yaw/pitch so drift + spread apply in
    // stable angular space regardless of camera convention.
    let pitch = Math.asin(clamp(this._fwd.y, -1, 1));
    let yaw = Math.atan2(this._fwd.x, this._fwd.z);

    if (!melee) {
      // Current shot flies with the EXISTING drift (first bullet true to the
      // crosshair) plus a gaussian sample of the live spread cone.
      const spread = this.currentSpread();
      const sigma = spread * 0.45;
      pitch += this._driftP + clamp(gauss() * sigma, -spread, spread);
      yaw += this._driftY + clamp(gauss() * sigma, -spread, spread);
    }

    const cp = Math.cos(pitch);
    // Per-shot allocation is fine — event consumers may retain these.
    const dir = new THREE.Vector3(Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp);
    const origin = player.eyePos().clone();

    const payload = { weaponId: def.id, origin: origin, dir: dir, byPlayer: true };
    if (melee) payload.melee = true;
    this.game.events.emit('weapon:fire', payload);
    this._lastShotAt = this._now;

    if (melee) {
      if (player.addViewPunch) {
        player.addViewPunch(0.006, (Math.random() - 0.5) * 0.006);
      }
      return;
    }

    // ---- advance the spray: pattern kick joins the drift AFTER this shot ---
    const rec = def.recoil;
    const pat = rec.pattern;
    let kp = rec.pitchPerShot;
    let ky = 0;
    if (pat && pat.length) {
      const idx = Math.min(pat.length - 1, this._recoilIndexF | 0);
      kp = pat[idx].p;
      ky = pat[idx].y;
    }
    this._driftP = Math.min(DRIFT_CLAMP, this._driftP + kp);
    this._driftY = clamp(this._driftY + ky, -DRIFT_CLAMP, DRIFT_CLAMP);
    this._recoilIndexF = Math.min(pat && pat.length ? pat.length : 30, this._recoilIndexF + 1);
    this._bloom = Math.min(def.bloomMax, this._bloom + def.bloomPerShot);

    // Cosmetic view kick (player decays it ~8/s) — part of the punch feel;
    // the aim drift above is what actually steers bullets.
    if (player.addViewPunch) {
      player.addViewPunch(
        kp * 0.45,
        ky * 0.5 + (Math.random() - 0.5) * rec.yawJitter
      );
    }
  }

  // Recoil recovery: drift and recoilIndex unwind once the trigger rests;
  // bloom recovers continuously, much faster off-trigger.
  _decayRecoil(dt, def) {
    const rec = def && def.recoil ? def.recoil : null;
    const interval = def && def.rpm > 0 ? 60 / def.rpm : 0.2;
    const idleFor = this._now - this._lastShotAt;

    if (idleFor > interval * 1.6 + 0.06) {
      const rate = rec ? rec.recovery : 8;
      const k = Math.exp(-rate * dt);
      this._driftP *= k;
      this._driftY *= k;
      if (Math.abs(this._driftP) < 1e-4) this._driftP = 0;
      if (Math.abs(this._driftY) < 1e-4) this._driftY = 0;
      this._recoilIndexF = Math.max(0, this._recoilIndexF - dt * rate * 1.6);
    }

    if (this._bloom > 0) {
      const brate = idleFor > interval + 0.05 ? 5 : 1.2;
      this._bloom *= Math.exp(-brate * dt);
      if (this._bloom < 1e-5) this._bloom = 0;
    }
  }

  // ==========================================================================
  // Grenades
  // ==========================================================================
  _emitThrow(def, player) {
    const cam = this.game.camera;
    cam.getWorldDirection(this._fwd);
    const dir = this._fwd.clone();
    const origin = player.eyePos().clone();
    this.game.events.emit('grenade:throw', {
      type: def.id,
      origin: origin,
      dir: dir,
      strength: def.throwStrength || 14,
    });
    this._consumeGrenade(def.id);
  }

  _grenadeCount(id) {
    const arr = this.slots[4];
    let n = 0;
    for (let i = 0; i < arr.length; i++) if (arr[i] === id) n++;
    return n;
  }

  _consumeGrenade(id) {
    const arr = this.slots[4];
    const i = arr.indexOf(id);
    if (i !== -1) arr.splice(i, 1);
    this._syncGrenadeAmmo(id);
  }

  _syncGrenadeAmmo(id) {
    const n = this._grenadeCount(id);
    if (n > 0) {
      let a = this.ammo[id];
      if (!a) {
        a = { mag: 0, reserve: 0 };
        this.ammo[id] = a;
      }
      a.mag = n;
      a.reserve = 0;
    } else {
      delete this.ammo[id];
    }
  }

  _cycleGrenade() {
    const order = ['hegrenade', 'flashbang', 'smokegrenade'];
    const owned = [];
    for (let i = 0; i < order.length; i++) {
      if (this._grenadeCount(order[i]) > 0) owned.push(order[i]);
    }
    if (!owned.length) return;
    const cur = owned.indexOf(this.currentId);
    const next = owned[(cur + 1) % owned.length];
    this.equip(next);
  }

  // ==========================================================================
  // Equip / reload
  // ==========================================================================
  _equipList() {
    const out = [];
    if (this.slots[1]) out.push(this.slots[1]);
    if (this.slots[2]) out.push(this.slots[2]);
    if (this.slots[3]) out.push(this.slots[3]);
    const seen = {};
    const g4 = this.slots[4];
    for (let i = 0; i < g4.length; i++) {
      if (!seen[g4[i]]) {
        seen[g4[i]] = 1;
        out.push(g4[i]);
      }
    }
    return out;
  }

  _forceEquip(id, dur, trackLast) {
    this._cancelActivity();
    if (trackLast && id !== this.currentId) this.lastWeaponId = this.currentId;
    this.currentId = id;
    this._state = 'equipping';
    this._stateT = 0;
    this._stateDur = dur;
    // Switching resets the spray — CS muscle memory.
    this._recoilIndexF = 0;
    this._driftP = 0;
    this._driftY = 0;
    this._bloom = 0;
    this.game.events.emit('weapon:equip', { id: id });
  }

  _cancelActivity() {
    // Cancels reload / wind-up / throw-in-progress silently. A grenade whose
    // pin was pulled but not yet released is kept (no consume happened).
    this._state = 'idle';
    this._stateT = 0;
    this._stateDur = 0;
    this._thrown = false;
    this._unscope();
  }

  _startReload() {
    const def = this.current();
    if (!def || def.melee || def.slot === 4 || def.magSize <= 0) return;
    if (
      this._state === 'reloading' ||
      this._state === 'equipping' ||
      this._state === 'winding' ||
      this._state === 'throwing'
    ) {
      return;
    }
    const ammo = this.ammo[def.id];
    if (!ammo || ammo.reserve <= 0 || ammo.mag >= def.magSize) return;
    const player = this.game.player;
    if (player && player.alive === false) return;

    this._unscope(); // reloading the AWP drops the scope
    this._state = 'reloading';
    this._stateT = 0;
    this._stateDur = def.reloadTime;
    this.game.events.emit('weapon:reload:start', { id: def.id, duration: def.reloadTime });
  }

  // ==========================================================================
  // Scope / FOV
  // ==========================================================================
  _baseFov() {
    const cfg = this.game.config;
    return (cfg && cfg.PLAYER && cfg.PLAYER.FOV) || 74;
  }

  _toggleScope() {
    const def = this.current();
    if (!def || !def.zoomFov) return;
    if (this._state !== 'idle') return;
    this._rescopeAt = -1; // manual toggle overrides a pending auto re-scope
    const levels = def.zoomFov.length;
    this.scopeLevel = (this.scopeLevel + 1) % (levels + 1);
    const fov =
      this.scopeLevel === 0 ? this._baseFov() : def.zoomFov[this.scopeLevel - 1];
    this._fovTarget = fov;
    this.game.events.emit('weapon:scope', { level: this.scopeLevel, fov: fov });
  }

  _unscope() {
    this._rescopeAt = -1;
    const base = this._baseFov();
    if (this.scopeLevel > 0) {
      this.scopeLevel = 0;
      this._fovTarget = base;
      this.game.events.emit('weapon:scope', { level: 0, fov: base });
    } else {
      this._fovTarget = base;
    }
  }

  _updateFov(dt) {
    const diff = this._fovTarget - this._fovCurrent;
    if (diff === 0) return;
    if (Math.abs(diff) < 0.02) {
      this._fovCurrent = this._fovTarget;
    } else {
      this._fovCurrent += diff * (1 - Math.exp(-FOV_LERP_RATE * dt));
    }
    const cam = this.game.camera;
    if (cam) {
      cam.fov = this._fovCurrent;
      cam.updateProjectionMatrix();
    }
  }
}

// Re-exports for convenience (bots/HUD may import from either file).
export { WEAPONS, GEAR, BUY_MENU };
