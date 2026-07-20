import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import Bots from '../src/ai/bots.js';
import Multiplayer from '../src/network/multiplayer.js';
import { CONFIG } from '../src/shared/config.js';

function makeVisuals(assets = { ct: null, t: null }) {
  return Object.assign(Object.create(Bots.prototype), {
    _charAssets: assets,
    _externalActors: new Set(),
    all: [],
    _cfg: CONFIG.BOT,
    time: 0,
  });
}

function makeActor(overrides = {}) {
  const position = new THREE.Vector3();
  return {
    team: 'ct',
    alive: true,
    pos: position,
    position,
    yaw: 0,
    pitch: 0,
    crouching: false,
    moveSpeed2D: 0,
    weaponId: 'ak47',
    ...overrides,
  };
}

function makeSkinnedBody(name, geometry, material) {
  const vertexCount = geometry.attributes.position.count;
  const skinIndex = new Uint16Array(vertexCount * 4);
  const skinWeight = new Float32Array(vertexCount * 4);
  for (let i = 0; i < vertexCount; i++) skinWeight[i * 4] = 1;
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));

  const rootBone = new THREE.Bone();
  rootBone.name = `${name}Root`;
  const mesh = new THREE.SkinnedMesh(geometry, material);
  mesh.name = name;
  mesh.add(rootBone);
  mesh.bind(new THREE.Skeleton([rootBone]));
  return mesh;
}

function makeCharacterAsset() {
  const scene = new THREE.Group();
  const bodyGeometry = new THREE.BoxGeometry(0.7, 1.5, 0.35);
  const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff });
  bodyMaterial.name = 'Character_Main';
  scene.add(makeSkinnedBody('Body', bodyGeometry, bodyMaterial));

  const skinGeometry = new THREE.SphereGeometry(0.2, 8, 6);
  const skinMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff });
  skinMaterial.name = 'Skin';
  const head = new THREE.Mesh(skinGeometry, skinMaterial);
  head.name = 'Head';
  scene.add(head);

  const weaponGeometry = new THREE.BoxGeometry(0.1, 0.1, 0.5);
  const weaponMaterial = new THREE.MeshStandardMaterial({ color: 0x252525 });
  // Real held meshes reuse tint-like names such as Grey; the adapter must
  // identify them by hierarchy and never recolor the shared weapon material.
  weaponMaterial.name = 'Grey';
  for (const name of ['AK', 'SMG', 'Sniper', 'Pistol']) {
    const socket = new THREE.Group();
    socket.name = name;
    const mesh = new THREE.Mesh(weaponGeometry, weaponMaterial);
    mesh.name = `${name}Geometry`;
    socket.add(mesh);
    scene.add(socket);
  }

  return {
    scene,
    clips: [
      new THREE.AnimationClip('Idle', 1, []),
      new THREE.AnimationClip('Death', 1, []),
    ],
    bodyGeometry,
    bodyMaterial,
    skinMaterial,
    weaponMaterial,
  };
}

test('an external operative is an empty, non-block root until its team asset loads', () => {
  const visuals = makeVisuals();
  const actor = makeActor();

  const root = visuals.createOperativeVisual(actor, {
    uniform: 0x345678,
    skin: 0xb97856,
    sleeve: 0x26384a,
    dark: 0x101820,
  });

  assert.ok(root.isGroup);
  assert.equal(root.name, 'remote-operative');
  assert.equal(root.visible, false);
  assert.equal(root.children.length, 0);
  assert.equal(root.getObjectByProperty('isMesh', true), undefined,
    'the async placeholder cannot regress to the old block body');
  assert.equal(visuals._externalActors.has(actor), true);
});

test('the operative adapter clones and tints body materials while preserving shared weapon assets', () => {
  const asset = makeCharacterAsset();
  const visuals = makeVisuals({ ct: asset, t: null });
  const palette = {
    uniform: 0x345678,
    skin: 0xb97856,
    sleeve: 0x26384a,
    dark: 0x101820,
  };
  const actor = makeActor();

  visuals.createOperativeVisual(actor, palette);

  const body = actor.rig.getObjectByName('Body');
  const head = actor.rig.getObjectByName('Head');
  const akGeometry = actor.rig.getObjectByName('AKGeometry');
  assert.ok(body.isSkinnedMesh, 'the attached template remains a skinned operative');
  assert.equal(body.geometry, asset.bodyGeometry, 'immutable authored geometry stays shared');
  assert.notEqual(body.material, asset.bodyMaterial, 'tintable uniform material is actor-owned');
  assert.notEqual(head.material, asset.skinMaterial, 'tintable skin material is actor-owned');
  assert.equal(body.material.color.getHex(), palette.uniform);
  assert.equal(head.material.color.getHex(), palette.skin);
  assert.equal(akGeometry.material, asset.weaponMaterial,
    'held weapons retain their authored shared material');

  assert.equal(actor.gunMeshes.AK.visible, true);
  assert.equal(actor.gunMeshes.Pistol.visible, false);
  actor.weaponId = 'usp';
  visuals.updateOperativeVisual(actor, 0);
  assert.equal(actor.gunMeshes.AK.visible, false);
  assert.equal(actor.gunMeshes.Pistol.visible, true);
  actor.weaponId = 'knife';
  visuals.updateOperativeVisual(actor, 0);
  assert.equal(Object.values(actor.gunMeshes).every((mesh) => !mesh.visible), true,
    'knife/utility does not leave an unrelated firearm in the hands');
});

test('a remote uses the other operative as a non-block fallback, then swaps in place', () => {
  const tAsset = makeCharacterAsset();
  const ctAsset = makeCharacterAsset();
  const visuals = makeVisuals({ ct: null, t: tAsset });
  const actor = makeActor({ team: 'ct' });
  const root = visuals.createOperativeVisual(actor, {
    uniform: 0x345678,
    skin: 0xb97856,
    sleeve: 0x26384a,
    dark: 0x101820,
  });

  assert.equal(actor.visualAssetTeam, 't');
  assert.ok(actor.rig, 'one available operative is preferable to an invisible or block player');
  const fallbackRig = actor.rig;

  visuals._charAssets.ct = ctAsset;
  visuals._refreshCharacterVisuals();
  assert.equal(actor.mesh, root, 'the network/spectator root stays stable during the swap');
  assert.equal(actor.visualAssetTeam, 'ct');
  assert.notEqual(actor.rig, fallbackRig);
  assert.equal(root.children.includes(fallbackRig), false);
});

test('external operative death is edge-triggered and respawn clears the corpse pose', () => {
  const visuals = makeVisuals();
  const actor = makeActor();
  const root = visuals.createOperativeVisual(actor, null);

  visuals.time = 12.5;
  assert.equal(visuals.setOperativeAlive(actor, false, { fallAxis: 'x', fallSign: -1 }), true);
  assert.equal(actor.alive, false);
  assert.equal(actor.deathTime, 12.5);
  assert.equal(actor.deathPlayed, false);
  assert.equal(actor.corpseSettled, false);
  assert.equal(actor.fallAxis, 'x');
  assert.equal(actor.fallSign, -1);

  visuals.time = 20;
  assert.equal(visuals.setOperativeAlive(actor, false, { fallAxis: 'z', fallSign: 1 }), false);
  assert.equal(actor.deathTime, 12.5, 'repeated dead packets do not restart the death');
  assert.equal(actor.fallAxis, 'x', 'repeated dead packets do not change the settled fall');

  root.rotation.x = -1.1;
  root.rotation.z = 0.7;
  actor.deathPlayed = true;
  actor.corpseSettled = true;
  assert.equal(visuals.setOperativeAlive(actor, true), true);
  assert.equal(actor.alive, true);
  assert.equal(actor.deathTime, -1);
  assert.equal(actor.deathPlayed, false);
  assert.equal(actor.corpseSettled, false);
  assert.equal(root.rotation.x, 0);
  assert.equal(root.rotation.z, 0);
});

test('multiplayer keeps remotes hidden until a pose arrives, updates through the adapter, and unregisters them', () => {
  const visuals = makeVisuals();
  const updated = [];
  const originalUpdate = visuals.updateOperativeVisual;
  visuals.updateOperativeVisual = function updateOperativeVisual(actor, dt) {
    updated.push({ actor, dt });
    return originalUpdate.call(this, actor, dt);
  };

  const scene = new THREE.Scene();
  const game = {
    scene,
    bots: visuals,
    config: CONFIG,
    state: { round: 1 },
    hud: { _sbDirty: false },
  };
  const entry = {
    id: 'remote-1',
    name: 'Second Window',
    team: 't',
    characterId: 'ranger',
    alive: true,
  };
  const multiplayer = Object.assign(Object.create(Multiplayer.prototype), {
    game,
    active: true,
    mode: 'humans',
    localId: 'local',
    roster: [entry],
    remotePlayers: [],
    _remoteById: new Map(),
  });

  const remote = multiplayer._createRemote(entry);
  multiplayer.remotePlayers.push(remote);
  multiplayer._remoteById.set(remote.networkId, remote);
  assert.equal(remote.hasNetworkPose, false);
  assert.equal(remote.mesh.visible, false);
  assert.equal(visuals._externalActors.has(remote), true);
  assert.equal(scene.children.includes(remote.mesh), true);

  multiplayer._updateRemoteBodies(1 / 60);
  assert.equal(remote.mesh.visible, false, 'roster membership alone cannot flash a body at world origin');

  multiplayer._applyPlayerState(remote.networkId, {
    pos: { x: 4, y: 0, z: -2 },
    yaw: 0.4,
    pitch: -0.1,
    alive: true,
    moveSpeed2D: 3.25,
    weaponId: 'glock',
  });
  multiplayer._updateRemoteBodies(0.1);
  assert.equal(remote.hasNetworkPose, true);
  assert.equal(remote.mesh.visible, true);
  assert.deepEqual(updated.at(-1), { actor: remote, dt: 0.1 });
  assert.equal(remote.moveSpeed, 3.25, 'the shared adapter receives replicated locomotion speed');

  multiplayer._removeRemote(remote.networkId);
  assert.equal(visuals._externalActors.has(remote), false);
  assert.equal(scene.children.includes(remote.mesh), false);
  assert.equal(multiplayer._remoteById.has(remote.networkId), false);
  assert.equal(multiplayer.remotePlayers.length, 0);
});
