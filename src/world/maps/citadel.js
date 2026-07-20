import { chain, perimeter, site, spawnRow } from './layout.js';

const bounds = { x0: -50, x1: 50, z0: -42, z1: 42 };

const nodes = {
  t_n: [-43, 0, -16], t_m: [-44, 0, 0], t_s: [-43, 0, 16],
  n0: [-35, 0, -24], n1: [-25, 0, -29], n2: [-13, 0, -29], n3: [0, 0, -29], n4: [10, 1.2, -27],
  a0: [16, 1.2, -27], a1: [24, 1.2, -27], a2: [32, 1.2, -31], a3: [34, 1.2, -23],
  s0: [-35, 0, 24], s1: [-25, 0, 29], s2: [-13, 0, 29], s3: [0, 0, 29], s4: [10, 1.2, 27],
  b0: [16, 1.2, 27], b1: [24, 1.2, 27], b2: [32, 1.2, 31], b3: [34, 1.2, 23],
  m0: [-34, 0, 0], m1: [-24, 0, 0], m2: [-13, 0, 0], m3: [-4, 0, -3], m4: [4, 0, -3], m5: [14, 0, 0], m6: [25, 0, 0], m7: [36, 0, 0],
  cn0: [0, 0, -8], cn1: [0, 0, -18], cs0: [0, 0, 8], cs1: [0, 0, 18],
  an: [20, 0, -16], as: [20, 1.2, -21], bn: [20, 0, 16], bs: [20, 1.2, 21],
  ct_n: [43, 0, -15], ct_m: [44, 0, 0], ct_s: [43, 0, 15],
};

const edges = [
  ...chain('t_n', 'n0', 'n1', 'n2', 'n3', 'n4', 'a0', 'a1', 'a2'),
  ...chain('t_s', 's0', 's1', 's2', 's3', 's4', 'b0', 'b1', 'b2'),
  ...chain('t_m', 'm0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'ct_m'),
  ['t_n', 't_m'], ['t_m', 't_s'], ['n0', 'm0'], ['m0', 's0'],
  ...chain('m3', 'cn0', 'cn1', 'n3'), ...chain('m3', 'cs0', 'cs1', 's3'),
  ...chain('m6', 'an', 'as', 'a0'), ...chain('m6', 'bn', 'bs', 'b0'),
  ['a3', 'a1'], ['a3', 'ct_n'], ['ct_n', 'ct_m'], ['ct_m', 'ct_s'], ['ct_s', 'b3'], ['b3', 'b1'],
  ['m7', 'ct_n'], ['m7', 'ct_s'],
];

export const CITADEL = {
  id: 'citadel',
  bounds,
  theme: {
    key: 'citadel',
    wall: '#aa8d6b', wallA: '#c29a69', wallB: '#817d72', floor: '#938572',
    trim: '#695744', metal: '#625f5b', wood: '#74543a', fog: 0xc2a783,
    fogNear: 76, fogFar: 170, skyTint: 0xe4c6a0, sun: 0xffd49a,
    sunIntensity: 2.45, sunPosition: [-45, 62, -30], hemiSky: 0xb6c7df,
    hemiGround: 0x80674d, ambient: 0x55483e, ambientIntensity: 0.5,
    accentA: '#d88945', accentB: '#667b89', markerA: '#f3a54e', markerB: '#7399aa',
  },
  solids: [
    [-52, 52, -1, 0, -44, 44, 'ground', 'stone'],
    ...perimeter(bounds, 10, 1.8, 'wallN'),
    // Four keep wings create a cross-shaped inner court with genuine rotations.
    [-19, -6, 0, 7.2, -19, -7, 'wallB'],
    [-19, -6, 0, 7.2, 7, 19, 'wallB'],
    [6, 19, 0, 7.2, -19, -7, 'wallA'],
    [6, 19, 0, 7.2, 7, 19, 'wallA'],
    // Raised northern and southern site terraces.
    [10, 39, 0, 1.2, -36, -20, 'padPlat', 'stone'],
    [10, 39, 0, 1.2, 20, 36, 'padPlatB', 'stone'],
    [39, 47, 0, 6.8, -38, -19, 'wallA'],
    [39, 47, 0, 6.8, 19, 38, 'wallB'],
    // West barracks and east gatehouse frame each spawn.
    [-48, -37, 0, 6.2, -38, -23, 'wallB'],
    [-48, -37, 0, 6.2, 23, 38, 'wallB'],
    // Low battlements give cover without sealing the courtyard.
    [-5, 5, 0, 1.15, -20, -19, 'wallAs'],
    [-5, 5, 0, 1.15, 19, 20, 'wallBs'],
    [-29, -28, 0, 1.25, -6, 6, 'wallBs'],
    [27, 28, 0, 1.25, -6, 6, 'wallAs'],
  ],
  stairs: [
    [7, 10, -35, -20, 6, 0.2, '+x', 'wallAs', 0],
    [7, 10, 20, 35, 6, 0.2, '+x', 'wallBs', 0],
    [18, 23, -20, -17, 6, 0.2, '-z', 'wallAs', 0],
    [18, 23, 17, 20, 6, 0.2, '+z', 'wallBs', 0],
  ],
  arches: [
    [-19, 0, 8, 'z', 0.9, 3.8, 5.5, 'wallBs'],
    [19, 0, 8, 'z', 0.9, 3.8, 5.5, 'wallAs'],
    [0, -19, 12, 'x', 0.9, 3.8, 5.6, 'wallAs'],
    [0, 19, 12, 'x', 0.9, 3.8, 5.6, 'wallBs'],
  ],
  props: [
    { kind: 'column', x: 0, z: 0, radius: 1.4, height: 1.1, mat: 'stoneDark' },
    { kind: 'column', x: -31, z: -20, radius: 1.0, height: 7.5, mat: 'wallB' },
    { kind: 'column', x: -31, z: 20, radius: 1.0, height: 7.5, mat: 'wallB' },
    { kind: 'column', x: 31, z: -15, radius: 1.0, height: 7.5, mat: 'wallA' },
    { kind: 'column', x: 31, z: 15, radius: 1.0, height: 7.5, mat: 'wallA' },
    { kind: 'crate', x: 20, z: -32, size: 1.35, y: 1.2 },
    { kind: 'crate', x: 33, z: -23, size: 1.2, y: 1.2, mat: 'crateDark' },
    { kind: 'crate', x: 20, z: 32, size: 1.35, y: 1.2 },
    { kind: 'crate', x: 33, z: 23, size: 1.2, y: 1.2, mat: 'crateDark' },
    { kind: 'sandbags', x0: 20, x1: 27, z0: -19.5, z1: -18.5, h: 1.0 },
    { kind: 'sandbags', x0: 20, x1: 27, z0: 18.5, z1: 19.5, h: 1.0 },
    { kind: 'barrel', x: -24, z: -4, red: true },
    { kind: 'barrel', x: -24, z: 4, red: false },
  ],
  decor: [
    [0, 1.2, 0, 4.2, 0.12, 4.2, 'water'], [0, 1.35, 0, 1.2, 0.18, 1.2, 'stoneDark'],
    [-12.5, 7.55, -13, 13.4, 0.35, 12.4, 'trim'], [-12.5, 7.55, 13, 13.4, 0.35, 12.4, 'trim'],
    [12.5, 7.55, -13, 13.4, 0.35, 12.4, 'trim'], [12.5, 7.55, 13, 13.4, 0.35, 12.4, 'trim'],
    [24.5, 1.25, -28, 27, 0.06, 15, 'stoneLight'], [24.5, 1.25, 28, 27, 0.06, 15, 'stoneLight'],
    [-49.1, 4.3, 0, 0.12, 3.4, 11, 'accentB'], [49.1, 4.3, 0, 0.12, 3.4, 11, 'accentA'],
  ],
  lights: [
    { color: 0xffa750, intensity: 7, distance: 17, pos: [-2, 3, -5] },
    { color: 0xffa750, intensity: 7, distance: 17, pos: [2, 3, 5] },
  ],
  spawns: {
    t: spawnRow([[-44, -17], [-46, -10], [-42, -4], [-45, 4], [-42, 10], [-44, 17]], -Math.PI / 2),
    ct: spawnRow([[44, -16], [46, -10], [42, -4], [45, 4], [42, 10], [44, 16]], Math.PI / 2),
  },
  bombSites: [site('A', [25, 1.2, -28], [14, 3.4, 11]), site('B', [25, 1.2, 28], [14, 3.4, 11])],
  navigation: {
    nodes,
    edges,
    attackRoutes: {
      A: [
        { name: 'north battlement', nodes: ['t_n', 'n0', 'n2', 'n3', 'n4', 'a1'] },
        { name: 'inner court', nodes: ['t_m', 'm1', 'm3', 'cn0', 'cn1', 'n3', 'n4'] },
        { name: 'east gate split', nodes: ['t_m', 'm3', 'm5', 'an', 'as', 'a0'] },
      ],
      B: [
        { name: 'south battlement', nodes: ['t_s', 's0', 's2', 's3', 's4', 'b1'] },
        { name: 'inner court', nodes: ['t_m', 'm1', 'm3', 'cs0', 'cs1', 's3', 's4'] },
      ],
    },
    defenseAreas: [
      { name: 'A terrace', sector: 'A', anchor: 'a1', nodes: ['a0', 'a1', 'a2', 'a3'] },
      { name: 'B terrace', sector: 'B', anchor: 'b1', nodes: ['b0', 'b1', 'b2', 'b3'] },
      { name: 'fountain court', sector: 'mid', anchor: 'm5', nodes: ['m3', 'm4', 'm5', 'cn0', 'cs0'] },
      { name: 'north gate', sector: 'A', anchor: 'an', nodes: ['an', 'as', 'a0'] },
      { name: 'south gate', sector: 'B', anchor: 'bn', nodes: ['bn', 'bs', 'b0'] },
      { name: 'east gatehouse', sector: 'mid', anchor: 'm7', nodes: ['m6', 'm7', 'ct_m'] },
    ],
  },
};
