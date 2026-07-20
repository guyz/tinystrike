/**
 * TINY STRIKE — Section J: Procedural audio (`AudioSys`).
 *
 * Every sound is synthesized with WebAudio — zero assets. The AudioContext is
 * created lazily on the first user gesture ('ui:start' / 'input:lock' / any
 * keydown / mousedown) to satisfy autoplay policy.
 *
 * Signal graph:
 *   sfx bus ─┐
 *            ├→ compressor → duck gain → muffle lowpass → master (0.5) → out
 *   music bus┘
 *
 * Each one-shot sound lives in a "group": a private output gain (plus optional
 * StereoPanner / air-absorption lowpass for 3D sounds) that every layer of the
 * sound feeds into. Every source counts pending refs on its group; when the
 * last source's `onended` fires, all nodes of the group are disconnected, so
 * nothing is ever left running. A soft voice cap sheds quiet, distant sounds
 * when heavy firefights would otherwise pile up hundreds of nodes; the master
 * DynamicsCompressor keeps the sum from clipping when ten guns go off at once.
 */
import * as THREE from 'three';

// --- module scratch (no allocation in per-frame / per-event code) -----------
const _vFwd = new THREE.Vector3();
const _vA = new THREE.Vector3();
const _vB = new THREE.Vector3();

// --- gunshot character per weapon id ----------------------------------------
// vol    : overall loudness scaler
// crack  : high transient snap amount (supersonic crack)
// bpFrom/bpTo/nDur : swept band-pass noise body (the "bang")
// thF/thVol/thDur  : resonant low thump layer
// lp     : optional lowpass over the body (suppressed USP)
// sub    : extra sub-sine layer (AWP)
// echo   : feedback-delay tail (AWP canyon boom)
// mech   : audible action/slide click near the muzzle
const GUN_PROFILES = {
  glock:  { vol: 0.60, crack: 0.42, bpFrom: 1750, bpTo: 430, nDur: 0.100, thF: 150, thVol: 0.72, thDur: 0.105 },
  usp:    { vol: 0.30, crack: 0.10, bpFrom: 950,  bpTo: 360, nDur: 0.080, thF: 128, thVol: 0.52, thDur: 0.090, lp: 1150, mech: true },
  deagle: { vol: 1.00, crack: 0.62, bpFrom: 1150, bpTo: 235, nDur: 0.175, thF: 103, thVol: 1.00, thDur: 0.210, mech: true },
  mp5:    { vol: 0.55, crack: 0.40, bpFrom: 1950, bpTo: 545, nDur: 0.068, thF: 158, thVol: 0.62, thDur: 0.080 },
  ak47:   { vol: 0.92, crack: 0.60, bpFrom: 1060, bpTo: 215, nDur: 0.150, thF: 115, thVol: 0.95, thDur: 0.165 },
  m4a1:   { vol: 0.82, crack: 0.55, bpFrom: 1350, bpTo: 300, nDur: 0.118, thF: 133, thVol: 0.85, thDur: 0.135 },
  awp:    { vol: 1.30, crack: 0.78, bpFrom: 720,  bpTo: 130, nDur: 0.300, thF: 84,  thVol: 1.15, thDur: 0.340, sub: 52, echo: true },
};

const FOOT_PROFILES = {
  concrete: { f: 760,  q: 1.1, dur: 0.070, vol: 1.00 },
  sand:     { f: 400,  q: 0.6, dur: 0.110, vol: 0.80 },
  wood:     { f: 520,  q: 1.5, dur: 0.080, vol: 1.00, knock: 175 },
  metal:    { f: 1400, q: 3.0, dur: 0.090, vol: 0.90, ring: 1750 },
};

const GRENADE_IDS = { hegrenade: 1, flashbang: 1, smokegrenade: 1 };

export default class AudioSys {
  constructor(game) {
    this.game = game;

    // WebAudio graph (all null until first user gesture)
    this.ctx = null;
    this.master = null;      // final gain (0.5)
    this.comp = null;        // gentle master DynamicsCompressor
    this.duck = null;        // duck gain (explosion / flash muffle)
    this.muffleLP = null;    // master lowpass swept down on nearby blasts
    this.sfx = null;         // SFX bus
    this.music = null;       // music / ambient / stinger bus

    this._noiseBuf = null;   // 1 s white noise
    this._brownBuf = null;   // 3 s brown noise (wind)
    this._wind = null;       // persistent ambient nodes

    // bookkeeping
    this._voices = 0;              // live sources (for shedding)
    this._nextBeep = 0;            // bomb beep scheduler (ctx time)
    this._nextDefTick = 0;         // defuse tick scheduler
    this._defTickAlt = false;
    this._reloadSrcs = [];         // cancellable scheduled reload foley
    this._lastFxExplAt = -100;     // dedupe fallback for bomb:detonated
    this._detPending = false;
    this._detAt = 0;
    this._detPos = { x: 0, y: 0, z: 0 };
    this._lastDeployCue = -100;   // suppresses a duplicate first-round cue

    this._bind();
  }

  // ==========================================================================
  // Wiring
  // ==========================================================================

  _bind() {
    const ev = this.game.events;
    const unlock = () => this._ensureCtx();

    // Lazy context creation on first gesture (autoplay policy). Window
    // listeners also catch synthetic test-mode events.
    ev.on('ui:start', unlock);
    ev.on('input:lock', unlock);
    ev.on('input:keydown', unlock);
    window.addEventListener('keydown', unlock);
    window.addEventListener('mousedown', unlock);

    // Combat / weapons
    ev.on('weapon:fire', (p) => this._onWeaponFire(p));
    ev.on('bot:fire', (p) => this._onBotFire(p));
    ev.on('weapon:dryfire', () => this._onDryFire());
    ev.on('weapon:reload:start', (p) => this._onReloadStart(p));
    ev.on('weapon:equip', (p) => this._onEquip(p));
    ev.on('weapon:scope', (p) => this._onScope(p));
    ev.on('grenade:throw', (p) => this._onThrow(p));

    // Movement foley
    ev.on('player:footstep', (p) => this._onPlayerStep(p));
    ev.on('bot:footstep', (p) => this._onBotStep(p));
    ev.on('player:land', (p) => this._onLand(p));

    // Damage / deaths
    ev.on('player:damage', (p) => this._onPlayerDamage(p));
    ev.on('player:death', () => this._onPlayerDeath());
    ev.on('bot:death', (p) => this._onBotDeath(p));
    ev.on('fx:blood', (p) => this._onBlood(p));
    ev.on('hud:hitmarker', (p) => this._onHitmarker(p));

    // World FX
    ev.on('fx:impact', (p) => this._onImpact(p));
    ev.on('fx:explosion', (p) => this._onExplosion(p));
    ev.on('fx:flash', (p) => this._onFlash(p));
    ev.on('fx:smoke', (p) => this._onSmoke(p));
    ev.on('bomb:detonated', (p) => this._onDetonated(p));

    // Match flow / UI
    ev.on('round:phase', (p) => this._onPhase(p));
    ev.on('round:end', (p) => this._onRoundEnd(p));
    ev.on('game:end', (p) => this._onGameEnd(p));
    ev.on('bomb:planted', (p) => this._onPlanted(p));
    ev.on('bomb:defused', () => this._onDefused());
    ev.on('bot:defusing', () => this._onBotDefusing());
    ev.on('econ:buy', () => this._onBuy());
    ev.on('ui:toggle-buy', () => this._uiClick(920, 0.10));
    ev.on('ui:start', () => this._onGameStart());
    ev.on('ui:restart', unlock);
    ev.on('ui:restart', () => this._onGameStart());
  }

  _ensureCtx() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this._buildGraph();
    }
    if (this.ctx.state === 'suspended') {
      const p = this.ctx.resume();
      if (p && p.catch) p.catch(() => {});
    }
  }

  _buildGraph() {
    const ctx = this.ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(ctx.destination);

    // Master lowpass: wide open normally; swept down briefly by close blasts.
    this.muffleLP = ctx.createBiquadFilter();
    this.muffleLP.type = 'lowpass';
    this.muffleLP.frequency.value = 19500;
    this.muffleLP.Q.value = 0.4;
    this.muffleLP.connect(this.master);

    this.duck = ctx.createGain();
    this.duck.gain.value = 1;
    this.duck.connect(this.muffleLP);

    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -16;
    this.comp.knee.value = 18;
    this.comp.ratio.value = 5;
    this.comp.attack.value = 0.003;
    this.comp.release.value = 0.22;
    this.comp.connect(this.duck);

    this.sfx = ctx.createGain();
    this.sfx.gain.value = 1;
    this.sfx.connect(this.comp);

    this.music = ctx.createGain();
    this.music.gain.value = 1;
    this.music.connect(this.comp);

    this._makeBuffers();
    this._startAmbient();
  }

  _makeBuffers() {
    const ctx = this.ctx;
    const sr = ctx.sampleRate;

    // 1 s white noise, reused by every noise-based layer (random start offset
    // decorrelates simultaneous shots).
    const wlen = Math.floor(sr);
    this._noiseBuf = ctx.createBuffer(1, wlen, sr);
    const w = this._noiseBuf.getChannelData(0);
    for (let i = 0; i < wlen; i++) w[i] = Math.random() * 2 - 1;

    // 3 s brown noise for the desert wind bed.
    const blen = Math.floor(sr * 3);
    this._brownBuf = ctx.createBuffer(1, blen, sr);
    const b = this._brownBuf.getChannelData(0);
    let acc = 0;
    for (let i = 0; i < blen; i++) {
      acc += ((Math.random() * 2 - 1) - acc) * 0.02;
      b[i] = acc * 8;
    }
  }

  _startAmbient() {
    const ctx = this.ctx;

    // Wind: brown noise → lowpass, two slow LFOs (gain gusts + filter color).
    const src = ctx.createBufferSource();
    src.buffer = this._brownBuf;
    src.loop = true;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 380;
    lp.Q.value = 0.5;

    const g = ctx.createGain();
    g.gain.value = 0.05;

    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.07;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 0.024;
    lfo.connect(lfoG);
    lfoG.connect(g.gain);

    const lfo2 = ctx.createOscillator();
    lfo2.type = 'sine';
    lfo2.frequency.value = 0.043;
    const lfo2G = ctx.createGain();
    lfo2G.gain.value = 95;
    lfo2.connect(lfo2G);
    lfo2G.connect(lp.frequency);

    src.connect(lp);
    lp.connect(g);
    g.connect(this.music);

    // Very low distant rumble bed under the wind.
    const rSrc = ctx.createBufferSource();
    rSrc.buffer = this._brownBuf;
    rSrc.loop = true;
    rSrc.playbackRate.value = 0.55;
    const rLp = ctx.createBiquadFilter();
    rLp.type = 'lowpass';
    rLp.frequency.value = 130;
    rLp.Q.value = 0.4;
    const rG = ctx.createGain();
    rG.gain.value = 0.022;
    rSrc.connect(rLp);
    rLp.connect(rG);
    rG.connect(this.music);

    src.start(0, Math.random() * 2);
    rSrc.start(0, Math.random() * 2);
    lfo.start(0);
    lfo2.start(0);

    // Persistent — intentionally never stopped (ambient bed for the whole
    // session); kept referenced so it is never GC'd mid-play.
    this._wind = { src, rSrc, lfo, lfo2, lp, g, lfoG, lfo2G, rLp, rG };
  }

  // ==========================================================================
  // Core plumbing helpers
  // ==========================================================================

  _ready() {
    return !!(this.ctx && this.ctx.state === 'running');
  }

  _t() {
    return this.ctx.currentTime + 0.003;
  }

  _rnd(a, b) {
    return a + Math.random() * (b - a);
  }

  _filter(type, f, q) {
    const flt = this.ctx.createBiquadFilter();
    flt.type = type;
    flt.frequency.value = f;
    flt.Q.value = q || 1;
    return flt;
  }

  /** A sound group: private output gain feeding `dest`; auto-cleans when the
   *  last registered source ends. */
  _grp(dest, vol) {
    const out = this.ctx.createGain();
    out.gain.value = vol;
    out.connect(dest);
    return { out, nodes: [out], srcs: [], pending: 0 };
  }

  /** Register a source (+ its private nodes) with a group for lifecycle. */
  _add(grp, src, ...nodes) {
    grp.pending++;
    this._voices++;
    grp.srcs.push(src);
    for (let i = 0; i < nodes.length; i++) grp.nodes.push(nodes[i]);
    const self = this;
    src.onended = function () {
      self._voices--;
      try { src.disconnect(); } catch (e) { /* already gone */ }
      if (--grp.pending <= 0) {
        const ns = grp.nodes;
        for (let i = 0; i < ns.length; i++) {
          try { ns[i].disconnect(); } catch (e) { /* already gone */ }
        }
        ns.length = 0;
        grp.srcs.length = 0;
      }
    };
  }

  /** Direct (non-positional) group into the SFX bus, or null when not ready /
   *  over the voice budget. */
  _direct(vol, bus) {
    if (!this._ready()) return null;
    if (this._voices > 72) return null;
    return this._grp(bus || this.sfx, vol);
  }

  _noiseSrc(rate) {
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuf;
    src.loop = true;
    src.playbackRate.value = rate || 1;
    return src;
  }

  /**
   * Public 3D one-shot helper (spec API).
   * `buildFn(grp, when, dist)` builds layers into `grp.out`.
   * Gain = vol × clamp(refDist / d, 0, 1) with a soft fade near maxDist; pan
   * from camera-relative azimuth via StereoPanner; distant sounds also get an
   * air-absorption lowpass.
   */
  play3D(buildFn, pos, opts) {
    if (!this._ready() || !pos) return null;
    const o = opts || {};
    const refDist = o.refDist !== undefined ? o.refDist : 8;
    const maxDist = o.maxDist !== undefined ? o.maxDist : 60;
    const vol = o.vol !== undefined ? o.vol : 1;

    const cam = this.game.camera;
    const cp = cam.position;
    const dx = pos.x - cp.x;
    const dy = pos.y - cp.y;
    const dz = pos.z - cp.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > maxDist) return null;

    let g = vol * Math.min(1, refDist / Math.max(d, 0.001));
    const edge = maxDist * 0.75;
    if (d > edge) g *= 1 - (d - edge) / (maxDist - edge);
    if (g <= 0.004) return null;

    // Voice shedding: drop quiet distant sounds during heavy firefights.
    if (!o.priority) {
      if (this._voices > 70) return null;
      if (this._voices > 48 && g < 0.12) return null;
    }

    // Stereo pan from camera-relative azimuth.
    cam.getWorldDirection(_vFwd);
    let pan = 0;
    const fl = Math.sqrt(_vFwd.x * _vFwd.x + _vFwd.z * _vFwd.z);
    const hl = Math.sqrt(dx * dx + dz * dz);
    if (fl > 0.001 && hl > 0.4) {
      const rx = -_vFwd.z / fl;
      const rz = _vFwd.x / fl;
      pan = ((dx * rx + dz * rz) / hl) * 0.8;
      if (pan < -1) pan = -1; else if (pan > 1) pan = 1;
    }

    const ctx = this.ctx;
    let dest = this.sfx;
    let panner = null;
    if (ctx.createStereoPanner) {
      panner = ctx.createStereoPanner();
      panner.pan.value = pan;
      panner.connect(dest);
      dest = panner;
    }
    let air = null;
    if (d > refDist * 1.7) {
      air = this._filter('lowpass', Math.max(1100, 16000 * Math.min(1, (refDist * 2.4) / d)), 0.5);
      air.connect(dest);
      dest = air;
    }

    const grp = this._grp(dest, g);
    if (panner) grp.nodes.push(panner);
    if (air) grp.nodes.push(air);
    buildFn(grp, this._t(), d);
    return grp;
  }

  // ==========================================================================
  // Synth building blocks
  // ==========================================================================

  /**
   * Oscillator layer.
   * o: { f, type, vol, a (attack), dur (exp decay), end (freq slide target),
   *      slideDur, tau (setTarget decay instead of dur), hold, lp (lowpass) }
   */
  _tone(grp, t, o, dest) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(Math.max(1, o.f), t);
    if (o.end) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.end), t + (o.slideDur || o.dur || 0.1));
    }

    const g = ctx.createGain();
    const a = o.a !== undefined ? o.a : 0.004;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(o.vol, t + a);
    let stopAt;
    if (o.tau) {
      const hold = o.hold !== undefined ? o.hold : 0.02;
      g.gain.setTargetAtTime(0.0001, t + a + hold, o.tau);
      stopAt = t + a + hold + o.tau * 6;
    } else {
      const dur = o.dur || 0.15;
      g.gain.exponentialRampToValueAtTime(0.0008, t + a + dur);
      g.gain.linearRampToValueAtTime(0, t + a + dur + 0.012);
      stopAt = t + a + dur + 0.03;
    }

    let node = osc;
    if (o.lp) {
      const lp = this._filter('lowpass', o.lp, o.lpQ || 0.7);
      node.connect(lp);
      node = lp;
      grp.nodes.push(lp);
    }
    node.connect(g);
    g.connect(dest || grp.out);
    osc.start(t);
    osc.stop(stopAt);
    this._add(grp, osc, g);
  }

  /**
   * Filtered-noise layer.
   * o: { type ('bandpass'|'lowpass'|'highpass'), f, fEnd, slideDur, q, dur,
   *      vol, a, rate, lp (extra series lowpass) }
   */
  _noiseHit(grp, t, o, dest) {
    const ctx = this.ctx;
    const src = this._noiseSrc(o.rate || 1);
    const flt = ctx.createBiquadFilter();
    flt.type = o.type || 'bandpass';
    flt.frequency.setValueAtTime(o.f, t);
    if (o.fEnd) {
      flt.frequency.exponentialRampToValueAtTime(Math.max(20, o.fEnd), t + (o.slideDur || o.dur));
    }
    flt.Q.value = o.q || 1;

    const g = ctx.createGain();
    const a = o.a !== undefined ? o.a : 0.003;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(o.vol, t + a);
    g.gain.exponentialRampToValueAtTime(0.0008, t + a + o.dur);
    g.gain.linearRampToValueAtTime(0, t + a + o.dur + 0.012);

    src.connect(flt);
    let node = flt;
    if (o.lp) {
      const lp = this._filter('lowpass', o.lp, 0.7);
      node.connect(lp);
      node = lp;
      grp.nodes.push(lp);
    }
    node.connect(g);
    g.connect(dest || grp.out);
    src.start(t, this._rnd(0, 0.7));
    src.stop(t + a + o.dur + 0.03);
    this._add(grp, src, flt, g);
  }

  /** Short mechanical transient (clicks, clacks, ticks). */
  _mech(grp, t, f, vol, dest) {
    this._noiseHit(grp, t, { type: 'bandpass', f: f * this._rnd(0.92, 1.08), q: 2.2, dur: 0.028, vol: vol, a: 0.001 }, dest);
    this._tone(grp, t, { f: f * 0.55, type: 'square', vol: vol * 0.35, a: 0.001, dur: 0.018, lp: f * 1.4 }, dest);
  }

  /** Feedback-delay echo tail fed from `tap` (AWP boom). A silent looping
   *  anchor source keeps the group alive until the tail dies, then everything
   *  is disconnected together. */
  _echoTail(grp, t, tap, delayTime, fb, dur) {
    const ctx = this.ctx;
    const delay = ctx.createDelay(0.6);
    delay.delayTime.value = delayTime;
    const fbG = ctx.createGain();
    fbG.gain.value = fb;
    const wet = ctx.createGain();
    wet.gain.setValueAtTime(0.55, t);
    wet.gain.setValueAtTime(0.55, t + dur * 0.55);
    wet.gain.linearRampToValueAtTime(0, t + dur);
    fbG.gain.setValueAtTime(fb, t + dur * 0.5);
    fbG.gain.linearRampToValueAtTime(0, t + dur * 0.9);

    tap.connect(delay);
    delay.connect(fbG);
    fbG.connect(delay);
    delay.connect(wet);
    wet.connect(grp.out);

    // Silent anchor (universal 'ended' timer — no ConstantSource dependency).
    const anchor = this._noiseSrc(1);
    const z = ctx.createGain();
    z.gain.value = 0;
    anchor.connect(z);
    z.connect(grp.out);
    anchor.start(t);
    anchor.stop(t + dur + 0.05);
    this._add(grp, anchor, z, delay, fbG, wet);
  }

  /** Duck the whole mix (explosions / flashbangs), recover smoothly. */
  _duckMaster(level, recover) {
    if (!this._ready()) return;
    const t = this.ctx.currentTime;
    const g = this.duck.gain;
    try { g.cancelScheduledValues(t); } catch (e) { /* noop */ }
    const lvl = Math.max(0.12, Math.min(level, 1));
    g.setValueAtTime(Math.min(g.value, lvl), t);
    g.setTargetAtTime(1, t + 0.08, (recover || 2) / 4);
  }

  /** Sweep the master lowpass down briefly (concussion muffle). */
  _muffle(freq, recover) {
    if (!this._ready()) return;
    const t = this.ctx.currentTime;
    const f = this.muffleLP.frequency;
    try { f.cancelScheduledValues(t); } catch (e) { /* noop */ }
    f.setValueAtTime(Math.min(f.value, Math.max(500, freq)), t);
    f.setTargetAtTime(19500, t + 0.1, (recover || 2) / 4);
  }

  // ==========================================================================
  // Sound designs
  // ==========================================================================

  /** Layered gunshot; `dist` (m from listener) culls detail layers far away. */
  _gunshot(grp, t, p, dist) {
    const ctx = this.ctx;
    const far = dist > 34;

    // All layers feed a mix node so the echo tail can tap the full shot.
    const mix = ctx.createGain();
    mix.gain.value = 1;
    mix.connect(grp.out);
    grp.nodes.push(mix);

    // Body: swept band-pass noise burst — the "bang".
    this._noiseHit(grp, t, {
      type: 'bandpass', f: p.bpFrom, fEnd: p.bpTo, slideDur: p.nDur, q: 0.85,
      dur: p.nDur * 1.6, vol: 1.0, a: 0.003, rate: this._rnd(0.92, 1.08), lp: p.lp,
    }, mix);

    // Crack: tiny high transient (near shots only).
    if (!far && p.crack) {
      this._noiseHit(grp, t, { type: 'highpass', f: 3200, q: 0.7, dur: 0.022, vol: p.crack, a: 0.001 }, mix);
    }

    // Thump: resonant decaying low sine.
    this._tone(grp, t, {
      f: p.thF * this._rnd(0.95, 1.05), end: p.thF * 0.52, slideDur: p.thDur,
      dur: p.thDur * 1.35, vol: p.thVol, a: 0.004, type: 'sine',
    }, mix);

    // Sub layer (AWP body shake).
    if (p.sub && dist < 50) {
      this._tone(grp, t, { f: p.sub, end: p.sub * 0.6, slideDur: 0.4, dur: 0.42, vol: 0.8, a: 0.006 }, mix);
    }

    // Action noise near the muzzle (deagle slide, USP suppressor click).
    if (p.mech && dist < 12) this._mech(grp, t + 0.045, 1500, 0.12, mix);

    // AWP canyon echo tail.
    if (p.echo && dist < 70) this._echoTail(grp, t, mix, 0.18, 0.38, 1.35);
  }

  _swish(grp, t) {
    this._noiseHit(grp, t, { type: 'bandpass', f: 350, fEnd: 2600, slideDur: 0.12, q: 1.4, dur: 0.14, vol: 0.9, a: 0.02, rate: this._rnd(0.9, 1.1) });
    this._tone(grp, t + 0.02, { f: 4200, vol: 0.08, a: 0.005, dur: 0.07 });
  }

  _footstep(grp, t, surface) {
    const p = FOOT_PROFILES[surface] || FOOT_PROFILES.concrete;
    this._noiseHit(grp, t, {
      type: 'bandpass', f: p.f * this._rnd(0.88, 1.14), q: p.q,
      dur: p.dur, vol: p.vol, a: 0.004, rate: this._rnd(0.9, 1.15),
    });
    if (p.knock) this._tone(grp, t, { f: p.knock * this._rnd(0.92, 1.08), vol: 0.35, a: 0.003, dur: 0.05, end: p.knock * 0.7 });
    if (p.ring) this._tone(grp, t, { f: p.ring * this._rnd(0.95, 1.06), type: 'triangle', vol: 0.10, a: 0.002, dur: 0.14 });
  }

  _impactSound(grp, t, surface) {
    if (surface === 'metal') {
      const f = this._rnd(2100, 2750);
      this._tone(grp, t, { f, type: 'triangle', vol: 0.55, a: 0.001, hold: 0.01, tau: 0.06, end: f * 0.92, slideDur: 0.2 });
      this._tone(grp, t, { f: f * 1.83, type: 'sine', vol: 0.2, a: 0.001, dur: 0.09 });
      this._noiseHit(grp, t, { type: 'highpass', f: 4000, dur: 0.018, vol: 0.35, a: 0.001 });
    } else if (surface === 'wood') {
      this._noiseHit(grp, t, { type: 'bandpass', f: this._rnd(420, 560), q: 1.2, dur: 0.055, vol: 0.7, a: 0.002, rate: 0.85 });
      this._tone(grp, t, { f: 190, vol: 0.4, a: 0.002, dur: 0.06, end: 120 });
    } else if (surface === 'sand') {
      this._noiseHit(grp, t, { type: 'lowpass', f: 600, dur: 0.08, vol: 0.6, a: 0.006, rate: 0.8 });
    } else {
      // concrete
      this._noiseHit(grp, t, { type: 'highpass', f: 2400, dur: 0.04, vol: 0.6, a: 0.001 });
      this._noiseHit(grp, t, { type: 'bandpass', f: this._rnd(800, 1100), q: 1.0, dur: 0.03, vol: 0.35, a: 0.001 });
      if (Math.random() < 0.16) {
        // occasional ricochet zing
        this._tone(grp, t + 0.01, { f: this._rnd(1900, 2500), end: this._rnd(600, 900), slideDur: 0.3, vol: 0.12, a: 0.004, dur: 0.32 });
      }
    }
  }

  _explosionSound(grp, t, dist, big) {
    // Sharp transient crack (near only).
    if (dist < 45) this._noiseHit(grp, t, { type: 'highpass', f: 2800, dur: 0.045, vol: 0.9, a: 0.001 });
    // Main boom: lowpass noise swept down.
    this._noiseHit(grp, t, {
      type: 'lowpass', f: 1000, fEnd: 90, slideDur: 0.9,
      dur: big ? 1.5 : 1.1, vol: 1.25, a: 0.002, rate: 0.9,
    });
    // 50 Hz sub swell.
    this._tone(grp, t, { f: 55, end: 30, slideDur: 1.2, dur: big ? 1.5 : 1.15, vol: 1.1, a: 0.005 });
    // Rumble tail.
    this._noiseHit(grp, t + 0.15, { type: 'lowpass', f: 220, dur: big ? 2.2 : 1.6, vol: 0.5, a: 0.12, rate: 0.7 });
    // Debris crackle after the blast (near only).
    if (dist < 30) {
      for (let i = 0; i < 4; i++) {
        const dt2 = this._rnd(0.25, 0.95);
        this._noiseHit(grp, t + dt2, { type: 'bandpass', f: this._rnd(900, 2200), q: 2.0, dur: 0.03, vol: 0.12, a: 0.002 });
      }
    }
  }

  _beepSound(grp, t, f) {
    this._tone(grp, t, { f, type: 'sine', vol: 0.6, a: 0.002, dur: 0.055 });
    this._tone(grp, t, { f: f * 2.01, type: 'sine', vol: 0.12, a: 0.002, dur: 0.035 });
  }

  _blip(grp, t, f, o) {
    const oo = o || {};
    this._tone(grp, t, {
      f, type: oo.type || 'triangle', vol: oo.vol !== undefined ? oo.vol : 0.22,
      a: oo.a !== undefined ? oo.a : 0.008, dur: oo.dur || 0.16,
      tau: oo.tau, hold: oo.hold, lp: oo.lp,
    });
    if (oo.chiff) {
      this._noiseHit(grp, t, { type: 'bandpass', f: 1900, q: 1.6, dur: 0.03, vol: oo.chiff, a: 0.001 });
    }
  }

  /** Dry, tactile confirmation of a bullet connecting.  A short filtered
   *  noise crack carries the cue; the low resonant layer merely gives it
   *  weight and is intentionally far below the range of an arcade bleep. */
  _impactConfirm(grp, t, headshot) {
    this._noiseHit(grp, t, {
      type: 'bandpass', f: 1850, fEnd: 610, slideDur: 0.045,
      q: 0.72, dur: 0.058, vol: 0.56, a: 0.001, rate: 0.82,
    });
    this._noiseHit(grp, t + 0.003, {
      type: 'lowpass', f: 510, fEnd: 185, slideDur: 0.07,
      q: 0.62, dur: 0.075, vol: 0.34, a: 0.002, rate: 0.68,
    });
    this._tone(grp, t + 0.002, {
      f: 118, end: 61, slideDur: 0.065, dur: 0.075,
      vol: 0.22, a: 0.002,
    });

    if (headshot) {
      // Helmet/skull snap: two narrow, rapidly falling noise resonances.  No
      // clean pitched oscillator, so it reads as material impact rather than
      // the old two-note headshot chime.
      this._noiseHit(grp, t, {
        type: 'highpass', f: 3300, fEnd: 1450, slideDur: 0.045,
        q: 0.7, dur: 0.055, vol: 0.34, a: 0.001,
      });
      this._noiseHit(grp, t + 0.018, {
        type: 'bandpass', f: 2850, fEnd: 760, slideDur: 0.11,
        q: 3.8, dur: 0.13, vol: 0.17, a: 0.001, rate: 0.94,
      });
    }
  }

  /** Player elimination confirmation: a compact low stamp plus a dusty tail.
   *  It deliberately avoids the former ascending two-note reward melody. */
  _eliminationConfirm(grp, t, headshot) {
    this._noiseHit(grp, t, {
      type: 'bandpass', f: headshot ? 1250 : 980, fEnd: 165,
      slideDur: 0.18, q: 0.62, dur: 0.21, vol: 0.66,
      a: 0.002, rate: 0.64,
    });
    this._noiseHit(grp, t + 0.014, {
      type: 'highpass', f: 4100, fEnd: 1800, slideDur: 0.055,
      q: 0.55, dur: 0.065, vol: 0.16, a: 0.001,
    });
    this._noiseHit(grp, t + 0.085, {
      type: 'lowpass', f: 340, fEnd: 115, slideDur: 0.15,
      q: 0.55, dur: 0.18, vol: 0.33, a: 0.012, rate: 0.6,
    });
    this._tone(grp, t, {
      f: 94, end: 39, slideDur: 0.20, dur: 0.22,
      vol: 0.46, a: 0.003,
    });
  }

  /** Tactical match/round deployment cue.  `full` adds the air-rush and bass
   *  impact used when entering a match; subsequent freeze phases use just the
   *  compact gear-and-action preparation. */
  _deploymentSound(grp, t, full) {
    if (full) {
      this._noiseHit(grp, t, {
        type: 'bandpass', f: 175, fEnd: 2250, slideDur: 0.36,
        q: 0.65, dur: 0.42, vol: 0.34, a: 0.055, rate: 0.7,
      });
      this._noiseHit(grp, t + 0.28, {
        type: 'lowpass', f: 920, fEnd: 105, slideDur: 0.33,
        q: 0.6, dur: 0.38, vol: 0.82, a: 0.002, rate: 0.76,
      });
      this._noiseHit(grp, t + 0.28, {
        type: 'highpass', f: 3100, fEnd: 1600, slideDur: 0.03,
        q: 0.55, dur: 0.035, vol: 0.25, a: 0.001,
      });
      this._tone(grp, t + 0.28, {
        f: 76, end: 36, slideDur: 0.36, dur: 0.42,
        vol: 0.62, a: 0.004,
      });
      this._mech(grp, t + 0.08, 720, 0.25);
      this._mech(grp, t + 0.18, 1420, 0.21);
      return;
    }

    this._noiseHit(grp, t, {
      type: 'bandpass', f: 560, fEnd: 205, slideDur: 0.17,
      q: 0.65, dur: 0.20, vol: 0.38, a: 0.012, rate: 0.65,
    });
    this._tone(grp, t, {
      f: 66, end: 42, slideDur: 0.18, dur: 0.21,
      vol: 0.28, a: 0.005,
    });
    this._mech(grp, t + 0.045, 680, 0.24);
    this._mech(grp, t + 0.13, 1210, 0.20);
  }

  // ==========================================================================
  // Event handlers
  // ==========================================================================

  _onWeaponFire(p) {
    if (!this._ready() || !p) return;
    const id = p.weaponId;
    if (p.melee || id === 'knife') {
      const grp = this._direct(0.30);
      if (grp) this._swish(grp, this._t());
      return;
    }
    if (GRENADE_IDS[id]) return; // throws are voiced via 'grenade:throw'

    const prof = GUN_PROFILES[id] || GUN_PROFILES.m4a1;
    // Defensive: 'weapon:fire' is player-emitted per spec, but if a payload
    // ever arrives flagged non-player with a world origin, voice it in 3D.
    if (p.byPlayer === false && p.origin) {
      this.play3D((g, t, d) => this._gunshot(g, t, prof, d), p.origin, {
        refDist: 11, maxDist: 95, vol: prof.vol * 0.55,
      });
      return;
    }
    const grp = this._direct(prof.vol * 0.5);
    if (!grp) return;
    const t = this._t();
    this._gunshot(grp, t, prof, 0);
    if (id === 'awp') {
      // bolt cycle
      this._mech(grp, t + 0.55, 850, 0.30);
      this._mech(grp, t + 0.74, 1250, 0.24);
    }
  }

  _onBotFire(p) {
    if (!this._ready() || !p || !p.origin) return;
    const id = p.weaponId;
    if (id === 'knife') {
      this.play3D((g, t) => this._swish(g, t), p.origin, { refDist: 4, maxDist: 18, vol: 0.6 });
      return;
    }
    const prof = GUN_PROFILES[id] || GUN_PROFILES.ak47;
    this.play3D((g, t, d) => this._gunshot(g, t, prof, d), p.origin, {
      refDist: 11, maxDist: 95, vol: prof.vol * 0.55,
    });
  }

  _onDryFire() {
    const grp = this._direct(0.22);
    if (!grp) return;
    const t = this._t();
    this._mech(grp, t, 1900, 0.6);
    this._tone(grp, t + 0.02, { f: 1150, type: 'square', vol: 0.1, a: 0.001, dur: 0.02, lp: 2400 });
  }

  _onReloadStart(p) {
    this._cancelReload();
    const grp = this._direct(0.4);
    if (!grp) return;
    const id = p && p.id;
    const dur = (p && p.duration) || 2.4;
    const heavy = id === 'awp' ? 0.62 : (id === 'ak47' || id === 'm4a1') ? 0.8 : id === 'mp5' ? 0.95 : 1.12;
    const t = this._t();

    // mag release click
    this._mech(grp, t + dur * 0.12, 1500 * heavy, 0.5);
    // mag slides out
    this._noiseHit(grp, t + dur * 0.34, { type: 'bandpass', f: 900 * heavy, fEnd: 420 * heavy, slideDur: 0.1, q: 1.2, dur: 0.11, vol: 0.35, a: 0.01 });
    // mag in — heavier thunk
    this._mech(grp, t + dur * 0.62, 800 * heavy, 0.6);
    this._tone(grp, t + dur * 0.62, { f: 210 * heavy, vol: 0.35, a: 0.003, dur: 0.07, end: 130 * heavy });
    // slide / bolt: two crisp ticks
    this._mech(grp, t + dur * 0.86, 1250 * heavy, 0.55);
    this._mech(grp, t + dur * 0.86 + 0.07, 1650 * heavy, 0.45);

    // Remember sources so a weapon switch can cancel the tail of the foley.
    for (let i = 0; i < grp.srcs.length; i++) this._reloadSrcs.push(grp.srcs[i]);
  }

  _cancelReload() {
    if (this.ctx && this._reloadSrcs.length) {
      const now = this.ctx.currentTime;
      for (let i = 0; i < this._reloadSrcs.length; i++) {
        try { this._reloadSrcs[i].stop(now); } catch (e) { /* already stopped */ }
      }
    }
    this._reloadSrcs.length = 0;
  }

  _onEquip() {
    this._cancelReload();
    const grp = this._direct(0.3);
    if (!grp) return;
    const t = this._t();
    this._mech(grp, t, 900, 0.5);
    this._mech(grp, t + 0.07, 1400, 0.4);
    this._noiseHit(grp, t, { type: 'bandpass', f: 600, q: 0.8, dur: 0.06, vol: 0.18, a: 0.01 });
  }

  _onScope(p) {
    const grp = this._direct(0.18);
    if (!grp) return;
    const lvl = (p && p.level) || 0;
    this._mech(grp, this._t(), 800 + lvl * 350, 0.7);
  }

  _onThrow() {
    const grp = this._direct(0.24);
    if (!grp) return;
    this._noiseHit(grp, this._t(), { type: 'bandpass', f: 260, fEnd: 1100, slideDur: 0.2, q: 1.1, dur: 0.22, vol: 0.9, a: 0.05 });
  }

  _onPlayerStep(p) {
    const walking = p && p.walking;
    const grp = this._direct(walking ? 0.07 : 0.14);
    if (!grp) return;
    this._footstep(grp, this._t(), (p && p.surface) || 'concrete');
  }

  _onBotStep(p) {
    if (!this._ready() || !p || !p.pos) return;
    this.play3D((g, t) => this._footstep(g, t, 'concrete'), p.pos, { refDist: 6, maxDist: 30, vol: 0.55 });
  }

  _onLand(p) {
    const speed = (p && p.speed) || 3;
    const v = Math.min(0.5, 0.12 + (speed - 3) * 0.045);
    const grp = this._direct(v);
    if (!grp) return;
    const t = this._t();
    this._noiseHit(grp, t, { type: 'lowpass', f: 500, dur: 0.1, vol: 0.9, a: 0.004, rate: 0.85 });
    this._tone(grp, t, { f: 95, vol: 0.6, a: 0.004, dur: 0.1, end: 55 });
  }

  _onPlayerDamage(p) {
    const amount = (p && p.amount) || 10;
    const grp = this._direct(Math.min(0.42, 0.12 + amount / 90));
    if (!grp) return;
    const t = this._t();
    this._tone(grp, t, { f: 140, end: 62, slideDur: 0.1, vol: 0.8, a: 0.003, dur: 0.12 });
    this._noiseHit(grp, t, { type: 'lowpass', f: 700, dur: 0.06, vol: 0.4, a: 0.002 });
  }

  _onPlayerDeath() {
    const grp = this._direct(0.58);
    if (!grp) return;
    const t = this._t();

    // Immediate ballistic shock: a dry transient, a chest-weight thump and
    // the low pressure drop one hears as the camera falls.  The old cue was a
    // sequence of clean oscillator pulses, which read as UI beeps instead of
    // a physical death.
    this._noiseHit(grp, t, {
      type: 'highpass', f: 2700, fEnd: 1200, slideDur: 0.035,
      q: 0.55, dur: 0.045, vol: 0.42, a: 0.001,
    });
    this._noiseHit(grp, t, {
      type: 'lowpass', f: 920, fEnd: 145, slideDur: 0.34,
      q: 0.65, dur: 0.40, vol: 0.85, a: 0.003, rate: 0.72,
    });
    this._tone(grp, t, {
      f: 86, end: 33, slideDur: 0.34, dur: 0.40,
      vol: 0.62, a: 0.004,
    });

    // Cloth/body fall, an unvoiced exhale and two small gear clatters.  All
    // are noise/mechanical layers, so the tail stays organic and non-melodic.
    this._noiseHit(grp, t + 0.16, {
      type: 'lowpass', f: 540, fEnd: 125, slideDur: 0.46,
      q: 0.6, dur: 0.54, vol: 0.62, a: 0.025, rate: 0.62,
    });
    this._noiseHit(grp, t + 0.24, {
      type: 'bandpass', f: 1050, fEnd: 250, slideDur: 0.82,
      q: 0.72, dur: 0.92, vol: 0.22, a: 0.08, rate: 0.54,
    });
    this._mech(grp, t + 0.27, 1280, 0.15);
    this._mech(grp, t + 0.43, 760, 0.12);

    this._duckMaster(0.44, 3.0);
    this._muffle(760, 3.2);
  }

  _onBotDeath(p) {
    if (!this._ready() || !p || !p.bot || !p.bot.pos) return;
    this.play3D((g, t) => {
      // body fall: cloth rustle + floor thud
      this._noiseHit(g, t + 0.12, { type: 'lowpass', f: 350, dur: 0.16, vol: 0.8, a: 0.01, rate: 0.7 });
      this._tone(g, t + 0.14, { f: 72, vol: 0.5, a: 0.005, dur: 0.12, end: 45 });
      this._noiseHit(g, t, { type: 'bandpass', f: 1200, q: 0.9, dur: 0.08, vol: 0.18, a: 0.008 });
    }, p.bot.pos, { refDist: 7, maxDist: 34, vol: 0.6 });
  }

  _onBlood(p) {
    if (!this._ready() || !p || !p.point) return;
    this.play3D((g, t) => {
      this._tone(g, t, { f: 220, end: 80, slideDur: 0.08, vol: 0.55, a: 0.002, dur: 0.09 });
      this._noiseHit(g, t, { type: 'lowpass', f: 900, dur: 0.055, vol: 0.45, a: 0.002, rate: 0.8 });
    }, p.point, { refDist: 7, maxDist: 40, vol: 0.55 });
  }

  _onHitmarker(p) {
    const killed = !!(p && p.kill);
    const grp = this._direct(killed ? 0.36 : 0.28);
    if (!grp) return;
    const t = this._t();
    this._impactConfirm(grp, t, !!(p && p.headshot));
    if (killed) this._eliminationConfirm(grp, t + 0.035, !!p.headshot);
  }

  _onImpact(p) {
    if (!this._ready() || !p || !p.point) return;
    const surface = p.surface || 'concrete';
    this.play3D((g, t) => this._impactSound(g, t, surface), p.point, { refDist: 6, maxDist: 45, vol: 0.55 });
  }

  _onExplosion(p) {
    if (!this._ready() || !p || !p.pos) return;
    this._lastFxExplAt = this.ctx.currentTime;
    const radius = p.radius || 9;
    this._playExplosionAt(p.pos, radius >= 12);
  }

  _playExplosionAt(pos, big) {
    const cp = this.game.camera.position;
    const dx = pos.x - cp.x;
    const dy = pos.y - cp.y;
    const dz = pos.z - cp.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    this.play3D((g, t, dd) => this._explosionSound(g, t, dd, big), pos, {
      refDist: 24, maxDist: 170, vol: big ? 1.5 : 1.1, priority: true,
    });
    // Master duck + concussion muffle scaled by proximity.
    this._duckMaster(Math.min(0.8, 0.22 + d / 70), 2);
    if (d < 26) this._muffle(900 + d * 60, 2);
  }

  _onDetonated(p) {
    // Combat normally emits the matching 'fx:explosion'; keep a fallback so
    // the bomb is never silent, without double-playing.
    if (!this._ready() || !p || !p.pos) return;
    this._detPending = true;
    this._detAt = this.ctx.currentTime;
    this._detPos.x = p.pos.x;
    this._detPos.y = p.pos.y;
    this._detPos.z = p.pos.z;
  }

  _onFlash(p) {
    if (!this._ready() || !p || !p.pos) return;
    const pos = p.pos;

    // The bang itself, positional.
    this.play3D((g, t) => {
      this._noiseHit(g, t, { type: 'highpass', f: 2500, dur: 0.07, vol: 1.0, a: 0.001 });
      this._noiseHit(g, t, { type: 'bandpass', f: 1500, q: 0.8, dur: 0.15, vol: 0.7, a: 0.002 });
      this._tone(g, t, { f: 3400, vol: 0.3, a: 0.001, dur: 0.1 });
      this._tone(g, t, { f: 160, end: 70, slideDur: 0.12, vol: 0.5, a: 0.003, dur: 0.14 });
    }, pos, { refDist: 16, maxDist: 90, vol: 1.2, priority: true });

    // Tinnitus ring for the player, scaled by distance and rough LOS.
    const cp = this.game.camera.position;
    const dx = pos.x - cp.x;
    const dy = pos.y - cp.y;
    const dz = pos.z - cp.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    let blocked = false;
    const w = this.game.world;
    if (w && typeof w.raycast === 'function' && d > 0.5) {
      _vB.set(dx / d, dy / d, dz / d);
      const hit = w.raycast(_vA.copy(cp), _vB, Math.max(0.1, d - 0.4));
      if (hit) blocked = true;
    }
    const ring = Math.max(0, 1 - d / 24) * (blocked ? 0.35 : 1);
    if (ring > 0.04) {
      const grp = this._direct(ring * 0.5);
      if (grp) {
        const t = this._t();
        this._tone(grp, t, { f: 2954, vol: 0.5, a: 0.004, hold: 0.5, tau: 1.0 });
        this._tone(grp, t, { f: 3021, vol: 0.3, a: 0.004, hold: 0.4, tau: 0.85 });
        this._noiseHit(grp, t, { type: 'highpass', f: 6000, dur: 2.2, vol: 0.05, a: 0.02 });
      }
      this._duckMaster(Math.min(0.75, 0.2 + d / 30), 2.5);
      this._muffle(1400 + d * 120, 2.2);
    }
  }

  _onSmoke(p) {
    if (!this._ready() || !p || !p.pos) return;
    this.play3D((g, t) => {
      // pop
      this._tone(g, t, { f: 240, end: 70, slideDur: 0.1, vol: 0.7, a: 0.003, dur: 0.12 });
      this._noiseHit(g, t, { type: 'bandpass', f: 700, q: 0.9, dur: 0.06, vol: 0.5, a: 0.002 });
      // long hiss as it billows
      this._noiseHit(g, t + 0.06, { type: 'lowpass', f: 2800, fEnd: 900, slideDur: 2.0, dur: 2.3, vol: 0.4, a: 0.15 });
    }, p.pos, { refDist: 9, maxDist: 50, vol: 0.6 });
  }

  // --- match flow / UI ------------------------------------------------------

  _onGameStart() {
    const play = () => {
      if (!this._ready()) return;
      const grp = this._direct(0.52, this.music);
      if (!grp) return;
      this._lastDeployCue = this.ctx.currentTime;
      this._deploymentSound(grp, this._t() + 0.025, true);
    };

    // Context creation and resume are normally synchronous enough inside the
    // click gesture.  Safari can leave it suspended until the resume promise
    // settles; retain the start cue instead of silently dropping it there.
    if (!this._ready() && this.ctx && this.ctx.state === 'suspended') {
      const ctx = this.ctx;
      const resumed = ctx.resume();
      if (resumed && resumed.then) {
        resumed.then(() => {
          if (this.ctx === ctx) play();
        }).catch(() => {});
      }
      return;
    }
    play();
  }

  _onPhase(p) {
    if (!this._ready() || !p) return;
    if (p.phase !== 'freeze' && p.phase !== 'live' && p.phase !== 'planted') return;

    // ui:start is immediately followed by the first freeze event.  The full
    // match-deployment cue already covers that transition, so do not pile a
    // second preparation sound on top of it.
    if (p.phase === 'freeze' && this.ctx.currentTime - this._lastDeployCue < 0.85) return;

    const grp = this._direct(p.phase === 'planted' ? 0.5 : 0.44, this.music);
    if (!grp) return;
    const t = this._t() + 0.05;

    if (p.phase === 'freeze') {
      // New round: vest/cloth movement followed by a compact weapon action.
      this._deploymentSound(grp, t, false);
    } else if (p.phase === 'live') {
      // Radio squelch + air push + low physical stamp.  This replaces the
      // former rising two-note "round live" beep.
      this._noiseHit(grp, t, {
        type: 'highpass', f: 2600, fEnd: 1150, slideDur: 0.055,
        q: 0.75, dur: 0.07, vol: 0.26, a: 0.001,
      });
      this._noiseHit(grp, t + 0.018, {
        type: 'bandpass', f: 240, fEnd: 1450, slideDur: 0.22,
        q: 0.7, dur: 0.25, vol: 0.32, a: 0.025, rate: 0.72,
      });
      this._noiseHit(grp, t + 0.13, {
        type: 'lowpass', f: 650, fEnd: 120, slideDur: 0.18,
        q: 0.55, dur: 0.22, vol: 0.48, a: 0.002, rate: 0.7,
      });
      this._tone(grp, t + 0.13, {
        f: 82, end: 44, slideDur: 0.19, dur: 0.22,
        vol: 0.36, a: 0.003,
      });
      this._mech(grp, t + 0.075, 980, 0.13);
    } else if (p.phase === 'planted') {
      // tense dissonant sting
      this._tone(grp, t, { f: 92.5, vol: 0.24, a: 0.02, hold: 0.6, tau: 0.45 });
      this._tone(grp, t, { f: 98, vol: 0.2, a: 0.02, hold: 0.6, tau: 0.45 });
      this._tone(grp, t, { f: 370, vol: 0.07, a: 0.15, hold: 0.3, tau: 0.4, type: 'triangle' });
      this._noiseHit(grp, t, { type: 'bandpass', f: 300, fEnd: 900, slideDur: 1.2, q: 1.5, dur: 1.3, vol: 0.10, a: 0.4 });
    }
  }

  _onRoundEnd(p) {
    if (!this._ready() || !p) return;
    const grp = this._direct(0.55, this.music);
    if (!grp) return;
    const t = this._t() + 0.2;
    const won = p.winner === 'ct'; // the player is always CT

    if (won) {
      const notes = [523.25, 659.25, 783.99, 1046.5];
      for (let i = 0; i < notes.length; i++) {
        this._blip(grp, t + i * 0.12, notes[i], { vol: 0.2, hold: 0.05, tau: 0.12 });
      }
      this._tone(grp, t + 0.48, { f: 1318.5, vol: 0.08, a: 0.01, hold: 0.1, tau: 0.25, type: 'sine' });
    } else {
      const notes = [659.25, 523.25, 415.3, 329.63];
      for (let i = 0; i < notes.length; i++) {
        const nt = t + i * 0.17;
        this._blip(grp, nt, notes[i], { vol: 0.16, hold: 0.06, tau: 0.14, type: 'sine' });
        this._blip(grp, nt, notes[i] * 1.007, { vol: 0.08, hold: 0.06, tau: 0.14, type: 'sine' });
      }
    }
  }

  _onGameEnd(p) {
    if (!this._ready() || !p) return;
    const grp = this._direct(0.6, this.music);
    if (!grp) return;
    const t = this._t() + 0.25;
    const won = p.winner === 'ct';

    if (won) {
      const arp = [523.25, 659.25, 783.99, 1046.5, 1318.5];
      for (let i = 0; i < arp.length; i++) {
        this._blip(grp, t + i * 0.09, arp[i], { vol: 0.18, hold: 0.04, tau: 0.1 });
      }
      // sustained C-major swell
      const chord = [523.25, 659.25, 783.99];
      for (let i = 0; i < chord.length; i++) {
        this._tone(grp, t + 0.45, { f: chord[i], vol: 0.12, a: 0.15, hold: 0.9, tau: 0.5, type: 'triangle' });
      }
      this._noiseHit(grp, t + 0.45, { type: 'highpass', f: 7000, dur: 1.2, vol: 0.04, a: 0.2 });
    } else {
      // sombre low minor swell + descending line
      const line = [440, 392, 329.63, 261.63];
      for (let i = 0; i < line.length; i++) {
        this._blip(grp, t + i * 0.22, line[i], { vol: 0.13, hold: 0.08, tau: 0.18, type: 'sine' });
      }
      const chord = [220, 261.63, 329.63];
      for (let i = 0; i < chord.length; i++) {
        this._tone(grp, t + 0.6, { f: chord[i], vol: 0.1, a: 0.3, hold: 1.0, tau: 0.6, type: 'sine' });
      }
    }
  }

  _onPlanted(p) {
    if (!this._ready() || !p || !p.pos) return;
    // Arming flourish at the bomb: three fast beeps, rising.
    this.play3D((g, t) => {
      this._beepSound(g, t, 1870);
      this._beepSound(g, t + 0.12, 1980);
      this._beepSound(g, t + 0.24, 2140);
    }, p.pos, { refDist: 16, maxDist: 100, vol: 0.7, priority: true });
    this._nextBeep = 0; // restart the beep scheduler immediately
  }

  _onDefused() {
    const grp = this._direct(0.4);
    if (!grp) return;
    const t = this._t();
    // wire-snip + relieved resolve
    this._mech(grp, t, 2400, 0.5);
    this._blip(grp, t + 0.1, 1046.5, { vol: 0.2, dur: 0.09, type: 'sine' });
    this._blip(grp, t + 0.2, 1396.9, { vol: 0.22, dur: 0.16, type: 'sine' });
  }

  _onBotDefusing() {
    if (!this._ready()) return;
    const b = this.game.state && this.game.state.bomb;
    if (!b || !b.pos) return;
    this.play3D((g, t) => {
      this._mech(g, t, 1300, 0.5);
      this._mech(g, t + 0.15, 1600, 0.4);
    }, b.pos, { refDist: 8, maxDist: 40, vol: 0.4 });
  }

  _onBuy() {
    const grp = this._direct(0.4);
    if (!grp) return;
    const t = this._t();
    // register cha-ching
    this._tone(grp, t, { f: 2093, vol: 0.32, a: 0.002, hold: 0.02, tau: 0.09 });
    this._tone(grp, t + 0.06, { f: 2637, vol: 0.26, a: 0.002, hold: 0.02, tau: 0.09 });
    // coin jingle
    for (let i = 0; i < 3; i++) {
      this._tone(grp, t + 0.11 + i * 0.045, { f: this._rnd(3800, 5400), vol: 0.08, a: 0.001, dur: 0.05 });
    }
    // drawer clack
    this._mech(grp, t + 0.02, 700, 0.5);
  }

  _uiClick(f, vol) {
    const grp = this._direct(vol || 0.12);
    if (!grp) return;
    this._mech(grp, this._t(), f || 900, 0.8);
  }

  // ==========================================================================
  // Per-frame scheduling (bomb beeps, defuse ticks, detonation fallback)
  // ==========================================================================

  update(dt) { // eslint-disable-line no-unused-vars -- schedulers use ctx time
    if (!this._ready()) return;
    const st = this.game.state;
    const now = this.ctx.currentTime;

    // Bomb beeps: cadence accelerates as the fuse runs down.
    if (st && st.phase === 'planted' && st.bomb && st.bomb.pos) {
      if (now >= this._nextBeep) {
        const iv = Math.min(1, Math.max(0.12, st.timer / 40));
        this._nextBeep = now + iv;
        const f = st.timer < 8 ? 2320 : 2080;
        this.play3D((g, t) => this._beepSound(g, t, f), st.bomb.pos, {
          refDist: 16, maxDist: 100, vol: 0.65, priority: true,
        });
      }
    } else {
      this._nextBeep = 0;
    }

    // Defuse ticks while the player works on the bomb.
    if (st && st.bomb && st.bomb.planted && st.bomb.defuseProgress > 0) {
      if (now >= this._nextDefTick) {
        this._nextDefTick = now + 0.13;
        this._defTickAlt = !this._defTickAlt;
        const grp = this._direct(0.16);
        if (grp) this._mech(grp, now + 0.002, this._defTickAlt ? 1650 : 1250, 0.8);
      }
    } else {
      this._nextDefTick = 0;
    }

    // Detonation fallback: if no 'fx:explosion' followed 'bomb:detonated',
    // play the big blast ourselves (never let the bomb be silent).
    if (this._detPending && now > this._detAt + 0.3) {
      this._detPending = false;
      if (this._lastFxExplAt < this._detAt - 0.05) {
        this._playExplosionAt(this._detPos, true);
      }
    }
  }
}
