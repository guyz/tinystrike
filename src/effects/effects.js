// ============================================================================
// OPERATION GOLDENEYE — src/effects/effects.js
// Section K: all visual FX. Everything pooled; zero allocations per frame.
//
// Pools:
//   - 3 GPU point-particle systems (additive sparks, hard debris bits, soft
//     dust puffs) — single draw call each, CPU-simmed into typed arrays.
//   - Spark streak meshes (stretched additive boxes) for metal hits/explosions.
//   - Tracer meshes (32) streaking from muzzle to impact.
//   - Brass shell meshes (24) with tumble + one floor bounce.
//   - Burst sprites (flashes / fireballs, additive).
//   - Puff sprites (big billboards: smoke grenades + explosion smoke).
//   - Bullet-hole decals: ONE merged mesh, 80-quad FIFO ring.
//   - Fixed light pool (added once at construction, animated by intensity so
//     the renderer never recompiles shaders from changing light counts).
//
// 4 shared procedural sprite textures built once at construction:
//   spark dot, soft puff, star flash, bullet hole.
//
// Everything cleans up on 'round:start'.
// ============================================================================

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Scratch objects (module-level, reused everywhere; never allocate per frame)
// ---------------------------------------------------------------------------
const _va = new THREE.Vector3();
const _vb = new THREE.Vector3();
const _vc = new THREE.Vector3();
const _vd = new THREE.Vector3();
const _ve = new THREE.Vector3();
const _vf = new THREE.Vector3();
const _vg = new THREE.Vector3();
const _Z = new THREE.Vector3(0, 0, 1);
const _DOWN = new THREE.Vector3(0, -1, 0);

function rand(a, b) { return a + Math.random() * (b - a); }
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

// Deterministic PRNG for texture generation (keeps textures identical run to run).
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Procedural sprite textures (the 4 shared ones)
// ---------------------------------------------------------------------------
function makeCanvas(size) {
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  return c;
}

// 1) Spark dot — hot white core, warm falloff. Used by the point systems.
function makeSparkTexture() {
  const s = 64;
  const c = makeCanvas(s);
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0.0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,246,228,0.95)');
  g.addColorStop(0.55, 'rgba(255,214,158,0.38)');
  g.addColorStop(1.0, 'rgba(255,186,110,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(c);
  return tex;
}

// 2) Soft puff — lumpy smoke blob with a near-solid plateau core so stacked
//    billboards genuinely block vision.
function makePuffTexture() {
  const s = 128;
  const c = makeCanvas(s);
  const ctx = c.getContext('2d');
  const rng = mulberry32(1337);
  // Base body with a solid-ish plateau.
  let g = ctx.createRadialGradient(s / 2, s / 2, s * 0.05, s / 2, s / 2, s * 0.5);
  g.addColorStop(0.0, 'rgba(255,255,255,0.98)');
  g.addColorStop(0.34, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.62, 'rgba(255,255,255,0.5)');
  g.addColorStop(0.86, 'rgba(255,255,255,0.14)');
  g.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  // Lumps for a rolling, cauliflower edge.
  for (let i = 0; i < 14; i++) {
    const ang = rng() * Math.PI * 2;
    const rad = rng() * s * 0.26;
    const x = s / 2 + Math.cos(ang) * rad;
    const y = s / 2 + Math.sin(ang) * rad;
    const r = s * (0.09 + rng() * 0.13);
    g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const a = 0.1 + rng() * 0.18;
    g.addColorStop(0, 'rgba(255,255,255,' + a.toFixed(3) + ')');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 3) Star flash — bright core plus tapered spikes; used for muzzle flashes,
//    fireball cores, flashbang pop, bomb glow.
function makeFlashTexture() {
  const s = 128;
  const c = makeCanvas(s);
  const ctx = c.getContext('2d');
  const rng = mulberry32(90210);
  const cx = s / 2, cy = s / 2;
  // Warm outer halo.
  let g = ctx.createRadialGradient(cx, cy, 0, cx, cy, s * 0.5);
  g.addColorStop(0, 'rgba(255,236,200,0.55)');
  g.addColorStop(0.5, 'rgba(255,196,120,0.16)');
  g.addColorStop(1, 'rgba(255,170,90,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  // Spikes.
  const spikes = 6;
  for (let i = 0; i < spikes; i++) {
    const ang = (i / spikes) * Math.PI * 2 + rng() * 0.5;
    const len = s * (0.34 + rng() * 0.15);
    const w = s * (0.028 + rng() * 0.03);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(ang);
    const lg = ctx.createLinearGradient(0, 0, len, 0);
    lg.addColorStop(0, 'rgba(255,252,240,0.95)');
    lg.addColorStop(0.4, 'rgba(255,230,180,0.55)');
    lg.addColorStop(1, 'rgba(255,200,120,0)');
    ctx.fillStyle = lg;
    ctx.beginPath();
    ctx.moveTo(0, -w);
    ctx.lineTo(len, 0);
    ctx.lineTo(0, w);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  // Hot core on top.
  g = ctx.createRadialGradient(cx, cy, 0, cx, cy, s * 0.16);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.55, 'rgba(255,248,225,0.85)');
  g.addColorStop(1, 'rgba(255,235,190,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 4) Bullet hole — dark pit, chipped gray rim, hairline cracks.
function makeHoleTexture() {
  const s = 64;
  const c = makeCanvas(s);
  const ctx = c.getContext('2d');
  const rng = mulberry32(4242);
  const cx = s / 2, cy = s / 2;
  // Soft dark blast smudge.
  let g = ctx.createRadialGradient(cx, cy, 2, cx, cy, s * 0.48);
  g.addColorStop(0, 'rgba(22,19,16,0.95)');
  g.addColorStop(0.42, 'rgba(28,24,20,0.55)');
  g.addColorStop(0.75, 'rgba(34,30,26,0.2)');
  g.addColorStop(1, 'rgba(40,36,30,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  // Cracks radiating out.
  ctx.strokeStyle = 'rgba(16,13,11,0.6)';
  ctx.lineWidth = 1.2;
  for (let i = 0; i < 5; i++) {
    const ang = rng() * Math.PI * 2;
    const len = s * (0.18 + rng() * 0.16);
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(ang) * 4, cy + Math.sin(ang) * 4);
    const midA = ang + (rng() - 0.5) * 0.7;
    ctx.lineTo(cx + Math.cos(midA) * len * 0.6, cy + Math.sin(midA) * len * 0.6);
    ctx.lineTo(cx + Math.cos(ang) * len, cy + Math.sin(ang) * len);
    ctx.stroke();
  }
  // Chipped bright rim flecks (catch light like fresh chips).
  ctx.strokeStyle = 'rgba(168,156,140,0.55)';
  ctx.lineWidth = 1.4;
  for (let i = 0; i < 8; i++) {
    const ang = rng() * Math.PI * 2;
    const r = s * (0.13 + rng() * 0.09);
    ctx.beginPath();
    ctx.arc(cx, cy, r, ang, ang + 0.35 + rng() * 0.5);
    ctx.stroke();
  }
  // Deep black core.
  g = ctx.createRadialGradient(cx, cy, 0, cx, cy, s * 0.17);
  g.addColorStop(0, 'rgba(0,0,0,1)');
  g.addColorStop(0.7, 'rgba(6,5,4,0.9)');
  g.addColorStop(1, 'rgba(10,8,7,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------------------
// GPU point-particle pool. One THREE.Points per pool; per-particle size/color/
// alpha via custom attributes. drawRange trims to alive count.
// ---------------------------------------------------------------------------
function buildPointsMaterial(texture, blending) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTex: { value: texture },
      uScale: { value: 400 },
    },
    vertexShader: [
      'attribute float aSize;',
      'attribute vec4 aColor;',
      'uniform float uScale;',
      'varying vec4 vColor;',
      'void main() {',
      '  vColor = aColor;',
      '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
      '  gl_PointSize = aSize * uScale / max(0.1, -mv.z);',
      '  gl_Position = projectionMatrix * mv;',
      '}',
    ].join('\n'),
    fragmentShader: [
      'uniform sampler2D uTex;',
      'varying vec4 vColor;',
      'void main() {',
      '  vec4 t = texture2D(uTex, gl_PointCoord);',
      '  float a = t.a * vColor.a;',
      '  if (a < 0.004) discard;',
      '  gl_FragColor = vec4(vColor.rgb * t.rgb, a);',
      '}',
    ].join('\n'),
    blending: blending,
    depthWrite: false,
    depthTest: true,
    transparent: true,
  });
}

class PointPool {
  constructor(parent, texture, capacity, blending, fadePow) {
    this.cap = capacity;
    this.count = 0;
    this.fadePow = fadePow;
    this._steal = 0;
    this._lastN = 0;

    this.posArr = new Float32Array(capacity * 3);
    this.colArr = new Float32Array(capacity * 4);
    this.sizeArr = new Float32Array(capacity);
    this.vel = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.size0 = new Float32Array(capacity);
    this.grow = new Float32Array(capacity);
    this.alpha0 = new Float32Array(capacity);
    this.grav = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);

    this.geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.posArr, 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(this.colArr, 4).setUsage(THREE.DynamicDrawUsage);
    this.sizeAttr = new THREE.BufferAttribute(this.sizeArr, 1).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', this.posAttr);
    this.geo.setAttribute('aColor', this.colAttr);
    this.geo.setAttribute('aSize', this.sizeAttr);
    this.geo.setDrawRange(0, 0);

    this.material = buildPointsMaterial(texture, blending);
    this.points = new THREE.Points(this.geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
    parent.add(this.points);
  }

  spawn(px, py, pz, vx, vy, vz, life, size, r, g, b, alpha, gravity, drag, grow) {
    let i;
    if (this.count < this.cap) i = this.count++;
    else { i = this._steal % this.cap; this._steal++; }
    const i3 = i * 3, i4 = i * 4;
    this.posArr[i3] = px; this.posArr[i3 + 1] = py; this.posArr[i3 + 2] = pz;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.colArr[i4] = r; this.colArr[i4 + 1] = g; this.colArr[i4 + 2] = b; this.colArr[i4 + 3] = alpha;
    this.sizeArr[i] = size;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size0[i] = size;
    this.grow[i] = grow;
    this.alpha0[i] = alpha;
    this.grav[i] = gravity;
    this.drag[i] = drag;
  }

  _move(src, dst) {
    const s3 = src * 3, d3 = dst * 3, s4 = src * 4, d4 = dst * 4;
    this.posArr[d3] = this.posArr[s3];
    this.posArr[d3 + 1] = this.posArr[s3 + 1];
    this.posArr[d3 + 2] = this.posArr[s3 + 2];
    this.vel[d3] = this.vel[s3];
    this.vel[d3 + 1] = this.vel[s3 + 1];
    this.vel[d3 + 2] = this.vel[s3 + 2];
    this.colArr[d4] = this.colArr[s4];
    this.colArr[d4 + 1] = this.colArr[s4 + 1];
    this.colArr[d4 + 2] = this.colArr[s4 + 2];
    this.colArr[d4 + 3] = this.colArr[s4 + 3];
    this.sizeArr[dst] = this.sizeArr[src];
    this.life[dst] = this.life[src];
    this.maxLife[dst] = this.maxLife[src];
    this.size0[dst] = this.size0[src];
    this.grow[dst] = this.grow[src];
    this.alpha0[dst] = this.alpha0[src];
    this.grav[dst] = this.grav[src];
    this.drag[dst] = this.drag[src];
  }

  update(dt) {
    let n = this.count;
    if (n === 0 && this._lastN === 0) return;
    const pos = this.posArr, col = this.colArr, sz = this.sizeArr;
    for (let i = 0; i < n; i++) {
      const life = this.life[i] - dt;
      if (life <= 0) {
        n--;
        if (i !== n) this._move(n, i);
        i--;
        continue;
      }
      this.life[i] = life;
      const i3 = i * 3;
      let vx = this.vel[i3], vy = this.vel[i3 + 1], vz = this.vel[i3 + 2];
      vy -= this.grav[i] * dt;
      const dr = Math.max(0, 1 - this.drag[i] * dt);
      vx *= dr; vy *= dr; vz *= dr;
      this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
      pos[i3] += vx * dt; pos[i3 + 1] += vy * dt; pos[i3 + 2] += vz * dt;
      const t = 1 - life / this.maxLife[i];
      col[i * 4 + 3] = this.alpha0[i] * Math.pow(1 - t, this.fadePow);
      sz[i] = this.size0[i] * (1 + this.grow[i] * t);
    }
    this.count = n;
    this.geo.setDrawRange(0, n);
    if (n > 0 || this._lastN > 0) {
      this.posAttr.needsUpdate = true;
      this.colAttr.needsUpdate = true;
      this.sizeAttr.needsUpdate = true;
    }
    this._lastN = n;
  }

  clear() {
    this.count = 0;
    this._steal = 0;
    this.geo.setDrawRange(0, 0);
    this._lastN = 0;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const DECAL_MAX = 80;
const TRACER_MAX = 32;
const SHELL_MAX = 24;
const STREAK_MAX = 32;
const BURST_MAX = 20;
const PUFF_MAX = 56;
const SHELL_PENDING_MAX = 8;

// Light pool layout (fixed — lights never enter/leave the scene, so the
// renderer never recompiles materials mid-firefight).
const L_MUZZLE_PLAYER = 0;
const L_MUZZLE_BOT = 1;
const L_EXPLO_A = 2;
const L_EXPLO_B = 3;
const L_FLASHBANG = 4;

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------
export default class Effects {
  constructor(game) {
    this.game = game;

    this.root = new THREE.Group();
    this.root.name = 'effects';
    if (game.scene) game.scene.add(this.root);

    // --- the 4 shared procedural textures --------------------------------
    this.texSpark = makeSparkTexture();
    this.texPuff = makePuffTexture();
    this.texFlash = makeFlashTexture();
    this.texHole = makeHoleTexture();

    // --- point-particle systems ------------------------------------------
    // Additive hot sparks (metal hits, muzzle spits, explosions).
    this.sparks = new PointPool(this.root, this.texSpark, 256, THREE.AdditiveBlending, 1.1);
    // Hard debris bits (concrete chunks, wood chips, blood drops).
    this.bits = new PointPool(this.root, this.texSpark, 256, THREE.NormalBlending, 1.4);
    // Soft dust puffs (impact dust, blood mist, muzzle wisps, ground dust).
    this.puffs = new PointPool(this.root, this.texPuff, 192, THREE.NormalBlending, 1.6);

    // --- spark streak meshes ---------------------------------------------
    this.streaks = [];
    this._streakIdx = 0;
    {
      const geo = new THREE.BoxGeometry(1, 1, 1);
      this._streakGeo = geo;
      for (let i = 0; i < STREAK_MAX; i++) {
        const mat = new THREE.MeshBasicMaterial({
          color: 0xffc873,
          blending: THREE.AdditiveBlending,
          transparent: true,
          depthWrite: false,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.visible = false;
        mesh.frustumCulled = false;
        this.root.add(mesh);
        this.streaks.push({
          mesh, mat,
          vel: new THREE.Vector3(),
          t: 0, life: 0, w: 0.03,
          active: false,
        });
      }
    }

    // --- tracers ----------------------------------------------------------
    this.tracers = [];
    this._tracerIdx = 0;
    {
      const geo = new THREE.BoxGeometry(1, 1, 1);
      this._tracerGeo = geo;
      for (let i = 0; i < TRACER_MAX; i++) {
        const mat = new THREE.MeshBasicMaterial({
          color: 0xffd9a0,
          blending: THREE.AdditiveBlending,
          transparent: true,
          depthWrite: false,
          opacity: 0.9,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.visible = false;
        mesh.frustumCulled = false;
        this.root.add(mesh);
        this.tracers.push({
          mesh, mat,
          from: new THREE.Vector3(),
          dir: new THREE.Vector3(),
          dist: 0, head: 0, speed: 0, tail: 6,
          t: 0, fading: false, fade: 0, w: 0.016, baseA: 0.85,
          active: false,
        });
      }
    }

    // --- brass shells -----------------------------------------------------
    this.shells = [];
    this._shellIdx = 0;
    {
      const geo = new THREE.BoxGeometry(0.026, 0.011, 0.011);
      this._shellGeo = geo;
      for (let i = 0; i < SHELL_MAX; i++) {
        const mat = new THREE.MeshStandardMaterial({
          color: 0xc09032,
          metalness: 0.75,
          roughness: 0.35,
          transparent: true,
          opacity: 1,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.visible = false;
        mesh.frustumCulled = false;
        this.root.add(mesh);
        this.shells.push({
          mesh, mat,
          vel: new THREE.Vector3(),
          ang: new THREE.Vector3(),
          t: 0, floorY: 0, bounces: 0, resting: false,
          active: false,
        });
      }
    }
    // Delayed shell ejects (AWP ejects after the bolt cycle).
    this._shellPending = new Float32Array(SHELL_PENDING_MAX);
    this._shellPendingN = 0;

    // --- burst sprites (flashes, fireballs) ------------------------------
    this.bursts = [];
    this._burstIdx = 0;
    for (let i = 0; i < BURST_MAX; i++) {
      const mat = new THREE.SpriteMaterial({
        map: this.texFlash,
        color: 0xffffff,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
        opacity: 0,
      });
      const spr = new THREE.Sprite(mat);
      spr.visible = false;
      spr.renderOrder = 8;
      this.root.add(spr);
      this.bursts.push({
        sprite: spr, mat,
        t: 0, life: 0, size0: 0.2, size1: 0.4, alpha0: 1, vy: 0, expo: 1.7, rotSpeed: 0,
        active: false,
      });
    }

    // --- big billboard puffs (smoke grenade clusters + explosion smoke) --
    this.puffSprites = [];
    this._puffIdx = 0;
    for (let i = 0; i < PUFF_MAX; i++) {
      const mat = new THREE.SpriteMaterial({
        map: this.texPuff,
        color: 0xffffff,
        transparent: true,
        depthWrite: false,
        opacity: 0,
      });
      const spr = new THREE.Sprite(mat);
      spr.visible = false;
      spr.renderOrder = 7;
      this.root.add(spr);
      this.puffSprites.push({
        sprite: spr, mat,
        t: 0, life: 0,
        cx: 0, cy: 0, cz: 0,
        orbitR: 0, angle: 0, angSpeed: 0,
        h: 0, rise: 0, riseCap: 999,
        size0: 1, size1: 1,
        fadeIn: 0.1, fadeOut: 0.5, alphaMax: 1,
        spin: 0,
        active: false,
      });
    }

    // --- decals: one merged 80-quad FIFO mesh ----------------------------
    this._decalIdx = 0;
    this._decalCount = 0;
    {
      const geo = new THREE.BufferGeometry();
      this._decalPos = new Float32Array(DECAL_MAX * 4 * 3);
      this._decalCol = new Float32Array(DECAL_MAX * 4 * 3);
      const uvs = new Float32Array(DECAL_MAX * 4 * 2);
      const idx = new Uint16Array(DECAL_MAX * 6);
      for (let i = 0; i < DECAL_MAX; i++) {
        const u = i * 8;
        uvs[u] = 0; uvs[u + 1] = 0;
        uvs[u + 2] = 1; uvs[u + 3] = 0;
        uvs[u + 4] = 1; uvs[u + 5] = 1;
        uvs[u + 6] = 0; uvs[u + 7] = 1;
        const t = i * 6, v = i * 4;
        idx[t] = v; idx[t + 1] = v + 1; idx[t + 2] = v + 2;
        idx[t + 3] = v; idx[t + 4] = v + 2; idx[t + 5] = v + 3;
      }
      this._decalPosAttr = new THREE.BufferAttribute(this._decalPos, 3).setUsage(THREE.DynamicDrawUsage);
      this._decalColAttr = new THREE.BufferAttribute(this._decalCol, 3).setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('position', this._decalPosAttr);
      geo.setAttribute('color', this._decalColAttr);
      geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      geo.setDrawRange(0, 0);
      const mat = new THREE.MeshBasicMaterial({
        map: this.texHole,
        transparent: true,
        depthWrite: false,
        vertexColors: true,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      this.decalMesh = new THREE.Mesh(geo, mat);
      this.decalMesh.frustumCulled = false;
      this.decalMesh.renderOrder = 2;
      this._decalGeo = geo;
      this.root.add(this.decalMesh);
    }

    // --- fixed light pool -------------------------------------------------
    // [player muzzle, bot muzzle, explosion A, explosion B, flashbang]
    this.lights = [];
    const lightDefs = [
      { color: 0xffc27a, dist: 11 },  // player muzzle
      { color: 0xffc27a, dist: 10 },  // bot muzzle (round-robin)
      { color: 0xff9a4a, dist: 30 },  // explosion A
      { color: 0xff9a4a, dist: 30 },  // explosion B
      { color: 0xffffff, dist: 24 },  // flashbang
    ];
    for (let i = 0; i < lightDefs.length; i++) {
      const d = lightDefs[i];
      const light = new THREE.PointLight(d.color, 0, d.dist, 2);
      light.castShadow = false;
      this.root.add(light);
      this.lights.push({ light, t: 1, life: 1, peak: 0, expo: 1 });
    }
    this._exploLightFlip = 0;

    // --- bomb light + glow sprite ----------------------------------------
    this.bombLight = new THREE.PointLight(0xff2a1a, 0, 11, 2);
    this.bombLight.castShadow = false;
    this.root.add(this.bombLight);
    this._bombBeat = 0;
    {
      const mat = new THREE.SpriteMaterial({
        map: this.texFlash,
        color: 0xff3524,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
        opacity: 0,
      });
      this.bombGlow = new THREE.Sprite(mat);
      this.bombGlow.visible = false;
      this.bombGlow.renderOrder = 8;
      this.root.add(this.bombGlow);
    }

    // --- pending work queued from events, resolved in update() -----------
    // (player muzzle flashes wait so the viewmodel has copied this frame's
    //  camera transform before we sample the muzzle world position)
    this._pendingPlayerFlash = 0;

    // --- event wiring -----------------------------------------------------
    const ev = game.events;
    if (ev) {
      ev.on('weapon:fire', (p) => this._onWeaponFire(p));
      ev.on('bot:fire', (p) => this._onBotFire(p));
      ev.on('fx:tracer', (p) => this._onTracer(p));
      ev.on('fx:impact', (p) => this._onImpact(p));
      ev.on('fx:blood', (p) => this._onBlood(p));
      ev.on('fx:explosion', (p) => this._onExplosion(p));
      ev.on('fx:flash', (p) => this._onFlash(p));
      ev.on('fx:smoke', (p) => this._onSmoke(p));
      ev.on('round:phase', (p) => this._onRoundPhase(p));
      ev.on('bomb:detonated', () => { this.bombLight.intensity = 0; this.bombGlow.visible = false; });
      ev.on('round:start', () => this._clearAll());
    }
  }

  // =========================================================================
  // Event handlers
  // =========================================================================

  _onWeaponFire(p) {
    if (!p || p.melee || !p.byPlayer) return;
    const id = p.weaponId;
    if (id === 'knife' || id === 'hegrenade' || id === 'flashbang' || id === 'smokegrenade') return;
    this._pendingPlayerFlash = Math.min(this._pendingPlayerFlash + 1, 2);
    // Shell eject; AWP ejects after the bolt cycle.
    if (this._shellPendingN < SHELL_PENDING_MAX) {
      this._shellPending[this._shellPendingN++] = (id === 'awp') ? 0.65 : 0.02;
    }
  }

  _onBotFire(p) {
    if (!p || !p.origin) return;
    const o = p.origin, d = p.dir;
    // Push the flash out to roughly the gun tip.
    if (d) {
      _va.set(o.x + d.x * 0.5, o.y + d.y * 0.5 - 0.12, o.z + d.z * 0.5);
    } else {
      _va.set(o.x, o.y - 0.12, o.z);
    }
    this._spawnMuzzleFlash(_va, rand(0.12, 0.17), L_MUZZLE_BOT, 3);
  }

  _onTracer(p) {
    if (!p || !p.from || !p.to) return;
    _va.set(p.from.x, p.from.y, p.from.z);
    _vb.set(p.to.x, p.to.y, p.to.z);
    _vc.subVectors(_vb, _va);
    const dist = _vc.length();
    if (dist < 3) return;
    _vc.multiplyScalar(1 / dist);

    const e = this.tracers[this._tracerIdx % TRACER_MAX];
    this._tracerIdx++;
    e.active = true;
    e.from.copy(_va);
    e.dir.copy(_vc);
    e.dist = dist;
    e.head = 0;
    e.speed = dist / 0.05;                       // full path in ~50 ms
    e.tail = Math.min(7, dist * 0.55);
    e.t = 0;
    e.fading = false;
    e.fade = 0;
    e.w = (p.weaponId === 'awp') ? 0.03 : 0.016;
    e.baseA = (p.weaponId === 'awp') ? 1.0 : 0.85;
    e.mat.opacity = e.baseA;
    e.mesh.visible = true;
    e.mesh.quaternion.setFromUnitVectors(_Z, _vc);
  }

  _onImpact(p) {
    if (!p || !p.point) return;
    const surface = p.surface || 'concrete';
    const px = p.point.x, py = p.point.y, pz = p.point.z;
    let nx = 0, ny = 1, nz = 0;
    if (p.normal) { nx = p.normal.x; ny = p.normal.y; nz = p.normal.z; }

    // --- particles, tuned per surface ---
    if (surface === 'metal') {
      const n = 6 + (Math.random() * 3 | 0);
      for (let i = 0; i < n; i++) {
        const sp = rand(4.5, 10);
        this.sparks.spawn(
          px, py, pz,
          nx * sp * rand(0.4, 1) + rand(-3, 3),
          ny * sp * rand(0.4, 1) + rand(-1.5, 4),
          nz * sp * rand(0.4, 1) + rand(-3, 3),
          rand(0.25, 0.5), rand(0.02, 0.045),
          1, rand(0.75, 0.9), rand(0.35, 0.55), 1,
          14, 1.5, 0
        );
      }
      this._spawnStreak(px, py, pz, nx * rand(3, 7) + rand(-2.5, 2.5), ny * rand(3, 7) + rand(0, 3), nz * rand(3, 7) + rand(-2.5, 2.5), rand(0.2, 0.35), 0.022, 0xffd27a);
      this.puffs.spawn(px, py, pz, nx * 0.5, ny * 0.5 + 0.3, nz * 0.5, 0.35, 0.1, 0.45, 0.45, 0.46, 0.3, 0.2, 2.5, 2.2);
    } else if (surface === 'wood') {
      const n = 6 + (Math.random() * 3 | 0);
      for (let i = 0; i < n; i++) {
        const sp = rand(1.5, 4.5);
        const shade = rand(0.7, 1.1);
        this.bits.spawn(
          px, py, pz,
          nx * sp + rand(-1.4, 1.4),
          ny * sp + rand(-0.4, 1.8),
          nz * sp + rand(-1.4, 1.4),
          rand(0.3, 0.5), rand(0.018, 0.038),
          0.42 * shade, 0.28 * shade, 0.15 * shade, 1,
          13, 0.8, 0
        );
      }
      this.puffs.spawn(px, py, pz, nx * 0.7, ny * 0.7 + 0.2, nz * 0.7, 0.4, 0.11, 0.55, 0.46, 0.34, 0.35, 0.4, 2.8, 2.4);
    } else if (surface === 'sand') {
      for (let i = 0; i < 3; i++) {
        this.puffs.spawn(
          px, py, pz,
          nx * rand(0.5, 1.3) + rand(-0.5, 0.5),
          ny * rand(0.5, 1.3) + rand(0, 0.5),
          nz * rand(0.5, 1.3) + rand(-0.5, 0.5),
          rand(0.4, 0.6), rand(0.12, 0.2),
          0.71, 0.62, 0.46, rand(0.4, 0.55),
          0.6, 2.6, 2.6
        );
      }
      for (let i = 0; i < 6; i++) {
        const sp = rand(1.2, 3.6);
        this.bits.spawn(
          px, py, pz,
          nx * sp + rand(-1.2, 1.2),
          ny * sp + rand(0, 1.6),
          nz * sp + rand(-1.2, 1.2),
          rand(0.3, 0.45), rand(0.014, 0.03),
          0.72, 0.62, 0.44, 1,
          12, 0.6, 0
        );
      }
    } else { // concrete (default)
      for (let i = 0; i < 2; i++) {
        this.puffs.spawn(
          px, py, pz,
          nx * rand(0.5, 1.3) + rand(-0.4, 0.4),
          ny * rand(0.5, 1.3) + rand(0, 0.4),
          nz * rand(0.5, 1.3) + rand(-0.4, 0.4),
          rand(0.35, 0.55), rand(0.11, 0.17),
          0.62, 0.58, 0.5, rand(0.4, 0.5),
          0.5, 2.8, 2.4
        );
      }
      for (let i = 0; i < 5; i++) {
        const sp = rand(1.5, 4.2);
        const shade = rand(0.75, 1.1);
        this.bits.spawn(
          px, py, pz,
          nx * sp + rand(-1.3, 1.3),
          ny * sp + rand(-0.2, 1.7),
          nz * sp + rand(-1.3, 1.3),
          rand(0.28, 0.45), rand(0.016, 0.034),
          0.45 * shade, 0.43 * shade, 0.4 * shade, 1,
          13, 0.7, 0
        );
      }
      if (Math.random() < 0.55) {
        for (let i = 0; i < 2; i++) {
          const sp = rand(3, 6.5);
          this.sparks.spawn(
            px, py, pz,
            nx * sp + rand(-2, 2), ny * sp + rand(0, 2.5), nz * sp + rand(-2, 2),
            rand(0.18, 0.32), rand(0.016, 0.03),
            1, 0.85, 0.5, 1,
            13, 1.5, 0
          );
        }
      }
    }

    // --- bullet-hole decal ---
    _va.set(px, py, pz);
    _vb.set(nx, ny, nz);
    if (surface === 'wood') this._placeDecal(_va, _vb, rand(0.05, 0.075), 0.75, 0.6, 0.45);
    else if (surface === 'metal') this._placeDecal(_va, _vb, rand(0.045, 0.065), 1, 1, 1);
    else if (surface === 'sand') this._placeDecal(_va, _vb, rand(0.09, 0.13), 0.85, 0.76, 0.6);
    else this._placeDecal(_va, _vb, rand(0.055, 0.08), 0.92, 0.9, 0.86);
  }

  _onBlood(p) {
    if (!p || !p.point) return;
    const px = p.point.x, py = p.point.y, pz = p.point.z;
    let dx = 0, dy = 0, dz = 1;
    if (p.dir) { dx = p.dir.x; dy = p.dir.y; dz = p.dir.z; }
    const n = 8 + (Math.random() * 5 | 0);
    for (let i = 0; i < n; i++) {
      const sp = rand(1, 3.2);
      const shade = rand(0.7, 1.15);
      this.bits.spawn(
        px, py, pz,
        dx * sp + rand(-1.5, 1.5),
        dy * sp + rand(-0.4, 1.6),
        dz * sp + rand(-1.5, 1.5),
        rand(0.35, 0.55), rand(0.02, 0.048),
        0.48 * shade, 0.035 * shade, 0.035 * shade, 1,
        14, 0.8, 0
      );
    }
    // A little dark mist that hangs for a beat.
    for (let i = 0; i < 2; i++) {
      this.puffs.spawn(
        px, py, pz,
        dx * 0.8 + rand(-0.4, 0.4), 0.25 + rand(0, 0.4), dz * 0.8 + rand(-0.4, 0.4),
        rand(0.3, 0.42), rand(0.09, 0.14),
        0.34, 0.02, 0.02, rand(0.32, 0.45),
        0.4, 2.5, 2.6
      );
    }
  }

  _onExplosion(p) {
    if (!p || !p.pos) return;
    const px = p.pos.x, py = p.pos.y, pz = p.pos.z;
    const radius = p.radius || 9;
    const rs = radius / 9; // scale factor relative to HE reference

    // --- fireball core + body ---
    _va.set(px, py + 0.3, pz);
    this._spawnBurst(_va, this.texFlash, 0xfff3cf, radius * 0.35, radius * 0.95, 0.28, 1, 0.6, 1.6, rand(-3, 3));
    this._spawnBurst(_va, this.texPuff, 0xff8c30, radius * 0.3, radius * 1.15, 0.35, 0.95, 1.2, 1.8, rand(-1.5, 1.5));
    this._spawnBurst(_va, this.texPuff, 0xffb84e, radius * 0.22, radius * 0.8, 0.3, 0.9, 1.8, 1.6, rand(-2, 2));

    // --- 20 spark streaks ---
    for (let i = 0; i < 20; i++) {
      const ang = Math.random() * Math.PI * 2;
      const up = rand(0.15, 1);
      const sp = rand(8, 19) * Math.sqrt(rs);
      this._spawnStreak(
        px, py + 0.3, pz,
        Math.cos(ang) * sp * (1 - up * 0.5),
        sp * up,
        Math.sin(ang) * sp * (1 - up * 0.5),
        rand(0.4, 0.75), rand(0.025, 0.045),
        Math.random() < 0.5 ? 0xffd27a : 0xff9a3a
      );
    }

    // --- hot point sparks ---
    for (let i = 0; i < 24; i++) {
      const ang = Math.random() * Math.PI * 2;
      const sp = rand(5, 14) * Math.sqrt(rs);
      const up = rand(-0.1, 1);
      this.sparks.spawn(
        px, py + 0.3, pz,
        Math.cos(ang) * sp, sp * up * 0.8 + 2, Math.sin(ang) * sp,
        rand(0.3, 0.65), rand(0.03, 0.06),
        1, rand(0.6, 0.85), rand(0.25, 0.45), 1,
        16, 0.8, 0
      );
    }

    // --- dark debris ---
    for (let i = 0; i < 10; i++) {
      const ang = Math.random() * Math.PI * 2;
      const sp = rand(3, 9) * Math.sqrt(rs);
      this.bits.spawn(
        px, py + 0.2, pz,
        Math.cos(ang) * sp, rand(2, 7), Math.sin(ang) * sp,
        rand(0.4, 0.8), rand(0.03, 0.06),
        0.16, 0.14, 0.12, 1,
        15, 0.4, 0
      );
    }

    // --- rising gray smoke (billboards) ---
    for (let i = 0; i < 8; i++) {
      const ang = Math.random() * Math.PI * 2;
      const r = rand(0, radius * 0.22);
      const shade = rand(0.24, 0.4);
      this._spawnPuffSprite({
        cx: px + Math.cos(ang) * r,
        cy: py + rand(0.2, 0.9),
        cz: pz + Math.sin(ang) * r,
        orbitR: 0, angle: 0, angSpeed: rand(-0.3, 0.3),
        h: 0, rise: rand(1.3, 2.2), riseCap: 999,
        size0: radius * rand(0.28, 0.4), size1: radius * rand(0.7, 0.95),
        life: rand(2.1, 2.7), fadeIn: 0.06, fadeOut: 1.3,
        alphaMax: rand(0.6, 0.78),
        r: shade, g: shade * 0.97, b: shade * 0.93,
        spin: rand(-0.35, 0.35),
      });
    }

    // --- low dust ring skimming the ground ---
    for (let i = 0; i < 6; i++) {
      const ang = (i / 6) * Math.PI * 2 + rand(-0.3, 0.3);
      const sp = rand(4, 7) * rs;
      this.puffs.spawn(
        px, py + 0.15, pz,
        Math.cos(ang) * sp, rand(0.3, 0.9), Math.sin(ang) * sp,
        rand(0.5, 0.8), radius * 0.06,
        0.58, 0.53, 0.45, 0.4,
        0.8, 2.2, 3
      );
    }

    // --- light flash: intensity 30 -> 0 over 0.3 s (scaled up for big blasts)
    const li = L_EXPLO_A + (this._exploLightFlip ^= 1);
    this._flashLight(li, px, py + 0.6, pz, 30 * rs, 0.3, 1.5, radius * 3);

    // --- scorch mark on the ground ---
    const world = this.game.world;
    if (world && typeof world.raycast === 'function') {
      _va.set(px, py + 0.6, pz);
      const hit = world.raycast(_va, _DOWN, 5);
      if (hit && hit.point) {
        _vb.set(hit.point.x, hit.point.y, hit.point.z);
        _vc.set(0, 1, 0);
        this._placeDecal(_vb, _vc, clamp(radius * 0.16, 0.6, 1.9), 0.32, 0.28, 0.25);
      }
    }

    // --- camera shake ---
    const player = this.game.player;
    if (player && typeof player.addShake === 'function' && player.position) {
      _va.set(px, py, pz);
      const d = _vb.copy(player.position).sub(_va).length();
      const strength = clamp(1 - d / (radius * 2.2), 0, 1) * 1.8 * Math.sqrt(rs);
      if (strength > 0.02) player.addShake(strength);
    }
  }

  _onFlash(p) {
    if (!p || !p.pos) return;
    const px = p.pos.x, py = p.pos.y, pz = p.pos.z;
    this._flashLight(L_FLASHBANG, px, py + 0.2, pz, 26, 0.3, 1.2, 24);
    _va.set(px, py + 0.2, pz);
    this._spawnBurst(_va, this.texFlash, 0xffffff, 0.8, 3.2, 0.18, 1, 0, 1.4, rand(-4, 4));
    for (let i = 0; i < 8; i++) {
      const ang = Math.random() * Math.PI * 2;
      const sp = rand(3, 8);
      this.sparks.spawn(
        px, py + 0.2, pz,
        Math.cos(ang) * sp, rand(1, 5), Math.sin(ang) * sp,
        rand(0.15, 0.35), rand(0.02, 0.04),
        1, 1, 1, 1,
        10, 1.5, 0
      );
    }
  }

  _onSmoke(p) {
    if (!p || !p.pos) return;
    const px = p.pos.x, py = p.pos.y, pz = p.pos.z;
    const dur = (typeof p.duration === 'number' && p.duration > 0) ? p.duration : 15;

    // Pop puff + hiss particles.
    for (let i = 0; i < 5; i++) {
      const ang = Math.random() * Math.PI * 2;
      this.puffs.spawn(
        px, py + 0.2, pz,
        Math.cos(ang) * rand(1, 2.5), rand(1, 2.6), Math.sin(ang) * rand(1, 2.5),
        rand(0.4, 0.7), rand(0.15, 0.25),
        0.8, 0.8, 0.78, 0.5,
        0.5, 2, 2.5
      );
    }

    // The vision-blocking cluster: outer ring + dense core + cap. Slow swirl,
    // slight rise, fade in 0.6 s / out over the last 2 s.
    // Outer ring (8).
    for (let i = 0; i < 8; i++) {
      const ang = (i / 8) * Math.PI * 2 + rand(-0.35, 0.35);
      const shade = rand(0.66, 0.8);
      this._spawnPuffSprite({
        cx: px, cy: py, cz: pz,
        orbitR: rand(1.35, 1.8), angle: ang,
        angSpeed: rand(0.06, 0.18) * (i % 2 === 0 ? 1 : -1),
        h: rand(0.5, 1.9), rise: 0.12, riseCap: 3,
        size0: rand(2.7, 3.5), size1: rand(3.1, 3.9),
        life: dur, fadeIn: 0.6, fadeOut: 2,
        alphaMax: rand(0.84, 0.9),
        r: shade, g: shade * 0.985, b: shade * 0.955,
        spin: rand(0.04, 0.12) * (Math.random() < 0.5 ? 1 : -1),
      });
    }
    // Dense core (4) — near-opaque.
    for (let i = 0; i < 4; i++) {
      const ang = (i / 4) * Math.PI * 2 + rand(-0.5, 0.5);
      const shade = rand(0.7, 0.82);
      this._spawnPuffSprite({
        cx: px, cy: py, cz: pz,
        orbitR: rand(0.35, 0.7), angle: ang,
        angSpeed: rand(0.05, 0.14) * (i % 2 === 0 ? -1 : 1),
        h: rand(0.8, 1.7), rise: 0.1, riseCap: 3,
        size0: rand(2.5, 3.1), size1: rand(2.9, 3.5),
        life: dur, fadeIn: 0.55, fadeOut: 2,
        alphaMax: rand(0.94, 0.98),
        r: shade, g: shade * 0.985, b: shade * 0.955,
        spin: rand(0.03, 0.1) * (Math.random() < 0.5 ? 1 : -1),
      });
    }
    // Cap on top.
    {
      const shade = rand(0.7, 0.8);
      this._spawnPuffSprite({
        cx: px, cy: py, cz: pz,
        orbitR: 0.3, angle: rand(0, Math.PI * 2),
        angSpeed: rand(-0.1, 0.1),
        h: 2.35, rise: 0.1, riseCap: 3,
        size0: 2.9, size1: 3.3,
        life: dur, fadeIn: 0.7, fadeOut: 2,
        alphaMax: 0.9,
        r: shade, g: shade * 0.985, b: shade * 0.955,
        spin: rand(-0.08, 0.08),
      });
    }
  }

  _onRoundPhase(p) {
    if (p && p.phase === 'planted') {
      this._bombBeat = 0;
    }
  }

  // =========================================================================
  // Spawner helpers (all reuse pool slots + scratch vectors; no allocation)
  // =========================================================================

  _spawnMuzzleFlash(pos, scale, lightIdx, peak) {
    const b = this._spawnBurst(pos, this.texFlash, 0xffe6b3, scale * 0.75, scale * 1.6, 0.045, 0.95, 0, 1.2, 0);
    if (b) b.mat.rotation = Math.random() * Math.PI * 2;
    this._flashLight(lightIdx, pos.x, pos.y, pos.z, peak, 0.06, 1, 0);
    // A couple of hot spits out of the barrel.
    for (let i = 0; i < 2; i++) {
      this.sparks.spawn(
        pos.x, pos.y, pos.z,
        rand(-2, 2), rand(-0.5, 1.5), rand(-2, 2),
        rand(0.08, 0.16), rand(0.012, 0.024),
        1, 0.85, 0.55, 1,
        8, 2, 0
      );
    }
  }

  _spawnBurst(pos, tex, colorHex, size0, size1, life, alpha, vy, expo, rotSpeed) {
    const e = this.bursts[this._burstIdx % BURST_MAX];
    this._burstIdx++;
    e.active = true;
    e.t = 0;
    e.life = life;
    e.size0 = size0;
    e.size1 = size1;
    e.alpha0 = alpha;
    e.vy = vy;
    e.expo = expo;
    e.rotSpeed = rotSpeed;
    if (e.mat.map !== tex) e.mat.map = tex;
    e.mat.color.setHex(colorHex);
    e.mat.opacity = alpha;
    e.sprite.position.copy(pos);
    e.sprite.scale.set(size0, size0, 1);
    e.sprite.visible = true;
    return e;
  }

  _spawnStreak(px, py, pz, vx, vy, vz, life, w, colorHex) {
    const e = this.streaks[this._streakIdx % STREAK_MAX];
    this._streakIdx++;
    e.active = true;
    e.t = 0;
    e.life = life;
    e.w = w;
    e.vel.set(vx, vy, vz);
    e.mat.color.setHex(colorHex);
    e.mat.opacity = 1;
    e.mesh.position.set(px, py, pz);
    e.mesh.visible = true;
  }

  _spawnPuffSprite(o) {
    const e = this.puffSprites[this._puffIdx % PUFF_MAX];
    this._puffIdx++;
    e.active = true;
    e.t = 0;
    e.life = o.life;
    e.cx = o.cx; e.cy = o.cy; e.cz = o.cz;
    e.orbitR = o.orbitR; e.angle = o.angle; e.angSpeed = o.angSpeed;
    e.h = o.h; e.rise = o.rise; e.riseCap = o.riseCap;
    e.size0 = o.size0; e.size1 = o.size1;
    e.fadeIn = o.fadeIn; e.fadeOut = o.fadeOut; e.alphaMax = o.alphaMax;
    e.spin = o.spin;
    e.mat.color.setRGB(o.r, o.g, o.b);
    e.mat.opacity = 0;
    e.mat.rotation = Math.random() * Math.PI * 2;
    e.sprite.scale.set(o.size0, o.size0, 1);
    e.sprite.position.set(o.cx + Math.cos(o.angle) * o.orbitR, o.cy + o.h, o.cz + Math.sin(o.angle) * o.orbitR);
    e.sprite.visible = true;
  }

  _flashLight(idx, x, y, z, peak, life, expo, dist) {
    const e = this.lights[idx];
    e.t = 0;
    e.life = life;
    e.peak = peak;
    e.expo = expo;
    e.light.position.set(x, y, z);
    if (dist > 0) e.light.distance = dist;
    e.light.intensity = peak;
  }

  _spawnShell() {
    const g = this.game;
    if (g.weapons && typeof g.weapons.isScoped === 'function' && g.weapons.isScoped()) return;
    const cam = g.camera;
    if (!cam) return;

    // Eject from the muzzle area, kicked right + up in camera space.
    this._getMuzzlePos(_va);
    _vb.set(1, 0, 0).applyQuaternion(cam.quaternion);   // right
    _vc.set(0, 1, 0).applyQuaternion(cam.quaternion);   // up
    _vd.set(0, 0, -1).applyQuaternion(cam.quaternion);  // forward
    _va.addScaledVector(_vd, -0.12).addScaledVector(_vb, 0.03);

    const e = this.shells[this._shellIdx % SHELL_MAX];
    this._shellIdx++;
    e.active = true;
    e.resting = false;
    e.bounces = 0;
    e.t = 0;
    e.mat.opacity = 1;
    e.mesh.position.copy(_va);
    e.mesh.rotation.set(rand(0, Math.PI), rand(0, Math.PI), rand(0, Math.PI));
    e.vel.set(0, 0, 0)
      .addScaledVector(_vb, rand(1.5, 2.6))
      .addScaledVector(_vc, rand(1.5, 2.4))
      .addScaledVector(_vd, rand(-0.3, 0.2));
    e.ang.set(rand(-14, 14), rand(-14, 14), rand(-14, 14));
    e.mesh.visible = true;

    // One raycast at spawn to find the floor it will land on.
    const world = g.world;
    e.floorY = _va.y - 1.7;
    if (world && typeof world.raycast === 'function') {
      const hit = world.raycast(_va, _DOWN, 6);
      if (hit && hit.point) e.floorY = hit.point.y;
    }
  }

  _getMuzzlePos(out) {
    const g = this.game;
    const vm = g.viewmodel;
    if (vm && typeof vm.getMuzzleWorldPos === 'function') {
      const r = vm.getMuzzleWorldPos(out);
      if (r && r.isVector3 && r !== out) out.copy(r);
      return out;
    }
    const cam = g.camera;
    if (cam) {
      _vg.set(0, 0, -1).applyQuaternion(cam.quaternion);
      out.copy(cam.position).addScaledVector(_vg, 0.4);
      _vg.set(1, 0, 0).applyQuaternion(cam.quaternion);
      out.addScaledVector(_vg, 0.12);
      out.y -= 0.06;
    } else {
      out.set(0, 0, 0);
    }
    return out;
  }

  _placeDecal(p, n, size, r, g, b) {
    const i = this._decalIdx % DECAL_MAX;
    this._decalIdx++;
    this._decalCount = Math.min(this._decalCount + 1, DECAL_MAX);

    _vd.set(n.x, n.y, n.z);
    const len = _vd.length();
    if (len < 1e-5) _vd.set(0, 1, 0); else _vd.multiplyScalar(1 / len);
    // Tangent basis.
    if (Math.abs(_vd.y) > 0.92) _ve.set(1, 0, 0); else _ve.set(0, 1, 0);
    _vf.crossVectors(_vd, _ve).normalize();
    _ve.crossVectors(_vf, _vd);
    // Random roll around the normal.
    const a = Math.random() * Math.PI * 2;
    const c = Math.cos(a) * size, s = Math.sin(a) * size;
    // e1 = t1*c + t2*s ; e2 = -t1*s + t2*c
    _vg.copy(_ve).multiplyScalar(c).addScaledVector(_vf, s);   // e1
    _ve.multiplyScalar(-s).addScaledVector(_vf, c);            // e2 (in place)
    // Base point pushed off the surface.
    _vf.copy(p).addScaledVector(_vd, 0.012);

    const pa = this._decalPos, ca = this._decalCol;
    const o = i * 12;
    // corner 0: base - e1 - e2
    pa[o] = _vf.x - _vg.x - _ve.x; pa[o + 1] = _vf.y - _vg.y - _ve.y; pa[o + 2] = _vf.z - _vg.z - _ve.z;
    // corner 1: base + e1 - e2
    pa[o + 3] = _vf.x + _vg.x - _ve.x; pa[o + 4] = _vf.y + _vg.y - _ve.y; pa[o + 5] = _vf.z + _vg.z - _ve.z;
    // corner 2: base + e1 + e2
    pa[o + 6] = _vf.x + _vg.x + _ve.x; pa[o + 7] = _vf.y + _vg.y + _ve.y; pa[o + 8] = _vf.z + _vg.z + _ve.z;
    // corner 3: base - e1 + e2
    pa[o + 9] = _vf.x - _vg.x + _ve.x; pa[o + 10] = _vf.y - _vg.y + _ve.y; pa[o + 11] = _vf.z - _vg.z + _ve.z;
    for (let k = 0; k < 4; k++) {
      ca[o + k * 3] = r; ca[o + k * 3 + 1] = g; ca[o + k * 3 + 2] = b;
    }
    this._decalPosAttr.needsUpdate = true;
    this._decalColAttr.needsUpdate = true;
    this._decalGeo.setDrawRange(0, this._decalCount * 6);
  }

  // =========================================================================
  // Per-frame update — advances every pool; zero allocations.
  // =========================================================================
  update(dt) {
    if (!(dt > 0)) return;
    const g = this.game;

    // Keep point sizes correct across resolutions / zoom (AWP changes fov).
    if (g.renderer && g.camera) {
      const h = g.renderer.domElement.height || 800;
      const uScale = h * 0.5 * g.camera.projectionMatrix.elements[5];
      this.sparks.material.uniforms.uScale.value = uScale;
      this.bits.material.uniforms.uScale.value = uScale;
      this.puffs.material.uniforms.uScale.value = uScale;
    }

    // ---- pending player muzzle flashes (viewmodel has updated by now) ----
    while (this._pendingPlayerFlash > 0) {
      this._pendingPlayerFlash--;
      const scoped = g.weapons && typeof g.weapons.isScoped === 'function' && g.weapons.isScoped();
      if (!scoped) {
        this._getMuzzlePos(_va);
        this._spawnMuzzleFlash(_va, rand(0.15, 0.22), L_MUZZLE_PLAYER, 4);
        // Faint smoke wisp curling off the barrel.
        this.puffs.spawn(
          _va.x, _va.y, _va.z,
          rand(-0.15, 0.15), rand(0.3, 0.55), rand(-0.15, 0.15),
          rand(0.35, 0.55), 0.045,
          0.62, 0.6, 0.56, 0.14,
          -0.2, 1.5, 4
        );
      } else {
        // Scoped shots still throw light even if the model is hidden.
        this._getMuzzlePos(_va);
        this._flashLight(L_MUZZLE_PLAYER, _va.x, _va.y, _va.z, 4, 0.06, 1, 0);
      }
    }

    // ---- delayed shell ejects ----
    for (let i = 0; i < this._shellPendingN; i++) {
      this._shellPending[i] -= dt;
      if (this._shellPending[i] <= 0) {
        this._spawnShell();
        this._shellPendingN--;
        this._shellPending[i] = this._shellPending[this._shellPendingN];
        i--;
      }
    }

    // ---- point particles ----
    this.sparks.update(dt);
    this.bits.update(dt);
    this.puffs.update(dt);

    // ---- spark streaks ----
    for (let i = 0; i < STREAK_MAX; i++) {
      const e = this.streaks[i];
      if (!e.active) continue;
      e.t += dt;
      if (e.t >= e.life) {
        e.active = false;
        e.mesh.visible = false;
        continue;
      }
      e.vel.y -= 22 * dt;
      e.mesh.position.addScaledVector(e.vel, dt);
      const speed = e.vel.length();
      if (speed > 0.001) {
        _va.copy(e.vel).multiplyScalar(1 / speed);
        e.mesh.quaternion.setFromUnitVectors(_Z, _va);
      }
      const k = 1 - e.t / e.life;
      const len = clamp(speed * 0.05, 0.06, 1.3);
      e.mesh.scale.set(e.w * k + 0.001, e.w * k + 0.001, len);
      e.mat.opacity = k;
    }

    // ---- tracers ----
    for (let i = 0; i < TRACER_MAX; i++) {
      const e = this.tracers[i];
      if (!e.active) continue;
      if (!e.fading) {
        e.head += e.speed * dt;
        if (e.head >= e.dist) {
          e.head = e.dist;
          e.fading = true;
          e.fade = 0.05;
        }
      } else {
        e.fade -= dt;
        if (e.fade <= 0) {
          e.active = false;
          e.mesh.visible = false;
          continue;
        }
      }
      const segEnd = e.head;
      const segStart = Math.max(0, e.head - e.tail);
      const segLen = Math.max(0.05, segEnd - segStart);
      const mid = (segStart + segEnd) * 0.5;
      e.mesh.position.copy(e.from).addScaledVector(e.dir, mid);
      const alpha = e.fading ? (e.fade / 0.05) : 1;
      e.mesh.scale.set(e.w, e.w, segLen);
      e.mat.opacity = alpha * e.baseA;
    }

    // ---- brass shells ----
    for (let i = 0; i < SHELL_MAX; i++) {
      const e = this.shells[i];
      if (!e.active) continue;
      e.t += dt;
      if (e.t > 1.2) {
        const fade = 1 - (e.t - 1.2) / 0.3;
        if (fade <= 0) {
          e.active = false;
          e.mesh.visible = false;
          continue;
        }
        e.mat.opacity = fade;
      }
      if (!e.resting) {
        e.vel.y -= 12 * dt;
        e.mesh.position.addScaledVector(e.vel, dt);
        e.mesh.rotation.x += e.ang.x * dt;
        e.mesh.rotation.y += e.ang.y * dt;
        e.mesh.rotation.z += e.ang.z * dt;
        if (e.mesh.position.y <= e.floorY + 0.008 && e.vel.y < 0) {
          if (e.bounces === 0) {
            e.bounces = 1;
            e.mesh.position.y = e.floorY + 0.008;
            e.vel.y = -e.vel.y * 0.32;
            e.vel.x *= 0.5; e.vel.z *= 0.5;
            e.ang.multiplyScalar(0.45);
          } else {
            e.resting = true;
            e.mesh.position.y = e.floorY + 0.006;
            e.vel.set(0, 0, 0);
            e.ang.set(0, 0, 0);
            e.mesh.rotation.x = Math.PI * 0.5;
          }
        }
      }
    }

    // ---- burst sprites ----
    for (let i = 0; i < BURST_MAX; i++) {
      const e = this.bursts[i];
      if (!e.active) continue;
      e.t += dt;
      if (e.t >= e.life) {
        e.active = false;
        e.sprite.visible = false;
        e.mat.opacity = 0;
        continue;
      }
      const k = e.t / e.life;
      const ease = 1 - (1 - k) * (1 - k);
      const s = e.size0 + (e.size1 - e.size0) * ease;
      e.sprite.scale.set(s, s, 1);
      e.sprite.position.y += e.vy * dt;
      e.mat.opacity = e.alpha0 * Math.pow(1 - k, e.expo);
      e.mat.rotation += e.rotSpeed * dt;
    }

    // ---- big billboard puffs (smokes) ----
    for (let i = 0; i < PUFF_MAX; i++) {
      const e = this.puffSprites[i];
      if (!e.active) continue;
      e.t += dt;
      if (e.t >= e.life) {
        e.active = false;
        e.sprite.visible = false;
        e.mat.opacity = 0;
        continue;
      }
      const t = e.t;
      e.angle += e.angSpeed * dt;
      const riseAmt = e.rise * Math.min(t, e.riseCap);
      e.sprite.position.set(
        e.cx + Math.cos(e.angle) * e.orbitR,
        e.cy + e.h + riseAmt,
        e.cz + Math.sin(e.angle) * e.orbitR
      );
      const k = t / e.life;
      const s = e.size0 + (e.size1 - e.size0) * k;
      e.sprite.scale.set(s, s, 1);
      e.mat.rotation += e.spin * dt;
      const aIn = e.fadeIn > 0 ? clamp01(t / e.fadeIn) : 1;
      const aOut = e.fadeOut > 0 ? clamp01((e.life - t) / e.fadeOut) : 1;
      e.mat.opacity = e.alphaMax * aIn * aIn * (3 - 2 * aIn) * aOut;
    }

    // ---- pooled flash lights ----
    for (let i = 0; i < this.lights.length; i++) {
      const e = this.lights[i];
      if (e.t >= e.life) {
        if (e.light.intensity !== 0) e.light.intensity = 0;
        continue;
      }
      e.t += dt;
      const k = clamp01(e.t / e.life);
      e.light.intensity = e.peak * Math.pow(1 - k, e.expo);
    }

    // ---- bomb pulsing red light ----
    const st = g.state;
    if (st && st.phase === 'planted' && st.bomb && st.bomb.planted && st.bomb.pos) {
      const bp = st.bomb.pos;
      this.bombLight.position.set(bp.x, bp.y + 0.35, bp.z);
      this.bombGlow.position.set(bp.x, bp.y + 0.3, bp.z);
      const interval = clamp((st.timer || 0) / 40, 0.12, 1);
      this._bombBeat += dt / interval;
      if (this._bombBeat >= 1) this._bombBeat %= 1;
      const env = Math.exp(-6 * this._bombBeat);
      this.bombLight.intensity = 7 * env;
      this.bombGlow.visible = true;
      this.bombGlow.material.opacity = 0.85 * env;
      const s = 0.16 + 0.36 * env;
      this.bombGlow.scale.set(s, s, 1);
    } else {
      if (this.bombLight.intensity !== 0) this.bombLight.intensity = 0;
      if (this.bombGlow.visible) this.bombGlow.visible = false;
    }
  }

  // =========================================================================
  // Full cleanup — fired on 'round:start'
  // =========================================================================
  _clearAll() {
    this.sparks.clear();
    this.bits.clear();
    this.puffs.clear();

    for (let i = 0; i < STREAK_MAX; i++) {
      const e = this.streaks[i];
      e.active = false;
      e.mesh.visible = false;
    }
    for (let i = 0; i < TRACER_MAX; i++) {
      const e = this.tracers[i];
      e.active = false;
      e.mesh.visible = false;
    }
    for (let i = 0; i < SHELL_MAX; i++) {
      const e = this.shells[i];
      e.active = false;
      e.mesh.visible = false;
      e.mat.opacity = 1;
    }
    for (let i = 0; i < BURST_MAX; i++) {
      const e = this.bursts[i];
      e.active = false;
      e.sprite.visible = false;
      e.mat.opacity = 0;
    }
    for (let i = 0; i < PUFF_MAX; i++) {
      const e = this.puffSprites[i];
      e.active = false;
      e.sprite.visible = false;
      e.mat.opacity = 0;
    }

    // Decals: reset ring + collapse to zero quads.
    this._decalIdx = 0;
    this._decalCount = 0;
    this._decalGeo.setDrawRange(0, 0);

    // Lights out.
    for (let i = 0; i < this.lights.length; i++) {
      this.lights[i].t = this.lights[i].life = 1;
      this.lights[i].light.intensity = 0;
    }
    this.bombLight.intensity = 0;
    this.bombGlow.visible = false;
    this._bombBeat = 0;

    // Queues.
    this._pendingPlayerFlash = 0;
    this._shellPendingN = 0;
  }
}
