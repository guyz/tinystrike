import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import ViewModel, {
  NPC_ARM_POSES,
  NPC_ARM_FAMILY,
  NPC_ARM_FIST_CENTER,
  PROC_POSES,
} from '../src/weapons/viewmodel.js';
import { WEAPONS } from '../src/weapons/data.js';
import { buildWeaponModel, PROCEDURAL_WEAPON_IDS } from '../src/gfx/weapons/catalogue.js';

function makeSkinnedArmSource() {
  const source = new THREE.Group();
  const grip = new THREE.Object3D();
  grip.name = 'VM_Grip';
  source.add(grip);

  const shoulder = new THREE.Bone();
  shoulder.name = 'UpperArm.R';
  const hand = new THREE.Bone();
  hand.name = 'Hand.R';
  hand.position.y = -0.2;
  shoulder.add(hand);
  source.add(shoulder);

  const geometry = new THREE.BoxGeometry(0.05, 0.25, 0.05);
  const vertexCount = geometry.getAttribute('position').count;
  const skinIndices = new Uint16Array(vertexCount * 4);
  const skinWeights = new Float32Array(vertexCount * 4);
  for (let i = 0; i < vertexCount; i++) skinWeights[i * 4] = 1;
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));

  const material = new THREE.MeshStandardMaterial({ color: 0x889977 });
  const body = new THREE.SkinnedMesh(geometry, material);
  body.name = 'Body';
  body.add(shoulder);
  body.bind(new THREE.Skeleton([shoulder, hand]));
  grip.add(body);
  return source;
}

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

test('one NPC arm source is skeleton-cloned into every weapon wrapper', () => {
  const vm = makeBareViewModel();
  const source = makeSkinnedArmSource();
  const sourceMesh = source.getObjectByName('Body');

  vm._applyNPCArms({ scene: source });

  const armClones = [];
  for (const id of Object.keys(WEAPONS)) {
    const group = vm._models[id];
    const arms = group.userData.npcArms;
    assert.ok(arms, `${id} should receive the NPC arm`);
    assert.equal(arms.parent, group);
    assert.equal(
      group.children.filter((child) => child.userData.isNPCViewmodelArms).length,
      1,
      `${id} should contain exactly one NPC arm clone`
    );

    const mesh = arms.getObjectByName('Body');
    assert.ok(mesh && mesh.isSkinnedMesh, `${id} should retain the skinned mesh`);
    assert.equal(mesh.geometry, sourceMesh.geometry, 'immutable arm geometry should be shared');
    assert.notEqual(mesh.material, sourceMesh.material, 'profile tint needs a wrapper-local material clone');
    assert.notEqual(mesh.skeleton, sourceMesh.skeleton, 'each wrapper needs an independent skeleton');
    assert.notEqual(mesh.skeleton.bones[0], sourceMesh.skeleton.bones[0]);
    armClones.push(arms);
  }

  const firstMesh = armClones[0].getObjectByName('Body');
  const secondMesh = armClones[1].getObjectByName('Body');
  assert.notEqual(firstMesh.skeleton, secondMesh.skeleton);
  assert.equal(firstMesh.geometry, secondMesh.geometry);
  assert.notEqual(firstMesh.material, secondMesh.material, 'each weapon wrapper must own its tintable material');

  // Once a real weapon GLB arrives, the fallback grip correction is removed
  // while the already-cloned skeleton remains attached to its wrapper. What is
  // left is the family's own grip seat, which is NOT the identity: the fist has
  // to end up around the pistol grip, which sits below and behind the wrapper
  // origin (see NPC_ARM_POSES).
  const akArms = vm._models.ak47.userData.npcArms;
  const withFallback = akArms.position.clone();
  vm._poseNPCArms(akArms, 'ak47', 'glb');
  const seated = akArms.position.clone();
  assert.deepEqual(
    withFallback.clone().sub(seated).toArray().map((v) => +v.toFixed(6)),
    NPC_ARM_POSES.rifle.fallback.map((v) => +v.toFixed(6)),
    'switching off the primitive fallback must remove exactly the fallback offset'
  );
  assert.deepEqual(
    seated.toArray().map((v) => +v.toFixed(6)),
    NPC_ARM_POSES.rifle.pos.map((v) => +v.toFixed(6))
  );
  assert.ok(seated.length() > 0.005, 'the grip seat is an offset, not the identity');
});

test('invalid NPC arm sources fail before replacing the active source', () => {
  const vm = makeBareViewModel();
  assert.throws(
    () => vm._applyNPCArms({ scene: new THREE.Group() }),
    /no SkinnedMesh/
  );
  assert.equal(vm._npcArmsSource, undefined);
});

test('profile appearance recolors cloned arms without mutating the GLB source material', () => {
  const vm = makeBareViewModel();
  vm.game = { profile: { characterId: 'vanguard' }, player: { team: 'ct' } };
  const source = makeSkinnedArmSource();
  const sourceMaterial = source.getObjectByName('Body').material;
  const originalColor = sourceMaterial.color.getHex();
  vm._applyNPCArms({ scene: source });

  vm.applyProfileAppearance('breacher');
  const akArms = vm._models.ak47.userData.npcArms;
  assert.equal(akArms.userData.characterId, 'breacher');
  assert.notEqual(akArms.getObjectByName('Body').material.color.getHex(), originalColor);
  assert.equal(sourceMaterial.color.getHex(), originalColor, 'source GLB material must remain untouched');
});

test('NPC arm source must be spatially seated under an identity VM_Grip', () => {
  const vm = makeBareViewModel();
  const translated = makeSkinnedArmSource();
  translated.getObjectByName('VM_Grip').position.x = 1;
  assert.throws(
    () => vm._applyNPCArms({ scene: translated }),
    /world-space identity/
  );

  const detached = makeSkinnedArmSource();
  const body = detached.getObjectByName('Body');
  detached.attach(body);
  assert.throws(
    () => vm._applyNPCArms({ scene: detached }),
    /parented under VM_Grip/
  );

  const drifted = makeSkinnedArmSource();
  drifted.getObjectByName('Body').position.x = 1;
  assert.throws(
    () => vm._applyNPCArms({ scene: drifted }),
    /hand bounds are not seated/
  );
});

test('the shipped CT arm GLB is a skinned, body-stripped grip asset', async () => {
  if (typeof globalThis.ProgressEvent === 'undefined') {
    globalThis.ProgressEvent = class ProgressEvent {};
  }

  const bytes = await readFile(
    new URL('../assets/models/viewmodels/npc-arms-ct.glb', import.meta.url)
  );
  const arrayBuffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  );
  const gltf = await new Promise((resolve, reject) => {
    new GLTFLoader().parse(arrayBuffer, '', resolve, reject);
  });

  assert.equal(gltf.animations.length, 0, 'viewmodel pose must be frozen');
  const grip = gltf.scene.getObjectByName('VM_Grip');
  assert.ok(grip, 'canonical identity grip is required');
  assert.ok(grip.position.length() < 1e-9);
  assert.ok(grip.quaternion.angleTo(new THREE.Quaternion()) < 1e-9);
  assert.ok(grip.scale.distanceTo(new THREE.Vector3(1, 1, 1)) < 1e-9);
  assert.equal(grip.userData.source_asset, 'assets/models/soldier_ct.glb');
  assert.equal(grip.userData.source_clip, 'Idle_Shoot');

  const renderMeshes = [];
  gltf.scene.traverse((object) => {
    if (object.isMesh) renderMeshes.push(object);
  });
  assert.equal(renderMeshes.length, 2, 'one two-material Body mesh is expected');
  assert.ok(renderMeshes.every((mesh) => mesh.isSkinnedMesh));
  assert.ok(renderMeshes.every((mesh) => mesh.skeleton.bones.length === 43));
  assert.deepEqual(
    renderMeshes.map((mesh) => mesh.material.name).sort(),
    ['Black', 'Skin']
  );
  assert.equal(
    renderMeshes.reduce((count, mesh) => count + mesh.geometry.attributes.position.count, 0),
    435,
    'only the authored CT right lower arm and finger vertices may ship'
  );

  const vm = makeBareViewModel();
  vm._applyNPCArms(gltf);
  for (const id of Object.keys(WEAPONS)) {
    const meshes = [];
    vm._models[id].userData.npcArms.traverse((object) => {
      if (object.isSkinnedMesh) meshes.push(object);
    });
    assert.equal(meshes.length, 2, `${id} must receive both authored materials`);
    assert.ok(meshes.every((mesh) => mesh.skeleton.bones.length === 43));
  }
});

async function loadShippedArm() {
  if (typeof globalThis.ProgressEvent === 'undefined') {
    globalThis.ProgressEvent = class ProgressEvent {};
  }
  const bytes = await readFile(
    new URL('../assets/models/viewmodels/npc-arms-ct.glb', import.meta.url)
  );
  const arrayBuffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  );
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(arrayBuffer, '', resolve, reject);
  });
}

/** Wrapper scale the running viewmodel gives each weapon group. */
function wrapperScale(id) {
  if (PROCEDURAL_WEAPON_IDS.includes(id)) return PROC_POSES[id].scale;
  return 1; // _applyGLB pins the group to 1 and scales only the weapon content
}

/**
 * The hand has to be a HAND in the frame — this is the regression that shipped.
 *
 * The arm GLB is the CT soldier's own, at the source file's scale, where the
 * stylised fist measures 288 x 320 x 330 mm and the index-to-pinky knuckle row
 * measures 173 mm. Two failures are one line apart here: seat it at the
 * character's in-game 0.806 and the fist swallows the receiver; seat it at the
 * 0.25 that shipped and it is a 43 mm lump hidden inside the gun. Both were
 * shot and both are visibly wrong, so the knuckle row is pinned to a human
 * hand's 45-75 mm ON EVERY WEAPON — which also fails if a wrapper scale in
 * PROC_POSES moves without its family's arm scale following it.
 */
test('the NPC hand is human-sized in camera space on every weapon', async () => {
  const gltf = await loadShippedArm();
  const vm = makeBareViewModel();
  vm._applyNPCArms(gltf);

  for (const id of Object.keys(WEAPONS)) {
    const group = vm._models[id];
    const scale = wrapperScale(id);
    group.scale.setScalar(scale);
    const arms = group.userData.npcArms;
    vm._poseNPCArms(arms, id, PROCEDURAL_WEAPON_IDS.includes(id) ? 'procedural' : 'glb');
    group.updateMatrixWorld(true);

    const index = arms.getObjectByName('Index2R');
    const pinky = arms.getObjectByName('Pinky2R');
    assert.ok(index && pinky, `${id} arm must keep its knuckle bones`);
    const span = new THREE.Vector3()
      .setFromMatrixPosition(index.matrixWorld)
      .distanceTo(new THREE.Vector3().setFromMatrixPosition(pinky.matrixWorld));
    assert.ok(
      span > 0.045 && span < 0.075,
      `${id}: knuckle row is ${(span * 1000).toFixed(1)} mm in camera space, ` +
        'outside the 45-75 mm a human hand occupies'
    );
  }
});

/**
 * The fist has to close on the PISTOL GRIP.
 *
 * VM_Grip is a point on the hand's own skin (measured clearance to the nearest
 * triangle: 0.7 mm) 45 mm off the middle of the fist, so seating it at the
 * wrapper origin — the identity pose — leaves the fist up inside the receiver
 * and 11 mm out to the right of the weapon's centre line. Checked against each
 * weapon's OWN exported nodes rather than against copied numbers, so it cannot
 * go stale when a model is re-cut.
 */
test('the seated fist closes on the pistol grip of every procedural firearm', () => {
  for (const id of PROCEDURAL_WEAPON_IDS) {
    const pose = NPC_ARM_POSES[NPC_ARM_FAMILY[id]];
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3().fromArray(pose.pos),
      new THREE.Quaternion().setFromEuler(new THREE.Euler().fromArray(pose.rot)),
      new THREE.Vector3(pose.scale, pose.scale, pose.scale)
    );
    const fist = new THREE.Vector3().fromArray(NPC_ARM_FIST_CENTER).applyMatrix4(matrix);

    const model = buildWeaponModel(id);
    const bore = model.nodes.muzzle[1];
    const triggerZ = model.nodes.triggerPivot.pos[2];

    assert.ok(
      Math.abs(fist.x) < 0.01,
      `${id}: fist centre is ${(fist.x * 1000).toFixed(1)} mm off the bore line — ` +
        'a hand wrapped around a grip straddles it'
    );
    const belowBore = bore - fist.y;
    assert.ok(
      belowBore > 0.03 && belowBore < 0.095,
      `${id}: fist centre is ${(belowBore * 1000).toFixed(1)} mm under the bore, ` +
        'not on the grip below the receiver'
    );
    const behindTrigger = fist.z - triggerZ;
    assert.ok(
      behindTrigger > 0.02 && behindTrigger < 0.08,
      `${id}: fist centre is ${(behindTrigger * 1000).toFixed(1)} mm behind the ` +
        'trigger — the grip is, the handguard and the stock are not'
    );
  }
});
