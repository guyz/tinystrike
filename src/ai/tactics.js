// Pure, deterministic helpers for spreading bot assignments and destinations.
// Keeping these free of Three.js/game state makes the tactical choices easy to
// exercise in tests without constructing the renderer or loading character GLBs.

function positiveMod(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

function gcd(a, b) {
  while (b) {
    const next = a % b;
    a = b;
    b = next;
  }
  return Math.abs(a);
}

// Stable 0..1 noise used only to break otherwise-identical scoring ties.
function hashUnit(value) {
  let x = value | 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  x ^= x >>> 16;
  return (x >>> 0) / 0x100000000;
}

/**
 * Distribute attackers across every available route before reusing one.
 * The round seed rotates both the first route and traversal order, so rounds
 * do not open identically while a replay with the same seed stays reproducible.
 */
export function balancedRouteIndices(memberCount, routeCount, seed = 0) {
  if (memberCount <= 0 || routeCount <= 0) return [];
  const offset = positiveMod(seed, routeCount);
  let stride = routeCount > 2 ? 1 + positiveMod(seed * 2 + 1, routeCount - 1) : 1;
  while (gcd(stride, routeCount) !== 1) stride++;

  const out = new Array(memberCount);
  for (let i = 0; i < memberCount; i++) {
    out[i] = positiveMod(offset + i * stride, routeCount);
  }
  return out;
}

/**
 * Assign defenders by sector first (A/B/mid), then rotate between posts inside
 * that sector on subsequent rounds. `areas` only needs a `sector` property.
 */
export function balancedDefenseIndices(memberCount, areas, seed = 0) {
  if (memberCount <= 0 || !areas || areas.length === 0) return [];

  const sectors = [];
  const groups = new Map();
  for (let i = 0; i < areas.length; i++) {
    const sector = areas[i].sector || 'map';
    if (!groups.has(sector)) {
      groups.set(sector, []);
      sectors.push(sector);
    }
    groups.get(sector).push(i);
  }

  const out = new Array(memberCount);
  const sectorOffset = positiveMod(seed, sectors.length);
  for (let i = 0; i < memberCount; i++) {
    const sector = sectors[(sectorOffset + i) % sectors.length];
    const choices = groups.get(sector);
    const cycle = Math.floor(i / sectors.length);
    out[i] = choices[positiveMod(seed + cycle, choices.length)];
  }
  return out;
}

function distanceXZ(a, b) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

/**
 * Choose a useful point while avoiding a bot's recent destinations and spots
 * already occupied/reserved by teammates. All inputs are plain {x,z} values.
 */
export function selectDiversePointIndex(points, {
  origin,
  occupied = [],
  recent = [],
  salt = 0,
  minTravel = 3,
} = {}) {
  if (!points || points.length === 0) return -1;

  let best = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    const travel = origin ? distanceXZ(point, origin) : minTravel;

    // Prefer a meaningful rotation over choosing the node under our feet.
    let score = Math.min(travel, 14) * 0.12;
    if (travel < minTravel) score -= (minTravel - travel) * 1.4;

    // A teammate's current position or reserved goal makes this point less
    // valuable. The effect fades smoothly instead of hard-rejecting choke nodes.
    for (let j = 0; j < occupied.length; j++) {
      const d = distanceXZ(point, occupied[j]);
      if (d < 7) score -= (7 - d) * 0.62;
    }

    // Strong short-term memory prevents the conspicuous A-B-A patrol loop.
    for (let j = 0; j < recent.length; j++) {
      const d = distanceXZ(point, recent[j]);
      if (d < 3.5) score -= (3.5 - d) * (2.8 / (j + 1));
    }

    score += hashUnit((salt + 1) * 0x45d9f3b + i * 0x27d4eb2d) * 0.28;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}
