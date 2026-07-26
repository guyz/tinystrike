// The operative body merge (src/ai/bots.js _optimizeCharacterAsset).
//
// This exists because the merge is a rendering optimisation that has to be
// invisible: nine bots used to spend 80 draw calls on their bodies (CT 10 each,
// T 8), which is 240 of the frame's ~590 main-pass calls once the shadow map is
// counted, for 5828 and 4594 triangles respectively. Collapsing the pack's
// per-material sub-meshes to four SkinnedMeshes is only correct if the animation
// and the albedo come out bit-identical, so that is what these tests assert
// against the shipped GLBs rather than against a stand-in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import Bots from '../src/ai/bots.js';
import { CONFIG } from '../src/shared/config.js';

const TEAMS = ['ct', 't'];
const GUN_SEATS = ['AK', 'SMG', 'Sniper', 'Pistol'];

async function loadSoldier(team) {
  const bytes = await readFile(new URL(`../assets/models/soldier_${team}.glb`, import.meta.url));
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(arrayBuffer, '', resolve, reject);
  });
}

/** A Bots instance with just enough of the game for the asset pipeline. */
function makeVisuals() {
  return Object.assign(Object.create(Bots.prototype), {
    // a truthy material library is the signal that procedural weapons exist, so
    // the authored held-weapon meshes can be stripped
    game: { materials: {} },
    _charAssets: { ct: null, t: null },
    _externalActors: new Set(),
    all: [],
    _cfg: CONFIG.BOT,
    time: 0,
  });
}

function renderMeshes(root) {
  const out = [];
  root.traverse((o) => { if (o.isMesh) out.push(o); });
  return out;
}

/**
 * World-space positions of every posed body vertex, held-weapon subtrees left
 * out so a stripped asset and an authored one are comparable.
 */
function posedVertices(root) {
  const points = [];
  const v = new THREE.Vector3();
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (let n = o; n && n !== root; n = n.parent) if (GUN_SEATS.includes(n.name)) return;
    const count = o.geometry.attributes.position.count;
    for (let i = 0; i < count; i++) {
      if (o.isSkinnedMesh) o.getVertexPosition(i, v);
      else v.fromBufferAttribute(o.geometry.attributes.position, i).applyMatrix4(o.matrixWorld);
      points.push([v.x, v.y, v.z]);
    }
  });
  return points;
}

function poseTo(root, clips, clipName, fraction) {
  const clip = clips.find((c) => c.name.split('|').pop() === clipName);
  assert.ok(clip, `${clipName} clip is required`);
  const mixer = new THREE.AnimationMixer(root);
  const action = mixer.clipAction(clip);
  action.reset();
  action.play();
  action.setEffectiveWeight(1);
  action.time = clip.duration * fraction;
  mixer.update(1e-6);
  root.updateMatrixWorld(true);
  return mixer;
}

for (const team of TEAMS) {
  test(`the ${team} operative merges to four skinned draw calls without losing a triangle`, async () => {
    const authored = await loadSoldier(team);
    const optimized = await loadSoldier(team);
    const visuals = makeVisuals();

    const before = renderMeshes(authored.scene);
    const beforeBody = before.filter((m) => {
      for (let n = m; n; n = n.parent) if (GUN_SEATS.includes(n.name)) return false;
      return true;
    });
    const triangles = (list) => list.reduce(
      (sum, m) => sum + (m.geometry.index ? m.geometry.index.count / 3 : m.geometry.attributes.position.count / 3),
      0
    );
    const beforeTris = triangles(beforeBody);

    assert.equal(visuals._optimizeCharacterAsset(team, optimized.scene), true,
      'the shipped asset must take the merge path, not the bail-out');

    const after = renderMeshes(optimized.scene);
    // Four groups: (skin, skin), (uniform, cloth), (sleeve, cloth), (dark, hard).
    // Anything more means the merge key drifted; anything fewer means two
    // differently tinted or differently surfaced groups got folded together.
    assert.equal(after.length, 4, `${team} body should be four draw calls, got ${after.length}`);
    assert.equal(after.every((m) => m.isSkinnedMesh), true, 'every merged body mesh stays skinned');
    assert.equal(triangles(after), beforeTris,
      'the merge must neither drop nor duplicate a triangle');
    assert.ok(beforeBody.length > after.length,
      `the merge has to actually reduce the count (was ${beforeBody.length})`);

    // One skeleton for the whole body: the renderer walks 43 bones and uploads a
    // bone texture per distinct Skeleton object per frame.
    const skeletons = new Set(after.map((m) => m.skeleton));
    assert.equal(skeletons.size, 1, 'all four merged meshes share one skeleton');
    for (const mesh of after) {
      assert.ok(mesh.bindMatrix.equals(new THREE.Matrix4()),
        'merged meshes bind with an identity bindMatrix (vertices are pre-baked)');
    }

    // The four held-weapon seats keep their authored transform but lose their
    // ~9k triangles of never-shown geometry.
    for (const name of GUN_SEATS) {
      const authoredSeat = authored.scene.getObjectByName(name);
      const seat = optimized.scene.getObjectByName(name);
      assert.ok(seat, `${name} seat must survive: _attachHeldWeapon reuses its transform`);
      assert.equal(renderMeshes(seat).length, 0, `${name} authored meshes are dead weight`);
      assert.ok(seat.position.distanceTo(authoredSeat.position) < 1e-9,
        `${name} seat position must be untouched`);
      // Component-wise, not Quaternion.angleTo: the pack's SMG rotation ships at
      // |q|^2 = 0.99999997, and angleTo's acos(2*dot^2 - 1) turns that rounding
      // into a phantom 0.0005 rad even when comparing a quaternion to itself.
      for (const axis of ['x', 'y', 'z', 'w']) {
        assert.ok(Math.abs(seat.quaternion[axis] - authoredSeat.quaternion[axis]) < 1e-9,
          `${name} seat orientation must be untouched`);
      }
      let bone = seat.parent;
      while (bone && !bone.isBone) bone = bone.parent;
      assert.equal(bone && bone.name, 'Index1R', `${name} must still hang off the hand bone`);
    }
  });

  test(`the ${team} merged body poses identically to the authored sub-meshes`, async () => {
    const authored = await loadSoldier(team);
    const optimized = await loadSoldier(team);
    assert.equal(makeVisuals()._optimizeCharacterAsset(team, optimized.scene), true);

    // Death and Duck are the extremes: Death lays the body flat off the root and
    // Duck drives the legs hardest, so both are where a bad rigid-prop bake or a
    // wrong bind matrix would show first.
    for (const [clip, fraction] of [['Idle', 0], ['Walk', 0.38], ['Run_Gun', 0.5], ['Duck', 0.4], ['Death', 0.9]]) {
      poseTo(authored.scene, authored.animations, clip, fraction);
      poseTo(optimized.scene, optimized.animations, clip, fraction);

      const a = posedVertices(authored.scene);
      const b = posedVertices(optimized.scene);
      assert.equal(b.length, a.length, `${clip} vertex count must match`);

      // Every authored vertex must land on a merged vertex. 0.1 mm is two orders
      // of magnitude below the 1 cm features on this model.
      const bucket = new Map();
      const key = (p) => `${Math.round(p[0] * 1e4)}|${Math.round(p[1] * 1e4)}|${Math.round(p[2] * 1e4)}`;
      for (const p of b) {
        const k = key(p);
        if (!bucket.has(k)) bucket.set(k, []);
        bucket.get(k).push(p);
      }
      let worst = 0;
      for (const p of a) {
        if (bucket.has(key(p))) continue;
        // rounding can straddle a bucket edge; quantify the real distance
        let best = Infinity;
        for (const q of b) {
          const d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
          if (d < best) best = d;
        }
        worst = Math.max(worst, Math.sqrt(best));
      }
      assert.ok(worst < 1e-4, `${clip} pose drifted by ${worst} m; the merge is not animation-exact`);
    }

    // The bone the procedural weapon is parented to must survive the merge.
    const hand = optimized.scene.getObjectByName('Index1R');
    assert.ok(hand && hand.isBone, 'Index1R must survive: the held weapon hangs off it');
  });

  test(`the ${team} merged body keeps the authored albedo per vertex and yields it to a palette`, async () => {
    const authored = await loadSoldier(team);
    const optimized = await loadSoldier(team);
    const visuals = makeVisuals();

    // Every authored colour, and how many vertices wear it.
    const wanted = new Map();
    for (const mesh of renderMeshes(authored.scene)) {
      for (let n = mesh; n; n = n.parent) if (GUN_SEATS.includes(n.name)) { mesh.__gun = true; break; }
      if (mesh.__gun) continue;
      const c = mesh.material.color;
      const k = `${c.r.toFixed(6)},${c.g.toFixed(6)},${c.b.toFixed(6)}`;
      wanted.set(k, (wanted.get(k) || 0) + mesh.geometry.attributes.position.count);
    }

    assert.equal(visuals._optimizeCharacterAsset(team, optimized.scene), true);

    const got = new Map();
    for (const mesh of renderMeshes(optimized.scene)) {
      assert.equal(mesh.material.vertexColors, true, 'untinted operatives read albedo from vertices');
      assert.equal(mesh.material.color.getHex(), 0xffffff,
        'a white base is what makes diffuse * vColor reproduce the authored albedo exactly');
      assert.equal(mesh.material.userData.tsBakedAlbedo, true,
        'the tint pass needs this flag to know it must switch vertexColors off');
      const attr = mesh.geometry.attributes.color;
      assert.ok(attr, 'merged geometry carries a colour attribute');
      assert.equal(attr.itemSize, 3);
      for (let i = 0; i < attr.count; i++) {
        const k = `${attr.getX(i).toFixed(6)},${attr.getY(i).toFixed(6)},${attr.getZ(i).toFixed(6)}`;
        got.set(k, (got.get(k) || 0) + 1);
      }
    }
    assert.deepEqual([...got.entries()].sort(), [...wanted.entries()].sort(),
      'every authored colour must survive on exactly the same vertices');

    // Handing the same asset a palette must produce flat colours, as it did
    // before the merge — the baked attribute has to stop multiplying in.
    visuals._charAssets[team] = { scene: optimized.scene, clips: optimized.animations, sharedSkeleton: true };
    const actor = {
      // 'knife' has no procedural model, so _attachHeldWeapon bails before the
      // weapon registry (which needs a real GPU material library) is touched.
      team, alive: true, weaponId: 'knife', yaw: 0, pitch: 0, moveSpeed2D: 0, crouching: false,
      pos: new THREE.Vector3(), position: new THREE.Vector3(),
    };
    const palette = { uniform: 0x3366cc, skin: 0xb97856, sleeve: 0x224466, dark: 0x101820 };
    visuals.createOperativeVisual(actor, palette);

    const tinted = renderMeshes(actor.rig);
    assert.equal(tinted.length, 4, 'a tinted operative is still four draw calls');
    const byName = new Map(tinted.map((m) => [String(m.material.name).toLowerCase(), m.material]));
    const expected = {
      skin: [palette.skin, 0.68, false],
      pants: [palette.sleeve, 0.94, true],
      grey: [palette.sleeve, 0.94, true],
      character_main: [palette.uniform, 0.94, true],
      enemy_red: [palette.uniform, 0.94, true],
      darkgrey: [palette.dark, 0.52, true],
      black: [palette.dark, 0.52, true],
    };
    for (const [name, material] of byName) {
      const want = expected[name];
      assert.ok(want, `unexpected merged material name ${name}`);
      assert.equal(material.vertexColors, false,
        `${name}: a flat palette colour must not be multiplied by the baked albedo`);
      assert.equal(material.color.getHex(), want[0], `${name} takes its palette slot`);
      assert.equal(material.roughness, want[1], `${name} keeps its surface class`);
      assert.equal(actor.ownedVisualMaterials.has(material), true,
        `${name} must be actor-owned: a merged material is shared by the whole team`);
    }
    // Four distinct palette slots have to remain independently addressable.
    assert.equal(new Set(tinted.map((m) => m.material.color.getHex())).size, 4,
      'skin, uniform, sleeve and dark stay four separate colours after the merge');
  });
}

test('a rig swap re-seats the held weapon instead of orphaning it', async () => {
  const ct = await loadSoldier('ct');
  const t = await loadSoldier('t');
  const visuals = makeVisuals();
  visuals._optimizeCharacterAsset('ct', ct.scene);
  visuals._optimizeCharacterAsset('t', t.scene);

  // Reproduce the load race: the T asset lands first, so a CT bot is built on
  // the T fallback rig and only later swaps to its own.
  visuals._charAssets.t = { scene: t.scene, clips: t.animations, sharedSkeleton: true };
  const actor = {
    team: 'ct', alive: true, weaponId: 'knife', yaw: 0, pitch: 0, moveSpeed2D: 0, crouching: false,
    pos: new THREE.Vector3(), position: new THREE.Vector3(),
  };
  visuals.createOperativeVisual(actor, null);
  assert.equal(actor.visualAssetTeam, 't', 'the fallback rig is the other team asset');

  // Stand in for a procedural weapon: what matters is that a rig swap must not
  // leave heldWeapon/heldWeaponId pointing at the discarded rig, because
  // _attachHeldWeapon's "already holding this" early-out would then never fire
  // again and the bot would carry nothing for the rest of the match.
  const seat = actor.gunMeshes.Pistol;
  const weapon = new THREE.Group();
  weapon.name = 'held:usp';
  seat.parent.add(weapon);
  actor.heldWeapon = weapon;
  actor.heldWeaponId = 'usp';

  visuals._charAssets.ct = { scene: ct.scene, clips: ct.animations, sharedSkeleton: true };
  visuals._refreshCharacterVisuals();

  assert.equal(actor.visualAssetTeam, 'ct', 'the bot swaps onto its own team asset');
  assert.equal(actor.heldWeapon, null, 'the stale weapon is released with the old rig');
  assert.equal(actor.heldWeaponId, null, 'so the next _applyGunLook re-seats a real one');
  assert.equal(weapon.parent, null, 'and it is out of the scene graph, not leaked into it');
});

test('merged bodies carry an over-sized culling sphere so they can be culled without popping', async () => {
  const gltf = await loadSoldier('ct');
  assert.equal(makeVisuals()._optimizeCharacterAsset('ct', gltf.scene), true);

  const meshes = renderMeshes(gltf.scene);
  const height = 2.2699; // CHAR_MODELS.ct.bodyHeight, feet at y = 0
  for (const mesh of meshes) {
    assert.equal(mesh.frustumCulled, true,
      'an explicit sphere is what makes culling safe; without it bots must stay unculled');
    assert.ok(mesh.boundingSphere,
      'three would otherwise measure whatever pose it first sees and never update');
    // Death lays the body about one body-height from the root, so the sphere has
    // to clear that with room to spare or a corpse pops at the screen edge.
    assert.ok(mesh.boundingSphere.radius > height * 1.4,
      `culling sphere radius ${mesh.boundingSphere.radius} is too tight for the Death pose`);
    assert.ok(Math.abs(mesh.boundingSphere.center.y - height * 0.5) < height * 0.15,
      'sphere should be centred on the body, not on the feet');
  }

  // Any pose, any clip: every posed vertex has to stay inside the sphere.
  const sphere = meshes[0].boundingSphere;
  const v = new THREE.Vector3();
  for (const [clip, fraction] of [['Death', 1], ['Duck', 0.5], ['Jump', 0.5], ['Run_Gun', 0.5], ['HitReact', 0.6]]) {
    poseTo(gltf.scene, gltf.animations, clip, fraction);
    for (const mesh of meshes) {
      const count = mesh.geometry.attributes.position.count;
      for (let i = 0; i < count; i++) {
        mesh.getVertexPosition(i, v);
        assert.ok(sphere.containsPoint(v),
          `${clip} puts a vertex outside the culling sphere at ${v.toArray()}`);
      }
    }
  }
});
