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

const BOT_RADIUS = 0.35;
const BOT_HEIGHT = 1.83;
const BOT_SPEED = 4.6;
const GRAVITY = 20;
const STEP_DT = 1 / 60;
const EDGE_REACH = 0.3;
const FLOOR_TOLERANCE = 0.12;

// Exercise the same horizontal steering, gravity and World.resolveMovement
// combination used by Bots._moveBot. A center-line ray is not sufficient here:
// the production bot capsule must fit around corners and climb every authored
// elevation in both directions.
function traverseWaypointEdge(world, from, to, {
  lateralOffset = 0,
  lateralPush = 0,
  pushSeconds = 0,
} = {}) {
  const pos = from.clone();
  let velY = 0;
  const edgeX = to.x - from.x;
  const edgeZ = to.z - from.z;
  const horizontalLength = Math.hypot(edgeX, edgeZ);
  const sideX = horizontalLength > 1e-6 ? -edgeZ / horizontalLength : 0;
  const sideZ = horizontalLength > 1e-6 ? edgeX / horizontalLength : 0;
  pos.x += sideX * lateralOffset;
  pos.z += sideZ * lateralOffset;
  const maxSeconds = Math.max(4, horizontalLength / BOT_SPEED * 3 + 2);
  const maxSteps = Math.ceil(maxSeconds / STEP_DT);
  let bestDistance = horizontalLength;

  for (let step = 0; step < maxSteps; step++) {
    const dx = to.x - pos.x;
    const dz = to.z - pos.z;
    const distance = Math.hypot(dx, dz);
    bestDistance = Math.min(bestDistance, distance);
    if (distance <= EDGE_REACH && Math.abs(pos.y - to.y) <= FLOOR_TOLERANCE) {
      return { reached: true, pos, bestDistance };
    }

    let moveX = distance > 1e-6 ? dx / distance : 0;
    let moveZ = distance > 1e-6 ? dz / distance : 0;
    if (step * STEP_DT < pushSeconds && lateralPush !== 0) {
      moveX += sideX * lateralPush;
      moveZ += sideZ * lateralPush;
      const moveLength = Math.hypot(moveX, moveZ);
      if (moveLength > 1e-6) { moveX /= moveLength; moveZ /= moveLength; }
    }
    const stepDistance = Math.min(BOT_SPEED * STEP_DT, distance);
    velY -= GRAVITY * STEP_DT;
    const delta = new THREE.Vector3(moveX * stepDistance, velY * STEP_DT, moveZ * stepDistance);
    const result = world.resolveMovement(pos, delta, BOT_RADIUS, BOT_HEIGHT);
    pos.copy(result.pos);
    if (result.onGround) velY = Math.max(velY, 0);
    if (result.hitCeiling) velY = Math.min(velY, 0);
  }

  return { reached: false, pos, bestDistance };
}

function waypoint(world, key) {
  const node = world.waypoints.nodes.find((entry) => entry.key === key);
  assert.ok(node, `waypoint ${key} exists on ${world.mapId}`);
  return node.pos;
}

function edgeLabel(nodes, a, b) {
  const left = nodes[a].key ?? nodes[a].id;
  const right = nodes[b].key ?? nodes[b].id;
  return `${left}-${right}`;
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
    const blockedNodes = world.waypoints.nodes
      .filter((node) => {
        if (world._clearAt(node.pos.x, node.pos.y, node.pos.z, BOT_RADIUS, BOT_HEIGHT)) return false;
        // Several ground materials are represented by a 6 cm collision pad
        // while their authored nav points remain at logical y=0. Allow the
        // resolver's normal support offset, but no horizontal/standing overlap.
        return !world._clearAt(node.pos.x, node.pos.y + 0.08, node.pos.z, BOT_RADIUS, BOT_HEIGHT);
      })
      .map((node) => node.key ?? node.id);
    assert.deepEqual(
      blockedNodes,
      [],
      `every nav node fits the production bot capsule: ${blockedNodes.join(', ')}`
    );
    const blockedEdges = [];
    for (const [a, b] of world.waypoints.edges) {
      const label = edgeLabel(world.waypoints.nodes, a, b);
      for (const [fromId, toId] of [[a, b], [b, a]]) {
        const from = world.waypoints.nodes[fromId].pos;
        const to = world.waypoints.nodes[toId].pos;
        const traversal = traverseWaypointEdge(world, from, to);
        if (!traversal.reached) blockedEdges.push(
          `${label} ${fromId === a ? 'forward' : 'backward'} stopped at ` +
            `(${traversal.pos.x.toFixed(2)}, ${traversal.pos.y.toFixed(2)}, ` +
            `${traversal.pos.z.toFixed(2)}), best distance ${traversal.bestDistance.toFixed(2)}`
        );
      }
    }
    assert.deepEqual(
      blockedEdges,
      [],
      `every authored edge is traversable in both directions by the production bot capsule:\n${blockedEdges.join('\n')}`
    );
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

test('tight ramp and spawn connectors tolerate teammate-separation offsets', () => {
  const cases = [
    { mapId: 'dustyard', keys: ['Q5', 'Q5_RAMP_SOUTH', 'Q5_RAMP_ENTRY', 'RF'] },
    { mapId: 'dustyard', keys: ['S1', 'S1_STAIR_WEST', 'S1_STAIR_ENTRY', 'S2'] },
    { mapId: 'harbor', keys: ['ct_bypass', 'ct_gate_n', 'm5'] },
  ];

  for (const { mapId, keys } of cases) {
    const world = new World(gameFor(mapId));
    const points = keys.map((key) => waypoint(world, key));
    for (let i = 1; i < points.length; i++) {
      for (const [from, to, direction] of [
        [points[i - 1], points[i], 'forward'],
        [points[i], points[i - 1], 'backward'],
      ]) {
        for (const sign of [-1, 1]) {
          const traversal = traverseWaypointEdge(world, from, to, {
            lateralOffset: sign * 0.28,
            lateralPush: sign * 0.28,
            pushSeconds: 0.7,
          });
          assert.equal(
            traversal.reached,
            true,
            `${mapId} ${keys[i - 1]}-${keys[i]} ${direction} clears a ` +
              `${sign < 0 ? 'left' : 'right'} group offset; stopped at ` +
              `(${traversal.pos.x.toFixed(2)}, ${traversal.pos.y.toFixed(2)}, ` +
              `${traversal.pos.z.toFixed(2)})`
          );
        }
      }
    }
  }
});

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
