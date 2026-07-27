import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { CONFIG } from '../src/shared/config.js';

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

const [{ default: World }, { dressMap }, { MAP_CATALOG }] = await Promise.all([
  import('../src/world/map.js'),
  import('../src/world/dressing.js'),
  import('../src/maps/catalog.js'),
]);

function gameFor(mapId) {
  return {
    selectedMapId: mapId,
    scene: new THREE.Scene(),
    config: CONFIG,
    state: { phase: 'menu' },
    debug: false,
    events: { on: () => () => {}, emit: () => {} },
  };
}

function dressedWorld(mapId, quality = 'high') {
  const world = new World(gameFor(mapId));

  // The headless constructor correctly skips dressing, but it has already
  // batched the authored solids. Restore those sources, dress, then batch once
  // in the same order as the live load path.
  if (world.solidBatch) world.solids.remove(world.solidBatch);
  for (const mesh of world.solids.children) if (mesh.isMesh) mesh.visible = true;
  world.solidBatch = null;

  const authored = world.colliders.length;
  const result = dressMap(world, { quality });
  world._batchSolids();
  world.solids.updateMatrixWorld(true);
  return { world, authored, result };
}

function proxiesOf(world) {
  return world.solids.children.filter(
    (mesh) => mesh.isMesh && mesh.userData.dressingCollider
  );
}

function routeClearance(world, x, z) {
  let best = Infinity;
  for (const [ai, bi] of world.waypoints.edges) {
    const a = world.waypoints.nodes[ai].pos;
    const b = world.waypoints.nodes[bi].pos;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    let t = len2 > 1e-6 ? ((x - a.x) * dx + (z - a.z) * dz) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t)));
  }
  return best;
}

function distanceToBoxXZ(x, z, box) {
  const dx = x < box.min.x ? box.min.x - x : x > box.max.x ? x - box.max.x : 0;
  const dz = z < box.min.z ? box.min.z - z : z > box.max.z ? z - box.max.z : 0;
  return Math.hypot(dx, dz);
}

function serialiseDressingColliders(world) {
  return proxiesOf(world).map((mesh) => {
    const index = world.solids.children.indexOf(mesh);
    const box = world.colliders[index];
    return [
      mesh.userData.dressingPropId,
      box.min.x, box.min.y, box.min.z,
      box.max.x, box.max.y, box.max.z,
      mesh.userData.surface,
    ];
  });
}

for (const meta of MAP_CATALOG) {
  test(`${meta.name} dressing colliders are deterministic, navigable, and raycastable`, () => {
    const first = dressedWorld(meta.id);
    const second = dressedWorld(meta.id);
    const lowQuality = dressedWorld(meta.id, 'low');
    const { world, authored, result } = first;
    const proxies = proxiesOf(world);
    const firstLayout = serialiseDressingColliders(world);

    assert.deepEqual(
      firstLayout,
      serialiseDressingColliders(second.world),
      `${meta.id}: building the same dressing twice changed its AABB list`
    );
    assert.deepEqual(
      firstLayout,
      serialiseDressingColliders(lowQuality.world),
      `${meta.id}: graphics quality changed the gameplay collider layout`
    );
    assert.equal(proxies.length, result.solids);
    assert.equal(world.colliders.length, authored + proxies.length);
    assert.ok(proxies.length >= 50, `${meta.id}: only ${proxies.length} dressing props became solid`);
    const proxyIds = new Set(proxies.map((proxy) => proxy.userData.dressingPropId));
    // Full composite coverage measures 155/167/214/221/157 across the five
    // deterministic maps. The earlier 150 estimate predated counters, roof
    // plant, stack unions and segmented structural supports. A 225 ceiling pins
    // the measured maximum with four-proxy headroom; movement/raycast
    // microbenchmarks remain in the low-single- and low-double-digit
    // microseconds respectively.
    assert.ok(proxies.length <= 225, `${meta.id}: ${proxies.length} dressing colliders exceeds the budget`);
    for (const low of ['pallet', 'tyre', 'tyre_small', 'bucket', 'cinder']) {
      assert.equal(proxyIds.has(low), false, `${meta.id}: sub-step ${low} became solid`);
    }
    if (meta.id !== 'citadel') {
      assert.equal(
        proxyIds.has('tyre_stack'),
        true,
        `${meta.id}: a completed above-step tyre stack stayed non-solid`
      );
      assert.equal(
        proxyIds.has('pallet_stack'),
        true,
        `${meta.id}: a loaded pallet stayed non-solid`
      );
      assert.equal(
        proxyIds.has('roof_duct'),
        true,
        `${meta.id}: composite roof plant remained bullet-through`
      );
    }
    assert.equal(proxyIds.has('facade_stack'), true, `${meta.id}: facade stacks were not unioned`);
    assert.equal(proxyIds.has('roof_stack'), true, `${meta.id}: roof stacks were not unioned`);
    if (['dustyard', 'neon_foundry', 'citadel'].includes(meta.id)) {
      assert.equal(proxyIds.has('shop_counter'), true, `${meta.id}: shop counters stayed non-solid`);
    }
    if (meta.id === 'harbor') {
      assert.equal(
        proxyIds.has('container_stilt'),
        true,
        'harbor: the floating container stand was omitted instead of relocated'
      );
      assert.equal(
        proxyIds.has('container_brace'),
        true,
        'harbor: visible diagonal supports stayed walk- and bullet-through'
      );
    }
    if (meta.id === 'dustyard') {
      assert.equal(
        proxyIds.has('slab_pedestal'),
        true,
        'dustyard: a nav-safe tall slab pedestal stayed non-solid'
      );
    }
    if (meta.id === 'citadel') {
      assert.equal(
        proxyIds.has('slab_pedestal'),
        false,
        'citadel: the fountain basin that crosses m3→cs0 should be omitted'
      );
    }
    assert.ok(
      proxies.some((proxy) =>
        !proxy.userData.dressingNavRequired &&
        /^(water_tank|roof_vent|crate|barrel|cabinet)/.test(
          proxy.userData.dressingPropId
        )
      ),
      `${meta.id}: substantial elevated props remained bullet-through`
    );
    assert.ok(
      proxies.some((proxy) => /^(crate|barrel|stall|handcart|brazier)/.test(
        proxy.userData.dressingPropId
      )),
      `${meta.id}: no representative crate, barrel, wagon, stall, or brazier became solid`
    );

    const batch = world.solidBatch;
    assert.equal(world.solids.children.at(-1), batch, 'the solid batch remains last');
    assert.equal(
      world.solids.children.filter((child) => child.isMesh).length,
      world.colliders.length,
      'every collider still has one index-locked raycast mesh'
    );
    let drawn = 0;
    world.solids.traverse((object) => {
      if (object.isMesh && object.visible) drawn++;
    });
    assert.ok(drawn <= 24, `${meta.id}: collision proxies raised solids to ${drawn} draw calls`);

    const raycaster = new THREE.Raycaster();
    const size = new THREE.Vector3();
    const centre = new THREE.Vector3();
    const hits = [];
    for (const proxy of proxies) {
      const index = world.solids.children.indexOf(proxy);
      const box = world.colliders[index];
      box.getSize(size);
      box.getCenter(centre);

      assert.equal(proxy.visible, false, 'a collision proxy never enters a render path');
      assert.ok(proxy.position.distanceTo(centre) < 1e-9);
      assert.ok(proxy.scale.distanceTo(size) < 1e-9);
      assert.match(proxy.userData.surface, /^(concrete|wood|metal|sand)$/);
      assert.ok(
        proxy.userData.dressingHeightAboveSupport > CONFIG.PLAYER.STEP_HEIGHT,
        `${meta.id}: ${proxy.userData.dressingPropId} is low enough to step over`
      );
      assert.ok(
        !['palm_trunk', 'palm_frond', 'shrub', 'weeds'].includes(
          proxy.userData.dressingPropId
        ),
        'vegetation never collides'
      );

      if (proxy.userData.dressingNavRequired) {
        const clear = routeClearance(world, centre.x, centre.z);
        assert.ok(
          clear + 1e-9 >= proxy.userData.dressingNavRadius,
          `${meta.id}: ${proxy.userData.dressingPropId} leaves ${clear.toFixed(3)} m ` +
            `for a required ${proxy.userData.dressingNavRadius.toFixed(3)} m`
        );

        for (const team of ['ct', 't']) {
          for (const spawn of world.spawns[team]) {
            assert.ok(
              distanceToBoxXZ(spawn.pos.x, spawn.pos.z, box) >=
                CONFIG.BOT.RADIUS + 0.2 - 1e-9,
              `${meta.id}: ${proxy.userData.dressingPropId} crowds ${team} spawn`
            );
          }
        }
        for (const site of world.bombSites) {
          const pad = site.box;
          const margin = CONFIG.BOT.RADIUS + 0.2;
          const overlaps =
            box.max.x > pad.min.x - margin &&
            box.min.x < pad.max.x + margin &&
            box.max.z > pad.min.z - margin &&
            box.min.z < pad.max.z + margin;
          assert.equal(overlaps, false, `${meta.id}: a dressing collider crowds site ${site.name}`);
        }
      } else {
        assert.equal(proxy.userData.dressingNavRadius, 0);
        assert.ok(
          box.min.y > 2.6,
          `${meta.id}: ${proxy.userData.dressingPropId} skipped nav clearance below a roof`
        );
      }

      hits.length = 0;
      raycaster.ray.origin.set(centre.x, box.max.y + 1, centre.z);
      raycaster.ray.direction.set(0, -1, 0);
      raycaster.near = 0;
      raycaster.far = size.y + 2;
      raycaster.intersectObject(proxy, false, hits);
      assert.ok(hits.length > 0, `${meta.id}: a bullet ray cannot hit ${proxy.userData.dressingPropId}`);
    }
  });
}
