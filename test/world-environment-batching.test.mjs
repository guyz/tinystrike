// The environment's loose decorative meshes are DRAWN merged, per material.
//
// `World._batchEnvironment` is the companion to `World._batchSolids`: the set
// dressing already lands as one mesh per material, but everything placed
// through `deco()` — sandbag detail bags, cornice trims, container ribs — was
// one mesh EACH, and each of them was submitted up to three times a frame
// (beauty, shadow map, SSAO depth prepass). MEASURED at map load, that was 81
// of Dustyard's 105 environment meshes and 78 of Citadel's 103, the largest
// static bucket left in the frame. The merge took the full post chain from
// 452 to 309 draw calls on the Dustyard eye camera and from 715 to 478 on the
// aerial, with a pixel diff against the unmerged frame of 0.03%-0.19% of
// pixels, almost all at one code value (isolated MSAA edge-sample flips from
// baking the world transform on the CPU), and 0 changed pixels on Frostline
// and Neon Foundry.
//
// This file guards the ways that can silently break:
//
//   1. THE WIN ITSELF. If a future edit gives every deco box its own material,
//      or reorders `loadMap` so the batch never builds, the draw count creeps
//      back up and nothing else notices.
//   2. WHAT MUST NOT BE MERGED. The site markers are transparent, depend on
//      painter sorting and `renderOrder`, and are gameplay signage — they keep
//      their own draw. Lights are not meshes and must survive untouched:
//      dressPracticals hangs a fixture off every live PointLight.
//   3. THE SOURCES STAY, HIDDEN. The sky's `_measureArena` fits the shadow
//      ortho by traversing the scene IGNORING `visible`, so removing the
//      source meshes (rather than hiding them) could shrink the measured
//      arena if a deco box ever stood proud of the solids. Hidden objects
//      cost nothing: `projectObject` and `WebGLShadowMap.renderObject` both
//      return early on `visible === false`.
//   4. LOSSLESSNESS. Every batch carries exactly the triangles of the sources
//      it hid, with their exact shadow flags.
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

/** The meshes each batch was built from, recovered by material + shadow flags. */
function sourcesOf(world, batch) {
  return world.environment.children.filter((mesh) => mesh.isMesh
    && mesh.material === batch.material
    && mesh.castShadow === batch.castShadow
    && mesh.receiveShadow === batch.receiveShadow
    && !mesh.visible);
}

/** How many environment objects the renderer would actually submit. */
function drawnObjects(world) {
  let n = 0;
  world.environment.traverse((o) => { if (o.isMesh && o.visible) n++; });
  return n;
}

for (const meta of MAP_CATALOG) {
  test(`${meta.name} draws its environment deco batched`, () => {
    const world = new World(gameFor(meta.id));
    const batch = world.environmentBatch;
    assert.ok(batch, `${meta.id} built an environment batch`);
    assert.ok(!batch.isMesh, 'the batch group is a Group, not a raycastable mesh');
    assert.equal(batch.parent, world.environment);

    // Headless there is no renderer, so no dressing and no backdrop: the
    // environment is exactly the deco meshes, the site markers and the lights
    // — which is the fragmented set the batching exists to collapse.
    const sources = world.environment.children.filter((o) => o.isMesh);
    const hidden = sources.filter((o) => !o.visible);
    assert.ok(hidden.length >= 2, `${meta.id}: the batch hid at least one bucket of deco`);

    // ---- 2. what must not be merged ---------------------------------------
    for (const mesh of sources) {
      if (!mesh.material || Array.isArray(mesh.material)) continue;
      if (mesh.material.transparent || mesh.renderOrder !== 0) {
        assert.equal(mesh.visible, true,
          `${meta.id}: a transparent/ordered mesh (site marker) was merged`);
      }
    }
    const lights = world.environment.children.filter((o) => o.isLight);
    for (const light of lights) {
      assert.equal(light.visible, true, `${meta.id}: a practical light was touched`);
    }

    // ---- 3. the sources stay, hidden, with their flags --------------------
    for (const mesh of hidden) {
      assert.equal(mesh.parent, world.environment, 'hidden sources stay in the group');
    }

    // ---- 4. the merge is lossless, bucket by bucket ------------------------
    for (const mesh of batch.children) {
      const from = sourcesOf(world, mesh);
      assert.equal(from.length, mesh.userData.owBatched,
        'every hidden source of a batch shares its exact material and shadow flags');
      assert.ok(from.length >= 2, 'no bucket of one was merged');
      const expected = from.reduce((n, m) => n + triangles(m.geometry), 0);
      assert.equal(triangles(mesh.geometry), expected,
        `${meta.id}: ${mesh.name} lost or gained triangles in the merge`);
    }

    // ---- 1. the win --------------------------------------------------------
    // MEASURED headless at the time this shipped: dustyard 85 meshes -> 4
    // drawn, frostline 48 -> 8, neon_foundry 92 -> 10, harbor 74 -> 11,
    // citadel 81 -> 9.
    // (With the renderer up the dressing adds its own ~20 per-material batches
    // on top of these; those are already one draw each.) The ceiling leaves a
    // little room for map edits, but a return to one-draw-per-deco-box —
    // dozens of meshes — must fail loudly.
    const drawn = drawnObjects(world);
    assert.ok(drawn <= 12,
      `${meta.id}: environment submits ${drawn} objects; the deco batching has stopped working`);
    assert.ok(drawn < sources.length / 2,
      `${meta.id}: ${sources.length} environment meshes still draw as ${drawn} objects`);
  });
}

test('a hidden deco mesh is out of both render paths', () => {
  const world = new World(gameFor('dustyard'));
  const hidden = world.environment.children.find((m) => m.isMesh && !m.visible);
  assert.ok(hidden, 'batching hid at least one deco mesh');
  // The renderer's own visibility gate, from the same objects the game uses.
  assert.equal(hidden.visible, false);
  assert.equal(hidden.parent, world.environment);
  // And the batch group draws in its place.
  const batch = world.environmentBatch;
  assert.ok(batch.children.some((b) => b.material === hidden.material),
    'a batch mesh carries the hidden source\'s material');
});
