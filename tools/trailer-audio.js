// ============================================================================
// OPERATION GOLDENEYE — tools/trailer-audio.js
//
// Offline soundtrack renderer for the trailer recorder (tools/trailer.js).
// The recorder logs every audio-relevant event with its exact video-timeline
// timestamp (frame / 30 s). This module replays that log into an
// OfflineAudioContext — synthesizing every SFX from oscillators / noise
// buffers / biquads in the same sonic character as src/audio/audio.js — plus
// an original procedural dark-tactical-electronic music bed structured from
// the logged scene markers (never hardcoded times). The result is true-peak
// checked (one corrective re-render if needed), encoded as 16-bit stereo WAV
// and POSTed to the capture sink at :8021/wav for ffmpeg muxing.
//
//   window.__trailer.renderAudio([log]) -> Promise<{
//     duration, eventCount, counts, peak, peakDb, sceneRms,
//     wavBytes, uploadOk, rerendered }>
//
// `log` is optional: defaults to the in-memory audioLog from the last start()
// (dry-run included); pass a saved audiolog.json object ({ totalFrames,
// events }) or a bare events array to render offline from disk.
// ============================================================================

const SR = 48000;
const FPS = 30;
const CAPTURE_BASE = 'http://localhost:8021';
const PEAK_TARGET = 0.89;   // ~ -1 dBFS true peak
const MUSIC_LEVEL = 0.72;   // music bus base gain (bed sits well under SFX)

// --- gunshot character per weapon id (mirrors src/audio/audio.js) -----------
const GUNS = {
  glock:  { vol: 0.60, crack: 0.42, bpFrom: 1750, bpTo: 430, nDur: 0.100, thF: 150, thVol: 0.72, thDur: 0.105 },
  usp:    { vol: 0.30, crack: 0.10, bpFrom: 950,  bpTo: 360, nDur: 0.080, thF: 128, thVol: 0.52, thDur: 0.090, lp: 1150, mech: true },
  deagle: { vol: 1.00, crack: 0.62, bpFrom: 1150, bpTo: 235, nDur: 0.175, thF: 103, thVol: 1.00, thDur: 0.210, mech: true },
  mp5:    { vol: 0.55, crack: 0.40, bpFrom: 1950, bpTo: 545, nDur: 0.068, thF: 158, thVol: 0.62, thDur: 0.080 },
  ak47:   { vol: 0.92, crack: 0.60, bpFrom: 1060, bpTo: 215, nDur: 0.150, thF: 115, thVol: 0.95, thDur: 0.165 },
  m4a1:   { vol: 0.82, crack: 0.55, bpFrom: 1350, bpTo: 300, nDur: 0.118, thF: 133, thVol: 0.85, thDur: 0.135 },
  awp:    { vol: 1.30, crack: 0.78, bpFrom: 720,  bpTo: 130, nDur: 0.300, thF: 84,  thVol: 1.15, thDur: 0.340, sub: 52, echo: true },
};

const FOOT = {
  concrete: { f: 760,  q: 1.1, dur: 0.070, vol: 1.00 },
  sand:     { f: 400,  q: 0.6, dur: 0.110, vol: 0.80 },
  wood:     { f: 520,  q: 1.5, dur: 0.080, vol: 1.00, knock: 175 },
  metal:    { f: 1400, q: 3.0, dur: 0.090, vol: 0.90 },
};

// Reload durations (s) — from src/weapons/data.js reloadTime values.
const RELOADS = { glock: 2.2, usp: 2.2, deagle: 2.2, mp5: 2.6, ak47: 2.5, m4a1: 3.0, awp: 3.6 };

// --- music ------------------------------------------------------------------
const BPM = 92;
const SPB = 60 / BPM;             // seconds per beat
const S16 = SPB / 4;              // sixteenth-note step
const HS = Math.pow(2, 1 / 12);   // half-step ratio (tension key shift)
const NOTE = {
  D1: 36.71, C2: 65.41, D2: 73.42, F2: 87.31, G2: 98.0, A2: 110.0,
  D3: 146.83, F3: 174.61, Fs3: 185.0, A3: 220.0, D4: 293.66,
  F4: 349.23, A4: 440.0, C5: 523.25,
};
// Two-bar bass riff in eighths, D minor (original motif).
const RIFF = [
  NOTE.D2, NOTE.D2, NOTE.D2, NOTE.F2, NOTE.D2, NOTE.D2, NOTE.C2, NOTE.D2,
  NOTE.D2, NOTE.D2, NOTE.D2, NOTE.F2, NOTE.G2, NOTE.F2, NOTE.C2, NOTE.D2,
];
// Cold 16th arp cycle (original), low in the mix.
const ARP = [NOTE.D4, NOTE.F4, NOTE.A4, NOTE.C5, NOTE.D4, NOTE.A4, NOTE.F4, NOTE.C5];

// Scene name → music intensity level (structure follows logged markers).
// 0 pad only · 1 +pulse bass · 2 +drums/riff · 3 +arp · 4 tension · 9 outro
const SCENE_LEVEL = {
  title: 0, flyover: 1, 'mid push': 2, awp: 3, utility: 3,
  retake: 4, defuse: 4, endcard: 9,
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const rnd = (a, b) => a + Math.random() * (b - a);
const toDb = (x) => (x > 1e-7 ? Math.round(200 * Math.log10(x)) / 10 : -140);

// ---------------------------------------------------------------------------
// Synth building blocks (offline, absolute-time scheduling)
// ---------------------------------------------------------------------------
function makeNoiseBuf(ctx) {
  const len = Math.floor(ctx.sampleRate * 2);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

class Synth {
  constructor(ctx, noiseBuf) {
    this.ctx = ctx;
    this.noise = noiseBuf;
  }

  filter(type, f, q) {
    const flt = this.ctx.createBiquadFilter();
    flt.type = type;
    flt.frequency.value = f;
    flt.Q.value = q || 1;
    return flt;
  }

  /** Oscillator layer: { f, type, vol, a, dur | (tau, hold), end, slideDur, lp, lpQ } */
  tone(dest, t, o) {
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
      stopAt = t + a + hold + o.tau * 7;
    } else {
      const dur = o.dur || 0.15;
      g.gain.exponentialRampToValueAtTime(0.0008, t + a + dur);
      g.gain.linearRampToValueAtTime(0, t + a + dur + 0.012);
      stopAt = t + a + dur + 0.03;
    }
    let node = osc;
    if (o.lp) {
      const lp = this.filter('lowpass', o.lp, o.lpQ || 0.7);
      node.connect(lp);
      node = lp;
    }
    node.connect(g);
    g.connect(dest);
    osc.start(t);
    osc.stop(stopAt);
  }

  /** Filtered-noise layer: { type, f, fEnd, slideDur, q, dur, vol, a, rate, lp } */
  noiseHit(dest, t, o) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.playbackRate.value = o.rate || 1;
    const flt = ctx.createBiquadFilter();
    flt.type = o.type || 'bandpass';
    flt.frequency.setValueAtTime(Math.max(20, o.f), t);
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
      const lp = this.filter('lowpass', o.lp, 0.7);
      node.connect(lp);
      node = lp;
    }
    node.connect(g);
    g.connect(dest);
    src.start(t, rnd(0, 1.2));
    src.stop(t + a + o.dur + 0.03);
  }

  /** Short mechanical transient (clicks, clacks, ticks). */
  mech(dest, t, f, vol) {
    this.noiseHit(dest, t, { type: 'bandpass', f: f * rnd(0.92, 1.08), q: 2.2, dur: 0.028, vol, a: 0.001 });
    this.tone(dest, t, { f: f * 0.55, type: 'square', vol: vol * 0.35, a: 0.001, dur: 0.018, lp: f * 1.4 });
  }

  /** Layered gunshot (see audio.js _gunshot); dist culls detail layers. */
  gunshot(dest, t, p, dist) {
    const far = dist > 34;
    this.noiseHit(dest, t, {
      type: 'bandpass', f: p.bpFrom, fEnd: p.bpTo, slideDur: p.nDur, q: 0.85,
      dur: p.nDur * 1.6, vol: 1.0, a: 0.003, rate: rnd(0.92, 1.08), lp: p.lp,
    });
    if (!far && p.crack) {
      this.noiseHit(dest, t, { type: 'highpass', f: 3200, q: 0.7, dur: 0.022, vol: p.crack, a: 0.001 });
    }
    this.tone(dest, t, {
      f: p.thF * rnd(0.95, 1.05), end: p.thF * 0.52, slideDur: p.thDur,
      dur: p.thDur * 1.35, vol: p.thVol, a: 0.004,
    });
    if (p.sub && dist < 50) {
      this.tone(dest, t, { f: p.sub, end: p.sub * 0.6, slideDur: 0.4, dur: 0.42, vol: 0.8, a: 0.006 });
    }
    if (p.mech && dist < 12) this.mech(dest, t + 0.045, 1500, 0.12);
    if (p.echo && dist < 70) {
      // AWP canyon echo tail: ~0.18 s spacing x3, decaying + darkening.
      const gains = [0.34, 0.13, 0.05];
      for (let i = 1; i <= 3; i++) {
        this.noiseHit(dest, t + 0.18 * i, {
          type: 'bandpass', f: p.bpFrom * 0.7, fEnd: p.bpTo, slideDur: p.nDur, q: 0.8,
          dur: p.nDur * 1.5, vol: gains[i - 1], a: 0.004, lp: 2600 - i * 600,
        });
        this.tone(dest, t + 0.18 * i, {
          f: p.thF * 0.9, end: p.thF * 0.5, slideDur: p.thDur,
          dur: p.thDur * 1.2, vol: p.thVol * gains[i - 1] * 0.9, a: 0.005,
        });
      }
    }
  }

  swish(dest, t) { // knife
    this.noiseHit(dest, t, { type: 'bandpass', f: 300, fEnd: 2400, slideDur: 0.13, q: 1.3, dur: 0.16, vol: 0.9, a: 0.02, rate: rnd(0.9, 1.1) });
  }

  throwSwish(dest, t) { // grenade lob
    this.noiseHit(dest, t, { type: 'bandpass', f: 260, fEnd: 1100, slideDur: 0.2, q: 1.1, dur: 0.22, vol: 0.9, a: 0.05 });
  }

  footstep(dest, t, surface) {
    const p = FOOT[surface] || FOOT.concrete;
    this.noiseHit(dest, t, { type: 'bandpass', f: p.f * rnd(0.88, 1.14), q: p.q, dur: p.dur, vol: p.vol, a: 0.004, rate: rnd(0.9, 1.15) });
    if (p.knock) this.tone(dest, t, { f: p.knock * rnd(0.92, 1.08), vol: 0.35, a: 0.003, dur: 0.05, end: p.knock * 0.7 });
  }

  impact(dest, t, surface) {
    if (surface === 'metal') {
      const f = rnd(2100, 2750);
      this.tone(dest, t, { f, type: 'triangle', vol: 0.5, a: 0.001, hold: 0.01, tau: 0.06, end: f * 0.92, slideDur: 0.2 });
      this.noiseHit(dest, t, { type: 'highpass', f: 4000, dur: 0.018, vol: 0.3, a: 0.001 });
    } else if (surface === 'wood') {
      this.noiseHit(dest, t, { type: 'bandpass', f: rnd(420, 560), q: 1.2, dur: 0.055, vol: 0.6, a: 0.002, rate: 0.85 });
      this.tone(dest, t, { f: 190, vol: 0.35, a: 0.002, dur: 0.06, end: 120 });
    } else if (surface === 'sand') {
      this.noiseHit(dest, t, { type: 'lowpass', f: 600, dur: 0.08, vol: 0.55, a: 0.006, rate: 0.8 });
    } else { // concrete chip
      this.noiseHit(dest, t, { type: 'highpass', f: 2400, dur: 0.04, vol: 0.55, a: 0.001 });
      this.noiseHit(dest, t, { type: 'bandpass', f: rnd(800, 1100), q: 1.0, dur: 0.03, vol: 0.3, a: 0.001 });
    }
  }

  explosion(dest, t, dist) {
    if (dist < 45) this.noiseHit(dest, t, { type: 'highpass', f: 2800, dur: 0.045, vol: 0.9, a: 0.001 });
    this.noiseHit(dest, t, { type: 'lowpass', f: 1000, fEnd: 90, slideDur: 0.9, dur: 1.3, vol: 1.25, a: 0.002, rate: 0.9 });
    this.tone(dest, t, { f: 55, end: 30, slideDur: 1.2, dur: 1.3, vol: 1.1, a: 0.005 }); // 50 Hz-class sub swell
    this.noiseHit(dest, t + 0.15, { type: 'lowpass', f: 220, dur: 1.7, vol: 0.5, a: 0.12, rate: 0.7 });
    if (dist < 30) {
      for (let i = 0; i < 3; i++) {
        this.noiseHit(dest, t + rnd(0.25, 0.9), { type: 'bandpass', f: rnd(900, 2200), q: 2.0, dur: 0.03, vol: 0.12, a: 0.002 });
      }
    }
  }

  flashbang(dest, t, dist) {
    this.noiseHit(dest, t, { type: 'highpass', f: 2500, dur: 0.07, vol: 1.0, a: 0.001 });
    this.noiseHit(dest, t, { type: 'bandpass', f: 1500, q: 0.8, dur: 0.15, vol: 0.7, a: 0.002 });
    this.tone(dest, t, { f: 160, end: 70, slideDur: 0.12, vol: 0.5, a: 0.003, dur: 0.14 });
    // 3 kHz tinnitus ring fading ~2.5 s, scaled by proximity.
    const ring = Math.max(0.12, 1 - dist / 30);
    this.tone(dest, t, { f: 2954, vol: 0.4 * ring, a: 0.004, hold: 0.4, tau: 0.75 });
    this.tone(dest, t, { f: 3021, vol: 0.22 * ring, a: 0.004, hold: 0.3, tau: 0.6 });
    this.noiseHit(dest, t, { type: 'highpass', f: 6000, dur: 2.2, vol: 0.04 * ring, a: 0.02 });
  }

  smoke(dest, t) {
    this.tone(dest, t, { f: 240, end: 70, slideDur: 0.1, vol: 0.6, a: 0.003, dur: 0.12 });
    this.noiseHit(dest, t, { type: 'bandpass', f: 700, q: 0.9, dur: 0.06, vol: 0.45, a: 0.002 });
    this.noiseHit(dest, t + 0.06, { type: 'lowpass', f: 2600, fEnd: 800, slideDur: 1.9, dur: 2.1, vol: 0.35, a: 0.15 });
  }

  hitmarker(dest, t, headshot, kill) {
    this.noiseHit(dest, t, { type: 'highpass', f: 5500, dur: 0.018, vol: 0.4, a: 0.001 });
    this.tone(dest, t, { f: 2000, type: 'square', vol: 0.16, a: 0.001, dur: 0.02, lp: 4000 });
    if (headshot) {
      this.tone(dest, t + 0.012, { f: 2800, end: 2500, slideDur: 0.08, vol: 0.3, a: 0.002, hold: 0.02, tau: 0.07 });
    }
    if (kill) {
      this.tone(dest, t + 0.06, { f: 170, end: 85, slideDur: 0.08, vol: 0.22, a: 0.004, dur: 0.1 });
    }
  }

  /** Deep cinematic braam: detuned low saws → closing lowpass + sub thump. */
  braam(dest, t) {
    const lp = this.filter('lowpass', 1500, 0.8);
    lp.frequency.setValueAtTime(1500, t);
    lp.frequency.exponentialRampToValueAtTime(150, t + 2.8);
    lp.connect(dest);
    for (const m of [0.992, 1.0, 1.008]) {
      this.tone(lp, t, { f: 55 * m, type: 'sawtooth', vol: 0.42, a: 0.025, hold: 0.4, tau: 0.7 });
    }
    for (const m of [0.9955, 1.0045]) {
      this.tone(lp, t, { f: 110 * m, type: 'sawtooth', vol: 0.22, a: 0.03, hold: 0.35, tau: 0.62 });
    }
    this.tone(dest, t, { f: 46, end: 30, slideDur: 1.1, dur: 1.5, vol: 0.85, a: 0.006 });
    this.noiseHit(dest, t, { type: 'lowpass', f: 700, fEnd: 90, slideDur: 1.5, dur: 1.9, vol: 0.45, a: 0.004, rate: 0.85 });
  }
}

// ---------------------------------------------------------------------------
// Spatializer: distance gain + StereoPanner + air-absorption lowpass
// ---------------------------------------------------------------------------
function spatial(S, sfx, dist, pan, vol) {
  const ctx = S.ctx;
  const g = ctx.createGain();
  g.gain.value = vol * Math.min(1, 8 / Math.max(dist || 0, 1));
  let dest = sfx;
  if (pan && ctx.createStereoPanner) {
    const p = ctx.createStereoPanner();
    p.pan.value = clamp(pan * 0.8, -1, 1);
    p.connect(sfx);
    dest = p;
  }
  if (dist > 16) {
    const air = S.filter('lowpass', Math.max(1200, 16000 * Math.min(1, 19 / dist)), 0.5);
    air.connect(dest);
    dest = air;
  }
  g.connect(dest);
  return g;
}

// ---------------------------------------------------------------------------
// SFX pass: one scheduled sound per logged event (+ derived beep/ratchet loops)
// ---------------------------------------------------------------------------
function scheduleSfx(S, sfx, events, duration, ducks) {
  let tPlanted = null;
  let tDefused = null;
  const defuseWindows = [];
  let openDefuse = null;

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const t = Math.max(0.02, e.t || 0);
    switch (e.type) {
      case 'weapon:fire': {
        if (e.melee || e.w === 'knife') { S.swish(spatial(S, sfx, 0, 0, 0.3), t); break; }
        const p = GUNS[e.w] || GUNS.m4a1;
        const dest = spatial(S, sfx, 0, 0, p.vol * 0.5);
        S.gunshot(dest, t, p, 0);
        if (e.w === 'awp') {
          S.mech(dest, t + 0.55, 850, 0.30);   // bolt cycle
          S.mech(dest, t + 0.74, 1250, 0.24);
          ducks.push({ t, mus: 0.6 });
        }
        break;
      }
      case 'bot:fire': {
        const p = GUNS[e.w] || GUNS.ak47;
        S.gunshot(spatial(S, sfx, e.dist, e.pan, p.vol * 0.55), t, p, e.dist || 0);
        break;
      }
      case 'fx:impact':
        S.impact(spatial(S, sfx, e.dist, e.pan, 0.18), t, e.surface);
        break;
      case 'fx:explosion':
        S.explosion(spatial(S, sfx, e.dist, e.pan, 1.35), t, e.dist || 0);
        ducks.push({ t, mus: 0.5, master: 0.5 });
        break;
      case 'fx:flash':
        S.flashbang(spatial(S, sfx, e.dist, e.pan, 1.1), t, e.dist || 0);
        ducks.push({ t, mus: 0.55, master: 0.6 });
        break;
      case 'fx:smoke':
        S.smoke(spatial(S, sfx, e.dist, e.pan, 0.5), t);
        break;
      case 'fx:blood': { // body-hit thwack
        const dest = spatial(S, sfx, e.dist, e.pan, 0.5);
        S.tone(dest, t, { f: 220, end: 80, slideDur: 0.08, vol: 0.55, a: 0.002, dur: 0.09 });
        S.noiseHit(dest, t, { type: 'lowpass', f: 900, dur: 0.055, vol: 0.45, a: 0.002, rate: 0.8 });
        break;
      }
      case 'weapon:equip': { // draw foley: two crisp clicks
        const dest = spatial(S, sfx, 0, 0, 0.28);
        S.mech(dest, t, 900, 0.5);
        S.mech(dest, t + 0.07, 1400, 0.4);
        break;
      }
      case 'bot:death': { // cloth rustle + floor thud
        const dest = spatial(S, sfx, e.dist, e.pan, 0.55);
        S.noiseHit(dest, t + 0.12, { type: 'lowpass', f: 350, dur: 0.16, vol: 0.8, a: 0.01, rate: 0.7 });
        S.tone(dest, t + 0.14, { f: 72, vol: 0.5, a: 0.005, dur: 0.12, end: 45 });
        break;
      }
      case 'player:land': {
        const v = Math.min(0.5, 0.12 + ((e.speed || 3) - 3) * 0.045);
        const dest = spatial(S, sfx, 0, 0, v);
        S.noiseHit(dest, t, { type: 'lowpass', f: 500, dur: 0.1, vol: 0.9, a: 0.004, rate: 0.85 });
        S.tone(dest, t, { f: 95, vol: 0.6, a: 0.004, dur: 0.1, end: 55 });
        break;
      }
      case 'player:damage': { // incoming-hit thud
        const dest = spatial(S, sfx, 0, 0, Math.min(0.42, 0.12 + (e.amount || 10) / 90));
        S.tone(dest, t, { f: 140, end: 62, slideDur: 0.1, vol: 0.8, a: 0.003, dur: 0.12 });
        S.noiseHit(dest, t, { type: 'lowpass', f: 700, dur: 0.06, vol: 0.4, a: 0.002 });
        break;
      }
      case 'hud:hitmarker':
        S.hitmarker(spatial(S, sfx, 0, 0, 0.32), t, !!e.headshot, !!e.kill);
        break;
      case 'kill': // subtle body-drop thunk (covers staged kills too)
        S.tone(spatial(S, sfx, 0, 0, 0.14), t + 0.1, { f: 120, end: 60, slideDur: 0.1, dur: 0.12, vol: 0.8, a: 0.005 });
        break;
      case 'weapon:reload:start': {
        const dur = e.dur || RELOADS[e.w] || 2.5;
        const dest = spatial(S, sfx, 0, 0, 0.4);
        // 3 mechanical clicks spread across ~40-70% of the reload
        S.mech(dest, t + dur * 0.40, 1450, 0.5);
        S.mech(dest, t + dur * 0.55, 820, 0.6);
        S.tone(dest, t + dur * 0.55, { f: 210, vol: 0.3, a: 0.003, dur: 0.07, end: 130 });
        S.mech(dest, t + dur * 0.70, 1250, 0.5);
        break;
      }
      case 'weapon:scope':
        S.mech(spatial(S, sfx, 0, 0, 0.16), t, 800 + (e.level || 0) * 350, 0.7);
        break;
      case 'grenade:throw':
        S.throwSwish(spatial(S, sfx, 0, 0, 0.24), t);
        break;
      case 'bomb:planted': {
        if (tPlanted === null) tPlanted = t;
        const dest = spatial(S, sfx, 0, 0, 0.5);
        // tense two-note sting: dissonant low pair, then a minor-third rise
        S.tone(dest, t, { f: 92.5, type: 'sawtooth', vol: 0.34, a: 0.02, hold: 0.45, tau: 0.4, lp: 750 });
        S.tone(dest, t, { f: 98, type: 'sawtooth', vol: 0.28, a: 0.02, hold: 0.45, tau: 0.4, lp: 750 });
        S.tone(dest, t + 0.5, { f: 130.81, type: 'sawtooth', vol: 0.34, a: 0.03, hold: 0.6, tau: 0.55, lp: 900 });
        S.tone(dest, t + 0.5, { f: 61.74, vol: 0.4, a: 0.02, dur: 0.9, end: 41 });
        break;
      }
      case 'bomb:defused': {
        if (tDefused === null) tDefused = t;
        const dest = spatial(S, sfx, 0, 0, 0.45);
        S.mech(dest, t, 2400, 0.5); // wire snip
        S.tone(dest, t + 0.12, { f: 587.33, vol: 0.26, a: 0.004, hold: 0.03, tau: 0.11 });
        S.tone(dest, t + 0.26, { f: 880, vol: 0.28, a: 0.004, hold: 0.03, tau: 0.13 });
        S.tone(dest, t + 0.42, { f: 1174.66, vol: 0.3, a: 0.004, hold: 0.05, tau: 0.22 });
        ducks.push({ t, mus: 0.5 });
        break;
      }
      case 'round:phase':
        if (e.phase === 'live') {
          const dest = spatial(S, sfx, 0, 0, 0.14);
          S.tone(dest, t, { f: 392, type: 'triangle', vol: 0.5, a: 0.008, dur: 0.06 });
          S.tone(dest, t + 0.09, { f: 587.33, type: 'triangle', vol: 0.55, a: 0.008, dur: 0.12 });
        }
        break;
      case 'round:end':
        if (e.winner === 'ct') {
          const dest = spatial(S, sfx, 0, 0, 0.5);
          const notes = [587.33, 739.99, 880, 1174.66]; // rising D-major triad
          for (let k = 0; k < notes.length; k++) {
            S.tone(dest, t + 0.15 + k * 0.12, { f: notes[k], type: 'triangle', vol: 0.26, a: 0.006, hold: 0.04, tau: 0.14 });
          }
          const chord = [293.66, 369.99, 440];
          for (let k = 0; k < chord.length; k++) {
            S.tone(dest, t + 0.62, { f: chord[k], type: 'triangle', vol: 0.11, a: 0.15, hold: 0.8, tau: 0.5 });
          }
        }
        break;
      case 'player:footstep':
        S.footstep(spatial(S, sfx, 0, 0, e.walking ? 0.07 : 0.13), t, e.surface);
        break;
      case 'bot:footstep':
        S.footstep(spatial(S, sfx, e.dist, e.pan, 0.5), t, 'concrete');
        break;
      case 'scene':
        if (e.name === 'title') S.braam(spatial(S, sfx, 0, 0, 0.75), t + 0.3);
        else if (e.name === 'endcard') S.braam(spatial(S, sfx, 0, 0, 0.7), t + 0.45);
        break;
      case 'defuse-start':
        openDefuse = t;
        break;
      case 'defuse-end':
        if (openDefuse !== null) { defuseWindows.push([openDefuse, t]); openDefuse = null; }
        break;
      default: break;
    }
  }
  if (openDefuse !== null) defuseWindows.push([openDefuse, tDefused !== null ? tDefused : duration]);

  // Bomb beeps: accelerating cadence, plant → defuse (red-alert character).
  if (tPlanted !== null) {
    const stopAt = Math.min(tDefused !== null ? tDefused : duration, duration);
    let bt = tPlanted + 0.6;
    let guard = 0;
    while (bt < stopAt && guard++ < 400) {
      const dest = spatial(S, sfx, 0, 0, 0.26);
      S.tone(dest, bt, { f: 1108, type: 'square', vol: 0.5, a: 0.002, dur: 0.055, lp: 3400 });
      S.tone(dest, bt, { f: 2216, vol: 0.12, a: 0.002, dur: 0.04 });
      bt += clamp((40 - (bt - tPlanted)) / 40, 0.12, 1);
    }
  }

  // Quiet ratchet tick loop while the player works the defuse kit.
  for (const [a, b] of defuseWindows) {
    let alt = false;
    let guard = 0;
    for (let tt = a; tt < Math.min(b, duration) && guard++ < 200; tt += 0.13) {
      alt = !alt;
      S.mech(spatial(S, sfx, 0, 0, 0.13), tt, alt ? 1650 : 1250, 0.8);
    }
  }
}

// ---------------------------------------------------------------------------
// Music pass: original dark tactical-electronic bed from the scene markers
// ---------------------------------------------------------------------------
function pad(S, music, t0, t1, freqs, o) {
  if (!(t1 - t0 > 0.5)) return;
  const ctx = S.ctx;
  const lp = S.filter('lowpass', o.lpFrom, 0.8);
  lp.frequency.setValueAtTime(o.lpFrom, t0);
  lp.frequency.linearRampToValueAtTime(o.lpTo, t1);
  const g = ctx.createGain();
  const a = Math.min(o.a || 1.1, (t1 - t0) * 0.5);
  const stop = t1 + (o.r || 1.0);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(o.vol, t0 + a);
  g.gain.setValueAtTime(o.vol, Math.max(t0 + a, t1 - 0.05));
  g.gain.linearRampToValueAtTime(0, stop);
  lp.connect(g);
  g.connect(music);
  for (const f of freqs) {
    for (const d of [0.9952, 1.0048]) { // detuned saw pair per voice
      const osc = ctx.createOscillator();
      osc.type = o.type || 'sawtooth';
      osc.frequency.value = f * d;
      osc.connect(lp);
      osc.start(t0);
      osc.stop(stop + 0.05);
    }
  }
}

function scheduleMusic(S, music, events, duration) {
  const markers = [];
  for (const e of events) {
    if (e.type === 'scene') markers.push({ name: e.name, t: Math.max(0, e.t || 0) });
  }
  markers.sort((a, b) => a.t - b.t);
  if (!markers.length) markers.push({ name: 'mid push', t: 0 });

  const segs = [];
  let lvl = 2;
  for (let i = 0; i < markers.length; i++) {
    const m = markers[i];
    if (SCENE_LEVEL[m.name] !== undefined) lvl = SCENE_LEVEL[m.name];
    segs.push({
      name: m.name, start: m.t,
      end: i + 1 < markers.length ? markers[i + 1].t : duration,
      level: lvl,
    });
  }
  const levelAt = (t) => {
    let out = segs[0].level;
    for (const s of segs) if (t >= s.start) out = s.level;
    return out;
  };

  const first = segs[0];
  const groove0 = segs.find((s) => s.level >= 1 && s.level <= 4);
  const anchor = groove0 ? groove0.start : first.start;
  const tension0 = segs.find((s) => s.level === 4);
  const endSeg = segs.find((s) => s.level === 9);
  const tEndcard = endSeg ? endSeg.start : duration;
  const re = events.find((e) => e.type === 'round:end');
  const tResolve = re && re.t < tEndcard ? Math.max(0, re.t) : null;
  const rhythmStop = Math.min(tResolve !== null ? tResolve : Infinity, tEndcard, duration);
  const tensionStart = tension0 ? tension0.start : rhythmStop;

  // ---- pads (chord regions follow the markers) ----
  const Dm = [NOTE.D2, NOTE.A2, NOTE.D3, NOTE.F3];
  const Ebm = Dm.map((f) => f * HS);
  const Dmaj = [NOTE.D2, NOTE.A2, NOTE.D3, NOTE.Fs3, NOTE.A3];
  const padEnd1 = tension0 ? tension0.start : (tResolve !== null ? tResolve : tEndcard);
  pad(S, music, first.start, padEnd1, Dm, { vol: 0.11, lpFrom: 240, lpTo: 680, a: 1.1, r: 1.4 });
  if (tension0) {
    pad(S, music, tension0.start, tResolve !== null ? tResolve : tEndcard, Ebm,
      { vol: 0.12, lpFrom: 480, lpTo: 1250, a: 0.7, r: 0.9 });
  }
  if (tResolve !== null) {
    pad(S, music, tResolve + 0.1, tEndcard, Dmaj, { vol: 0.12, lpFrom: 900, lpTo: 420, a: 0.5, r: 1.2 });
    for (const f of [NOTE.D3, NOTE.Fs3, NOTE.A3, NOTE.D4]) { // resolving major hit
      S.tone(music, tResolve + 0.08, { f, type: 'triangle', vol: 0.15, a: 0.02, hold: 0.3, tau: 0.9 });
    }
  }
  pad(S, music, tEndcard, duration - 0.4, Dm, { vol: 0.12, lpFrom: 520, lpTo: 200, a: 0.9, r: 0.6 });
  if (duration > 4) { // final low note
    S.tone(music, duration - 2.7, { f: NOTE.D1 * 2, end: NOTE.D1, slideDur: 1.4, vol: 0.34, a: 0.4, dur: 1.7 });
  }

  // ---- title: sparse sub pulses under the brooding pad ----
  if (first.level === 0) {
    for (let st = first.start + 0.7; st < first.end - 0.3; st += SPB * 2) {
      S.tone(music, st, { f: NOTE.D2, end: NOTE.D1, slideDur: 0.5, vol: 0.2, a: 0.12, dur: 0.55 });
    }
  }

  // ---- rhythm grid: anchored 16ths at 92 BPM ----
  let guard = 0;
  for (let k = 0; ; k++) {
    const st = anchor + k * S16;
    if (st >= rhythmStop || guard++ > 4000) break;
    const L = levelAt(st);
    if (L < 1 || L > 4) continue;
    const i16 = k % 16; // position within the bar
    const i4 = k % 4;   // position within the beat
    const tension = L === 4;
    const shift = tension ? HS : 1; // pads/bass/arp swell a half-step up

    if (k % 2 === 0) { // bass on the 8th grid
      let f;
      let vol;
      if (L === 1) { f = NOTE.D2; vol = i16 === 0 ? 0.26 : 0.19; } // pulse
      else { f = RIFF[(k / 2) % 16] * shift; vol = 0.22; }         // two-bar riff
      S.tone(music, st, { f, type: 'sawtooth', vol, a: 0.008, dur: S16 * 1.5, lp: 300, lpQ: 1.1 });
      S.tone(music, st, { f: f / 2, vol: vol * 0.85, a: 0.006, dur: S16 * 1.35 });
    }
    if (L >= 2) {
      if (i4 === 0) { // 4-on-floor kick: pitched-down sine thump
        S.tone(music, st, { f: 150, end: 42, slideDur: 0.07, vol: 0.5, a: 0.002, dur: 0.1 });
      }
      if (i16 === 4 || i16 === 12) { // snare on 2 + 4
        S.noiseHit(music, st, { type: 'bandpass', f: 1900, q: 0.9, dur: 0.09, vol: 0.26, a: 0.001 });
        S.tone(music, st, { f: 215, end: 150, slideDur: 0.05, vol: 0.1, a: 0.001, dur: 0.06 });
      }
      if (i4 === 2) { // offbeat filtered-noise hat
        S.noiseHit(music, st, { type: 'highpass', f: 7500, dur: 0.028, vol: 0.09, a: 0.001 });
      }
      if (tension && (i4 === 1 || i4 === 3)) { // ticking 16th hats
        S.noiseHit(music, st, { type: 'highpass', f: 9000, dur: 0.02, vol: 0.055, a: 0.001 });
      }
    }
    if (L >= 3) { // cold plucky arp, rising cutoff through the tension window
      const prog = tension && rhythmStop > tensionStart
        ? clamp((st - tensionStart) / (rhythmStop - tensionStart), 0, 1) : 0;
      S.tone(music, st, { f: ARP[i16 % 8] * shift, type: 'square', vol: 0.065, a: 0.002, dur: 0.075, lp: 900 + 1900 * prog, lpQ: 1.2 });
    }
  }
}

// ---------------------------------------------------------------------------
// Ducking automation (music dips under big transients, recovers ~1.5 s)
// ---------------------------------------------------------------------------
function applyDucks(musicGain, duckGain, ducks) {
  ducks.sort((a, b) => a.t - b.t);
  for (const d of ducks) {
    const t = Math.max(0.02, d.t);
    musicGain.gain.setTargetAtTime(MUSIC_LEVEL * (d.mus || 0.55), t, 0.03);
    musicGain.gain.setTargetAtTime(MUSIC_LEVEL, t + 0.4, 0.45);
    if (d.master) {
      duckGain.gain.setTargetAtTime(d.master, t, 0.012);
      duckGain.gain.setTargetAtTime(1, t + 0.12, 0.35);
    }
  }
}

// ---------------------------------------------------------------------------
// Offline render / analysis / WAV
// ---------------------------------------------------------------------------
function renderOnce(events, duration, trim) {
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OAC) return Promise.reject(new Error('OfflineAudioContext unavailable'));
  const ctx = new OAC(2, Math.ceil(duration * SR), SR);

  const master = ctx.createGain(); // trim stage (peak control) + end fade
  master.gain.setValueAtTime(trim, 0);
  master.gain.setValueAtTime(trim, Math.max(0, duration - 0.3));
  master.gain.linearRampToValueAtTime(0.0001, Math.max(0.02, duration - 0.02));
  master.connect(ctx.destination);

  const duck = ctx.createGain(); // master-wide blast duck
  duck.gain.value = 1;
  duck.connect(master);

  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.knee.value = 12;
  comp.ratio.value = 4;
  comp.attack.value = 0.003;
  comp.release.value = 0.25;
  comp.connect(duck);

  const sfx = ctx.createGain();
  sfx.gain.value = 1;
  sfx.connect(comp);

  const music = ctx.createGain();
  music.gain.value = MUSIC_LEVEL;
  music.connect(comp);

  const S = new Synth(ctx, makeNoiseBuf(ctx));
  const ducks = [];
  scheduleSfx(S, sfx, events, duration, ducks);
  scheduleMusic(S, music, events, duration);
  applyDucks(music, duck, ducks);
  return ctx.startRendering();
}

function scanPeak(buf) {
  let peak = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const v = d[i] < 0 ? -d[i] : d[i];
      if (v > peak) peak = v;
    }
  }
  return peak;
}

function measureScenes(buf, events, duration) {
  const markers = [];
  for (const e of events) {
    if (e.type === 'scene') markers.push({ name: e.name, t: Math.max(0, e.t || 0) });
  }
  markers.sort((a, b) => a.t - b.t);
  if (!markers.length) markers.push({ name: 'all', t: 0 });
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);
  const out = [];
  for (let i = 0; i < markers.length; i++) {
    const start = markers[i].t;
    const end = i + 1 < markers.length ? markers[i + 1].t : duration;
    const i0 = Math.max(0, Math.floor(start * buf.sampleRate));
    const i1 = Math.min(buf.length, Math.floor(end * buf.sampleRate));
    if (i1 <= i0) continue;
    let sum = 0;
    for (let s = i0; s < i1; s++) sum += L[s] * L[s] + R[s] * R[s];
    const rms = Math.sqrt(sum / ((i1 - i0) * 2));
    // quietest 0.4 s window (0.2 s hop): proves the bed never drops out
    const win = Math.floor(0.4 * buf.sampleRate);
    const hop = Math.floor(0.2 * buf.sampleRate);
    let minRms = rms;
    for (let w0 = i0; w0 + win <= i1; w0 += hop) {
      let ws = 0;
      for (let s = w0; s < w0 + win; s++) ws += L[s] * L[s] + R[s] * R[s];
      const wr = Math.sqrt(ws / (win * 2));
      if (wr < minRms) minRms = wr;
    }
    out.push({
      scene: markers[i].name,
      start: Math.round(start * 100) / 100,
      end: Math.round(end * 100) / 100,
      rmsDb: toDb(rms),
      minWinDb: toDb(minRms),
    });
  }
  return out;
}

function encodeWav(buf) {
  const nCh = 2;
  const n = buf.length;
  const blockAlign = nCh * 2;
  const dataSize = n * blockAlign;
  const ab = new ArrayBuffer(44 + dataSize);
  const dv = new DataView(ab);
  const wstr = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  wstr(0, 'RIFF');
  dv.setUint32(4, 36 + dataSize, true);
  wstr(8, 'WAVE');
  wstr(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);            // PCM
  dv.setUint16(22, nCh, true);
  dv.setUint32(24, buf.sampleRate, true);
  dv.setUint32(28, buf.sampleRate * blockAlign, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, 16, true);
  wstr(36, 'data');
  dv.setUint32(40, dataSize, true);
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);
  let off = 44;
  for (let i = 0; i < n; i++) {
    let s = L[i] < -1 ? -1 : L[i] > 1 ? 1 : L[i];
    dv.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
    s = R[i] < -1 ? -1 : R[i] > 1 ? 1 : R[i];
    dv.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return ab;
}

// ---------------------------------------------------------------------------
// Entry point (wired by tools/trailer.js as window.__trailer.renderAudio)
// ---------------------------------------------------------------------------
export default function initAudioRenderer(game, trailerState) {
  let inFlight = null;

  async function renderAudio(optLog) {
    const raw = optLog || (trailerState && trailerState.audioLog);
    const events = Array.isArray(raw) ? raw : (raw && raw.events) || [];
    if (!events.length) {
      throw new Error('renderAudio: audio log is empty — run window.__trailer.start() first');
    }
    const loggedFrames = !Array.isArray(raw) && raw && raw.totalFrames ? raw.totalFrames : null;
    const totalFrames = loggedFrames
      || (trailerState && trailerState.progress && trailerState.progress.totalFrames)
      || Math.ceil((events[events.length - 1].t + 4) * FPS);
    const duration = totalFrames / FPS;

    let trim = 1;
    let rendered = await renderOnce(events, duration, trim);
    let peak = scanPeak(rendered);
    let rerendered = false;
    if (peak > PEAK_TARGET) { // scale master and re-render once
      trim = (PEAK_TARGET * 0.97) / peak;
      rendered = await renderOnce(events, duration, trim);
      peak = scanPeak(rendered);
      rerendered = true;
    }

    const sceneRms = measureScenes(rendered, events, duration);
    const wav = encodeWav(rendered);
    let uploadOk = false;
    try {
      const res = await fetch(`${CAPTURE_BASE}/wav`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: wav,
      });
      uploadOk = !!(res && res.ok);
    } catch (_) {
      uploadOk = false; // sink down (dry-run verification) — still resolve
    }

    const counts = {};
    for (const e of events) counts[e.type] = (counts[e.type] || 0) + 1;
    return {
      duration,
      eventCount: events.length,
      counts,
      peak: Math.round(peak * 10000) / 10000,
      peakDb: toDb(peak),
      sceneRms,
      wavBytes: wav.byteLength,
      uploadOk,
      rerendered,
    };
  }

  return (optLog) => {
    if (!inFlight) {
      inFlight = renderAudio(optLog).finally(() => { inFlight = null; });
    }
    return inFlight;
  };
}
