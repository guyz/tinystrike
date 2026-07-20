import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

// World textures are generated on canvases. A no-op 2D context is enough for
// deterministic structural/runtime tests and keeps Node free of browser deps.
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

const [{ default: World }, { MAP_CATALOG, DEFAULT_MAP_ID }, { WORLD_MAP_DEFINITIONS }] = await Promise.all([
  import('../src/world/map.js'),
  import('../src/maps/catalog.js'),
  import('../src/world/maps/registry.js'),
]);

function gameFor(mapId) {
  const emitted = [];
  const handlers = new Map();
  return {
    selectedMapId: mapId,
    scene: new THREE.Scene(),
    config: { PLAYER: { STEP_HEIGHT: 0.62 } },
    state: { phase: 'menu' },
    debug: false,
    emitted,
    events: {
      on(type, fn) { handlers.set(type, fn); return () => handlers.delete(type); },
      emit(type, payload) { emitted.push([type, payload]); },
    },
  };
}

function connectedCount(world) {
  const seen = new Set([0]);
  const pending = [0];
  while (pending.length) {
    const current = pending.pop();
    for (const edge of world._adjacency[current]) {
      if (!seen.has(edge.id)) { seen.add(edge.id); pending.push(edge.id); }
    }
  }
  return seen.size;
}

test('catalog exposes five stable, unique map contracts', () => {
  assert.equal(DEFAULT_MAP_ID, 'dustyard');
  assert.deepEqual(MAP_CATALOG.map(({ id }) => id), [
    'dustyard', 'frostline', 'neon_foundry', 'harbor', 'citadel',
  ]);
  assert.equal(new Set(MAP_CATALOG.map(({ name }) => name)).size, 5);
  assert.deepEqual(Object.keys(WORLD_MAP_DEFINITIONS).sort(), [
    'citadel', 'frostline', 'harbor', 'neon_foundry',
  ]);
  assert.equal(new Set(Object.values(WORLD_MAP_DEFINITIONS).map((def) => def.theme.key)).size, 4);
});

for (const meta of MAP_CATALOG) {
  test(`${meta.name} has complete gameplay structure`, () => {
    const game = gameFor(meta.id);
    const world = new World(game);

    assert.equal(world.mapId, meta.id);
    assert.equal(world.mapMeta.name, meta.name);
    assert.ok(world.colliders.length >= 25, 'enough authored collision geometry');
    assert.ok(world.solids.children.length >= 25, 'raycast meshes mirror collision layout');
    assert.ok(world.spawns.ct.length >= 6);
    assert.ok(world.spawns.t.length >= 6);
    assert.deepEqual(world.bombSites.map(({ name }) => name).sort(), ['A', 'B']);
    assert.ok(world.waypoints.nodes.length >= 30);
    assert.ok(world.waypoints.edges.length >= world.waypoints.nodes.length - 1);
    assert.equal(connectedCount(world), world.waypoints.nodes.length, 'navigation graph is connected');
    if (meta.id !== 'dustyard') {
      for (const node of world.waypoints.nodes) {
        assert.ok(
          world._clearAt(node.pos.x, node.pos.y, node.pos.z, 0.18, 1.65),
          `nav node ${node.key ?? node.id} is clear`
        );
      }
    }

    for (const team of ['ct', 't']) {
      for (const spawn of world.spawns[team]) {
        assert.ok(world._clearAt(spawn.pos.x, spawn.pos.y, spawn.pos.z, 0.34, 1.8), `${team} spawn is clear`);
        for (const site of world.bombSites) {
          const path = world.findPath(spawn.pos, site.center);
          assert.ok(path.length >= 2, `${team} can path to ${site.name}`);
          assert.ok(path.at(-1).distanceTo(site.center) < 0.001);
        }
      }
    }

    for (const siteName of ['A', 'B']) {
      const routes = world.botTactics.attackRoutes[siteName];
      assert.ok(routes.length >= 2, `${siteName} has multiple attack routes`);
      assert.ok(routes.every((route) => route.points.length >= 4));
    }
    assert.deepEqual(
      new Set(world.botTactics.defenseAreas.map(({ sector }) => sector)),
      new Set(['A', 'B', 'mid'])
    );

    const downHit = world.raycast(new THREE.Vector3(0, 20, 30), new THREE.Vector3(0, -1, 0), 30);
    assert.ok(downHit, 'world geometry participates in raycasts');
    assert.ok(game.emitted.some(([type, payload]) => type === 'map:changed' && payload.mapId === meta.id));

    if (meta.id !== 'dustyard') {
      const warnings = [];
      const originalWarn = console.warn;
      console.warn = (...args) => warnings.push(args.join(' '));
      try { world._validateNav(); } finally { console.warn = originalWarn; }
      assert.equal(
        warnings.filter((message) => message.includes(' blocked ') || message.includes(' inside ')).length,
        0,
        `all authored navigation edges are unobstructed:\n${warnings.join('\n')}`
      );
    }
  });
}

test('runtime switching replaces scene groups without leaking old map roots', () => {
  const game = gameFor('dustyard');
  const world = new World(game);
  const oldSolids = world.solids;
  const oldEnvironment = world.environment;

  assert.equal(world.loadMap('harbor'), true);
  assert.equal(world.mapId, 'harbor');
  assert.equal(game.scene.children.includes(oldSolids), false);
  assert.equal(game.scene.children.includes(oldEnvironment), false);
  assert.equal(game.scene.children.includes(world.solids), true);
  assert.equal(game.scene.children.includes(world.environment), true);
  assert.equal(world.loadMap('harbor'), false, 'same-map reload is a no-op');
  assert.equal(world.loadMap('not-a-map'), true, 'unknown IDs normalize to default');
  assert.equal(world.mapId, 'dustyard');
});
