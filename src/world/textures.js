// ============================================================================
// TINY STRIKE — procedural canvas textures.
// All deterministic (seeded PRNG, never Math.random), no external assets.
// Every texture: RepeatWrapping, SRGBColorSpace, 512x512 unless noted.
// ============================================================================
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Deterministic PRNG
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function finalize(canvas) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// Parse '#rrggbb' -> [r,g,b]
function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function css(r, g, b, a = 1) {
  return `rgba(${r | 0},${g | 0},${b | 0},${a})`;
}

// Lighten (f>0) / darken (f<0) a hex color, returns css string.
function shade(hex, f, a = 1) {
  const [r, g, b] = rgb(hex);
  const t = f < 0 ? 0 : 255;
  const p = Math.abs(f);
  return css(r + (t - r) * p, g + (t - g) * p, b + (t - b) * p, a);
}

// Mix two hex colors.
function mix(hexA, hexB, t, a = 1) {
  const A = rgb(hexA);
  const B = rgb(hexB);
  return css(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t, a);
}

// Scatter fine speckle noise over the canvas.
function speckle(ctx, rand, w, h, count, size, alpha, light, dark) {
  for (let i = 0; i < count; i++) {
    const x = rand() * w;
    const y = rand() * h;
    const s = size * (0.5 + rand());
    const lum = rand();
    ctx.fillStyle = lum > 0.5 ? light : dark;
    ctx.globalAlpha = alpha * (0.4 + 0.6 * rand());
    ctx.fillRect(x, y, s, s);
  }
  ctx.globalAlpha = 1;
}

// Big soft translucent blobs for tonal variation.
function mottle(ctx, rand, w, h, count, rMin, rMax, colors, alpha) {
  for (let i = 0; i < count; i++) {
    const x = rand() * w;
    const y = rand() * h;
    const r = rMin + rand() * (rMax - rMin);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const col = colors[(rand() * colors.length) | 0];
    g.addColorStop(0, col.replace(/[\d.]+\)$/, `${alpha * (0.5 + 0.5 * rand())})`));
    g.addColorStop(1, col.replace(/[\d.]+\)$/, '0)'));
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
}

// Random-walk crack line.
function crack(ctx, rand, x, y, len, color, width) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x, y);
  let ang = rand() * Math.PI * 2;
  for (let i = 0; i < len; i++) {
    ang += (rand() - 0.5) * 1.1;
    x += Math.cos(ang) * (3 + rand() * 6);
    y += Math.sin(ang) * (3 + rand() * 6);
    ctx.lineTo(x, y);
  }
  ctx.stroke();
}

// ---------------------------------------------------------------------------
// makeWallTexture({ base, accent }) — sandstone plaster, grime, brick hints
// ---------------------------------------------------------------------------
export function makeWallTexture(opts = {}) {
  const base = opts.base || '#c8a878';
  const accent = opts.accent || base;
  const rand = mulberry32(hashString('wall|' + base + '|' + accent));
  const W = 512;
  const H = 512;
  const c = makeCanvas(W, H);
  const ctx = c.getContext('2d');

  // Base plaster with slight vertical gradient (dust settles low).
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, shade(base, 0.06));
  grad.addColorStop(0.65, base);
  grad.addColorStop(1, shade(base, -0.12));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Tonal mottling.
  mottle(ctx, rand, W, H, 34, 40, 130,
    [shade(base, 0.1, 1), shade(base, -0.12, 1), mix(base, accent, 0.7, 1)], 0.14);

  // Brick hints: faint mortar grid showing through worn plaster (lower 2/3).
  ctx.globalAlpha = 0.16;
  ctx.strokeStyle = shade(base, -0.35);
  ctx.lineWidth = 2;
  const bh = 34;
  const bw = 84;
  for (let row = 5; row < 15; row++) {
    const y = row * bh + (rand() - 0.5) * 3;
    if (rand() < 0.35) continue; // patches where plaster still covers
    ctx.beginPath();
    ctx.moveTo(rand() * 60, y);
    ctx.lineTo(W - rand() * 60, y);
    ctx.stroke();
    const off = (row % 2) * (bw / 2);
    for (let x = off; x < W; x += bw) {
      if (rand() < 0.45) continue;
      const bx = x + (rand() - 0.5) * 4;
      ctx.beginPath();
      ctx.moveTo(bx, y);
      ctx.lineTo(bx, y + bh * 0.9);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;

  // A few exposed bricks (fully worn plaster spots).
  for (let i = 0; i < 7; i++) {
    const x = rand() * (W - 90);
    const y = H * 0.35 + rand() * (H * 0.55);
    ctx.fillStyle = mix(base, '#9a6b4a', 0.55, 0.35 + rand() * 0.25);
    ctx.fillRect(x, y, 60 + rand() * 40, 26 + rand() * 10);
    ctx.strokeStyle = shade(base, -0.4, 0.4);
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, 60, 30);
  }

  // Grime streaks running down from random points and from the top edge.
  for (let i = 0; i < 26; i++) {
    const x = rand() * W;
    const y0 = rand() < 0.5 ? 0 : rand() * H * 0.5;
    const len = 60 + rand() * 220;
    const wdt = 3 + rand() * 14;
    const g = ctx.createLinearGradient(0, y0, 0, y0 + len);
    g.addColorStop(0, shade(base, -0.3, 0.22 * rand() + 0.06));
    g.addColorStop(1, shade(base, -0.3, 0));
    ctx.fillStyle = g;
    ctx.fillRect(x - wdt / 2, y0, wdt, len);
  }

  // Fine plaster noise.
  speckle(ctx, rand, W, H, 2600, 1.6, 0.1, shade(base, 0.25), shade(base, -0.3));

  // Cracks.
  for (let i = 0; i < 4; i++) {
    crack(ctx, rand, rand() * W, rand() * H * 0.6, 14 + (rand() * 14) | 0,
      shade(base, -0.42, 0.5), 1.2);
  }

  // Accent tint wash (zone identity) + darker skirting band at the bottom.
  ctx.fillStyle = mix(base, accent, 1, 0.16);
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = mix(accent, '#000000', 0.35, 0.28);
  ctx.fillRect(0, H - 46, W, 46);
  ctx.fillStyle = shade(accent, -0.5, 0.5);
  ctx.fillRect(0, H - 46, W, 3);

  return finalize(c);
}

// ---------------------------------------------------------------------------
// makeFloorTexture({ base }) — dusty concrete / packed sand, cracks, pebbles
// ---------------------------------------------------------------------------
export function makeFloorTexture(opts = {}) {
  const base = opts.base || '#b3a07c';
  const rand = mulberry32(hashString('floor|' + base));
  const W = 512;
  const H = 512;
  const c = makeCanvas(W, H);
  const ctx = c.getContext('2d');

  ctx.fillStyle = base;
  ctx.fillRect(0, 0, W, H);

  // Large tonal patches (wind-blown sand / stains).
  mottle(ctx, rand, W, H, 40, 50, 150,
    [shade(base, 0.09, 1), shade(base, -0.11, 1), mix(base, '#8f7a55', 0.5, 1)], 0.16);

  // Subtle concrete slab seams (2x2 grid).
  ctx.strokeStyle = shade(base, -0.3, 0.35);
  ctx.lineWidth = 3;
  for (let i = 1; i < 2; i++) {
    ctx.beginPath();
    ctx.moveTo(W * 0.5 + (rand() - 0.5) * 6, 0);
    ctx.lineTo(W * 0.5 + (rand() - 0.5) * 6, H);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, H * 0.5 + (rand() - 0.5) * 6);
    ctx.lineTo(W, H * 0.5 + (rand() - 0.5) * 6);
    ctx.stroke();
  }

  // Cracks.
  for (let i = 0; i < 7; i++) {
    crack(ctx, rand, rand() * W, rand() * H, 12 + (rand() * 18) | 0,
      shade(base, -0.38, 0.45), 1.4);
  }

  // Pebbles: little shadowed dots with a highlight.
  for (let i = 0; i < 130; i++) {
    const x = rand() * W;
    const y = rand() * H;
    const r = 1.2 + rand() * 3.2;
    ctx.fillStyle = shade(base, -0.28, 0.7);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = shade(base, 0.22, 0.8);
    ctx.beginPath();
    ctx.arc(x - r * 0.3, y - r * 0.3, r * 0.45, 0, Math.PI * 2);
    ctx.fill();
  }

  // Fine grit.
  speckle(ctx, rand, W, H, 3200, 1.5, 0.12, shade(base, 0.2), shade(base, -0.26));

  // Tire-ish scuffs / drag marks.
  for (let i = 0; i < 5; i++) {
    const x = rand() * W;
    const y = rand() * H;
    const ang = rand() * Math.PI;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    ctx.fillStyle = shade(base, -0.22, 0.12 + rand() * 0.1);
    ctx.fillRect(-60 - rand() * 60, -4, 120 + rand() * 120, 8 + rand() * 6);
    ctx.restore();
  }

  return finalize(c);
}

// ---------------------------------------------------------------------------
// makeCrateTexture() — wooden supply crate: planks, frame, bolts
// ---------------------------------------------------------------------------
export function makeCrateTexture() {
  const rand = mulberry32(hashString('crate'));
  const W = 512;
  const H = 512;
  const c = makeCanvas(W, H);
  const ctx = c.getContext('2d');
  const wood = '#8a5f34';

  ctx.fillStyle = wood;
  ctx.fillRect(0, 0, W, H);

  // Inner planks (vertical), each with its own tone + grain.
  const planks = 5;
  const pw = W / planks;
  for (let p = 0; p < planks; p++) {
    const x0 = p * pw;
    ctx.fillStyle = shade(wood, (rand() - 0.5) * 0.24);
    ctx.fillRect(x0, 0, pw, H);
    // grain: wavy vertical strokes
    for (let gLine = 0; gLine < 9; gLine++) {
      const gx = x0 + 6 + rand() * (pw - 12);
      ctx.strokeStyle = shade(wood, -0.25 - rand() * 0.2, 0.35);
      ctx.lineWidth = 1 + rand() * 1.4;
      ctx.beginPath();
      ctx.moveTo(gx, 0);
      let xx = gx;
      for (let y = 0; y <= H; y += 32) {
        xx = gx + Math.sin(y * 0.02 + rand() * 6) * 4;
        ctx.lineTo(xx, y);
      }
      ctx.stroke();
    }
    // knot
    if (rand() < 0.6) {
      const kx = x0 + pw * (0.3 + rand() * 0.4);
      const ky = 60 + rand() * (H - 120);
      ctx.strokeStyle = shade(wood, -0.4, 0.8);
      ctx.lineWidth = 2;
      for (let r = 3; r < 12; r += 3) {
        ctx.beginPath();
        ctx.ellipse(kx, ky, r, r * 1.5, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    // plank gap shadow
    ctx.fillStyle = shade(wood, -0.55, 0.8);
    ctx.fillRect(x0 - 1.5, 0, 3, H);
  }

  // Outer frame planks.
  const fw = 54;
  ctx.fillStyle = shade(wood, -0.16);
  ctx.fillRect(0, 0, W, fw);
  ctx.fillRect(0, H - fw, W, fw);
  ctx.fillRect(0, 0, fw, H);
  ctx.fillRect(W - fw, 0, fw, H);
  ctx.strokeStyle = shade(wood, -0.5, 0.9);
  ctx.lineWidth = 3;
  ctx.strokeRect(fw, fw, W - fw * 2, H - fw * 2);
  ctx.strokeRect(1.5, 1.5, W - 3, H - 3);
  // frame highlight bevel
  ctx.strokeStyle = shade(wood, 0.18, 0.5);
  ctx.lineWidth = 2;
  ctx.strokeRect(fw - 4, fw - 4, W - (fw - 4) * 2, H - (fw - 4) * 2);

  // Bolts at frame corners and mid-edges.
  const boltAt = (x, y) => {
    ctx.fillStyle = '#4a4a48';
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#8f8f8a';
    ctx.beginPath();
    ctx.arc(x - 2, y - 2, 3, 0, Math.PI * 2);
    ctx.fill();
  };
  const m = fw / 2;
  [[m, m], [W - m, m], [m, H - m], [W - m, H - m],
   [W / 2, m], [W / 2, H - m], [m, H / 2], [W - m, H / 2]].forEach(([x, y]) => boltAt(x, y));

  // Faded stencil marking.
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.rotate(-0.04);
  ctx.font = 'bold 44px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(30,26,20,0.32)';
  ctx.fillText('SUPPLY', 0, -14);
  ctx.font = 'bold 30px monospace';
  ctx.fillText('7.62 MM', 0, 26);
  ctx.restore();

  // Dust + wear.
  speckle(ctx, rand, W, H, 1600, 1.6, 0.1, shade(wood, 0.3), shade(wood, -0.4));

  return finalize(c);
}

// ---------------------------------------------------------------------------
// makeMetalTexture({ base }) — brushed metal, rivets, scratches, rust
// ---------------------------------------------------------------------------
export function makeMetalTexture(opts = {}) {
  const base = opts.base || '#7a7f85';
  const rand = mulberry32(hashString('metal|' + base));
  const W = 512;
  const H = 512;
  const c = makeCanvas(W, H);
  const ctx = c.getContext('2d');

  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, shade(base, 0.08));
  grad.addColorStop(0.5, base);
  grad.addColorStop(1, shade(base, -0.1));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Brushed horizontal streaks.
  for (let i = 0; i < 240; i++) {
    const y = rand() * H;
    const x = rand() * W;
    const len = 40 + rand() * 220;
    ctx.fillStyle = rand() > 0.5
      ? shade(base, 0.14, 0.05 + rand() * 0.06)
      : shade(base, -0.16, 0.05 + rand() * 0.06);
    ctx.fillRect(x, y, len, 1 + rand() * 1.6);
  }

  // Panel seams.
  ctx.strokeStyle = shade(base, -0.4, 0.6);
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(0, H * 0.33);
  ctx.lineTo(W, H * 0.33);
  ctx.moveTo(0, H * 0.66);
  ctx.lineTo(W, H * 0.66);
  ctx.stroke();

  // Rivet rows along seams and edges.
  const rivet = (x, y) => {
    ctx.fillStyle = shade(base, -0.35, 0.9);
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = shade(base, 0.3, 0.9);
    ctx.beginPath();
    ctx.arc(x - 1.5, y - 1.5, 2, 0, Math.PI * 2);
    ctx.fill();
  };
  for (let x = 24; x < W; x += 58) {
    rivet(x, 14);
    rivet(x, H * 0.33 + 12);
    rivet(x, H * 0.66 + 12);
    rivet(x, H - 14);
  }

  // Scratches.
  for (let i = 0; i < 26; i++) {
    const x = rand() * W;
    const y = rand() * H;
    const ang = (rand() - 0.5) * 0.9;
    const len = 20 + rand() * 90;
    ctx.strokeStyle = rand() > 0.4 ? shade(base, 0.32, 0.35) : shade(base, -0.35, 0.35);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    ctx.stroke();
  }

  // Rust blooms near bottom / seams.
  for (let i = 0; i < 10; i++) {
    const x = rand() * W;
    const y = rand() < 0.5 ? H - rand() * 90 : H * 0.33 + rand() * 30;
    const r = 8 + rand() * 26;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(122,68,32,0.28)');
    g.addColorStop(1, 'rgba(122,68,32,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  speckle(ctx, rand, W, H, 900, 1.4, 0.08, shade(base, 0.28), shade(base, -0.3));

  return finalize(c);
}

// ---------------------------------------------------------------------------
// makeSkyTexture() — 1024x512 warm desert dusk gradient with faint clouds
// ---------------------------------------------------------------------------
export function makeSkyTexture() {
  const rand = mulberry32(hashString('sky'));
  const W = 1024;
  const H = 512;
  const c = makeCanvas(W, H);
  const ctx = c.getContext('2d');

  // Vertical gradient: deep dusk blue at zenith -> warm gold at horizon.
  const horizon = H * 0.62;
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#31406b');
  grad.addColorStop(0.3, '#5c5a84');
  grad.addColorStop(0.5, '#a97f7e');
  grad.addColorStop(0.62, '#e8a95e');
  grad.addColorStop(0.68, '#f2c27c');
  grad.addColorStop(0.8, '#e3bd90');
  grad.addColorStop(1, '#d9b28a');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Sun glow low on the horizon.
  const sunX = W * 0.31;
  const sunY = horizon - 8;
  let g = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, 200);
  g.addColorStop(0, 'rgba(255,232,180,0.9)');
  g.addColorStop(0.25, 'rgba(255,205,130,0.45)');
  g.addColorStop(1, 'rgba(255,190,120,0)');
  ctx.fillStyle = g;
  ctx.fillRect(sunX - 200, sunY - 200, 400, 400);
  g = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, 46);
  g.addColorStop(0, 'rgba(255,248,225,1)');
  g.addColorStop(1, 'rgba(255,240,200,0)');
  ctx.fillStyle = g;
  ctx.fillRect(sunX - 50, sunY - 50, 100, 100);

  // Streaky dusk clouds: elongated soft ellipses, warmer near horizon.
  for (let i = 0; i < 34; i++) {
    const t = rand();
    const y = t * horizon * 0.96;
    const x = rand() * W;
    const len = 60 + rand() * 240;
    const th = 5 + rand() * 16 * (0.4 + t);
    const warm = y / horizon;
    const colTop = `rgba(${140 + warm * 115 | 0},${120 + warm * 80 | 0},${140 + warm * 40 | 0},`;
    const a = 0.05 + rand() * 0.12;
    const cg = ctx.createRadialGradient(x, y, 0, x, y, len / 2);
    cg.addColorStop(0, colTop + a + ')');
    cg.addColorStop(1, colTop + '0)');
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(1, th / (len / 2));
    ctx.translate(-x, -y);
    ctx.fillStyle = cg;
    ctx.fillRect(x - len / 2, y - len / 2, len, len);
    ctx.restore();
  }

  // Faint stars in the upper sky.
  for (let i = 0; i < 60; i++) {
    const x = rand() * W;
    const y = rand() * H * 0.22;
    ctx.fillStyle = `rgba(255,255,255,${0.12 + rand() * 0.2})`;
    ctx.fillRect(x, y, 1.4, 1.4);
  }

  const tex = finalize(c);
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

// ---------------------------------------------------------------------------
// makeSiteMarkerTexture({ letter, color }) — painted floor decal ("A"/"B")
// (extra helper used by the map for bombsite floor markers)
// ---------------------------------------------------------------------------
export function makeSiteMarkerTexture(opts = {}) {
  const letter = opts.letter || 'A';
  const color = opts.color || '#ff9a3c';
  const rand = mulberry32(hashString('site|' + letter + '|' + color));
  const W = 256;
  const H = 256;
  const c = makeCanvas(W, H);
  const ctx = c.getContext('2d');

  // Dark worn square patch.
  ctx.fillStyle = 'rgba(20,16,12,0.55)';
  const pad = 14;
  ctx.beginPath();
  ctx.roundRect(pad, pad, W - pad * 2, H - pad * 2, 18);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.85;
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.roundRect(pad + 8, pad + 8, W - (pad + 8) * 2, H - (pad + 8) * 2, 12);
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Big stencil letter.
  ctx.font = '900 168px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(letter, W / 2, H / 2 + 10);

  // Wear: punch transparent holes out of the paint.
  ctx.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 260; i++) {
    const x = rand() * W;
    const y = rand() * H;
    const r = 1 + rand() * 4.5;
    ctx.globalAlpha = 0.25 + rand() * 0.5;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;

  const tex = finalize(c);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}
