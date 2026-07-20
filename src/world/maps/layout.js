// Pure helpers shared by authored map definitions. Keeping map data free of
// Three.js makes it possible to validate every arena in Node without a DOM or
// WebGL context.

export function chain(...ids) {
  const edges = [];
  for (let i = 1; i < ids.length; i++) edges.push([ids[i - 1], ids[i]]);
  return edges;
}

export function perimeter({ x0, x1, z0, z1 }, height = 8, thickness = 1.5, mat = 'wallN') {
  const half = thickness / 2;
  return [
    [x0 - half, x1 + half, 0, height, z0 - half, z0 + half, mat],
    [x0 - half, x1 + half, 0, height, z1 - half, z1 + half, mat],
    [x0 - half, x0 + half, 0, height, z0, z1, mat],
    [x1 - half, x1 + half, 0, height, z0, z1, mat],
  ];
}

export function spawnRow(points, yaw, y = 0.06) {
  return points.map(([x, z]) => ({ x, y, z, yaw }));
}

export function site(name, center, size = [10, 3, 10]) {
  const [x, y, z] = center;
  const [w, h, d] = size;
  return {
    name,
    center,
    box: [x - w / 2, y - 0.2, z - d / 2, x + w / 2, y + h, z + d / 2],
  };
}

export function definitionFingerprint(definition) {
  const nav = definition.navigation;
  return JSON.stringify({
    bounds: definition.bounds,
    sites: definition.bombSites.map((entry) => entry.center),
    nodes: Object.values(nav.nodes),
    solids: definition.solids.length,
    theme: definition.theme,
  });
}
