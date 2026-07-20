import * as THREE from 'three';

function material(world, key) {
  return world.mats[key] || world.mats.wallN;
}

function addContainer(world, prop) {
  const { x, y = 1.3, z, w = 5.8, h = 2.6, d = 2.5 } = prop;
  const mat = material(world, prop.mat || 'metal');
  world.box(x, y, z, w, h, d, mat, 'metal');

  // Proud frame ribs make the silhouette read like corrugated cargo without
  // adding extra colliders or expensive custom geometry.
  const horizontal = w >= d;
  const span = horizontal ? w : d;
  const ribs = Math.max(3, Math.floor(span / 0.75));
  for (let i = 1; i < ribs; i++) {
    const offset = -span / 2 + (i / ribs) * span;
    world.deco(
      horizontal ? x + offset : x,
      y,
      horizontal ? z : z + offset,
      horizontal ? 0.07 : w + 0.04,
      h + 0.06,
      horizontal ? d + 0.04 : 0.07,
      world.mats.metalDark
    );
  }
  world.deco(x, y + h / 2 + 0.04, z, w + 0.08, 0.08, d + 0.08, world.mats.metalDark);
}

function addProp(world, prop) {
  switch (prop.kind) {
    case 'crate':
      world.crate(prop.x, prop.z, prop.size, prop.y || 0, material(world, prop.mat || 'crate'));
      break;
    case 'barrel':
      world.barrel(prop.x, prop.z, !!prop.red, prop.y || 0);
      break;
    case 'sandbags':
      world.sandbags(prop.x0, prop.x1, prop.z0, prop.z1, prop.h || 1, prop.y || 0);
      break;
    case 'column':
      world.column(prop.x, prop.z, prop.radius, prop.height, material(world, prop.mat), prop.y || 0);
      break;
    case 'container':
      addContainer(world, prop);
      break;
    default:
      throw new Error(`[world] unknown map prop kind: ${prop.kind}`);
  }
}

export function buildDefinitionGeometry(world, definition) {
  for (const [x0, x1, y0, y1, z0, z1, mat, surface] of definition.solids) {
    world.slab(x0, x1, y0, y1, z0, z1, material(world, mat), surface || 'concrete');
  }
  for (const item of definition.stairs || []) {
    const [x0, x1, z0, z1, steps, rise, dir, mat, yBase = 0] = item;
    world.stairs(x0, x1, z0, z1, steps, rise, dir, material(world, mat), yBase);
  }
  for (const item of definition.arches || []) {
    const [cx, cz, width, axis, thickness, yBot, yTop, mat] = item;
    world.arch(cx, cz, width, axis, thickness, yBot, yTop, material(world, mat));
  }
  for (const prop of definition.props || []) addProp(world, prop);
  for (const [x, y, z, w, h, d, mat, rotationY = 0] of definition.decor || []) {
    const mesh = world.deco(x, y, z, w, h, d, material(world, mat));
    mesh.rotation.y = rotationY;
  }
  for (const lightDef of definition.lights || []) {
    const light = new THREE.PointLight(
      lightDef.color,
      lightDef.intensity,
      lightDef.distance,
      lightDef.decay || 1.8
    );
    light.position.fromArray(lightDef.pos);
    world.environment.add(light);
  }

  for (const team of ['ct', 't']) {
    for (const spawn of definition.spawns[team]) {
      world.spawns[team].push({
        pos: new THREE.Vector3(spawn.x, spawn.y, spawn.z),
        yaw: spawn.yaw,
      });
    }
  }

  const markerColors = {
    A: definition.theme.markerA || '#ffad46',
    B: definition.theme.markerB || '#55a8d0',
  };
  world.bombSites = definition.bombSites.map((entry) => {
    const [x, y, z] = entry.center;
    const [x0, y0, z0, x1, y1, z1] = entry.box;
    world.siteMarker(entry.name, markerColors[entry.name], x, y, z, Math.min(x1 - x0, z1 - z0) * 0.62);
    return {
      name: entry.name,
      center: new THREE.Vector3(x, y, z),
      box: new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1)),
    };
  });
}

export function buildDefinitionNavigation(world, definition) {
  const nav = definition.navigation;
  const byKey = new Map();

  for (const [key, xyz] of Object.entries(nav.nodes)) {
    const node = { id: world.waypoints.nodes.length, key, pos: new THREE.Vector3(...xyz) };
    world.waypoints.nodes.push(node);
    byKey.set(key, node);
  }
  for (const [aKey, bKey] of nav.edges) {
    const a = byKey.get(aKey);
    const b = byKey.get(bKey);
    if (!a || !b) throw new Error(`[world] ${definition.id}: unknown nav edge ${aKey}-${bKey}`);
    world.waypoints.edges.push([a.id, b.id]);
  }

  const nodes = world.waypoints.nodes;
  const adjacency = nodes.map(() => []);
  for (const [a, b] of world.waypoints.edges) {
    const cost = nodes[a].pos.distanceTo(nodes[b].pos);
    adjacency[a].push({ id: b, cost });
    adjacency[b].push({ id: a, cost });
  }
  world._adjacency = adjacency;

  const route = (entry) => ({
    name: entry.name,
    points: entry.nodes.map((key) => byKey.get(key).pos.clone()),
  });
  const area = (entry) => ({
    name: entry.name,
    sector: entry.sector,
    anchor: byKey.get(entry.anchor).pos.clone(),
    points: entry.nodes.map((key) => byKey.get(key).pos.clone()),
  });
  world.botTactics = {
    attackRoutes: Object.fromEntries(
      Object.entries(nav.attackRoutes).map(([site, entries]) => [site, entries.map(route)])
    ),
    defenseAreas: nav.defenseAreas.map(area),
  };
}
