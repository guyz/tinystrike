import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import ViewModel from '../src/weapons/viewmodel.js';
import { WEAPONS } from '../src/weapons/data.js';

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
  // while the already-cloned skeleton remains attached to its wrapper.
  const akArms = vm._models.ak47.userData.npcArms;
  assert.ok(akArms.position.length() > 0);
  vm._poseNPCArms(akArms, 'ak47', 'glb');
  assert.ok(akArms.position.length() < 1e-9);
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
