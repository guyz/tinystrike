import * as THREE from 'three';
// Lifted from the reference project's kit.js: the two helpers this file needs,
// so the prop library does not drag in a building kit bound to another game's
// layout system.
import {
  chamferBox,
  rockGeometry,
  sackGeometry,
  polyPrism,
  paintMasks,
  fillMasks,
  fbm3,
  warpGeometry,
} from './util.js';

export function mergeSimple(list) {
  let vc = 0;
  let ic = 0;
  for (const g of list) {
    vc += g.getAttribute('position').count;
    ic += g.index ? g.index.count : g.getAttribute('position').count;
  }
  const pos = new Float32Array(vc * 3);
  const nrm = new Float32Array(vc * 3);
  const uv = new Float32Array(vc * 2);
  const col = new Float32Array(vc * 3);
  const idx = vc > 65535 ? new Uint32Array(ic) : new Uint16Array(ic);
  let vo = 0;
  let io = 0;
  for (const g of list) {
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    const u = g.getAttribute('uv');
    const c = g.getAttribute('color');
    pos.set(p.array, vo * 3);
    if (n) nrm.set(n.array, vo * 3);
    if (u) uv.set(u.array, vo * 2);
    if (c) col.set(c.array, vo * 3);
    if (g.index) {
      const a = g.index.array;
      for (let i = 0; i < a.length; i++) idx[io + i] = vo + a[i];
      io += a.length;
    } else {
      for (let i = 0; i < p.count; i++) idx[io + i] = vo + i;
      io += p.count;
    }
    vo += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

export function pockGeometry(rng, r = 0.05) {
  const SEG = 8;
  // (radius factor, height factor) — floor, bowl wall, rim crest, outer skirt.
  const RINGS = [
    [0.0, 0.010],
    [0.42, 0.024],
    [0.8, 0.075],
    [1.0, 0.004],
  ];
  // chipped rim: per-segment radius and crest-height jitter. 8 + 8 = 16 draws.
  const jr = [];
  const jz = [];
  for (let s = 0; s < SEG; s++) jr.push(1 + (rng.float() - 0.5) * 0.42);
  for (let s = 0; s < SEG; s++) jz.push(0.62 + rng.float() * 0.76);

  const pos = [];
  const idx = [];
  // ring 0 is the single centre vertex; rings 1..3 are full circles.
  pos.push(0, 0, RINGS[0][1] * r);
  for (let k = 1; k < RINGS.length; k++) {
    const [rf, zf] = RINGS[k];
    for (let s = 0; s < SEG; s++) {
      const a = (s / SEG) * Math.PI * 2;
      // Only the two outer rings are chipped; the bowl stays smooth so the
      // floor does not poke through the wall.
      const rj = k >= 2 ? jr[s] : 1;
      const zj = k === 2 ? jz[s] : 1;
      pos.push(Math.cos(a) * rf * r * rj, Math.sin(a) * rf * r * rj, zf * r * zj);
    }
  }
  const ringStart = (k) => 1 + (k - 1) * SEG;
  for (let s = 0; s < SEG; s++) {
    const n = (s + 1) % SEG;
    idx.push(0, ringStart(1) + s, ringStart(1) + n); // floor fan
  }
  for (let k = 1; k < RINGS.length - 1; k++) {
    const a0 = ringStart(k);
    const b0 = ringStart(k + 1);
    for (let s = 0; s < SEG; s++) {
      const n = (s + 1) % SEG;
      idx.push(a0 + s, b0 + s, b0 + n, a0 + s, b0 + n, a0 + n);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  paintMasks(g, (x, y, z, nx, ny, nz, out) => {
    // Wear (exposed substrate) and AO are strongest in the crater floor; the
    // raised rim is cleaner and catches light, which is what sells the depth.
    const t = Math.min(1, Math.hypot(x, y) / (r * 0.8));
    out[0] = 0.9 - 0.35 * t;
    out[1] = 0.62 - 0.3 * t;
    out[2] = 0.9 - 0.55 * t;
  });
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/**
 * WORLD — the prop library.
 *
 * Every prop is a small assembly of chamfered boxes, tubes, cloth grids and
 * noise-deformed rocks, merged into ONE geometry and registered as an
 * InstancedMesh prototype. Placement (rotation/scale/tint variation) lives in
 * dressing.js — this file only decides what things look like.
 *
 * Mask convention as everywhere else: r = edge wear, g = grime, b = extra AO,
 * multiplied per instance by instanceColor so no two crates weather alike.
 */

const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();

function mat(x, y, z, ry = 0, rx = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  _p.set(x, y, z);
  _s.set(sx, sy, sz);
  return _m.compose(_p, _q, _s);
}

/** Generic convex-edge detector: verts near two or more bounding faces. */
export function autoEdgeWear(geo, margin = 0.02, amount = 1) {
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const sx = bb.max.x - bb.min.x;
  const sy = bb.max.y - bb.min.y;
  const sz = bb.max.z - bb.min.z;
  return paintMasks(geo, (x, y, z, nx, ny, nz, out) => {
    let near = 0;
    if (sx > margin * 3 && (x - bb.min.x < margin || bb.max.x - x < margin)) near++;
    if (sy > margin * 3 && (y - bb.min.y < margin || bb.max.y - y < margin)) near++;
    if (sz > margin * 3 && (z - bb.min.z < margin || bb.max.z - z < margin)) near++;
    if (near >= 2) out[0] = Math.max(out[0], amount);
  });
}

/**
 * A plain 12-triangle box.
 *
 * A chamfered box costs 44 triangles: 12 for the faces, 24 for the edge strips
 * and 8 for the corners. That is the right trade for a crate body or a coping
 * course, whose 1-2 cm chamfer is what catches the specular at 2 m. It is the
 * wrong trade for a 16 mm slat, a 24 mm baluster or a 30 mm louvre, where the
 * chamfer is under a pixel from anywhere a player stands — and those members
 * are most of the prop library's triangle count (a slatted crate is 22 boxes,
 * only one of which is thicker than 5 cm).
 */
function plateBox(sx, sy, sz) {
  const g = new THREE.BoxGeometry(sx, sy, sz);
  // Thin members are all edge, so they read as worn everywhere; the underside
  // grime that chamferBox paints per-face is added by _push's `grime`.
  fillMasks(g, 0.6, 0, 0);
  return g;
}

/** Part accumulator for one prop. */
class PB {
  constructor() {
    this.list = [];
  }

  _push(g, wear, grime, ao) {
    if (!g.getAttribute('color')) fillMasks(g, 0.2, 0, 0);
    if (wear !== 1 || grime > 0 || ao > 0) {
      const c = g.getAttribute('color');
      for (let i = 0; i < c.count; i++) {
        c.setXYZ(
          i,
          Math.min(1, c.getX(i) * wear),
          Math.min(1, Math.max(c.getY(i), grime)),
          Math.min(1, Math.max(c.getZ(i), ao))
        );
      }
    }
    this.list.push(g);
    return g;
  }

  box(sx, sy, sz, x = 0, y = 0, z = 0, o = {}) {
    // Anything under 3.5 cm on its thin axis gets the plain box: at that gauge
    // the chamfer is sub-pixel past arm's length and costs 32 extra triangles.
    const thin = o.thin ?? Math.min(sx, sy, sz) < 0.035;
    const g = thin ? plateBox(sx, sy, sz) : chamferBox(sx, sy, sz, o.bevel ?? 0.008);
    g.applyMatrix4(mat(x, y, z, o.ry ?? 0, o.rx ?? 0, o.rz ?? 0));
    return this._push(g, o.wear ?? 1, o.grime ?? 0, o.ao ?? 0);
  }

  cyl(r, h, x = 0, y = 0, z = 0, o = {}) {
    const g = new THREE.CylinderGeometry(
      (o.taper ?? 1) * r,
      r,
      h,
      o.radial ?? 12,
      o.seg ?? 1,
      o.open ?? false
    );
    autoEdgeWear(g, o.margin ?? Math.min(r, h) * 0.12, 0.9);
    g.applyMatrix4(mat(x, y, z, o.ry ?? 0, o.rx ?? 0, o.rz ?? 0));
    return this._push(g, o.wear ?? 1, o.grime ?? 0, o.ao ?? 0);
  }

  geo(g, x = 0, y = 0, z = 0, o = {}) {
    if (o.autoWear !== false && !g.getAttribute('color')) autoEdgeWear(g, o.margin ?? 0.02);
    g.applyMatrix4(mat(x, y, z, o.ry ?? 0, o.rx ?? 0, o.rz ?? 0, o.sx ?? 1, o.sy ?? 1, o.sz ?? 1));
    return this._push(g, o.wear ?? 1, o.grime ?? 0, o.ao ?? 0);
  }

  build() {
    const g = mergeSimple(this.list);
    for (const p of this.list) p.dispose();
    this.list.length = 0;
    return g;
  }
}

// ============================================================== containers ==
function crate(rng, s = 0.62, slats = true) {
  const p = new PB();
  p.box(s, s * 0.85, s * 0.92, 0, 0, 0, { bevel: 0.012, grime: 0.12 });
  if (slats) {
    // plank slats standing proud of the body, with one board sprung loose
    const n = 3;
    for (let i = 0; i < n; i++) {
      const y = -s * 0.32 + (i / (n - 1)) * s * 0.64;
      const loose = rng.float() < 0.18;
      p.box(s * 1.01, s * 0.14, 0.016, 0, y, s * 0.46, {
        bevel: 0.004,
        rz: loose ? rng.range(-0.12, 0.12) : 0,
        wear: 1,
      });
      p.box(s * 1.01, s * 0.14, 0.016, 0, y, -s * 0.46, { bevel: 0.004 });
      p.box(0.016, s * 0.14, s * 0.94, s * 0.5, y, 0, { bevel: 0.004 });
      p.box(0.016, s * 0.14, s * 0.94, -s * 0.5, y, 0, { bevel: 0.004 });
    }
    // corner posts
    for (const sx of [-1, 1])
      for (const sz of [-1, 1])
        p.box(0.05, s * 0.86, 0.05, sx * (s * 0.48), 0, sz * (s * 0.44), { bevel: 0.006 });
    // lid boards with real gaps: the top face is what the player looks down on,
    // and one unbroken panel there is what makes a crate read as a solid block
    const lid = 4;
    for (let i = 0; i < lid; i++) {
      const z = -s * 0.46 + ((i + 0.5) / lid) * s * 0.92;
      p.box(s * 1.0, 0.02, (s * 0.92) / lid - 0.012, 0, s * 0.425 + 0.012, z, {
        bevel: 0.004,
        rz: rng.range(-0.006, 0.006),
        wear: 1,
      });
    }
    // a cross batten and a couple of nail heads' worth of relief
    p.box(s * 1.02, 0.022, 0.055, 0, s * 0.44, s * 0.2, { bevel: 0.004, wear: 1 });
  }
  const g = p.build();
  g.translate(0, s * 0.425, 0);
  return g;
}

function cardboardBox(rng, s = 0.45) {
  const p = new PB();
  const h = s * rng.range(0.6, 0.9);
  p.box(s, h, s * rng.range(0.8, 1.1), 0, 0, 0, { bevel: 0.006, grime: 0.25 });
  // flaps, one folded up
  p.box(s * 0.48, 0.012, s * 0.9, -s * 0.25, h / 2 + 0.006, 0, { bevel: 0.003, wear: 1 });
  p.box(s * 0.48, 0.012, s * 0.9, s * 0.25, h / 2 + 0.09, 0, { bevel: 0.003, rz: -0.9 });
  const g = p.build();
  g.translate(0, h / 2, 0);
  return g;
}

function barrel(rng, r = 0.29, h = 0.88, ribs = 3) {
  const p = new PB();
  p.cyl(r, h, 0, 0, 0, { radial: 16, grime: 0.15 });
  for (let i = 0; i < ribs; i++) {
    const y = -h / 2 + ((i + 1) / (ribs + 1)) * h;
    p.cyl(r * 1.045, h * 0.055, 0, y, 0, { radial: 16, wear: 1, grime: 0.3 });
  }
  p.cyl(r * 1.02, 0.03, 0, h / 2 - 0.015, 0, { radial: 16, wear: 1 });
  p.cyl(r * 1.02, 0.03, 0, -h / 2 + 0.015, 0, { radial: 16, wear: 1, grime: 0.5 });
  // bung
  p.cyl(0.05, 0.02, r * 0.45, h / 2 + 0.008, 0, { radial: 8, wear: 1 });
  const g = p.build();
  g.translate(0, h / 2, 0);
  warpGeometry(g, 0.008, 2.2, rng.float() * 10);
  return g;
}

function gasBottle(rng) {
  const p = new PB();
  const h = 0.58;
  p.cyl(0.155, h, 0, 0, 0, { radial: 14, grime: 0.2 });
  p.cyl(0.15, 0.06, 0, h / 2 + 0.02, 0, { radial: 14, taper: 0.75, wear: 1 });
  p.cyl(0.032, 0.09, 0, h / 2 + 0.09, 0, { radial: 8, wear: 1 });
  p.cyl(0.075, 0.035, 0, h / 2 + 0.14, 0, { radial: 10, wear: 1 });
  p.cyl(0.16, 0.02, 0, -h / 2 + 0.01, 0, { radial: 14, grime: 0.6 });
  const g = p.build();
  g.translate(0, h / 2, 0);
  return g;
}

function bucket(rng) {
  const p = new PB();
  p.cyl(0.145, 0.28, 0, 0, 0, { radial: 14, taper: 1.24, grime: 0.4, open: true });
  p.cyl(0.145, 0.02, 0, -0.13, 0, { radial: 14, grime: 0.6 });
  p.cyl(0.185, 0.018, 0, 0.14, 0, { radial: 14, wear: 1 });
  const g = p.build();
  g.translate(0, 0.14, 0);
  return g;
}

function jerryCan(rng) {
  const p = new PB();
  p.box(0.34, 0.44, 0.17, 0, 0, 0, { bevel: 0.02, grime: 0.2 });
  p.box(0.3, 0.06, 0.05, 0, 0.24, 0, { bevel: 0.01, wear: 1 });
  p.cyl(0.035, 0.05, 0.11, 0.25, 0, { radial: 8, wear: 1 });
  const g = p.build();
  g.translate(0, 0.22, 0);
  return g;
}

// ================================================================== cover ==
/**
 * A filled bag: ~0.5 m long, 0.17 m tall once it has settled under its stack.
 * Three genuinely different silhouettes, because a wall built from one bag is a
 * lattice of identical lozenges no matter how it is stacked.
 */
function sandbag(rng, i = 0) {
  const dims = [
    [0.49, 0.175, 0.33],
    [0.45, 0.16, 0.35],
    [0.47, 0.15, 0.3],
  ][i % 3];
  const g = sackGeometry(rng, dims[0], dims[1], dims[2], {
    variant: i % 3,
    box: 4.6 - (i % 3) * 0.5,
    lump: 1.2,
  });
  const bb = g.boundingBox;
  paintMasks(g, (x, y, z, nx, ny, nz, out) => {
    const n = fbm3(x * 12, y * 12, z * 12, 2);
    // creases and the underside of the bag: where dust and shadow collect
    const crease = Math.max(0, 1 - Math.abs(ny) * 3.2);
    const low = Math.max(0, 1 - (y - bb.min.y) / (dims[1] * 0.55));
    // the tied ends are the darkest part of a bag, and they are what draws the
    // seam between one bag and the next in a stack
    const end = Math.max(0, Math.abs(x) / (dims[0] * 0.5) - 0.62) / 0.38;
    // Bags weather hard: sun-bleached on top, filthy where they touch.
    out[0] = 0.3 + n * 0.45 + Math.max(0, ny) * 0.2;
    // Keep the hessian pale: bags are only filthy where they touch, and burying
    // the weave under grime is what makes sandbags read as beanbags.
    out[1] = 0.16 + Math.max(0, -ny) * 0.45 + n * 0.14 + low * low * 0.3 + end * 0.25;
    out[2] = 0.1 + Math.max(0, -ny) * 0.45 + crease * 0.22 + low * low * 0.35 + end * end * 0.5;
  });
  g.translate(0, dims[1] * 0.5, 0);
  return g;
}

function jerseyBarrier(rng) {
  // Proper jersey profile: wide splayed foot, sloped face, narrow top.
  const prof = [
    [-0.3, 0],
    [0.3, 0],
    [0.3, 0.09],
    [0.16, 0.24],
    [0.09, 0.72],
    [0.09, 0.92],
    [-0.09, 0.92],
    [-0.09, 0.72],
    [-0.16, 0.24],
    [-0.3, 0.09],
  ];
  const shape = new THREE.Shape();
  shape.moveTo(prof[0][0], prof[0][1]);
  for (let i = 1; i < prof.length; i++) shape.lineTo(prof[i][0], prof[i][1]);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: 1.9,
    bevelEnabled: true,
    bevelThickness: 0.015,
    bevelSize: 0.015,
    bevelSegments: 1,
    steps: 1,
  });
  g.translate(0, 0, -0.95);
  g.computeVertexNormals();
  autoEdgeWear(g, 0.035, 1);
  const p = new PB();
  p.geo(g, 0, 0, 0, { autoWear: false, grime: 0.15 });
  // lifting eyes and a scuffed reflector
  p.cyl(0.035, 0.1, 0, 0.95, -0.55, { radial: 8, rx: Math.PI / 2, wear: 1 });
  p.cyl(0.035, 0.1, 0, 0.95, 0.55, { radial: 8, rx: Math.PI / 2, wear: 1 });
  const out = p.build();
  paintMasks(out, (x, y, z, nx, ny, nz, o) => {
    o[1] = Math.min(1, o[1] + Math.max(0, 1 - y / 0.35) ** 2 * 0.6 + Math.max(0, -ny) * 0.4);
    o[2] = Math.min(1, o[2] + Math.max(0, 1 - y / 0.3) ** 2 * 0.45);
  });
  return out;
}

function concreteBlock(rng, w = 1.2, h = 0.9, d = 0.8) {
  const p = new PB();
  p.box(w, h, d, 0, 0, 0, { bevel: 0.03, grime: 0.2 });
  // chipped corner
  const chip = rockGeometry(rng, 0.34, 0, 0.8);
  p.geo(chip, w / 2 - 0.06, h / 2 - 0.05, d / 2 - 0.08, { grime: 0.4 });
  const g = p.build();
  g.translate(0, h / 2, 0);
  return g;
}

/**
 * A tyre. A smooth torus is the giveaway: real rubber has a tread band with
 * discrete blocks and grooves, a shoulder radius, and raised lettering on the
 * sidewall. The tread count is deliberately low (14 blocks) so it resolves as
 * blocks at 3 m instead of aliasing into a hum like a 34-cycle ripple does.
 */
function tyre(rng, r = 0.33) {
  const BLOCKS = 14;
  /**
   * 4 columns per block. At 3 the pulse is sampled at 0, 1/3, 2/3 of the pitch,
   * so only one column of the three ever reaches full height and the crown
   * reads as a ring of beads. At 4 it samples 0, 1/4, 1/2, 3/4 — two columns up,
   * two down — which is a tread block. The 5 columns this used to carry bought
   * nothing but triangles: at 17 blocks that was 85 radial segments and 2380
   * triangles on a prop the level places sixty of, more than the whole facade
   * of the building behind it.
   */
  const radial = BLOCKS * 4;
  const HW = r * 0.3; // half the section width
  // A real tyre section: flat-ish sidewalls at the widest point, a distinct
  // shoulder, a flat crown, and a bead that leaves a proper hole in the middle.
  // Revolving this instead of a circle is the difference between a tyre and an
  // inflatable ring. 11 points is the fewest that keeps all four features.
  const prof = [
    [0.55, 0.5],
    [0.8, 0.99],
    [0.95, 0.9],
    [1.0, 0.4],
    [1.0, -0.4],
    [0.95, -0.9],
    [0.8, -0.99],
    [0.55, -0.5],
    [0.5, -0.18],
    [0.505, 0.18],
    [0.55, 0.5],
  ].map(([pr, py]) => new THREE.Vector2(pr * r, py * HW));
  const g = new THREE.LatheGeometry(prof, radial);
  const pa = g.getAttribute('position');
  const stagger = rng.float() * 6.28;
  for (let i = 0; i < pa.count; i++) {
    const x = pa.getX(i);
    const y = pa.getY(i);
    const z = pa.getZ(i);
    const a = Math.atan2(z, x);
    const rr = Math.hypot(x, z);
    // tread blocks: a square wave round the crown, split by a centre groove
    const ph = (a * BLOCKS) / (Math.PI * 2) + stagger;
    const blkT = ((ph % 1) + 1) % 1;
    // A block that occupies 62% of the pitch with a chamfered leading and
    // trailing edge. A square pulse over 3 coarse columns made the crown read as
    // a ring of beads; a real tread block has a sloped shoulder into the groove.
    const blk = Math.max(0, Math.min(1, blkT / 0.075, (0.62 - blkT) / 0.075));
    const centre = Math.exp(-((y / (HW * 0.22)) ** 2) * 3); // circumferential groove
    const treadBand = Math.max(0, (rr / r - 0.9) / 0.1) * Math.max(0, 1 - Math.abs(y) / (HW * 0.72));
    // 9 mm of tread relief: enough to read as blocks at 3 m, not a monster truck
    const grow = treadBand * (blk * 0.0062 - 0.0018 - centre * 0.0045) * (r / 0.33);
    const f = 1 + grow / Math.max(1e-4, rr);
    // sidewall lettering / brand ring relief, pushed along the sidewall normal
    const band = Math.exp(-(((rr / r - 0.76) / 0.11) ** 2));
    const letter = band * ((Math.sin(a * 23 + stagger * 3) > 0.4 ? 0.006 : 0) + 0.0022) * (r / 0.33);
    pa.setXYZ(i, x * f, y * 0.94 + Math.sign(y) * letter, z * f);
  }
  g.computeVertexNormals();
  paintMasks(g, (x, y, z, nx, ny, nz, out) => {
    const rr = Math.hypot(x, z);
    const crown = Math.min(1, Math.max(0, (rr / r - 0.88) / 0.12));
    const hole = Math.max(0, 1 - (rr / r - 0.5) / 0.12); // inside the bead
    const n = fbm3(x * 9, y * 9, z * 9, 2);
    // the crown is scrubbed clean-ish, the sidewalls and grooves hold dust
    out[0] = 0.25 + crown * 0.4 + n * 0.25;
    out[1] = 0.3 + (1 - crown) * 0.35 + Math.max(0, -ny) * 0.3;
    out[2] = 0.12 + (1 - crown) * 0.25 + Math.max(0, -ny) * 0.3 + hole * 0.5;
  });
  g.translate(0, HW * 0.95, 0);
  return g;
}

function pallet(rng) {
  const p = new PB();
  const w = 1.16;
  const d = 0.98;
  for (let i = 0; i < 3; i++) {
    const z = -d / 2 + 0.06 + (i / 2) * (d - 0.12);
    p.box(w, 0.075, 0.11, 0, 0.04, z, { bevel: 0.006, grime: 0.3 });
  }
  const boards = 6;
  for (let i = 0; i < boards; i++) {
    const z = -d / 2 + 0.05 + (i / (boards - 1)) * (d - 0.1);
    p.box(w, 0.018, 0.1, 0, 0.088, z, { bevel: 0.004, rz: rng.range(-0.004, 0.004) });
  }
  for (let i = 0; i < 3; i++) {
    const z = -d / 2 + 0.06 + (i / 2) * (d - 0.12);
    p.box(w, 0.018, 0.1, 0, -0.008, z, { bevel: 0.004 });
  }
  return p.build();
}

// ============================================================== furniture ==
function table(rng, w = 1.5, h = 0.78, d = 0.8) {
  const p = new PB();
  p.box(w, 0.045, d, 0, h - 0.02, 0, { bevel: 0.008, wear: 1 });
  p.box(w - 0.1, 0.05, d - 0.1, 0, h - 0.075, 0, { bevel: 0.006, grime: 0.3 });
  for (const sx of [-1, 1])
    for (const sz of [-1, 1])
      p.box(0.07, h - 0.1, 0.07, sx * (w / 2 - 0.09), (h - 0.1) / 2, sz * (d / 2 - 0.09), {
        bevel: 0.005,
        grime: 0.25,
      });
  return p.build();
}

function stall(rng, w = 2.3) {
  // Market stall: trestle table, back board, cloth over the top, poles.
  const p = new PB();
  const h = 0.84;
  const d = 1.05;
  p.box(w, 0.05, d, 0, h, 0, { bevel: 0.008 });
  p.box(w - 0.06, 0.09, d - 0.08, 0, h - 0.07, 0, { bevel: 0.006, grime: 0.35 });
  for (const sx of [-1, 1]) {
    p.box(0.08, h - 0.05, 0.08, sx * (w / 2 - 0.1), (h - 0.05) / 2, d / 2 - 0.1, { grime: 0.3 });
    p.box(0.08, h - 0.05, 0.08, sx * (w / 2 - 0.1), (h - 0.05) / 2, -d / 2 + 0.1, { grime: 0.3 });
    // corner posts carrying the canopy
    p.box(0.06, 2.0, 0.06, sx * (w / 2 - 0.05), 1.0, -d / 2 + 0.06, { grime: 0.2 });
    p.box(0.06, 2.0, 0.06, sx * (w / 2 - 0.05), 1.0, d / 2 - 0.06, { grime: 0.2 });
  }
  p.box(w, 0.06, 0.06, 0, 1.98, -d / 2 + 0.06, {});
  p.box(w, 0.06, 0.06, 0, 1.98, d / 2 - 0.06, {});
  // shelf under the table
  p.box(w - 0.3, 0.03, d - 0.3, 0, 0.24, 0, { bevel: 0.004, grime: 0.45 });
  return p.build();
}

function shelfUnit(rng, w = 1.1, h = 1.9, d = 0.35) {
  const p = new PB();
  for (const sx of [-1, 1]) p.box(0.05, h, d, sx * (w / 2 - 0.025), h / 2, 0, { grime: 0.2 });
  const n = 4;
  for (let i = 0; i < n; i++) {
    const y = 0.22 + (i / (n - 1)) * (h - 0.4);
    p.box(w - 0.06, 0.03, d, 0, y, 0, { bevel: 0.005, grime: 0.25 });
  }
  p.box(w, 0.03, 0.02, 0, h - 0.02, -d / 2 + 0.01, {});
  return p.build();
}

function mattress(rng) {
  const g = chamferBox(1.85, 0.16, 0.85, 0.05);
  paintMasks(g, (x, y, z, nx, ny, nz, out) => {
    const n = fbm3(x * 3 + 4, y * 3, z * 3, 2);
    out[0] = 0.2;
    out[1] = 0.45 + n * 0.4;
    out[2] = Math.max(0, -ny) * 0.4;
  });
  // sag in the middle
  const pa = g.getAttribute('position');
  for (let i = 0; i < pa.count; i++) {
    const x = pa.getX(i);
    const y = pa.getY(i);
    const z = pa.getZ(i);
    if (y > 0) pa.setY(i, y - 0.035 * Math.cos((x / 1.85) * Math.PI) * Math.cos((z / 0.85) * Math.PI));
  }
  g.computeVertexNormals();
  g.translate(0, 0.08, 0);
  return g;
}

function chair(rng) {
  const p = new PB();
  const sh = 0.46;
  p.box(0.42, 0.04, 0.4, 0, sh, 0, { bevel: 0.006, wear: 1 });
  for (const sx of [-1, 1])
    for (const sz of [-1, 1])
      p.box(0.04, sh, 0.04, sx * 0.18, sh / 2, sz * 0.17, { grime: 0.2 });
  p.box(0.42, 0.5, 0.035, 0, sh + 0.27, -0.18, { bevel: 0.005, rx: -0.08 });
  p.box(0.42, 0.06, 0.05, 0, sh + 0.48, -0.2, { bevel: 0.005 });
  return p.build();
}

function cabinet(rng, w = 0.9, h = 1.15, d = 0.44) {
  const p = new PB();
  p.box(w, h, d, 0, h / 2, 0, { bevel: 0.01, grime: 0.2 });
  for (const sx of [-1, 1]) {
    p.box(w / 2 - 0.03, h - 0.12, 0.03, sx * (w / 4), h / 2, d / 2 + 0.01, { bevel: 0.005, wear: 1 });
    p.box(0.03, 0.1, 0.03, sx * 0.06, h / 2, d / 2 + 0.03, { wear: 1 });
  }
  p.box(w + 0.04, 0.04, d + 0.04, 0, h + 0.02, 0, { bevel: 0.008, wear: 1, grime: 0.3 });
  return p.build();
}

// ================================================================ services ==
function acUnit(rng) {
  const p = new PB();
  const w = 0.78;
  const h = 0.55;
  const d = 0.34;
  p.box(w, h, d, 0, 0, 0, { bevel: 0.012, grime: 0.35 });
  // louvre grille on the face
  for (let i = 0; i < 7; i++) {
    p.box(w - 0.1, 0.035, 0.02, 0, -h / 2 + 0.08 + i * 0.06, d / 2 + 0.005, {
      bevel: 0.003,
      rx: 0.35,
      wear: 1,
    });
  }
  // fan ring
  p.cyl(0.19, 0.03, 0, 0.02, d / 2 + 0.02, { radial: 16, rx: Math.PI / 2, wear: 1 });
  // wall brackets
  for (const sx of [-1, 1]) {
    p.box(0.05, 0.05, 0.5, sx * (w / 2 - 0.05), -h / 2 + 0.03, -d / 2 - 0.16, { grime: 0.5 });
    p.box(0.05, 0.34, 0.05, sx * (w / 2 - 0.05), -h / 2 - 0.14, -d / 2 - 0.36, { grime: 0.5, rz: 0.5 });
  }
  // condensate drip stain hanger
  p.cyl(0.012, 0.5, w / 2 - 0.12, -h / 2 - 0.24, 0, { radial: 6, grime: 0.6 });
  const g = p.build();
  return g;
}

function satDish(rng) {
  const p = new PB();
  const dish = new THREE.SphereGeometry(0.42, 16, 10, 0, Math.PI * 2, 0, 0.55);
  dish.scale(1, 0.42, 1);
  dish.rotateX(-2.1);
  autoEdgeWear(dish, 0.03, 0.8);
  p.geo(dish, 0, 0.55, 0.1, { autoWear: false, grime: 0.3 });
  p.cyl(0.03, 0.5, 0, 0.4, -0.12, { radial: 8, rx: 0.5, wear: 1 });
  p.cyl(0.045, 0.55, 0, 0.27, -0.22, { radial: 8, grime: 0.4 });
  p.box(0.24, 0.03, 0.24, 0, 0.02, -0.22, { bevel: 0.005, grime: 0.6 });
  p.cyl(0.028, 0.16, 0, 0.62, 0.34, { radial: 6, rx: 1.1, wear: 1 });
  return p.build();
}

function waterTank(rng) {
  const p = new PB();
  p.cyl(0.55, 1.0, 0, 0.5, 0, { radial: 18, grime: 0.3 });
  p.cyl(0.56, 0.05, 0, 0.99, 0, { radial: 18, wear: 1 });
  p.cyl(0.18, 0.09, 0.16, 1.05, 0, { radial: 12, wear: 1 });
  p.cyl(0.03, 0.5, -0.5, 0.2, 0, { radial: 6, grime: 0.5, rz: 0.3 });
  // cradle
  for (const sz of [-1, 1]) p.box(1.2, 0.09, 0.09, 0, 0.045, sz * 0.36, { grime: 0.5 });
  return p.build();
}

function roofVent(rng) {
  const p = new PB();
  p.box(0.5, 0.3, 0.5, 0, 0.15, 0, { bevel: 0.01, grime: 0.4 });
  p.cyl(0.17, 0.36, 0, 0.48, 0, { radial: 12, grime: 0.3 });
  p.cyl(0.24, 0.06, 0, 0.68, 0, { radial: 12, wear: 1 });
  p.cyl(0.2, 0.05, 0, 0.74, 0, { radial: 12, taper: 0.3, wear: 1 });
  return p.build();
}

function streetLamp(rng, h = 5.4) {
  const p = new PB();
  p.cyl(0.13, 0.35, 0, 0.17, 0, { radial: 12, grime: 0.6 });
  p.cyl(0.075, h, 0, h / 2, 0, { radial: 10, taper: 0.7, grime: 0.25 });
  // Curved arm made of short segments, with a diagonal stay back to the post.
  // The stay matters: without it the head is a box floating a metre off the
  // column, and the moment the column is occluded by a roofline the whole lamp
  // reads as a detached prop hanging in the sky.
  const segs = 5;
  for (let i = 0; i < segs; i++) {
    const t = i / (segs - 1);
    const a = t * 1.35;
    p.cyl(0.055, 0.44, Math.sin(a) * 0.62 * (0.4 + t), h - 0.1 + Math.cos(a) * 0.34 * t, 0, {
      radial: 8,
      rz: -a,
      grime: 0.3,
    });
  }
  p.cyl(0.028, 0.95, 0.32, h - 0.42, 0, { radial: 6, rz: -0.72, grime: 0.4 });
  p.box(0.1, 0.16, 0.1, 0.05, h - 0.72, 0, { bevel: 0.01, grime: 0.45 });
  p.box(0.5, 0.13, 0.28, 0.86, h + 0.06, 0, { bevel: 0.02, rz: -0.16, grime: 0.35 });
  p.box(0.42, 0.06, 0.22, 0.88, h - 0.02, 0, { bevel: 0.01, rz: -0.16, wear: 1 });
  return p.build();
}

/** The lamp's diffuser, kept separate so it can use a glassy material. */
function lampGlass() {
  const g = chamferBox(0.4, 0.05, 0.2, 0.01);
  fillMasks(g, 0.2, 0.1, 0);
  return g;
}

/**
 * A wall-bracketed satellite dish.
 *
 * `satDish` is a MAST on a base plate: it stands on a roof. Bolting that to a
 * facade leaves a horizontal foot plate hanging in the air with nothing under
 * it, which is the loudest floating-prop tell on any of these buildings. This
 * is the wall version — a back plate that lies flat on the render, a short arm,
 * and the dish cantilevered off it. Authored with +Z pointing away from the
 * wall and the plate's back face at z = 0, so the seat plane is z = 0.
 */
function satDishWall(rng) {
  const p = new PB();
  // back plate: four bolts into the render, so it sits ON the wall
  p.box(0.16, 0.3, 0.03, 0, 0, 0.015, { bevel: 0.005, grime: 0.55 });
  for (const sy of [-1, 1]) p.cyl(0.014, 0.02, 0, sy * 0.11, 0.04, { radial: 6, rx: Math.PI / 2, wear: 1 });
  // arm out to the mount, with a diagonal stay: an arm alone bends visibly
  p.cyl(0.032, 0.36, 0, 0.02, 0.2, { radial: 8, rx: Math.PI / 2, grime: 0.35 });
  p.cyl(0.018, 0.3, 0, -0.09, 0.15, { radial: 6, rx: Math.PI / 2 - 0.8, grime: 0.4 });
  // the dish itself, offset azimuth like every real one
  const dish = new THREE.SphereGeometry(0.34, 14, 8, 0, Math.PI * 2, 0, 0.6);
  dish.scale(1, 0.4, 1);
  dish.rotateX(-2.35);
  dish.rotateY(0.3);
  autoEdgeWear(dish, 0.03, 0.8);
  p.geo(dish, 0, 0.04, 0.42, { autoWear: false, grime: 0.3 });
  // LNB on its arm, in front of the reflector
  p.cyl(0.02, 0.26, 0.03, -0.14, 0.5, { radial: 6, rx: 0.9, wear: 1 });
  p.cyl(0.032, 0.09, 0.03, -0.06, 0.61, { radial: 8, rx: 0.9, wear: 1 });
  return p.build();
}

/** Wall conduit / meter box. Small, but it is what makes a facade look serviced. */
function conduitBox(rng) {
  const p = new PB();
  p.box(0.2, 0.28, 0.11, 0, 0, 0.055, { bevel: 0.008, grime: 0.45 });
  p.box(0.17, 0.24, 0.02, 0, 0, 0.12, { thin: true, wear: 1 });
  // the conduit that leaves it, clipped into the wall above
  p.cyl(0.016, 0.34, 0.05, 0.3, 0.03, { radial: 6, grime: 0.5 });
  return p.build();
}

/** Cinder block — the universal building unit, and it stacks. */
function cinderBlock(rng) {
  const g = chamferBox(0.44, 0.21, 0.21, 0.012);
  paintMasks(g, (x, y, z, nx, ny, nz, out) => {
    out[0] = 0.7;
    out[1] = 0.3 + Math.max(0, -ny) * 0.5 + fbm3(x * 8, y * 8, z * 8, 2) * 0.2;
    out[2] = Math.max(0, -ny) * 0.4;
  });
  g.translate(0, 0.105, 0);
  return g;
}

/** A flat produce tray. Stacks under a stall and holds a `produce` heap. */
function produceTray(rng) {
  const p = new PB();
  p.box(0.6, 0.02, 0.42, 0, 0.01, 0, { thin: true, grime: 0.35 });
  for (const s of [-1, 1]) {
    p.box(0.6, 0.09, 0.02, 0, 0.055, s * 0.2, { thin: true, wear: 1 });
    p.box(0.02, 0.09, 0.42, s * 0.29, 0.055, 0, { thin: true, wear: 1 });
  }
  return p.build();
}

/** A lumpy heap of produce that sits in a tray or on a stall top. */
function produceHeap(rng) {
  const p = new PB();
  for (let i = 0; i < 7; i++) {
    const g = rockGeometry(rng, rng.range(0.055, 0.1), 0, 0.8);
    p.geo(g, rng.range(-0.22, 0.22), 0.035 + rng.range(0, 0.04), rng.range(-0.14, 0.14), {
      autoWear: false,
      grime: 0.15,
    });
  }
  const g = p.build();
  fillMasks(g, 0.15, 0.22, 0.1);
  return g;
}

/** Cheap plastic stool — one is outside every shop and on every roof. */
function stool(rng) {
  const p = new PB();
  p.box(0.34, 0.04, 0.34, 0, 0.42, 0, { bevel: 0.008, wear: 1, grime: 0.3 });
  for (const sx of [-1, 1])
    for (const sz of [-1, 1])
      p.box(0.035, 0.42, 0.035, sx * 0.13, 0.21, sz * 0.13, { thin: true, rz: sx * 0.06, grime: 0.4 });
  return p.build();
}

/**
 * A market sack: grain, cement or charcoal, slumped open at the neck. Uses the
 * same Lp-ball as a sandbag but stood on end, which is how a full sack sits.
 */
function marketSack(rng, h = 0.62) {
  const g = sackGeometry(rng, 0.42, h, 0.4, { variant: 1, box: 2.6, lump: 1.35, seg: 14, rings: 8 });
  // stand it up: the sack builder authors its long axis along X
  g.rotateZ(Math.PI / 2);
  paintMasks(g, (x, y, z, nx, ny, nz, out) => {
    const n = fbm3(x * 10, y * 10, z * 10, 2);
    out[0] = 0.3 + n * 0.4;
    out[1] = 0.25 + Math.max(0, -ny) * 0.5 + n * 0.2;
    out[2] = 0.12 + Math.max(0, -ny) * 0.45;
  });
  g.computeBoundingBox();
  g.translate(0, -g.boundingBox.min.y, 0);
  return g;
}

/**
 * A handcart. Every market has one parked against a wall: a plank bed on two
 * bicycle wheels with the shafts resting on the ground. Reads at 20 m purely on
 * the silhouette of the wheels and the tipped bed, so it is worth its 300
 * triangles.
 */
function handCart(rng) {
  const p = new PB();
  const L = 1.5;
  const W = 0.84;
  const bedY = 0.52;
  // bed planks with real gaps
  for (let i = 0; i < 5; i++) {
    const z = -W / 2 + (i + 0.5) * (W / 5);
    p.box(L, 0.026, W / 5 - 0.022, 0, bedY, z, { thin: true, grime: 0.4, rz: rng.range(-0.004, 0.004) });
  }
  // side boards and the tail board
  for (const sz of [-1, 1]) p.box(L, 0.17, 0.022, 0, bedY + 0.09, sz * (W / 2), { thin: true, grime: 0.35 });
  p.box(0.022, 0.17, W, -L / 2, bedY + 0.09, 0, { thin: true, grime: 0.35 });
  // chassis rails and the axle
  for (const sz of [-1, 1]) p.box(L, 0.05, 0.05, 0, bedY - 0.04, sz * (W / 2 - 0.06), { grime: 0.5 });
  p.cyl(0.022, W + 0.1, 0.05, bedY - 0.09, 0, { radial: 6, rx: Math.PI / 2, grime: 0.6 });
  // wheels, sunk to the axle
  for (const sz of [-1, 1]) {
    p.cyl(0.31, 0.06, 0.05, bedY - 0.09, sz * (W / 2 + 0.04), { radial: 14, rx: Math.PI / 2, grime: 0.5 });
    p.cyl(0.09, 0.09, 0.05, bedY - 0.09, sz * (W / 2 + 0.04), { radial: 8, rx: Math.PI / 2, wear: 1 });
  }
  // shafts, tipped down to rest on the ground the way a parked cart does
  for (const sz of [-1, 1]) {
    p.box(0.95, 0.05, 0.05, -L / 2 - 0.36, bedY - 0.2, sz * (W / 2 - 0.12), {
      rz: 0.42,
      grime: 0.45,
    });
  }
  p.box(0.05, 0.05, W - 0.2, -L / 2 - 0.75, bedY - 0.4, 0, { grime: 0.5 });
  const g = p.build();
  g.computeBoundingBox();
  g.translate(0, -g.boundingBox.min.y, 0);
  return g;
}

/**
 * A bicycle leaning on its stand. Two rings, a diamond frame and bars: 340
 * triangles for a prop that instantly says a person lives here. The tubes are
 * 6-sided because at 30 mm diameter nothing more ever resolves.
 */
function bicycle(rng) {
  const p = new PB();
  const R = 0.33;
  const wb = 1.02; // wheelbase
  const lean = 0.16; // resting against its stand
  for (const sx of [-1, 1]) {
    const wheel = new THREE.TorusGeometry(R, 0.022, 4, 14);
    wheel.rotateY(Math.PI / 2);
    autoEdgeWear(wheel, 0.02, 0.7);
    p.geo(wheel, (sx * wb) / 2, R, 0, { autoWear: false, grime: 0.35 });
    // hub and a token of spokes: three struts read as a wheel that has them
    p.cyl(0.028, 0.07, (sx * wb) / 2, R, 0, { radial: 6, rz: Math.PI / 2, wear: 1 });
    for (let i = 0; i < 3; i++) {
      p.box(0.012, R * 1.9, 0.012, (sx * wb) / 2, R, 0, { thin: true, rz: (i / 3) * Math.PI, wear: 1 });
    }
  }
  // diamond frame
  const tube = (len, x, y, z, rz2, ry2 = 0) =>
    p.cyl(0.016, len, x, y, z, { radial: 6, rz: rz2, ry: ry2, grime: 0.3, wear: 1 });
  tube(0.56, -0.06, 0.72, 0, 1.45); // top tube
  tube(0.6, -0.04, 0.45, 0, 1.15); // down tube
  tube(0.52, -0.34, 0.5, 0, 0.26); // seat tube
  tube(0.46, 0.3, 0.42, 0, -0.55); // chainstay / fork
  tube(0.5, 0.22, 0.62, 0, -0.2); // seat stay
  // fork, bars, saddle, crank
  tube(0.62, 0.46, 0.5, 0, -0.22);
  p.box(0.03, 0.03, 0.44, 0.5, 0.94, 0, { thin: true, wear: 1 });
  p.box(0.2, 0.05, 0.11, -0.32, 0.86, 0, { bevel: 0.012, grime: 0.4 });
  p.cyl(0.05, 0.03, -0.05, 0.28, 0, { radial: 8, rz: Math.PI / 2, wear: 1 });
  for (const sz of [-1, 1]) p.box(0.03, 0.16, 0.02, -0.05, 0.22, sz * 0.07, { thin: true, wear: 1 });
  const g = p.build();
  g.rotateZ(lean);
  g.computeBoundingBox();
  g.translate(0, -g.boundingBox.min.y, 0);
  return g;
}

/**
 * A shop fascia sign: the painted board over a shopfront, on two stand-off
 * brackets so it casts a shadow onto the render instead of lying on it.
 * Authored +Z outward with the bracket feet at z = 0 — that is the seat plane.
 */
function shopSign(rng, w = 2.2, h = 0.52) {
  const p = new PB();
  // brackets first: they are what the wall actually holds
  for (const sx of [-1, 1]) {
    p.box(0.05, 0.05, 0.14, sx * (w / 2 - 0.18), 0, 0.07, { thin: true, grime: 0.55 });
    p.box(0.04, h * 0.8, 0.03, sx * (w / 2 - 0.18), 0, 0.13, { thin: true, wear: 1 });
  }
  p.box(w, h, 0.05, 0, 0, 0.155, { bevel: 0.008, grime: 0.2 });
  // capping rails top and bottom, and a shallow raised panel on the face
  for (const sy of [-1, 1]) p.box(w + 0.05, 0.04, 0.08, 0, sy * (h / 2), 0.16, { thin: true, wear: 1 });
  p.box(w - 0.16, h - 0.14, 0.012, 0, 0, 0.187, { thin: true, wear: 1, grime: 0.15 });
  return p.build();
}

/**
 * A panelled door leaf, standing in its opening. Authored with the hinge stile
 * at -X, the face toward +Z and the bottom at y = 0.
 */
function doorLeaf(rng, w = 0.92, h = 2.05) {
  const p = new PB();
  p.box(w, h, 0.05, 0, h / 2, 0, { bevel: 0.006, grime: 0.35 });
  // rails and stiles standing proud, then two sunk panels between them
  for (const sy of [-1, 1]) p.box(w, 0.11, 0.062, 0, h / 2 + sy * (h / 2 - 0.08), 0, { thin: true, wear: 1 });
  p.box(w, 0.13, 0.062, 0, h * 0.46, 0, { thin: true, wear: 1 });
  for (const sx of [-1, 1]) p.box(0.1, h, 0.062, sx * (w / 2 - 0.05), h / 2, 0, { thin: true, wear: 1 });
  // handle and a lock plate
  p.cyl(0.02, 0.11, w / 2 - 0.15, h * 0.47, 0.055, { radial: 6, rz: Math.PI / 2, wear: 1 });
  p.box(0.05, 0.16, 0.012, w / 2 - 0.15, h * 0.47, 0.04, { thin: true, wear: 1 });
  return p.build();
}

/** Broken glass fanned out under a blown-out window. */
function glassShards(rng) {
  const p = new PB();
  for (let i = 0; i < 9; i++) {
    const s = 0.03 + rng.float() * 0.06;
    p.box(s, 0.004, s * rng.range(0.5, 1.6), rng.range(-0.5, 0.5), 0.003, rng.range(-0.4, 0.4), {
      thin: true,
      ry: rng.float() * 6.28,
      wear: 1,
    });
  }
  return p.build();
}

// ================================================================== debris ==
function brickChunk(rng) {
  const g = rockGeometry(rng, 0.22, 0, 0.55);
  paintMasks(g, (x, y, z, nx, ny, nz, out) => {
    out[0] = 0.5 + fbm3(x * 9, y * 9, z * 9, 2) * 0.5;
    out[1] = 0.4 + Math.max(0, -ny) * 0.4;
    out[2] = 0.25;
  });
  return g;
}

function slabShard(rng) {
  const p = new PB();
  const w = rng.range(0.5, 0.95);
  const d = rng.range(0.35, 0.7);
  const pts = [];
  const n = 7;
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const rr = 0.5 * (0.6 + fbm3(Math.cos(t) * 3 + 2, Math.sin(t) * 3, 5, 2) * 0.8);
    pts.push([Math.cos(t) * rr * w, Math.sin(t) * rr * d]);
  }
  const g = polyPrism(pts, rng.range(0.07, 0.13));
  autoEdgeWear(g, 0.02, 1);
  p.geo(g, 0, 0, 0, { autoWear: false, grime: 0.4 });
  // rebar sticking out, bent
  const bars = rng.int(2, 4);
  for (let i = 0; i < bars; i++) {
    const a = rng.float() * Math.PI * 2;
    p.cyl(0.008, rng.range(0.3, 0.7), Math.cos(a) * w * 0.3, 0.06, Math.sin(a) * d * 0.3, {
      radial: 5,
      rz: rng.range(-1.4, 1.4),
      rx: rng.range(-1.2, 1.2),
      grime: 0.5,
    });
  }
  return p.build();
}

function rebarBundle(rng) {
  const p = new PB();
  const n = rng.int(4, 7);
  for (let i = 0; i < n; i++) {
    p.cyl(0.009, rng.range(1.4, 2.6), rng.range(-0.08, 0.08), 0.012 + i * 0.019, rng.range(-0.06, 0.06), {
      radial: 5,
      rx: Math.PI / 2,
      ry: rng.range(-0.12, 0.12),
      grime: 0.55,
    });
  }
  return p.build();
}

function plank(rng) {
  const g = chamferBox(rng.range(0.9, 2.1), 0.035, rng.range(0.12, 0.2), 0.005);
  autoEdgeWear(g, 0.012, 1);
  warpGeometry(g, 0.012, 1.4, rng.float() * 9);
  paintMasks(g, (x, y, z, nx, ny, nz, out) => {
    out[1] = Math.min(1, out[1] + 0.3 + Math.max(0, -ny) * 0.4);
  });
  return g;
}

/**
 * The swept fillet of dust and grit that piles against anything left standing
 * on a street. Unit radius (put() scales it), 2.5 cm proud at the object and
 * feathering to nothing at the rim, with a jagged outline so it never reads as
 * a disc. Grime mask driven hard at the centre so the material's own cavity
 * grime darkens the contact line.
 */
function dustSkirt(rng) {
  // 3 rings x 16 segments = 96 triangles. This goes under a hundred props per
  // map, so the tessellation has to buy something: 3 rings is the fewest that
  // still gives the (1-d)^2 profile a shoulder rather than a straight cone.
  const RAD = 3;
  const SEG = 16;
  const g = new THREE.CylinderGeometry(1, 1, 0, SEG, RAD);
  const pa = g.getAttribute('position');
  const col = new Float32Array(pa.count * 3);
  for (let i = 0; i < pa.count; i++) {
    const x = pa.getX(i);
    const z = pa.getZ(i);
    const d = Math.min(1, Math.hypot(x, z));
    const a = Math.atan2(z, x);
    // ragged outline: the rim wanders +/-22%
    const wob = 0.86 + 0.28 * fbm3(Math.cos(a) * 2.2, Math.sin(a) * 2.2, 3.1, 3);
    const dd = d * wob;
    pa.setX(i, x * wob);
    pa.setZ(i, z * wob);
    // (1-d)^2 profile: steep against the object, flat at the edge
    const t = Math.max(0, 1 - dd);
    pa.setY(i, t * t * 0.021 + (fbm3(x * 6, z * 6, 9.4, 3) - 0.5) * 0.004 * (1 - dd));
    col[i * 3] = 0.05;
    col[i * 3 + 1] = 0.35 + 0.6 * t;
    col[i * 3 + 2] = 0.3 + 0.55 * t;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

function litterPaper(rng) {
  const g = new THREE.PlaneGeometry(rng.range(0.1, 0.22), rng.range(0.1, 0.28), 2, 2);
  const pa = g.getAttribute('position');
  for (let i = 0; i < pa.count; i++) {
    pa.setZ(i, (fbm3(pa.getX(i) * 20, pa.getY(i) * 20, 3, 2) - 0.5) * 0.035);
  }
  g.rotateX(-Math.PI / 2);
  g.computeVertexNormals();
  fillMasks(g, 0.3, 0.5, 0.2);
  return g;
}

function bottle(rng) {
  const p = new PB();
  p.cyl(0.038, 0.17, 0, 0.085, 0, { radial: 10, grime: 0.3 });
  p.cyl(0.02, 0.08, 0, 0.2, 0, { radial: 8, taper: 0.8 });
  return p.build();
}

function can(rng) {
  const g = new THREE.CylinderGeometry(0.033, 0.033, 0.115, 10, 1);
  autoEdgeWear(g, 0.01, 1);
  // crushed
  const pa = g.getAttribute('position');
  for (let i = 0; i < pa.count; i++) {
    const y = pa.getY(i);
    pa.setX(i, pa.getX(i) * (1 - Math.abs(y) * 1.2));
  }
  g.computeVertexNormals();
  g.rotateZ(1.4);
  g.translate(0, 0.033, 0);
  return g;
}

// ============================================================== vegetation ==
function palmTree(rng, h = 5.2) {
  const p = new PB();
  const segs = 9;
  const lean = rng.range(-0.1, 0.1);
  for (let i = 0; i < segs; i++) {
    const t = i / segs;
    const r = 0.19 * (1 - t * 0.42);
    const y = t * h;
    const x = Math.sin(t * 2.2 + lean * 4) * lean * h * 0.4;
    p.cyl(r, h / segs + 0.02, x, y + h / segs / 2, 0, {
      radial: 9,
      taper: 0.92,
      grime: 0.3 + t * 0.2,
      wear: 1,
    });
    // ring scars where old fronds broke off
    p.cyl(r * 1.13, 0.045, x, y + h / segs * 0.75, 0, { radial: 9, wear: 1, grime: 0.4 });
  }
  const topX = Math.sin(2.2 + lean * 4) * lean * h * 0.4;
  const g = p.build();
  g.userData = { topX, topY: h };
  return g;
}

/** One palm frond: leaflets along a curved spine, foliage-textured quads. */
function palmFrond(rng, len = 2.6) {
  const list = [];
  const n = 13;
  for (let i = 0; i < n; i++) {
    const t = (i + 1) / (n + 1);
    const x = t * len;
    const droop = -t * t * len * 0.42;
    const lw = (0.42 + Math.sin(t * Math.PI) * 0.55) * (1 - t * 0.35);
    for (const side of [-1, 1]) {
      const q = new THREE.PlaneGeometry(lw, 0.16, 1, 1);
      q.translate(lw / 2, 0, 0);
      const m = mat(x, droop, 0, 0, 0, 0);
      const rot = new THREE.Matrix4().makeRotationZ(-0.5 - t * 0.5);
      const yaw = new THREE.Matrix4().makeRotationY(side * (1.15 - t * 0.35));
      q.applyMatrix4(rot);
      q.applyMatrix4(yaw);
      q.applyMatrix4(m);
      fillMasks(q, 0.2, 0.25, 0);
      list.push(q);
    }
  }
  // spine
  const spine = new THREE.PlaneGeometry(len, 0.05, 6, 1);
  const pa = spine.getAttribute('position');
  for (let i = 0; i < pa.count; i++) {
    const x = pa.getX(i) + len / 2;
    pa.setXYZ(i, x, pa.getY(i) - ((x / len) ** 2) * len * 0.42, pa.getZ(i));
  }
  spine.computeVertexNormals();
  fillMasks(spine, 0.2, 0.3, 0);
  list.push(spine);
  const g = mergeSimple(list);
  for (const q of list) q.dispose();
  return g;
}

function shrub(rng, s = 0.8) {
  const list = [];
  const n = 7;
  for (let i = 0; i < n; i++) {
    const q = new THREE.PlaneGeometry(s * rng.range(0.7, 1.15), s * rng.range(0.6, 1.0), 1, 1);
    const m = mat(
      rng.range(-s * 0.2, s * 0.2),
      s * rng.range(0.28, 0.6),
      rng.range(-s * 0.2, s * 0.2),
      rng.float() * Math.PI,
      rng.range(-0.4, 0.4),
      rng.range(-0.3, 0.3)
    );
    q.applyMatrix4(m);
    fillMasks(q, 0.2, 0.35, 0.2);
    list.push(q);
  }
  const g = mergeSimple(list);
  for (const q of list) q.dispose();
  return g;
}

function weedTuft(rng) {
  const list = [];
  const n = 4;
  for (let i = 0; i < n; i++) {
    const q = new THREE.PlaneGeometry(rng.range(0.18, 0.34), rng.range(0.14, 0.3), 1, 1);
    q.applyMatrix4(
      mat(rng.range(-0.06, 0.06), rng.range(0.07, 0.17), rng.range(-0.06, 0.06), rng.float() * 3.14, rng.range(-0.5, 0.5), 0)
    );
    fillMasks(q, 0.2, 0.5, 0.3);
    list.push(q);
  }
  const g = mergeSimple(list);
  for (const q of list) q.dispose();
  return g;
}

function planter(rng) {
  const p = new PB();
  p.cyl(0.34, 0.42, 0, 0.21, 0, { radial: 14, taper: 0.78, grime: 0.4 });
  p.cyl(0.36, 0.05, 0, 0.42, 0, { radial: 14, wear: 1 });
  p.cyl(0.3, 0.06, 0, 0.4, 0, { radial: 12, grime: 0.9 });
  return p.build();
}

// ================================================================= signage ==
function signBoard(rng, w = 1.5, h = 0.5) {
  const p = new PB();
  p.box(w, h, 0.05, 0, 0, 0, { bevel: 0.008, grime: 0.25 });
  p.box(w + 0.05, 0.045, 0.07, 0, h / 2, 0, { bevel: 0.006, wear: 1 });
  p.box(w + 0.05, 0.045, 0.07, 0, -h / 2, 0, { bevel: 0.006, wear: 1 });
  for (const sx of [-1, 1]) p.box(0.03, 0.24, 0.12, sx * (w / 2 - 0.12), 0, -0.08, { grime: 0.5 });
  return p.build();
}

/**
 * A shop sign hung off a bracket ARM, square to the facade so it is legible
 * from down the street rather than only from directly in front of the shop.
 *
 * It used to be a board on a horizontal bar with nothing at either end of the
 * bar: hung on a wall that reads as a sign floating beside the building. The
 * arm now starts at a back plate on the wall plane (z = 0, the seat) and is
 * triangulated by a stay, which is how a real bracket carries the moment.
 */
function signHanging(rng, w = 0.78, h = 0.54) {
  const p = new PB();
  p.box(0.1, 0.24, 0.03, 0, 0.02, 0.015, { thin: true, grime: 0.55 });
  p.cyl(0.018, 0.72, 0, 0.1, 0.36, { radial: 6, rx: Math.PI / 2, wear: 1, grime: 0.4 });
  p.cyl(0.012, 0.42, 0, -0.06, 0.19, { radial: 5, rx: Math.PI / 2 - 0.75, wear: 1, grime: 0.5 });
  for (const s of [-1, 1]) p.cyl(0.009, 0.14, 0, 0.04, 0.36 + s * (w / 2 - 0.1), { radial: 5, wear: 1 });
  p.box(0.03, h, w, 0, -0.03 - h / 2, 0.36, { thin: true, grime: 0.3 });
  for (const sy of [-1, 1]) p.box(0.05, 0.035, w + 0.04, 0, -0.03 - h / 2 + sy * (h / 2), 0.36, { thin: true, wear: 1 });
  return p.build();
}

// ================================================================ vehicles ==
/**
 * A burnt-out saloon. Built as one merged geometry per material group and
 * returned so the caller can place one or two — silhouette first: sagging roof,
 * blown glass, missing wheels, doors hanging.
 */
export function burntCar(rng) {
  const body = new PB();
  const L = 4.35;
  const W = 1.78;
  // main body tub
  body.box(W, 0.5, L, 0, 0.62, 0, { bevel: 0.05, grime: 0.5 });
  body.box(W * 0.99, 0.34, L * 0.62, 0, 0.95, -0.15, { bevel: 0.06, grime: 0.5 });
  // bonnet + boot
  body.box(W * 0.94, 0.13, L * 0.3, 0, 0.94, L * 0.33, { bevel: 0.03, rx: 0.06, wear: 1 });
  body.box(W * 0.94, 0.13, L * 0.22, 0, 0.95, -L * 0.38, { bevel: 0.03, rx: -0.08, wear: 1 });
  // cabin: A/B/C pillars and a sagging roof
  const rh = 1.42;
  for (const sx of [-1, 1]) {
    body.box(0.09, 0.55, 0.1, sx * (W / 2 - 0.08), 1.2, L * 0.14, { rx: 0.35, grime: 0.4 });
    body.box(0.09, 0.5, 0.1, sx * (W / 2 - 0.08), 1.22, -L * 0.02, { grime: 0.4 });
    body.box(0.11, 0.52, 0.12, sx * (W / 2 - 0.08), 1.2, -L * 0.2, { rx: -0.3, grime: 0.4 });
    // sills and door skins
    body.box(0.07, 0.42, L * 0.42, sx * (W / 2 - 0.03), 0.68, 0.05, { bevel: 0.02, wear: 1, grime: 0.5 });
  }
  body.box(W * 0.86, 0.07, L * 0.36, 0, rh - 0.04, -L * 0.04, { bevel: 0.04, wear: 1, grime: 0.6 });
  // wheel arches
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      body.cyl(0.42, 0.1, sx * (W / 2 - 0.04), 0.5, sz * L * 0.31, {
        radial: 12,
        rz: Math.PI / 2,
        open: true,
        grime: 0.5,
      });
    }
  // bumpers
  body.box(W * 0.98, 0.22, 0.16, 0, 0.5, L / 2 - 0.05, { bevel: 0.03, wear: 1, grime: 0.5 });
  body.box(W * 0.98, 0.22, 0.16, 0, 0.5, -L / 2 + 0.05, { bevel: 0.03, wear: 1, grime: 0.5, rz: 0.05 });
  const g = body.build();
  paintMasks(g, (x, y, z, nx, ny, nz, out) => {
    // soot: heaviest around the cabin and upward faces
    const soot = 0.45 + 0.5 * Math.max(0, ny) + 0.3 * Math.max(0, 1 - Math.abs(z) / 1.6);
    out[1] = Math.min(1, out[1] + soot * 0.8);
    out[0] = Math.min(1, out[0] * 0.8);
  });
  return g;
}

// =============================================================== registry ==
/**
 * Register every instanced prototype. Called once, before the level is built.
 * Prototype ids are the vocabulary dressing.js and interiors.js draw from.
 */
/**
 * The catalogue.
 *
 * Tiny Strike merges its set dressing into one mesh per material rather than
 * instancing prototypes, so this exposes the builders directly. Each entry is
 * `[surfaceKey, build(rng), anchors?]` where the key is a Tiny Strike map
 * material name (see src/world/surfaces.js).
 *
 * `anchors` is how a prop tells the placement code where it TOUCHES the world,
 * and it is the whole floating-prop defence:
 *
 *   baseY  the local Y that must land on the ground. Defaults to the geometry's
 *          own bounding-box floor, which is right for everything modelled with
 *          its origin at its base — so a prop is seated by measurement, not by
 *          a magic number at the call site that goes stale the moment the model
 *          changes. (This is exactly how tyres ended up floating 10 cm: the
 *          model was fixed to sit on its origin and the +0.10 lift at the call
 *          site stayed.)
 *   seatZ  the local Z that must land ON THE WALL PLANE, for wall fittings.
 *          Defaults to the bounding-box back. Override it wherever part of the
 *          prop is MEANT to disappear into the masonry — an air conditioner's
 *          brackets, a bolt shank — because otherwise the box the brackets
 *          reach into pushes the whole unit out into the street.
 *
 * Wall props are authored with +Z pointing away from the wall.
 */
export const PROPS = {
  // containers
  crate_a: ['crate', (r) => crate(r, 0.64)],
  crate_b: ['crateDark', (r) => crate(r, 0.48)],
  crate_c: ['crate', (r) => crate(r, 0.82)],
  crate_flat: ['crateDark', (r) => crate(r, 0.55, false)],
  box_card_a: ['crate', (r) => cardboardBox(r, 0.46)],
  box_card_b: ['crateDark', (r) => cardboardBox(r, 0.34)],
  barrel_rust: ['barrelRed', (r) => barrel(r)],
  barrel_blue: ['accentB', (r) => barrel(r, 0.28, 0.9, 2)],
  barrel_wood: ['crateDark', (r) => barrel(r, 0.31, 0.78, 4)],
  gas_bottle: ['barrel', (r) => gasBottle(r)],
  bucket: ['metalDark', (r) => bucket(r)],
  jerry_can: ['barrel', (r) => jerryCan(r)],
  cinder: ['trim', (r) => cinderBlock(r)],
  sack: ['sandbag', (r) => marketSack(r)],
  tray: ['crate', (r) => produceTray(r)],
  produce: ['foliage', (r) => produceHeap(r)],

  // cover
  sandbag_a: ['sandbag', (r) => sandbag(r, 0)],
  sandbag_b: ['sandbag', (r) => sandbag(r, 1)],
  sandbag_c: ['sandbag', (r) => sandbag(r, 2)],
  jersey: ['trim', (r) => jerseyBarrier(r)],
  block_big: ['trim', (r) => concreteBlock(r, 1.25, 0.95, 0.85)],
  block_small: ['stoneDark', (r) => concreteBlock(r, 0.55, 0.42, 0.4)],
  tyre: ['rubber', (r) => tyre(r)],
  tyre_small: ['rubber', (r) => tyre(r, 0.26)],
  pallet: ['crate', (r) => pallet(r)],

  // furniture / market
  table: ['crateDark', (r) => table(r, 1.5, 0.78, 0.8)],
  table_small: ['crate', (r) => table(r, 0.9, 0.72, 0.7)],
  stall: ['crateDark', (r) => stall(r, 2.3)],
  shelf: ['crateDark', (r) => shelfUnit(r)],
  chair: ['crate', (r) => chair(r)],
  stool: ['crate', (r) => stool(r)],
  cabinet: ['crateDark', (r) => cabinet(r)],
  mattress: ['sandbag', (r) => mattress(r)],

  // vehicles
  handcart: ['crateDark', (r) => handCart(r)],
  bicycle: ['metalDark', (r) => bicycle(r)],

  // services
  ac_unit: ['metalDark', (r) => acUnit(r), { seatZ: -0.17 }],
  sat_dish: ['metalDark', (r) => satDish(r)],
  sat_dish_wall: ['metalDark', (r) => satDishWall(r), { seatZ: 0 }],
  conduit_box: ['metalDoor', (r) => conduitBox(r), { seatZ: 0 }],
  water_tank: ['accentB', (r) => waterTank(r)],
  roof_vent: ['metalGrid', (r) => roofVent(r)],
  lamp_post: ['metalDark', (r) => streetLamp(r)],
  lamp_glass: ['neonA', () => lampGlass()],

  // debris
  brick_a: ['stoneDark', (r) => brickChunk(r)],
  slab_shard: ['trim', (r) => slabShard(r)],
  rebar: ['barrelRed', (r) => rebarBundle(r)],
  plank_a: ['crate', (r) => plank(r)],
  plank_b: ['crateDark', (r) => plank(r)],
  litter: ['crate', (r) => litterPaper(r)],
  bottle: ['glass', (r) => bottle(r)],
  can: ['metalDark', (r) => can(r)],
  glass_shards: ['glass', (r) => glassShards(r)],
  dust_skirt: ['ground', (r) => dustSkirt(r)],

  // vegetation
  palm_trunk: ['wood', (r) => palmTree(r, 5.4)],
  palm_frond: ['foliage', (r) => palmFrond(r, 2.7)],
  shrub: ['foliage', (r) => shrub(r, 0.85)],
  weeds: ['foliage', (r) => weedTuft(r)],
  planter: ['trim', (r) => planter(r)],

  // signage and openings
  sign_board: ['accentB', (r) => signBoard(r, 1.6, 0.55), { seatZ: -0.14 }],
  sign_shop: ['accentA', (r) => shopSign(r, 2.2, 0.52), { seatZ: 0 }],
  sign_hang: ['accentA', (r) => signHanging(r), { seatZ: 0 }],
  door_leaf: ['metalDoor', (r) => doorLeaf(r), { seatZ: 0 }],
};

/**
 * Build one prop and measure it.
 *
 * @returns {null|{key:string, geo:THREE.BufferGeometry, baseY:number,
 *   seatZ:number, top:number, radius:number, box:THREE.Box3}}
 *   `baseY`/`seatZ` are the local ground and wall contact planes (see PROPS),
 *   `top` is the local Y of the highest vertex — what a caller stacks on —
 *   and `radius` is the footprint half-diagonal, for the overlap test.
 */
export function buildProp(id, rng) {
  const entry = PROPS[id];
  if (!entry) return null;
  const geo = entry[1](rng);
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const anchors = entry[2];
  return {
    key: entry[0],
    geo,
    baseY: anchors?.baseY ?? bb.min.y,
    seatZ: anchors?.seatZ ?? bb.min.z,
    top: bb.max.y,
    radius: Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z) * 0.5,
    box: bb,
  };
}
