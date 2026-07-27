// Floating / buried part scanner.
//
//   node tools/measure-weapon-defects.mjs m4a1 [gapToleranceMm]
//
// The two defect classes that a turntable screenshot CANNOT show you, which is
// why they have repeatedly shipped:
//
//  FLOATING — a part whose AABB is separated from every other part's AABB by
//    more than the tolerance. A real firearm has no such part: everything is
//    pinned, welded, screwed or dovetailed to something touching it. This is the
//    defect the user sees as "floating pieces".
//
//  ENCLOSED — a part whose AABB lies strictly inside ONE other solid part's
//    AABB with clearance on all six faces, i.e. it contributes nothing to the
//    silhouette and nothing to the shading. It is invisible in a screenshot by
//    definition, so the only way to find it is like this. Cavities, glass and
//    cartridges are exempt: those are *meant* to be inside something.
//
// Both are heuristics on axis-aligned boxes, so read the hits as leads and
// confirm against the model, not as verdicts. A diagonal part (a canted bolt
// knob, a raked magazine) has a loose AABB and can show a false gap; a part
// that touches only its own host's chamfer can show a fraction of a millimetre.
// The tolerance defaults to 1.2 mm for that reason.
import * as THREE from 'three';
import { Assembly } from '../src/gfx/weapons/geometry.js';
import { buildWeaponModel, PROCEDURAL_WEAPON_IDS } from '../src/gfx/weapons/catalogue.js';

const SEAT = {
  magazine: 'magSeat',
  charging: 'chargeRest',
  bolt: 'boltRest',
  slide: 'slideRest',
  trigger: 'triggerPivot',
  selector: 'selectorPivot',
};

/** Materials that legitimately live inside another part. */
const INTERNAL = new Set(['cavity', 'glass', 'lens_ring', 'lens_vig', 'brass', 'copper']);

/** Gap between two AABBs: 0 if they touch or overlap, else the separation. */
function gap(a, b) {
  let d2 = 0;
  for (const ax of ['x', 'y', 'z']) {
    const d = Math.max(b.min[ax] - a.max[ax], a.min[ax] - b.max[ax], 0);
    d2 += d * d;
  }
  return Math.sqrt(d2);
}

function scan(id, gapTol) {
  // Capture every add with its own AABB, tagged by assembly and call site.
  const orig = Assembly.prototype.add;
  const items = [];
  Assembly.prototype.add = function (geo, mat, t) {
    const site = (new Error().stack.split('\n')[2] || '?')
      .trim()
      .replace(/^at\s+/, '')
      .replace(/.*\/weapons\//, '')
      .replace(/\)$/, '');
    const r = orig.call(this, geo, mat, t);
    const list = this.buckets.get(mat);
    const g = list[list.length - 1];
    g.computeBoundingBox();
    items.push({ asm: this.name, mat, site, box: g.boundingBox.clone() });
    return r;
  };
  let model;
  try {
    model = buildWeaponModel(id);
  } finally {
    Assembly.prototype.add = orig;
  }
  if (!model) {
    console.log(`\n=== ${id} — no procedural model (ids: ${PROCEDURAL_WEAPON_IDS.join(', ')}) ===`);
    return 0;
  }

  // A moving part's local space is not the weapon's: push each through its rest
  // transform, or every magazine and trigger reads as floating. (This is the
  // same correction measure-weapon-parts.mjs exists to make.)
  const seatOf = new Map([[model.body.name, null]]);
  for (const [part, asm] of Object.entries(model.moving ?? {})) seatOf.set(asm.name, SEAT[part]);
  for (const it of items) {
    const seat = seatOf.get(it.asm);
    const node = seat ? model.nodes[seat] : null;
    if (!node) continue;
    it.box.applyMatrix4(
      new THREE.Matrix4().compose(
        new THREE.Vector3().fromArray(node.pos),
        new THREE.Quaternion().setFromEuler(new THREE.Euler().fromArray(node.rot ?? [0, 0, 0])),
        new THREE.Vector3(1, 1, 1)
      )
    );
  }

  const mm = (v) => (v * 1000).toFixed(1);
  console.log(`\n=== ${id} — ${items.length} adds ===`);

  const floats = [];
  for (let i = 0; i < items.length; i++) {
    let best = Infinity;
    let bestJ = -1;
    for (let j = 0; j < items.length; j++) {
      if (i === j) continue;
      const g = gap(items[i].box, items[j].box);
      if (g < best) {
        best = g;
        bestJ = j;
      }
    }
    if (best > gapTol) floats.push([items[i], best, items[bestJ]]);
  }
  console.log(`-- FLOATING (>${mm(gapTol)} mm clear of every other part): ${floats.length}`);
  for (const [it, g, near] of floats.sort((a, b) => b[1] - a[1])) {
    console.log(
      `   ${mm(g).padStart(6)} mm  ${it.mat.padEnd(13)}${it.site.padEnd(24)}[${it.asm}]` +
        `  nearest ${near.site} ${near.mat}`
    );
  }

  const buried = [];
  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    if (INTERNAL.has(a.mat)) continue;
    const m = 0.0004; // 0.4 mm of clearance on all six faces before it counts
    for (let j = 0; j < items.length; j++) {
      if (i === j) continue;
      const b = items[j];
      if (INTERNAL.has(b.mat)) continue;
      if (
        a.box.min.x >= b.box.min.x + m && a.box.max.x <= b.box.max.x - m &&
        a.box.min.y >= b.box.min.y + m && a.box.max.y <= b.box.max.y - m &&
        a.box.min.z >= b.box.min.z + m && a.box.max.z <= b.box.max.z - m
      ) {
        buried.push([a, b]);
        break;
      }
    }
  }
  console.log(`-- ENCLOSED by a single other solid part: ${buried.length}`);
  for (const [a, b] of buried) {
    console.log(
      `   ${a.mat.padEnd(13)}${a.site.padEnd(24)}[${a.asm}]  inside  ${b.site} ${b.mat}`
    );
  }
  return floats.length + buried.length;
}

const args = process.argv.slice(2);
const tol = Number(args.find((a) => /^[\d.]+$/.test(a)) ?? 1.2) / 1000;
const ids = args.filter((a) => !/^[\d.]+$/.test(a));
let hits = 0;
for (const id of ids.length ? ids : PROCEDURAL_WEAPON_IDS) hits += scan(id, tol);
console.log(`\n${hits} lead(s) to confirm against the model.`);
