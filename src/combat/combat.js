// ---------------------------------------------------------------------------
// TINY STRIKE — Combat resolution (spec section F)
//
// Owns: hitscan resolution for player AND bot shots (ray vs vertical capsule),
// wall penetration, grenade projectile physics (bounce via world.raycast,
// restitution 0.45 / friction 0.7), HE radial damage with LOS, flashbang blind
// math (view angle + LOS + distance), smoke LOS registry (public losBlocked),
// bomb detonation damage, and the kill / money / killfeed flow.
//
// Emits:   kill, fx:impact, fx:tracer, fx:blood, fx:explosion, fx:flash,
//          fx:smoke, hud:hitmarker, hud:flash, econ:kill
// Listens: weapon:fire, bot:fire, grenade:throw, bomb:detonated, bot:death,
//          player:death, round:start
//
// Hot-path discipline: every per-frame / per-bullet computation runs on
// pre-allocated scratch vectors and scalar math. The only allocations happen
// at event boundaries (cloned vectors inside emitted payloads, which the spec
// itself mandates) and at grenade-throw time (pooled after first use).
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { WEAPONS } from '../weapons/data.js';

// --- Ballistics tuning -----------------------------------------------------
const MAX_RANGE = 250;             // hitscan max travel (m)
const LEG_ZONE = 0.5;              // bottom of capsule counted as legs (m)
const LEG_MULT = 0.75;             // leg damage multiplier
const MELEE_RANGE = 1.8;           // knife reach (m)
const BACKSTAB_MULT = 1.9;         // 34 -> ~65 per spec table

// A character is a broad body capsule plus a separate head sphere. The old
// hitbox used the full 0.35 m body radius around the skull and classified its
// top 0.30 m as a headshot, making the hittable head almost twice as wide as
// the rendered soldiers. These bounds track the ~0.32-0.36 m wide helmets.
const HEAD_RADIUS_RATIO = 0.52;
const HEAD_RADIUS_MIN = 0.15;
const HEAD_RADIUS_MAX = 0.19;
const BOT_CROUCH_VISUAL_SCALE = 0.78;

// --- Penetration -----------------------------------------------------------
const PEN_PROBE = 0.4;             // max wall thickness probe (m)
const PEN_MAX_THICKNESS = 0.35;    // walls thicker than this stop the bullet
const PEN_DMG_SCALE = 0.55;        // damage retained after penetrating

// --- Grenades --------------------------------------------------------------
const GRENADE_RADIUS = 0.07;
const GRENADE_GRAVITY = 20;
const GRENADE_RESTITUTION = 0.45;
const GRENADE_FRICTION = 0.7;      // tangential velocity kept on bounce
const GRENADE_ROLL_DRAG = 4;       // 1/s horizontal decel while rolling
const FUSE_HE = 1.6;
const FUSE_FLASH = 1.6;
const FUSE_SMOKE = 3.0;            // smoke pops on rest OR after this

const HE_RADIUS = 9;
const HE_MAX_DMG = 98;
const HE_FALLOFF_EXP = 1.6;

const FLASH_RANGE = 18;
const FLASH_HOLD = 2.2;            // full-blind seconds at intensity 1
const FLASH_FADE = 1.5;

const SMOKE_RADIUS = 3.2;
const SMOKE_DURATION = 15;
const SMOKE_LIFT = 1.1;            // cloud sphere center sits above the pop point

const BOMB_RADIUS = 16;
const BOMB_MAX_DMG = 420;          // near-guaranteed kill on-site

// Fallback so an unknown weapon id never crashes resolution ('c4', stubs...).
const FALLBACK_DEF = Object.freeze({
  damage: 25,
  headshotMult: 4,
  penetration: 0.3,
  falloffStart: 25,
  falloffEnd: 90,
  falloffMinScale: 0.55,
  killReward: 300,
  tracerEvery: 1,
});

export default class Combat {
  constructor(game) {
    this.game = game;

    // Public smoke registry: [{ pos: Vector3, radius, until }]
    this.smokes = [];

    this._time = 0;
    this._shotCounter = 0;
    this._warned = new Set();

    // Grenade projectile pool (meshes created lazily on first throw).
    this._projectiles = [];
    this._grenAssets = null;

    // --- scratch vectors (never allocated in hot paths) ---
    this._sOrigin = new THREE.Vector3();   // current bullet segment origin
    this._sDir = new THREE.Vector3();      // normalized bullet direction
    this._sEnd = new THREE.Vector3();      // visible tracer end point
    this._tracerFrom = new THREE.Vector3();
    this._muzzleTmp = new THREE.Vector3();
    this._wallPoint = new THREE.Vector3();
    this._wallNormal = new THREE.Vector3();
    this._exitPoint = new THREE.Vector3();
    this._exitNormal = new THREE.Vector3();
    this._probeOrigin = new THREE.Vector3();
    this._negDir = new THREE.Vector3();
    this._hitPos = new THREE.Vector3();
    this._center = new THREE.Vector3();    // detonation center (plain-obj safe)
    this._nrm = new THREE.Vector3();
    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3();
    this._v4 = new THREE.Vector3();
    this._v5 = new THREE.Vector3();
    this._v6 = new THREE.Vector3();
    this._v7 = new THREE.Vector3();
    this._v8 = new THREE.Vector3();

    // capsule-test result registers (avoid per-test object allocation)
    this._capY = 0;          // hit height of the most recent capsule test
    this._hitChar = null;    // nearest character hit by _testCharacters
    this._hitIsPlayer = false;
    this._hitFeetY = 0;
    this._hitHeight = 0;
    this._capYBest = 0;
    this._capPart = 'body';
    this._hitPartBest = 'body';

    const ev = game.events;
    ev.on('weapon:fire', (e) => this._onWeaponFire(e));
    ev.on('bot:fire', (e) => this._onBotFire(e));
    ev.on('grenade:throw', (e) => this._onGrenadeThrow(e));
    ev.on('bomb:detonated', (e) => this._onBombDetonated(e));
    ev.on('bot:death', (e) => this._onBotDeath(e));
    ev.on('remote:death', (e) => this._onRemoteDeath(e));
    ev.on('player:death', (e) => this._onPlayerDeath(e));
    ev.on('round:start', () => this._onRoundStart());
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /**
   * True if the segment a→b passes within the radius of any active smoke.
   * Pure scalar math — safe to call from bot perception every think tick.
   * a/b may be THREE.Vector3 or any {x,y,z}.
   */
  losBlocked(a, b) {
    const s = this.smokes;
    const n = s.length;
    if (n === 0 || !a || !b) return false;
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const abz = b.z - a.z;
    const len2 = abx * abx + aby * aby + abz * abz;
    for (let i = 0; i < n; i++) {
      const sm = s[i];
      const p = sm.pos;
      let t = 0;
      if (len2 > 1e-8) {
        t = ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / len2;
        if (t < 0) t = 0;
        else if (t > 1) t = 1;
      }
      const cx = a.x + abx * t - p.x;
      const cy = a.y + aby * t - p.y;
      const cz = a.z + abz * t - p.z;
      if (cx * cx + cy * cy + cz * cz < sm.radius * sm.radius) return true;
    }
    return false;
  }

  update(dt) {
    this._time += dt;

    if (this._projectiles.length) this._updateProjectiles(dt);

    // prune expired smokes (small array, reverse splice keeps `smokes` public
    // and stable for readers)
    const s = this.smokes;
    for (let i = s.length - 1; i >= 0; i--) {
      if (s[i].until <= this._time) s.splice(i, 1);
    }
  }

  /** Resolve a non-host human's shot on the authoritative host. */
  fireRemote(e, shooter) {
    if (!e || !shooter || !shooter.alive || !e.origin || !e.dir) return;
    const weaponId = e.weaponId || 'usp';
    const def = this._def(weaponId);
    this._sOrigin.set(e.origin.x, e.origin.y, e.origin.z);
    this._sDir.set(e.dir.x, e.dir.y, e.dir.z);
    if (this._sDir.lengthSq() < 1e-10) return;
    this._sDir.normalize();
    if (e.melee) this._resolveMelee(shooter, shooter.team, false, weaponId, def);
    else this._fireBullet(weaponId, def, shooter, shooter.team, false, null);
  }

  /** Spawn a non-host human's grenade in the authoritative simulation. */
  throwRemoteGrenade(e, shooter) {
    if (!e || !shooter || !shooter.alive) return;
    this._onGrenadeThrow({
      type: e.grenadeType || 'hegrenade',
      origin: e.origin,
      dir: e.dir,
      strength: e.strength,
      thrower: shooter,
    });
  }

  /** Apply a host-replicated flashbang to this client's local camera/HUD. */
  applyNetworkFlash(pos) {
    if (pos) this._flashLocalPlayer(pos);
  }

  // =========================================================================
  // Fire event intake
  // =========================================================================

  _onWeaponFire(e) {
    // weapon:fire is the player's channel per spec.
    if (!e || !e.origin || !e.dir) return;
    const mp = this.game.multiplayer;
    if (mp && mp.active && !mp.isAuthority()) return;
    const weaponId = e.weaponId || 'usp';
    const def = this._def(weaponId);
    const shooter = this.game.player || null;
    const team = (shooter && shooter.team) || 'ct';

    this._sOrigin.set(e.origin.x, e.origin.y, e.origin.z);
    this._sDir.set(e.dir.x, e.dir.y, e.dir.z);
    if (this._sDir.lengthSq() < 1e-10) return;
    this._sDir.normalize();

    if (e.melee) {
      this._resolveMelee(shooter, team, true, weaponId, def);
    } else {
      this._fireBullet(weaponId, def, shooter, team, true, null);
    }
  }

  _onBotFire(e) {
    if (!e || !e.origin || !e.dir) return;
    const mp = this.game.multiplayer;
    if (mp && mp.active && !mp.isAuthority()) return;
    const weaponId = e.weaponId || 'ak47';
    const def = this._def(weaponId);
    const shooter = e.bot || null;
    const team = (shooter && shooter.team) || 't';

    this._sOrigin.set(e.origin.x, e.origin.y, e.origin.z);
    this._sDir.set(e.dir.x, e.dir.y, e.dir.z);
    if (this._sDir.lengthSq() < 1e-10) return;
    this._sDir.normalize();

    // gun tip provided in the event, else eye pos (spec F)
    const muzzle = (e.muzzle && e.muzzle.isVector3) ? e.muzzle : null;
    this._fireBullet(weaponId, def, shooter, team, false, muzzle);
  }

  // =========================================================================
  // Hitscan
  // =========================================================================

  _fireBullet(weaponId, def, shooter, shooterTeam, byPlayer, muzzleOverride) {
    // Resolve the tracer origin BEFORE resolution mutates scratch state.
    this._tracerFrom.copy(this._sOrigin);
    if (byPlayer) {
      const vm = this.game.viewmodel;
      if (vm && typeof vm.getMuzzleWorldPos === 'function') {
        const m = vm.getMuzzleWorldPos(this._muzzleTmp);
        if (m && m.isVector3) this._tracerFrom.copy(m);
        else this._tracerFrom.copy(this._muzzleTmp);
      }
    } else if (muzzleOverride) {
      this._tracerFrom.copy(muzzleOverride);
    }

    this._resolveBullet(weaponId, def, shooter, shooterTeam, byPlayer);

    // one tracer per shot, muzzle → first visible termination point
    this._shotCounter++;
    const every = def.tracerEvery != null ? def.tracerEvery : 1;
    if (every > 0 && this._shotCounter % every === 0) {
      this.game.events.emit('fx:tracer', {
        from: this._tracerFrom.clone(),
        to: this._sEnd.clone(),
        weaponId,
        shooterId: shooter && shooter.networkId ? shooter.networkId
          : (shooter === this.game.player ? this.game.player.networkId : null),
      });
    }
  }

  /**
   * Marches the bullet: up to two segments (one wall penetration max).
   * Sets this._sEnd to the end of the FIRST segment (the visible tracer end).
   */
  _resolveBullet(weaponId, def, shooter, shooterTeam, byPlayer) {
    const ev = this.game.events;
    let remaining = MAX_RANGE;
    let traveled = 0;
    let dmgScale = 1;
    let canPen = (def.penetration || 0) > 0.01;

    // default end: full range (overwritten on first-segment termination)
    this._sEnd.copy(this._sOrigin).addScaledVector(this._sDir, remaining);

    for (let seg = 0; seg < 2; seg++) {
      const world = this.game.world;

      // 1) world geometry along this segment
      let hasWall = false;
      let wallDist = Infinity;
      let wallSurface = 'concrete';
      if (world && typeof world.raycast === 'function') {
        const hit = world.raycast(this._sOrigin, this._sDir, remaining);
        if (hit) {
          hasWall = true;
          wallDist = hit.distance;
          // copy immediately — world may reuse internal vectors
          this._wallPoint.copy(hit.point);
          this._wallNormal.copy(hit.normal);
          wallSurface = hit.surface
            || (hit.mesh && hit.mesh.userData && hit.mesh.userData.surface)
            || 'concrete';
        }
      }

      // 2) nearest character strictly before the wall
      const charT = this._testCharacters(
        this._sOrigin, this._sDir, Math.min(remaining, wallDist), shooter
      );

      if (charT >= 0) {
        // Bullet stops on any character; only enemies take damage (spec F).
        const target = this._hitChar;
        this._hitPos.copy(this._sOrigin).addScaledVector(this._sDir, charT);
        if (seg === 0) this._sEnd.copy(this._hitPos);

        const targetTeam = target.team || (this._hitIsPlayer ? 'ct' : 't');
        if (targetTeam !== shooterTeam) {
          const part = this._hitPartBest;
          const headshot = part === 'head';
          const zone = headshot
            ? (def.headshotMult != null ? def.headshotMult : 4)
            : (part === 'legs' ? LEG_MULT : 1);
          const dist = traveled + charT;
          const dmg = Math.max(
            1,
            Math.round((def.damage != null ? def.damage : 25)
              * this._falloff(def, dist) * zone * dmgScale)
          );
          ev.emit('fx:blood', {
            point: this._hitPos.clone(),
            dir: this._sDir.clone(),
          });
          this._applyDamage(target, this._hitIsPlayer, dmg, shooter, weaponId, headshot, part, byPlayer);
        }
        return;
      }

      if (!hasWall) return; // flew off into the sky

      // 3) wall impact (entry)
      ev.emit('fx:impact', {
        point: this._wallPoint.clone(),
        normal: this._wallNormal.clone(),
        surface: wallSurface,
      });
      if (seg === 0) this._sEnd.copy(this._wallPoint);

      // 4) penetration — one max
      if (!canPen) return;
      canPen = false;

      // Probe: step past the entry point, cast back toward it. The backside
      // face of a thin wall faces the probe origin, so a front-face raycast
      // finds it; anything thicker than the probe yields no hit (we would be
      // casting from inside the solid).
      this._probeOrigin.copy(this._wallPoint).addScaledVector(this._sDir, PEN_PROBE);
      this._negDir.copy(this._sDir).negate();
      let back = null;
      if (world && typeof world.raycast === 'function') {
        back = world.raycast(this._probeOrigin, this._negDir, PEN_PROBE - 0.005);
      }
      if (!back) return;
      const thickness = PEN_PROBE - back.distance;
      if (thickness <= 0 || thickness > PEN_MAX_THICKNESS) return;

      this._exitPoint.copy(back.point);
      this._exitNormal.copy(back.normal);
      const exitSurface = back.surface
        || (back.mesh && back.mesh.userData && back.mesh.userData.surface)
        || 'concrete';

      // exit impact on the far side
      ev.emit('fx:impact', {
        point: this._exitPoint.clone(),
        normal: this._exitNormal.clone(),
        surface: exitSurface,
      });

      traveled += wallDist + thickness;
      remaining -= wallDist + thickness;
      if (remaining <= 0.25) return;
      dmgScale *= PEN_DMG_SCALE;
      this._sOrigin.copy(this._exitPoint).addScaledVector(this._sDir, 0.01);
    }
  }

  _resolveMelee(shooter, shooterTeam, byPlayer, weaponId, def) {
    const ev = this.game.events;
    const world = this.game.world;

    let hasWall = false;
    let wallDist = Infinity;
    let wallSurface = 'concrete';
    if (world && typeof world.raycast === 'function') {
      const hit = world.raycast(this._sOrigin, this._sDir, MELEE_RANGE);
      if (hit) {
        hasWall = true;
        wallDist = hit.distance;
        this._wallPoint.copy(hit.point);
        this._wallNormal.copy(hit.normal);
        wallSurface = hit.surface || 'concrete';
      }
    }

    const charT = this._testCharacters(
      this._sOrigin, this._sDir, Math.min(MELEE_RANGE, wallDist), shooter
    );

    if (charT >= 0) {
      const target = this._hitChar;
      const targetTeam = target.team || (this._hitIsPlayer ? 'ct' : 't');
      if (targetTeam === shooterTeam) return; // no friendly stabs
      this._hitPos.copy(this._sOrigin).addScaledVector(this._sDir, charT);

      // Backstab: victim facing points away from the attacker, i.e. roughly
      // along the attack direction (yaw 0 faces -Z).
      const vyaw = target.yaw || 0;
      const facX = -Math.sin(vyaw);
      const facZ = -Math.cos(vyaw);
      const horiz = Math.hypot(this._sDir.x, this._sDir.z) || 1;
      const backstab = (facX * this._sDir.x + facZ * this._sDir.z) / horiz > 0.35;

      const base = def.damage != null ? def.damage : 34;
      const dmg = backstab
        ? (def.damageBack != null ? def.damageBack : Math.round(base * BACKSTAB_MULT))
        : base;
      const part = this._hitPartBest;

      ev.emit('fx:blood', {
        point: this._hitPos.clone(),
        dir: this._sDir.clone(),
      });
      this._applyDamage(target, this._hitIsPlayer, dmg, shooter, weaponId, false, part, byPlayer);
      return;
    }

    // knife scraping a wall — little spark/chip
    if (hasWall && wallDist <= MELEE_RANGE) {
      ev.emit('fx:impact', {
        point: this._wallPoint.clone(),
        normal: this._wallNormal.clone(),
        surface: wallSurface,
      });
    }
  }

  _applyDamage(target, isPlayer, dmg, shooter, weaponId, headshot, part, byPlayer) {
    if (!target || typeof target.takeDamage !== 'function') return;
    target.takeDamage(dmg, { from: shooter, weapon: weaponId, headshot, part });
    // Player hit feedback — bot targets only ('bot:death' fires synchronously
    // inside takeDamage, so `alive` is already settled here).
    if (byPlayer && !isPlayer) {
      this.game.events.emit('hud:hitmarker', { headshot, kill: !target.alive });
    }
  }

  // =========================================================================
  // Character capsule tests
  // =========================================================================

  /**
   * Nearest character hit along the ray, or -1. Skips the shooter, dead
   * characters, and anything beyond maxDist. Results land in instance
   * registers: _hitChar/_hitIsPlayer/_hitFeetY/_hitHeight/_capYBest.
   */
  _testCharacters(o, d, maxDist, shooter) {
    let bestT = -1;
    this._hitChar = null;
    const g = this.game;
    const cfg = g.config || {};

    // --- the player ---
    const pl = g.player;
    if (pl && pl.alive && pl !== shooter) {
      let fx = 0, fy = 0, fz = 0, radius = -1, height = 0;
      if (typeof pl.hitCapsule === 'function') {
        const cap = pl.hitCapsule();
        if (cap && cap.pos) {
          fx = cap.pos.x; fy = cap.pos.y; fz = cap.pos.z;
          radius = cap.radius; height = cap.height;
        }
      }
      if (radius < 0 && pl.position) {
        fx = pl.position.x; fy = pl.position.y; fz = pl.position.z;
        radius = (cfg.PLAYER && cfg.PLAYER.RADIUS) || 0.35;
        height = (cfg.PLAYER && cfg.PLAYER.HEIGHT_STAND) || 1.83;
      }
      if (radius > 0) {
        const t = this._rayCharacter(
          o.x, o.y, o.z, d.x, d.y, d.z, maxDist,
          fx, fy, fz, radius, height
        );
        if (t >= 0) {
          bestT = t;
          this._hitChar = pl;
          this._hitIsPlayer = true;
          this._hitFeetY = fy;
          this._hitHeight = height;
          this._capYBest = this._capY;
          this._hitPartBest = this._capPart;
        }
      }
    }

    // --- bots ---
    const bots = g.bots && g.bots.all;
    if (bots) {
      const defRadius = (cfg.BOT && cfg.BOT.RADIUS) || 0.35;
      const defHeight = (cfg.BOT && cfg.BOT.HEIGHT) || 1.83;
      for (let i = 0; i < bots.length; i++) {
        const b = bots[i];
        if (!b || b === shooter || !b.alive || !b.pos) continue;
        const radius = b.radius != null ? b.radius : defRadius;
        let height = b.height != null ? b.height : defHeight;
        // The Duck clip/primitive crouch pose remains about 78% of standing
        // height, while movement uses a shorter clearance capsule. Combat must
        // follow the visible head or carefully aimed shots pass over it.
        if (b.crouching) height = Math.max(height, defHeight * BOT_CROUCH_VISUAL_SCALE);
        const t = this._rayCharacter(
          o.x, o.y, o.z, d.x, d.y, d.z, maxDist,
          b.pos.x, b.pos.y, b.pos.z, radius, height
        );
        if (t >= 0 && (bestT < 0 || t < bestT)) {
          bestT = t;
          this._hitChar = b;
          this._hitIsPlayer = false;
          this._hitFeetY = b.pos.y;
          this._hitHeight = height;
          this._capYBest = this._capY;
          this._hitPartBest = this._capPart;
        }
      }
    }

    // --- remote human players (authoritative host only for damage) ---
    const remotes = g.multiplayer && g.multiplayer.remotePlayers;
    if (Array.isArray(remotes)) {
      const defRadius = (cfg.PLAYER && cfg.PLAYER.RADIUS) || 0.35;
      const defHeight = (cfg.PLAYER && cfg.PLAYER.HEIGHT_STAND) || 1.83;
      for (let i = 0; i < remotes.length; i++) {
        const r = remotes[i];
        if (!r || r === shooter || !r.alive || !r.position) continue;
        const radius = r.radius != null ? r.radius : defRadius;
        const height = r.height != null ? r.height : defHeight;
        const t = this._rayCharacter(
          o.x, o.y, o.z, d.x, d.y, d.z, maxDist,
          r.position.x, r.position.y, r.position.z, radius, height
        );
        if (t >= 0 && (bestT < 0 || t < bestT)) {
          bestT = t;
          this._hitChar = r;
          this._hitIsPlayer = false;
          this._hitFeetY = r.position.y;
          this._hitHeight = height;
          this._capYBest = this._capY;
          this._hitPartBest = this._capPart;
        }
      }
    }

    return bestT;
  }

  /**
   * Ray vs the compound character hitbox. The body keeps the movement radius
   * for forgiving torso/limb contact, but ends at the neck; a much smaller
   * sphere owns headshot classification. Returns the first physical contact
   * and stores its part/height in the scratch registers.
   */
  _rayCharacter(ox, oy, oz, dx, dy, dz, maxDist, fx, fy, fz, radius, height) {
    const headRadius = Math.max(
      HEAD_RADIUS_MIN,
      Math.min(HEAD_RADIUS_MAX, radius * HEAD_RADIUS_RATIO)
    );
    const headY = fy + height - headRadius;
    // Let the body's rounded shoulder volume rise to the center of the head.
    // The dedicated sphere still exclusively decides headshot classification;
    // this overlap preserves forgiving shoulder/upper-torso hits.
    const bodyHeight = Math.max(radius * 2, height - headRadius);

    const bodyT = this._rayCapsule(
      ox, oy, oz, dx, dy, dz, maxDist,
      fx, fy, fz, radius, bodyHeight
    );
    const bodyY = this._capY;
    const headT = this._raySphere(
      ox, oy, oz, dx, dy, dz,
      fx, headY, fz, headRadius, maxDist
    );

    if (headT >= 0) {
      this._capY = oy + dy * headT;
      this._capPart = 'head';
      return bodyT >= 0 ? Math.min(bodyT, headT) : headT;
    }
    if (bodyT >= 0) {
      this._capY = bodyY;
      this._capPart = bodyY <= fy + LEG_ZONE ? 'legs' : 'body';
      return bodyT;
    }
    this._capPart = 'body';
    return -1;
  }

  /**
   * Ray vs vertical capsule, all-scalar. Direction must be normalized.
   * Capsule: feet at (fx,fy,fz), axis +Y, given radius/height.
   * Returns distance t along the ray (>= 0) or -1; stores hit height in _capY.
   */
  _rayCapsule(ox, oy, oz, dx, dy, dz, maxDist, fx, fy, fz, radius, height) {
    const y0 = fy + radius;              // bottom sphere center height
    const y1 = fy + height - radius;     // top sphere center height
    const rx = ox - fx;
    const rz = oz - fz;
    const a = dx * dx + dz * dz;
    const c = rx * rx + rz * rz - radius * radius;

    if (a > 1e-9) {
      const b = 2 * (rx * dx + rz * dz);
      const disc = b * b - 4 * a * c;
      // The 2D projected ray misses the circle -> misses cylinder AND caps.
      if (disc < 0) return -1;
      const sq = Math.sqrt(disc);
      let t = (-b - sq) / (2 * a);
      if (t < 0 && c < 0) {
        // origin inside the infinite cylinder
        if (oy > fy && oy < fy + height) {
          this._capY = oy;
          return 0.0005; // point-blank body contact
        }
        t = -1; // above/below — caps decide
      }
      if (t >= 0 && t <= maxDist) {
        const y = oy + dy * t;
        if (y >= y0 && y <= y1) {
          // side hit is provably the earliest capsule contact
          this._capY = y;
          return t;
        }
      }
    } else if (c > 0) {
      return -1; // vertical ray outside the cylinder footprint
    }

    // sphere caps
    let best = -1;
    let t = this._raySphere(ox, oy, oz, dx, dy, dz, fx, y1, fz, radius, maxDist);
    if (t >= 0) {
      best = t;
      this._capY = oy + dy * t;
    }
    t = this._raySphere(ox, oy, oz, dx, dy, dz, fx, y0, fz, radius, maxDist);
    if (t >= 0 && (best < 0 || t < best)) {
      best = t;
      this._capY = oy + dy * t;
    }
    return best;
  }

  _raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r, maxDist) {
    const px = ox - cx;
    const py = oy - cy;
    const pz = oz - cz;
    const b = px * dx + py * dy + pz * dz;
    const c = px * px + py * py + pz * pz - r * r;
    if (c > 0 && b > 0) return -1; // outside and pointing away
    const disc = b * b - c;
    if (disc < 0) return -1;
    let t = -b - Math.sqrt(disc);
    if (t < 0) t = c < 0 ? 0.0005 : -1; // inside the sphere -> immediate
    if (t < 0 || t > maxDist) return -1;
    return t;
  }

  _falloff(def, dist) {
    const start = def.falloffStart != null ? def.falloffStart : 25;
    const end = def.falloffEnd != null ? def.falloffEnd : 90;
    const min = def.falloffMinScale != null ? def.falloffMinScale : 0.55;
    if (dist <= start) return 1;
    if (dist >= end) return min;
    return 1 - (1 - min) * ((dist - start) / (end - start));
  }

  // =========================================================================
  // Grenades
  // =========================================================================

  _onGrenadeThrow(e) {
    if (!e || !e.origin || !e.dir) return;
    const mp = this.game.multiplayer;
    if (mp && mp.active && !mp.isAuthority() && !e.thrower) return;
    const type = e.type || 'hegrenade';
    const p = this._acquireProjectile(type);

    p.pos.set(e.origin.x, e.origin.y, e.origin.z);
    this._v1.set(e.dir.x, e.dir.y, e.dir.z);
    if (this._v1.lengthSq() < 1e-8) this._v1.set(0, 0, -1);
    this._v1.normalize();

    const strength = e.strength != null ? e.strength : 14;
    p.vel.copy(this._v1).multiplyScalar(strength);

    // inherit thrower velocity ×0.3 (only the player throws per spec, but
    // stay generic if a bot ever appears in the payload)
    const thrower = e.thrower || e.bot || this.game.player || null;
    if (thrower && thrower.velocity && thrower.velocity.isVector3) {
      p.vel.addScaledVector(thrower.velocity, 0.3);
    }
    p.thrower = thrower;
    p.throwerTeam = (thrower && thrower.team) || 'ct';
    p.fuse = type === 'smokegrenade' ? FUSE_SMOKE : (type === 'flashbang' ? FUSE_FLASH : FUSE_HE);
    p.spin.set(
      (Math.random() * 2 - 1) * 9,
      (Math.random() * 2 - 1) * 9,
      (Math.random() * 2 - 1) * 9
    );

    // nudge out of the thrower's face — but never through a wall
    const world = this.game.world;
    let nudge = 0.25;
    if (world && typeof world.raycast === 'function') {
      const block = world.raycast(p.pos, this._v1, nudge + GRENADE_RADIUS);
      if (block) {
        nudge = Math.max(block.distance - GRENADE_RADIUS - 0.02, 0);
        p.vel.multiplyScalar(-0.15); // thrown point-blank into a wall: drop it
      }
    }
    p.pos.addScaledVector(this._v1, nudge);
    p.mesh.position.copy(p.pos);
    p.mesh.rotation.set(0, 0, 0);
  }

  _buildGrenadeAssets() {
    this._grenAssets = {
      geo: {
        hegrenade: new THREE.SphereGeometry(GRENADE_RADIUS, 12, 10),
        flashbang: new THREE.CylinderGeometry(0.045, 0.045, 0.14, 10),
        smokegrenade: new THREE.CylinderGeometry(0.055, 0.055, 0.15, 10),
      },
      mat: {
        hegrenade: new THREE.MeshStandardMaterial({ color: 0x35452c, roughness: 0.55, metalness: 0.45 }),
        flashbang: new THREE.MeshStandardMaterial({ color: 0x9aa4ad, roughness: 0.35, metalness: 0.7 }),
        smokegrenade: new THREE.MeshStandardMaterial({ color: 0x4c5a52, roughness: 0.6, metalness: 0.5 }),
      },
    };
  }

  _acquireProjectile(type) {
    if (!this._grenAssets) this._buildGrenadeAssets();
    let p = null;
    for (let i = 0; i < this._projectiles.length; i++) {
      if (!this._projectiles[i].active) { p = this._projectiles[i]; break; }
    }
    if (!p) {
      p = {
        active: false,
        type: '',
        mesh: null,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        spin: new THREE.Vector3(),
        fuse: 0,
        resting: false,
        grounded: false,
        thrower: null,
        throwerTeam: 'ct',
      };
      p.mesh = new THREE.Mesh(this._grenAssets.geo.hegrenade, this._grenAssets.mat.hegrenade);
      p.mesh.castShadow = true;
      p.mesh.visible = false;
      if (this.game.scene) this.game.scene.add(p.mesh);
      this._projectiles.push(p);
    }
    const key = this._grenAssets.geo[type] ? type : 'hegrenade';
    p.mesh.geometry = this._grenAssets.geo[key];
    p.mesh.material = this._grenAssets.mat[key];
    p.mesh.visible = true;
    p.active = true;
    p.type = type;
    p.resting = false;
    p.grounded = false;
    return p;
  }

  _updateProjectiles(dt) {
    const world = this.game.world;
    const canRay = !!(world && typeof world.raycast === 'function');

    for (let i = 0; i < this._projectiles.length; i++) {
      const p = this._projectiles[i];
      if (!p.active) continue;

      p.fuse -= dt;
      if (p.type === 'smokegrenade') {
        if (p.resting || p.fuse <= 0) {
          this._popSmoke(p);
          this._release(p);
          continue;
        }
      } else if (p.fuse <= 0) {
        if (p.type === 'flashbang') this._detonateFlash(p);
        else this._detonateHE(p);
        this._release(p);
        continue;
      }

      if (p.resting) continue;

      if (!p.grounded) p.vel.y -= GRENADE_GRAVITY * dt;

      // integrate along motion with a ray to prevent tunneling
      this._v1.copy(p.vel).multiplyScalar(dt);
      const dist = this._v1.length();
      if (dist > 1e-7) {
        this._v2.copy(this._v1).multiplyScalar(1 / dist);
        let hit = null;
        if (canRay) hit = world.raycast(p.pos, this._v2, dist + GRENADE_RADIUS);
        if (hit) {
          this._nrm.copy(hit.normal);
          const move = Math.max(hit.distance - GRENADE_RADIUS - 0.005, 0);
          p.pos.addScaledVector(this._v2, move);

          const vn = p.vel.dot(this._nrm);
          if (vn < 0) {
            // split into tangential (× friction) + reflected normal (× restitution)
            this._v3.copy(this._nrm).multiplyScalar(vn);
            p.vel.sub(this._v3).multiplyScalar(GRENADE_FRICTION);
            p.vel.addScaledVector(this._nrm, -vn * GRENADE_RESTITUTION);
          }
          if (this._nrm.y > 0.6) {
            if (p.vel.lengthSq() < 1.0) {
              p.vel.set(0, 0, 0);
              p.resting = true;
            } else if (Math.abs(p.vel.y) < 1.3) {
              p.vel.y = 0;
              p.grounded = true; // start rolling
            }
          }
          p.spin.multiplyScalar(0.55); // bounces bleed spin
        } else {
          p.pos.add(this._v1);
          // fallback floor at y=0 if the world can't raycast (stub worlds)
          if (!canRay && p.pos.y < GRENADE_RADIUS) {
            p.pos.y = GRENADE_RADIUS;
            if (p.vel.y < 0) p.vel.y = -p.vel.y * GRENADE_RESTITUTION;
            p.vel.x *= GRENADE_FRICTION;
            p.vel.z *= GRENADE_FRICTION;
            if (p.vel.lengthSq() < 1.0) { p.vel.set(0, 0, 0); p.resting = true; }
          }
        }
      }

      // rolling: hug the floor, drag to a stop, fall off ledges
      if (p.grounded && !p.resting) {
        const drag = Math.max(0, 1 - GRENADE_ROLL_DRAG * dt);
        p.vel.x *= drag;
        p.vel.z *= drag;
        let onFloor = false;
        if (canRay) {
          this._v4.set(0, -1, 0);
          this._v5.copy(p.pos);
          this._v5.y += 0.1;
          const ground = world.raycast(this._v5, this._v4, 0.4);
          if (ground) {
            p.pos.y = ground.point.y + GRENADE_RADIUS;
            if (p.vel.y < 0) p.vel.y = 0;
            onFloor = true;
          }
        }
        if (!onFloor) p.grounded = false; // rolled off an edge
        if (p.vel.lengthSq() < 0.25) {
          p.vel.set(0, 0, 0);
          p.resting = true;
        }
      }

      if (p.pos.y < -60) { // escaped the world somehow
        this._release(p);
        continue;
      }

      p.mesh.position.copy(p.pos);
      p.mesh.rotation.x += p.spin.x * dt;
      p.mesh.rotation.y += p.spin.y * dt;
      p.mesh.rotation.z += p.spin.z * dt;
    }
  }

  _release(p) {
    p.active = false;
    p.resting = false;
    p.grounded = false;
    p.thrower = null;
    if (p.mesh) p.mesh.visible = false;
  }

  // =========================================================================
  // Detonations
  // =========================================================================

  _detonateHE(p) {
    this.game.events.emit('fx:explosion', { pos: p.pos.clone(), radius: HE_RADIUS });
    this._radialDamage(p.pos, HE_RADIUS, HE_MAX_DMG, p.thrower, p.throwerTeam, 'hegrenade', true, false);
    this._shakePlayer(p.pos, HE_RADIUS * 1.8, 0.9);
  }

  _detonateFlash(p) {
    const ev = this.game.events;
    ev.emit('fx:flash', { pos: p.pos.clone() });

    // bots handle their own LOS/range check
    const bots = this.game.bots;
    if (bots && typeof bots.applyFlash === 'function') bots.applyFlash(p.pos);

    this._flashLocalPlayer(p.pos);
  }

  _flashLocalPlayer(pos) {
    // Player blind = f(view angle, LOS, distance).
    const pl = this.game.player;
    const cam = this.game.camera;
    if (!pl || !pl.alive || !cam) return;

    if (typeof pl.eyePos === 'function') this._v6.copy(pl.eyePos());
    else if (pl.position) { this._v6.copy(pl.position); this._v6.y += 1.62; }
    else return;

    const d = this._v6.distanceTo(pos);
    if (d > FLASH_RANGE) return;
    if (!this._losClear(pos, this._v6)) return;

    cam.getWorldDirection(this._v7);
    this._v8.copy(pos).sub(this._v6).multiplyScalar(1 / Math.max(d, 1e-4));
    const dot = this._v7.dot(this._v8);

    // looking at it (dot >= 0.3) -> full; behind you -> weak residual
    const face = dot >= 0.3 ? 1 : Math.max(0.18, 0.18 + 0.82 * (dot + 1) / 1.3);
    const distF = d <= 7 ? 1 : Math.max(0.3, 1 - 0.7 * ((d - 7) / (FLASH_RANGE - 7)));
    const intensity = Math.min(1, face * distF);
    if (intensity < 0.04) return;

    this.game.events.emit('hud:flash', {
      intensity,
      duration: FLASH_HOLD * intensity + FLASH_FADE,
    });
  }

  _popSmoke(p) {
    this.game.events.emit('fx:smoke', { pos: p.pos.clone(), duration: SMOKE_DURATION });
    const cloud = p.pos.clone();
    cloud.y += SMOKE_LIFT; // sphere centered at torso/eye height blocks vision best
    this.smokes.push({ pos: cloud, radius: SMOKE_RADIUS, until: this._time + SMOKE_DURATION });
  }

  _onBombDetonated(e) {
    if (!e || !e.pos) return;
    this._center.set(e.pos.x, e.pos.y, e.pos.z);
    this.game.events.emit('fx:explosion', { pos: this._center.clone(), radius: BOMB_RADIUS });
    // The bomb hurts everyone, through cover — being on-site is lethal.
    this._radialDamage(this._center, BOMB_RADIUS, BOMB_MAX_DMG, null, null, 'c4', false, true);
    this._shakePlayer(this._center, 45, 1.6);
  }

  /**
   * Radial explosion damage: dmg = maxDmg × (1 − d/radius)^1.6, optional LOS
   * gate, optional teammate immunity (self-damage always applies).
   */
  _radialDamage(center, radius, maxDmg, attacker, attackerTeam, weaponId, requireLOS, hurtTeammates) {
    const g = this.game;
    const ev = g.events;
    const byPlayer = this._isPlayer(attacker);

    // --- player ---
    const pl = g.player;
    if (pl && pl.alive && pl.position && typeof pl.takeDamage === 'function') {
      this._v6.copy(pl.position);
      this._v6.y += 0.9; // chest center
      const d = this._v6.distanceTo(center);
      if (d <= radius) {
        const isSelf = attacker === pl;
        const friendly = attackerTeam != null && attackerTeam === pl.team && !isSelf;
        if ((hurtTeammates || !friendly)
          && (!requireLOS || this._losClear(center, this._v6))) {
          const dmg = Math.max(1, Math.round(maxDmg * Math.pow(1 - d / radius, HE_FALLOFF_EXP)));
          pl.takeDamage(dmg, { from: attacker, weapon: weaponId, headshot: false, part: 'body' });
        }
      }
    }

    // --- bots ---
    const bots = g.bots && g.bots.all;
    if (bots) {
      for (let i = 0; i < bots.length; i++) {
        const b = bots[i];
        if (!b || !b.alive || !b.pos || typeof b.takeDamage !== 'function') continue;
        this._v6.copy(b.pos);
        this._v6.y += (b.height != null ? b.height : 1.83) * 0.5;
        const d = this._v6.distanceTo(center);
        if (d > radius) continue;
        const friendly = attackerTeam != null && b.team === attackerTeam && attacker !== b;
        if (friendly && !hurtTeammates) continue;
        if (requireLOS && !this._losClear(center, this._v6)) continue;
        const dmg = Math.max(1, Math.round(maxDmg * Math.pow(1 - d / radius, HE_FALLOFF_EXP)));
        b.takeDamage(dmg, { from: attacker, weapon: weaponId, headshot: false, part: 'body' });
        if (byPlayer) ev.emit('hud:hitmarker', { headshot: false, kill: !b.alive });
      }
    }

    // --- remote human players ---
    const remotes = g.multiplayer && g.multiplayer.remotePlayers;
    if (Array.isArray(remotes)) {
      for (let i = 0; i < remotes.length; i++) {
        const r = remotes[i];
        if (!r || !r.alive || !r.position || typeof r.takeDamage !== 'function') continue;
        this._v6.copy(r.position);
        this._v6.y += (r.height != null ? r.height : 1.83) * 0.5;
        const d = this._v6.distanceTo(center);
        if (d > radius) continue;
        const friendly = attackerTeam != null && r.team === attackerTeam && attacker !== r;
        if (friendly && !hurtTeammates) continue;
        if (requireLOS && !this._losClear(center, this._v6)) continue;
        const dmg = Math.max(1, Math.round(maxDmg * Math.pow(1 - d / radius, HE_FALLOFF_EXP)));
        r.takeDamage(dmg, { from: attacker, weapon: weaponId, headshot: false, part: 'body' });
      }
    }
  }

  /** World-geometry LOS between two points (small end slack for wall-huggers). */
  _losClear(from, to) {
    const w = this.game.world;
    if (!w || typeof w.raycast !== 'function') return true;
    this._v7.copy(from);
    this._v7.y += 0.25;
    this._v8.copy(to).sub(this._v7);
    const d = this._v8.length();
    if (d < 1e-4) return true;
    this._v8.multiplyScalar(1 / d);
    const hit = w.raycast(this._v7, this._v8, Math.max(d - 0.3, 0.01));
    return !hit;
  }

  _shakePlayer(center, range, maxStrength) {
    const pl = this.game.player;
    if (!pl || typeof pl.addShake !== 'function' || !pl.position) return;
    this._v6.copy(pl.position);
    this._v6.y += 0.9;
    const d = this._v6.distanceTo(center);
    if (d < range) pl.addShake(maxStrength * (1 - d / range));
  }

  // =========================================================================
  // Kill / money / killfeed flow
  // =========================================================================

  _onBotDeath(e) {
    if (!e || !e.bot) return;
    const bot = e.bot;
    const weaponId = this._weaponIdOf(e.weapon);
    const headshot = !!e.headshot;
    const killer = e.killer != null ? e.killer : null;

    let killerName;
    let killerTeam;
    let reward = 0;
    if (this._isPlayer(killer)) {
      killerName = this._localPlayerName();
      killerTeam = (this.game.player && this.game.player.team) || 'ct';
      // money — combat's allowed exception on game.state
      const def = this._def(weaponId);
      reward = def.killReward != null ? def.killReward : 300;
      const econ = this.game.config && this.game.config.ECON;
      const maxMoney = econ && econ.MAX_MONEY != null ? econ.MAX_MONEY : 16000;
      this.game.state.money = Math.min(maxMoney, (this.game.state.money || 0) + reward);
      this.game.events.emit('econ:kill', { weaponId, reward });
    } else if (killer && killer.name) {
      killerName = killer.name;
      killerTeam = killer.team || 't';
      if (killer.isRemotePlayer) {
        const def = this._def(weaponId);
        reward = def.killReward != null ? def.killReward : 300;
      }
    } else if (weaponId === 'c4') {
      killerName = 'C4';
      killerTeam = 't';
    } else {
      killerName = bot.name || 'World';
      killerTeam = bot.team || 't';
    }

    this.game.events.emit('kill', {
      killerName,
      victimName: bot.name || 'Bot',
      weaponId,
      headshot,
      killerTeam,
      victimTeam: bot.team || 't',
      killerId: killer && killer.networkId ? killer.networkId : (this._isPlayer(killer) ? this.game.player.networkId : null),
      victimId: null,
      reward,
    });
  }

  _onRemoteDeath(e) {
    if (!e || !e.player) return;
    const mp = this.game.multiplayer;
    if (mp && mp.active && !mp.isAuthority()) return;
    const victim = e.player;
    const killer = e.killer || null;
    const weaponId = this._weaponIdOf(e.weapon);
    let killerName = 'World';
    let killerTeam = victim.team === 'ct' ? 't' : 'ct';
    let reward = 0;
    if (this._isPlayer(killer)) {
      killerName = this._localPlayerName();
      killerTeam = this.game.player.team;
      const def = this._def(weaponId);
      reward = def.killReward != null ? def.killReward : 300;
      const maxMoney = this.game.config.ECON.MAX_MONEY;
      this.game.state.money = Math.min(maxMoney, (this.game.state.money || 0) + reward);
      this.game.events.emit('econ:kill', { weaponId, reward });
    } else if (killer && killer.name) {
      killerName = killer.name;
      killerTeam = killer.team || killerTeam;
      if (killer.isRemotePlayer) {
        const def = this._def(weaponId);
        reward = def.killReward != null ? def.killReward : 300;
      }
    } else if (weaponId === 'c4') {
      killerName = 'C4';
      killerTeam = 't';
    }
    this.game.events.emit('kill', {
      killerName,
      victimName: victim.name || 'Operative',
      weaponId,
      headshot: !!e.headshot,
      killerTeam,
      victimTeam: victim.team,
      killerId: killer && killer.networkId ? killer.networkId : (this._isPlayer(killer) ? this.game.player.networkId : null),
      victimId: victim.networkId,
      reward,
    });
  }

  _onPlayerDeath(e) {
    const mp = this.game.multiplayer;
    if (mp && mp.active && !mp.isAuthority()) return;
    const ev = e || {};
    const weaponId = this._weaponIdOf(ev.weapon);
    const killer = ev.killer != null ? ev.killer : null;

    let killerName = 'World';
    let killerTeam = 't';
    let reward = 0;
    if (this._isPlayer(killer)) {
      killerName = this._localPlayerName();
      killerTeam = (this.game.player && this.game.player.team) || 'ct';
    } else if (killer && killer.name) {
      killerName = killer.name;
      killerTeam = killer.team || 't';
      if (killer.isRemotePlayer) {
        const def = this._def(weaponId);
        reward = def.killReward != null ? def.killReward : 300;
      }
    } else if (weaponId === 'c4') {
      killerName = 'C4';
      killerTeam = 't';
    }

    this.game.events.emit('kill', {
      killerName,
      victimName: this._localPlayerName(),
      weaponId,
      headshot: !!ev.headshot,
      killerTeam,
      victimTeam: (this.game.player && this.game.player.team) || 'ct',
      killerId: killer && killer.networkId ? killer.networkId : null,
      victimId: this.game.player && this.game.player.networkId,
      reward,
    });
  }

  // =========================================================================
  // Housekeeping / helpers
  // =========================================================================

  _onRoundStart() {
    for (let i = 0; i < this._projectiles.length; i++) {
      if (this._projectiles[i].active) this._release(this._projectiles[i]);
    }
    this.smokes.length = 0;
  }

  _isPlayer(x) {
    return !!x && (x === this.game.player || x === 'player' || x.isPlayer === true);
  }

  _localPlayerName() {
    const mp = this.game.multiplayer;
    return mp && mp.active ? (mp.localName || 'Operative') : 'You';
  }

  _weaponIdOf(w) {
    if (typeof w === 'string' && w) return w;
    if (w && typeof w.id === 'string') return w.id;
    return 'world';
  }

  _def(id) {
    const d = WEAPONS && WEAPONS[id];
    if (d) return d;
    if (id !== 'c4' && id !== 'world' && !this._warned.has(id)) {
      this._warned.add(id);
      console.warn(`[combat] unknown weapon id "${id}" — using fallback stats`);
    }
    return FALLBACK_DEF;
  }
}
