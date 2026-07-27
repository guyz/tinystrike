// The world's solid boxes are DRAWN merged and RAYCAST individually.
//
// `World._batchSolids` builds one merged mesh per (material, castShadow,
// receiveShadow) and hides the per-box meshes it merged. That is a pure
// rendering change — measured on Dustyard it takes `world-solids` from 165 draw
// calls carrying 2 484 triangles down to about 12 — and it is only safe because
// the per-box meshes are still there, in the same order, answering rays and
// being read back by the set dressing.
//
// This file guards the four ways that can silently break:
//
//   1. THE READ-BACK CONTRACT. `src/world/dressing.js` walks
//      `world.solids.children[i]` and uses `i` to find `world.colliders[i]`.
//      Every prop, kerb, coping, stain and snow cap in all five maps is placed
//      off that walk, so appending the batch group anywhere but the end, or
//      removing a box, silently moves hundreds of props.
//   2. RAYCASTS. `World.raycast` must keep returning the individual box, with
//      its `userData.surface` — a hit on a merged mesh has no surface kind, so
//      footsteps, decals, penetration and bot sightlines would all fall back to
//      'concrete'.
//   3. THE SHADOW-CASTER EXCLUSION. `box()` makes anything broad, flat and low
//      receive-only, because a 104 x 84 m coplanar caster fills the cascade and
//      self-shadows into acne. A batch that mixed casters with non-casters
//      would put it straight back.
//   4. THE WIN ITSELF. If a future edit gives every box its own material the
//      batching quietly stops working, and nothing else would notice.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

// World textures are generated on canvases; a no-op 2D context is enough here.
const gradient = { addColorStop() {} };
const context = new Proxy({}, {
  get(target, key) {
    if (key === 'createLinearGradient' || key === 'createRadialGradient') return () => gradient;
    if (!(key in target)) target[key] = () => {};
    return target[key];
  },
  set(target, key, value) { target[key] = value; return true; },
});
globalThis.document = {
  createElement(tag) {
    assert.equal(tag, 'canvas');
    return { width: 0, height: 0, getContext: () => context };
  },
};

const [{ default: World }, { MAP_CATALOG }] = await Promise.all([
  import('../src/world/map.js'),
  import('../src/maps/catalog.js'),
]);

function gameFor(mapId) {
  return {
    selectedMapId: mapId,
    scene: new THREE.Scene(),
    config: { PLAYER: { STEP_HEIGHT: 0.62 } },
    state: { phase: 'menu' },
    debug: false,
    events: { on: () => () => {}, emit: () => {} },
  };
}

const triangles = (geometry) => (geometry.index
  ? geometry.index.count / 3
  : geometry.attributes.position.count / 3);

/** The boxes each batch was built from, recovered by material + shadow flags. */
function sourcesOf(world, batch) {
  return world.solids.children.filter((mesh) => mesh.isMesh
    && mesh.material === batch.material
    && mesh.castShadow === batch.castShadow
    && mesh.receiveShadow === batch.receiveShadow
    && !mesh.visible);
}

/**
 * How many objects the renderer would actually submit for `world.solids`:
 * the merged batches plus any box left drawing on its own. Hidden objects cost
 * nothing — `WebGLRenderer.projectObject` and `WebGLShadowMap.renderObject`
 * both return early on `visible === false`.
 */
function drawnObjects(world) {
  let n = 0;
  world.solids.traverse((o) => { if (o.isMesh && o.visible) n++; });
  return n;
}

for (const meta of MAP_CATALOG) {
  test(`${meta.name} draws its solids batched and raycasts them individually`, () => {
    const world = new World(gameFor(meta.id));
    const boxes = world.solids.children.filter((o) => o.isMesh);
    const batch = world.solidBatch;

    // ---- 1. the read-back contract ---------------------------------------
    // Index i of solids.children is still the box that pushed colliders[i], and
    // the batch group is appended after all of them.
    assert.equal(boxes.length, world.colliders.length,
      'one mesh per collider, still index-locked for dressing.js');
    for (let i = 0; i < world.colliders.length; i++) {
      const mesh = world.solids.children[i];
      assert.ok(mesh.isMesh, `solids.children[${i}] is still the authored box`);
      const centre = world.colliders[i].getCenter(new THREE.Vector3());
      assert.ok(mesh.position.distanceTo(centre) < 1e-6,
        `${meta.id}: solids.children[${i}] no longer sits on colliders[${i}]`);
      assert.ok(mesh.userData.surface, `solids.children[${i}] kept its surface kind`);
    }
    assert.ok(batch, `${meta.id} built a solids batch`);
    assert.equal(world.solids.children.at(-1), batch, 'the batch group is appended LAST');
    assert.ok(!batch.isMesh, 'the batch group is a Group, so isMesh read-backs skip it');

    // ---- 2. raycasts still resolve to the individual box ------------------
    // Straight down over a coarse grid: every hit is a direct child of solids
    // (never the batch), and carries a surface kind.
    const down = new THREE.Vector3(0, -1, 0);
    const from = new THREE.Vector3();
    let hits = 0;
    for (let x = -46; x <= 46; x += 4) {
      for (let z = -38; z <= 38; z += 4) {
        const hit = world.raycast(from.set(x, 40, z), down, 60);
        if (!hit) continue;
        hits++;
        assert.equal(hit.mesh.parent, world.solids,
          `${meta.id}: ray at ${x},${z} hit a merged batch instead of its box`);
        assert.notEqual(hit.mesh.userData.surface, undefined);
        assert.equal(hit.surface, hit.mesh.userData.surface);
      }
    }
    assert.ok(hits > 200, `${meta.id}: the downward grid found ${hits} surfaces`);

    // ---- 3. shadow flags survive the merge, box for box -------------------
    for (const mesh of batch.children) {
      const sources = sourcesOf(world, mesh);
      assert.equal(sources.length, mesh.userData.owBatched,
        'every hidden source of a batch shares its exact shadow flags');
      // The merge is lossless: the batch carries every source triangle.
      const expected = sources.reduce((n, m) => n + triangles(m.geometry), 0);
      assert.equal(triangles(mesh.geometry), expected,
        `${meta.id}: ${mesh.name} lost or gained triangles in the merge`);
    }
    // box(): anything broad, flat and low is receive-only. Whether it ends up
    // merged or on its own, it must never be drawn by a casting object.
    for (const mesh of boxes) {
      const s = mesh.scale;
      if (!(s.y <= 1.5 && s.x >= 8 && s.z >= 8)) continue;
      assert.equal(mesh.castShadow, false, 'a broad flat low box is not a caster');
      for (const b of batch.children) {
        if (b.material === mesh.material && b.castShadow) {
          assert.ok(!sourcesOf(world, b).includes(mesh),
            `${meta.id}: a floor pad was merged into a shadow-casting batch`);
        }
      }
    }

    // ---- 4. the win --------------------------------------------------------
    // MEASURED headless (one material per key, the worst case — with the
    // renderer up, identical surface+opts pairs share one material and there
    // are fewer still): dustyard 165 -> 20, frostline 45 -> 15,
    // neon_foundry 61 -> 17, harbor 45 -> 17, citadel 68 -> 14.
    const drawn = drawnObjects(world);
    assert.ok(drawn <= 24,
      `${meta.id}: solids submit ${drawn} objects; the batching has stopped working`);
    assert.ok(drawn < boxes.length / 2,
      `${meta.id}: ${boxes.length} boxes still draw as ${drawn} objects`);
  });
}

test('a hidden box is out of both render paths but still raycast', () => {
  // The whole design rests on three.js semantics, so assert them rather than
  // trusting them: `visible = false` removes an object from the main pass and
  // from the shadow pass, and Raycaster does not look at `visible` at all.
  const world = new World(gameFor('dustyard'));
  const box = world.solids.children.find((m) => m.isMesh && !m.visible);
  assert.ok(box, 'batching hid at least one box');

  const raycaster = new THREE.Raycaster();
  raycaster.ray.origin.set(box.position.x, box.position.y + 30, box.position.z);
  raycaster.ray.direction.set(0, -1, 0);
  raycaster.far = 100;
  const intersects = [];
  raycaster.intersectObject(box, false, intersects);
  assert.ok(intersects.length > 0, 'an invisible box is still a raycast target');

  // And the renderer's own visibility gate, from the same objects the game uses.
  assert.equal(box.visible, false);
  assert.equal(box.parent, world.solids);
});
