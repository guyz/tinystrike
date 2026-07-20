import { chain, perimeter, site, spawnRow } from './layout.js';

const bounds = { x0: -52, x1: 52, z0: -42, z1: 42 };

const nodes = {
  t_w: [-27, 0, 35], t_c: [0, 0, 35], t_e: [28, 0, 35],
  w0: [-31, 0, 28], w1: [-40, 0, 20], w2: [-41, 0, 10], w3: [-39, 0, 0], w4: [-38, 0, -7.5],
  b_ramp: [-35, 0.5, -10], b0: [-34, 0.5, -14], b1: [-31, 0.5, -19], b2: [-39, 0.5, -20], b3: [-27, 0.5, -14],
  e0: [31, 0, 28], e1: [41, 0, 20], e2: [43, 0, 10], e3: [41, 0, 0], e4: [39, 0, -7.5],
  a_ramp: [35, 0.5, -10], a0: [34, 0.5, -14], a1: [31, 0.5, -19], a2: [39, 0.5, -20], a3: [27, 0.5, -14],
  m0: [0, 0, 27], m1: [0, 0, 18], m2: [0, 0, 8], m3: [0, 0, -2], m4: [0, 0, -13], m5: [0, 0, -23],
  // Two centered gate points keep separation steering inside the gap between
  // the spawn sandbags and the short customs wall.
  ct_gate_n: [4, 0, -27.5], ct_bypass: [4, 0, -30.3],
  nw: [-18, 0, -25], bw: [-26, 0, -26], ne: [18, 0, -25], ae: [26, 0, -26],
  ct_w: [-22, 0, -34], ct_c: [0, 0, -35], ct_e: [22, 0, -34],
  dock_mid: [20, 0, 20], yard_mid: [-20, 0, 20],
};

const edges = [
  ...chain('t_w', 'w0', 'w1', 'w2', 'w3', 'w4', 'b_ramp', 'b0', 'b1', 'b2'),
  ...chain('t_e', 'e0', 'e1', 'e2', 'e3', 'e4', 'a_ramp', 'a0', 'a1', 'a2'),
  ...chain('t_c', 'm0', 'm1', 'm2', 'm3', 'm4', 'm5', 'ct_gate_n', 'ct_bypass', 'ct_c'),
  ['t_w', 't_c'], ['t_c', 't_e'],
  ...chain('w1', 'yard_mid', 'm1'), ...chain('m1', 'dock_mid', 'e1'),
  ...chain('m5', 'nw', 'bw', 'b1'), ...chain('m5', 'ne', 'ae', 'a1'),
  ['b3', 'nw'], ['b3', 'b0'], ['a3', 'ne'], ['a3', 'a0'],
  ['bw', 'ct_w'], ['ct_w', 'ct_c'], ['ct_c', 'ct_e'], ['ct_e', 'ae'],
];

export const HARBOR = {
  id: 'harbor',
  bounds,
  theme: {
    key: 'coastal',
    wall: '#88979a', wallA: '#d19a5b', wallB: '#4f7180', floor: '#727b78',
    trim: '#374b52', metal: '#52666d', wood: '#776149', fog: 0x9bb7be,
    fogNear: 72, fogFar: 165, skyTint: 0xb8d7dc, sun: 0xffe4bd,
    sunIntensity: 2.0, sunPosition: [55, 48, -40], hemiSky: 0xb6dce8,
    hemiGround: 0x59685e, ambient: 0x50636a, ambientIntensity: 0.6,
    accentA: '#e49b3f', accentB: '#39798d', markerA: '#ffad46', markerB: '#45a9c5',
  },
  solids: [
    [-54, 54, -1, 0, -44, 44, 'ground', 'concrete'],
    ...perimeter(bounds, 8.5, 1.5, 'wallB'),
    // Customs house creates a tight, roofed mid lane.
    [-14, -3.2, 0, 6.4, -14, 16, 'wallN'],
    [3.2, 14, 0, 6.4, -14, 16, 'wallN'],
    [-3.2, 3.2, 3.3, 6.4, -14, 16, 'wallN'],
    // Container-yard and dry-dock buildings create different side routes.
    [-28, -17, 0, 5.5, -7, 18, 'wallB'],
    [17, 27, 0, 5.5, -7, 18, 'wallA'],
    [-49, -44, 0, 6, -28, 27, 'wallB'],
    [44, 49, 0, 4.5, -29, 27, 'wallA'],
    // Bomb piers sit above the wet concrete and have open crossfire angles.
    [-43, -24, 0, 0.5, -25, -10, 'padPlatB', 'wood'],
    [24, 43, 0, 0.5, -25, -10, 'padPlat', 'metal'],
    [-43, -36, 0.5, 4.2, -25, -23, 'wallB'],
    [36, 43, 0.5, 4.2, -25, -23, 'wallA'],
    // Spawn warehouses and seawalls.
    [-50, -35, 0, 5.4, 29, 40, 'wallB'],
    [35, 50, 0, 5.4, 29, 40, 'wallA'],
    [-50, -43, 0, 4.8, -41, -31, 'wallB'],
    [43, 50, 0, 4.8, -41, -31, 'wallN'],
    [-12, -5, 0, 1.2, -29, -28, 'wallBs'],
    [5, 12, 0, 1.2, -29, -28, 'wallBs'],
  ],
  stairs: [
    [-42, -24, -10, -8, 2, 0.25, '-z', 'wood', 0],
    [24, 42, -10, -8, 2, 0.25, '-z', 'metal', 0],
  ],
  arches: [
    [0, 16, 6.4, 'x', 0.8, 3.25, 5.1, 'wallNs'],
    [0, -14, 6.4, 'x', 0.8, 3.25, 5.1, 'wallNs'],
  ],
  props: [
    { kind: 'container', x: -37, y: 1.3, z: 15, w: 5.8, h: 2.6, d: 2.5, mat: 'accentB' },
    { kind: 'container', x: -35, y: 1.3, z: 8, w: 2.5, h: 2.6, d: 5.8, mat: 'accentA' },
    { kind: 'container', x: -32, y: 3.9, z: 24, w: 5.8, h: 2.6, d: 2.5, mat: 'accentB' },
    { kind: 'container', x: 34, y: 1.3, z: 14, w: 5.8, h: 2.6, d: 2.5, mat: 'accentA' },
    { kind: 'crate', x: -39, z: -18, size: 1.3, y: 0.5 },
    { kind: 'crate', x: -29, z: -22, size: 1.15, y: 0.5, mat: 'crateDark' },
    { kind: 'barrel', x: -26, z: -12, red: false, y: 0.5 },
    { kind: 'crate', x: 39, z: -18, size: 1.3, y: 0.5 },
    { kind: 'crate', x: 29, z: -22, size: 1.15, y: 0.5, mat: 'crateDark' },
    { kind: 'barrel', x: 26, z: -12, red: true, y: 0.5 },
    { kind: 'column', x: 20, z: -2, radius: 0.7, height: 9, mat: 'metal' },
    { kind: 'column', x: 39, z: -2, radius: 0.7, height: 9, mat: 'metal' },
    { kind: 'sandbags', x0: -3, x1: 3, z0: -30.5, z1: -29.5, h: 1.0 },
  ],
  decor: [
    [29.5, 8.8, -2, 20, 0.45, 0.45, 'accentA'], [29.5, 5.8, -2, 0.45, 6, 0.45, 'metal'],
    [39, 5.8, -2, 0.45, 6, 0.45, 'metal'], [38.5, 8.2, -2, 2.5, 0.3, 0.3, 'metal'],
    [-33.5, 0.54, -17.5, 18, 0.08, 14, 'wood'], [33.5, 0.54, -17.5, 18, 0.08, 14, 'metalGrid'],
    [-13.8, 4.1, 0, 0.12, 1.1, 4.5, 'glass'], [13.8, 4.1, 0, 0.12, 1.1, 4.5, 'glass'],
    [51.1, 0.08, 0, 2.2, 0.08, 78, 'water'], [-51.1, 0.08, 0, 2.2, 0.08, 78, 'water'],
  ],
  lights: [
    { color: 0xffc06f, intensity: 7, distance: 17, pos: [0, 2.7, 8] },
    { color: 0xffc06f, intensity: 7, distance: 17, pos: [0, 2.7, -7] },
    { color: 0x72d5ff, intensity: 5, distance: 16, pos: [34, 3.5, -17] },
  ],
  spawns: {
    t: spawnRow([[-28, 35], [-17, 37], [-6, 34], [6, 37], [17, 34], [28, 36]], 0),
    ct: spawnRow([[-24, -34], [-14, -36], [-4, -33], [6, -36], [16, -33], [25, -35]], Math.PI),
  },
  bombSites: [site('A', [34, 0.5, -18], [12, 3, 10]), site('B', [-34, 0.5, -18], [12, 3, 10])],
  navigation: {
    nodes,
    edges,
    attackRoutes: {
      A: [
        { name: 'quayside', nodes: ['t_e', 'e1', 'e3', 'e4', 'a_ramp', 'a1'] },
        { name: 'customs flank', nodes: ['t_c', 'm1', 'm3', 'm5', 'ne', 'ae', 'a1'] },
        { name: 'dock connector', nodes: ['t_c', 'm1', 'm2', 'dock_mid', 'e1', 'e3'] },
      ],
      B: [
        { name: 'container yard', nodes: ['t_w', 'w1', 'w3', 'w4', 'b_ramp', 'b1'] },
        { name: 'customs flank', nodes: ['t_c', 'm1', 'm3', 'm5', 'nw', 'bw', 'b1'] },
      ],
    },
    defenseAreas: [
      { name: 'A dry dock', sector: 'A', anchor: 'a1', nodes: ['a0', 'a1', 'a2', 'a3'] },
      { name: 'B cargo pier', sector: 'B', anchor: 'b1', nodes: ['b0', 'b1', 'b2', 'b3'] },
      { name: 'customs hall', sector: 'mid', anchor: 'm4', nodes: ['m2', 'm3', 'm4', 'm5'] },
      { name: 'quayside', sector: 'A', anchor: 'e4', nodes: ['e3', 'e4', 'a_ramp'] },
      { name: 'container lane', sector: 'B', anchor: 'w4', nodes: ['w3', 'w4', 'b_ramp'] },
      { name: 'north cross', sector: 'mid', anchor: 'ct_c', nodes: ['bw', 'nw', 'm5', 'ne', 'ae'] },
    ],
  },
};
