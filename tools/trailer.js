// ============================================================================
// TINY STRIKE — tools/trailer.js
//
// Cinematic trailer recorder. Loaded by src/main.js when the URL has ?trailer
// (which also forces game.debug so the input module accepts synthetic events).
//
// The recorder drives the game DETERMINISTICALLY — it never relies on
// requestAnimationFrame. Per captured frame it calls every subsystem's
// update(1/60) twice (= 1/30 s of game time), renders at 1920x1080, composites
// the WebGL frame plus a hand-drawn cinematic HUD onto an offscreen 2D canvas,
// and POSTs the JPEG to the capture sink at http://localhost:8021.
//
//   window.__trailer.start()   -> Promise<summary>   (takes minutes)
//   window.__trailer.progress  -> { frame, totalFrames, scene, uploading,
//                                   dryRun, notes, ... }
//   window.__trailer.abort()
//
// Staging touches only stable bot fields (pos, yaw, alive, team, takeDamage,
// path, hasGoal) plus the public module APIs from SPEC.md.
// ============================================================================

import * as THREE from 'three';
import { WEAPONS } from '../src/weapons/data.js';
import initAudioRenderer from './trailer-audio.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const W = 1920;
const H = 1080;
const FPS = 30;
const STEP_DT = 1 / 60;
const STEPS_PER_FRAME = 2;
const LB = Math.round(H * 0.08);            // letterbox bar height
const CAPTURE_BASE = 'http://localhost:8021';
const JPEG_QUALITY = 0.87;

// Grenade ids: their 'weapon:fire' is silent — audio comes from 'grenade:throw'.
const GRENADE_IDS = { hegrenade: 1, flashbang: 1, smokegrenade: 1 };

const UPDATE_ORDER = [
  'rounds', 'player', 'weapons', 'viewmodel', 'bots',
  'combat', 'effects', 'hud', 'audio', 'input',
];

// CS olive-green palette (matches the game's DOM HUD flavor)
const C = {
  olive: '#9ab26b',
  oliveBright: '#c8d6b9',
  oliveDim: 'rgba(154,178,107,0.55)',
  chip: 'rgba(10,12,8,0.55)',
  chipEdge: 'rgba(154,178,107,0.30)',
  red: '#e0533d',
  white: '#f2f5ea',
  ct: '#9fc2e8',
  t: '#dfa45c',
};

// ---------------------------------------------------------------------------
// Small math / easing helpers (exposed on the director too)
// ---------------------------------------------------------------------------
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeInCubic = (t) => t * t * t;
const smoothstep = (t) => t * t * (3 - 2 * t);
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const within = (t, a, b) => t >= a && t < b;

// ---------------------------------------------------------------------------
// The director
// ---------------------------------------------------------------------------
class TrailerDirector {
  constructor(game) {
    this.game = game;

    this.progress = {
      frame: 0,
      totalFrames: 0,
      scene: 'idle',
      sceneFrame: 0,
      uploading: false,
      dryRun: false,
      uploaded: 0,
      done: false,
      running: false,
      error: null,
      notes: [],
    };

    this._abortFlag = false;
    this._running = false;

    // --- synthetic input bookkeeping ---
    this._keysHeld = new Set();
    this._mouseHeld = new Set();

    // --- aim state ---
    this._noiseT = Math.random() * 100;

    // --- staged-bot pins: bot -> Vector3 (re-applied after every step) ---
    this._pins = new Map();

    // --- cast protection: bots that must survive until their scene ---
    this._protected = new Set();

    // --- per-scene scratch state ---
    this._s = {};

    // --- flags set by game events ---
    this._planted = false;
    this._defused = false;

    // --- cinematic HUD state (advanced by the composite clock, not rAF) ---
    this._hudClock = 0;
    this._hudMode = 'none'; // 'none' | 'cine' | 'gameplay'
    this._kills = [];
    this._hitmarker = 0;      // seconds remaining
    this._hitmarkerKill = false;
    this._hitmarkerHS = false;
    this._flash = 0;          // 0..1 white overlay
    this._dmgPulse = 0;       // 0..1 red vignette
    this._banners = [];       // queue of { text, sub }
    this._banner = null;      // { text, sub, t }
    this._caption = null;     // { text, t, dur }
    this._sysErrNoted = new Set();

    // --- audio event log (soundtrack pipeline — tools/trailer-audio.js) ---
    this.audioLog = [];        // { t, type, ... } on the final video timeline
    this._audioUnsubs = [];    // recording-scoped listener removers
    this._captureFrame = 0;    // frame index being produced (t = frame / FPS)
    this._logMuted = false;    // true during uncaptured warm-up stepping
    this._lastImpactLogT = -1; // fx:impact subsample gate (<=10/s)
    this._lastBloodLogT = -1;  // fx:blood subsample gate (<=10/s)
    this._lastDmgLogT = -1;    // player:damage subsample gate (<=4/s)
    this._lastPStepLogT = -1;  // player footstep gate (<=5/s)
    this._lastBStepLogT = -1;  // bot footstep gate (<=5/s)
    this._defusingLogged = false;
    this._vCamF = new THREE.Vector3(); // scratch for pan computation

    // --- composite canvas ---
    this._canvas = document.createElement('canvas');
    this._canvas.width = W;
    this._canvas.height = H;
    this._g2d = this._canvas.getContext('2d');

    // scratch
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();

    this._bindEvents();
    this._scenes = this._buildScenes();
    this.progress.totalFrames = this._scenes.reduce(
      (n, s) => n + Math.round(s.duration * FPS), 0
    );
    this.progress.sceneList = this._scenes.map(
      (s) => `${s.name} (${s.duration}s)`
    );
  }

  // =========================================================================
  // Notes / event wiring
  // =========================================================================
  _note(msg) {
    this.progress.notes.push(msg);
    console.warn('[trailer] ' + msg);
  }

  _bindEvents() {
    const ev = this.game.events;
    if (!ev || typeof ev.on !== 'function') return;

    ev.on('kill', (e) => {
      if (!e) return;
      const def = WEAPONS && WEAPONS[e.weaponId];
      this._kills.push({
        a: e.killerName || '?',
        at: e.killerTeam || 't',
        b: e.victimName || '?',
        bt: e.victimTeam || 't',
        w: def ? def.name : (e.weaponId === 'c4' ? 'C4' : e.weaponId || '?'),
        hs: !!e.headshot,
        t: this._hudClock,
      });
      if (this._kills.length > 6) this._kills.shift();
    });

    ev.on('hud:hitmarker', (e) => {
      this._hitmarker = 0.28;
      this._hitmarkerKill = !!(e && e.kill);
      this._hitmarkerHS = !!(e && e.headshot);
    });

    ev.on('hud:flash', (e) => {
      const i = e && typeof e.intensity === 'number' ? e.intensity : 1;
      this._flash = Math.max(this._flash, clamp(i, 0, 1));
    });

    ev.on('player:damage', (e) => {
      const amt = e && typeof e.amount === 'number' ? e.amount : 20;
      this._dmgPulse = clamp(this._dmgPulse + 0.25 + amt * 0.012, 0, 1);
    });

    ev.on('round:phase', (e) => {
      if (e && e.phase === 'planted') {
        this._planted = true;
        this._queueBanner('THE BOMB HAS BEEN PLANTED', '40 SECONDS TO DETONATION');
      }
    });

    ev.on('bomb:defused', () => {
      this._defused = true;
      this._queueBanner('BOMB DEFUSED', null);
    });

    ev.on('round:end', (e) => {
      if (!e) return;
      if (e.winner === 'ct') {
        this._queueBanner('COUNTER-TERRORISTS WIN', e.reason === 'defuse' ? 'SITE SECURED' : null);
      } else if (e.winner === 't') {
        this._queueBanner('TERRORISTS WIN', null);
      }
    });
  }

  _queueBanner(text, sub) {
    this._banners.push({ text, sub });
  }

  // =========================================================================
  // Audio event log (soundtrack pipeline — rendered by tools/trailer-audio.js)
  // Every entry is stamped with the final-video timestamp of the frame being
  // produced when the event fired: t = captured frame index / FPS.
  // =========================================================================
  _alog(entry) {
    if (this._logMuted) return;
    entry.t = Math.round((this._captureFrame / FPS) * 1000) / 1000;
    this.audioLog.push(entry);
  }

  /** Camera-relative { dist, pan } snapshot for a world position (log time). */
  _distPan(pos) {
    const cam = this.game.camera;
    const cp = cam.position;
    const dx = pos.x - cp.x;
    const dy = pos.y - cp.y;
    const dz = pos.z - cp.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    cam.getWorldDirection(this._vCamF);
    const f = this._vCamF;
    let pan = 0;
    const fl = Math.hypot(f.x, f.z);
    const hl = Math.hypot(dx, dz);
    if (fl > 0.001 && hl > 0.4) {
      // sin(camera-relative azimuth) = dot with the camera's right vector
      pan = clamp((dx * (-f.z / fl) + dz * (f.x / fl)) / hl, -1, 1);
    }
    return {
      dist: Math.round(dist * 100) / 100,
      pan: Math.round(pan * 100) / 100,
    };
  }

  _bindAudioLog() {
    const ev = this.game.events;
    if (!ev || typeof ev.on !== 'function') return;
    const U = this._audioUnsubs;

    U.push(ev.on('weapon:fire', (p) => {
      if (!p || GRENADE_IDS[p.weaponId]) return; // voiced via 'grenade:throw'
      this._alog({ type: 'weapon:fire', w: p.weaponId, melee: !!p.melee, dist: 0, pan: 0 });
    }));
    U.push(ev.on('bot:fire', (p) => {
      if (!p || !p.origin) return;
      const dp = this._distPan(p.origin);
      this._alog({ type: 'bot:fire', w: p.weaponId, dist: dp.dist, pan: dp.pan });
    }));
    U.push(ev.on('fx:explosion', (p) => {
      if (!p || !p.pos) return;
      const dp = this._distPan(p.pos);
      this._alog({ type: 'fx:explosion', dist: dp.dist, pan: dp.pan });
    }));
    U.push(ev.on('fx:flash', (p) => {
      if (!p || !p.pos) return;
      const dp = this._distPan(p.pos);
      this._alog({ type: 'fx:flash', dist: dp.dist, pan: dp.pan });
    }));
    U.push(ev.on('fx:smoke', (p) => {
      if (!p || !p.pos) return;
      const dp = this._distPan(p.pos);
      this._alog({ type: 'fx:smoke', dist: dp.dist, pan: dp.pan });
    }));
    U.push(ev.on('fx:impact', (p) => {
      if (!p || !p.point) return;
      const now = this._captureFrame / FPS;
      if (now - this._lastImpactLogT < 0.1) return; // subsample to <=10/s
      const dp = this._distPan(p.point);
      if (dp.dist > 60) return; // inaudible
      this._lastImpactLogT = now;
      this._alog({ type: 'fx:impact', surface: p.surface || 'concrete', dist: dp.dist, pan: dp.pan });
    }));
    U.push(ev.on('fx:blood', (p) => {
      if (!p || !p.point) return;
      const now = this._captureFrame / FPS;
      if (now - this._lastBloodLogT < 0.1) return; // subsample to <=10/s
      const dp = this._distPan(p.point);
      if (dp.dist > 40) return; // inaudible
      this._lastBloodLogT = now;
      this._alog({ type: 'fx:blood', dist: dp.dist, pan: dp.pan });
    }));
    U.push(ev.on('weapon:equip', (p) => {
      this._alog({ type: 'weapon:equip', w: (p && p.id) || null, dist: 0, pan: 0 });
    }));
    U.push(ev.on('bot:death', (p) => {
      if (!p || !p.bot || !p.bot.pos) return;
      const dp = this._distPan(p.bot.pos);
      if (dp.dist > 40) return; // inaudible
      this._alog({ type: 'bot:death', dist: dp.dist, pan: dp.pan });
    }));
    U.push(ev.on('player:land', (p) => {
      this._alog({ type: 'player:land', speed: (p && p.speed) || 3, dist: 0, pan: 0 });
    }));
    U.push(ev.on('player:damage', (p) => {
      const now = this._captureFrame / FPS;
      if (now - this._lastDmgLogT < 0.25) return; // <=4/s
      this._lastDmgLogT = now;
      this._alog({ type: 'player:damage', amount: (p && p.amount) || 10, dist: 0, pan: 0 });
    }));
    U.push(ev.on('kill', (p) => {
      this._alog({ type: 'kill', headshot: !!(p && p.headshot) });
    }));
    U.push(ev.on('hud:hitmarker', (p) => {
      this._alog({ type: 'hud:hitmarker', headshot: !!(p && p.headshot), kill: !!(p && p.kill) });
    }));
    U.push(ev.on('weapon:reload:start', (p) => {
      this._alog({ type: 'weapon:reload:start', w: (p && p.id) || null, dur: (p && p.duration) || 0 });
    }));
    U.push(ev.on('weapon:scope', (p) => {
      this._alog({ type: 'weapon:scope', level: (p && p.level) || 0 });
    }));
    U.push(ev.on('grenade:throw', (p) => {
      this._alog({ type: 'grenade:throw', g: (p && p.type) || null });
    }));
    U.push(ev.on('bomb:planted', () => this._alog({ type: 'bomb:planted' })));
    U.push(ev.on('bomb:defused', () => this._alog({ type: 'bomb:defused' })));
    U.push(ev.on('round:phase', (p) => {
      this._alog({ type: 'round:phase', phase: (p && p.phase) || null });
    }));
    U.push(ev.on('round:end', (p) => {
      this._alog({ type: 'round:end', winner: (p && p.winner) || null });
    }));
    U.push(ev.on('player:footstep', (p) => {
      const now = this._captureFrame / FPS;
      if (now - this._lastPStepLogT < 0.2) return; // <=5/s
      this._lastPStepLogT = now;
      this._alog({ type: 'player:footstep', walking: !!(p && p.walking), surface: (p && p.surface) || 'concrete', dist: 0, pan: 0 });
    }));
    U.push(ev.on('bot:footstep', (p) => {
      if (!p || !p.pos) return;
      const now = this._captureFrame / FPS;
      if (now - this._lastBStepLogT < 0.2) return; // <=5/s
      const dp = this._distPan(p.pos);
      if (dp.dist > 45) return; // inaudible
      this._lastBStepLogT = now;
      this._alog({ type: 'bot:footstep', dist: dp.dist, pan: dp.pan });
    }));
  }

  _unbindAudioLog() {
    for (const off of this._audioUnsubs) {
      try { off(); } catch (_) { /* ignore */ }
    }
    this._audioUnsubs.length = 0;
  }

  async _postAudioLog() {
    if (this.progress.dryRun || !this.audioLog.length) return;
    try {
      await fetch(`${CAPTURE_BASE}/audiolog`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          totalFrames: this.progress.totalFrames,
          fps: FPS,
          events: this.audioLog,
        }),
      });
    } catch (_) { /* sink gone — the in-memory log still drives renderAudio() */ }
  }

  // =========================================================================
  // Synthetic input
  // =========================================================================
  _ensureLock() {
    const input = this.game.input;
    if (input && !input.locked && typeof input.requestLock === 'function') {
      input.requestLock();
    }
  }

  key(k, down) {
    const has = this._keysHeld.has(k);
    if (down && !has) {
      this._keysHeld.add(k);
      window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    } else if (!down && has) {
      this._keysHeld.delete(k);
      window.dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true }));
    }
  }

  tapKey(k) {
    // press + release across this frame (down now, up next tick is fine too;
    // input records keydown immediately)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true }));
  }

  mouse(button, down) {
    this._ensureLock();
    const has = this._mouseHeld.has(button);
    if (down && !has) {
      this._mouseHeld.add(button);
      window.dispatchEvent(new MouseEvent('mousedown', { button, bubbles: true }));
    } else if (!down && has) {
      this._mouseHeld.delete(button);
      window.dispatchEvent(new MouseEvent('mouseup', { button, bubbles: true }));
    }
  }

  clickRMB() {
    this.mouse(2, true);
    this.mouse(2, false);
  }

  /** move = { f, b, l, r } booleans */
  setMove(move) {
    const m = move || {};
    this.key('w', !!m.f);
    this.key('s', !!m.b);
    this.key('a', !!m.l);
    this.key('d', !!m.r);
  }

  releaseInputs() {
    for (const k of Array.from(this._keysHeld)) this.key(k, false);
    for (const b of Array.from(this._mouseHeld)) this.mouse(b, false);
  }

  // =========================================================================
  // Aiming / steering (writes player.yaw / player.pitch directly)
  // =========================================================================
  _organicNoise(freqScale, amp) {
    const t = this._noiseT * (freqScale || 1);
    return (
      Math.sin(t * 1.7) * 0.5 +
      Math.sin(t * 3.13 + 1.31) * 0.32 +
      Math.sin(t * 5.71 + 4.2) * 0.18
    ) * amp;
  }

  _aimAnglesTo(target) {
    const p = this.game.player;
    const eye = p.eyePos();
    const dx = target.x - eye.x;
    const dy = target.y - eye.y;
    const dz = target.z - eye.z;
    // player convention: forward = (-sin yaw, 0, -cos yaw)
    const yaw = Math.atan2(-dx, -dz);
    const pitch = Math.atan2(dy, Math.hypot(dx, dz));
    return { yaw, pitch };
  }

  /**
   * smoothLookAt — ease player yaw/pitch toward aiming at a world position
   * with slight organic noise so the aim looks human.
   */
  smoothLookAt(target, rate, noiseAmp) {
    const p = this.game.player;
    if (!p) return 10;
    const want = this._aimAnglesTo(target);
    const r = rate == null ? 8 : rate;
    const k = 1 - Math.exp(-r * (1 / FPS));
    const na = noiseAmp == null ? 1 : noiseAmp;
    const ny = this._organicNoise(1.0, 0.006 * na);
    const np = this._organicNoise(1.37, 0.0042 * na);
    const dy = wrapAngle(want.yaw + ny - p.yaw);
    const dp = (want.pitch + np) - p.pitch;
    p.yaw += dy * k;
    p.pitch = clamp(p.pitch + dp * k, -1.4, 1.4);
    return Math.hypot(dy, dp); // remaining angular error (pre-step)
  }

  /** Steer toward a ground point (yaw only) and hold W. Returns 2D distance. */
  steerTo(point, rate) {
    const p = this.game.player;
    if (!p) return 0;
    const dx = point.x - p.position.x;
    const dz = point.z - p.position.z;
    const dist = Math.hypot(dx, dz);
    const wantYaw = Math.atan2(-dx, -dz);
    const k = 1 - Math.exp(-(rate == null ? 7 : rate) * (1 / FPS));
    p.yaw += wrapAngle(wantYaw - p.yaw) * k;
    p.pitch += (0 - p.pitch) * k * 0.5;
    this.setMove({ f: dist > 0.7 });
    return dist;
  }

  // =========================================================================
  // Staging helpers
  // =========================================================================
  tpPlayer(x, y, z, yaw, pitch) {
    const p = this.game.player;
    if (!p) return;
    p.position.set(x, y, z);
    p.velocity.set(0, 0, 0);
    if (typeof yaw === 'number') p.yaw = yaw;
    p.pitch = typeof pitch === 'number' ? pitch : 0;
  }

  /** Give (free) + equip a loadout. */
  arm(ids, equipId) {
    const w = this.game.weapons;
    if (!w) return;
    try {
      for (const id of ids) w.give(id, true);
      if (equipId) w.equip(equipId);
    } catch (err) {
      this._note('arm() failed: ' + err.message);
    }
  }

  pin(bot, x, y, z, yaw) {
    if (!bot) return;
    bot.pos.set(x, y, z);
    if (typeof yaw === 'number') bot.yaw = yaw;
    try { bot.path = null; bot.hasGoal = false; } catch (_) { /* stable-ish */ }
    this._pins.set(bot, new THREE.Vector3(x, y, z));
  }

  unpin(bot) {
    this._pins.delete(bot);
  }

  _applyPins() {
    for (const [bot, pos] of this._pins) {
      if (!bot || !bot.alive) continue;
      bot.pos.copy(pos);
      try { bot.path = null; bot.hasGoal = false; } catch (_) { /* ignore */ }
    }
  }

  /** Guaranteed-outcome fallback: finish a staged kill if RNG spared the bot. */
  ensureDead(bot, weaponId, label) {
    if (!bot || !bot.alive) return;
    try {
      bot.takeDamage(500, { from: this.game.player, weapon: weaponId, headshot: false, part: 'body' });
      this._note('fallback kill used: ' + label);
    } catch (err) {
      this._note('fallback kill failed (' + label + '): ' + err.message);
    }
  }

  _aliveTs() {
    const bots = this.game.bots;
    if (!bots || !Array.isArray(bots.all)) return [];
    return bots.all.filter((b) => b && b.team === 't' && b.alive);
  }

  _cts() {
    const bots = this.game.bots;
    if (!bots || !Array.isArray(bots.all)) return [];
    return bots.all.filter((b) => b && b.team === 'ct');
  }

  _topUpPlayer() {
    const p = this.game.player;
    if (!p) return;
    if (!p.alive) {
      // The show must go on: quiet resurrection (should not happen — armor +
      // per-step top-up make single-step lethal damage nearly impossible).
      p.alive = true;
      p.health = 100;
      if (!this._resNoted) {
        this._resNoted = true;
        this._note('player died mid-recording — resurrected to continue');
      }
      return;
    }
    if (p.health < 100) p.health = 100;
    if (p.armor < 100) p.armor = 100;
  }

  // =========================================================================
  // Deterministic stepping
  // =========================================================================
  _stepOnce() {
    const g = this.game;
    for (const key of UPDATE_ORDER) {
      const sys = g[key];
      if (!sys || typeof sys.update !== 'function') continue;
      try {
        sys.update(STEP_DT);
      } catch (err) {
        if (!this._sysErrNoted.has(key)) {
          this._sysErrNoted.add(key);
          this._note(`update error in '${key}' (continuing): ${err.message}`);
        }
      }
    }
    this._applyPins();
    this._topUpPlayer();
    // plot armor: cast members cannot die before their scripted moment
    for (const b of this._protected) {
      if (b && b.alive && b.health < 100) b.health = 100;
    }
  }

  /** Uncaptured warm-up stepping (e.g. burn through menu + freeze). */
  _warmupUntil(cond, maxSteps) {
    let n = 0;
    // Warm-up game time is not captured — mute the audio log so compressed
    // off-screen events don't pile onto a single video timestamp.
    this._logMuted = true;
    while (n < maxSteps && !cond()) {
      this._stepOnce();
      n++;
    }
    this._logMuted = false;
    if (!cond()) this._note('warm-up hit step budget (' + maxSteps + ')');
    return n;
  }

  // =========================================================================
  // Capture / upload
  // =========================================================================
  _blob() {
    return new Promise((resolve) => {
      try {
        this._canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY);
      } catch (err) {
        resolve(null);
      }
    });
  }

  async _upload(n, blob) {
    if (this.progress.dryRun || !blob) return;
    const url = `${CAPTURE_BASE}/frame?n=${n}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        this.progress.uploading = true;
        const res = await fetch(url, { method: 'POST', body: blob });
        this.progress.uploading = false;
        if (res.ok) {
          this.progress.uploaded++;
          this._consecFail = 0;
          return;
        }
      } catch (err) {
        this.progress.uploading = false;
      }
    }
    if (n === 0) {
      this.progress.dryRun = true;
      this._note('capture server unreachable on first frame — dry-run mode');
      return;
    }
    this._consecFail = (this._consecFail || 0) + 1;
    if (this._consecFail === 1) this._note('frame upload failed at #' + n + ' (continuing)');
    if (this._consecFail > 30) {
      this.progress.dryRun = true;
      this._note('too many upload failures — switching to dry-run');
    }
  }

  async _finishUpload() {
    if (this.progress.dryRun) return;
    try {
      await fetch(`${CAPTURE_BASE}/done`, { method: 'POST' });
    } catch (_) { /* sink already gone — fine */ }
  }

  // =========================================================================
  // Cinematic HUD (drawn on the composite canvas — the DOM HUD is never used)
  // =========================================================================
  _advanceHudClock() {
    const dt = 1 / FPS;
    this._hudClock += dt;
    this._noiseT += dt;
    this._hitmarker = Math.max(0, this._hitmarker - dt);
    this._flash *= Math.exp(-2.3 * dt);
    if (this._flash < 0.01) this._flash = 0;
    this._dmgPulse *= Math.exp(-2.0 * dt);
    if (this._dmgPulse < 0.01) this._dmgPulse = 0;

    if (this._banner) {
      this._banner.t += dt;
      if (this._banner.t > 2.7) this._banner = null;
    }
    if (!this._banner && this._banners.length) {
      this._banner = { ...this._banners.shift(), t: 0 };
    }
    if (this._caption) this._caption.t += dt;
  }

  setCaption(text, dur) {
    this._caption = text ? { text, t: 0, dur: dur || 4.2 } : null;
  }

  _font(size, weight) {
    return `${weight || 700} ${size}px "Arial Narrow", "Helvetica Neue", Arial, sans-serif`;
  }

  _text(g, str, x, y, opts) {
    const o = opts || {};
    g.save();
    g.font = this._font(o.size || 20, o.weight);
    g.textAlign = o.align || 'left';
    g.textBaseline = o.baseline || 'alphabetic';
    try { if (o.ls) g.letterSpacing = o.ls + 'px'; } catch (_) { /* older ctx */ }
    if (o.glow) {
      g.shadowColor = o.glow;
      g.shadowBlur = o.glowBlur || 18;
    }
    g.globalAlpha = o.alpha == null ? 1 : clamp(o.alpha, 0, 1);
    g.fillStyle = o.color || C.white;
    g.fillText(str, x, y);
    g.restore();
  }

  _chip(g, x, y, w, h, alpha) {
    g.save();
    g.globalAlpha = alpha == null ? 1 : alpha;
    g.fillStyle = C.chip;
    g.strokeStyle = C.chipEdge;
    g.lineWidth = 1;
    g.beginPath();
    if (g.roundRect) g.roundRect(x, y, w, h, 6);
    else g.rect(x, y, w, h);
    g.fill();
    g.stroke();
    g.restore();
  }

  _drawHUD(g) {
    const game = this.game;
    const st = game.state || {};
    const pl = game.player;
    const wp = game.weapons;
    const mode = this._hudMode;

    const scoped = !!(wp && typeof wp.isScoped === 'function' && wp.isScoped());
    const alive = !!(pl && pl.alive);

    // ---- damage vignette (under everything else) ----
    if (this._dmgPulse > 0.02 && mode === 'gameplay') {
      const grad = g.createRadialGradient(W / 2, H / 2, H * 0.28, W / 2, H / 2, H * 0.72);
      grad.addColorStop(0, 'rgba(180,20,10,0)');
      grad.addColorStop(1, `rgba(180,20,10,${(0.55 * this._dmgPulse).toFixed(3)})`);
      g.fillStyle = grad;
      g.fillRect(0, 0, W, H);
    }

    // ---- AWP scope overlay ----
    if (scoped && mode === 'gameplay') {
      const r = H * 0.42;
      g.save();
      g.beginPath();
      g.rect(0, 0, W, H);
      g.arc(W / 2, H / 2, r, 0, Math.PI * 2, true);
      g.fillStyle = 'rgba(3,5,3,0.965)';
      g.fill('evenodd');
      // lens ring
      g.beginPath();
      g.arc(W / 2, H / 2, r, 0, Math.PI * 2);
      g.lineWidth = 5;
      g.strokeStyle = 'rgba(0,0,0,0.9)';
      g.stroke();
      g.beginPath();
      g.arc(W / 2, H / 2, r - 6, 0, Math.PI * 2);
      g.lineWidth = 1.5;
      g.strokeStyle = 'rgba(154,178,107,0.35)';
      g.stroke();
      // cross lines
      g.lineWidth = 1.6;
      g.strokeStyle = 'rgba(0,0,0,0.95)';
      g.beginPath();
      g.moveTo(W / 2 - r, H / 2); g.lineTo(W / 2 + r, H / 2);
      g.moveTo(W / 2, H / 2 - r); g.lineTo(W / 2, H / 2 + r);
      g.stroke();
      // mil ticks
      g.lineWidth = 1.2;
      for (let i = 1; i <= 4; i++) {
        const d = i * r * 0.18;
        g.beginPath();
        g.moveTo(W / 2 + d, H / 2 - 8); g.lineTo(W / 2 + d, H / 2 + 8);
        g.moveTo(W / 2 - d, H / 2 - 8); g.lineTo(W / 2 - d, H / 2 + 8);
        g.moveTo(W / 2 - 8, H / 2 + d); g.lineTo(W / 2 + 8, H / 2 + d);
        g.moveTo(W / 2 - 8, H / 2 - d); g.lineTo(W / 2 + 8, H / 2 - d);
        g.stroke();
      }
      g.restore();
    }

    // ---- dynamic crosshair ----
    if (mode === 'gameplay' && alive && !scoped) {
      let spread = 0;
      try {
        if (wp && typeof wp.currentSpread === 'function') spread = wp.currentSpread() || 0;
      } catch (_) { /* ignore */ }
      const gap = clamp(spread * 900, 4, 70);
      const len = 13;
      const cx = W / 2;
      const cy = H / 2;
      g.save();
      g.lineCap = 'butt';
      const draw = (color, lw, extra) => {
        g.strokeStyle = color;
        g.lineWidth = lw;
        g.beginPath();
        g.moveTo(cx + gap + extra, cy); g.lineTo(cx + gap + len - extra, cy);
        g.moveTo(cx - gap - extra, cy); g.lineTo(cx - gap - len + extra, cy);
        g.moveTo(cx, cy + gap + extra); g.lineTo(cx, cy + gap + len - extra);
        g.moveTo(cx, cy - gap - extra); g.lineTo(cx, cy - gap - len + extra);
        g.stroke();
      };
      draw('rgba(0,0,0,0.8)', 4.6, -1);
      draw('rgba(178,206,120,0.95)', 2.2, 0);
      g.restore();
    }

    // ---- hitmarker ----
    if (this._hitmarker > 0 && mode === 'gameplay') {
      const a = clamp(this._hitmarker / 0.28, 0, 1);
      const big = this._hitmarkerHS ? 1.45 : 1;
      const gp = 9 * big;
      const ln = 13 * big;
      const cx = W / 2, cy = H / 2;
      g.save();
      g.globalAlpha = a;
      g.strokeStyle = this._hitmarkerKill ? 'rgba(235,80,60,0.95)' : 'rgba(245,245,240,0.95)';
      g.lineWidth = 2.6;
      g.beginPath();
      for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        g.moveTo(cx + sx * gp, cy + sy * gp);
        g.lineTo(cx + sx * (gp + ln), cy + sy * (gp + ln));
      }
      g.stroke();
      g.restore();
    }

    // ---- bottom-left: health chip ----
    if (mode === 'gameplay') {
      const hx = 64, hy = H - LB - 96, hw = 236, hh = 62;
      this._chip(g, hx, hy, hw, hh);
      // cross icon
      g.save();
      g.fillStyle = C.olive;
      const cxi = hx + 34, cyi = hy + hh / 2;
      g.fillRect(cxi - 5, cyi - 15, 10, 30);
      g.fillRect(cxi - 15, cyi - 5, 30, 10);
      g.restore();
      const hp = pl ? Math.max(0, Math.round(pl.health)) : 0;
      this._text(g, String(hp), hx + 62, hy + 45, { size: 40, color: C.oliveBright, ls: 1 });
      // armor sliver
      if (pl && pl.armor > 0) {
        const aw = (hw - 24) * clamp(pl.armor / 100, 0, 1);
        g.save();
        g.fillStyle = 'rgba(159,194,232,0.28)';
        g.fillRect(hx + 12, hy + hh - 8, hw - 24, 4);
        g.fillStyle = 'rgba(159,194,232,0.85)';
        g.fillRect(hx + 12, hy + hh - 8, aw, 4);
        g.restore();
      }

      // ---- bottom-right: ammo chip ----
      const aw2 = 300, ax = W - 64 - aw2, ay = hy;
      this._chip(g, ax, ay, aw2, hh);
      let magStr = '—', resStr = '', wname = 'KNIFE';
      try {
        const def = wp && wp.current ? wp.current() : null;
        if (def) wname = (def.name || def.id || '').toUpperCase();
        const ammo = wp && wp.currentAmmo ? wp.currentAmmo() : null;
        if (ammo) {
          magStr = String(ammo.mag);
          resStr = ' / ' + ammo.reserve;
        }
      } catch (_) { /* ignore */ }
      this._text(g, wname, ax + aw2 - 16, ay + 22, {
        size: 15, align: 'right', color: C.oliveDim, ls: 2,
      });
      this._text(g, magStr, ax + aw2 - 16 - (resStr ? 78 : 0), ay + 52, {
        size: 38, align: 'right', color: C.oliveBright,
      });
      if (resStr) {
        this._text(g, resStr, ax + aw2 - 16, ay + 52, {
          size: 24, align: 'right', color: C.oliveDim,
        });
      }

      // ---- defuse progress bar ----
      const bomb = st.bomb || {};
      if (bomb.planted && bomb.defuseProgress > 0.05 && bomb.defusingBy === 'player') {
        const need = bomb.defuseTime || 10;
        const frac = clamp(bomb.defuseProgress / need, 0, 1);
        const bw = 470, bh = 30;
        const bx = (W - bw) / 2, by = H - LB - 118;
        this._chip(g, bx, by - 30, bw, bh + 44);
        this._text(g, 'DEFUSING — KIT ENGAGED', W / 2, by - 8, {
          size: 16, align: 'center', color: C.oliveBright, ls: 3,
        });
        g.save();
        g.fillStyle = 'rgba(0,0,0,0.55)';
        g.fillRect(bx + 12, by + 2, bw - 24, bh - 12);
        g.fillStyle = C.olive;
        g.fillRect(bx + 12, by + 2, (bw - 24) * frac, bh - 12);
        g.restore();
      }
    }

    // ---- top-center: timer + scores ----
    if (mode === 'gameplay' || mode === 'cine') {
      const tw = 250, tx = (W - tw) / 2, ty = LB + 14;
      this._chip(g, tx, ty, tw, 68, 0.92);
      const timer = Math.max(0, st.timer || 0);
      const m = Math.floor(timer / 60);
      const s = Math.floor(timer % 60);
      const tstr = `${m}:${s < 10 ? '0' : ''}${s}`;
      const planted = !!(st.bomb && st.bomb.planted) && !this._defused;
      const urgent = planted || (st.phase === 'live' && timer < 10);
      this._text(g, tstr, W / 2, ty + 34, {
        size: 34, align: 'center',
        color: urgent ? C.red : C.oliveBright,
        glow: planted ? 'rgba(224,83,61,0.8)' : null, glowBlur: 10,
      });
      const sc = st.scores || { ct: 0, t: 0 };
      this._text(g, `CT ${sc.ct}`, W / 2 - 26, ty + 58, { size: 18, align: 'right', color: C.ct });
      this._text(g, '—', W / 2, ty + 58, { size: 16, align: 'center', color: C.oliveDim });
      this._text(g, `${sc.t} T`, W / 2 + 26, ty + 58, { size: 18, align: 'left', color: C.t });
      if (planted) {
        const blink = (Math.sin(this._hudClock * 9) + 1) / 2;
        g.save();
        g.globalAlpha = 0.45 + blink * 0.55;
        g.fillStyle = C.red;
        g.beginPath();
        g.arc(tx + 26, ty + 28, 7, 0, Math.PI * 2);
        g.fill();
        g.restore();
        this._text(g, 'ARMED', tx + 16, ty + 54, { size: 12, color: C.red, ls: 1 });
      }
    }

    // ---- killfeed (top-right) ----
    if (mode === 'gameplay' || mode === 'cine') {
      let y = LB + 34;
      for (const k of this._kills) {
        const age = this._hudClock - k.t;
        if (age > 4.2) continue;
        const a = age > 3.4 ? 1 - (age - 3.4) / 0.8 : 1;
        const self = k.a === 'You' || k.b === 'You';
        g.save();
        g.font = this._font(19);
        const wLabel = `[${k.w}]${k.hs ? ' ☠' : ''}`;
        const aW = g.measureText(k.a).width;
        const wW = g.measureText(wLabel).width;
        const bW = g.measureText(k.b).width;
        const pad = 12, gapx = 9;
        const total = aW + wW + bW + gapx * 2 + pad * 2;
        const x0 = W - 56 - total;
        g.restore();
        this._chip(g, x0, y - 21, total, 30, (self ? 0.95 : 0.72) * a);
        let x = x0 + pad;
        this._text(g, k.a, x, y, { size: 19, color: k.at === 'ct' ? C.ct : C.t, alpha: a });
        x += aW + gapx;
        this._text(g, wLabel, x, y, { size: 19, color: k.hs ? C.red : C.oliveBright, alpha: a });
        x += wW + gapx;
        this._text(g, k.b, x, y, { size: 19, color: k.bt === 'ct' ? C.ct : C.t, alpha: a });
        y += 37;
      }
    }

    // ---- flashbang whiteout ----
    if (this._flash > 0.02) {
      g.save();
      g.globalAlpha = clamp(Math.pow(this._flash, 0.75), 0, 1);
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, W, H);
      g.restore();
    }

    // ---- subtle vignette ----
    const vg = g.createRadialGradient(W / 2, H / 2, H * 0.42, W / 2, H / 2, H * 0.86);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.34)');
    g.fillStyle = vg;
    g.fillRect(0, 0, W, H);

    // ---- letterbox bars ----
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, LB);
    g.fillRect(0, H - LB, W, LB);

    // ---- lower-third scene caption (inside the bottom letterbox bar) ----
    if (this._caption) {
      const c = this._caption;
      let a = 1;
      if (c.t < 0.45) a = c.t / 0.45;
      else if (c.t > c.dur - 0.5) a = clamp((c.dur - c.t) / 0.5, 0, 1);
      if (a > 0.01) {
        const y = H - LB + 52;
        g.save();
        g.globalAlpha = a;
        g.fillStyle = C.olive;
        g.fillRect(70, y - 15, 4, 20);
        g.restore();
        this._text(g, c.text.toUpperCase(), 86, y, {
          size: 19, color: C.oliveBright, ls: 4, alpha: a,
        });
      }
    }

    // ---- center banner ----
    if (this._banner) {
      const b = this._banner;
      let a = 1;
      if (b.t < 0.14) a = b.t / 0.14;
      else if (b.t > 2.3) a = clamp((2.7 - b.t) / 0.4, 0, 1);
      const y = H * 0.30;
      g.save();
      g.globalAlpha = a * 0.5;
      g.fillStyle = 'rgba(0,0,0,0.85)';
      g.fillRect(0, y - 58, W, b.sub ? 116 : 92);
      g.restore();
      this._text(g, b.text, W / 2, y, {
        size: 52, align: 'center', color: C.oliveBright, ls: 8,
        alpha: a, glow: 'rgba(154,178,107,0.55)', glowBlur: 22,
      });
      if (b.sub) {
        this._text(g, b.sub, W / 2, y + 40, {
          size: 20, align: 'center', color: C.oliveDim, ls: 5, alpha: a,
        });
      }
    }
  }

  _drawTitleCard(g, t, dur, title, subtitle, opts) {
    const o = opts || {};
    // backdrop
    g.save();
    g.globalAlpha = o.backdropAlpha == null ? 1 : o.backdropAlpha;
    g.fillStyle = '#050604';
    g.fillRect(0, 0, W, H);
    g.restore();

    const inA = (from, to) => clamp((t - from) / (to - from), 0, 1);
    const outA = t > dur - 0.6 ? clamp((dur - t) / 0.6, 0, 1) : 1;

    const aTitle = easeOutCubic(inA(0.35, 1.15)) * outA;
    const aSub = easeOutCubic(inA(0.85, 1.65)) * outA;
    const aExtra = easeOutCubic(inA(1.2, 2.0)) * outA;

    if (aTitle > 0.01) {
      // top rule
      g.save();
      g.globalAlpha = aTitle * 0.85;
      g.fillStyle = C.olive;
      g.fillRect(W / 2 - 160, H / 2 - 128, 320, 3);
      g.restore();
      this._text(g, title, W / 2, H / 2 - 28, {
        size: 96, align: 'center', color: C.oliveBright, ls: 14,
        alpha: aTitle, glow: 'rgba(154,178,107,0.6)', glowBlur: 34,
      });
    }
    if (subtitle && aSub > 0.01) {
      this._text(g, subtitle, W / 2, H / 2 + 34, {
        size: 26, align: 'center', color: C.olive, ls: 8, alpha: aSub,
      });
    }
    if (o.extra && aExtra > 0.01) {
      this._text(g, o.extra, W / 2, H / 2 + 96, {
        size: 28, align: 'center', color: C.olive, ls: 5, alpha: aExtra,
      });
    }
    // letterbox continuity
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, LB);
    g.fillRect(0, H - LB, W, LB);
  }

  // =========================================================================
  // Scene composition per frame
  // =========================================================================
  _composite(scene, t) {
    const g = this._g2d;
    this._advanceHudClock();

    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);
    try {
      g.drawImage(this.game.canvas, 0, 0, W, H);
    } catch (_) { /* context loss — keep black */ }

    this._drawHUD(g);
    if (scene.overlay) scene.overlay(g, t);

    // inter-scene dip to black
    const dIn = scene.dipIn || 0;
    const dOut = scene.dipOut || 0;
    let dip = 0;
    if (dIn > 0 && t < dIn) dip = 1 - t / dIn;
    if (dOut > 0 && t > scene.duration - dOut) {
      dip = Math.max(dip, (t - (scene.duration - dOut)) / dOut);
    }
    if (dip > 0.01) {
      g.save();
      g.globalAlpha = clamp(dip, 0, 1);
      g.fillStyle = '#000';
      g.fillRect(0, 0, W, H);
      g.restore();
    }
  }

  // =========================================================================
  // THE SEQUENCE
  // =========================================================================
  _buildScenes() {
    const T = this;
    const game = this.game;

    // Pen coordinates (see map.js): CT bots go to the T-plaza SW corner
    // (no line of sight to either bomb site or any staged action), unused
    // T bots wait inside the enclosed B-tunnel chamber.
    const CT_PEN = [
      [-44.3, 0.06, 28.0], [-43.2, 0.06, 29.6], [-44.6, 0.06, 31.2],
      [-43.0, 0.06, 27.2], [-44.0, 0.06, 30.4], [-43.6, 0.06, 32.4],
    ];
    const T_PEN = [
      [-39.5, 0.06, 6.5], [-36.5, 0.06, 5.2], [-33.5, 0.06, 6.8],
      [-37.5, 0.06, 8.3], [-32.2, 0.06, 6.0], [-35.0, 0.06, 7.4],
    ];

    const chest = (bot) => T._v.set(bot.pos.x, bot.pos.y + 1.3, bot.pos.z);

    return [
      // =====================================================================
      { // SCENE 1 — TITLE (3.5 s)
        name: 'title',
        duration: 3.5,
        setup() {
          T._hudMode = 'none';
          T.setCaption(null);
        },
        tick() { /* game steps underneath (menu -> freeze) */ },
        overlay(g, t) {
          T._drawTitleCard(g, t, 3.5, 'TINY STRIKE', 'TACTICAL BOMB DEFUSAL');
        },
      },

      // =====================================================================
      { // SCENE 2 — FLYOVER (5 s): live round unfolds below
        name: 'flyover',
        duration: 5,
        dipIn: 0.001, dipOut: 0.3,
        setup() {
          // Burn through menu auto-start + freeze so bots are moving.
          T._warmupUntil(() => game.state.phase === 'live', 720);
          T._ensureLock();
          const p = game.player;
          if (p) { p.armor = 100; }

          // Cast the whole trailer NOW, while every T is guaranteed alive,
          // and give the cast plot armor until their scripted moment.
          const bots = game.bots;
          const ts = T._aliveTs();
          const carrier = (bots && bots.bombCarrier && bots.bombCarrier.alive)
            ? bots.bombCarrier : ts[0] || null;
          const others = ts.filter((b) => b !== carrier);
          T._cast = {
            carrier,
            v1: others[0] || null,
            v2: others[1] || null,
            v3: others[2] || null,
            v4: others[3] || null,
            v5: others[4] || null,
          };
          if (ts.length < 6) T._note('only ' + ts.length + ' T bots alive at cast time');
          for (const key of ['carrier', 'v1', 'v2', 'v3', 'v4', 'v5']) {
            if (T._cast[key]) T._protected.add(T._cast[key]);
          }

          // hide the first-person weapon while the camera flies
          try {
            const grp = game.viewmodel && game.viewmodel.getWeaponGroup
              ? game.viewmodel.getWeaponGroup() : null;
            if (grp) { T._s.hiddenVm = grp; grp.visible = false; }
          } catch (_) { /* fine */ }

          T._s.pos = new THREE.CatmullRomCurve3([
            new THREE.Vector3(-8, 27, 39),
            new THREE.Vector3(0, 17, 12),
            new THREE.Vector3(9, 11, -9),
            new THREE.Vector3(23, 7.5, -19),
          ]);
          T._s.look = new THREE.CatmullRomCurve3([
            new THREE.Vector3(-2, 1, 24),
            new THREE.Vector3(0, 1.5, -8),
            new THREE.Vector3(18, 2, -15),
            new THREE.Vector3(33, 2.2, -17),
          ]);
          T._hudMode = 'cine';
          T.setCaption('STRIKE UNDERWAY', 4.6);
        },
        tick() { /* the round plays itself */ },
        camera(t) {
          const u = easeInOutCubic(clamp(t / 5, 0, 1));
          const cam = game.camera;
          const p = T._s.pos.getPoint(u);
          const l = T._s.look.getPoint(u);
          cam.position.copy(p);
          cam.lookAt(l);
        },
      },

      // =====================================================================
      { // SCENE 3 — MID PUSH (8 s): AK, two staged kills
        name: 'mid push',
        duration: 8,
        dipIn: 0.3, dipOut: 0.25,
        setup() {
          // restore viewmodel
          if (T._s.hiddenVm) { T._s.hiddenVm.visible = true; T._s.hiddenVm = null; }
          T._s = {};
          const bots = game.bots;

          // Nudge the carrier's committed site to B (fully enclosed room —
          // guarantees the plant can't be interrupted by long sightlines).
          try {
            const sites = game.world && game.world.bombSites;
            const b = sites && sites.find((s) => s && s.name === 'B');
            if (b && bots && bots._targetSite !== undefined) bots._targetSite = b;
          } catch (_) { T._note('could not steer plant site — using organic choice'); }

          // ---- pens ----
          T._cts().forEach((b, i) => {
            const p = CT_PEN[i % CT_PEN.length];
            T.pin(b, p[0], p[1], p[2], 0);
          });
          [T._cast.carrier, T._cast.v3, T._cast.v4, T._cast.v5].forEach((b, i) => {
            if (!b) return;
            const p = T_PEN[i % T_PEN.length];
            T.pin(b, p[0], p[1], p[2], Math.PI);
          });

          // ---- staged victims in the mid lane (protection off — they're up) ----
          const { v1, v2 } = T._cast;
          if (v1) { T.unpin(v1); T._protected.delete(v1); v1.pos.set(2.6, 0.06, -0.6); v1.yaw = 0; try { v1.path = null; v1.hasGoal = false; } catch (_) {} }
          if (v2) { T.unpin(v2); T._protected.delete(v2); v2.pos.set(-3.7, 0.06, 6.6); v2.yaw = 0; try { v2.path = null; v2.hasGoal = false; } catch (_) {} }

          // ---- player ----
          T.tpPlayer(0, 0.06, -22.5, Math.PI, 0);
          T.arm(['ak47'], 'ak47');
          T._hudMode = 'gameplay';
          T.setCaption('MID CONTROL', 5.2);
        },
        tick(t) {
          const { v1, v2 } = T._cast;
          const s = T._s;

          // movement: strafing push, pausing to shoot (counter-strafe)
          const bursting =
            within(t, 2.0, 3.9) || within(t, 4.85, 6.7);
          if (!bursting && t < 7.6) {
            const strafeL = Math.floor(t / 0.75) % 2 === 0;
            T.setMove({ f: true, l: strafeL, r: !strafeL });
          } else {
            T.setMove({});
          }

          // aim + fire plan
          if (t < 1.7) {
            T.smoothLookAt(T._v2.set(1, 1.6, -4), 6, 1.6);
          } else if (t < 4.0) {
            if (v1 && v1.alive) T.smoothLookAt(chest(v1), 13, 0.4);
            else T.smoothLookAt(T._v2.set(2.5, 1.4, 0), 7, 1.2);
            T.mouse(0,
              (within(t, 2.1, 2.5) || within(t, 2.7, 3.15) || within(t, 3.4, 3.8)) &&
              !!(v1 && v1.alive));
            if (t > 3.9 && v1) T.ensureDead(v1, 'ak47', 'mid kill #1');
          } else if (t < 4.7) {
            T.mouse(0, false);
            T.smoothLookAt(T._v2.set(-5, 1.8, 2), 5, 2.2); // organic scan left
          } else if (t < 6.8) {
            if (v2 && v2.alive) T.smoothLookAt(chest(v2), 13, 0.4);
            T.mouse(0,
              (within(t, 5.0, 5.45) || within(t, 5.65, 6.1) || within(t, 6.25, 6.65)) &&
              !!(v2 && v2.alive));
            if (t > 6.75 && v2) T.ensureDead(v2, 'ak47', 'mid kill #2');
          } else {
            T.mouse(0, false);
            if (t > 6.9 && !s.reloaded) { s.reloaded = true; T.tapKey('r'); }
            T.smoothLookAt(T._v2.set(0, 1.6, 14), 5, 1.4);
          }
        },
      },

      // =====================================================================
      { // SCENE 4 — AWP (6 s): scoped one-shot on a crossing bot.
        //  The bomb carrier is quietly staged at site B in the background —
        //  the organic plant flow (clear 1.5 s + plant 3.2 s) runs while the
        //  player holds the long angle.
        name: 'awp',
        duration: 6,
        dipIn: 0.25, dipOut: 0.25,
        setup() {
          T._s = {};
          T.releaseInputs();
          T.tpPlayer(44.2, 0.06, -4.2, Math.PI, 0);
          T.arm(['awp'], 'awp');
          T.setCaption('A LONG — OVERWATCH', 4.6);

          // staged crossing bot, pinned until the scope has settled
          const v3 = T._cast.v3;
          if (v3) { T._protected.delete(v3); T.pin(v3, 39.6, 0.06, 12.6, -Math.PI / 2); }

          // background: stage the plant (organic path)
          const c = T._cast.carrier;
          if (c && c.alive) {
            T.unpin(c);
            c.pos.set(-37, 1.06, -15);
            c.yaw = 0;
            try { c.path = null; c.hasGoal = false; } catch (_) {}
          } else {
            T._note('no live bomb carrier to stage — will force plant later');
          }
        },
        tick(t) {
          const v3 = T._cast.v3;
          const s = T._s;
          T.setMove({});

          if (t > 0.9 && !s.scoped) { s.scoped = true; T.clickRMB(); }

          // release the runner once we're scoped in
          if (t > 2.0 && !s.crossing && v3 && v3.alive) {
            s.crossing = true;
            T.unpin(v3);
            try {
              v3.path = [new THREE.Vector3(48.6, 0, 13.0)];
              v3.pathIndex = 0;
              v3.goal.copy(v3.path[0]);
              v3.hasGoal = true;
              v3.state = 'move';
            } catch (_) { T._note('could not set crossing path — bot will engage in place'); }
          }

          if (v3 && v3.alive) {
            // deliberate sniper track: slow rate, tiny noise
            T.smoothLookAt(chest(v3), t < 2.8 ? 4.5 : 9, 0.35);
          } else {
            T.smoothLookAt(T._v2.set(44, 1.2, 18), 3.5, 0.8);
          }

          if (t > 3.15 && !s.shot) {
            s.shot = true;
            T.mouse(0, true);
          }
          if (t > 3.3) T.mouse(0, false);
          if (t > 4.0 && t < 4.06 && v3) T.ensureDead(v3, 'awp', 'awp pick');
        },
      },

      // =====================================================================
      { // SCENE 5 — UTILITY (8 s): smoke into the B door, flashbang pop,
        //  HE lobbed through the mid double doors onto two bots at the barrel.
        name: 'utility',
        duration: 8,
        dipIn: 0.25, dipOut: 0.25,
        setup() {
          T._s = { wp: new THREE.Vector3(0.6, 0, -28.6) };
          T.releaseInputs();
          T.tpPlayer(-4.5, 0.06, -29.0, 2.1, 0);
          T.arm(['m4a1', 'smokegrenade', 'flashbang', 'hegrenade'], 'smokegrenade');
          T.setCaption('UTILITY — TAKE THE MAP', 5.0);
          const { v4, v5 } = T._cast;
          if (v4) T._protected.delete(v4);
          if (v5) T._protected.delete(v5);
        },
        tick(t) {
          const s = T._s;
          const { v4, v5 } = T._cast;

          // --- beat 1: smoke into the B door archway (watch it bloom) ---
          if (t < 3.3) {
            T.setMove({});
            T.smoothLookAt(T._v2.set(-19.5, 3.4, -25.9), 8, 0.8);
            if (t > 0.6 && !s.smoke) { s.smoke = true; T.mouse(0, true); }
            if (t > 0.78) T.mouse(0, false);
            return;
          }

          // --- reposition: ground-point steering to a fixed waypoint just
          //     shy of the double doors. Aim targets must NEVER drive the
          //     movement here — that funnels the player through the door gap.
          if (!s.arrived) {
            const dist = T.steerTo(s.wp, 8);
            if (dist < 0.8 || t > 4.7) { s.arrived = true; T.setMove({}); }
          } else {
            T.setMove({});
          }
          if (t > 4.0 && !s.flashEquipped) {
            s.flashEquipped = true;
            T.game.weapons.equip('flashbang');
          }

          // --- beat 2: standing flash lob, high over the plaza ---
          if (t >= 4.5 && t < 5.2) {
            if (s.arrived) T.smoothLookAt(T._v2.set(10, 7, -24.5), 9, 0.8);
            if (t > 4.75 && !s.flash) { s.flash = true; T.mouse(0, true); }
            if (t > 4.9) T.mouse(0, false);
            return;
          }
          if (t < 5.2) return;

          // --- beat 3: HE through the doors onto the staged pair ---
          if (!s.heEquipped) { s.heEquipped = true; T.game.weapons.equip('hegrenade'); }
          T.smoothLookAt(T._v2.set(-3, 4, -17), 8, 0.7);
          if (t > 5.85 && !s.he) { s.he = true; T.mouse(0, true); }
          if (t > 6.0) T.mouse(0, false);

          // Stage the HE victims by the mid barrel only once the grenade is
          // in flight: nobody can flinch the throw, and their pop-in hides
          // under the flashbang whiteout. Pre-weakened — HE caps at 98 vs
          // 100 hp, so a full-health pair could never die to one grenade.
          if (t > 6.55 && !s.staged) {
            s.staged = true;
            if (v4) {
              T.pin(v4, -3.6, 0.06, -17.5, Math.PI);
              try { v4.takeDamage(62, {}); } catch (_) {}
            }
            if (v5) {
              T.pin(v5, -2.2, 0.06, -16.2, Math.PI);
              try { v5.takeDamage(62, {}); } catch (_) {}
            }
          }

          if (t > 7.82 && t < 7.9) {
            if (v4) T.ensureDead(v4, 'hegrenade', 'HE kill #1');
            if (v5) T.ensureDead(v5, 'hegrenade', 'HE kill #2');
          }
          if (t > 6.2 && !s.plantCheck) {
            s.plantCheck = true;
            if (!T._planted) T._note('bomb not yet planted by end of utility scene');
          }
        },
      },

      // =====================================================================
      { // SCENE 6 — RETAKE (7 s): push the site, kill the defender.
        name: 'retake',
        duration: 7,
        dipIn: 0.25, dipOut: 0.25,
        setup() {
          T._s = {};
          T.releaseInputs();

          // Last resort if the organic plant never fired (logged): emit the
          // event flow manually so the sequence can continue.
          if (!T._planted && game.state.phase === 'live') {
            const c = T._cast.carrier;
            const pos = (c && c.alive)
              ? c.pos.clone()
              : new THREE.Vector3(-37, 1.0, -15);
            T._note('forcing bomb:planted (organic plant did not fire in time)');
            try { game.events.emit('bomb:planted', { site: 'B', pos }); } catch (_) {}
          }

          const bomb = game.state.bomb || {};
          const bombPos = bomb.pos
            ? new THREE.Vector3(bomb.pos.x, bomb.pos.y, bomb.pos.z)
            : new THREE.Vector3(-37, 1.0, -15);
          T._bombPos = bombPos;
          const site = bomb.site || 'B';
          T._siteName = site;

          // defender: the (former) carrier holds the site
          let d = T._cast.carrier && T._cast.carrier.alive ? T._cast.carrier : null;
          if (!d) d = T._aliveTs()[0] || null;
          T._cast.defender = d;
          if (d) {
            T.unpin(d);
            T._protected.delete(d);
            let faceX;
            let faceZ;
            if (site === 'B') { d.pos.set(-33.4, 1.06, -17.2); faceX = -20; faceZ = -26; }
            else { d.pos.set(34.5, 2.06, -14.5); faceX = 29; faceZ = -27; }
            // bot yaw convention: model faces (-sin yaw, -cos yaw)
            d.yaw = Math.atan2(-(faceX - d.pos.x), -(faceZ - d.pos.z));
            try { d.path = null; d.hasGoal = false; } catch (_) {}
          } else {
            T._note('no defender available for the retake scene');
          }

          if (site === 'B') {
            T.tpPlayer(-19.4, 0.06, -27.6, 2.4, 0);
            T._s.route = [
              new THREE.Vector3(-23.5, 0, -20.5),
              new THREE.Vector3(-29.0, 0, -15.2),
              new THREE.Vector3(bombPos.x + 1.4, bombPos.y, bombPos.z + 0.5),
            ];
          } else {
            T.tpPlayer(29, 0.06, -31.5, Math.PI, 0);
            T._s.route = [
              new THREE.Vector3(29, 2, -24.5),
              new THREE.Vector3(bombPos.x + 1.4, bombPos.y, bombPos.z + 0.8),
            ];
          }
          T._s.leg = 0;
          T.arm(['m4a1'], 'm4a1');
          T.setCaption('SITE ' + site + ' — RETAKE', 5.4);
        },
        tick(t) {
          const s = T._s;
          const d = T._cast.defender;
          const route = s.route;

          const engaging = d && d.alive && t > 1.9 && t < 5.2;
          if (engaging) {
            T.setMove({});
            T.smoothLookAt(chest(d), 11, 0.5);
            T.mouse(0, within(t, 2.25, 2.7) || within(t, 2.95, 3.45) || within(t, 3.8, 4.3));
          } else {
            T.mouse(0, false);
            if (t > 5.3 && t < 5.36 && d) T.ensureDead(d, 'm4a1', 'retake defender');
            // follow the route
            if (route && s.leg < route.length) {
              const dist = T.steerTo(route[s.leg], 8);
              if (dist < 1.0) s.leg++;
            } else {
              T.setMove({});
              if (T._bombPos) T.smoothLookAt(T._v2.copy(T._bombPos).setY(T._bombPos.y + 0.3), 7, 0.8);
            }
          }
        },
      },

      // =====================================================================
      { // SCENE 7 — DEFUSE (8 s): E-hold, progress bar, banners.
        name: 'defuse',
        duration: 8,
        dipIn: 0.25,
        setup() {
          T._s = {};
          T.releaseInputs();
          const bombPos = T._bombPos || new THREE.Vector3(-37, 1.0, -15);
          const p = game.player;
          if (p) p.hasKit = true; // 5 s defuse — trailer pacing
          T.tpPlayer(bombPos.x + 1.02, bombPos.y + 0.06, bombPos.z + 0.4, 0, -0.6);
          T.setCaption('CUT THE WIRE', 5.2);
          T._hudMode = 'gameplay';
        },
        tick(t) {
          const bombPos = T._bombPos;
          T.setMove({});
          if (bombPos) {
            T.smoothLookAt(T._v2.set(bombPos.x, bombPos.y + 0.12, bombPos.z), 9, 0.4);
          }
          if (t > 0.7) T.key('e', true);
          if (t > 6.9 && !T._defused && game.state.phase === 'planted') {
            T._note('forcing bomb:defused (player defuse did not complete in time)');
            try { game.events.emit('bomb:defused', { by: 'player' }); } catch (_) {}
          }
          if (t > 7.6) T.key('e', false);
        },
      },

      // =====================================================================
      { // SCENE 8 — END CARD (4 s)
        name: 'endcard',
        duration: 4,
        setup() {
          T.releaseInputs();
          T._hudMode = 'none';
          T.setCaption(null);
          T._banner = null;
          T._banners.length = 0;
          T._s = {};
        },
        tick() {},
        overlay(g, t) {
          const fadeIn = easeInOutCubic(clamp(t / 0.7, 0, 1));
          T._drawTitleCard(g, Math.max(0.0, t - 0.3), 3.7,
            'TINY STRIKE', 'PLAY FREE IN YOUR BROWSER',
            { backdropAlpha: fadeIn, extra: 'GUYZYSKIND.COM/TINYSTRIKE' });
        },
      },
    ];
  }

  // =========================================================================
  // Run control
  // =========================================================================
  abort() {
    this._abortFlag = true;
  }

  async start() {
    if (this._running) return this.progress;
    this._running = true;
    this._abortFlag = false;
    this.progress.running = true;
    this.progress.done = false;
    this.progress.error = null;

    // fresh run state (supports repeat runs on the same page)
    this.progress.frame = 0;
    this.progress.uploaded = 0;
    this.progress.notes.length = 0;
    this._consecFail = 0;
    this._planted = false;
    this._defused = false;
    this._kills.length = 0;
    this._banners.length = 0;
    this._banner = null;
    this._caption = null;
    this._flash = 0;
    this._dmgPulse = 0;
    this._hitmarker = 0;
    this._pins.clear();
    this._protected.clear();
    this._sysErrNoted.clear();

    // audio log: fresh recording-scoped state + listeners
    this.audioLog.length = 0;
    this._captureFrame = 0;
    this._logMuted = false;
    this._lastImpactLogT = -1;
    this._lastBloodLogT = -1;
    this._lastDmgLogT = -1;
    this._lastPStepLogT = -1;
    this._lastBStepLogT = -1;
    this._defusingLogged = false;
    this._bindAudioLog();

    let saved = null;
    try {
      saved = this._prepareRenderer();
      await this._runSequence();
    } catch (err) {
      this.progress.error = String((err && err.stack) || err);
      this._note('fatal error (sequence stopped): ' + ((err && err.message) || err));
    } finally {
      // remove recording-scoped audio listeners BEFORE re-arming the live
      // loop, so post-recording gameplay can't pollute the log
      this._unbindAudioLog();
      try { await this._finishUpload(); } catch (_) { /* ignore */ }
      try { await this._postAudioLog(); } catch (_) { /* ignore */ }
      try { this._restoreRenderer(saved); } catch (_) { /* ignore */ }
      this.releaseInputs();
      this._pins.clear();
      this.progress.running = false;
      this.progress.done = true;
      this._running = false;
    }

    return {
      frames: this.progress.frame,
      totalFrames: this.progress.totalFrames,
      uploaded: this.progress.uploaded,
      dryRun: this.progress.dryRun,
      aborted: this._abortFlag,
      audioEvents: this.audioLog.length,
      notes: this.progress.notes.slice(),
    };
  }

  _prepareRenderer() {
    const { renderer, camera } = this.game;
    const saved = {
      pixelRatio: renderer.getPixelRatio(),
      size: renderer.getSize(new THREE.Vector2()),
      aspect: camera.aspect,
    };
    // Kill the rAF loop — we drive the game manually and the embedded pane
    // starves rAF anyway. Restored (re-armed) in _restoreRenderer.
    renderer.setAnimationLoop(null);
    renderer.setPixelRatio(1);
    renderer.setSize(W, H, false); // keep CSS size
    camera.aspect = W / H;
    camera.updateProjectionMatrix();
    return saved;
  }

  _restoreRenderer(saved) {
    const { renderer, camera } = this.game;
    if (saved) {
      renderer.setPixelRatio(saved.pixelRatio);
      renderer.setSize(window.innerWidth, window.innerHeight);
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
    }
    // Re-arm a frame loop equivalent to main.js's so the page stays alive.
    const game = this.game;
    let last = performance.now();
    renderer.setAnimationLoop(() => {
      const now = performance.now();
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      for (const key of UPDATE_ORDER) {
        const sys = game[key];
        if (sys && typeof sys.update === 'function') sys.update(dt);
      }
      renderer.render(game.scene, game.camera);
    });
  }

  async _runSequence() {
    const game = this.game;
    let frameN = 0;

    for (const scene of this._scenes) {
      if (this._abortFlag) break;
      this.progress.scene = scene.name;
      this.progress.sceneFrame = 0;

      // audio log: scene marker at the exact video timestamp of its 1st frame
      this._captureFrame = frameN;
      this._alog({ type: 'scene', name: scene.name });

      try {
        if (scene.setup) scene.setup();
      } catch (err) {
        this._note(`setup error in scene '${scene.name}' (continuing): ${err.message}`);
      }

      const frames = Math.round(scene.duration * FPS);
      for (let i = 0; i < frames; i++) {
        if (this._abortFlag) break;
        const t = i / FPS;
        this._captureFrame = frameN;

        // 1) choreography drives inputs/aim/staging for this frame
        try {
          if (scene.tick) scene.tick(t, i);
        } catch (err) {
          if (!this._sysErrNoted.has('tick:' + scene.name)) {
            this._sysErrNoted.add('tick:' + scene.name);
            this._note(`tick error in scene '${scene.name}' (continuing): ${err.message}`);
          }
        }

        // 2) deterministic stepping: 2 x 1/60 s of game time
        for (let s = 0; s < STEPS_PER_FRAME; s++) this._stepOnce();

        // audio log: player defuse window transitions (defuse-start/-end,
        // derived from bomb.defuseProgress in the defuse scene)
        const ab = game.state.bomb;
        const defusingNow = !!(ab && ab.planted && ab.defusingBy === 'player' && ab.defuseProgress > 0);
        if (defusingNow !== this._defusingLogged) {
          this._defusingLogged = defusingNow;
          this._alog({ type: defusingNow ? 'defuse-start' : 'defuse-end' });
        }

        // 3) camera override AFTER updates (player writes the camera each
        //    update — flyovers overwrite it, normal scenes leave it alone)
        try {
          if (scene.camera) scene.camera(t + 1 / FPS);
        } catch (err) {
          if (!this._sysErrNoted.has('cam:' + scene.name)) {
            this._sysErrNoted.add('cam:' + scene.name);
            this._note(`camera error in scene '${scene.name}': ${err.message}`);
          }
        }

        // 4) render + composite + upload (sequential — order matters)
        game.renderer.render(game.scene, game.camera);
        this._composite(scene, t);
        const blob = await this._blob();
        await this._upload(frameN, blob);

        frameN++;
        this.progress.frame = frameN;
        this.progress.sceneFrame = i + 1;

        // keep the tab responsive in dry-run (no awaited fetch to yield on)
        if (this.progress.dryRun && i % 8 === 0) {
          await new Promise((r) => setTimeout(r, 0));
        }
      }
    }

    this.progress.scene = this._abortFlag ? 'aborted' : 'complete';
  }
}

// ---------------------------------------------------------------------------
// Entry point (called by src/main.js after boot when the URL has ?trailer)
// ---------------------------------------------------------------------------
const TRAILER_GLBS = [
  'ak47', 'awp', 'm4a1', 'smokegrenade', 'flashbang', 'hegrenade',
];

function trailerAssetsReady(game) {
  const characters = game.bots && game.bots._charAssets;
  const viewmodel = game.viewmodel;
  const models = viewmodel && viewmodel._models;
  return !!(
    characters && characters.ct && characters.t &&
    viewmodel._npcArmsSource && models &&
    TRAILER_GLBS.every((id) => models[id] && models[id].userData.weaponSource === 'glb')
  );
}

function mountTrailerCaptureControl(game, api) {
  const root = document.createElement('section');
  root.id = 'trailer-capture-control';
  root.style.cssText = [
    'position:fixed', 'z-index:100000', 'left:20px', 'bottom:20px',
    'width:340px', 'padding:14px', 'border:1px solid rgba(154,178,107,.7)',
    'background:rgba(4,7,4,.94)', 'color:#c8d6b9',
    'font:700 12px/1.5 Arial,sans-serif', 'letter-spacing:1px',
  ].join(';');

  const button = document.createElement('button');
  button.type = 'button';
  button.disabled = true;
  button.textContent = 'LOADING TRAILER ASSETS';
  button.style.cssText = [
    'width:100%', 'padding:11px', 'border:1px solid #9ab26b',
    'background:#27331a', 'color:#f2f5ea', 'font:inherit', 'cursor:pointer',
  ].join(';');

  const status = document.createElement('pre');
  status.setAttribute('aria-live', 'polite');
  status.style.cssText = 'margin:10px 0 0;white-space:pre-wrap;font:inherit;color:#9ab26b';
  status.textContent = 'Waiting for characters, hands, and weapon GLBs…';
  root.append(button, status);
  document.body.append(root);

  let running = false;
  const refresh = () => {
    if (running) {
      const p = api.progress;
      status.textContent = `CAPTURING ${p.frame}/${p.totalFrames}\n${String(p.scene || '').toUpperCase()}`;
      return;
    }
    if (!trailerAssetsReady(game)) return;
    button.disabled = false;
    button.textContent = 'RENDER TRAILER';
    status.textContent = 'ALL AUTHORED ASSETS READY';
    root.dataset.state = 'ready';
  };
  const refreshTimer = setInterval(refresh, 200);
  refresh();

  button.addEventListener('click', async () => {
    if (running || !trailerAssetsReady(game)) return;
    running = true;
    button.disabled = true;
    button.textContent = 'RENDERING…';
    root.dataset.state = 'capturing';
    try {
      const capture = await api.start();
      root.dataset.state = 'audio';
      status.textContent = 'RENDERING SOUNDTRACK…';
      const audio = await api.renderAudio();
      api.result = { capture, audio };
      root.dataset.state = 'done';
      button.textContent = 'TRAILER COMPLETE';
      status.textContent = [
        `FRAMES ${capture.uploaded}/${capture.totalFrames}`,
        `AUDIO ${audio.uploadOk ? 'UPLOADED' : 'FAILED'}`,
        capture.notes.length ? `NOTES ${capture.notes.join(' | ')}` : 'NO CAPTURE NOTES',
      ].join('\n');
    } catch (err) {
      api.result = { error: String((err && err.stack) || err) };
      root.dataset.state = 'error';
      button.textContent = 'TRAILER FAILED';
      status.textContent = api.result.error;
    } finally {
      running = false;
      clearInterval(refreshTimer);
    }
  });

  return root;
}

export default function initTrailer(game) {
  const director = new TrailerDirector(game);

  // Freeze the real-time loop immediately: even a starved rAF trickle would
  // advance the match between page load and start(), desyncing the scripted
  // round. From here on the game only moves when the recorder steps it.
  try {
    game.renderer.setAnimationLoop(null);
    game.renderer.render(game.scene, game.camera); // leave one frame visible
  } catch (_) { /* ignore */ }
  const api = {
    start: () => director.start(),
    abort: () => director.abort(),
    progress: director.progress,
    // soundtrack pipeline (tools/trailer-audio.js): event log captured during
    // start(); renderAudio([log]) synthesizes + uploads the WAV offline
    audioLog: director.audioLog,
    renderAudio: initAudioRenderer(game, director),
    // handy extras for debugging
    _director: director,
    ease: { easeInOutCubic, easeOutCubic, easeInCubic, smoothstep, lerp, clamp },
  };
  window.__trailer = api;
  api.control = mountTrailerCaptureControl(game, api);
  console.warn('[trailer] ready — call window.__trailer.start()');
  return api;
}
