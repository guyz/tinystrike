// The third-person weapon collapse (src/gfx/weapons/build.js collapseWeaponObject).
//
// A soldier's gun is a first-person asset seen from across a lane. Measured on
// Dustyard with nine bots on a rifle loadout, camera 22 m back, through the game's
// own post chain with renderer.info.autoReset off:
//
//                     draw calls   triangles
//   no weapons held          426    1169068
//   full-detail weapons      751    1753624
//   merged weapons           535    1743064
//
// so the weapons' share of the frame was 325 draw calls and is now 109 — the
// 158 held meshes became 55, and each is drawn about twice (main pass plus the
// shadow cascade). Silhouette area of the objects being paid for, at 8 m through
// the 74-degree camera at 2800x1680: awp 1387 px, ak47 972, m4a1 810, mp5 742,
// deagle 341, usp 277, glock 219.
//
// The collapse is only correct if the gun is the same gun. These tests pin the
// mesh count so the win cannot quietly regress, and pin the things that make the
// win safe: the geometry is bit-identical, the vertex wear masks survive, the
// viewmodel path is untouched, and the hand-bone seating contract still holds.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import {
  buildWeaponObject,
  collapseWeaponObject,
  resolveParts,
  TP_MATERIAL_CLASS,
} from '../src/gfx/weapons/build.js';
import { WeaponMaterials, WEAPON_MATERIALS } from '../src/gfx/weapons/materials.js';
import { buildWeaponModel, PROCEDURAL_WEAPON_IDS } from '../src/gfx/weapons/catalogue.js';
import { bakeMasks, setMask } from '../src/gfx/materials/masks.js';

/**
 * PINNED third-person draw calls per weapon.
 *
 * If one of these fails after a model change, the fix is NOT to bump the number:
 * a new material bucket means a new key that `TP_MATERIAL_CLASS` has not triaged,
 * and an untriaged key costs a draw call on every bot carrying that gun. Decide
 * which third-person class the new surface belongs to, add it to the table, and
 * only then update the pin.
 */
const TP_MESHES = { m4a1: 7, ak47: 6, mp5: 6, awp: 7, deagle: 6, usp: 5, glock: 5 };

/** Full-detail counts, for the ratio assertion. */
const VM_MESHES = { m4a1: 21, ak47: 16, mp5: 16, awp: 21, deagle: 16, usp: 16, glock: 15 };

/**
 * A material library that behaves like the real `MaterialSystem` in the ways the
 * weapon build depends on: `get(name, opts)` returns one material per distinct
 * request, and `bakeMasks` is the real curvature bake, so the `color` attribute
 * the merge has to preserve is genuinely there.
 */
function stubLibrary() {
  const cache = new Map();
  return {
    get(name, opts = {}) {
      const key = `${name}|${JSON.stringify(opts)}`;
      let m = cache.get(key);
      if (!m) {
        m = new THREE.MeshStandardMaterial({ name: key });
        cache.set(key, m);
      }
      return m;
    },
    bakeMasks: (geo, opts) => bakeMasks(geo, opts),
    setMask: (geo, opts) => setMask(geo, opts),
  };
}

function meshes(root) {
  const out = [];
  root.traverse((o) => {
    if (o.isMesh) out.push(o);
  });
  return out;
}

const triangles = (geo) => {
  const idx = geo.getIndex();
  return (idx ? idx.count : geo.getAttribute('position').count) / 3;
};

/** Build both flavours of one weapon off one model, the way the registry does. */
function buildPair(id) {
  const mats = new WeaponMaterials(stubLibrary());
  const full = buildWeaponObject(buildWeaponModel(id), mats, { viewmodel: false });
  const merged = collapseWeaponObject(full, mats);
  return { mats, full, merged };
}

test('every material key the models use is triaged, and only transparent ones are dropped', () => {
  const seen = new Set();
  for (const id of PROCEDURAL_WEAPON_IDS) {
    const { full } = buildPair(id);
    for (const mesh of meshes(full)) {
      assert.equal(typeof mesh.userData.matKey, 'string',
        `${mesh.name} must carry userData.matKey — the collapse groups on it`);
      seen.add(mesh.userData.matKey);
    }
  }
  // An unlisted key is not a failure — it stays its own class, which is the safe
  // direction — but it costs a draw call per bot, so it has to be visible.
  const untriaged = [...seen].filter((k) => !(k in TP_MATERIAL_CLASS));
  const dropped = [...seen].filter((k) => TP_MATERIAL_CLASS[k] === null);

  // Dropping opaque geometry would punch a hole in the gun. Everything on the
  // drop list has to be a transparent overlay, which is checkable: the four
  // optic materials are the only ones WEAPON_MATERIALS does not define, because
  // they are hand-built transparent/unlit inserts in materials.js.
  const mats = new WeaponMaterials(stubLibrary());
  for (const key of dropped) {
    assert.equal(key in WEAPON_MATERIALS, false,
      `${key} is a surfaced PBR material; only transparent optic inserts may be dropped`);
    assert.equal(mats.get(key).transparent, true,
      `${key} is opaque — dropping it would leave a hole in the silhouette`);
  }

  // Anything folded into another class must name a class that really exists.
  for (const [key, cls] of Object.entries(TP_MATERIAL_CLASS)) {
    if (cls === null) continue;
    assert.equal(TP_MATERIAL_CLASS[cls] ?? cls, cls,
      `${key} collapses into ${cls}, which itself collapses further — flatten the table`);
  }

  assert.deepEqual(untriaged, [],
    `these material keys cost an extra third-person draw call each: ${untriaged.join(', ')}`);
});

for (const id of PROCEDURAL_WEAPON_IDS) {
  test(`${id} collapses to ${TP_MESHES[id]} third-person draw calls`, () => {
    const { full, merged } = buildPair(id);

    const before = meshes(full);
    const after = meshes(merged);
    assert.equal(before.length, VM_MESHES[id],
      `${id} full-detail build changed (${before.length} meshes) — re-measure before touching the pin`);
    assert.equal(after.length, TP_MESHES[id],
      `${id} third-person build is ${after.length} draw calls, pinned at ${TP_MESHES[id]}`);

    // The merge only pays off if it really is one mesh per class.
    assert.equal(new Set(after.map((m) => m.material)).size, after.length,
      'two merged meshes share a material — they should have been one draw call');
    assert.equal(new Set(after.map((m) => m.userData.matKey)).size, after.length,
      'two merged meshes claim the same class');

    // Every third-person mesh is opaque: the transparent pass has to be empty,
    // both for the sort cost and because those shaders are the frame's dearest.
    for (const mesh of after) {
      assert.equal(mesh.material.transparent, false,
        `${mesh.name} is transparent; third person must not add to the sorted pass`);
      assert.equal(mesh.castShadow, true, 'a held weapon casts into the world');
      assert.equal(mesh.receiveShadow, true);
    }

    // Flat: one group, N meshes, no intermediate nodes to walk or update.
    assert.equal(merged.children.length, after.length,
      'the merged weapon must be a flat group — no part nodes left to transform');
    for (const child of merged.children) assert.equal(child.isMesh, true);
  });

  test(`${id} keeps every triangle it did not deliberately drop, in the same place`, () => {
    const { mats, full, merged } = buildPair(id);

    // Bucket the source geometry by the class it collapses into, in the same
    // world space the collapse works in, and compare AABBs. This is the check
    // that a part's rest transform was baked in correctly: a magazine merged
    // without its `magSeat` offset would sit 30 mm out and show up here.
    full.updateMatrixWorld(true);
    const wanted = new Map();
    let keptTris = 0;
    let droppedTris = 0;
    for (const mesh of meshes(full)) {
      const key = mesh.userData.matKey;
      const cls = key in TP_MATERIAL_CLASS ? TP_MATERIAL_CLASS[key] : key;
      if (cls === null) {
        droppedTris += triangles(mesh.geometry);
        continue;
      }
      keptTris += triangles(mesh.geometry);
      const geo = mesh.geometry.clone();
      geo.applyMatrix4(mesh.matrixWorld);
      geo.computeBoundingBox();
      const box = wanted.get(cls) ?? new THREE.Box3();
      box.union(geo.boundingBox);
      wanted.set(cls, box);
      geo.dispose();
    }

    assert.equal(merged.userData.droppedTris, droppedTris);
    assert.equal(merged.userData.tris, keptTris,
      'the merge must neither drop nor duplicate a triangle it was asked to keep');
    assert.deepEqual([...wanted.keys()].sort(), merged.children.map((m) => m.userData.matKey).sort());

    let totalTris = 0;
    for (const mesh of merged.children) {
      totalTris += triangles(mesh.geometry);
      mesh.geometry.computeBoundingBox();
      const got = mesh.geometry.boundingBox;
      const want = wanted.get(mesh.userData.matKey);
      // Exact, not approximate: the collapse is a rigid transform plus an index
      // offset, so any drift at all means a matrix went in wrong.
      for (const corner of ['min', 'max']) {
        for (const axis of ['x', 'y', 'z']) {
          assert.equal(got[corner][axis], want[corner][axis],
            `${id}/${mesh.userData.matKey} ${corner}.${axis} moved by ` +
              `${((got[corner][axis] - want[corner][axis]) * 1000).toFixed(4)} mm`);
        }
      }
      assert.equal(mesh.material, mats.get(mesh.userData.matKey),
        `${mesh.userData.matKey} must be drawn with its own class material`);
    }
    assert.equal(totalTris, keptTris);
  });

  test(`${id} carries its wear, grime and AO vertex masks through the merge`, () => {
    const { full, merged } = buildPair(id);

    // These three channels are what stop the gun reading as clean plastic, and
    // they live in a `color` attribute that the geometry kit's own
    // `normalizeAttributes` strips. Losing them is silent — the gun still draws.
    const channelSum = (root) => {
      const sum = [0, 0, 0];
      let verts = 0;
      for (const mesh of meshes(root)) {
        const key = mesh.userData.matKey;
        if ((key in TP_MATERIAL_CLASS ? TP_MATERIAL_CLASS[key] : key) === null) continue;
        const col = mesh.geometry.getAttribute('color');
        assert.ok(col, `${mesh.name} lost its mask attribute`);
        assert.equal(col.itemSize, 3);
        verts += col.count;
        for (let i = 0; i < col.count; i++) {
          sum[0] += col.getX(i);
          sum[1] += col.getY(i);
          sum[2] += col.getZ(i);
        }
      }
      return { sum, verts };
    };

    const a = channelSum(full);
    const b = channelSum(merged);
    assert.equal(b.verts, a.verts, 'the merge changed the vertex count');
    for (let k = 0; k < 3; k++) {
      assert.ok(Math.abs(b.sum[k] - a.sum[k]) < 1e-3,
        `mask channel ${'rgb'[k]} totals ${b.sum[k]} against ${a.sum[k]} — the bake was lost or altered`);
    }
    assert.ok(a.sum[0] > 0, 'the fixture has to actually have baked masks, or this proves nothing');
  });

  test(`${id} merged weapon still satisfies the seating and clone contract`, () => {
    const { full, merged } = buildPair(id);

    // bots.js reads none of the scene graph: it copies the pack's seat transform
    // onto the group and counter-scales by the hand bone. Everything it and the
    // tracer code touch is plain data on userData, which has to survive the JSON
    // round-trip Object3D.copy() puts it through.
    assert.equal(merged.userData.weaponId, full.userData.weaponId);
    assert.deepEqual(merged.userData.muzzle, full.userData.muzzle);
    assert.deepEqual(merged.userData.eject, full.userData.eject);
    assert.deepEqual(merged.userData.sight, full.userData.sight);
    assert.equal(merged.userData.merged, true, 'the flag is how callers detect a baked weapon');
    assert.equal(JSON.parse(JSON.stringify(merged.userData)).merged, true,
      'userData must be JSON-safe: one template is cloned per soldier');

    const clone = merged.clone(true);
    assert.equal(meshes(clone).length, TP_MESHES[id], 'a clone is the same draw calls');
    assert.equal(clone.children[0].geometry, merged.children[0].geometry,
      'clones share geometry — nine bots must cost draw calls, not memory');

    // resolveParts on a merged weapon returns nothing, and that is the contract:
    // a placeholder node would accept a transform and move no geometry, which is
    // a silent failure. Nothing drives a bot weapon's slide, magazine or bolt.
    const parts = resolveParts(clone);
    assert.deepEqual(parts, {}, 'a merged weapon exposes no moving parts');
    assert.deepEqual(merged.userData.partNames, {});

    // The scale contract: the group's own transform is identity, so the bone
    // counter-scale in _attachHeldWeapon lands the gun at true size.
    assert.deepEqual(merged.position.toArray(), [0, 0, 0]);
    assert.deepEqual(merged.scale.toArray(), [1, 1, 1]);
    assert.deepEqual(merged.quaternion.toArray(), [0, 0, 0, 1]);
  });

  test(`${id} viewmodel build is untouched by the collapse`, () => {
    const mats = new WeaponMaterials(stubLibrary());
    const model = buildWeaponModel(id);
    const full = buildWeaponObject(model, mats, { viewmodel: true });

    // The animation layer drives these by name through userData.parts, so the
    // viewmodel must keep one node per moving part and its own mesh per bucket.
    const wanted = Object.keys(model.moving ?? {});
    assert.ok(wanted.length > 0, `${id} should have moving parts`);
    const parts = resolveParts(full);
    assert.deepEqual(Object.keys(parts).sort(), wanted.sort());
    for (const name of wanted) {
      assert.ok(parts[name].isObject3D && !parts[name].isMesh,
        `${name} must stay a transformable node`);
      assert.ok(meshes(parts[name]).length > 0, `${name} must still own geometry`);
    }
    assert.equal(meshes(full).length, VM_MESHES[id],
      'the first-person gun keeps every separate mesh it had');
    assert.equal(full.userData.merged, undefined, 'the viewmodel build is not a merged one');

    // Collapsing must not mutate the object it reads.
    const before = meshes(full).length;
    collapseWeaponObject(full, mats);
    assert.equal(meshes(full).length, before, 'collapseWeaponObject consumed its source');
    assert.deepEqual(Object.keys(resolveParts(full)).sort(), wanted.sort(),
      'collapseWeaponObject stole the source weapon parts');
  });
}

test('the collapse is worth its complexity on every weapon', () => {
  // Nothing here should ever be within a couple of draw calls of the full build;
  // if it is, the class table has stopped collapsing anything and the extra code
  // path is not paying for itself.
  for (const id of PROCEDURAL_WEAPON_IDS) {
    const ratio = TP_MESHES[id] / VM_MESHES[id];
    assert.ok(ratio <= 0.45,
      `${id} only gets to ${TP_MESHES[id]}/${VM_MESHES[id]} draw calls (${(ratio * 100).toFixed(0)}%)`);
    assert.ok(TP_MESHES[id] <= 8, `${id} third-person build is ${TP_MESHES[id]} draw calls; the budget is 8`);
  }
  const total = PROCEDURAL_WEAPON_IDS.reduce((n, id) => n + TP_MESHES[id], 0);
  const wasTotal = PROCEDURAL_WEAPON_IDS.reduce((n, id) => n + VM_MESHES[id], 0);
  assert.equal(wasTotal, 121);
  assert.equal(total, 42);
});
