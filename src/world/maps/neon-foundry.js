import { chain, perimeter, site, spawnRow } from './layout.js';

const bounds = { x0: -52, x1: 52, z0: -38, z1: 38 };

const nodes = {
  t_n: [-44, 0, -18], t_m: [-45, 0, 0], t_s: [-44, 0, 18],
  n0: [-35, 0, -22], n1: [-25, 0, -25], n2: [-14, 0, -24], n3: [-2, 0, -24], n4: [10, 0, -25],
  a0: [20, 0.9, -25], a1: [29, 0.9, -25], a2: [36, 0.9, -20], a3: [29, 0.9, -17],
  s0: [-35, 0, 22], s1: [-25, 0, 25], s2: [-14, 0, 24], s3: [-2, 0, 24], s4: [10, 0, 25],
  b0: [20, 0.9, 25], b1: [29, 0.9, 25], b2: [36, 0.9, 20], b3: [29, 0.9, 17],
  m0: [-34, 0, 0], m1: [-24, 0, 0], m2: [-16, 0, 0], m3: [-7, 3, 0], m4: [7, 3, 0], m5: [16, 0, 0], m6: [35, 0, 0],
  an: [11.5, 0, -18], as: [18, 0.9, -18], bn: [11.5, 0, 18], bs: [18, 0.9, 18],
  ct_n: [44, 0, -12], ct_m: [45, 0, 0], ct_s: [44, 0, 12],
  ws1: [-14.5, 0.5, 0], ws2: [-13.5, 1, 0], ws3: [-12.5, 1.5, 0],
  ws4: [-11.5, 2, 0], ws5: [-10.5, 2.5, 0], ws6: [-9.5, 3, 0],
  es6: [9.5, 3, 0], es5: [10.5, 2.5, 0], es4: [11.5, 2, 0],
  es3: [12.5, 1.5, 0], es2: [13.5, 1, 0], es1: [14.5, 0.5, 0],
};

const edges = [
  ...chain('t_n', 'n0', 'n1', 'n2', 'n3', 'n4', 'a0', 'a1', 'a2'),
  ...chain('t_s', 's0', 's1', 's2', 's3', 's4', 'b0', 'b1', 'b2'),
  ...chain(
    't_m', 'm0', 'm1', 'm2',
    'ws1', 'ws2', 'ws3', 'ws4', 'ws5', 'ws6', 'm3', 'm4',
    'es6', 'es5', 'es4', 'es3', 'es2', 'es1',
    'm5', 'm6', 'ct_m'
  ),
  ['t_n', 't_m'], ['t_m', 't_s'],
  ...chain('m5', 'an', 'as', 'a3', 'a1'),
  ...chain('m5', 'bn', 'bs', 'b3', 'b1'),
  ['ct_n', 'ct_m'], ['ct_m', 'ct_s'],
  ['m6', 'ct_n'], ['m6', 'ct_s'],
];

export const NEON_FOUNDRY = {
  id: 'neon_foundry',
  bounds,
  theme: {
    key: 'neon',
    wall: '#46515e', wallA: '#594866', wallB: '#395b64', floor: '#373f47',
    trim: '#242d35', metal: '#627582', wood: '#6a5245', fog: 0x1b2636,
    fogNear: 58, fogFar: 135, skyTint: 0x344968, sun: 0xb8ceef,
    sunIntensity: 1.65, sunPosition: [-32, 48, -24], hemiSky: 0x86abe0,
    hemiGround: 0x3a3d46, hemiIntensity: 1.15, ambient: 0x7890ad, ambientIntensity: 1.35,
    accentA: '#ff4f9a', accentB: '#16e7d4', markerA: '#ff4f9a', markerB: '#16e7d4',
  },
  solids: [
    [-54, 54, -1, 0, -40, 40, 'ground', 'concrete'],
    ...perimeter(bounds, 9, 1.6, 'wallN'),
    // Furnace core split by an east-west service tunnel.
    [-11, 11, 0, 7.5, -14, -3.2, 'wallA'],
    [-11, 11, 0, 7.5, 3.2, 14, 'wallB'],
    [-11, 11, 5.2, 7.5, -3.2, 3.2, 'wallN'],
    // Loading halls establish distinct northern and southern lanes.
    [-36, -19, 0, 6, -18, -8, 'wallN'],
    [-36, -19, 0, 6, 8, 18, 'wallN'],
    [16, 22, 0, 6, -17, -8, 'wallA'],
    [16, 22, 0, 6, 8, 17, 'wallB'],
    // Site casting decks, each reached by broad ramps from both sides.
    [18, 41, 0, 0.9, -31, -15, 'padPlat', 'metal'],
    [18, 41, 0, 0.9, 15, 31, 'padPlatB', 'metal'],
    [41, 49, 0, 5.7, -32, -15, 'wallA'],
    [41, 49, 0, 5.7, 15, 32, 'wallB'],
    // Rails around the furnace catwalk; the deck remains traversable.
    [-9, 9, 2.75, 3, -2.8, 2.8, 'metal', 'metal'],
    [-9, 9, 3, 3.9, -2.8, -2.65, 'metal', 'metal'],
    [-9, 9, 3, 3.9, 2.65, 2.8, 'metal', 'metal'],
    // Spawn machinery breaks up long sightlines.
    [-48, -39, 0, 5, -32, -24, 'wallN'],
    [-48, -39, 0, 5, 24, 32, 'wallN'],
  ],
  stairs: [
    [12, 18, -30, -15, 5, 0.18, '+x', 'metal', 0],
    [12, 18, 15, 30, 5, 0.18, '+x', 'metal', 0],
    [-15, -9, -2.8, 2.8, 6, 0.5, '+x', 'metal', 0],
    [9, 15, -2.8, 2.8, 6, 0.5, '-x', 'metal', 0],
  ],
  arches: [
    // 1.83 m bots need a sliver more headroom where the 3 m catwalk meets
    // these arch lintels; 5.1 m preserves the silhouette and clears the rig.
    [-11, 0, 6.4, 'z', 0.8, 5.1, 5.45, 'wallAs'],
    [11, 0, 6.4, 'z', 0.8, 5.1, 5.45, 'wallBs'],
  ],
  props: [
    { kind: 'container', x: -29, y: 1.3, z: -29, w: 5.5, h: 2.6, d: 2.5, mat: 'accentA' },
    { kind: 'container', x: -30, y: 1.3, z: 29, w: 5.5, h: 2.6, d: 2.5, mat: 'accentB' },
    { kind: 'barrel', x: -16, z: -27, red: true },
    { kind: 'barrel', x: -15, z: 27, red: false },
    { kind: 'crate', x: 26, z: -27, size: 1.4, y: 0.9 },
    { kind: 'crate', x: 34, z: -18, size: 1.25, y: 0.9, mat: 'crateDark' },
    { kind: 'crate', x: 26, z: 27, size: 1.4, y: 0.9 },
    { kind: 'crate', x: 34, z: 18, size: 1.25, y: 0.9, mat: 'crateDark' },
    { kind: 'column', x: 0, z: -9.5, radius: 1.4, height: 10, mat: 'hotMetal' },
    { kind: 'column', x: 0, z: 9.5, radius: 1.4, height: 10, mat: 'hotMetal' },
    { kind: 'sandbags', x0: 28, x1: 34, z0: -14, z1: -13, h: 1.0 },
    { kind: 'sandbags', x0: 28, x1: 34, z0: 13, z1: 14, h: 1.0 },
  ],
  decor: [
    [0, 8.1, -8.6, 22.6, 0.3, 0.4, 'accentA'], [0, 8.1, 8.6, 22.6, 0.3, 0.4, 'accentB'],
    [-11.5, 3.8, 0, 0.18, 0.5, 6.2, 'neonA'], [11.5, 3.8, 0, 0.18, 0.5, 6.2, 'neonB'],
    [29.5, 0.95, -23, 21, 0.08, 15, 'metalGrid'], [29.5, 0.95, 23, 21, 0.08, 15, 'metalGrid'],
    [-50.8, 4.2, 0, 0.12, 2.2, 14, 'neonA'], [50.8, 4.2, 0, 0.12, 2.2, 14, 'neonB'],
    [-1.8, 1.5, 0, 0.12, 2.2, 4.2, 'warning'], [1.8, 1.5, 0, 0.12, 2.2, 4.2, 'warning'],
  ],
  lights: [
    { color: 0xff287e, intensity: 11, distance: 20, pos: [-7, 3.2, -1] },
    { color: 0x18ead6, intensity: 11, distance: 20, pos: [7, 3.2, 1] },
    { color: 0xff7a30, intensity: 9, distance: 18, pos: [0, 5, -10] },
    { color: 0xff7a30, intensity: 9, distance: 18, pos: [0, 5, 10] },
    { color: 0xb8d7ff, intensity: 12, distance: 25, pos: [-41, 4.5, -16] },
    { color: 0xb8d7ff, intensity: 12, distance: 25, pos: [-41, 4.5, 16] },
    { color: 0x9fcfff, intensity: 14, distance: 27, pos: [42, 4.5, -11] },
    { color: 0x9fcfff, intensity: 14, distance: 27, pos: [42, 4.5, 11] },
    { color: 0xffb36b, intensity: 12, distance: 23, pos: [29, 5, -24] },
    { color: 0xffb36b, intensity: 12, distance: 23, pos: [29, 5, 24] },
    { color: 0xb7c8e8, intensity: 8, distance: 22, pos: [-24, 4, 0] },
  ],
  spawns: {
    t: spawnRow([[-45, -18], [-47, -11], [-43, -4], [-46, 4], [-43, 11], [-45, 18]], -Math.PI / 2),
    ct: spawnRow([[45, -12], [47, -9], [43, -2], [46, 2], [43, 9], [45, 12]], Math.PI / 2),
  },
  bombSites: [site('A', [29, 0.9, -24], [13, 3.2, 11]), site('B', [29, 0.9, 24], [13, 3.2, 11])],
  navigation: {
    nodes,
    edges,
    attackRoutes: {
      A: [
        { name: 'north loading', nodes: ['t_n', 'n0', 'n2', 'n4', 'a0', 'a1'] },
        { name: 'furnace split', nodes: ['t_m', 'm1', 'm3', 'm4', 'an', 'as', 'a3'] },
        { name: 'high catwalk', nodes: ['m1', 'm2', 'm3', 'm4', 'm5', 'an'] },
      ],
      B: [
        { name: 'south loading', nodes: ['t_s', 's0', 's2', 's4', 'b0', 'b1'] },
        { name: 'furnace split', nodes: ['t_m', 'm1', 'm3', 'm4', 'bn', 'bs', 'b3'] },
      ],
    },
    defenseAreas: [
      { name: 'A casting deck', sector: 'A', anchor: 'a1', nodes: ['a0', 'a1', 'a2', 'a3'] },
      { name: 'B casting deck', sector: 'B', anchor: 'b1', nodes: ['b0', 'b1', 'b2', 'b3'] },
      { name: 'service tunnel', sector: 'mid', anchor: 'm5', nodes: ['m3', 'm4', 'm5', 'm6'] },
      { name: 'A loading lane', sector: 'A', anchor: 'n4', nodes: ['n3', 'n4', 'a0'] },
      { name: 'B loading lane', sector: 'B', anchor: 's4', nodes: ['s3', 's4', 'b0'] },
      { name: 'furnace catwalk', sector: 'mid', anchor: 'm4', nodes: ['m2', 'm3', 'm4', 'm5'] },
    ],
  },
};
