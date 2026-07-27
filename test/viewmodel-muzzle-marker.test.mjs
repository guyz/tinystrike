// Regression cover for the muzzle marker of the procedural firearms.
//
// The bug these tests exist for shipped silently and was expensive to find.
// `build.js` stores every weapon node as PLAIN DATA — `userData.muzzle` is a
// three-number ARRAY, deliberately, because Object3D.copy() round-trips
// userData through JSON and one built template is cloned for the viewmodel and
// for every soldier carrying that gun. The viewmodel seeded its muzzle marker
// with `Object3D.position.copy(userData.muzzle)`, and Vector3.copy() reads
// .x/.y/.z — off an Array those are `undefined`, NOT NaN, so nothing threw.
// Object3D then composed a NaN matrix from them.
//
// Measured consequence on all seven procedural firearms: getMuzzleWorldPos()
// returned (NaN, NaN, NaN), combat emitted 'fx:tracer' with from=(NaN,NaN,NaN),
// and effects spawned the muzzle flash, the smoke wisp and the shell casing at
// NaN. A NaN vertex is discarded by the rasteriser, so firing produced no
// tracer, no flash, no smoke and no casing — nothing left the barrel at all.
// The knife and the grenades were unaffected, because they take the GLB path
// and read a real `Muzzle` empty out of the file. That asymmetry is why it read
// as "the gun is not shooting where I am aiming" rather than as a crash.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import ViewModel from '../src/weapons/viewmodel.js';
import { WEAPONS } from '../src/weapons/data.js';
import { buildWeaponModel, PROCEDURAL_WEAPON_IDS } from '../src/gfx/weapons/catalogue.js';

function makeBareViewModel() {
  const vm = Object.create(ViewModel.prototype);
  vm._models = {};
  for (const id of Object.keys(WEAPONS)) {
    const group = new THREE.Group();
    group.userData.weaponSource = 'fallback';
    vm._models[id] = group;
  }
  return vm;
}

/** Stand-in for what `weaponInstance()` hands `_applyProcedural`. */
function makeBuiltWeapon(model) {
  const object = new THREE.Group();
  // EXACTLY the shape build.js stores: a plain array, not a Vector3.
  object.userData.muzzle = [...model.nodes.muzzle];
  object.userData.parts = {};
  return object;
}

test('every procedural firearm gets a finite muzzle marker at its authored crown', () => {
  const vm = makeBareViewModel();

  for (const id of PROCEDURAL_WEAPON_IDS) {
    const model = buildWeaponModel(id);
    vm._applyProcedural(id, makeBuiltWeapon(model), model);

    const marker = vm._models[id].userData.muzzle;
    assert.ok(marker, `${id}: no muzzle marker was bound`);

    for (const axis of ['x', 'y', 'z']) {
      assert.ok(
        Number.isFinite(marker.position[axis]),
        `${id}: muzzle marker ${axis} is ${marker.position[axis]} — a non-finite ` +
          'muzzle silently deletes the tracer, the flash, the smoke and the casing'
      );
    }

    // It must land ON the authored barrel crown, not merely be finite.
    assert.deepEqual(
      marker.position.toArray().map((v) => Number(v.toFixed(6))),
      model.nodes.muzzle.map((v) => Number(v.toFixed(6))),
      `${id}: muzzle marker is not at the authored crown`
    );

    // A NaN world matrix does not throw either, so check the composed result.
    marker.updateWorldMatrix(true, false);
    assert.ok(
      marker.matrixWorld.elements.every(Number.isFinite),
      `${id}: muzzle marker composed a non-finite world matrix`
    );
  }
});

test('a muzzle node that cannot be seated is dropped, not stored as NaN', () => {
  const vm = makeBareViewModel();
  const model = buildWeaponModel('ak47');
  const object = new THREE.Group();
  object.userData.muzzle = { nonsense: true }; // neither array nor Vector3
  object.userData.parts = {};

  vm._applyProcedural('ak47', object, model);

  // null is the documented "fall back to the camera ray" signal; a marker left
  // at its default (0,0,0) is finite but spawns tracers out of the grip, and a
  // NaN one is an invisible tracer. Only null is acceptable.
  //
  // NOTE: assert on a PRIMITIVE, never on the Object3D itself. A failing
  // assert.equal(object3D, null) sends util.inspect walking the wrapper's
  // circular parent/children graph and the whole built weapon, which exhausts
  // the heap and reports as an OOM instead of as the assertion that failed.
  assert.equal(
    vm._models.ak47.userData.muzzle === null,
    true,
    'an unusable muzzle node must be dropped so getMuzzleWorldPos falls back'
  );
});

test('getMuzzleWorldPos never hands a non-finite point to combat or effects', () => {
  const camera = new THREE.PerspectiveCamera(74, 1.6, 0.1, 100);
  camera.position.set(3, 1.7, -4);
  camera.updateMatrixWorld(true);

  const vm = Object.create(ViewModel.prototype);
  vm.rig = new THREE.Group();
  vm.rig.visible = true;
  vm._vDir = new THREE.Vector3();
  vm._muzzleOut = new THREE.Vector3();
  vm._currentId = 'ak47';
  vm.game = { camera };

  // A marker whose position went bad upstream — the exact failure mode above.
  const rotten = new THREE.Object3D();
  rotten.position.set(NaN, NaN, NaN);
  const group = new THREE.Group();
  group.visible = true;
  group.userData.muzzle = rotten;
  group.add(rotten);
  vm.rig.add(group);
  vm._models = { ak47: group };

  const out = vm.getMuzzleWorldPos(new THREE.Vector3());
  assert.ok(
    Number.isFinite(out.x) && Number.isFinite(out.y) && Number.isFinite(out.z),
    `returned (${out.x}, ${out.y}, ${out.z}) — combat and effects consume this ` +
      'without checking, and a NaN origin deletes four effects silently'
  );
  // The fallback is the camera ray, so it must sit in front of the eye.
  const ahead = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  assert.ok(
    out.clone().sub(camera.position).dot(ahead) > 0,
    'the fallback muzzle must be in front of the camera'
  );
});
