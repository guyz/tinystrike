// ---------------------------------------------------------------------------
// OPERATION GOLDENEYE — src/player/player.js
//
// First-person player controller: CS-style ground/air movement, camera rig
// (view bob, landing dip, view punch, shake), crouch/walk states, health &
// armor, footsteps, and the hit capsule used by combat.
//
// Camera composition order (never pollutes aim state):
//   base yaw/pitch (aim)  ->  view punch offsets  ->  shake offsets
// ---------------------------------------------------------------------------

import * as THREE from 'three';

// ---- tuning (module-local feel constants; gameplay numbers live in CONFIG) --
const LOOK_SENS = 0.0022;        // rad per pixel of mouse movement
const PITCH_CLAMP = 1.45;        // rad
const PUNCH_DECAY = 8;           // 1/s exponential decay toward zero
const PUNCH_CLAMP = 0.5;         // rad, sanity cap on accumulated punch
const SHAKE_DECAY = 4.2;         // 1/s
const SHAKE_MAX = 1.5;           // accumulated shake amplitude cap
const CROUCH_LERP = 12;          // 1/s eye/hitbox height lerp
const BOB_LERP = 10;             // 1/s bob amplitude fade in/out
const BOB_AMP_V = 0.016;         // m vertical bob at full run (<= 0.02 per spec)
const BOB_AMP_L = 0.011;         // m lateral sway
const BOB_ROLL = 0.004;          // rad roll sway
const STRAFE_LEAN = 0.008;       // rad roll while strafing at full speed
const BREATHE_AMP = 0.0022;      // m idle breathing rise/fall
const STRIDE = 2.5;              // m between footstep events
const FOOTSTEP_MIN_SPEED = 2;    // m/s: below this no footsteps
const LAND_MIN_SPEED = 3;        // m/s down: emits 'player:land' + dip
const JUMP_BUFFER = 0.15;        // s: pressing jump slightly early still hops
const JUMP_COOLDOWN = 0.25;      // s between jumps (prevents pogo jitter)
const DIP_SPRING_K = 130;        // landing-dip spring stiffness
const DIP_SPRING_C = 13;         // landing-dip damping (slightly underdamped)
const DIP_PER_MS = 0.028;        // dip impulse per m/s of landing speed
const DIP_MAX = 0.15;            // m max downward dip
const TERMINAL_FALL = 30;        // m/s max fall speed
const DEATH_TILT = -0.5;         // rad: dead camera pitches down toward this
const DEATH_ROLL = 0.32;         // rad: slump roll when dead
const DEATH_EYE = 0.5;           // m: dead camera sinks toward this height

// ---- shared scratch (never allocate in the frame loop) ----------------------
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _wish = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _rayOrigin = new THREE.Vector3();
const _standBox = new THREE.Box3();
const DOWN = new THREE.Vector3(0, -1, 0);

export default class Player {
  constructor(game) {
    this.game = game;
    const P = game.config.PLAYER;

    // ---- public state (spec section C) ----
    this.position = new THREE.Vector3(0, 0, 0);   // feet
    this.velocity = new THREE.Vector3(0, 0, 0);
    this.yaw = 0;
    this.pitch = 0;
    this.health = P.MAX_HEALTH;
    this.armor = 0;
    this.hasKit = false;
    this.alive = true;
    this.team = game.config.TEAM ? game.config.TEAM.CT : 'ct';
    this.onGround = false;
    this.crouching = false;
    this.walking = false;
    this.moveSpeed2D = 0;
    this.eyeHeight = P.EYE_STAND;
    this.radius = P.RADIUS;

    // ---- internal state ----
    this._heightCur = P.HEIGHT_STAND;  // current hitbox height (lerps)
    this._punchPitch = 0;              // view punch (recoil) offsets, rad
    this._punchYaw = 0;
    this._shakeAmp = 0;                // camera shake amplitude 0..SHAKE_MAX
    this._shakeTime = 0;
    this._bobPhase = 0;                // advances with distance traveled
    this._bobAmp = 0;                  // smoothed 0..1 bob intensity
    this._breatheTime = 0;
    this._dipY = 0;                    // landing dip spring (negative = down)
    this._dipVel = 0;
    this._stepAccum = 0;               // meters since last footstep
    this._jumpQueued = 0;              // seconds left on buffered jump press
    this._jumpCooldown = 0;
    this._deathBlend = 0;              // 0..1 ease into death camera
    this._deathEyeStart = P.EYE_STAND;

    // reused return objects (allocate-free getters)
    this._eyeTemp = new THREE.Vector3();
    this._capsule = { pos: new THREE.Vector3(), radius: P.RADIUS, height: P.HEIGHT_STAND };

    // camera rig uses YXZ so yaw/pitch/roll compose intuitively
    if (game.camera) game.camera.rotation.order = 'YXZ';

    // buffered jump: real keydown only (Input suppresses auto-repeat)
    game.events.on('input:keydown', (p) => {
      if (p && p.key === ' ') this._jumpQueued = JUMP_BUFFER;
    });
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** World-space eye position. Returns an internal temp — clone to keep. */
  eyePos() {
    return this._eyeTemp.set(
      this.position.x,
      this.position.y + this.eyeHeight,
      this.position.z
    );
  }

  /**
   * Recoil kick. Offsets are applied on top of yaw/pitch when composing the
   * camera and decay exponentially (~8/s) — aim direction is never modified.
   */
  addViewPunch(pitchRad, yawRad) {
    this._punchPitch = THREE.MathUtils.clamp(this._punchPitch + (pitchRad || 0), -PUNCH_CLAMP, PUNCH_CLAMP);
    this._punchYaw = THREE.MathUtils.clamp(this._punchYaw + (yawRad || 0), -PUNCH_CLAMP, PUNCH_CLAMP);
  }

  /** Brief camera shake (explosions). strength ~0..1, stacks with a cap. */
  addShake(strength) {
    if (!(strength > 0)) return;
    this._shakeAmp = Math.min(SHAKE_MAX, this._shakeAmp + strength);
  }

  /**
   * Apply incoming damage with CS armor math:
   *   healthDmg = armor > 0 ? amount * ARMOR_DAMAGE_SCALE : amount
   *   armor    -= amount * 0.5 (floored at 0)
   * Emits 'player:damage' and (once, at <= 0 hp) 'player:death'.
   */
  takeDamage(amount, info) {
    if (!this.alive || !(amount > 0)) return;
    const game = this.game;
    if (game.state.phase === 'menu') return;
    info = info || {};

    let healthDmg;
    if (this.armor > 0) {
      // Helmets mitigate far less than body armor (CS-style): rifle headshots
      // stay lethal through armor.
      const scale = info.headshot ? 0.85 : game.config.ARMOR_DAMAGE_SCALE;
      healthDmg = amount * scale;
      this.armor = Math.max(0, this.armor - amount * 0.5);
    } else {
      healthDmg = amount;
    }
    this.health -= healthDmg;

    // direction indicator: world yaw from player toward the attacker,
    // in the same convention as this.yaw (yaw 0 faces -Z).
    let dirYaw = this.yaw;
    const from = info.from;
    const fromPos = from ? (from.pos || from.position) : null;
    if (fromPos && typeof fromPos.x === 'number') {
      const dx = fromPos.x - this.position.x;
      const dz = fromPos.z - this.position.z;
      if (dx * dx + dz * dz > 1e-6) dirYaw = Math.atan2(-dx, -dz);
    }

    // small aim flinch — punch only, never moves true aim
    const flinch = 0.005 + Math.min(healthDmg, 60) * 0.0004;
    this.addViewPunch(flinch, (Math.random() - 0.5) * 0.008);

    game.events.emit('player:damage', { amount: healthDmg, from: from || null, dirYaw });

    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
      this.velocity.set(0, 0, 0);
      this._deathBlend = 0;
      this._deathEyeStart = this.eyeHeight;
      game.events.emit('player:death', {
        killer: from || null,
        weapon: info.weapon || null,
        headshot: !!info.headshot,
      });
    }
  }

  /** Round reset: full health, keep bought armor/kit, respawn at spawn. */
  resetForRound(spawn) {
    const P = this.game.config.PLAYER;
    if (spawn) {
      if (spawn.pos) this.position.copy(spawn.pos);
      if (typeof spawn.yaw === 'number') this.yaw = spawn.yaw;
    }
    this.pitch = 0;
    this.health = P.MAX_HEALTH;
    this.alive = true;
    this.velocity.set(0, 0, 0);
    this.onGround = false;
    this.crouching = false;
    this.walking = false;
    this.moveSpeed2D = 0;
    this._heightCur = P.HEIGHT_STAND;
    this.eyeHeight = P.EYE_STAND;
    this._punchPitch = 0;
    this._punchYaw = 0;
    this._shakeAmp = 0;
    this._dipY = 0;
    this._dipVel = 0;
    this._bobAmp = 0;
    this._bobPhase = 0;
    this._stepAccum = 0;
    this._jumpQueued = 0;
    this._jumpCooldown = 0;
    this._deathBlend = 0;
    // discard look deltas accumulated while dead / in menus so the view
    // doesn't snap on spawn
    const input = this.game.input;
    if (input && typeof input.consumeLook === 'function') input.consumeLook();
  }

  /** Hitbox for enemy fire. Reused object — read immediately, don't keep. */
  hitCapsule() {
    const c = this._capsule;
    c.pos.copy(this.position);
    c.radius = this.radius;
    c.height = this._heightCur;
    return c;
  }

  // -------------------------------------------------------------------------
  // Frame update
  // -------------------------------------------------------------------------

  update(dt) {
    const game = this.game;
    const phase = game.state.phase;
    if (phase === 'menu') return;

    this._decayViewDynamics(dt);

    if (!this.alive) {
      this._updateDeathCamera(dt);
      return;
    }

    this._updateLook();
    this._updateMovement(dt, phase);
    this._updateFootsteps(dt);
    this._applyCamera(dt);
  }

  // Punch / shake / landing-dip springs run every frame regardless of state.
  _decayViewDynamics(dt) {
    const decay = Math.exp(-PUNCH_DECAY * dt);
    this._punchPitch *= decay;
    this._punchYaw *= decay;
    if (Math.abs(this._punchPitch) < 1e-5) this._punchPitch = 0;
    if (Math.abs(this._punchYaw) < 1e-5) this._punchYaw = 0;

    this._shakeAmp *= Math.exp(-SHAKE_DECAY * dt);
    if (this._shakeAmp < 1e-3) this._shakeAmp = 0;
    this._shakeTime += dt;
    this._breatheTime += dt;

    // landing dip: damped spring back to zero
    this._dipVel += (-DIP_SPRING_K * this._dipY - DIP_SPRING_C * this._dipVel) * dt;
    this._dipY += this._dipVel * dt;
    if (this._dipY < -DIP_MAX) this._dipY = -DIP_MAX;
  }

  // ---- look ---------------------------------------------------------------

  _updateLook() {
    const input = this.game.input;
    if (!input || typeof input.consumeLook !== 'function') return;
    const look = input.consumeLook();
    if (!look) return;

    let sens = LOOK_SENS;
    const weapons = this.game.weapons;
    if (weapons && typeof weapons.isScoped === 'function' && weapons.isScoped()) {
      // scoped sensitivity scales with zoom so flicks feel consistent
      sens *= (weapons.scopeLevel >= 2 ? 0.22 : 0.45);
    }

    this.yaw -= look.dx * sens;
    this.pitch -= look.dy * sens;
    if (this.pitch > PITCH_CLAMP) this.pitch = PITCH_CLAMP;
    else if (this.pitch < -PITCH_CLAMP) this.pitch = -PITCH_CLAMP;

    // keep yaw bounded for float hygiene on long sessions
    if (this.yaw > Math.PI * 64 || this.yaw < -Math.PI * 64) {
      this.yaw = Math.atan2(Math.sin(this.yaw), Math.cos(this.yaw));
    }
  }

  // ---- movement -----------------------------------------------------------

  _updateMovement(dt, phase) {
    const game = this.game;
    const P = game.config.PLAYER;
    const input = game.input;
    const v = this.velocity;
    const moveLocked = phase === 'freeze'; // look allowed, feet frozen

    const down = (key) =>
      !!(input && typeof input.isDown === 'function' && input.isDown(key));

    // -- crouch / walk intent --
    const wantCrouch = down('control');
    this.walking = down('shift') && !wantCrouch;

    let targetHeight = wantCrouch ? P.HEIGHT_CROUCH : P.HEIGHT_STAND;
    if (!wantCrouch && this._heightCur < P.HEIGHT_STAND - 0.02 && this._standUpBlocked()) {
      targetHeight = P.HEIGHT_CROUCH; // low ceiling: stay crouched
    }
    this.crouching = targetHeight === P.HEIGHT_CROUCH;

    // smooth crouch: hitbox height lerps, eye follows the same fraction
    const hBlend = 1 - Math.exp(-CROUCH_LERP * dt);
    this._heightCur += (targetHeight - this._heightCur) * hBlend;
    const f = (this._heightCur - P.HEIGHT_CROUCH) / (P.HEIGHT_STAND - P.HEIGHT_CROUCH);
    this.eyeHeight = P.EYE_CROUCH + (P.EYE_STAND - P.EYE_CROUCH) * f;

    // -- wish direction in yaw space --
    let fmove = 0;
    let smove = 0;
    if (!moveLocked) {
      if (down('w')) fmove += 1;
      if (down('s')) fmove -= 1;
      if (down('d')) smove += 1;
      if (down('a')) smove -= 1;
    }
    _fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    _right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    _wish.set(0, 0, 0).addScaledVector(_fwd, fmove).addScaledVector(_right, smove);
    const hasInput = _wish.lengthSq() > 1e-6;
    if (hasInput) _wish.normalize();

    // -- target speed --
    const weapons = game.weapons;
    let mult = 1;
    if (weapons && typeof weapons.currentMoveMult === 'function') {
      const m = weapons.currentMoveMult();
      if (typeof m === 'number' && m > 0) mult = m;
    }
    const baseSpeed = this.crouching
      ? P.CROUCH_SPEED
      : this.walking
        ? P.WALK_SPEED
        : P.RUN_SPEED;
    const wishSpeed = baseSpeed * mult;

    if (this.onGround) {
      // ground friction — exponential, always applied for decisive stops
      const drop = Math.exp(-P.FRICTION_GROUND * dt);
      v.x *= drop;
      v.z *= drop;
      if (!hasInput && v.x * v.x + v.z * v.z < 0.0009) {
        v.x = 0;
        v.z = 0;
      }
      if (hasInput) {
        // quake-style: accelerate only the shortfall along wishdir
        const cur = v.x * _wish.x + v.z * _wish.z;
        const add = wishSpeed - cur;
        if (add > 0) {
          const accel = Math.min(P.ACCEL_GROUND * dt, add);
          v.x += _wish.x * accel;
          v.z += _wish.z * accel;
        }
      }
      // jump (buffered press; blocked in freeze)
      if (!moveLocked && this._jumpQueued > 0 && this._jumpCooldown <= 0) {
        v.y = P.JUMP_VELOCITY;
        this.onGround = false;
        this._jumpQueued = 0;
        this._jumpCooldown = JUMP_COOLDOWN;
        game.events.emit('player:jump');
      }
    } else if (hasInput) {
      // weak air control (capped projection allows gentle air-strafing)
      const cap = Math.min(wishSpeed, 1.4);
      const cur = v.x * _wish.x + v.z * _wish.z;
      const add = cap - cur;
      if (add > 0) {
        const accel = Math.min(P.ACCEL_AIR * wishSpeed * dt, add);
        v.x += _wish.x * accel;
        v.z += _wish.z * accel;
      }
    }
    this._jumpQueued = Math.max(0, this._jumpQueued - dt);
    this._jumpCooldown = Math.max(0, this._jumpCooldown - dt);

    // -- gravity, then collide & slide through the world --
    v.y -= P.GRAVITY * dt;
    if (v.y < -TERMINAL_FALL) v.y = -TERMINAL_FALL;

    const vyBefore = v.y;
    const wasGround = this.onGround;
    _delta.copy(v).multiplyScalar(dt);

    const world = game.world;
    if (world && typeof world.resolveMovement === 'function') {
      const res = world.resolveMovement(this.position, _delta, this.radius, this._heightCur);
      if (res) {
        if (res.pos) this.position.copy(res.pos);
        this.onGround = !!res.onGround;
        if (res.hitCeiling && v.y > 0) v.y = 0;
      }
    } else {
      // world not ready: crude ground plane so we never fall forever
      this.position.add(_delta);
      if (this.position.y <= 0) {
        this.position.y = 0;
        this.onGround = true;
      } else {
        this.onGround = false;
      }
    }

    if (this.onGround && v.y < 0) {
      const fallSpeed = -vyBefore;
      if (!wasGround && fallSpeed >= LAND_MIN_SPEED) {
        // landing: view dip impulse + slight downward punch + event
        const s = Math.min(fallSpeed, 12);
        this._dipVel -= s * DIP_PER_MS;
        this.addViewPunch(-s * 0.0032, 0);
        game.events.emit('player:land', { speed: fallSpeed });
      }
      v.y = 0;
    }

    this.moveSpeed2D = Math.hypot(v.x, v.z);
  }

  // True if the standing hitbox would clip world geometry at this position.
  _standUpBlocked() {
    const world = this.game.world;
    const colliders = world && world.colliders;
    if (!colliders || colliders.length === 0) return false;
    const P = this.game.config.PLAYER;
    const p = this.position;
    const r = this.radius - 0.04; // inset so resting contacts don't false-positive
    // only the band above the current crouched top matters
    _standBox.min.set(p.x - r, p.y + this._heightCur - 0.02, p.z - r);
    _standBox.max.set(p.x + r, p.y + P.HEIGHT_STAND - 0.02, p.z + r);
    for (let i = 0; i < colliders.length; i++) {
      if (_standBox.intersectsBox(colliders[i])) return true;
    }
    return false;
  }

  // ---- footsteps ----------------------------------------------------------

  _updateFootsteps(dt) {
    if (this.onGround && this.moveSpeed2D > FOOTSTEP_MIN_SPEED) {
      this._stepAccum += this.moveSpeed2D * dt;
      if (this._stepAccum >= STRIDE) {
        this._stepAccum -= STRIDE;
        let surface = 'concrete';
        const world = this.game.world;
        if (world && typeof world.raycast === 'function') {
          _rayOrigin.set(this.position.x, this.position.y + 0.3, this.position.z);
          const hit = world.raycast(_rayOrigin, DOWN, 1.2);
          if (hit && hit.surface) surface = hit.surface;
        }
        // clone: listeners (audio/bots) may hold the position past this frame
        this.game.events.emit('player:footstep', {
          pos: this.position.clone(),
          walking: this.walking,
          surface,
        });
      }
    } else {
      // keep some phase so the first step after moving again lands naturally,
      // but never fire a stale step from an old sprint
      if (this._stepAccum > STRIDE * 0.7) this._stepAccum = STRIDE * 0.7;
    }
  }

  // ---- camera -------------------------------------------------------------

  _applyCamera(dt) {
    const game = this.game;
    const cam = game.camera;
    if (!cam) return;
    const P = game.config.PLAYER;
    if (cam.rotation.order !== 'YXZ') cam.rotation.order = 'YXZ';

    // -- view bob (disabled while scoped) --
    let scoped = false;
    const weapons = game.weapons;
    if (weapons && typeof weapons.isScoped === 'function') scoped = !!weapons.isScoped();

    const speedFrac = Math.min(1, this.moveSpeed2D / P.RUN_SPEED);
    const bobTarget = this.onGround && !scoped && this.moveSpeed2D > 0.4 ? speedFrac : 0;
    this._bobAmp += (bobTarget - this._bobAmp) * (1 - Math.exp(-BOB_LERP * dt));
    if (this.onGround && this._bobAmp > 0.001) {
      // one full vertical cycle per STRIDE meters — bob syncs with footsteps
      this._bobPhase += this.moveSpeed2D * dt * ((Math.PI * 2) / STRIDE);
    }
    const bobV = Math.sin(this._bobPhase) * BOB_AMP_V * this._bobAmp;
    const bobL = Math.sin(this._bobPhase * 0.5) * BOB_AMP_L * this._bobAmp;
    const bobRoll = Math.sin(this._bobPhase * 0.5) * BOB_ROLL * this._bobAmp;

    // idle breathing (fades out while moving)
    const breathe = Math.sin(this._breatheTime * 1.9) * BREATHE_AMP * (1 - this._bobAmp);

    // strafe lean: roll slightly into lateral velocity
    _right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const latVel = this.velocity.x * _right.x + this.velocity.z * _right.z;
    const lean = -(latVel / P.RUN_SPEED) * STRAFE_LEAN;

    // -- shake (band of incommensurate sines ≈ smooth noise) --
    let shX = 0;
    let shY = 0;
    let shPitch = 0;
    let shYaw = 0;
    let shRoll = 0;
    const s = this._shakeAmp;
    if (s > 0) {
      const t = this._shakeTime;
      shX = Math.sin(t * 57.3) * 0.03 * s;
      shY = Math.sin(t * 46.7 + 1.3) * 0.026 * s;
      shPitch = Math.sin(t * 51.9 + 2.1) * 0.03 * s;
      shYaw = Math.sin(t * 44.1 + 0.7) * 0.024 * s;
      shRoll = Math.sin(t * 38.3 + 4.2) * 0.016 * s;
    }

    // -- compose: eye + bob + dip + shake / aim + punch + shake --
    cam.position.set(
      this.position.x + _right.x * bobL + shX,
      this.position.y + this.eyeHeight + bobV + this._dipY + breathe + shY,
      this.position.z + _right.z * bobL
    );
    cam.rotation.y = this.yaw + this._punchYaw + shYaw;
    cam.rotation.x = this.pitch + this._punchPitch + shPitch;
    cam.rotation.z = bobRoll + lean + shRoll;
  }

  // Dead: static camera at the death spot, sinking with a slight downward
  // tilt and slump roll. Look input is flushed so respawn doesn't snap.
  _updateDeathCamera(dt) {
    const game = this.game;
    const cam = game.camera;

    const input = game.input;
    if (input && typeof input.consumeLook === 'function') input.consumeLook();

    this._deathBlend = Math.min(1, this._deathBlend + dt * 1.6);
    const t = this._deathBlend;
    const b = t * t * (3 - 2 * t); // smoothstep ease

    if (!cam) return;
    if (cam.rotation.order !== 'YXZ') cam.rotation.order = 'YXZ';

    let shY = 0;
    let shPitch = 0;
    let shRoll = 0;
    const s = this._shakeAmp;
    if (s > 0) {
      const time = this._shakeTime;
      shY = Math.sin(time * 46.7 + 1.3) * 0.02 * s;
      shPitch = Math.sin(time * 51.9 + 2.1) * 0.02 * s;
      shRoll = Math.sin(time * 38.3 + 4.2) * 0.012 * s;
    }

    const eyeY = this._deathEyeStart + (DEATH_EYE - this._deathEyeStart) * b;
    cam.position.set(this.position.x, this.position.y + eyeY + shY, this.position.z);
    cam.rotation.y = this.yaw + this._punchYaw;
    cam.rotation.x = this.pitch * (1 - b) + DEATH_TILT * b + this._punchPitch + shPitch;
    cam.rotation.z = DEATH_ROLL * b + shRoll;
  }
}
