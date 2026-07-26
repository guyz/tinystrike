// ============================================================================
// TINY STRIKE — set dressing.
//
// The maps are authored as axis-aligned boxes (spec rule 7) because that is
// what the collision, the nav graph and the bot tactics are validated against.
// This pass reads those boxes back and builds everything a box cannot express —
// copings, plinths, pilasters, windows, doorways, shopfronts, balconies,
// drainpipes, roof plant, market stalls, laundry, kerbs, drifts, rubble,
// cables, signage — as NON-COLLIDING geometry.
//
// Nothing here touches `world.colliders`, `world.waypoints` or any spawn, so
// gameplay is bit-identical with dressing on or off. Everything is merged into
// one mesh per material, so a fully dressed arena costs ~20 extra draw calls.
//
// It is also fully deterministic: seeded off the map id, no Math.random, so two
// players in the same room see the same street. Each pass draws from its own
// forked stream, so editing one pass does not re-roll the whole level.
//
// ----------------------------------------------------------------------------
// THE GROUNDING CONTRACT — read this before adding anything
//
// Every defect this file has ever shipped has been a prop that did not touch
// what it was standing on or bolted to. Three rules, all enforced by helpers
// rather than by numbers typed at the call site:
//
//  1. Anything on the ground goes through `groundProp()`, which finds the
//     surface with `standing()` and seats the prop on its OWN measured base
//     plane (`buildProp().baseY`). No call site ever names a height.
//  2. Anything on a wall goes through `wallProp()`, which puts the prop's own
//     seat plane (`buildProp().seatZ`) exactly on the wall face, and only after
//     `backedByWall()` proves there is masonry behind it across its whole width
//     — a face being "exposed" says nothing about whether an archway, a door
//     opening or a setback has left daylight where the bracket would go.
//  3. Anything stacked goes on the measured top of what is under it
//     (`buildProp().top`), never on a nominal size.
//  4. Anything bolted to a wall reserves the patch of render it covers
//     (`claimWall`) and checks it first (`wallFree`), exactly as ground props
//     reserve a footprint disc. Without it two passes that each ask "is there
//     wall behind me?" both answer yes and an awning ends up through a
//     signboard — which is what the Citadel review found in four bays.
//  5. Anything the weather is the reason for — an awning, a canopy, a market
//     stall — needs sky above it (`openSky`). A market awning inside a roofed
//     customs hall was the loudest "procedural" tell on Harbor.
// ============================================================================
import * as THREE from 'three';
import { Rng } from '../gfx/kit/rng.js';
import { buildProp } from '../gfx/kit/props.js';
import {
  Accum,
  chamferBox,
  plainBox,
  quad,
  newTrs,
  rockGeometry,
  driftBerm,
  patchGeometry,
  catenaryTube,
  tubeY,
  clothGeometry,
  fillMasks,
  runoffStreak,
} from '../gfx/kit/util.js';

// A face of a building mass, in world space. `yaw` is the rotation that maps a
// prop's local +Z (which is the direction every wall prop is authored to face)
// onto this face's outward normal.
const FACES = [
  { axis: 'x', sign: -1, nx: -1, nz: 0, yaw: -Math.PI / 2 },
  { axis: 'x', sign: 1, nx: 1, nz: 0, yaw: Math.PI / 2 },
  { axis: 'z', sign: -1, nx: 0, nz: -1, yaw: Math.PI },
  { axis: 'z', sign: 1, nx: 0, nz: 1, yaw: 0 },
];

// Sampling cross for the ground test: centre plus the four footprint extremes.
const CROSS = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];

// Dustyard is the one arena with no map definition (it is built in code), and
// its playable extent is the one quoted at the top of map.js.
const LEGACY_BOUNDS = { x0: -50, x1: 50, z0: -40, z1: 40 };

/**
 * Batches detail geometry by material key and merges each bucket once.
 *
 * Every geometry carries the wear/grime/AO vertex masks the material shader
 * reads (r = edge wear, g = grime, b = extra AO), which is what puts dirt in
 * the reveals and bright metal on the chamfers.
 */
class Dresser {
  constructor(world, rng, theme) {
    this.world = world;
    this.rng = rng;
    this.theme = theme;
    this.batches = new Map();
    this.cache = new Map();
    this.tris = 0;
    this.props = 0;
    // Footprint discs already taken by a prop, so nothing is ever placed inside
    // something else. Linear scan: a full map claims ~700 discs, which is a
    // quarter of a millisecond over the whole build.
    this.claims = [];
    // The same idea for walls: patches of render already carrying a fitting,
    // keyed by mass + face, each entry [u0, u1, y0, y1] in face coordinates.
    this.wallClaims = new Map();
    // How many of each prop id the map has spent, for `quota`.
    this.used = new Map();
  }

  _faceKey(mass, f) {
    return `${mass.index}:${f.axis}${f.sign}`;
  }

  /**
   * Is this patch of a wall face free?
   *
   * `backedByWall` proves there is masonry behind a fitting; it says nothing
   * about what is already screwed to the front of it. Every pass that hangs
   * something on a facade computes its own bay rhythm, so two of them landing
   * on the same 40 cm of render is the normal case, not the unlucky one: the
   * Citadel review found an awning through a signboard, a signboard pierced by
   * its neighbour's awning, and a window overlapping a pilaster. `pad` is the
   * clear air a fitting needs around it — 6 cm, the thickness of the frame
   * mouldings, so two fittings never share an edge.
   */
  wallFree(mass, f, u, halfWidth, y0, y1, pad = 0.06) {
    const list = this.wallClaims.get(this._faceKey(mass, f));
    if (!list) return true;
    const a0 = u - halfWidth - pad;
    const a1 = u + halfWidth + pad;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (a1 > c[0] && a0 < c[1] && y1 + pad > c[2] && y0 - pad < c[3]) return false;
    }
    return true;
  }

  claimWall(mass, f, u, halfWidth, y0, y1) {
    const key = this._faceKey(mass, f);
    let list = this.wallClaims.get(key);
    if (!list) this.wallClaims.set(key, (list = []));
    list.push([u - halfWidth, u + halfWidth, y0, y1]);
  }

  /**
   * Spend one of a prop id's allowance, or refuse.
   *
   * Four sightings of the same bicycle — two of them in one frame — was the
   * clearest "procedurally scattered" tell in the Harbor review. A scatter pass
   * has no memory of what it has already placed, so the distinctive props need
   * a ration; the anonymous ones (bricks, cans, crates) do not.
   */
  quota(id, max) {
    const n = this.used.get(id) ?? 0;
    if (n >= max) return false;
    this.used.set(id, n + 1);
    return true;
  }

  /** Cache a geometry that is instanced many times (a window bar, a pipe). */
  geo(key, build) {
    let g = this.cache.get(key);
    if (!g) this.cache.set(key, (g = build()));
    return g;
  }

  add(matKey, geometry, matrix, masks) {
    let a = this.batches.get(matKey);
    if (!a) this.batches.set(matKey, (a = new Accum(`decor:${matKey}`)));
    a.add(geometry, matrix, masks ? { masks } : null);
    return this;
  }

  /**
   * Axis-aligned box helper: the workhorse for trims, sills and frames.
   *
   * `thin` swaps the 44-triangle chamfered box for a 12-triangle plain one.
   * Balusters, mullions, slats and grille bars are tens of thousands of boxes
   * per map and their 4 mm chamfer never resolves — that switch alone is worth
   * more triangles than every prop added in this pass.
   */
  box(matKey, x, y, z, sx, sy, sz, opts = {}) {
    const masks = opts.masks ?? [0.35, 0.5, 0.25];
    if (opts.thin ?? Math.min(sx, sy, sz) < 0.06) {
      this.add(matKey, this.geo('box:plain', () => plainBox()),
        newTrs(x, y, z, opts.ry ?? 0, sx, sy, sz, opts.rx ?? 0, opts.rz ?? 0), masks);
      return this;
    }
    const bevel = opts.bevel ?? 0.012;
    // chamferBox is authored at unit size, so a non-uniform scale would scale
    // the chamfer with it. For anything with a strong aspect ratio, build the
    // real size instead — the bevel is the whole point of the primitive.
    const strong = Math.max(sx, sy, sz) / Math.max(1e-3, Math.min(sx, sy, sz)) > 6;
    const geometry = strong
      ? chamferBox(sx, sy, sz, bevel)
      : this.geo(`box:${bevel}`, () => chamferBox(1, 1, 1, bevel));
    const m = strong
      ? newTrs(x, y, z, opts.ry ?? 0, 1, 1, 1, opts.rx ?? 0, opts.rz ?? 0)
      : newTrs(x, y, z, opts.ry ?? 0, sx, sy, sz, opts.rx ?? 0, opts.rz ?? 0);
    this.add(matKey, geometry, m, masks);
    if (strong) geometry.dispose?.();
    return this;
  }

  /** Is this footprint free of every prop already placed? */
  free(x, z, radius) {
    for (let i = 0; i < this.claims.length; i++) {
      const c = this.claims[i];
      const dx = x - c[0];
      const dz = z - c[1];
      const r = radius + c[2];
      if (dx * dx + dz * dz < r * r) return false;
    }
    return true;
  }

  claim(x, z, radius) {
    this.claims.push([x, z, radius]);
  }

  finish() {
    const world = this.world;
    for (const [matKey, accum] of this.batches) {
      if (accum.empty) continue;
      this.tris += accum.tris;
      const geometry = accum.build();
      const mesh = new THREE.Mesh(geometry, world.decorMaterial(matKey));
      mesh.name = `decor:${matKey}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      world.environment.add(mesh);
    }
    for (const g of this.cache.values()) g.dispose?.();
    this.cache.clear();
    this.batches.clear();
  }
}

// ---------------------------------------------------------------- queries --

/**
 * Is this point inside any collider other than `skip`?
 *
 * `margin` inflates the box HORIZONTALLY only. It used to inflate Y as well,
 * and that single line disabled most of this file: every arena has a ground
 * slab spanning y ∈ [-1, 0], so a probe at y = 0.2 with a 0.56 m footprint
 * margin reported "inside the ground" and the caller gave up. Measured over
 * 5000 in-bounds points per map, the drift/rubble pass, the free-debris
 * scatter, the shopfronts, the market rows, the barriers, the pallets and the
 * vegetation all accepted ZERO placements on every map. A footprint radius is a
 * horizontal quantity; the vertical extent of the prop is tested separately, by
 * probing the column it will occupy.
 */
function occupied(world, x, y, z, skip, margin = 0) {
  const cols = world.colliders;
  for (let i = 0; i < cols.length; i++) {
    if (i === skip) continue;
    const c = cols[i];
    if (
      x > c.min.x - margin && x < c.max.x + margin &&
      z > c.min.z - margin && z < c.max.z + margin &&
      y > c.min.y && y < c.max.y
    ) return true;
  }
  return false;
}

/** Highest collider top under (x,z), i.e. what a prop would stand on. */
function groundAt(world, x, z, below = 100) {
  let y = 0;
  const cols = world.colliders;
  for (let i = 0; i < cols.length; i++) {
    const c = cols[i];
    if (x > c.min.x && x < c.max.x && z > c.min.z && z < c.max.z) {
      if (c.max.y <= below && c.max.y > y) y = c.max.y;
    }
  }
  return y;
}

/** The arena's playable rectangle. Nothing is dressed outside it. */
function boundsOf(world) {
  return world.mapDefinition ? world.mapDefinition.bounds : LEGACY_BOUNDS;
}

function inBounds(world, x, z, inset = 0) {
  const b = boundsOf(world);
  return x > b.x0 + inset && x < b.x1 - inset && z > b.z0 + inset && z < b.z1 - inset;
}

/**
 * Where a prop can actually stand — the one function every ground placement
 * must go through.
 *
 * Sampling the surface at a single point is not enough, and assuming y = 0 is
 * worse. These maps are full of floor pads, 2 m bomb-site platforms, ramps,
 * stair treads and catwalks, so a prop dropped at y = 0 is buried whenever it
 * lands on a platform, and one placed at the platform's height floats the
 * moment its footprint hangs over the edge.
 *
 * So: sample the support under five points across the footprint, demand they
 * agree to within a centimetre or two (that is what rejects ledges, kerbs,
 * stair treads and the lip of a pad), then sweep the COLUMN the prop will
 * occupy for anything solid. Sweeping matters: one probe at ankle height walks
 * straight under a lintel, and one at head height misses a kerb.
 *
 * @returns {number|null} the surface height, or null if the spot is unusable
 */
/**
 * How far this point is from the nearest walked route, in metres.
 *
 * None of this dressing has a collider — that is the whole contract — so
 * anything tall standing in a lane is something the player walks straight
 * THROUGH, which is a worse artefact than the bare box it replaced. The nav
 * graph is exactly the map's own description of where people walk, so it is
 * the right thing to measure against: props may crowd the edges of a lane and
 * fill the dead corners, but nothing waist-high or taller may stand in one.
 *
 * Point-to-segment in XZ; the graph is ~70 nodes and this runs at load only.
 */
function navClearance(world, x, z) {
  const nodes = world.waypoints.nodes;
  const edges = world.waypoints.edges;
  if (!nodes.length) return Infinity;
  let best = Infinity;
  for (let i = 0; i < edges.length; i++) {
    const a = nodes[edges[i][0]].pos;
    const b = nodes[edges[i][1]].pos;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    let t = len2 > 1e-6 ? ((x - a.x) * dx + (z - a.z) * dz) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = x - (a.x + dx * t);
    const ez = z - (a.z + dz * t);
    const d = ex * ex + ez * ez;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

function standing(world, x, z, radius, height = 0.8, maxSurface = 2.6, lane = 0) {
  if (!inBounds(world, x, z, 0.4)) return null;
  // Tall props keep out of the lanes; ankle-height litter does not care.
  if (lane > 0 && navClearance(world, x, z) < lane) return null;
  const r = Math.max(0.05, radius * 0.72);
  let lo = Infinity;
  let hi = -Infinity;
  for (const [ox, oz] of CROSS) {
    const h = groundAt(world, x + ox * r, z + oz * r, maxSurface);
    if (h < lo) lo = h;
    if (h > hi) hi = h;
  }
  // A step of more than 2 cm across the footprint means part of the prop is
  // over a drop: that is exactly the "floating crate on the platform edge".
  if (hi - lo > 0.02) return null;
  const top = hi + Math.max(0.3, height);
  const step = Math.max(0.4, (top - hi) / 4);
  for (let y = hi + 0.1; y < top; y += step) {
    if (occupied(world, x, y, z, -1, radius * 0.8)) return null;
  }
  return hi;
}

/**
 * Is there solid wall behind this point, all the way up the run AND across the
 * fitting's width?
 *
 * A face being "exposed" only says there is open air in FRONT of it. It says
 * nothing about whether the wall itself exists at a given spot: these maps are
 * full of archways, door openings, window cuts and masses that step back, and a
 * drainpipe, balcony or air conditioner anchored across one of those hangs in
 * mid-air with daylight behind it — which is exactly what the eye picks out as
 * broken. Sampling only the centre line also misses the common case of a
 * 2.5 m balcony whose left half is over an arch.
 *
 * `depth` is how far INSIDE the face to probe. It has to be a real distance —
 * the old 0.18 m was within float noise of the face on a thin partition — but
 * it must not punch out the far side of that partition, so callers pass their
 * own wall's half-thickness.
 */
function backedByWall(world, x, z, nx, nz, yFrom, yTo, opts = {}) {
  const { halfWidth = 0, depth = 0.25, samples = 4 } = opts;
  const tx = -nz;
  const tz = nx;
  const across = halfWidth > 0.05 ? [-1, 0, 1] : [0];
  for (const s of across) {
    const ox = x - nx * depth + tx * s * halfWidth;
    const oz = z - nz * depth + tz * s * halfWidth;
    for (let i = 0; i <= samples; i++) {
      const y = yFrom + ((yTo - yFrom) * i) / samples;
      if (!occupied(world, ox, y, oz, -1)) return false;
    }
  }
  return true;
}

/** Is there room in front of a fitting — nothing solid, and inside the arena? */
function clearFor(world, x, z, radius, y = 0.5) {
  return inBounds(world, x, z, 0.2) && !occupied(world, x, y, z, -1, radius);
}

/**
 * Is there open sky above this point?
 *
 * An awning, a canopy, a market stall or a laundry line exists because of
 * weather; one of them under a roof is the kind of mistake that tells a player
 * the level was generated rather than built. Harbor had a market awning hanging
 * inside the roofed customs hall, and Dustyard a cloth fragment clipped into a
 * ceiling corner. The probe walks the column above the fitting in half-metre
 * steps: 9 m clears every interior in these maps (the tallest roofed span is
 * the customs hall at 5.2 m) without punching through the sky.
 */
function openSky(world, x, z, fromY) {
  for (let y = fromY + 0.35; y < fromY + 9; y += 0.5) {
    if (occupied(world, x, y, z, -1)) return false;
  }
  return true;
}

// ------------------------------------------------------------ map read-back --

/**
 * Read the map back as a list of building masses.
 *
 * `world.solids.children[i]` and `world.colliders[i]` are built in lockstep by
 * World.box(), so the index carries across and a mass knows which collider is
 * its own (and must be ignored by the exposure test).
 */
function massesOf(world) {
  const out = [];
  const meshes = world.solids.children;
  const b = boundsOf(world);
  const spanX = b.x1 - b.x0;
  const spanZ = b.z1 - b.z0;
  const keys = wallKeysOf(world);
  for (let i = 0; i < meshes.length; i++) {
    const mesh = meshes[i];
    if (!mesh.isMesh || mesh.geometry !== world._unitBox) continue; // skip barrels/columns
    const s = mesh.scale;
    const p = mesh.position;
    const y0 = p.y - s.y / 2;
    const y1 = p.y + s.y / 2;
    if (s.y < 2.2) continue;                 // crates, kerbs, rails, sandbags
    if (Math.min(s.x, s.z) < 0.4) continue;  // thin fences get their own pass
    if (y0 > 3.5) continue;                  // floating lintels and ceilings
    out.push({
      index: i, mesh, y0, y1,
      x: p.x, z: p.z, w: s.x, h: s.y, d: s.z,
      surface: mesh.userData.surface || 'concrete',
      // Raised to the top of the coping by dressMassShell, if this mass gets one.
      deckY: y1,
      // The arena's own boundary. Its outward faces are unreachable, and its
      // roof is a 100 m ribbon — both get dressed more cheaply than a building.
      perimeter: s.x > spanX * 0.6 || s.z > spanZ * 0.6,
      wallKey: keys ? keys[i] : null,
    });
  }
  return out;
}

/**
 * The map material key of each solid, so a stain can be drawn in the SAME
 * surface as the wall it runs down.
 *
 * The runoff the shader draws under a sill is `mix(albedo * 0.72, grime, 0.26)`
 * — it is the wall's own colour, darkened. Drawing it in some other key puts a
 * patch of the wrong material halfway down the facade, so it is worth being
 * exact. `buildDefinitionGeometry` emits `definition.solids` first and in
 * order, so index i of both lists is the same box; this verifies that box for
 * box and gives up entirely on the first disagreement rather than guessing.
 * Dustyard has no definition and falls back to the theme's nominated key.
 */
function wallKeysOf(world) {
  const def = world.mapDefinition;
  if (!def || !def.solids) return null;
  const meshes = world.solids.children;
  if (meshes.length < def.solids.length) return null;
  const keys = new Array(meshes.length).fill(null);
  for (let i = 0; i < def.solids.length; i++) {
    const [x0, x1, y0, y1, z0, z1, key] = def.solids[i];
    const m = meshes[i];
    if (
      !m.isMesh ||
      Math.abs(m.position.x - (x0 + x1) / 2) > 1e-3 ||
      Math.abs(m.position.y - (y0 + y1) / 2) > 1e-3 ||
      Math.abs(m.scale.x - (x1 - x0)) > 1e-3 ||
      Math.abs(m.scale.z - (z1 - z0)) > 1e-3
    ) return null;
    keys[i] = key;
  }
  return keys;
}

/** Which of a mass's four vertical faces have open, reachable air in front. */
function exposedFaces(world, mass) {
  const out = [];
  for (const f of FACES) {
    const half = f.axis === 'x' ? mass.w / 2 : mass.d / 2;
    const cx = mass.x + (f.axis === 'x' ? f.sign * (half + 0.7) : 0);
    const cz = mass.z + (f.axis === 'z' ? f.sign * (half + 0.7) : 0);
    // A face outside the arena is the back of the perimeter wall: no player can
    // ever see it, and dressing it used to cost a third of the facade budget.
    if (!inBounds(world, cx, cz, 0)) continue;
    // Sample along the face at three positions and three heights: a face that
    // is mostly buried in a neighbouring mass is not a facade, and a fitting at
    // 5 m needs evidence the air is clear up there too.
    let open = 0;
    let total = 0;
    const span = f.axis === 'x' ? mass.d : mass.w;
    for (let u = -1; u <= 1; u++) {
      const ox = f.axis === 'x' ? 0 : u * span * 0.32;
      const oz = f.axis === 'x' ? u * span * 0.32 : 0;
      for (const y of [1.2, Math.min(mass.y1 - 0.4, 3.0), Math.min(mass.y1 - 0.3, 5.4)]) {
        if (y < 0.6) continue;
        total++;
        if (!occupied(world, cx + ox, y, cz + oz, mass.index)) open++;
      }
    }
    if (total && open / total >= 0.5) out.push({ ...f, open: open / total });
  }
  return out;
}

/**
 * The bay rhythm of a facade, shared by every pass that puts something on it.
 *
 * Windows sit on the bay centres; services, signs and downpipes sit on the
 * PIERS between them. Both derive from this one function, which is what stops
 * an air conditioner landing on a window reveal — the defect that put a blue
 * box over a window on Dustyard, because the two passes were computing the same
 * interval independently and landing in phase.
 */
function baysOf(mass, f) {
  const span = f.axis === 'x' ? mass.d : mass.w;
  const half = f.axis === 'x' ? mass.w / 2 : mass.d / 2;
  const count = Math.max(1, Math.floor(span / 3.2));
  return {
    span,
    half,
    count,
    /** Centre of bay i, as an offset along the face. */
    centre: (i) => ((i + 0.5) / count - 0.5) * (span - 1.6),
    /** The pier between bay i and i+1. */
    pier: (i) => ((i + 1) / count - 0.5) * (span - 1.6),
    /** World position at face offset u, `out` metres proud of the face. */
    at: (u, out) => ({
      x: mass.x + (f.axis === 'x' ? f.sign * (half + out) : u),
      z: mass.z + (f.axis === 'z' ? f.sign * (half + out) : u),
    }),
  };
}

// ------------------------------------------------------------- placement --

/**
 * Place a prop with its ORIGIN at (x, y, z). Only for props that hang off
 * something — palm fronds off a crown, a lamp diffuser off its arm.
 * @returns {object|null} the measured prop record, or null if the id is unknown
 */
function putProp(d, id, x, y, z, ry, opts = {}) {
  const p = buildProp(id, d.rng);
  if (!p) return null;
  const s = opts.scale ?? 1;
  d.add(
    opts.mat ?? p.key,
    p.geo,
    newTrs(x, y, z, ry, s, s, s, opts.rx ?? 0, opts.rz ?? 0),
    opts.masks
  );
  p.geo.dispose();
  d.props++;
  return p;
}

/**
 * Place a prop STANDING on the surface `y`: its own base plane lands there.
 *
 * `opts.fit` is the footprint radius of whatever it is standing ON. A stack is
 * only a stack if each box is carried by the one under it: a 0.82 m crate on a
 * 1.16 x 0.98 m pallet overhangs it on all four sides, which the Citadel review
 * found twice and the Dustyard review once. 1.05 is the tolerance — a crate may
 * sit flush with the pallet edge, it may not cantilever off it.
 *
 * @returns {object|null} the prop record; `y + (p.top - p.baseY) * scale` is
 *   the real top, which is what anything stacked on it must use.
 */
function standProp(d, id, x, y, z, ry, opts = {}) {
  const p = buildProp(id, d.rng);
  if (!p) return null;
  const s = opts.scale ?? 1;
  if (opts.fit !== undefined && p.radius * s > opts.fit * 1.05) {
    p.geo.dispose();
    return null;
  }
  d.add(
    opts.mat ?? p.key,
    p.geo,
    newTrs(x, y - p.baseY * s + (opts.sink ?? 0), z, ry, s, s, s, opts.rx ?? 0, opts.rz ?? 0),
    opts.masks
  );
  p.geo.dispose();
  d.props++;
  p.worldTop = y + (p.top - p.baseY) * s;
  // What anything stacked on this needs: the deck's real half-width and yaw.
  p.fitRadius = p.radius * s;
  p.ry = ry;
  return p;
}

/**
 * Bolt a prop to a wall face: its own seat plane lands ON the face plane.
 *
 * The standoff comes from the model, not from a constant at the call site. A
 * fixed 0.22 m left an air gap behind every air conditioner, and a fixed 0.5 m
 * left the shop sign 36 cm clear of the render — both read as a box screwed to
 * nothing. Parts that are MEANT to disappear into the masonry (an AC's
 * brackets, a bolt shank) are excluded by the prop's declared `seatZ`.
 */
function wallProp(d, id, faceX, faceZ, y, f, opts = {}) {
  const p = buildProp(id, d.rng);
  if (!p) return null;
  const s = opts.scale ?? 1;
  const out = (opts.gap ?? 0) - p.seatZ * s;
  d.add(
    opts.mat ?? p.key,
    p.geo,
    newTrs(faceX + f.nx * out, y, faceZ + f.nz * out, f.yaw, s, s, s, opts.rx ?? 0, opts.rz ?? 0),
    opts.masks
  );
  p.geo.dispose();
  d.props++;
  return p;
}

/**
 * Place a prop on whatever surface is under (x, z), or refuse.
 *
 * Footprint radius and height default to the prop's MEASURED size, so a call
 * site never has to know how big a thing is — which is how a 2.3 m stall ended
 * up tested with a 1.1 m radius and pushed through a wall.
 *
 * @returns {object|null} the prop record with `worldTop` set, or null
 */
function groundProp(d, world, id, x, z, ry, opts = {}) {
  const probe = buildProp(id, d.rng);
  if (!probe) return null;
  const s = opts.scale ?? 1;
  const radius = opts.radius ?? Math.min(probe.radius * s, 1.6);
  const height = opts.height ?? (probe.top - probe.baseY) * s;
  const pack = radius * (opts.pack ?? 0.7);
  /**
   * Lane clearance, scaled to how much of a player's view the prop occupies.
   *
   * Nothing here has a collider, so a tall prop in a walked lane is something
   * the player walks THROUGH. Knee-height litter can sit anywhere — you barely
   * register stepping over it — but a 5 m palm or a market stall has to be out
   * of the route entirely. The threshold is the prop's own height: under 0.5 m
   * it is free, and above that it needs its own height in clearance, capped at
   * 2.6 m so a lamp post can still stand on a street corner.
   */
  const lane = opts.lane ?? (height < 0.5 ? 0 : Math.min(2.6, 0.6 + height * 0.55));
  const y = standing(world, x, z, radius, height, opts.maxSurface, lane);
  if (y === null || !d.free(x, z, pack)) {
    probe.geo.dispose();
    return null;
  }
  d.add(
    opts.mat ?? probe.key,
    probe.geo,
    newTrs(x, y - probe.baseY * s + (opts.sink ?? 0), z, ry, s, s, s, opts.rx ?? 0, opts.rz ?? 0),
    opts.masks
  );
  probe.geo.dispose();
  d.props++;
  d.claim(x, z, pack);
  probe.worldTop = y + (probe.top - probe.baseY) * s;
  probe.worldY = y;
  probe.fitRadius = probe.radius * s;
  probe.ry = ry;
  return probe;
}

/**
 * The swept fillet of dust and grit that piles against anything standing on a
 * street. Nothing in the real world meets the ground on a clean line, and this
 * is the cheapest grounding cue there is — 96 triangles that stop a crate
 * reading as a decal pasted onto the deck.
 */
function skirt(d, world, x, y, z, radius, key) {
  if (radius < 0.18) return;
  const g = buildProp('dust_skirt', d.rng);
  if (!g) return;
  const s = radius * d.rng.range(1.15, 1.5);
  d.add(key, g.geo, newTrs(x, y + 0.006, z, d.rng.float() * 6.28, s, 1, s), null);
  g.geo.dispose();
}

// ------------------------------------------------------------------ passes --

/**
 * Coping, plinth and pilasters.
 *
 * A 9 m box with a texture on it is a wall; the same box with a capping course
 * that oversails, a plinth that catches the ground dirt and a rhythm of shallow
 * pilasters is a building. This is the single highest-value pass in the file.
 */
function dressMassShell(d, world, mass, faces, theme) {
  const trim = theme.trimKey;
  // The coping doubles as the roof deck — it covers the whole top of the mass —
  // so it is the largest single surface this pass draws and it gets its own key.
  // A timber capping over mudbrick is right for Dustyard and wrong for a stone
  // fortress, where it read as a wooden band running the length of the ramparts.
  const cop = theme.copingKey ?? trim;

  // ---- coping: a capping course that oversails the wall on every open face
  if (mass.y1 > 2.5 && mass.y1 < 12) {
    // The coping IS the roof deck as far as anything standing up there is
    // concerned. A mass with no exposed face never gets one, and the roof pass
    // used to assume 0.22 m unconditionally — which left every water tank and
    // crate stack on an interior block hanging 22 cm over its own roof.
    mass.deckY = mass.y1 + 0.22;
    const over = 0.14;
    d.box(cop, mass.x, mass.y1 + 0.11, mass.z, mass.w + over * 2, 0.22, mass.d + over * 2, {
      bevel: 0.02, masks: [0.7, 0.3, 0.1],
    });
    // A second, thinner drip course under it reads as a cornice rather than a lid.
    d.box(cop, mass.x, mass.y1 - 0.10, mass.z, mass.w + over, 0.09, mass.d + over, {
      bevel: 0.014, masks: [0.5, 0.55, 0.35],
    });
    /**
     * Corbels under the oversail.
     *
     * A cornice that projects 14 cm and terminates at the mass corner with a
     * clean rectangular cut is what the Dustyard review called "a plank
     * hovering a metre off the facade" — and the maps stack their own 0.2 m
     * trim slabs on the same course, so the projection is up to 34 cm with
     * nothing under it. A bracket every ~3 m is what carries a real cornice;
     * the spacing is derived from the face so it never lands on the corner.
     */
    for (const f of faces) {
      const b = baysOf(mass, f);
      if (b.span < 3.2) continue;
      const n = Math.max(1, Math.round(b.span / 3.0));
      for (let i = 0; i <= n; i++) {
        const u = (i / n - 0.5) * (b.span - 0.7);
        const p = b.at(u, over / 2 + 0.02);
        // Not into a neighbouring mass, and not out over an opening.
        if (occupied(world, p.x + f.nx * 0.45, mass.y1 - 0.4, p.z + f.nz * 0.45, mass.index)) continue;
        // 0.26 tall, tucked under the drip course, and 0.2 m proud — enough to
        // reach past the map's own trim slabs where a map draws one.
        d.box(cop, p.x, mass.y1 - 0.30, p.z,
          f.axis === 'x' ? 0.16 : 0.24, 0.26, f.axis === 'x' ? 0.24 : 0.16,
          { bevel: 0.01, masks: [0.55, 0.6, 0.55] });
        // A smaller stone under it: a corbel steps, it does not stop dead.
        d.box(cop, p.x - f.nx * 0.03, mass.y1 - 0.44, p.z - f.nz * 0.03,
          f.axis === 'x' ? 0.1 : 0.14, 0.14, f.axis === 'x' ? 0.14 : 0.1,
          // A 13 cm stone's 8 mm chamfer never resolves at the top of a wall, and
          // there are ~250 of these per map: 12 triangles instead of 44.
          { thin: true, masks: [0.5, 0.65, 0.6] });
      }
    }
  }

  // ---- plinth: only where the wall actually meets the ground
  if (mass.y0 < 0.15) {
    d.box(trim, mass.x, 0.21, mass.z, mass.w + 0.13, 0.42, mass.d + 0.13, {
      bevel: 0.016, masks: [0.45, 0.95, 0.45],
    });
    // The splash band: 18 cm of dirt thrown up the render by rain off the road.
    // A facade that meets the pavement on a ruled line is the tell that says
    // "two boxes intersecting"; this is drawn in the WALL's own material with
    // the grime mask pinned, so it reads as staining rather than as a stripe of
    // mud geometry glued on.
    const stain = mass.wallKey ?? theme.stainKey;
    for (const f of faces) {
      const b = baysOf(mass, f);
      const p = b.at(0, 0.008);
      d.box(stain, p.x, 0.55, p.z,
        f.axis === 'x' ? 0.02 : mass.w * 0.98, 0.26, f.axis === 'x' ? mass.d * 0.98 : 0.02,
        { thin: true, masks: [0, 0.95, 0.6] });
    }
  }

}

/**
 * Pilasters on the long open faces.
 *
 * These run LAST, after every fitting has claimed its patch of render, because a
 * pilaster is the one element on a facade that can simply be left out. Drawn
 * first — which is what this pass used to do — a 0.5 m wide, 0.14 m deep strip
 * lands under whatever the window and shopfront passes put there next, and the
 * Citadel review duly found "the narrow window overlaps the pilaster beside it".
 * A facade whose pilaster rhythm is interrupted where the shopfronts are is also
 * closer to the truth than one where it marches through them.
 */
function dressPilasters(d, world, mass, faces, theme) {
  const rng = d.rng;
  for (const f of faces) {
    const b = baysOf(mass, f);
    if (b.span < 6) continue;
    const count = Math.max(2, Math.round(b.span / 5.5));
    const top = Math.min(mass.y1 - 0.25, mass.y0 + 9);
    for (let i = 0; i <= count; i++) {
      const u = (i / count - 0.5) * (b.span - 0.9);
      const p = b.at(u, 0.07);
      if (occupied(world, p.x + f.nx * 0.5, 1.4, p.z + f.nz * 0.5, mass.index)) continue;
      const w = rng.range(0.42, 0.62);
      if (!d.wallFree(mass, f, u, w / 2, mass.y0, top, 0.02)) continue;
      d.claimWall(mass, f, u, w / 2, mass.y0, top);
      d.box(
        mass.wallKey ?? theme.trimKey,
        p.x, (mass.y0 + top) / 2, p.z,
        f.axis === 'x' ? 0.14 : w, top - mass.y0, f.axis === 'x' ? w : 0.14,
        { bevel: 0.01, masks: [0.5, 0.45, 0.3] }
      );
    }
  }
}

/**
 * Windows.
 *
 * A window is a recess, a frame, glass and a sill — four pieces. Draw it as one
 * dark quad on the wall and it reads exactly like what it is, a sticker. The
 * recess is what makes it survive being lit from the side, and the sill is what
 * casts the shadow and sheds the stain that dates the building.
 */
function dressWindows(d, world, mass, faces, theme) {
  if (mass.h < 3.4 || mass.y1 < 3.6) return;
  const rng = d.rng;
  const stainKey = mass.wallKey ?? theme.stainKey;

  for (const f of faces) {
    const b = baysOf(mass, f);
    if (b.span < 4) continue;
    const depth = Math.min(0.25, (f.axis === 'x' ? mass.w : mass.d) * 0.35);

    // Floors at 2.4 m centres, starting above head height so no window can be
    // mistaken for a doorway a player could use.
    const floors = [];
    for (let y = mass.y0 + 2.9; y < mass.y1 - 1.2; y += 2.4) floors.push(y);
    if (!floors.length) continue;

    for (let i = 0; i < b.count; i++) {
      const u = b.centre(i);
      const p = b.at(u, 0);
      if (occupied(world, p.x + f.nx * 0.8, 2.0, p.z + f.nz * 0.8, mass.index)) continue;

      for (const y of floors) {
        if (rng.bool(0.16)) continue; // blanked bays: a facade is never regular
        const ww = rng.range(1.05, 1.45);
        const wh = rng.range(1.15, 1.5);
        // The wall has to exist behind the whole opening, or the reveal box is
        // a dark rectangle floating over an archway.
        if (!backedByWall(world, p.x, p.z, f.nx, f.nz, y - wh / 2, y + wh / 2,
          { halfWidth: ww / 2, depth })) continue;
        // The frame, sill and the stain under it are 17 cm wider and 40 cm
        // taller than the opening: that whole patch has to be free, or the
        // shopfront that got this bay first has its fascia through the reveal.
        if (!d.wallFree(mass, f, u, ww / 2 + 0.19, y - wh / 2 - 0.4, y + wh / 2 + 0.14)) continue;
        d.claimWall(mass, f, u, ww / 2 + 0.19, y - wh / 2 - 0.4, y + wh / 2 + 0.14);
        const boarded = rng.bool(theme.boardedWindows ?? 0.25);
        const dx = f.axis === 'x' ? 1 : 0;
        const dz = f.axis === 'z' ? 1 : 0;
        /**
         * The depth ladder.
         *
         * The wall is a SOLID box — there is no hole to recess into, so a
         * window has to fake its depth by stacking proud of the render, and
         * the order matters. Everything used to be authored at NEGATIVE
         * standoffs (glass at -3 cm, frame at -5 cm), which buried the glass,
         * the mullions and the whole surround inside the masonry: every window
         * in the game was a bare dark panel with a sill under it. Read outward:
         * backing board, glass, glazing bars, surround, sill.
         */
        const at = (v, ...size) => ({
          x: p.x + dx * f.sign * v + (dz ? size[0] : 0),
          y: y + size[1],
          z: p.z + dz * f.sign * v + (dx ? size[0] : 0),
        });
        const OUT_BACK = 0.01;
        const OUT_GLASS = 0.055;
        const OUT_BAR = 0.075;
        const OUT_FRAME = 0.06;

        // backing board: the dark void behind the glass, 2 cm proud so it is
        // not in a depth fight with the wall it is drawn against
        const back = at(OUT_BACK, 0, 0);
        d.box(theme.revealKey, back.x, back.y, back.z,
          dx ? 0.04 : ww, wh, dz ? 0.04 : ww,
          { thin: true, masks: [0.1, 0.95, 0.95] });

        if (boarded) {
          for (let k = 0; k < 3; k++) {
            const t = (k + 0.5) / 3 - 0.5;
            const q = at(0.05, 0, t * wh * 0.86);
            d.box('crateDark', q.x, q.y, q.z,
              dx ? 0.06 : ww * rng.range(0.9, 1.06), wh * 0.22, dz ? 0.06 : ww * rng.range(0.9, 1.06),
              { thin: true, rz: dz ? rng.range(-0.03, 0.03) : 0, rx: dx ? rng.range(-0.03, 0.03) : 0,
                masks: [0.8, 0.6, 0.2] });
          }
          // the pane that went in first: shards on the ground below
          if (mass.y0 < 0.15 && y < 4.2 && rng.bool(0.35)) {
            const g = b.at(u, 0.75);
            const floor = standing(world, g.x, g.z, 0.5, 0.2);
            if (floor !== null) {
              standProp(d, 'glass_shards', g.x, floor, g.z, f.yaw, { masks: [0.6, 0.25, 0] });
            }
          }
        } else {
          // A single quad: the pane sits inside a frame that is 2 cm prouder on
          // all four sides, so it has no silhouette of its own and a solid box
          // would cost 44 triangles to hide five faces nobody can see.
          const gl = at(OUT_GLASS, 0, 0);
          d.add('glass', d.geo('pane', () => quad(1, 1)),
            newTrs(gl.x, gl.y, gl.z, f.yaw, ww * 0.94, wh * 0.94, 1), [0, 0.3, 0]);
          // mullion + transom, so the pane is never one sheet
          const bar = at(OUT_BAR, 0, 0);
          d.box(theme.frameKey, bar.x, bar.y, bar.z,
            dx ? 0.03 : 0.05, wh * 0.94, dz ? 0.03 : 0.05, { thin: true, masks: [0.7, 0.4, 0.1] });
          d.box(theme.frameKey, bar.x, bar.y, bar.z,
            dx ? 0.03 : ww * 0.94, 0.05, dz ? 0.03 : ww * 0.94, { thin: true, masks: [0.7, 0.4, 0.1] });
        }

        // frame surround, prouder than the glass so it casts onto it
        const fr = 0.085;
        for (const [ox, oy, sw, sh] of [
          [0, wh / 2 + fr / 2, ww + fr * 2, fr],
          [0, -wh / 2 - fr / 2, ww + fr * 2, fr],
          [-ww / 2 - fr / 2, 0, fr, wh],
          [ww / 2 + fr / 2, 0, fr, wh],
        ]) {
          const q = at(OUT_FRAME, ox, oy);
          d.box(theme.frameKey, q.x, q.y, q.z,
            dx ? 0.12 : sw, sh, dz ? 0.12 : sw,
            { thin: true, masks: [0.6, 0.5, 0.25] });
        }

        // sill, proud of everything — this casts the shadow that sells it
        const sill = at(0.09, 0, -wh / 2 - fr - 0.05);
        d.box(theme.trimKey, sill.x, sill.y, sill.z,
          dx ? 0.26 : ww + 0.34, 0.09, dz ? 0.26 : ww + 0.34,
          { bevel: 0.01, masks: [0.75, 0.8, 0.3] });

        // and the run of dirty water it sheds down the render below
        if (rng.bool(0.72)) {
          const len = rng.range(0.7, 1.7);
          const g = runoffStreak(rng, ww + 0.2, len, { amount: rng.range(0.75, 1.0) });
          d.add(stainKey, g,
            newTrs(p.x + f.nx * 0.012, y - wh / 2 - 0.14, p.z + f.nz * 0.012, f.yaw), null);
          g.dispose();
        }
      }
    }
  }
}

/** Drainpipes, conduit and wall lamps: the small vertical furniture. */
function dressWallFurniture(d, world, mass, faces, theme) {
  const rng = d.rng;
  if (mass.y1 < 3) return;
  const stainKey = mass.wallKey ?? theme.stainKey;

  for (const f of faces) {
    const b = baysOf(mass, f);
    const depth = Math.min(0.25, (f.axis === 'x' ? mass.w : mass.d) * 0.35);

    // ---- a downpipe on a pier near one end of most facades
    if (rng.bool(0.55)) {
      const u = (rng.bool() ? -1 : 1) * b.span * rng.range(0.3, 0.46);
      // Standoff is the pipe's own radius plus its bracket, so the back of the
      // pipe is 1 cm off the render — which is where a pipe on a saddle sits.
      const r = 0.055;
      const p = b.at(u, r + 0.015);
      const top = mass.y1 - 0.05;
      if (
        !occupied(world, p.x + f.nx * 0.4, 1.5, p.z + f.nz * 0.4, mass.index) &&
        backedByWall(world, p.x, p.z, f.nx, f.nz, mass.y0 + 0.3, top - 0.2, { depth, samples: 6 }) &&
        // A downpipe runs the whole height of the facade, so it takes a strip
        // out of every storey: it has to clear the windows, not cross them.
        d.wallFree(mass, f, u, 0.16, mass.y0, top)
      ) {
        d.claimWall(mass, f, u, 0.16, mass.y0, top);
        const g = d.geo('pipe:0.055:8', () => tubeY(r, 1, { radial: 8 }));
        d.add('metalDark', g, newTrs(p.x, mass.y0, p.z, 0, 1, top - mass.y0, 1), [0.55, 0.85, 0.3]);
        // Joint collars every section, brackets between them.
        for (let y = mass.y0 + 1.1; y < top - 0.4; y += 1.9) {
          d.add('metalDark', g, newTrs(p.x, y, p.z, 0, 1.24, 0.07, 1.24), [0.9, 0.7, 0.2]);
          d.box('metalDark', p.x - f.nx * (r * 0.6), y + 0.3, p.z - f.nz * (r * 0.6),
            f.axis === 'x' ? 0.1 : 0.14, 0.03, f.axis === 'x' ? 0.14 : 0.1, { thin: true });
        }
        // Rainwater head at the top: without it the pipe stops in mid-air and
        // reads as a mast rather than as plumbing that goes somewhere.
        d.box('metalDark', p.x, top - 0.16, p.z, 0.22, 0.3, 0.22, { bevel: 0.012, masks: [0.6, 0.9, 0.4] });
        // Shoe at the bottom, kicking the water out into the street.
        d.add('metalDark', g,
          newTrs(p.x + f.nx * 0.03, mass.y0 + 0.02, p.z + f.nz * 0.03, f.yaw, 1, 0.3, 1, 0.7),
          [0.85, 0.7, 0.3]);
        // and the overflow stain beside the head
        const st = runoffStreak(rng, 0.3, rng.range(1.2, 2.4), { amount: 0.85, cols: 3 });
        d.add(stainKey, st,
          newTrs(p.x + f.nx * (0.012 - r), top - 0.3, p.z + f.nz * (0.012 - r), f.yaw), null);
        st.dispose();
      }
    }

    /**
     * A bulkhead lamp on a bracket.
     *
     * Every piece is positioned from the WALL PLANE outward, not from an
     * arbitrary standoff: the back plate is half its own thickness off the
     * face so it lies flat on it, the arm starts at the plate and reaches out,
     * and the shade hangs at the end of the arm. Anything else leaves a gap
     * behind the fitting, and a gap behind a wall fitting is the most obvious
     * floating-prop tell there is.
     */
    if (rng.bool(0.32) && mass.y1 > 4) {
      const u = b.pier(rng.int(0, Math.max(0, b.count - 2)));
      const wall = b.at(u, 0);
      const y = Math.min(mass.y1 - 0.6, 3.5);
      const out = (dist, cb) => cb(wall.x + f.nx * dist, wall.z + f.nz * dist);
      if (
        !occupied(world, wall.x + f.nx * 0.6, y, wall.z + f.nz * 0.6, mass.index) &&
        backedByWall(world, wall.x, wall.z, f.nx, f.nz, y - 0.4, y + 0.3, { depth }) &&
        d.wallFree(mass, f, u, 0.3, y - 0.3, y + 0.45)
      ) {
        d.claimWall(mass, f, u, 0.3, y - 0.3, y + 0.45);
        // back plate, flat on the render
        out(0.025, (x, z) => {
          d.box('metalDark', x, y, z,
            f.axis === 'x' ? 0.05 : 0.14, 0.18, f.axis === 'x' ? 0.14 : 0.05,
            { thin: true, masks: [0.5, 0.7, 0.3] });
        });
        // the arm, rising as it reaches out, so the shade sits above the plate
        out(0.2, (x, z) => {
          d.box('metalDark', x, y + 0.11, z,
            f.axis === 'x' ? 0.38 : 0.05, 0.05, f.axis === 'x' ? 0.05 : 0.38,
            { thin: true, rz: f.axis === 'x' ? -f.sign * 0.42 : 0,
              rx: f.axis === 'z' ? f.sign * 0.42 : 0, masks: [0.8, 0.6, 0.2] });
        });
        // A wide conical shade with a lamp under it. A 15 cm shade at 3.5 m is
        // three pixels: it read as a black tablet stuck to the wall with a stub
        // beside it, which is the opposite of the read a street lamp needs.
        out(0.36, (x, z) => {
          // A closed frustum, not an open cone: an open ConeGeometry is
          // single-sided, so from underneath — which is where every player is —
          // its faces are backfaces and the shade disappears, leaving the bulb
          // floating. `tubeY` with a taper is wide at the bottom, narrow at the
          // top, and visible from every side.
          const shade = d.geo('shade:0.24', () => tubeY(0.24, 0.2, { radial: 12, taper: 0.42 }));
          d.add('metalDoor', shade, newTrs(x, y + 0.09, z), [0.55, 0.6, 0.2]);
          d.add('neonA', d.geo('bulb', () => new THREE.SphereGeometry(0.07, 6, 5)),
            newTrs(x, y + 0.11, z), [0, 0, 0]);
        });
      }
    }
  }
}

/**
 * Roof plant: tanks, ducting, vents, aerials, and the junk that accumulates on
 * a flat roof. Roofs are the top third of every wide shot in a low-rise map, so
 * they get real density rather than a token water tank.
 */
function dressRoof(d, world, mass, theme) {
  if (mass.perimeter || mass.w < 5 || mass.d < 5 || mass.y1 < 4 || mass.y1 > 11) return;
  const rng = d.rng;
  const y = mass.deckY;

  // A parapet around the roof edge.
  const ph = rng.range(0.5, 0.85);
  for (const f of FACES) {
    const along = f.axis === 'x' ? mass.d : mass.w;
    const half = f.axis === 'x' ? mass.w / 2 : mass.d / 2;
    const x = mass.x + (f.axis === 'x' ? f.sign * (half - 0.16) : 0);
    const z = mass.z + (f.axis === 'z' ? f.sign * (half - 0.16) : 0);
    d.box(theme.copingKey ?? theme.trimKey, x, y + ph / 2, z,
      f.axis === 'x' ? 0.3 : along, ph, f.axis === 'x' ? along : 0.3,
      { bevel: 0.016, masks: [0.7, 0.45, 0.2] });
  }

  const inset = 1.4;
  const rx = Math.max(0.2, mass.w / 2 - inset);
  const rz = Math.max(0.2, mass.d / 2 - inset);
  /** A free spot on the roof deck, or null — roof plant must not interpenetrate. */
  const spot = (radius) => {
    for (let t = 0; t < 8; t++) {
      const x = mass.x + rng.signed() * rx;
      const z = mass.z + rng.signed() * rz;
      if (d.free(x, z, radius)) {
        d.claim(x, z, radius);
        return { x, z };
      }
    }
    return null;
  };

  /**
   * Mains services on the roof, or none.
   *
   * The tank, the ducting run, the extractor, the vent stacks, the steel roof
   * hatch and the aerial mast are all plumbing and wiring. On the keeps of a
   * citadel they are the same category error as the air conditioners on its
   * curtain wall, and roofs are the top third of every wide shot — so
   * `roofServices: false` drops all six and leaves the parapet, the swept grit
   * and the theme's own `roofProps`.
   */
  const services = theme.roofServices !== false;

  // water tank on a stand
  if (services && rng.bool(0.6)) {
    const p = spot(1.0);
    if (p) {
      const legs = 0.5;
      const t = standProp(d, 'water_tank', p.x, y + legs, p.z, rng.range(0, 6.28),
        { mat: theme.tankKey, scale: rng.range(0.85, 1.1) });
      if (t) {
        for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
          d.box('metalDark', p.x + sx * 0.42, y + legs / 2, p.z + sz * 0.42, 0.09, legs, 0.09,
            { bevel: 0.006 });
        }
      }
    }
  }

  // ducting run + extractor
  if (services && rng.bool(0.65)) {
    const p = spot(1.6);
    if (p) {
      const len = rng.range(1.6, 3.2);
      const horiz = rng.bool();
      // Seated ON the deck: the duct is 0.55 deep, so its centre is 0.275 up.
      d.box('metalGrid', p.x, y + 0.275, p.z, horiz ? len : 0.55, 0.55, horiz ? 0.55 : len,
        { bevel: 0.014, masks: [0.6, 0.6, 0.3] });
      // The extractor sits ON TOP of the duct, inboard of its end, not
      // half-overhanging into space off the end face.
      const fan = d.geo('fan', () => tubeY(1, 1, { radial: 10 }));
      const fx = p.x + (horiz ? (len / 2 - 0.4) : 0);
      const fz = p.z + (horiz ? 0 : (len / 2 - 0.4));
      d.add('metalDark', fan, newTrs(fx, y + 0.55, fz, 0, 0.42, 0.5, 0.42), [0.6, 0.7, 0.3]);
    }
  }

  // vent stacks — a plant roof is mostly vents
  for (let i = 0, n = services ? rng.int(1, 3) + (theme.roofPlant ? 2 : 0) : 0; i < n; i++) {
    const p = spot(0.4);
    if (p) standProp(d, 'roof_vent', p.x, y, p.z, rng.range(0, 6.28), { scale: rng.range(0.8, 1.15) });
  }

  /**
   * A roof hatch: the reason anything is up here at all.
   *
   * The Harbor review's headline roof complaint was that the industrial roofs
   * carry "wooden chairs, stools and trestle tables" and no plant — and the
   * second half of that read is that crates and barrels appear on a roof with
   * no ladder and no hatch, i.e. no way anyone got them there.
   */
  if (services && theme.roofPlant) {
    const p = spot(0.7);
    if (p) {
      // Curb 0.95 x 0.26 x 0.85, seated on the deck.
      d.box('metalGrid', p.x, y + 0.13, p.z, 0.95, 0.26, 0.85,
        { bevel: 0.014, masks: [0.7, 0.6, 0.3] });
      /**
       * The lid, standing open ON ITS HINGE.
       *
       * A box rotates about its own centre, so a lid cannot be positioned by its
       * centre and then tilted — that is how the first version of this ended up a
       * black panel hovering 18 cm over the roof with daylight under it, the very
       * defect this pass exists to remove. Work from the hinge instead: the hinge
       * is the curb's -x top edge, the leaf runs 0.46 m from it along
       * (cos60, sin60), so its centre is that point plus half its length.
       */
      const lean = Math.PI / 3;
      const hx = p.x - 0.475;
      const hy = y + 0.26;
      d.box('metalDark', hx + Math.cos(lean) * 0.46, hy + Math.sin(lean) * 0.46, p.z,
        0.92, 0.05, 0.82,
        { thin: true, rz: lean, masks: [0.95, 0.35, 0.05] });
    }
  }

  /**
   * The clutter that makes a roof look used.
   *
   * `roofProps` is the theme's own list, because a roof terrace over a market
   * street keeps chairs and planters and a container-port roof keeps plant and
   * spares. Handing every map the same list put trestle tables and stools on
   * the Harbor warehouses.
   */
  const roofKit = theme.roofProps ?? ['stool', 'chair', 'tyre', 'barrel_rust', 'pallet', 'gas_bottle', 'bucket'];
  for (let i = 0, n = rng.int(2, 5); i < n; i++) {
    const roll = rng.float();
    if (roll < 0.35) {
      const p = spot(0.6);
      if (!p) continue;
      let deck = y;
      let fit = Infinity;
      for (let k = 0, stack = rng.int(2, 3); k < stack; k++) {
        const c = standProp(d, rng.pick(['crate_a', 'crate_b', 'crate_flat']),
          p.x + rng.range(-0.08, 0.08), deck, p.z + rng.range(-0.08, 0.08), rng.range(0, 6.28),
          { fit });
        if (!c) break;
        deck = c.worldTop;
        fit = c.fitRadius;
      }
    } else {
      const p = spot(0.5);
      if (p) standProp(d, rng.pick(roofKit), p.x, y, p.z, rng.range(0, 6.28));
    }
  }

  // grit blown into the corners, and the litter that never gets swept
  for (let i = 0; i < 3; i++) {
    const g = patchGeometry(rng, rng.range(0.6, 1.5), { lobes: 8, wobble: 0.5 });
    d.add(theme.spillKey, g,
      newTrs(mass.x + rng.signed() * rx, y + 0.012, mass.z + rng.signed() * rz,
        rng.float() * 6.28, 1, 1, 0.7),
      [0.1, 0.85, 0.5]);
    g.dispose();
  }
  const grit = theme.roofGrit ?? ['brick_a', 'cinder', 'litter', 'can', 'plank_b', 'bottle'];
  for (let i = 0, n = rng.int(3, 7); i < n; i++) {
    standProp(d, rng.pick(grit),
      mass.x + rng.signed() * rx, y, mass.z + rng.signed() * rz, rng.range(0, 6.28));
  }

  // an aerial mast: thin, tall, and it does a lot for a skyline
  if (services && mass.y1 > 6.0 && rng.bool(0.55)) {
    const p = spot(0.3);
    if (p) {
      const h = rng.range(1.8, 3.4);
      const g = d.geo('pipe:0.02:5', () => tubeY(0.02, 1, { radial: 5 }));
      d.add('metalDark', g, newTrs(p.x, y, p.z, 0, 1, h, 1), [0.9, 0.5, 0.2]);
      for (let i = 1; i <= 4; i++) {
        const yy = y + h * (0.45 + i * 0.11);
        d.add('metalDark', g,
          newTrs(p.x, yy, p.z, rng.float() * 3.14, 1, rng.range(0.25, 0.5), 1, 0, Math.PI / 2),
          [0.9, 0.5, 0.2]);
      }
    }
  }
}

// ------------------------------------------------------------------ street --

/**
 * Doorway units.
 *
 * A ground floor with no way in is the clearest sign that a building is a box
 * with a texture on it. A door is a recess, a leaf, jambs, a head casing, a
 * threshold step you can see the wear on, and the junk that always collects
 * beside one. The step is the part that has to be right: it is the only piece
 * that touches the ground, so it is placed from `standing()` and everything
 * else is measured off the wall.
 */
function doorwayUnit(d, world, mass, f, b, u, theme) {
  const rng = d.rng;
  const wall = b.at(u, 0);
  const w = rng.range(1.0, 1.25);
  const h = rng.range(2.05, 2.35);
  const depth = Math.min(0.25, (f.axis === 'x' ? mass.w : mass.d) * 0.35);
  // A door needs wall all round the opening, and a clear approach in front.
  if (!backedByWall(world, wall.x, wall.z, f.nx, f.nz, 0.3, h + 0.4,
    { halfWidth: w / 2 + 0.2, depth })) return false;
  // The unit is the opening plus its casing, canopy and sign: 0.5 m either side
  // and up to 3.1 m. Claimed as one piece so nothing lands in the middle of it.
  if (!d.wallFree(mass, f, u, w / 2 + 0.5, 0, h + 0.75)) return false;
  const front = b.at(u, 1.1);
  const floor = standing(world, front.x, front.z, 0.9, 0.4);
  if (floor === null || Math.abs(floor - mass.y0) > 0.02) return false;
  if (!d.free(front.x, front.z, 0.9)) return false;
  d.claim(front.x, front.z, 0.85);
  d.claimWall(mass, f, u, w / 2 + 0.5, 0, h + 0.75);

  const dx = f.axis === 'x' ? 1 : 0;
  const dz = f.axis === 'z' ? 1 : 0;
  const out = (v) => f.sign * v;

  /**
   * The depth ladder, same reasoning as the windows: the wall is a solid box,
   * so a doorway is built OUTWARD from the render, not carved into it. A leaf
   * seated behind the dark backing board is a leaf nobody ever sees.
   */
  // backing board — the dark interior beyond the leaf
  d.box(theme.revealKey, wall.x + dx * out(0.02), floor + h / 2, wall.z + dz * out(0.02),
    dx ? 0.04 : w, h, dz ? 0.04 : w, { thin: true, masks: [0.1, 0.9, 0.95] });
  // the leaf, standing closed in the opening. It is authored centred on its own
  // width, so swinging it ajar would pivot it about its middle rather than its
  // hinge — a door hanging on nothing, which is worse than a shut door.
  wallProp(d, 'door_leaf', wall.x + dx * out(0.045), wall.z + dz * out(0.045), floor, f,
    { scale: Math.min(1, w / 1.0), mat: rng.bool(0.5) ? 'metalDoor' : 'crateDark' });

  // jambs and head casing, standing proud of everything
  for (const s of [-1, 1]) {
    const along = s * (w / 2 + 0.05);
    d.box(theme.frameKey,
      wall.x + dx * out(0.09) + (dx ? 0 : along), floor + h / 2,
      wall.z + dz * out(0.09) + (dz ? 0 : along),
      dx ? 0.18 : 0.1, h + 0.12, dz ? 0.18 : 0.1,
      { thin: true, masks: [0.65, 0.5, 0.25] });
  }
  d.box(theme.frameKey, wall.x + dx * out(0.09), floor + h + 0.09, wall.z + dz * out(0.09),
    dx ? 0.18 : w + 0.24, 0.14, dz ? 0.18 : w + 0.24, { bevel: 0.008, masks: [0.65, 0.55, 0.3] });

  // threshold step: two courses, the top one worn hollow by feet
  d.box(theme.trimKey, wall.x + dx * out(0.22), floor + 0.06, wall.z + dz * out(0.22),
    dx ? 0.44 : w + 0.5, 0.12, dz ? 0.44 : w + 0.5, { bevel: 0.014, masks: [0.9, 0.7, 0.4] });
  d.box(theme.trimKey, wall.x + dx * out(0.36), floor + 0.03, wall.z + dz * out(0.36),
    dx ? 0.7 : w + 0.8, 0.06, dz ? 0.7 : w + 0.8, { bevel: 0.012, masks: [0.85, 0.85, 0.5] });

  // A canopy on two brackets over the door — but only where it would ever have
  // rained on the door. Under a roof it is a shelf bolted to an interior wall.
  if (rng.bool(0.55) && openSky(world, front.x, front.z, floor + h + 0.4)) {
    const cy = floor + h + 0.34;
    d.box(theme.trimKey, wall.x + dx * out(0.34), cy, wall.z + dz * out(0.34),
      dx ? 0.7 : w + 0.7, 0.09, dz ? 0.7 : w + 0.7, { bevel: 0.01, masks: [0.6, 0.8, 0.35] });
    for (const s of [-1, 1]) {
      const p = b.at(u + s * (w / 2 + 0.22), 0.2);
      d.box('metalDark', p.x, cy - 0.22, p.z,
        dx ? 0.42 : 0.05, 0.05, dz ? 0.42 : 0.05,
        { thin: true, rz: dx ? -f.sign * 0.5 : 0, rx: dz ? f.sign * 0.5 : 0 });
    }
    // and the stain the canopy sheds down the wall beside the door
    const st = runoffStreak(rng, w + 0.7, rng.range(0.8, 1.6), { amount: 0.8 });
    d.add(mass.wallKey ?? theme.stainKey, st,
      newTrs(wall.x + f.nx * 0.012, cy - 0.08, wall.z + f.nz * 0.012, f.yaw), null);
    st.dispose();
  }

  // a hanging shop sign beside the door — a bracket and a swinging board,
  // which is period on a market street and modern nowhere
  if (rng.bool(0.45)) {
    const sp = b.at(u + (rng.bool() ? 1 : -1) * (w / 2 + 0.5), 0);
    if (backedByWall(world, sp.x, sp.z, f.nx, f.nz, 2.1, 2.7, { depth })) {
      wallProp(d, 'sign_hang', sp.x, sp.z, floor + 2.55, f, { mat: theme.signKey });
    }
  }

  // the junk that lives beside a doorway
  const junk = theme.doorJunk
    ?? ['bucket', 'crate_b', 'stool', 'jerry_can', 'planter', 'sack', 'litter', 'tray'];
  for (let i = 0, n = rng.int(1, 3); i < n; i++) {
    const p = b.at(u + rng.range(-1, 1) * (w / 2 + 0.9), rng.range(0.5, 1.3));
    groundProp(d, world, rng.pick(junk), p.x, p.z, rng.range(0, 6.28), { pack: 0.55 });
  }
  return true;
}

/**
 * A shopfront: fascia sign, awning, counter and the goods stacked around it.
 * Placed on a whole bay, so the awning never crosses a window pier.
 */
function shopfrontUnit(d, world, mass, f, b, u, theme) {
  const rng = d.rng;
  const wall = b.at(u, 0);
  /**
   * The unit can never be wider than the bay it is placed in.
   *
   * `baysOf` puts bay centres (b.span - 1.6) / b.count apart, which on a 6.4 m
   * face is 2.4 m — and this used to ask for up to 3.2 m of shopfront, so two
   * neighbours overlapped by 80 cm and their awnings crossed. The Citadel
   * review saw exactly that: "neighbouring awnings overlap in a zig-zag".
   */
  const pitch = (b.span - 1.6) / b.count;
  const w = Math.min(rng.range(2.2, 3.2), pitch - 0.35);
  if (w < 1.8) return false;
  const depth = Math.min(0.25, (f.axis === 'x' ? mass.w : mass.d) * 0.35);
  if (!backedByWall(world, wall.x, wall.z, f.nx, f.nz, 0.6, 3.0,
    { halfWidth: w / 2, depth })) return false;
  const front = b.at(u, 1.3);
  const floor = standing(world, front.x, front.z, 1.3, 1.0);
  if (floor === null || Math.abs(floor - mass.y0) > 0.02) return false;
  if (!d.free(front.x, front.z, 1.3)) return false;
  // The fascia sign reaches ~3.6 m: claim the whole shopfront in one piece.
  if (!d.wallFree(mass, f, u, w / 2 + 0.1, 0, 3.7)) return false;
  d.claim(front.x, front.z, 1.2);
  d.claimWall(mass, f, u, w / 2 + 0.1, 0, 3.7);

  const dx = f.axis === 'x' ? 1 : 0;
  const dz = f.axis === 'z' ? 1 : 0;
  const out = (v) => f.sign * v;
  const headY = floor + rng.range(2.45, 2.75);
  // An awning is a weather device. Inside the Harbor customs hall this pass hung
  // a market awning off a signboard under a roof — so the cloth, its rafters and
  // the goods table only happen where there is sky over the pavement.
  const outdoors = openSky(world, front.x, front.z, headY);
  // And one shop in four is shut: a facade where every unit is open for business
  // with its awning at the same pitch is the "one bay copied ten times" read.
  const shut = rng.bool(0.28);

  /**
   * The head over the opening, and what closes it.
   *
   * A rolling steel shutter in a pressed housing is a 20th-century shopfront.
   * `shutters: false` swaps both for what closes a medieval stall: a timber
   * lintel on the head, and a boarded shopboard hinged down over the opening —
   * same silhouette, same "one shop in four is shut" read, no steel.
   */
  const steel = theme.shutters !== false;
  const headKey = steel ? 'metalDark' : theme.frameKey;
  // shop opening: a dark backing board 2 cm proud of the render (see the
  // doorway ladder), with the head casing over it
  d.box(theme.revealKey, wall.x + dx * out(0.02), floor + 1.15, wall.z + dz * out(0.02),
    dx ? 0.04 : w - 0.2, 2.3, dz ? 0.04 : w - 0.2, { thin: true, masks: [0.1, 0.9, 0.95] });
  d.box(headKey, wall.x + dx * out(0.1), floor + 2.42, wall.z + dz * out(0.1),
    dx ? 0.2 : w, 0.2, dz ? 0.2 : w, { bevel: 0.008, masks: [0.85, 0.5, 0.1] });
  if (shut && steel) {
    // The shutter rolled down: corrugated slats out of the housing, so the bay
    // reads as closed rather than as another identical open counter.
    const slats = Math.max(5, Math.round(2.3 / 0.22));
    for (let i = 0; i < slats; i++) {
      const y = floor + 0.06 + ((i + 0.5) / slats) * 2.26;
      d.box('metalDark', wall.x + dx * out(0.12), y, wall.z + dz * out(0.12),
        dx ? 0.05 : w - 0.16, 2.26 / slats - 0.02, dz ? 0.05 : w - 0.16,
        { thin: true, masks: [0.8, 0.55, 0.2] });
    }
  } else if (shut) {
    // Shuttered in board: five wide planks with a ledge and a diagonal brace,
    // which is what a shopboard is and what the boarded-window pass already
    // draws elsewhere on this facade.
    const boards = 5;
    for (let i = 0; i < boards; i++) {
      const y = floor + 0.06 + ((i + 0.5) / boards) * 2.26;
      d.box(theme.frameKey, wall.x + dx * out(0.12), y, wall.z + dz * out(0.12),
        dx ? 0.06 : w - 0.16, 2.26 / boards - 0.03, dz ? 0.06 : w - 0.16,
        { thin: true, masks: [0.85, 0.5, 0.2] });
    }
    // The brace, corner to corner. atan2 of the opening's own diagonal, so it
    // lands on the corners whatever width the bay came out at.
    const brace = Math.atan2(2.2, w - 0.2);
    d.box(theme.frameKey, wall.x + dx * out(0.17), floor + 1.16, wall.z + dz * out(0.17),
      dx ? 0.06 : Math.hypot(w - 0.2, 2.2), 0.12, dz ? 0.06 : Math.hypot(w - 0.2, 2.2),
      { thin: true, rz: dz ? brace : 0, rx: dx ? -brace : 0, masks: [0.9, 0.45, 0.15] });
  } else {
    // a counter in the opening
    d.box('crateDark', wall.x + dx * out(0.34), floor + 0.86, wall.z + dz * out(0.34),
      dx ? 0.62 : w * 0.82, 0.07, dz ? 0.62 : w * 0.82, { bevel: 0.008, masks: [0.8, 0.5, 0.2] });
    for (const s of [-1, 1]) {
      const leg = b.at(u + s * w * 0.34, 0.34);
      d.box('crateDark', leg.x, floor + 0.43, leg.z,
        dx ? 0.5 : 0.09, 0.86, dz ? 0.5 : 0.09, { thin: true, masks: [0.7, 0.6, 0.3] });
    }
  }

  /**
   * The awning.
   *
   * `clothGeometry` is authored flat in XY and centred on its origin, so a
   * sloped awning is that sheet tipped by (90 deg - slope) about the face
   * tangent. Every dimension below is derived from the slope rather than
   * guessed, because the guessed version put the front rail 24 cm below the
   * cloth's own front edge and the side struts nowhere near either.
   *
   *   reach = sheet * cos(slope)   how far it stands out from the wall
   *   drop  = sheet * sin(slope)   how far its front edge falls
   */
  const slope = rng.range(0.3, 0.42);
  const sheet = rng.range(1.35, 1.6);
  const reach = sheet * Math.cos(slope);
  const drop = sheet * Math.sin(slope);
  if (outdoors && !shut) {
    const g = clothGeometry(w, sheet, { sag: 0.11, wrinkle: 0.045, rng, hem: 1, bow: -1, fray: 0.014 });
    d.add(theme.clothKey ?? 'sandbag', g,
      newTrs(wall.x + f.nx * (reach / 2), headY - drop / 2, wall.z + f.nz * (reach / 2), f.yaw,
        1, 1, 1, slope - Math.PI / 2),
      [0.35, 0.5, 0.2]);
    g.dispose();
    /**
     * Front rail and rafters, UNDER the cloth.
     *
     * The rail used to sit 2 cm below the cloth's front edge with a 5 cm section,
     * so its top face stood 5 mm through the sheet and the sag pulled the fabric
     * further onto it — the Citadel review read it as "the awning's front rail
     * passes through its own cloth". A rail carries a sheet from below: the
     * offset is half the rail plus the fabric's own 3 mm, measured normal to the
     * slope, which in Y is that over cos(slope).
     */
    const clear = (0.025 + 0.004) / Math.cos(slope);
    // Tubular steel on a modern street, ash poles on a market that predates it.
    const railKey = theme.railKey ?? 'metalDark';
    d.box(railKey, wall.x + f.nx * reach, headY - drop - clear, wall.z + f.nz * reach,
      dx ? 0.05 : w + 0.1, 0.05, dz ? 0.05 : w + 0.1, { thin: true, masks: [0.9, 0.5, 0] });
    for (const s of [-1, 1]) {
      const r = b.at(u + s * w * 0.47, reach / 2);
      d.box(railKey, r.x, headY - drop / 2 - clear, r.z,
        dx ? sheet : 0.045, 0.045, dz ? sheet : 0.045,
        { thin: true, rz: dx ? -f.sign * slope : 0, rx: dz ? f.sign * slope : 0,
          masks: [0.9, 0.5, 0] });
    }
  } else if (outdoors) {
    // Rolled up against the housing: the same fitting, out of use. `tubeY` runs
    // from its origin along +Y, so the anchor is the run's START (the same
    // convention the plant pipework uses) and the roll is laid along the face:
    // rx = +90 deg sends +Y to +Z for an x-face, rz = -90 deg sends it to +X.
    const roll = d.geo('roll:0.09', () => tubeY(0.09, 1, { radial: 7 }));
    const p = b.at(u - (w - 0.1) / 2, 0.16);
    d.add(theme.clothKey ?? 'sandbag', roll,
      newTrs(p.x, headY, p.z, 0, 1, w - 0.1, 1,
        f.axis === 'x' ? Math.PI / 2 : 0, f.axis === 'x' ? 0 : -Math.PI / 2),
      [0.4, 0.55, 0.25]);
  }
  // Fascia sign, clear above the awning's attachment line. A painted fascia
  // board is a shop sign in any century; a theme with no literate signage
  // (`signProps: false`) gets a plain painted board of the same size instead,
  // which is what a guild mark on a lintel looks like at 4 m.
  if (theme.signProps !== false) {
    wallProp(d, 'sign_shop', wall.x, wall.z, headY + 0.45, f,
      { scale: Math.min(1.25, w / 2.4), mat: theme.signKey });
  } else {
    d.box(theme.signKey, wall.x + dx * out(0.055), headY + 0.45, wall.z + dz * out(0.055),
      dx ? 0.11 : w * 0.8, 0.42, dz ? 0.11 : w * 0.8, { bevel: 0.008, masks: [0.7, 0.5, 0.2] });
  }

  // goods: a trestle under the awning and stock stacked around it
  const table = shut ? null : groundProp(d, world, rng.bool(0.5) ? 'table' : 'table_small',
    front.x, front.z, f.yaw + rng.range(-0.08, 0.08), { pack: 0.5 });
  if (table) {
    for (let i = 0, n = rng.int(2, 4); i < n; i++) {
      // Along the trestle and across it, in the FACE's frame: at(u, out) is the
      // only place in this file that knows which world axis is which.
      const q = b.at(u + rng.range(-0.5, 0.5), 1.3 + rng.range(-0.25, 0.25));
      standProp(d, rng.pick(['tray', 'produce', 'box_card_b', 'bucket', 'sack']),
        q.x, table.worldTop, q.z, rng.range(0, 6.28),
        { scale: rng.range(0.85, 1.05), fit: table.radius });
    }
  }
  for (let i = 0, n = rng.int(2, 4); i < n; i++) {
    const p = b.at(u + rng.range(-1, 1) * (w / 2 + 0.4), rng.range(0.6, 1.9));
    const base = groundProp(d, world,
      rng.pick(['crate_b', 'box_card_a', 'box_card_b', 'crate_flat', 'sack', 'tray', 'bucket', 'shelf']),
      p.x, p.z, rng.range(0, 6.28), { pack: 0.55 });
    if (base && base.worldTop - base.worldY > 0.25 && rng.bool(0.4)) {
      standProp(d, rng.pick(['box_card_b', 'tray', 'produce']),
        p.x + rng.range(-0.06, 0.06), base.worldTop, p.z + rng.range(-0.06, 0.06),
        rng.range(0, 6.28), { fit: base.fitRadius });
    }
  }
  return true;
}

/** Balconies on the upper floors, and the life that happens on them. */
function balconyUnit(d, world, mass, f, b, u, theme) {
  const rng = d.rng;
  const w = rng.range(1.9, 2.8);
  const depth = 1.05;
  const wall = b.at(u, 0);
  const probeDepth = Math.min(0.25, (f.axis === 'x' ? mass.w : mass.d) * 0.35);
  const y = rng.range(3.2, Math.min(mass.y1 - 1.3, 5.6));
  if (y > mass.y1 - 1.2) return false;
  if (!backedByWall(world, wall.x, wall.z, f.nx, f.nz, y - 0.4, y + 1.1,
    { halfWidth: w / 2, depth: probeDepth })) return false;
  const front = b.at(u, depth * 0.6);
  if (!clearFor(world, front.x, front.z, 0.9, y + 0.5)) return false;
  // Slab, brackets, railing and the stain it sheds: from 30 cm under the slab
  // to the top of the rail. A balcony landing on a window row is the same
  // defect as one bolted over an archway.
  if (!d.wallFree(mass, f, u, w / 2 + 0.1, y - 0.35, y + 1.1)) return false;
  d.claimWall(mass, f, u, w / 2 + 0.1, y - 0.35, y + 1.1);

  const dx = f.axis === 'x' ? 1 : 0;
  const dz = f.axis === 'z' ? 1 : 0;
  // Slab: its inner edge is buried 3 cm IN the wall. A 2 cm air gap between a
  // cantilever slab and the facade is a tell you can see from across the map.
  const slabOut = depth / 2 - 0.03;
  const sx = wall.x + f.nx * slabOut;
  const sz = wall.z + f.nz * slabOut;
  d.box(theme.trimKey, sx, y, sz,
    dx ? depth : w, 0.14, dz ? depth : w, { bevel: 0.012, masks: [0.6, 0.7, 0.35] });
  // Brackets under it. A metre of unsupported concrete is not a thing.
  for (const s of [-1, 1]) {
    const p = b.at(u + s * (w / 2 - 0.18), depth * 0.34);
    d.box(theme.trimKey, p.x, y - 0.17, p.z,
      dx ? depth * 0.68 : 0.11, 0.28, dz ? depth * 0.68 : 0.11,
      { thin: true, masks: [0.4, 0.7, 0.45] });
  }

  // railing: top and mid rails all the way round, balusters on the front
  const railOut = depth - 0.06;
  for (const ry2 of [y + 0.5, y + 0.98]) {
    d.box('metalDark', wall.x + f.nx * railOut, ry2, wall.z + f.nz * railOut,
      dx ? 0.05 : w, 0.05, dz ? w : 0.05, { thin: true, masks: [0.9, 0.45, 0] });
    for (const s of [-1, 1]) {
      const p = b.at(u + s * (w / 2), railOut / 2);
      d.box('metalDark', p.x, ry2, p.z,
        dx ? railOut : 0.05, 0.05, dz ? 0.05 : railOut, { thin: true, masks: [0.9, 0.45, 0] });
    }
  }
  const bal = Math.max(5, Math.round(w / 0.19));
  for (let i = 0; i <= bal; i++) {
    const p = b.at(u + (i / bal - 0.5) * w, railOut);
    d.box('metalDark', p.x, y + 0.55, p.z,
      0.025, 0.98, 0.025, { thin: true, masks: [0.9, 0.5, 0] });
  }
  // corner posts, which is what actually carries the rail
  for (const s of [-1, 1]) {
    const p = b.at(u + s * (w / 2), railOut);
    d.box('metalDark', p.x, y + 0.55, p.z, 0.05, 1.04, 0.05,
      { thin: true, masks: [0.9, 0.5, 0] });
  }
  d.props += 2;

  // what is actually kept out there
  for (let i = 0, n = rng.int(1, 3); i < n; i++) {
    const p = b.at(u + rng.range(-w / 2 + 0.3, w / 2 - 0.3), rng.range(0.3, depth - 0.25));
    standProp(d, rng.pick(theme.balconyProps
      ?? ['bucket', 'crate_b', 'planter', 'box_card_b', 'stool', 'jerry_can', 'tyre_small']),
      p.x, y + 0.07, p.z, rng.range(0, 6.28), { scale: rng.range(0.85, 1.05) });
  }
  // a rug over the rail — nothing says "lived in" faster
  if (rng.bool(0.5)) {
    const rw = rng.range(0.8, Math.min(1.4, w - 0.5));
    const rh = rng.range(0.7, 1.1);
    const g = clothGeometry(rw, rh, {
      sag: 0.09, wrinkle: rng.range(0.04, 0.07), thickness: 0.0034, hem: 1,
      fray: rng.range(0.012, 0.03), rng,
    });
    // The cloth is centred on its origin, so hanging it from the rail means
    // dropping its centre half its own height below the rail.
    const rp = b.at(u + rng.range(-0.3, 0.3), railOut + 0.04);
    d.add(theme.clothKey ?? 'sandbag', g,
      newTrs(rp.x, y + 0.98 - rh / 2 + 0.05, rp.z, f.yaw), [0.4, 0.55, 0.2]);
    g.dispose();
  }
  // and the stain the slab sheds
  if (rng.bool(0.6)) {
    const st = runoffStreak(rng, w * 0.8, rng.range(0.9, 1.8), { amount: 0.9 });
    d.add(mass.wallKey ?? theme.stainKey, st,
      newTrs(wall.x + f.nx * 0.012, y - 0.09, wall.z + f.nz * 0.012, f.yaw), null);
    st.dispose();
  }
  return true;
}

/**
 * The facade, bay by bay.
 *
 * Placement is the part that has to be earned: props go where a person would
 * put them — against a wall, under a window, beside a doorway, in the lee of a
 * corner — never on a grid, and never anywhere a player could walk into them,
 * because none of this has a collider.
 */
function dressFacades(d, world, masses, theme) {
  const rng = d.rng;
  const budget = theme.propBudget ?? 240;

  for (const mass of masses) {
    if (d.props > budget) break;
    if (mass.y0 > 0.2) continue;
    for (const f of exposedFaces(world, mass)) {
      const b = baysOf(mass, f);
      if (b.span < 3) continue;
      const depth = Math.min(0.25, (f.axis === 'x' ? mass.w : mass.d) * 0.35);
      // Which ground-floor bays are already spoken for, so a doorway, a
      // shopfront and an air conditioner never land on the same piece of wall.
      const taken = new Set();

      // ---- doorways --------------------------------------------------------
      const doors = Math.min(2, Math.floor(b.span / 6));
      for (let i = 0; i < doors && d.props < budget; i++) {
        const bay = Math.min(b.count - 1, Math.floor(((i + 0.5) / doors) * b.count));
        if (taken.has(bay)) continue;
        if (!rng.bool(theme.doorways ?? 0.7)) continue;
        if (doorwayUnit(d, world, mass, f, b, b.centre(bay), theme)) taken.add(bay);
      }

      // ---- shopfronts ------------------------------------------------------
      // Never two in a row. Even with each unit clamped to its bay, a run of
      // adjacent shopfronts is the "one unit copied ten times for 60 m of wall"
      // read the Citadel review called the loudest procedural tell in the map.
      if (b.span > 5) {
        for (let i = 0; i < b.count && d.props < budget; i++) {
          if (taken.has(i)) continue;
          if (!rng.bool(theme.shopfronts ?? 0.4)) continue;
          if (shopfrontUnit(d, world, mass, f, b, b.centre(i), theme)) {
            taken.add(i);
            taken.add(i + 1);
          }
        }
      }

      // ---- wall services on the piers between the windows ------------------
      /**
       * A theme that has no mains services gets none of this.
       *
       * The roll below hangs an air conditioner, a satellite dish or a conduit
       * box on the piers. That is right for a desert town and a container port
       * and it is absurd on a curtain wall: the Citadel review counted
       * "wall-mounted AC units and a satellite dish" among the reasons a
       * medieval fort read as a modern industrial town. `wallServices: false`
       * turns the whole roll off and `dressSconces` puts iron light brackets on
       * the same piers instead.
       */
      const services = theme.wallServices === false ? 0 : Math.min(4, Math.floor(b.span / 4));
      for (let i = 0; i < services && d.props < budget; i++) {
        const pier = Math.min(b.count - 2, Math.round((i / Math.max(1, services - 1)) * (b.count - 2)));
        if (pier < 0) break;
        const u = b.pier(pier);
        const wall = b.at(u, 0);
        if (!clearFor(world, wall.x + f.nx * 0.6, wall.z + f.nz * 0.6, 0.5, 1.6)) continue;
        const wallTop = mass.y1 - 0.6;
        const roll = rng.float();
        // Height is clamped INSIDE the wall's own span — a unit bracketed to a
        // 3 m wall at 4 m is hanging in the air above the roofline — and dodges
        // the window rows, whose first floor starts at y0 + 2.9.
        if (roll < 0.42 && wallTop > 2.4) {
          const y = rng.range(2.05, Math.min(wallTop, 2.7));
          if (!backedByWall(world, wall.x, wall.z, f.nx, f.nz, y - 0.4, y + 0.4,
            { halfWidth: 0.42, depth })) continue;
          // The unit is 0.84 wide and drips 0.9 m of stain below itself. Both
          // Citadel and Dustyard had an awning's cloth crossing one of these.
          if (!d.wallFree(mass, f, u, 0.46, y - 1.0, y + 0.42)) continue;
          d.claimWall(mass, f, u, 0.46, y - 1.0, y + 0.42);
          wallProp(d, 'ac_unit', wall.x, wall.z, y, f);
          // the condensate run below it
          const st = runoffStreak(rng, 0.6, rng.range(0.7, 1.5), { amount: 0.95, cols: 3 });
          d.add(mass.wallKey ?? theme.stainKey, st,
            newTrs(wall.x + f.nx * 0.012, y - 0.32, wall.z + f.nz * 0.012, f.yaw), null);
          st.dispose();
        } else if (roll < 0.62 && mass.y1 > 5.0) {
          const y = mass.y1 - rng.range(0.8, 1.4);
          if (!backedByWall(world, wall.x, wall.z, f.nx, f.nz, y - 0.3, y + 0.3,
            { halfWidth: 0.2, depth })) continue;
          if (!d.wallFree(mass, f, u, 0.3, y - 0.35, y + 0.35)) continue;
          d.claimWall(mass, f, u, 0.3, y - 0.35, y + 0.35);
          wallProp(d, 'sat_dish_wall', wall.x, wall.z, y, f, { scale: rng.range(0.9, 1.15) });
        } else if (roll < 0.85 && mass.y1 > 2.2) {
          const y = rng.range(1.35, 1.7);
          if (!backedByWall(world, wall.x, wall.z, f.nx, f.nz, y - 0.3, y + 0.4,
            { halfWidth: 0.12, depth })) continue;
          if (!d.wallFree(mass, f, u, 0.2, y - 0.3, y + 0.4)) continue;
          d.claimWall(mass, f, u, 0.2, y - 0.3, y + 0.4);
          wallProp(d, 'conduit_box', wall.x, wall.z, y, f, { scale: rng.range(0.9, 1.3) });
        }
      }

      // ---- balconies on the upper floors -----------------------------------
      if (mass.y1 > 5.2 && b.span > 5) {
        const bays = Math.max(1, Math.floor(b.span / 4.5));
        for (let i = 0; i < bays && d.props < budget; i++) {
          if (!rng.bool(theme.balconies ?? 0.5)) continue;
          balconyUnit(d, world, mass, f, b, ((i + 0.5) / bays - 0.5) * (b.span - 2.4), theme);
        }
      }

      // ---- things people leave against a wall ------------------------------
      // The wall base is where wind, water and people put things, and it is
      // also the only place a non-colliding prop is out of a player's line, so
      // this is where the density goes.
      const leans = Math.min(9, Math.floor(b.span / 2.1));
      for (let i = 0; i < leans && d.props < budget; i++) {
        const u = ((i + 0.5) / leans - 0.5) * (b.span - 1.2) + rng.range(-0.4, 0.4);
        const p = b.at(u, rng.range(0.5, 0.95));
        // Only against real wall: a crate stacked across a doorway or an arch
        // is the same defect as a balcony bolted to daylight.
        const w2 = b.at(u, 0);
        if (!backedByWall(world, w2.x, w2.z, f.nx, f.nz, 0.4, 1.4, { depth })) continue;
        const id = rng.pick(theme.leanProps ?? [
          'crate_a', 'crate_b', 'crate_c', 'barrel_rust', 'barrel_blue', 'barrel_wood',
          'pallet', 'tyre', 'tyre_small', 'planter', 'shrub', 'gas_bottle', 'jerry_can',
          'cabinet', 'shelf', 'chair', 'block_small', 'weeds', 'cinder', 'sack', 'mattress',
        ]);
        const base = groundProp(d, world, id, p.x, p.z, rng.range(0, 6.28), { pack: 0.62 });
        if (!base) continue;
        if (theme.skirts !== false && base.radius > 0.24) {
          skirt(d, world, p.x, base.worldY, p.z, Math.min(base.radius, 0.7), theme.spillKey);
        }
        // stack something on top now and then, on the real top of what is there
        if (rng.bool(0.26) && base.worldTop - base.worldY > 0.08) {
          standProp(d, rng.pick(theme.stackProps
            ?? ['crate_b', 'box_card_a', 'box_card_b', 'tyre_small', 'sack', 'tray']),
            p.x + rng.range(-0.06, 0.06), base.worldTop, p.z + rng.range(-0.06, 0.06),
            rng.range(0, 6.28), { fit: base.fitRadius });
        }
      }

      // ---- a bicycle or a handcart parked against the frontage -------------
      if (theme.vehicles !== false && b.span > 5 && rng.bool(0.4) && d.props < budget) {
        const u = b.centre(rng.int(0, b.count - 1)) + rng.range(-0.6, 0.6);
        const p = b.at(u, rng.range(0.7, 1.0));
        // A bicycle is a 19th-century object. On the citadel `vehicleProps` is
        // the handcart alone, which is not.
        const kit = theme.vehicleProps ?? ['bicycle', 'handcart'];
        const id = kit.length === 1 ? kit[0] : (rng.bool(0.55) ? kit[0] : kit[1]);
        // Parked ALONG the wall, not nose-in: a cart square to a facade reads
        // as furniture that fell off a lorry.
        if (d.quota(id, 2)) {
          groundProp(d, world, id, p.x, p.z, f.yaw + Math.PI / 2 + rng.range(-0.12, 0.12),
            { pack: 0.5 });
        }
      }
    }

    /**
     * A lamp post on an outside corner.
     *
     * The overrides that used to be here — `radius: 0.4, height: 2.4` on a prop
     * that measures 0.62 and 5.5 — are why the Neon Foundry review found a cobra
     * head "planted inside the mid archway, buried in the staircase": a 0.4 m
     * footprint samples the ground at +-0.29 m and never notices the stair 0.3 m
     * away, and a declared height of 2.4 m asks `groundProp` for 1.9 m of lane
     * clearance instead of the 2.6 m a 5.5 m post needs, so it was allowed to
     * stand in the map's primary choke. Measured values only, plus sky overhead
     * — a street lamp under an arch is a street lamp indoors.
     */
    if (theme.lampPosts !== false
      && !mass.perimeter && mass.y1 > 4 && rng.bool(0.35) && d.props < budget) {
      const cx = mass.x + (rng.bool() ? 1 : -1) * (mass.w / 2 + 0.9);
      const cz = mass.z + (rng.bool() ? 1 : -1) * (mass.d / 2 + 0.9);
      const yaw = rng.range(0, 6.28);
      const post = openSky(world, cx, cz, 1.0)
        ? groundProp(d, world, 'lamp_post', cx, cz, yaw)
        : null;
      if (post) {
        // The lantern is part of the same post: its height is measured from
        // whatever the post is standing on, never from world zero, and its
        // offset is the arm's own measured reach.
        putProp(d, 'lamp_glass',
          cx + Math.cos(yaw) * 0.88, post.worldY + 5.36, cz - Math.sin(yaw) * 0.88, yaw);
      }
    }
  }
}

/**
 * Crates and barrels that the MAP placed as colliders.
 *
 * A crate is a cube with a wood texture on it, which is exactly what it looks
 * like. What makes it read as a crate is the FRAME: corner battens, a band
 * around the middle, and a stencil block on one face. Barrels get their rolling
 * hoops and a bung. All of it merges into the same decor batch, so the whole
 * map's crate furniture costs nothing extra to draw.
 */
function dressMapProps(d, world, theme) {
  const rng = d.rng;
  const meshes = world.solids.children;
  for (let i = 0; i < meshes.length; i++) {
    const mesh = meshes[i];
    if (!mesh.isMesh) continue;
    const s = mesh.scale;
    const p = mesh.position;

    // ---- crates: near-cubes tagged as wood ---------------------------------
    if (
      mesh.geometry === world._unitBox &&
      mesh.userData.surface === 'wood' &&
      s.x > 0.7 && s.x < 1.8 &&
      Math.abs(s.x - s.y) < 0.05 && Math.abs(s.x - s.z) < 0.05
    ) {
      const h = s.x / 2;
      const t = 0.055;                       // batten thickness
      const w = 0.085 * s.x;                 // batten width
      const key = rng.bool(0.5) ? 'crateDark' : 'wood';
      // Corner battens on the four vertical edges.
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          d.box(key, p.x + sx * (h - w / 2), p.y, p.z + sz * (h + t / 2), w, s.y * 0.98, t,
            { thin: true, masks: [0.85, 0.5, 0.2] });
          d.box(key, p.x + sx * (h + t / 2), p.y, p.z + sz * (h - w / 2), t, s.y * 0.98, w,
            { thin: true, masks: [0.85, 0.5, 0.2] });
        }
      }
      // A band around the waist and one under the lid.
      for (const y of [p.y - h * 0.45, p.y + h * 0.62]) {
        d.box(key, p.x, y, p.z, s.x + t * 2, w * 0.8, s.z + t * 2,
          { thin: true, masks: [0.8, 0.55, 0.25] });
      }
      /**
       * Stencil plate on one face, so no two crates read identically.
       *
       * It used to be a metalDark panel 42% of the face wide and 20% tall, and
       * against Frostline's snow the Frostline review read it as "a buried crate
       * showing through" — a dark rectangle inside the crate's own silhouette.
       * A stencil is paint: 26 x 15 cm regardless of crate size, in the crate's
       * own material with the wear mask pinned high so it reads as a bleached
       * patch rather than as a hole.
       */
      const face = rng.int(0, 3);
      const nx = face === 0 ? 1 : face === 1 ? -1 : 0;
      const nz = face === 2 ? 1 : face === 3 ? -1 : 0;
      d.box(key,
        p.x + nx * (h + t * 0.7), p.y + h * 0.1, p.z + nz * (h + t * 0.7),
        nx ? 0.01 : Math.min(0.26, s.x * 0.36), 0.15, nz ? 0.01 : Math.min(0.26, s.z * 0.36),
        { thin: true, masks: [1, 0.15, 0] });
      // and the dust that has piled against it
      if (theme.skirts !== false) skirt(d, world, p.x, p.y - s.y / 2, p.z, h * 1.15, theme.spillKey);
      continue;
    }

    // ---- barrels: the shared cylinder --------------------------------------
    // World.column() shares this geometry, so the aspect ratio is not enough:
    // a 1.1 m tall column with a 1.4 m radius would collect hoops and a bung.
    if (
      mesh.geometry === world._cylGeo &&
      mesh.userData.surface === 'metal' &&
      s.y > 0.9 && s.y < 1.3 && s.x < 0.6
    ) {
      const r = s.x;
      // TorusGeometry is authored in the XY plane: lay it flat, then scale the
      // ring to the barrel's radius.
      const hoop = d.geo('hoop', () => new THREE.TorusGeometry(1, 0.05, 5, 16));
      for (const y of [p.y - s.y * 0.28, p.y + s.y * 0.28]) {
        d.add('metalDark', hoop, newTrs(p.x, y, p.z, 0, r * 1.03, r * 1.03, r * 1.03, Math.PI / 2),
          [0.75, 0.6, 0.25]);
      }
      // Bung on the lid.
      d.box('metalDark', p.x + r * 0.42, p.y + s.y * 0.5 + 0.012, p.z, 0.09, 0.03, 0.09,
        { thin: true, masks: [0.6, 0.7, 0.3] });
      if (theme.skirts !== false) skirt(d, world, p.x, p.y - s.y / 2, p.z, r * 1.1, theme.spillKey);
      continue;
    }

    /**
     * Architectural columns: a base and a capital.
     *
     * `World.column()` shares the same 12-sided cylinder as the barrels, and
     * with nothing at either end it "stops dead with no capital and no base and
     * no contact shadow at its feet" (Citadel review). A base ring and a two-part
     * capital cost 4 rings and turn the same box of a prop into masonry. Each
     * ring is tested against the colliders first: Neon Foundry buries 7.5 m of
     * its 10 m hot-metal columns inside the furnace core, and a ring inside a
     * solid is triangles nobody will ever see.
     */
    if (mesh.geometry === world._cylGeo && (s.x >= 0.65 || s.y >= 1.6) &&
        mesh.userData.surface !== 'metal') {
      const r = s.x;
      const y0 = p.y - s.y / 2;
      const y1 = p.y + s.y / 2;
      const ring = d.geo('ring:12', () => tubeY(1, 1, { radial: 12 }));
      const put = (yy, hh, rr, masks) => {
        if (occupied(world, p.x + rr * 0.9, yy + hh / 2, p.z, i)) return;
        d.add(theme.copingKey ?? theme.trimKey, ring,
          newTrs(p.x, yy, p.z, Math.PI / 12, rr, hh, rr), masks);
      };
      // Base: two courses, the lower one wider — a plinth sheds water outward.
      put(y0, 0.1, r * 1.18, [0.45, 0.9, 0.45]);
      put(y0 + 0.1, 0.12, r * 1.09, [0.5, 0.7, 0.35]);
      // Capital: a necking ring then an abacus, both under the top so nothing
      // grows taller than the collider it belongs to.
      put(y1 - 0.34, 0.12, r * 1.08, [0.6, 0.45, 0.25]);
      put(y1 - 0.22, 0.22, r * 1.2, [0.75, 0.35, 0.15]);
      if (theme.skirts !== false) skirt(d, world, p.x, y0, p.z, r * 1.25, theme.spillKey);
      continue;
    }

    /**
     * Low cover boxes: a coping, and end piers.
     *
     * The four low battlements on Citadel "render as plain rectangular stone
     * boxes — flat top, dead straight, no coping, no crenellation, no end piers".
     * The coping is let INTO the top 12 cm of the box rather than laid on it:
     * this is cover a player peeks over, and 12 cm of non-colliding stone added
     * to its height would change what you can see without changing what stops a
     * bullet.
     */
    if (
      mesh.geometry === world._unitBox &&
      mesh.userData.surface !== 'wood' && mesh.userData.surface !== 'sand' &&
      s.y > 0.85 && s.y < 1.5 &&
      Math.max(s.x, s.z) > 2.5 && Math.min(s.x, s.z) < 2.0
    ) {
      const top = p.y + s.y / 2;
      const alongX = s.x >= s.z;
      d.box(theme.copingKey ?? theme.trimKey, p.x, top - 0.06, p.z,
        s.x + 0.1, 0.12, s.z + 0.1, { bevel: 0.018, masks: [0.8, 0.4, 0.15] });
      // End piers, 0.34 m of the run at each end, standing 8 cm proud.
      for (const sgn of [-1, 1]) {
        d.box(theme.copingKey ?? theme.trimKey,
          p.x + (alongX ? sgn * (s.x / 2 - 0.17) : 0), p.y + 0.02,
          p.z + (alongX ? 0 : sgn * (s.z / 2 - 0.17)),
          alongX ? 0.34 : s.x + 0.16, s.y - 0.04, alongX ? s.z + 0.16 : 0.34,
          { bevel: 0.016, masks: [0.6, 0.55, 0.25] });
      }
    }
  }
}

/**
 * Ground the map's own decorative plates.
 *
 * `World.deco()` boxes carry no collider, so nothing in the grounding contract
 * had ever looked at them — and the maps author plates that miss what they are
 * meant to be sitting on. Measured off the live scene:
 *
 *   citadel fountain   water plate 4.2 x 0.12 x 4.2 centred at y 1.2, so its
 *                      underside is 1.14, over a 2.8 m drum topping out at
 *                      1.10: 4 cm of air and 70 cm of overhang on four sides,
 *                      on the map's only central landmark
 *   citadel A/B pads   27 x 15 m paving centred at y 1.25 (underside 1.22) on a
 *                      terrace topping out at 1.20: a 2 cm slot open under all
 *                      405 m2, which a ray at y 1.21 crosses for 37 m unhit
 *
 * The repair is the same in both cases and it is what a mason would build: a
 * course that stands on the MEASURED surface under the plate's edge and stops
 * at the plate's own top face. Two rules keep it safe, because none of this has
 * a collider:
 *
 *  - it never leaves the plate's own footprint, so the volume a player can
 *    walk into is exactly the volume the plate already occupied;
 *  - it never rises above the plate, so nothing new blocks a sightline across
 *    a bomb site.
 *
 * A gap deeper than MAX_FILL is not a plate that missed its seat — it is a
 * cornice or roof cap authored to fly (Frostline's 12.4 x 36.4 m roof plates
 * measure 6.6 m of air under their edge). Those are left to the corbels in
 * `dressMassShell`; filling them would build a storey-high wall.
 */
function dressDecorSlabs(d, world, masses, theme) {
  const MAX_FILL = 1.4;
  const keys = wallKeysOf(world);
  const cols = world.colliders;

  /** What a course dropped at (x,z) would land on, and which collider it is. */
  const supportAt = (x, z, below) => {
    let y = -Infinity;
    let idx = -1;
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      if (
        x > c.min.x && x < c.max.x && z > c.min.z && z < c.max.z &&
        c.max.y <= below && c.max.y > y
      ) {
        y = c.max.y;
        idx = i;
      }
    }
    // A mass's coping is real geometry a plate can sit on, and it is 22 cm
    // proud of the mass top: the keeps' roof plates on Citadel and Frostline
    // land on it, not on the collider, and filling under them would draw a
    // second fascia over the one that is already there.
    for (const m of masses) {
      if (m.deckY > below || m.deckY <= y) continue;
      if (Math.abs(x - m.x) < m.w / 2 + 0.14 && Math.abs(z - m.z) < m.d / 2 + 0.14) {
        y = m.deckY;
        idx = -1;
      }
    }
    return { y, idx };
  };

  for (const mesh of world.environment.children) {
    if (!mesh.isMesh || mesh.geometry !== world._unitBox) continue;
    if (Math.abs(mesh.rotation.y) > 1e-3) continue; // this is AABB arithmetic
    const s = mesh.scale;
    const p = mesh.position;
    // A plate is broad, thin and horizontal. The test excludes the container
    // ribs (0.07 x 2.66 x 2.54), the sandbag detail boxes (0.66 across) and
    // every upright sign panel, without naming any of them.
    if (s.y > 0.6 || s.x < 1.5 || s.z < 1.5 || s.y > Math.min(s.x, s.z) * 0.45) continue;
    // Harbor's water strips live at x = +-51.1, outside the arena: unreachable,
    // and the last thing the sea needs is a kerb around it.
    if (!inBounds(world, p.x, p.z, 0)) continue;

    const under = p.y - s.y / 2;
    const top = p.y + s.y / 2;
    const band = Math.min(0.36, Math.max(0.14, Math.min(s.x, s.z) * 0.09));
    // Sides in face order: [-x, +x, -z, +z]. Each is measured on its own,
    // because a plate can bridge a terrace and open ground.
    const sides = [
      { ax: 'x', sign: -1, along: s.z },
      { ax: 'x', sign: 1, along: s.z },
      { ax: 'z', sign: -1, along: s.x },
      { ax: 'z', sign: 1, along: s.x },
    ];
    let drew = 0;
    for (const side of sides) {
      const halfOut = (side.ax === 'x' ? s.x : s.z) / 2 - band / 2;
      let lo = Infinity;
      let idx = -1;
      // Five samples along the run. The LOWEST support wins: a course that is
      // buried where the ground rises is invisible, a course that stops short
      // where it falls away is the defect being fixed.
      for (let i = 0; i <= 4; i++) {
        const t = (i / 4 - 0.5) * (side.along - band) * 0.98;
        const sx = p.x + (side.ax === 'x' ? side.sign * halfOut : t);
        const sz = p.z + (side.ax === 'z' ? side.sign * halfOut : t);
        const g = supportAt(sx, sz, under + 0.01);
        if (g.y < lo) {
          lo = g.y;
          idx = g.idx;
        }
      }
      const gap = under - lo;
      if (!(gap > 0.015) || gap > MAX_FILL) continue;
      drew++;
      // A kerb belongs to the deck it stands on, so it takes that surface's own
      // material and reads as a threshold rather than as a third stone. A
      // pedestal deep enough to be architecture takes the theme's coping.
      const key = gap > 0.35
        ? (theme.copingKey ?? theme.trimKey)
        : (keys && idx >= 0 ? keys[idx] : null) ?? theme.trimKey;
      const cx = p.x + (side.ax === 'x' ? side.sign * halfOut : 0);
      const cz = p.z + (side.ax === 'z' ? side.sign * halfOut : 0);
      // Z-sides are shortened to the X-sides' inner faces so the corners are
      // built once rather than twice.
      const run = side.ax === 'x' ? s.z : s.x - band * 2;
      const wide = side.ax === 'x' ? band : run;
      const deep = side.ax === 'x' ? run : band;
      if (gap > 0.35) {
        /**
         * Three courses: a base that catches the ground dirt, a wall set back
         * from both, and a cap. One flat band 1.1 m tall is a planter box; the
         * set-back is what makes it a basin.
         *
         * The cap finishes 2 cm ABOVE the plate. That is the one place the "never
         * rise above the slab" rule bends, and it has to: a cap whose top face is
         * coplanar with the water's top face z-fights along the whole rim, and a
         * basin brim-full to the millimetre reads as a lid anyway. 2 cm at 1.26 m
         * blocks no sightline.
         */
        const baseH = Math.min(0.18, gap * 0.16);
        const capTop = top + 0.02;
        const capH = Math.min(0.12, gap * 0.11) + 0.02;
        d.box(key, cx, lo + baseH / 2, cz, wide, baseH, deep,
          { bevel: 0.02, masks: [0.5, 0.9, 0.4] });
        const inset = 0.05;
        d.box(key, cx - (side.ax === 'x' ? side.sign * inset : 0), (lo + baseH + capTop - capH) / 2,
          cz - (side.ax === 'z' ? side.sign * inset : 0),
          side.ax === 'x' ? band - inset : wide, (capTop - capH) - (lo + baseH),
          side.ax === 'z' ? band - inset : deep,
          { bevel: 0.016, masks: [0.4, 0.6, 0.3] });
        d.box(key, cx, capTop - capH / 2, cz, wide, capH, deep,
          { bevel: 0.018, masks: [0.75, 0.35, 0.15] });
      } else {
        // A kerb stops 5 mm under the paving it edges, so the plate oversails it
        // as a drip edge instead of fighting it for the same plane.
        d.box(key, cx, (lo + top - 0.005) / 2, cz, wide, top - 0.005 - lo, deep,
          { bevel: 0.014, masks: [0.7, 0.6, 0.3] });
      }
    }
    if (drew) d.props += 1;
  }
}

/**
 * Stands under anything the map left in mid-air.
 *
 * Harbor authors a shipping container at `y: 3.9` as the top of a two-high stack
 * and never places the base one: collider x[-34.9,-29.1] y[2.6,5.2] z[22.8,25.3],
 * with nothing under it but the apron, 2.6 m of daylight you can see the far
 * seawall through, and it is the first thing you see leaving T spawn West.
 *
 * Dressing cannot fix that by moving the box — it is a collider, and colliders
 * are gameplay. What it CAN do is build what the box is standing on, and the
 * choice of structure is dictated by the one constraint this file never breaks:
 * nothing here stops a player, so filling the 2.6 m void with a solid-looking
 * mass would put a wall where people walk. A stand does not: four 0.26 m posts
 * on the corners, a bottom frame and a pair of braces occupy almost no floor,
 * read instantly as "on stands" (which is how a container waits for a chassis),
 * and leave the gap walkable exactly as it is today.
 *
 * The spanning test is what keeps roofs out of it: the customs hall's ceiling
 * slab is also "floating" by any support test, and it needs no legs because it
 * is carried by the walls on both sides.
 */
function dressStilts(d, world, theme) {
  const cols = world.colliders;
  const meshes = world.solids.children;
  for (let i = 0; i < meshes.length; i++) {
    const mesh = meshes[i];
    if (!mesh.isMesh || mesh.geometry !== world._unitBox) continue;
    const s = mesh.scale;
    const p = mesh.position;
    const y0 = p.y - s.y / 2;
    if (y0 < 0.4 || s.x < 1.2 || s.z < 1.2) continue;
    // What is under it, if anything.
    let sup = 0;
    for (let j = 0; j < cols.length; j++) {
      if (j === i) continue;
      const c = cols[j];
      if (p.x > c.min.x && p.x < c.max.x && p.z > c.min.z && p.z < c.max.z &&
        c.max.y <= y0 + 0.02 && c.max.y > sup) sup = c.max.y;
    }
    const gap = y0 - sup;
    if (gap < 0.5 || gap > 3.6) continue;
    // Spanning? A lintel or a ceiling has masonry beyond two opposite faces.
    const mid = y0 + s.y / 2;
    let pairX = 0;
    let pairZ = 0;
    for (const sgn of [-1, 1]) {
      if (occupied(world, p.x + sgn * (s.x / 2 + 0.5), mid, p.z, i)) pairX++;
      if (occupied(world, p.x, mid, p.z + sgn * (s.z / 2 + 0.5), i)) pairZ++;
    }
    if (pairX > 1 || pairZ > 1) continue;

    const post = 0.26;
    const ix = s.x / 2 - post / 2 - 0.34;
    const iz = s.z / 2 - post / 2 - 0.34;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const px = p.x + sx * ix;
        const pz = p.z + sz * iz;
        d.box('metalDark', px, (sup + y0) / 2, pz, post, gap, post,
          { bevel: 0.014, masks: [0.6, 0.75, 0.4] });
        // a foot plate, so the post is standing on the apron not in it
        d.box('metalDark', px, sup + 0.03, pz, post + 0.16, 0.06, post + 0.16,
          { thin: true, masks: [0.5, 0.9, 0.5] });
        if (theme.skirts !== false) skirt(d, world, px, sup, pz, 0.28, theme.spillKey);
      }
    }
    // Bottom frame tying the posts together, and a brace on each long side.
    for (const sz of [-1, 1]) {
      d.box('metalDark', p.x, sup + 0.28, p.z + sz * iz, ix * 2, 0.14, 0.12,
        { thin: true, masks: [0.7, 0.6, 0.3] });
      // The brace is a box rotated about Z, so its length has to be the true
      // diagonal of the bay it crosses or it lands short of the far post.
      const diag = Math.hypot(ix * 2, gap - 0.3);
      d.box('metalDark', p.x, (sup + 0.28 + y0) / 2, p.z + sz * iz, diag, 0.1, 0.1,
        { thin: true, rz: Math.atan2(gap - 0.3, ix * 2) * (sz > 0 ? 1 : -1),
          masks: [0.7, 0.6, 0.3] });
    }
    d.props++;
  }
}

/**
 * A fixture for every one of the map's own practical lights.
 *
 * `buildDefinitionGeometry` adds each definition light as a bare PointLight, and
 * two reviews found the same consequence: "two 19.6 W practicals hang in mid-air
 * with no fixture" (Citadel, at (-2,3,-5) and (2,3,5)), and "a warm pool sits on
 * the customs-hall ceiling with no lamp geometry anywhere — it reads as a light
 * leak" (Harbor). The light cannot move — it is authored, gameplay-visible
 * lighting — so the fixture is built around wherever it already is:
 *
 *   ceiling within 4 m   a pendant on a rod, which is what a hall light is
 *   wall within 1.3 m    a bracket lantern
 *   otherwise            a standing torch, on the nearest spot that is NOT in a
 *                        walked lane — nothing here has a collider, so a post in
 *                        a lane is a post players walk through
 *
 * This runs before every other pass so the fixture's footprint is claimed first
 * and the scatter routes around it.
 */
function dressPracticals(d, world, theme) {
  const rng = d.rng;
  const glass = 'neonA';
  for (const light of world.environment.children) {
    if (!light.isPointLight) continue;
    // A fixture for a light that emits nothing is a lamp that is not there: the
    // Neon Foundry rig carries six PointLights at intensity 0, and hanging a
    // pendant off each of them would be inventing six lamps out of dead weight.
    if (!(light.intensity > 0.01)) continue;
    const lx = light.position.x;
    const ly = light.position.y;
    const lz = light.position.z;
    if (!inBounds(world, lx, lz, 0)) continue;

    // ---- is there a ceiling over it?
    let ceil = 0;
    for (let h = 0.35; h < 4; h += 0.2) {
      if (occupied(world, lx, ly + h, lz, -1)) { ceil = ly + h; break; }
    }
    if (ceil > 0) {
      const rod = d.geo('pipe:0.022:6', () => tubeY(0.022, 1, { radial: 6 }));
      d.add('metalDark', rod, newTrs(lx, ly + 0.14, lz, 0, 1, ceil - ly - 0.14, 1), [0.6, 0.7, 0.2]);
      // ceiling rose, so the rod comes out of something
      d.box('metalDark', lx, ceil - 0.03, lz, 0.16, 0.06, 0.16, { thin: true, masks: [0.5, 0.8, 0.4] });
      // A wide shallow shade: an industrial pendant is a dish, and the dish is
      // what makes the pool of light on the floor legible as a lamp's pool. It is
      // a closed frustum rather than an open cone because an open cone shows only
      // backfaces to anyone standing under it, which is everyone.
      d.add('metalDoor', d.geo('shade:0.34', () => tubeY(0.34, 0.26, { radial: 14, taper: 0.3 })),
        newTrs(lx, ly + 0.08, lz), [0.5, 0.6, 0.25]);
      d.add(glass, d.geo('bulb', () => new THREE.SphereGeometry(0.07, 6, 5)),
        newTrs(lx, ly + 0.06, lz), [0, 0, 0]);
      d.props++;
      continue;
    }

    // ---- is there a wall within arm's reach?
    let wall = null;
    for (const f of FACES) {
      for (let dd = 0.35; dd < 1.35; dd += 0.15) {
        if (occupied(world, lx + f.nx * dd, ly, lz + f.nz * dd, -1)) {
          if (!wall || dd < wall.dist) wall = { f, dist: dd };
          break;
        }
      }
    }
    if (wall) {
      // The bracket is built from the wall plane outward, same as every other
      // wall fitting: plate on the render, arm across the gap, lantern at the
      // light. `nx/nz` point AWAY from the light, so the plate is at +dist.
      const f = wall.f;
      const px = lx + f.nx * (wall.dist - 0.03);
      const pz = lz + f.nz * (wall.dist - 0.03);
      d.box('metalDark', px, ly + 0.1, pz,
        f.axis === 'x' ? 0.06 : 0.16, 0.3, f.axis === 'x' ? 0.16 : 0.06,
        { thin: true, masks: [0.5, 0.75, 0.35] });
      d.box('metalDark', lx + f.nx * (wall.dist / 2), ly + 0.24, lz + f.nz * (wall.dist / 2),
        f.axis === 'x' ? wall.dist : 0.05, 0.05, f.axis === 'x' ? 0.05 : wall.dist,
        { thin: true, masks: [0.8, 0.6, 0.2] });
      d.add('metalDoor', d.geo('shade:0.22', () => tubeY(0.22, 0.2, { radial: 12, taper: 0.35 })),
        newTrs(lx, ly + 0.06, lz), [0.55, 0.6, 0.2]);
      d.add(glass, d.geo('bulb', () => new THREE.SphereGeometry(0.07, 6, 5)),
        newTrs(lx, ly + 0.04, lz), [0, 0, 0]);
      d.props++;
      continue;
    }

    // ---- otherwise it stands on the ground: a torch on a tripod
    let spot = null;
    for (let ring = 0; ring < 4 && !spot; ring++) {
      const rr = ring * 0.7;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2 + ring * 0.4;
        const sx = lx + Math.cos(a) * rr;
        const sz = lz + Math.sin(a) * rr;
        // 1.1 m of lane clearance: half a lane plus a player's own half-width,
        // which is the least that keeps a 3 m post out of a running line.
        const surface = standing(world, sx, sz, 0.34, Math.max(0.6, ly - 0.4), 2.6, 1.1);
        if (surface !== null && d.free(sx, sz, 0.5)) {
          spot = { x: sx, z: sz, y: surface };
          break;
        }
        if (rr === 0) break;
      }
    }
    if (!spot) continue;
    d.claim(spot.x, spot.z, 0.5);
    const post = d.geo('pipe:0.05:7', () => tubeY(0.05, 1, { radial: 7 }));
    const stand = Math.max(0.5, ly - 0.22 - spot.y);
    /**
     * A smooth grey tube on a stepped disc foot is a modern lighting column —
     * which is what the Citadel review saw when it listed "modern street lamp
     * posts" among the reasons the fort read as an industrial town, even though
     * the fitting on top of it is a fire basket. `fixtureKey` moves it onto
     * wrought iron and `braziers` swaps the disc foot for three splayed legs,
     * so it matches the standing braziers rather than the streetlights.
     */
    const ironKey = theme.fixtureKey ?? 'metalDark';
    d.add(ironKey, post, newTrs(spot.x, spot.y, spot.z, 0, 1, stand, 1), [0.7, 0.7, 0.25]);
    if (theme.braziers) {
      for (let k = 0; k < 3; k++) {
        const a = (k / 3) * Math.PI * 2 + rng.range(-0.15, 0.15);
        d.add(ironKey, post,
          newTrs(spot.x + Math.cos(a) * 0.14, spot.y + 0.02, spot.z + Math.sin(a) * 0.14,
            -a, 0.7, 0.42, 0.7, 0, 0.62),
          [0.85, 0.75, 0.35]);
      }
    } else {
      // A stepped foot, so it is standing on the deck rather than growing out of
      // it. Two courses off the same tube: 0.3 m and 0.2 m across.
      d.add(ironKey, post, newTrs(spot.x, spot.y, spot.z, 0, 6, 0.06, 6), [0.8, 0.8, 0.4]);
      d.add(ironKey, post, newTrs(spot.x, spot.y + 0.06, spot.z, 0, 4, 0.1, 4), [0.75, 0.7, 0.35]);
    }
    // the basket and its coals, at the light's own height
    const bowl = d.geo('bowl', () => new THREE.CylinderGeometry(0.26, 0.14, 0.22, 10, 1, true));
    d.add(ironKey, bowl, newTrs(spot.x, spot.y + stand + 0.09, spot.z), [0.85, 0.5, 0.2]);
    d.add(glass, d.geo('coals', () => new THREE.SphereGeometry(0.19, 7, 5)),
      newTrs(spot.x, spot.y + stand + 0.14, spot.z, rng.float() * 6.28, 1, 0.6, 1), [0, 0, 0]);
    d.props++;
  }
}

/** Ground: drifts against walls, rubble, puddles, weeds. */
function dressGround(d, world, masses, theme) {
  const rng = d.rng;
  const b = boundsOf(world);

  for (const mass of masses) {
    if (mass.y0 > 0.2) continue;
    for (const f of exposedFaces(world, mass)) {
      const bay = baysOf(mass, f);
      if (bay.span < 3) continue;
      const steps = Math.max(1, Math.round(bay.span / 3.4));
      for (let i = 0; i < steps; i++) {
        const u = ((i + 0.5) / steps - 0.5) * bay.span;
        // Anchored just off the face: a berm is a fillet AT the wall, so its
        // tall edge has to start there. Sampled with a small radius, because a
        // 0.7 m footprint half a metre from a wall is inside the wall.
        const p = bay.at(u, 0.28);
        const surface = standing(world, p.x, p.z, 0.22, 0.3, mass.y1 - 0.2);
        if (surface === null) continue;
        // driftBerm runs along local +X with its crest at z = 0 feathering to
        // +z, so it has to be turned to face OUT of this wall, not merely
        // aligned with its axis — half the berms used to point into the render.
        const ry = f.yaw;

        // Wind piles material against every wall it can reach — sand here,
        // snow on Frostline, grit and litter in the yards.
        if (theme.drift && rng.bool(theme.driftChance ?? 0.5)) {
          const len = (bay.span / steps) * rng.range(0.6, 0.95);
          const g = driftBerm(rng, len, rng.range(0.7, 1.3), rng.range(0.12, 0.3));
          d.add(theme.driftKey, g, newTrs(p.x, surface + 0.005, p.z, ry), [0.1, 0.35, 0.2]);
          g.dispose();
        }

        // Rubble at the foot of the wall. The jitter is applied BEFORE the
        // support test, not after — displacing a point that standing() already
        // approved is how debris ended up inside walls and over ledges.
        if (rng.bool(0.45)) {
          for (let k = 0, n = rng.int(2, 5); k < n; k++) {
            const jx = p.x + (f.axis === 'x' ? rng.signed() * 0.5 : rng.signed() * 0.9);
            const jz = p.z + (f.axis === 'x' ? rng.signed() * 0.9 : rng.signed() * 0.5);
            const s = rng.range(0.1, 0.34);
            const h = standing(world, jx, jz, s * 0.5, s, mass.y1 - 0.2);
            if (h === null) continue;
            const g = rockGeometry(rng, s, 0, rng.range(0.5, 0.8));
            d.add(theme.rubbleKey, g,
              newTrs(jx, h + s * 0.22, jz, rng.range(0, 6.28)), [0.55, 0.7, 0.3]);
            g.dispose();
          }
        }

        // Standing water on the wet maps, a dry weed clump on the others.
        if (theme.puddles && rng.bool(0.3)) {
          const jx = p.x + rng.signed() * 0.5;
          const jz = p.z + rng.signed() * 0.5;
          const h = standing(world, jx, jz, 0.7, 0.15, mass.y1 - 0.2);
          if (h !== null) {
            const g = patchGeometry(rng, rng.range(0.6, 1.5), { lobes: 9, wobble: 0.5 });
            d.add('water', g, newTrs(jx, h + 0.012, jz), [0, 0, 0]);
            g.dispose();
          }
        } else if (theme.vegetation !== false && rng.bool(0.45)) {
          // Weeds grow in the crack where the render meets the pavement, so
          // they belong tight against the wall, not scattered across the yard.
          for (let k = 0, n = rng.int(1, 3); k < n; k++) {
            const j = bay.at(u + (f.axis === 'x' ? 0 : rng.signed() * 0.8), rng.range(0.12, 0.4));
            groundProp(d, world, rng.pick(['weeds', 'weeds', 'shrub']),
              j.x + (f.axis === 'x' ? rng.signed() * 0.8 : 0), j.z, rng.range(0, 6.28),
              { pack: 0.3, scale: rng.range(0.6, 1.2) });
          }
        }

        // The litter and swept rubbish that collects along every kerb.
        for (let k = 0, n = rng.int(1, 4); k < n; k++) {
          const j = bay.at(u + (f.axis === 'x' ? 0 : rng.signed() * 1.2), rng.range(0.25, 0.95));
          groundProp(d, world,
            rng.pick(theme.kerbDebris
              ?? ['litter', 'can', 'bottle', 'brick_a', 'cinder', 'plank_b', 'litter']),
            j.x + (f.axis === 'x' ? rng.signed() * 1.2 : 0), j.z, rng.range(0, 6.28),
            { radius: 0.28, pack: 0.32 });
        }
      }
    }
  }

  // Free-standing debris across the open ground.
  const spread = theme.debris ?? 26;
  for (let i = 0; i < spread * 2; i++) {
    const x = rng.range(b.x0 + 4, b.x1 - 4);
    const z = rng.range(b.z0 + 4, b.z1 - 4);
    const roll = rng.float();
    if (roll < 0.42) {
      const s = rng.range(0.12, 0.4);
      const y = standing(world, x, z, s * 0.5, s);
      if (y === null) continue;
      const g = rockGeometry(rng, s, 0, 0.6);
      d.add(theme.rubbleKey, g, newTrs(x, y + s * 0.2, z, rng.range(0, 6.28)), [0.5, 0.7, 0.3]);
      g.dispose();
    } else if (roll < 0.7) {
      // a flattened patch of grit / spill
      const y = standing(world, x, z, 0.6, 0.12);
      if (y === null) continue;
      const g = patchGeometry(rng, rng.range(0.5, 1.2), { lobes: 8, wobble: 0.55 });
      d.add(theme.spillKey, g, newTrs(x, y + 0.01, z), [0.1, 0.8, 0.3]);
      g.dispose();
    } else {
      groundProp(d, world, rng.pick(theme.rubbleDebris
        ?? ['plank_a', 'plank_b', 'brick_a', 'cinder', 'litter', 'can', 'bottle']),
        x, z, rng.range(0, 6.28), { radius: 0.35, pack: 0.4 });
    }
  }
}

/** Cables strung between tall masses, and the laundry that follows them. */
function dressCables(d, world, masses, theme) {
  const rng = d.rng;
  const tall = masses.filter((m) => m.y1 > 4.0 && m.w > 2.5 && m.d > 2.5 && !m.perimeter);
  if (tall.length < 2) return;

  /**
   * Where a span leaves a mass.
   *
   * `min(w,d)/2` is not where the wall is: on a 12 x 3 block a span heading
   * east exits at x = 6, not at 1.5, so the rope used to start a metre inside
   * the masonry. This is the real exit distance along the span direction.
   */
  const exit = (m, dx, dz) => {
    const tx = Math.abs(dx) > 1e-4 ? (m.w / 2) / Math.abs(dx) : Infinity;
    const tz = Math.abs(dz) > 1e-4 ? (m.d / 2) / Math.abs(dz) : Infinity;
    return Math.min(tx, tz);
  };
  /** Is the span clear of every other mass along its length? */
  const spanClear = (ax, ay, az, bx, by, bz) => {
    for (let i = 1; i < 6; i++) {
      const t = i / 6;
      if (occupied(world, ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t, -1)) return false;
    }
    return true;
  };

  let made = 0;
  const want = theme.cableCount ?? 10;
  for (let i = 0; i < tall.length && made < want; i++) {
    const a = tall[i];
    for (let j = i + 1; j < tall.length && made < want; j++) {
      const bm = tall[j];
      const dist = Math.hypot(a.x - bm.x, a.z - bm.z);
      if (dist < 7 || dist > 24) continue;
      if (!rng.bool(0.5)) continue;
      const ux = (bm.x - a.x) / dist;
      const uz = (bm.z - a.z) / dist;
      const laundry = theme.laundry !== false && dist < 15 && rng.bool(0.45);
      const ya = (laundry ? Math.min(a.y1, bm.y1) - rng.range(1.4, 2.6) : a.y1 - rng.range(0.4, 1.2));
      const yb = (laundry ? ya + rng.range(-0.3, 0.3) : bm.y1 - rng.range(0.4, 1.2));
      const ax = a.x + ux * exit(a, ux, uz);
      const az = a.z + uz * exit(a, ux, uz);
      const bx = bm.x - ux * exit(bm, ux, uz);
      const bz = bm.z - uz * exit(bm, ux, uz);
      const sag = dist * (laundry ? 0.06 : rng.range(0.05, 0.09));
      if (!spanClear(ax, ya - sag, az, bx, yb - sag, bz)) continue;

      const strands = laundry ? 1 : rng.int(1, 3);
      for (let s = 0; s < strands; s++) {
        const off = (s - (strands - 1) / 2) * 0.16;
        const g = catenaryTube(
          [ax, ya + off * 0.4, az + off], [bx, yb + off * 0.4, bz + off],
          sag, laundry ? 0.012 : 0.022, { seg: 10, radial: 4 }
        );
        fillMasks(g, 0.2, 0.7, 0.1);
        d.add('metalDark', g, null);
        g.dispose();
      }
      if (laundry) {
        // Garments hung along it, following the same droop. clothGeometry is
        // CENTRED on its origin, so a garment hung at the rope's height floats
        // half its own height above the line — it has to drop by h/2.
        const yaw = Math.atan2(bx - ax, bz - az);
        for (let k = 0, items = rng.int(3, 6); k < items; k++) {
          const t = (k + 0.7) / (items + 0.4);
          const droop = 4 * sag * t * (1 - t);
          const gh = rng.range(0.4, 0.85);
          const g = clothGeometry(rng.range(0.35, 0.7), gh,
            { sag: 0.05, wrinkle: 0.06, rng, hem: 1, fray: 0.02 });
          d.add(theme.clothKey ?? 'sandbag', g,
            newTrs(ax + (bx - ax) * t, ya + (yb - ya) * t - droop - gh / 2 + 0.03,
              az + (bz - az) * t, yaw), [0.3, 0.45, 0.2]);
          g.dispose();
        }
        d.props += 2;
      }
      made++;
    }
  }
}

/**
 * The open street: market rows, barriers, tyre stacks, planting and the parked
 * vehicles. A row is what a market looks like — several stalls on the same line
 * with their canopies at the same height. Scattering single stalls at random
 * reads as furniture that fell off a lorry.
 */
function dressOpenGround(d, world, theme) {
  const rng = d.rng;
  const b = boundsOf(world);
  const budget = theme.propBudget ?? 240;

  // ---- market rows --------------------------------------------------------
  for (let attempt = 0; attempt < (theme.marketRows ?? 0) * 8 && d.props < budget; attempt++) {
    const x = rng.range(b.x0 + 8, b.x1 - 8);
    const z = rng.range(b.z0 + 8, b.z1 - 8);
    const along = rng.bool() ? 0 : Math.PI / 2;
    const dx = Math.sin(along);
    const dz = Math.cos(along);
    const count = rng.int(2, 4);
    // 3.0 m pitch on a 2.3 m stall: the canopies have to clear each other, and
    // at 2.6 m the sheets of neighbouring stalls merged into one lumpy blanket
    // down the whole row.
    const PITCH = 3.0;
    let room = true;
    let floor = null;
    for (let k = 0; k < count; k++) {
      // A market row is 2.3 m of stall plus a canopy: it belongs in the dead
      // space beside a lane, never across one — and never under a roof.
      const sx = x + dx * k * PITCH;
      const sz = z + dz * k * PITCH;
      const h = standing(world, sx, sz, 1.3, 2.1, 2.6, 2.4);
      if (h === null || !d.free(sx, sz, 1.2) || !openSky(world, sx, sz, h + 2.1) ||
        (floor !== null && Math.abs(h - floor) > 0.02)) { room = false; break; }
      floor = h;
    }
    if (!room || floor === null) continue;

    const facing = along + Math.PI / 2 + (rng.bool() ? 0 : Math.PI);
    for (let k = 0; k < count; k++) {
      const sx = x + dx * k * PITCH;
      const sz = z + dz * k * PITCH;
      d.claim(sx, sz, 1.2);
      // The stall carries its OWN canopy frame to 2.01 m, so the sheet goes on
      // that frame. Drawing a second set of poles beside it was two frames for
      // one canopy, and the sheet floated 20 cm over both of them.
      // Yaw varies per stall, not per row: four stalls at one pitch casting four
      // identical parallelogram shadows was the Citadel review's exhibit A.
      const stall = standProp(d, 'stall', sx, floor, sz, facing + rng.range(-0.16, 0.16));
      if (!stall) continue;
      /**
       * The canopy, sized to the frame it lies on.
       *
       * `stall()` carries its own canopy frame: two rails 0.93 m apart at
       * y = 1.98..2.01 spanning the 2.3 m top. The sheet was authored 2.34 x 1.9
       * and tipped 0.14 rad, so it overhung those rails by half a metre front and
       * back, touched them nowhere, and its own sag pulled the middle below them:
       * "canopy corners hover ~0.3 m clear of all four posts and the sheet
       * pinches to a saddle waist". Laid FLAT at the rails' measured top, the
       * cloth rests on both rails and sags between them, which is what cloth on
       * two rails does. 0.155 m of overhang each side is a hem, not a cantilever.
       */
      const g = clothGeometry(2.36, 1.24, { sag: 0.05, wrinkle: 0.03, rng, hem: 1, bow: -1 });
      d.add(theme.clothKey ?? 'sandbag', g,
        newTrs(sx, stall.worldTop + 0.012, sz, stall.ry, 1, 1, 1, -Math.PI / 2), [0.35, 0.5, 0.2]);
      g.dispose();
      // goods on the trestle (its measured top) and stacked on the ground, in
      // the frame of the stall as it was actually placed — jitter included
      const cos = Math.cos(stall.ry);
      const sin = Math.sin(stall.ry);
      const trestle = floor + 0.865;
      for (let i = 0, n = rng.int(2, 4); i < n; i++) {
        // Offsets in the STALL's own frame, then rotated: world-axis offsets on
        // a rotated 2.3 x 1.05 trestle put the goods in mid-air beside it.
        const lx = rng.range(-0.95, 0.95);
        const lz = rng.range(-0.3, 0.3);
        standProp(d, rng.pick(['tray', 'produce', 'box_card_b', 'bucket', 'sack']),
          sx + lx * cos + lz * sin, trestle, sz - lx * sin + lz * cos, rng.range(0, 6.28));
      }
      for (let i = 0, n = rng.int(1, 3); i < n; i++) {
        const lx = rng.range(-1.1, 1.1);
        const lz = rng.range(0.75, 1.4) * (rng.bool() ? 1 : -1);
        groundProp(d, world, rng.pick(['crate_b', 'box_card_a', 'sack', 'crate_flat', 'bucket', 'tray']),
          sx + lx * cos + lz * sin, sz - lx * sin + lz * cos, rng.range(0, 6.28), { pack: 0.5 });
      }
    }
    // something at the end of the row
    groundProp(d, world, rng.pick(theme.rowEndProps
      ?? ['barrel_wood', 'chair', 'stool', 'planter', 'shelf', 'handcart']),
      x - dx * (PITCH - 0.8), z - dz * (PITCH - 0.8), rng.range(0, 6.28), { pack: 0.6 });
  }

  // ---- everything else scattered where there is room ----------------------
  /**
   * The scatter kinds this theme actually owns.
   *
   * Every branch below is a class of object, not a single prop, and a class is
   * either in a place's vocabulary or it is not: a citadel has no vulcanised
   * rubber, no precast jersey barrier, no Euro pallet and no aluminium can, and
   * the Citadel review measured what that costs — `decor:rubber` at 69,440
   * triangles was the single largest mesh in the map, spent entirely on tyre
   * stacks in a medieval fort. Each flag defaults to on, so the four other maps
   * are untouched until they opt out.
   */
  const kinds = theme.scatter ?? {};
  const has = (k) => kinds[k] !== false;
  const scatter = theme.streetProps ?? 34;
  for (let i = 0; i < scatter * 3 && d.props < budget; i++) {
    const x = rng.range(b.x0 + 5, b.x1 - 5);
    const z = rng.range(b.z0 + 5, b.z1 - 5);
    const roll = rng.float();
    if (roll < 0.14 && has('barriers')) {
      // A short run of jersey barriers, as a line rather than a lone block.
      // Three identical blocks at identical rotation and identical spacing is
      // what both the Harbor and Citadel reviews picked out, so each unit gets
      // its own nudge and one joint in the run is left open, the way a barrier
      // line looks after something has driven through it.
      const yaw = rng.pick([0, Math.PI / 2]) + rng.range(-0.08, 0.08);
      const n = rng.int(2, 4);
      const skip = rng.bool(0.3) ? rng.int(1, n - 1) : -1;
      let along = 0;
      for (let k = 0; k < n; k++) {
        if (k === skip) { along += 1.1; continue; }
        const bx = x + Math.cos(yaw) * along;
        const bz = z - Math.sin(yaw) * along;
        along += 1.95 + rng.range(0, 0.22);
        if (!groundProp(d, world, 'jersey', bx, bz, yaw + rng.range(-0.05, 0.05),
          { radius: 1.0, pack: 0.85 })) break;
      }
    } else if (roll < 0.26 && has('tyres')) {
      // A tyre stack: one support test, then every tyre on the one below it.
      // The tyre model already stands on its own origin — the +0.10 "half a
      // section of lift" this used to add floated the whole stack 10 cm.
      const base = groundProp(d, world, 'tyre', x, z, rng.range(0, 6.28), { pack: 0.6 });
      if (base) {
        let top = base.worldTop;
        for (let k = 1, n = rng.int(2, 4); k < n; k++) {
          const t = standProp(d, k === n - 1 ? 'tyre_small' : 'tyre',
            x + rng.range(-0.05, 0.05), top - 0.012, z + rng.range(-0.05, 0.05),
            rng.range(0, 6.28));
          if (!t) break;
          top = t.worldTop;
        }
        if (theme.skirts !== false) skirt(d, world, x, base.worldY, z, 0.42, theme.spillKey);
      }
    } else if (roll < 0.38 && has('pallets')) {
      const base = groundProp(d, world, 'pallet', x, z, rng.range(0, 6.28), { pack: 0.7 });
      if (base && rng.bool(0.7)) {
        let top = base.worldTop;
        let fit = base.fitRadius;
        for (let k = 0, n = rng.int(1, 3); k < n; k++) {
          // Squared up on the deck: a pallet load that is cocked 7 degrees and
          // 12 cm off centre reads as a physics glitch, not as stacking.
          const c = standProp(d, rng.pick(['crate_a', 'crate_b', 'box_card_a', 'sack']),
            x + rng.range(-0.05, 0.05), top, z + rng.range(-0.05, 0.05),
            base.ry + rng.range(-0.05, 0.05), { fit });
          if (!c) break;
          top = c.worldTop;
          fit = c.radius;
        }
      }
    } else if (roll < 0.52 && theme.vegetation !== false) {
      // Planting comes in clumps: one shrub in the middle of a yard is a prop,
      // three around a planter is a corner someone looks after.
      const lead = groundProp(d, world, rng.pick(theme.plantProps ?? ['planter', 'shrub']), x, z,
        rng.range(0, 6.28), { pack: 0.6 });
      if (lead) {
        for (let k = 0, n = rng.int(1, 3); k < n; k++) {
          const a = rng.range(0, 6.28);
          const rr = rng.range(0.6, 1.3);
          groundProp(d, world, rng.pick(theme.plantProps ?? ['shrub', 'weeds', 'planter']),
            x + Math.cos(a) * rr, z + Math.sin(a) * rr, rng.range(0, 6.28),
            { pack: 0.5, scale: rng.range(0.7, 1.15) });
        }
      }
    } else if (roll < 0.6 && has('concrete')) {
      groundProp(d, world, rng.pick(['block_big', 'block_small', 'cinder']), x, z,
        rng.range(0, 6.28), { pack: 0.75 });
    } else if (roll < 0.72) {
      const bar = groundProp(d, world, rng.pick(theme.drums
        ?? ['barrel_rust', 'barrel_blue', 'gas_bottle', 'bucket', 'jerry_can']),
        x, z, rng.range(0, 6.28), { pack: 0.65 });
      if (bar && theme.skirts !== false) skirt(d, world, x, bar.worldY, z, bar.radius, theme.spillKey);
    } else if (roll < 0.8 && theme.vehicles !== false) {
      // Rationed: a bicycle is a distinctive silhouette, and the Harbor review
      // counted four of them, two in one frame. Two per map, two carts.
      const kit = theme.vehicleProps ?? ['bicycle', 'handcart'];
      const id = kit.length === 1 ? kit[0] : (rng.bool(0.6) ? kit[0] : kit[1]);
      if (d.quota(id, 2)) groundProp(d, world, id, x, z, rng.range(0, 6.28), { pack: 0.6 });
    } else if (roll < 0.9) {
      groundProp(d, world, rng.pick(theme.spoil
        ?? ['plank_a', 'plank_b', 'rebar', 'slab_shard', 'brick_a', 'mattress']),
        x, z, rng.range(0, 6.28), { radius: 0.6, pack: 0.5 });
    } else {
      groundProp(d, world, rng.pick(theme.smallDebris ?? ['litter', 'bottle', 'can', 'cinder']),
        x, z, rng.range(0, 6.28), { radius: 0.3, pack: 0.35 });
    }
  }

  // ---- palms in the squares ----------------------------------------------
  for (let i = 0; i < (theme.palms ?? 0) * 4 && d.props < budget; i++) {
    const x = rng.range(b.x0 + 8, b.x1 - 8);
    const z = rng.range(b.z0 + 8, b.z1 - 8);
    const trunk = groundProp(d, world, 'palm_trunk', x, z, rng.range(0, 6.28),
      { radius: 1.2, height: 5.4, pack: 1.2 });
    if (!trunk) continue;
    for (let k = 0, fronds = rng.int(6, 9); k < fronds; k++) {
      const a = (k / fronds) * Math.PI * 2 + rng.range(-0.2, 0.2);
      // The crown sits at the top of THIS trunk, not at a fixed world height.
      putProp(d, 'palm_frond', x, trunk.worldTop - 0.1, z, a, { rx: rng.range(-0.55, -0.1) });
    }
  }
}

// ------------------------------------------------------------ theme flavour --

/** Rugs and banners hung flat on a facade — Dustyard and Citadel. */
function dressCloth(d, world, masses, theme) {
  if (!theme.cloth) return;
  const rng = d.rng;
  for (const mass of masses) {
    if (mass.y1 < 3 || mass.y0 > 0.2) continue;
    for (const f of exposedFaces(world, mass)) {
      if (!rng.bool(theme.clothChance ?? 0.3)) continue;
      const b = baysOf(mass, f);
      if (b.span < 3.5) continue;
      const u = b.span * rng.range(-0.3, 0.3);
      const wall = b.at(u, 0.02);
      const y = rng.range(2.6, 3.4);
      const w = rng.range(1.8, 3.0);
      const depth = Math.min(0.25, (f.axis === 'x' ? mass.w : mass.d) * 0.35);
      if (occupied(world, wall.x + f.nx * 1.0, 1.6, wall.z + f.nz * 1.0, mass.index)) continue;
      if (!backedByWall(world, wall.x, wall.z, f.nx, f.nz, y - 0.9, y + 0.2,
        { halfWidth: w / 2, depth })) continue;

      const drop = rng.range(0.9, 1.5);
      /**
       * Rug on a rail, built from the RAIL down.
       *
       * The cloth is tipped 0.55 rad about the face tangent so it bellies out,
       * which means its top edge is `sin(0.55) * drop/2` BEHIND its centre and
       * `cos(0.55) * drop/2` above it. The bar used to be placed at + that
       * offset instead of −, so it ended up 0.9 m out in the street while the
       * cloth hung on nothing: the Dustyard review measured "the green tarp
       * hangs a metre below its rail and a metre proud of the wall". Now the bar
       * is fixed at BAR_OUT (its own radius plus a bracket off the render) and
       * the cloth's centre is derived from it.
       */
      const TILT = 0.55;
      const BAR_OUT = 0.1;
      const yTop = y + Math.cos(TILT) * drop * 0.5;
      const centreOut = BAR_OUT + Math.sin(TILT) * drop * 0.5;
      if (!d.wallFree(mass, f, u, w / 2 + 0.14, y - drop * 0.6, yTop + 0.12)) continue;
      d.claimWall(mass, f, u, w / 2 + 0.14, y - drop * 0.6, yTop + 0.12);
      // Same yaw convention as every other wall fitting. It used to be 180 deg
      // out, so with `bow: -1` the cloth bellied INTO the render and showed its
      // dusty back shell to the street.
      const g = clothGeometry(w, drop, { sag: 0.16, wrinkle: 0.045, rng, hem: 1, fray: 0.02, bow: -1 });
      d.add(theme.clothKey, g,
        newTrs(wall.x + f.nx * centreOut, y, wall.z + f.nz * centreOut, f.yaw, 1, 1, 1, -TILT),
        [0.3, 0.5, 0.2]);
      g.dispose();
      const railKey = theme.railKey ?? 'metalDark';
      d.box(railKey, wall.x + f.nx * BAR_OUT, yTop, wall.z + f.nz * BAR_OUT,
        f.axis === 'x' ? 0.05 : w + 0.2, 0.05, f.axis === 'x' ? w + 0.2 : 0.05,
        { thin: true, masks: [0.9, 0.5, 0] });
      // Brackets from the render out to the bar, at both ends of it.
      for (const s of [-1, 1]) {
        const along = s * w * 0.45;
        d.box(railKey,
          wall.x + f.nx * (BAR_OUT / 2) + (f.axis === 'z' ? along : 0),
          yTop - 0.02,
          wall.z + f.nz * (BAR_OUT / 2) + (f.axis === 'x' ? along : 0),
          f.axis === 'x' ? BAR_OUT : 0.04, 0.04, f.axis === 'x' ? 0.04 : BAR_OUT,
          { thin: true, masks: [0.9, 0.5, 0] });
      }
    }
  }
}

/** Crenellations along the top of the tallest walls — Citadel. */
function dressBattlements(d, world, masses, theme) {
  if (!theme.battlements) return;
  const rng = d.rng;
  for (const mass of masses) {
    if (mass.y1 < 5.5) continue;
    for (const f of FACES) {
      const along = f.axis === 'x' ? mass.d : mass.w;
      if (along < 6) continue;
      const half = f.axis === 'x' ? mass.w / 2 : mass.d / 2;
      const merlons = Math.floor(along / 1.6);
      for (let i = 0; i < merlons; i++) {
        if (i % 2 === 1) continue; // gap = embrasure
        const u = ((i + 0.5) / merlons - 0.5) * along;
        const x = mass.x + (f.axis === 'x' ? f.sign * (half - 0.2) : u);
        const z = mass.z + (f.axis === 'z' ? f.sign * (half - 0.2) : u);
        if (!inBounds(world, x, z, -1.5)) continue;
        const h = rng.range(0.75, 0.95);
        d.box('stone', x, mass.y1 + 0.22 + h / 2, z,
          f.axis === 'x' ? 0.42 : 1.15, h, f.axis === 'x' ? 1.15 : 0.42,
          { bevel: 0.02, masks: [0.8, 0.4, 0.15] });
      }
    }
  }
}

/**
 * Iron sconces on the wall piers — Citadel.
 *
 * This is the replacement for `wallServices`, not an addition to it: the same
 * piers, the same bay rhythm, the same `backedByWall` + `wallFree` contract,
 * and a fitting that belongs to the building. A cresset is a back plate, a
 * forged arm and a fire basket; the coals are `neonA`, which is the emissive
 * the map's own practicals already use, so this adds no material and therefore
 * no draw call.
 *
 * Height is 2.3–2.7 m: above a player's head (so nothing reads as a pickup),
 * below the 2.9 m first window row, and clamped inside the wall's own span.
 */
function dressSconces(d, world, masses, theme) {
  if (!theme.sconces) return;
  const rng = d.rng;
  for (const mass of masses) {
    if (mass.y0 > 0.2 || mass.y1 < 3.4) continue;
    for (const f of exposedFaces(world, mass)) {
      const b = baysOf(mass, f);
      if (b.span < 4) continue;
      const depth = Math.min(0.25, (f.axis === 'x' ? mass.w : mass.d) * 0.35);
      const n = Math.min(3, Math.floor(b.span / 5));
      for (let i = 0; i < n; i++) {
        if (!rng.bool(theme.sconces)) continue;
        const pier = Math.min(b.count - 2, Math.round((i / Math.max(1, n - 1)) * (b.count - 2)));
        if (pier < 0) break;
        const u = b.pier(pier);
        const wall = b.at(u, 0);
        const y = Math.min(mass.y1 - 0.5, rng.range(2.3, 2.7));
        if (!clearFor(world, wall.x + f.nx * 0.6, wall.z + f.nz * 0.6, 0.45, 1.6)) continue;
        if (!backedByWall(world, wall.x, wall.z, f.nx, f.nz, y - 0.5, y + 0.35,
          { halfWidth: 0.24, depth })) continue;
        // 0.9 m of soot below it, the same allowance the AC unit's condensate
        // run claimed, so a banner or an awning cannot be drawn across it.
        if (!d.wallFree(mass, f, u, 0.3, y - 0.9, y + 0.4)) continue;
        d.claimWall(mass, f, u, 0.3, y - 0.9, y + 0.4);

        // Built outward from the wall plane, same ladder as every wall fitting:
        // plate flat on the render, arm across the gap, basket at its end.
        const at = (dist, cb) => cb(wall.x + f.nx * dist, wall.z + f.nz * dist);
        at(0.03, (x, z) => {
          d.box('metal', x, y - 0.06, z,
            f.axis === 'x' ? 0.06 : 0.13, 0.44, f.axis === 'x' ? 0.13 : 0.06,
            { thin: true, masks: [0.55, 0.8, 0.35] });
        });
        // The arm rises 22 deg over its 26 cm reach, so the basket clears the
        // plate rather than sitting level with it.
        at(0.16, (x, z) => {
          d.box('metal', x, y + 0.05, z,
            f.axis === 'x' ? 0.3 : 0.04, 0.04, f.axis === 'x' ? 0.04 : 0.3,
            { thin: true, rz: f.axis === 'x' ? -f.sign * 0.38 : 0,
              rx: f.axis === 'z' ? f.sign * 0.38 : 0, masks: [0.85, 0.6, 0.2] });
        });
        at(0.3, (x, z) => {
          // An open-ended cylinder, wide at the top: a fire basket seen from
          // below is a ring, and a closed cone would show only backfaces there.
          const basket = d.geo('cresset', () => new THREE.CylinderGeometry(0.15, 0.09, 0.19, 9, 1, true));
          d.add('metal', basket, newTrs(x, y + 0.16, z), [0.9, 0.55, 0.25]);
          /**
           * The embers stand PROUD of the rim, by 5 cm.
           *
           * Centred in the basket they are invisible from every angle except
           * straight down — the basket's own wall occludes them — and the
           * fitting reads as a dark blob bolted to the wall, which is exactly
           * the read the AC unit it replaced had. The basket rim is at
           * y + 0.16 + 0.19/2 = y + 0.255; a 0.105 sphere squashed to 0.62 in Y
           * is 0.065 tall, so centring it at y + 0.24 puts its crown at
           * y + 0.305 and its base inside the basket where a fire's is.
           */
          d.add('neonA', d.geo('embers', () => new THREE.SphereGeometry(0.105, 7, 5)),
            newTrs(x, y + 0.24, z, rng.float() * 6.28, 1, 0.62, 1), [0, 0, 0]);
          d.props++;
        });
        // and the soot it has left up the render above itself
        const st = runoffStreak(rng, 0.34, rng.range(0.8, 1.5), { amount: 0.9, cols: 3 });
        d.add(mass.wallKey ?? theme.stainKey, st,
          newTrs(wall.x + f.nx * 0.012, y + 1.1, wall.z + f.nz * 0.012, f.yaw), null);
        st.dispose();
      }
    }
  }
}

/**
 * Heraldic banners hung down the wall head — Citadel.
 *
 * A long drop of cloth is the cheapest thing that says "someone holds this
 * place", it reads from the overview cameras as well as from the lane, and it
 * breaks the "4 rows x 11 columns of identical window units" repetition the
 * review measured on the curtain wall without touching the wall itself.
 *
 * It hangs from a crossbar near the wall head and falls free, so its top is
 * derived from the mass's OWN height, never from a world constant.
 */
function dressBanners(d, world, masses, theme) {
  if (!theme.banners) return;
  const rng = d.rng;
  for (const mass of masses) {
    if (mass.y1 < 4.5) continue;
    for (const f of exposedFaces(world, mass)) {
      const b = baysOf(mass, f);
      if (b.span < 5) continue;
      const depth = Math.min(0.25, (f.axis === 'x' ? mass.w : mass.d) * 0.35);
      /**
       * On the PIERS, not on arbitrary offsets.
       *
       * The first version placed banners anywhere along the face and almost
       * none of them survived: the window pass runs first and claims a patch
       * per bay per floor, so a 3 m drop dropped at a random `u` overlapped a
       * claimed reveal nearly every time and `wallFree` refused it. `decor:
       * accentB` came back at 5,444 triangles — no banners in it at all.
       * `b.pier` is the same interval the sconces and the downpipes use, which
       * is by construction the strip the windows do not occupy.
       */
      const n = Math.max(1, Math.min(b.count - 1, Math.floor(b.span / 9)));
      for (let i = 0; i < n; i++) {
        if (!rng.bool(theme.banners)) continue;
        const pier = Math.min(b.count - 2, Math.round(((i + 0.5) / n) * (b.count - 1)) - 1);
        if (pier < 0) continue;
        const u = b.pier(pier);
        const wall = b.at(u, 0);
        // A pier is (bay pitch - window width) wide, which on a 3.2 m bay is
        // about 1.4 m; 0.8 m of cloth leaves the frame mouldings clear.
        const w = rng.range(0.7, 0.95);
        const drop = rng.range(2.2, 3.2);
        // The bar sits a little under the wall head; the cloth hangs below it.
        const yTop = mass.y1 - rng.range(0.55, 1.0);
        const yBot = yTop - drop;
        if (yBot < mass.y0 + 1.6) continue;
        if (!backedByWall(world, wall.x, wall.z, f.nx, f.nz, yBot, yTop,
          { halfWidth: w / 2 + 0.1, depth, samples: 6 })) continue;
        if (!d.wallFree(mass, f, u, w / 2 + 0.14, yBot - 0.1, yTop + 0.14)) continue;
        d.claimWall(mass, f, u, w / 2 + 0.14, yBot - 0.1, yTop + 0.14);

        /**
         * `clothGeometry` is authored flat in XY, centred on its origin, with
         * +Y up — which is already the orientation a banner hangs in, so unlike
         * the awning (tipped to a slope) and the rug (tipped to belly out) this
         * one needs no extra rotation at all, only the face yaw. `bow: -1`
         * bellies it away from the render, which is the direction the wind
         * comes from; without it the cloth curves into the masonry.
         */
        const BAR_OUT = 0.075;
        const g = clothGeometry(w, drop, { sag: 0.05, wrinkle: 0.05, rng, hem: 1, bow: -1, fray: 0.03 });
        d.add(theme.bannerKey ?? theme.clothKey ?? 'sandbag', g,
          newTrs(wall.x + f.nx * (BAR_OUT + 0.03), yTop - drop / 2, wall.z + f.nz * (BAR_OUT + 0.03),
            f.yaw),
          [0.25, 0.45, 0.15]);
        g.dispose();
        // the crossbar it is lashed to, and the two pins holding it off the wall
        const railKey = theme.railKey ?? 'metalDark';
        d.box(railKey, wall.x + f.nx * BAR_OUT, yTop + 0.03, wall.z + f.nz * BAR_OUT,
          f.axis === 'x' ? 0.05 : w + 0.26, 0.05, f.axis === 'x' ? w + 0.26 : 0.05,
          { thin: true, masks: [0.85, 0.55, 0.1] });
        for (const s of [-1, 1]) {
          const along = s * w * 0.5;
          d.box('metal',
            wall.x + f.nx * (BAR_OUT / 2) + (f.axis === 'z' ? along : 0), yTop + 0.03,
            wall.z + f.nz * (BAR_OUT / 2) + (f.axis === 'x' ? along : 0),
            f.axis === 'x' ? BAR_OUT : 0.04, 0.04, f.axis === 'x' ? 0.04 : BAR_OUT,
            { thin: true, masks: [0.9, 0.5, 0] });
        }
        d.props++;
      }
    }
  }
}

/**
 * Standing braziers in the open — Citadel.
 *
 * The map's two authored practicals already get a fire basket on a tripod from
 * `dressPracticals`; this repeats that fitting, unlit, out in the courtyards,
 * so the lighting the player reads has a visible source vocabulary rather than
 * two isolated instances.
 *
 * Placement is the whole risk here — nothing in this file has a collider, so a
 * 1.4 m post in a running line is a post players walk through. `standing()`
 * with a 1.3 m lane argument is the same clearance the practicals' torch asks
 * for, and `openSky` keeps braziers out of the archways and off the stairs
 * under the keeps.
 */
function dressBraziers(d, world, theme) {
  const want = theme.braziers ?? 0;
  if (!want) return;
  const rng = d.rng;
  const b = boundsOf(world);
  let made = 0;
  for (let attempt = 0; attempt < want * 12 && made < want; attempt++) {
    const x = rng.range(b.x0 + 6, b.x1 - 6);
    const z = rng.range(b.z0 + 6, b.z1 - 6);
    // radius 0.42 (the foot), height 1.45 (the basket rim), 1.3 m of lane.
    const floor = standing(world, x, z, 0.42, 1.45, 2.6, 1.3);
    if (floor === null || !d.free(x, z, 1.0) || !openSky(world, x, z, floor + 1.6)) continue;
    d.claim(x, z, 0.95);
    made++;

    const stand = rng.range(0.95, 1.2);
    const post = d.geo('pipe:0.05:7', () => tubeY(0.05, 1, { radial: 7 }));
    d.add('metal', post, newTrs(x, floor, z, 0, 1, stand, 1), [0.7, 0.7, 0.25]);
    // Three splayed feet rather than the practicals' stepped tube: from 2 m
    // away a stepped foot reads as a bollard, and a tripod reads as a tripod.
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2 + rng.range(-0.15, 0.15);
      d.add('metal', post,
        newTrs(x + Math.cos(a) * 0.14, floor + 0.02, z + Math.sin(a) * 0.14, -a, 0.7, 0.42, 0.7,
          0, 0.62),
        [0.85, 0.75, 0.35]);
    }
    const bowl = d.geo('bowl', () => new THREE.CylinderGeometry(0.26, 0.14, 0.22, 10, 1, true));
    d.add('metal', bowl, newTrs(x, floor + stand + 0.09, z), [0.85, 0.5, 0.2]);
    d.add('neonA', d.geo('coals', () => new THREE.SphereGeometry(0.19, 7, 5)),
      newTrs(x, floor + stand + 0.14, z, rng.float() * 6.28, 1, 0.6, 1), [0, 0, 0]);
    // A ring of fuel at the foot: a brazier nobody has to feed is a lamp.
    for (let k = 0, m = rng.int(1, 3); k < m; k++) {
      const a = rng.range(0, 6.28);
      const rr = rng.range(0.75, 1.15);
      groundProp(d, world, rng.pick(['barrel_wood', 'sack', 'crate_b']),
        x + Math.cos(a) * rr, z + Math.sin(a) * rr, rng.range(0, 6.28), { pack: 0.55 });
    }
    d.props++;
  }
}

/**
 * Timber hoarding against a wall — Citadel.
 *
 * A curtain wall under repair: four uprights, two ledgers, a plank deck and the
 * material stacked under it. It is the one piece of dressing that breaks the
 * "reads extruded, not built" verdict on the perimeter, because scaffold is the
 * only thing on a wall that says the wall was assembled.
 *
 * The uprights are seated with `standing()` across their own footprint, and the
 * deck is derived from the measured floor rather than from the mass, so a
 * hoarding on the terrace steps is at the terrace's height, not the courtyard's.
 */
function dressHoardings(d, world, masses, theme) {
  const want = theme.hoardings ?? 0;
  if (!want) return;
  const rng = d.rng;
  let made = 0;
  for (const mass of masses) {
    if (made >= want) break;
    if (mass.y0 > 0.2 || mass.y1 < 4) continue;
    for (const f of exposedFaces(world, mass)) {
      if (made >= want) break;
      const b = baysOf(mass, f);
      if (b.span < 6) continue;
      if (!rng.bool(0.5)) continue;
      const len = rng.range(3.0, 4.4);
      const u = b.span * rng.range(-0.28, 0.28);
      const OUT = 1.05;              // how far the frame stands off the render
      const wall = b.at(u, 0);
      if (!backedByWall(world, wall.x, wall.z, f.nx, f.nz, 0.4, 3.2,
        { halfWidth: len / 2, depth: Math.min(0.25, (f.axis === 'x' ? mass.w : mass.d) * 0.35) })) continue;
      // The whole footprint has to be standing on one level and out of a lane.
      const mid = b.at(u, OUT / 2);
      const floor = standing(world, mid.x, mid.z, Math.max(len, OUT) * 0.5, 2.6, 2.6, 1.1);
      if (floor === null || Math.abs(floor - mass.y0) > 0.02) continue;
      if (!d.free(mid.x, mid.z, len * 0.45)) continue;
      if (!d.wallFree(mass, f, u, len / 2 + 0.1, 0, 3.3)) continue;
      d.claim(mid.x, mid.z, len * 0.42);
      d.claimWall(mass, f, u, len / 2 + 0.1, 0, 3.3);
      made++;

      const dx = f.axis === 'x' ? 1 : 0;
      const dz = f.axis === 'z' ? 1 : 0;
      const deck = floor + rng.range(2.15, 2.5);
      // ---- uprights: two against the render, two at the front of the frame
      for (const s of [-1, 1]) {
        for (const off of [0.16, OUT]) {
          const p = b.at(u + s * (len / 2 - 0.2), off);
          d.box('crateDark', p.x, floor + (deck - floor) / 2 + 0.06, p.z,
            0.11, deck - floor + 0.12, 0.11, { bevel: 0.008, masks: [0.8, 0.6, 0.3] });
        }
      }
      // ---- ledgers: one under the deck, one as a mid-rail
      for (const yy of [deck - 0.07, floor + (deck - floor) * 0.5]) {
        for (const off of [0.16, OUT]) {
          const p = b.at(u, off);
          d.box('crateDark', p.x, yy, p.z,
            dx ? 0.09 : len - 0.1, 0.09, dz ? 0.09 : len - 0.1,
            { thin: true, masks: [0.85, 0.55, 0.25] });
        }
      }
      // ---- the deck: five boards laid across the ledgers, one of them missing
      const gap = rng.int(0, 4);
      for (let i = 0; i < 5; i++) {
        if (i === gap) continue;
        const off = 0.13 + ((i + 0.5) / 5) * (OUT - 0.02);
        const p = b.at(u + rng.range(-0.04, 0.04), off);
        d.box('crate', p.x, deck, p.z,
          dx ? (OUT - 0.02) / 5 - 0.02 : len - 0.16, 0.045, dz ? (OUT - 0.02) / 5 - 0.02 : len - 0.16,
          { thin: true, ry: rng.range(-0.01, 0.01), masks: [0.9, 0.5, 0.2] });
      }
      // ---- a diagonal brace across the bay, on the front frame
      const p2 = b.at(u, OUT);
      const rise = deck - floor;
      const ang = Math.atan2(rise, len - 0.4);
      d.box('crateDark', p2.x, floor + rise / 2, p2.z,
        dx ? 0.08 : Math.hypot(len - 0.4, rise), 0.08, dz ? 0.08 : Math.hypot(len - 0.4, rise),
        { thin: true, rz: dz ? ang : 0, rx: dx ? -ang : 0, masks: [0.9, 0.5, 0.2] });
      // ---- the material it is there for, stacked underneath
      for (let i = 0, n = rng.int(2, 4); i < n; i++) {
        const p = b.at(u + rng.range(-1, 1) * (len / 2 - 0.4), rng.range(0.35, OUT - 0.1));
        groundProp(d, world, rng.pick(['barrel_wood', 'sack', 'crate_b', 'block_small', 'plank_a']),
          p.x, p.z, rng.range(0, 6.28), { pack: 0.5 });
      }
      d.props++;
    }
  }
}

/** A layer of settled snow on every up-facing surface — Frostline. */
function dressSnowCaps(d, world, masses, theme) {
  if (!theme.snowCaps) return;
  const rng = d.rng;
  const meshes = world.solids.children;
  for (let i = 0; i < meshes.length; i++) {
    const mesh = meshes[i];
    if (!mesh.isMesh || mesh.geometry !== world._unitBox) continue;
    const s = mesh.scale;
    const p = mesh.position;
    const top = p.y + s.y / 2;
    if (top < 0.35 || top > 12) continue;
    if (s.x < 0.5 || s.z < 0.5) continue;
    // Anything with another box sitting on it stays bare — tested across the
    // whole footprint, because one centre probe misses a crate on the corner.
    let blocked = false;
    for (const [ox, oz] of CROSS) {
      if (occupied(world, p.x + ox * s.x * 0.4, top + 0.35, p.z + oz * s.z * 0.4, i)) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;
    const thick = rng.range(0.05, 0.12);
    d.box('snow', p.x, top + thick / 2, p.z, s.x * 0.99, thick, s.z * 0.99, {
      bevel: 0.02, masks: [0.1, 0, 0],
    });
  }
}

/** Neon strip signage and pipe runs — Neon Foundry. */
function dressNeon(d, world, masses, theme) {
  if (!theme.neon) return;
  const rng = d.rng;
  for (const mass of masses) {
    if (mass.y1 < 4) continue;
    for (const f of exposedFaces(world, mass)) {
      const b = baysOf(mass, f);
      if (b.span < 4) continue;
      const depth = Math.min(0.25, (f.axis === 'x' ? mass.w : mass.d) * 0.35);
      if (rng.bool(0.42)) {
        const u = b.span * rng.range(-0.28, 0.28);
        const y = rng.range(3.2, Math.max(3.4, mass.y1 - 0.8));
        const key = rng.bool() ? 'neonA' : 'neonB';
        const wall = b.at(u, 0);
        if (rng.bool(0.5)) {
          // horizontal strip, its housing seated ON the wall
          const len = rng.range(1.6, 3.4);
          if (!backedByWall(world, wall.x, wall.z, f.nx, f.nz, y - 0.3, y + 0.3,
            { halfWidth: len / 2, depth })) continue;
          if (!d.wallFree(mass, f, u, len / 2, y - 0.25, y + 0.25)) continue;
          d.claimWall(mass, f, u, len / 2, y - 0.25, y + 0.25);
          const p = b.at(u, 0.06);
          d.box('metalDark', p.x, y, p.z,
            f.axis === 'x' ? 0.12 : len, 0.34, f.axis === 'x' ? len : 0.12, { bevel: 0.01 });
          const q = b.at(u, 0.14);
          d.box(key, q.x, y, q.z,
            f.axis === 'x' ? 0.05 : len * 0.92, 0.12, f.axis === 'x' ? len * 0.92 : 0.05,
            { thin: true, masks: [0, 0, 0] });
        } else {
          // vertical blade sign, cantilevered off the wall on its own box
          const h = rng.range(1.8, 3.0);
          if (!backedByWall(world, wall.x, wall.z, f.nx, f.nz, y - h / 2, y + h / 2,
            { halfWidth: 0.3, depth })) continue;
          if (!d.wallFree(mass, f, u, 0.34, y - h / 2, y + h / 2)) continue;
          d.claimWall(mass, f, u, 0.34, y - h / 2, y + h / 2);
          const p = b.at(u, f.axis === 'x' ? 0.3 : 0.25);
          d.box('metalDark', p.x, y, p.z,
            f.axis === 'x' ? 0.6 : 0.5, h, f.axis === 'x' ? 0.5 : 0.6, { bevel: 0.012 });
          const q = b.at(u, f.axis === 'x' ? 0.61 : 0.51);
          for (let i = 0; i < 3; i++) {
            const yy = y - h / 2 + ((i + 0.5) / 3) * h;
            d.box(i === 1 ? key : (key === 'neonA' ? 'neonB' : 'neonA'), q.x, yy, q.z,
              f.axis === 'x' ? 0.06 : 0.34, h / 6, f.axis === 'x' ? 0.34 : 0.06,
              { thin: true, masks: [0, 0, 0] });
          }
        }
      }

      // Plant pipework along the wall, on brackets.
      if (mass.y0 < 0.2 && mass.h >= 3 && b.span >= 6 && rng.bool(0.4)) {
        // Clamped to the wall it is bolted to: the run used to be centred on
        // the face and scaled by up to 0.85 of the span with a one-sided tube,
        // so 10 m of pipe ended up in the street with a flange in mid-air.
        const len = Math.min(b.span - 1.2, b.span * rng.range(0.5, 0.8));
        const y = rng.range(0.6, 2.2);
        const wall = b.at(0, 0);
        if (!backedByWall(world, wall.x, wall.z, f.nx, f.nz, y - 0.2, y + 0.2,
          { halfWidth: len / 2, depth })) continue;
        if (!d.wallFree(mass, f, 0, len / 2, y - 0.25, y + 0.25)) continue;
        d.claimWall(mass, f, 0, len / 2, y - 0.25, y + 0.25);
        const p = b.at(-len / 2, 0.28);
        const g = d.geo('pipe:0.09:10', () => tubeY(0.09, 1, { radial: 10 }));
        d.add('metalGrid', g,
          newTrs(p.x, y, p.z, 0, 1, len, 1,
            f.axis === 'x' ? Math.PI / 2 : 0, f.axis === 'x' ? 0 : -Math.PI / 2),
          [0.45, 0.7, 0.3]);
        for (let t = 0; t <= 1; t += 0.5) {
          const q = b.at(-len / 2 + t * len, 0.28);
          d.box('metalDark', q.x, y, q.z, 0.22, 0.22, 0.22, { bevel: 0.01 });
          const r = b.at(-len / 2 + t * len, 0.14);
          d.box('metalDark', r.x, y, r.z,
            f.axis === 'x' ? 0.28 : 0.05, 0.05, f.axis === 'x' ? 0.05 : 0.28, { thin: true });
        }
      }
    }
  }
}

// ------------------------------------------------------------------- themes --

const THEME_DRESSING = {
  desert: {
    trimKey: 'trim', frameKey: 'crateDark', revealKey: 'wallBs', tankKey: 'metal',
    stainKey: 'wallN', signKey: 'accentB',
    drift: true, driftKey: 'ground', driftChance: 0.6, rubbleKey: 'stoneDark',
    spillKey: 'ground', debris: 46, cableCount: 14,
    cloth: true, clothKey: 'sandbag', clothChance: 0.4, boardedWindows: 0.3,
    // A market quarter: awnings and stalls on every open frontage, washing
    // between the upper floors, and palms in the squares.
    propBudget: 900, shopfronts: 0.6, doorways: 0.85, balconies: 0.65,
    streetProps: 70, palms: 5, marketRows: 6,
  },
  coastal: {
    trimKey: 'trim', frameKey: 'metalDoor', revealKey: 'wallBs', tankKey: 'metalGrid',
    stainKey: 'wallN', signKey: 'accentB',
    drift: false, rubbleKey: 'stoneDark', spillKey: 'metalDark', debris: 40,
    cableCount: 12, puddles: true, boardedWindows: 0.4,
    /**
     * A working port: pallets, drums and barriers, no market and no greenery.
     *
     * `shopfronts: 0.18` put a fascia sign, a fabric awning, a trestle table and
     * stacked goods on 18% of the bays of a container terminal — including one
     * inside the roofed customs hall — which the Harbor review called "a
     * container port dressed with souk market stalls, in mustard". A port has
     * roller shutters and loading doors, which is what `doorways` draws.
     */
    propBudget: 780, shopfronts: 0, doorways: 0.7, balconies: 0.28,
    streetProps: 82, laundry: false, vegetation: false, clothKey: 'sandbag',
    // Dockside concrete is swept and wet, not dusty: the dust skirt read as
    // "hard-edged tan hexagonal pads lying at y~0.02 under the tyre stacks".
    skirts: false,
    // Quayside furniture. The default list hands out chairs, mattresses and
    // planters, none of which belong on a container apron.
    leanProps: [
      'crate_a', 'crate_b', 'crate_c', 'barrel_rust', 'barrel_blue', 'pallet',
      'tyre', 'tyre_small', 'gas_bottle', 'jerry_can', 'cabinet', 'block_small',
      'cinder', 'sack', 'bucket', 'rebar',
    ],
    // Industrial roofs: plant and spares, no roof terrace.
    roofPlant: true,
    roofProps: ['barrel_rust', 'gas_bottle', 'bucket', 'pallet', 'crate_b', 'cabinet'],
  },
  arctic: {
    trimKey: 'trim', frameKey: 'metalDoor', revealKey: 'wallBs', tankKey: 'metalGrid',
    stainKey: 'wallB', signKey: 'accentB',
    drift: true, driftKey: 'snow', driftChance: 0.8, rubbleKey: 'stoneDark',
    spillKey: 'snow', debris: 30, cableCount: 10,
    snowCaps: true, boardedWindows: 0.35,
    // A station, not a town: crates, drums and service gear, nothing growing,
    // and no dust skirts — the ground cover is snow, and the drifts do that job.
    // No shopfronts either: 0.1 was still enough to put a market awning and a
    // trestle of produce on an Antarctic research station.
    propBudget: 620, shopfronts: 0, doorways: 0.6, balconies: 0.15,
    streetProps: 56, laundry: false, vegetation: false, vehicles: false,
    skirts: false, clothKey: 'sandbag',
    leanProps: [
      'crate_a', 'crate_b', 'crate_c', 'barrel_rust', 'barrel_blue', 'pallet',
      'gas_bottle', 'jerry_can', 'cabinet', 'block_small', 'cinder', 'sack', 'tyre',
    ],
    roofPlant: true,
    roofProps: ['barrel_rust', 'gas_bottle', 'bucket', 'pallet', 'crate_b', 'cabinet'],
  },
  neon: {
    trimKey: 'trim', frameKey: 'metalDoor', revealKey: 'wallB', tankKey: 'metalGrid',
    stainKey: 'wallN', signKey: 'accentA',
    drift: false, rubbleKey: 'stoneDark', spillKey: 'metalDark', debris: 42,
    cableCount: 16, puddles: true, neon: true, boardedWindows: 0.45,
    propBudget: 820, shopfronts: 0.34, doorways: 0.7, balconies: 0.4,
    streetProps: 82, marketRows: 3, laundry: true, vegetation: false,
    clothKey: 'sandbag', skirts: false,
    roofPlant: true,
    roofProps: ['barrel_rust', 'gas_bottle', 'bucket', 'pallet', 'crate_b', 'cabinet'],
  },
  /**
   * A fortress, not a town — the one theme where the generic kit was actively
   * wrong.
   *
   * The Citadel review's headline finding was that "a medieval citadel is
   * wearing a modern industrial town's dressing kit": steel roller shutters,
   * wall-mounted air conditioners and a satellite dish, modern street lamp
   * posts, palm trees, plastic bins, and tyre stacks whose `decor:rubber` mesh
   * was, at 69,440 triangles, the largest single mesh in the map. None of that
   * was a bug in the passes — they were doing exactly what they do on Dustyard,
   * which is right for Dustyard. What was missing is that the passes never
   * ASKED what the map is. Everything below is that question, answered once.
   *
   * What replaces it: banners, braziers, iron sconces, timber hoardings,
   * barrels, sacks and cloth market stalls — and the cloth is the map's own
   * `accentB`, so the one saturated hue in a warm palette now reads as livery
   * rather than as the teal awnings the review counted.
   */
  citadel: {
    trimKey: 'trim', frameKey: 'crateDark', revealKey: 'stoneDark', tankKey: 'metal',
    stainKey: 'wallN', signKey: 'accentB', copingKey: 'stoneLight',
    // Timber, not tube: every rail, bar and awning member on this map.
    railKey: 'crateDark',
    drift: true, driftKey: 'ground', driftChance: 0.4, rubbleKey: 'stoneDark',
    spillKey: 'ground', debris: 44, cableCount: 0,
    cloth: true, clothKey: 'sandbag', clothChance: 0.32, bannerKey: 'accentB',
    battlements: true, boardedWindows: 0.2,
    // Wrought iron: the sconces, the braziers and the two authored practicals'
    // fixtures all share it, so the map has one metal vocabulary and not three.
    fixtureKey: 'metal',
    propBudget: 860, shopfronts: 0.5, doorways: 0.8, balconies: 0.45,
    streetProps: 66, palms: 0, marketRows: 5,

    // ---- what a fort does not have -----------------------------------------
    wallServices: false,   // no air conditioners, no satellite dishes, no conduit
    roofServices: false,   // no water tanks, ducting, extractors, vents or aerials
    lampPosts: false,      // no cast-iron street lighting
    shutters: false,       // shopboards in timber, not rolling steel
    signProps: false,      // a painted fascia board, not a lettered shop sign
    vehicles: false,       // and therefore no bicycle
    scatter: { tyres: false, barriers: false, pallets: false, concrete: false },

    // ---- and what it does ---------------------------------------------------
    sconces: 0.75,         // per eligible pier: iron cressets where the AC units were
    banners: 0.7,          // per eligible wall head
    braziers: 7,
    hoardings: 3,
    leanProps: [
      'crate_a', 'crate_b', 'crate_c', 'barrel_wood', 'sack', 'shrub', 'weeds',
      'stool', 'chair', 'shelf', 'tray', 'block_small', 'plank_a', 'plank_b', 'table_small',
    ],
    doorJunk: ['bucket', 'crate_b', 'stool', 'sack', 'tray', 'barrel_wood', 'shelf'],
    balconyProps: ['bucket', 'crate_b', 'stool', 'sack', 'tray', 'shelf'],
    stackProps: ['crate_b', 'sack', 'tray', 'box_card_b'],
    rowEndProps: ['barrel_wood', 'chair', 'stool', 'shelf', 'handcart'],
    roofProps: ['barrel_wood', 'crate_b', 'sack', 'crate_flat', 'stool', 'tray'],
    roofGrit: ['brick_a', 'slab_shard', 'plank_b', 'sack'],
    drums: ['barrel_wood', 'sack', 'bucket'],
    spoil: ['plank_a', 'plank_b', 'slab_shard', 'brick_a', 'sack'],
    smallDebris: ['brick_a', 'slab_shard', 'plank_b'],
    kerbDebris: ['brick_a', 'slab_shard', 'plank_b', 'weeds'],
    rubbleDebris: ['plank_a', 'plank_b', 'brick_a', 'slab_shard', 'weeds'],
    plantProps: ['shrub', 'weeds'],
    vehicleProps: ['handcart'],
  },
};

/**
 * Dress the loaded map. Call after the collision geometry exists.
 * @param {import('./map.js').default} world
 */
export function dressMap(world, opts = {}) {
  const base = THEME_DRESSING[world.theme.key] ?? THEME_DRESSING.desert;
  /**
   * Phones get the same architecture — copings, windows, pilasters, doorways,
   * roof plant, all of which are the actual read — and less of the scatter,
   * which is where the triangles are and which nobody notices missing at 1.25x
   * pixel ratio.
   */
  const theme = opts.quality === 'low'
    ? {
        ...base,
        debris: Math.round((base.debris ?? 24) * 0.4),
        cableCount: Math.min(4, base.cableCount ?? 0),
        driftChance: (base.driftChance ?? 0.5) * 0.5,
        propBudget: Math.round((base.propBudget ?? 240) * 0.45),
        streetProps: Math.round((base.streetProps ?? 34) * 0.5),
        marketRows: base.marketRows ? 1 : 0,
        palms: base.palms ? 1 : 0,
        skirts: false,
      }
    : base;

  // One stream per pass, forked off the map id. Editing the roof pass then
  // cannot re-roll every crate in the street, which is what made tuning this
  // file a game of whack-a-mole.
  const seed = new Rng(`tiny-strike:${world.mapId}`);
  const d = new Dresser(world, seed, theme);
  const masses = massesOf(world);
  const pass = (name, fn) => {
    d.rng = new Rng(`tiny-strike:${world.mapId}:${name}`);
    fn();
  };

  /**
   * Keep the bomb sites and the spawns clear.
   *
   * None of this has a collider, so a market stall standing on the A site
   * cannot block a plant — but a player running in to defuse has to read the
   * site instantly, and a crate they walk straight through is worse than no
   * crate at all. Claiming the ground first means every later pass routes
   * around it using the machinery it already uses for prop-on-prop overlap.
   */
  for (const site of world.bombSites ?? []) {
    const r = Math.min(site.box.max.x - site.box.min.x, site.box.max.z - site.box.min.z) * 0.5;
    d.claim(site.center.x, site.center.z, r + 0.6);
  }
  for (const team of ['ct', 't']) {
    for (const s of world.spawns?.[team] ?? []) d.claim(s.pos.x, s.pos.z, 1.4);
  }

  // The map's own practicals get their fixture first, so the fixture's footprint
  // is claimed before any scatter can land on it.
  pass('practicals', () => dressPracticals(d, world, theme));

  pass('shell', () => {
    for (const mass of masses) {
      const faces = exposedFaces(world, mass);
      if (!faces.length) continue;
      dressMassShell(d, world, mass, faces, theme);
    }
  });
  /**
   * Ground-floor furniture claims its wall BEFORE the windows are set out.
   *
   * A shopfront occupies its bay from the pavement to 3.7 m and the first window
   * row starts at 2.9 m, so whichever pass runs second has to give way — and it
   * has to be the windows, because a shopfront cannot move up. This ordering
   * plus `wallFree` is what stops a fascia sign being drawn across a reveal.
   */
  pass('facade', () => dressFacades(d, world, masses, theme));
  pass('windows', () => {
    for (const mass of masses) {
      const faces = exposedFaces(world, mass);
      if (!faces.length) continue;
      dressWindows(d, world, mass, faces, theme);
      dressWallFurniture(d, world, mass, faces, theme);
    }
  });
  pass('pilasters', () => {
    for (const mass of masses) {
      const faces = exposedFaces(world, mass);
      if (faces.length) dressPilasters(d, world, mass, faces, theme);
    }
  });
  pass('roof', () => {
    for (const mass of masses) dressRoof(d, world, mass, theme);
  });
  // Props come before the ground pass so the drifts and rubble know where the
  // props are and do not pile up through them.
  pass('mapprops', () => dressMapProps(d, world, theme));
  pass('slabs', () => {
    dressDecorSlabs(d, world, masses, theme);
    dressStilts(d, world, theme);
  });
  pass('street', () => dressOpenGround(d, world, theme));
  pass('ground', () => dressGround(d, world, masses, theme));
  pass('cables', () => dressCables(d, world, masses, theme));
  pass('cloth', () => dressCloth(d, world, masses, theme));
  pass('battlements', () => dressBattlements(d, world, masses, theme));
  // The period kit. Each of these is the replacement for something the generic
  // passes were gated out of above, so they run after the wall claims exist.
  pass('sconces', () => dressSconces(d, world, masses, theme));
  pass('banners', () => dressBanners(d, world, masses, theme));
  pass('hoardings', () => dressHoardings(d, world, masses, theme));
  pass('braziers', () => dressBraziers(d, world, theme));
  pass('snow', () => dressSnowCaps(d, world, masses, theme));
  pass('neon', () => dressNeon(d, world, masses, theme));

  d.finish();
  return { tris: d.tris, props: d.props };
}
