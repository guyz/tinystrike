import { chain, perimeter, site, spawnRow } from './layout.js';

const bounds = { x0: -50, x1: 50, z0: -40, z1: 40 };

const nodes = {
  t_w: [-28, 0, -33], t_c: [0, 0, -34], t_e: [28, 0, -33],
  nw_0: [-30, 0, -26], nw_1: [-39, 0, -19], nw_2: [-40, 0, -8], nw_3: [-38, 0, -1],
  a_ramp: [-34, 0.8, 3], a_1: [-35, 0.8, 7], a_2: [-31, 0.8, 13], a_3: [-38, 0.8, 18],
  ne_0: [30, 0, -26], ne_1: [39, 0, -19], ne_2: [40, 0, -8], ne_3: [38, 0, -1],
  b_ramp: [34, 0.8, 3], b_1: [35, 0.8, 7], b_2: [31, 0.8, 13], b_3: [38, 0.8, 18],
  mid_0: [0, 0, -27], mid_1: [0, 0, -17], mid_2: [0, 0, -7], mid_3: [0, 0, 4], mid_4: [0, 0, 15], mid_5: [0, 0, 23],
  sw_0: [-20, 0, 24], sw_1: [-30, 0, 26], sw_2: [-39, 0, 25],
  se_0: [20, 0, 24], se_1: [30, 0, 26], se_2: [39, 0, 25],
  ct_w: [-22, 0, 33], ct_c: [0, 0, 34], ct_e: [22, 0, 33],
  a_back: [-28, 0.8, 20], b_back: [28, 0.8, 20],
};

const edges = [
  ...chain('t_w', 'nw_0', 'nw_1', 'nw_2', 'nw_3', 'a_ramp', 'a_1', 'a_2', 'a_3'),
  ...chain('t_e', 'ne_0', 'ne_1', 'ne_2', 'ne_3', 'b_ramp', 'b_1', 'b_2', 'b_3'),
  ...chain('t_c', 'mid_0', 'mid_1', 'mid_2', 'mid_3', 'mid_4', 'mid_5', 'ct_c'),
  ['t_w', 't_c'], ['t_c', 't_e'], ['nw_0', 'mid_0'], ['mid_0', 'ne_0'],
  ...chain('mid_5', 'sw_0', 'sw_1', 'sw_2', 'a_back', 'a_2'),
  ...chain('mid_5', 'se_0', 'se_1', 'se_2', 'b_back', 'b_2'),
  ['sw_0', 'ct_w'], ['ct_w', 'ct_c'], ['ct_c', 'ct_e'], ['ct_e', 'se_0'],
  ['a_3', 'a_back'], ['b_3', 'b_back'],
];

export const FROSTLINE = {
  id: 'frostline',
  bounds,
  theme: {
    key: 'arctic',
    wall: '#8fa6b2', wallA: '#b9d8e4', wallB: '#637b91', floor: '#dce8e9',
    trim: '#435c6e', metal: '#667784', wood: '#7d7064', fog: 0xb9d4df,
    fogNear: 70, fogFar: 155, skyTint: 0xc9e3ef, sun: 0xe7f5ff,
    sunIntensity: 2.2, sunPosition: [-46, 58, -34], hemiSky: 0xbddcff,
    hemiGround: 0x6d7c82, ambient: 0x627786, ambientIntensity: 0.62,
    accentA: '#65dcff', accentB: '#436fb7', markerA: '#65dcff', markerB: '#5b80dd',
  },
  solids: [
    [-52, 52, -1, 0, -42, 42, 'ground', 'snow'],
    ...perimeter(bounds, 8.5, 1.5, 'wallB'),
    // Twin research wings leave a roofed central connector and broad exterior flanks.
    [-15, -3.2, 0, 6.5, -18, 18, 'wallN'],
    [3.2, 15, 0, 6.5, -18, 18, 'wallN'],
    [-3.2, 3.2, 3.25, 6.5, -18, 18, 'wallN'],
    [-23, -16, 0, 5.2, -7, 18, 'wallB'],
    [16, 23, 0, 5.2, -7, 18, 'wallB'],
    // Raised, asymmetric bomb pads.
    [-43, -24, 0, 0.8, 3, 22, 'padPlatB', 'concrete'],
    [24, 43, 0, 0.8, 3, 22, 'padPlat', 'concrete'],
    [-47, -43, 0, 5.5, -4, 25, 'wallB'],
    [43, 47, 0, 5.5, -4, 25, 'wallA'],
    // Spawn-side utility buildings and wind breaks.
    [-48, -31, 0, 5.8, -39, -28, 'wallB'],
    [31, 48, 0, 5.8, -39, -28, 'wallB'],
    [-48, -42, 0, 4.4, 27, 39, 'wallN'],
    [42, 48, 0, 4.4, 27, 39, 'wallN'],
    [-12, -5, 0, 1.4, 26, 27.2, 'wallBs'],
    [5, 12, 0, 1.4, 26, 27.2, 'wallBs'],
  ],
  stairs: [
    [-42, -24, 0, 3, 4, 0.2, '+z', 'padPlatB', 0],
    [24, 42, 0, 3, 4, 0.2, '+z', 'padPlat', 0],
  ],
  arches: [
    [0, -18, 6.4, 'x', 0.7, 3.2, 4.8, 'wallBs'],
    [0, 18, 6.4, 'x', 0.7, 3.2, 4.8, 'wallBs'],
  ],
  props: [
    { kind: 'crate', x: -39, z: 17, size: 1.35, y: 0.8 },
    { kind: 'crate', x: -30, z: 6, size: 1.15, y: 0.8, mat: 'crateDark' },
    { kind: 'barrel', x: -26, z: 19, red: false, y: 0.8 },
    { kind: 'crate', x: 39, z: 17, size: 1.35, y: 0.8 },
    { kind: 'crate', x: 30, z: 6, size: 1.15, y: 0.8, mat: 'crateDark' },
    { kind: 'barrel', x: 26, z: 19, red: true, y: 0.8 },
    { kind: 'crate', x: -6, z: -24, size: 1.25 },
    { kind: 'crate', x: 7, z: 23, size: 1.15 },
    { kind: 'sandbags', x0: -3, x1: 3, z0: 27.5, z1: 28.5, h: 1.0 },
    { kind: 'column', x: -21, z: -22, radius: 1.1, height: 5.8, mat: 'metal' },
    { kind: 'column', x: 21, z: -22, radius: 1.1, height: 5.8, mat: 'metal' },
  ],
  decor: [
    [-9, 6.8, 0, 12.4, 0.32, 36.4, 'trim'], [9, 6.8, 0, 12.4, 0.32, 36.4, 'trim'],
    [-33.5, 0.04, 12.5, 18, 0.06, 18, 'snow'], [33.5, 0.04, 12.5, 18, 0.06, 18, 'snow'],
    [-21, 5.9, -22, 4.6, 0.2, 2.5, 'solar', -0.15], [21, 5.9, -22, 4.6, 0.2, 2.5, 'solar', 0.15],
    [-14.7, 3.2, -4, 0.12, 1.2, 3.5, 'glass'], [14.7, 3.2, 5, 0.12, 1.2, 3.5, 'glass'],
    [-48.8, 2.4, 0, 0.18, 1.4, 13, 'iceGlow'], [48.8, 2.4, 0, 0.18, 1.4, 13, 'iceGlow'],
  ],
  lights: [
    { color: 0x70d8ff, intensity: 6, distance: 18, pos: [0, 2.5, -9] },
    { color: 0x70d8ff, intensity: 6, distance: 18, pos: [0, 2.5, 9] },
  ],
  spawns: {
    t: spawnRow([[-28, -33], [-16, -35], [-5, -32], [6, -35], [17, -32], [28, -34]], Math.PI),
    ct: spawnRow([[-24, 33], [-14, 35], [-4, 32], [6, 35], [16, 32], [25, 34]], 0),
  },
  bombSites: [site('A', [-34, 0.8, 12], [12, 3.2, 12]), site('B', [34, 0.8, 12], [12, 3.2, 12])],
  navigation: {
    nodes,
    edges,
    attackRoutes: {
      A: [
        { name: 'ice road', nodes: ['t_w', 'nw_1', 'nw_3', 'a_ramp', 'a_2'] },
        { name: 'lab flank', nodes: ['t_c', 'mid_1', 'mid_4', 'mid_5', 'sw_1', 'a_back'] },
      ],
      B: [
        { name: 'generator road', nodes: ['t_e', 'ne_1', 'ne_3', 'b_ramp', 'b_2'] },
        { name: 'lab flank', nodes: ['t_c', 'mid_1', 'mid_4', 'mid_5', 'se_1', 'b_back'] },
      ],
    },
    defenseAreas: [
      { name: 'A research pad', sector: 'A', anchor: 'a_2', nodes: ['a_1', 'a_2', 'a_3', 'a_back'] },
      { name: 'B generator pad', sector: 'B', anchor: 'b_2', nodes: ['b_1', 'b_2', 'b_3', 'b_back'] },
      { name: 'cryolab', sector: 'mid', anchor: 'mid_4', nodes: ['mid_2', 'mid_3', 'mid_4', 'mid_5'] },
      { name: 'A ice road', sector: 'A', anchor: 'nw_3', nodes: ['nw_2', 'nw_3', 'a_ramp'] },
      { name: 'B ice road', sector: 'B', anchor: 'ne_3', nodes: ['ne_2', 'ne_3', 'b_ramp'] },
      { name: 'south connector', sector: 'mid', anchor: 'ct_c', nodes: ['sw_0', 'mid_5', 'ct_c', 'se_0'] },
    ],
  },
};
