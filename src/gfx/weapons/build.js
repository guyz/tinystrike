// ============================================================================
// TINY STRIKE — procedural weapon assembly.
//
// The model builders (models/*.js) return material-bucketed geometry plus a
// table of named nodes. This turns one of those into a THREE.Object3D that
// Tiny Strike's own rigs can use, in Tiny Strike's own conventions:
//
//   origin      the shooting hand's grip anchor (web of the thumb)
//   -Z          down the bore, toward the muzzle
//   +Y          up
//   metres      real scale, so a rifle is 0.75 m long
//
// Those are exactly the conventions the GLB viewmodels were authored to, which
// is what lets these drop into the existing viewmodel rig and the soldiers'
// hand bones without re-posing anything.
//
// The returned group carries `userData.nodes` — muzzle, ejection port, sight
// line, magazine seat, bolt/slide travel — so animation code can drive the
// moving parts without knowing how the gun was built.
// ============================================================================
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { triCount } from './geometry.js';

/**
 * Reshape the vertex wear/grime/AO masks.
 *
 * Chamfered hard-surface geometry has no interior vertices on a face, so a
 * per-vertex edge mask ramps linearly from the chamfer all the way across the
 * panel: without this, a rail tooth or a mount top face comes out uniformly
 * worn — flat near-white bars instead of a bright line on the edge itself.
 * Raising the exponent is what pulls the ramp back onto the outer millimetre.
 */
export function shapeMasks(geo, o) {
  const col = geo.getAttribute('color');
  if (!col) return geo;
  const a = col.array;
  const amp = [o.wearAmp ?? 1, o.grimeAmp ?? 1, o.aoAmp ?? 1];
  const exp = [o.wearExp ?? 1, o.grimeExp ?? 1, o.aoExp ?? 1];
  for (let i = 0; i < a.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = a[i + k];
      a[i + k] = v <= 0 ? 0 : amp[k] * Math.pow(v > 1 ? 1 : v, exp[k]);
    }
  }
  col.needsUpdate = true;
  return geo;
}

function applyNode(object, node) {
  if (!node) return object;
  object.position.fromArray(node.pos);
  if (node.rot) object.rotation.fromArray(node.rot);
  return object;
}

/**
 * @param {object} model    a model definition from models/*.js
 * @param {import('./materials.js').WeaponMaterials} mats
 * @param {object} opts     { rng, viewmodel } — viewmodel parts skip shadow
 *                          casting and never frustum cull
 * @returns {THREE.Group}   group with userData.nodes / .parts / .tris
 */
export function buildWeaponObject(model, mats, opts = {}) {
  const group = new THREE.Group();
  group.name = `weapon:${model.id}`;

  const viewmodel = opts.viewmodel !== false;
  const rng = opts.rng ?? null;
  const bake = mats.lib?.bakeMasks?.bind(mats.lib) ?? null;
  const meshes = [];
  let tris = 0;

  const build = (asm, parent, wearScale = 1) => {
    const map = asm.build();
    for (const [matKey, geo] of map) {
      if (bake) {
        // Curvature masks: convex chamfers wear to bright metal, creases fill
        // with grime. This is what stops the gun reading as clean plastic.
        const soft = matKey === 'polymer' || matKey === 'rubber' || matKey === 'polymer_tan';
        bake(geo, { wear: 1, grime: 1, ao: 1, edgeThreshold: 0.16, rng });
        shapeMasks(geo, {
          wearAmp: (soft ? 0.42 : 0.62) * wearScale,
          wearExp: soft ? 3.4 : 2.8,
          grimeAmp: 1.15,
          grimeExp: 1.25,
          aoAmp: 1.0,
          aoExp: 1.15,
        });
      }
      const mesh = new THREE.Mesh(geo, mats.get(matKey));
      mesh.name = `${asm.name}-${matKey}`;
      // Which material bucket this mesh came out of, as plain data, so the
      // third-person collapse below can regroup without re-deriving it from the
      // mesh name (names are set by the model builders and are not a contract).
      mesh.userData.matKey = matKey;
      if (viewmodel) {
        // The viewmodel is drawn inside the player's own head: it must never
        // cast into the shadow map (it would shadow the world from the eye
        // position) but it absolutely must RECEIVE the sun, or the gun is lit
        // at full daylight while the street around it is in shade.
        mesh.castShadow = false;
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;
      } else {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
      parent.add(mesh);
      meshes.push(mesh);
      tris += triCount(geo);
    }
  };

  build(model.body, group);

  const parts = {};
  for (const [name, asm] of Object.entries(model.moving ?? {})) {
    const sub = new THREE.Object3D();
    sub.name = `${model.id}-${name}`;
    group.add(sub);
    // A magazine is handled far more than the receiver, but it is also swapped
    // out — it wears differently, so it gets its own scale.
    build(asm, sub, name === 'magazine' ? 0.8 : 1);
    parts[name] = sub;
  }

  const n = model.nodes;
  if (parts.magazine && n.magSeat) applyNode(parts.magazine, n.magSeat);
  if (parts.charging && n.chargeRest) applyNode(parts.charging, n.chargeRest);
  if (parts.bolt && n.boltRest) applyNode(parts.bolt, n.boltRest);
  if (parts.slide && n.slideRest) applyNode(parts.slide, n.slideRest);
  if (parts.trigger && n.triggerPivot) applyNode(parts.trigger, n.triggerPivot);
  if (parts.selector && n.selectorPivot) applyNode(parts.selector, n.selectorPivot);

  /**
   * userData carries PLAIN DATA ONLY — no Object3D references.
   *
   * `Object3D.copy()` round-trips userData through JSON, and one weapon
   * template is cloned for the viewmodel and for every soldier carrying that
   * gun, so an Object3D in here (a `parts` map, say) either throws on the
   * circular `parent` reference or silently produces junk. Moving parts are
   * looked up by name after cloning instead — see `resolveParts`.
   */
  group.userData.weaponId = model.id;
  group.userData.tris = tris;
  group.userData.muzzle = [...n.muzzle];
  group.userData.eject = [...(n.eject ?? n.muzzle)];
  group.userData.sight = [...(n.sight ?? [0, 0.1, 0])];
  group.userData.partNames = Object.fromEntries(
    Object.keys(parts).map((name) => [name, `${model.id}-${name}`])
  );
  return group;
}

/* ========================================================================== */
/*  third-person collapse                                                     */
/* ========================================================================== */

/**
 * THIRD-PERSON MATERIAL CLASSES
 *
 * A soldier's gun is a first-person asset seen from across a lane, and the
 * numbers say so. Silhouette area of each weapon at 8 m, rendered through the
 * game's own 74-degree camera at the shipped 2800x1680 device resolution, id
 * colour per mesh, read back off the GPU so occlusion between buckets is
 * resolved by the depth buffer rather than estimated:
 *
 *   awp 1387 px · ak47 972 · m4a1 810 · mp5 742 · deagle 341 · usp 277 · glock 219
 *
 * and against that, the full-detail build spends 15-21 meshes and 8-15 distinct
 * PBR materials per gun. Nine bots on Dustyard measured 139 weapon meshes and
 * 222.9k triangles — 139 main-pass draws plus the same again in the shadow
 * cascade, for objects averaging 700 pixels.
 *
 * So the third-person copy groups buckets by what survives at that size. Each
 * entry is the class a material key collapses INTO; `null` drops the bucket, and
 * a key mapped to itself is one that keeps its own draw call. Every choice below
 * is followed by the measured pixel count it is worth.
 *
 * EVERY key is listed, including the ones that stay as they are, so that a new
 * material added by the model builders is detectably absent rather than silently
 * costing a draw call on every bot carrying that gun. An absent key still works
 * — it becomes its own class, which is the safe direction to fail in — and both
 * a console warning and `weapon-thirdperson-merge.test.mjs` will say so.
 */
export const TP_MATERIAL_CLASS = {
  // --- dropped: the first-person sight picture ---------------------------
  // `glass` is the frame's most expensive shader — MeshPhysicalMaterial with a
  // 5-layer iridescence stack, sheen and ior — and `lens_ring`/`lens_vig` are
  // transparent, depth-write-off overlays that have to be sorted every frame.
  // All three exist to make the objective read as coated glass to an eye ON the
  // optical axis. Measured from outside at 8 m they are 22 px of the M4's 810
  // and 25 px of the AWP's 1387, i.e. 2.7% and 1.8%. Three transparent draws
  // per scoped bot for that is the worst trade on the gun. The `optic_tube`
  // liner stays, so the objective still reads as a dark bore, which is what a
  // scope looks like from the side anyway.
  glass: null,
  lens_ring: null,
  lens_vig: null,

  // --- collapsed ---------------------------------------------------------
  // Both are matte black double-sided interiors with the Fresnel taken out;
  // optic_tube is only 0.02 linear lighter than cavity. Measured 6 px (m4a1)
  // and 19 px (awp) of tube interior visible from outside.
  optic_tube: 'cavity',

  // The cartridge in the magwell and the round on the feed lips. copper is the
  // bullet jacket, brass the case; they share the `metal_brushed` surface and
  // differ only in tint (0xFFFFFF vs 0xFFFFDF) and grain scale. copper never
  // measures above 8 px on any of the seven, so it becomes brass.
  copper: 'brass',

  // Hard-anodised aluminium, coarse and fine grain. Same surface, same
  // roughness class; alu_fine is a 0.038 m grain for rails and mounts against
  // alu's 0.095 m. At 8 m one grain period is a third of a pixel.
  alu_fine: 'alu',

  // Three phosphate/blued steel variants off one `metal_brushed` surface with
  // near-identical tints (steel 0x736A6D, steel_black 0x6E6F71,
  // steel_bright 0x6E6E71); only the roughness spread differs. steel_black is
  // the dominant one by area on five of the seven, so it is the class that
  // keeps its own material and the other two fold in.
  steel: 'steel_black',
  steel_bright: 'steel_black',

  // --- kept: each carries a read no neighbouring class can stand in for -----
  steel_soot: 'steel_soot', // the carbon at the muzzle, 2.8x darker than steel — 37-90 px
  cavity: 'cavity', //         bores, ports and the magwell reading as holes — 19-106 px
  wood: 'wood', //             the AK's furniture — 271 px, the only warm tone on it
  polymer: 'polymer', //       88-333 px, the largest bucket on four of the seven
  polymer_tan: 'polymer_tan', // the desert furniture variant, 1.6x brighter than polymer
  rubber: 'rubber', //         the grip stipple, 0.86 roughness against polymer's 0.63
  brass: 'brass', //           the visible round; 70 px through the MP5's ejection port
  alu: 'alu', //               202 px (m4a1) / 468 px (awp)
  steel_black: 'steel_black', // 42-387 px, the dominant surface on five of the seven
};

const TP_MERGE_ATTRS = ['position', 'normal', 'uv', 'color'];
const _tpMatrix = new THREE.Matrix4();
const _warnedKeys = new Set();

/**
 * Put a set of geometries on one attribute layout so `mergeGeometries` accepts
 * them: identical attribute names, and an index on all of them or none.
 *
 * The `color` attribute is the whole reason this is not `geometry.mergeAll` —
 * that one runs everything through `normalizeAttributes`, which keeps only
 * position/normal/uv and would throw away every wear, grime and AO mask the
 * bake put on the vertices.
 *
 * KEEPING THE INDEX is what makes the collapse cheap. `mergeAll` goes through
 * `toNonIndexed()` and then welds the result back down with `mergeVertices`,
 * which is what a bucket merge inside one part needs — its pieces really do
 * share vertices. Across parts almost nothing is shared, so the weld is nearly
 * all cost: measured on the M4A1, non-indexed + weld took 248 ms and landed on
 * 54889 vertices; offsetting the indices takes 13 ms and lands on 54903. Fourteen
 * vertices, 0.03%, for 19x the time — and it is 13 ms rather than 248 that keeps
 * a bot spawning with an unseen weapon from dropping a frame.
 */
function tpAlign(list) {
  const want = new Set();
  for (const g of list) {
    for (const name of Object.keys(g.attributes)) {
      if (TP_MERGE_ATTRS.includes(name)) want.add(name);
    }
  }
  for (const g of list) {
    for (const name of Object.keys(g.attributes)) {
      if (!want.has(name)) g.deleteAttribute(name);
    }
    const n = g.getAttribute('position').count;
    if (want.has('normal') && !g.getAttribute('normal')) g.computeVertexNormals();
    if (want.has('uv') && !g.getAttribute('uv')) {
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    }
    // masks.js: all three channels default to 0 and 0 means "no effect", so a
    // bucket that never went through the bake is safe to pad with zeros.
    if (want.has('color') && !g.getAttribute('color')) {
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    }
    // An identity index costs one Uint32Array and makes a non-indexed bucket
    // mergeable with the indexed ones — `mergeGeometries` refuses a mixed list.
    // `mergeVertices` would do it too, but it would also weld, and the point of
    // this path is to not pay for a weld.
    if (!g.getIndex()) {
      const seq = new Uint32Array(n);
      for (let i = 0; i < n; i++) seq[i] = i;
      g.setIndex(new THREE.BufferAttribute(seq, 1));
    }
    g.morphAttributes = {};
    g.clearGroups();
  }
  return list;
}

/** Merge a class bucket into one geometry. */
function tpMerge(list) {
  // A class with one bucket in it is already one draw call: aligning it would
  // only bolt an identity index onto a non-indexed geometry, 4 bytes a vertex
  // for no dedup.
  if (list.length === 1) return list[0];
  const flat = tpAlign(list);
  const merged = mergeGeometries(flat, false);
  for (const g of flat) g.dispose();
  return merged;
}

/**
 * The third-person copy of an already-built weapon: one mesh per third-person
 * material class, with every part's rest transform baked in.
 *
 * WHY THIS IS BUILT FROM THE FINISHED OBJECT and not from the model definition:
 * re-running the builders costs 37-145 ms per gun (chamfered primitives, a merge
 * and a weld per bucket, then the curvature bake), and the viewmodel has already
 * paid that during the menu. Regrouping the finished geometry costs 3-13 ms —
 * measured per weapon: m4a1 13, awp 6, mp5 5, glock 4, ak47/deagle 3 — because it
 * is only a geometry copy and an index offset. That is what keeps a bot spawning
 * with a gun nobody has held yet from dropping a frame.
 *
 * WHY THE MOVING PARTS ARE BAKED IN: nothing drives them in third person.
 * src/ai/bots.js only ever adds and removes `bot.heldWeapon`; it never reads
 * `userData.parts`, and there is no third-person reload, bolt or slide
 * animation. They are static geometry, so they belong in the merge.
 *
 * The merged group therefore reports `parts` as EMPTY rather than handing back
 * placeholder nodes. A placeholder would resolve, accept a transform, and move
 * nothing — a silent failure. `userData.merged` is the flag to test instead.
 *
 * @param {THREE.Group} source  a group from `buildWeaponObject`
 * @param {import('./materials.js').WeaponMaterials} mats
 * @returns {THREE.Group}
 */
export function collapseWeaponObject(source, mats) {
  const group = new THREE.Group();
  group.name = `${source.name}:tp`;

  // Part nodes carry the rest transforms applied by `applyNode`; baking them in
  // is what lets the magazine and the bolt join the body's buckets.
  source.updateMatrixWorld(true);
  const toLocal = new THREE.Matrix4().copy(source.matrixWorld).invert();

  const buckets = new Map(); // class -> geometry[]
  let dropped = 0;
  source.traverse((o) => {
    if (!o.isMesh) return;
    const key = o.userData.matKey;
    if (key === undefined) {
      if (!_warnedKeys.has(`mesh:${o.name}`)) {
        _warnedKeys.add(`mesh:${o.name}`);
        console.warn(`[weapons] ${o.name} has no matKey; third-person merge is skipping it`);
      }
      return;
    }
    let cls = key;
    if (key in TP_MATERIAL_CLASS) {
      cls = TP_MATERIAL_CLASS[key];
      if (cls === null) {
        dropped += triCount(o.geometry);
        return;
      }
    } else if (!_warnedKeys.has(`key:${key}`)) {
      _warnedKeys.add(`key:${key}`);
      console.warn(
        `[weapons] material '${key}' is not in TP_MATERIAL_CLASS — it keeps its own ` +
          `third-person draw call on every bot carrying this weapon`
      );
    }
    const geo = o.geometry.clone();
    geo.applyMatrix4(_tpMatrix.multiplyMatrices(toLocal, o.matrixWorld));
    let list = buckets.get(cls);
    if (!list) buckets.set(cls, (list = []));
    list.push(geo);
  });

  let tris = 0;
  for (const [cls, list] of buckets) {
    const geo = tpMerge(list);
    if (!geo) continue;
    const mesh = new THREE.Mesh(geo, mats.get(cls));
    mesh.name = `${source.userData.weaponId}-tp-${cls}`;
    mesh.userData.matKey = cls;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    tris += triCount(geo);
  }

  // Same plain-data contract as the full build — `weaponInstance` clones this
  // and everything downstream reads these keys, not the scene graph.
  group.userData.weaponId = source.userData.weaponId;
  group.userData.tris = tris;
  group.userData.muzzle = [...source.userData.muzzle];
  group.userData.eject = [...source.userData.eject];
  group.userData.sight = [...source.userData.sight];
  group.userData.partNames = {};
  group.userData.merged = true;
  group.userData.droppedTris = dropped;
  return group;
}

/**
 * Find a built (or cloned) weapon's moving parts again.
 *
 * A merged third-person weapon has no part nodes and correctly returns `{}`.
 * @returns {Object<string, THREE.Object3D>}
 */
export function resolveParts(object) {
  const names = object.userData.partNames ?? {};
  const out = {};
  for (const [key, name] of Object.entries(names)) {
    const found = object.getObjectByName(name);
    if (found) out[key] = found;
  }
  return out;
}

/** Free everything a built weapon owns. Materials are shared and stay. */
export function disposeWeaponObject(group) {
  group.traverse((o) => {
    if (o.isMesh) o.geometry.dispose();
  });
}
