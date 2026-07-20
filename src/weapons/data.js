// ============================================================================
// TINY STRIKE — src/weapons/data.js (module D, data tables)
//
// Exports:
//   WEAPONS   — object keyed by weapon id (the 11 real weapons)
//   BUY_MENU  — [{ category, items: [ids] }] for the HUD buy panel
//   GEAR      — pseudo-item defs for 'armor' / 'kit' (name + price for HUD rows)
//   getItemDef(id) — WEAPONS[id] || GEAR[id] || null (HUD convenience)
//
// All angles are radians, distances meters, times seconds, prices dollars.
// Spray patterns are precomputed, deterministic (seeded PRNG), recoilIndex-
// driven lookup curves: first shots mostly vertical climb, then alternating
// horizontal drift — classic CS spray shapes.
// ============================================================================

import { CONFIG } from '../shared/config.js';

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) so patterns are identical every load.
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Spray pattern builder.
//   shots  — pattern length (usually mag size)
//   base   — per-shot vertical kick during the opening ramp (rad)
//   amp    — horizontal drift amplitude after the ramp (rad)
//   period — shots per full left/right oscillation
//   phase  — oscillation phase offset (which side it drifts to first)
//   ramp   — number of opening "mostly vertical" shots
//   decay  — how quickly vertical kick settles after the ramp
//   seed   — PRNG seed (deterministic jitter baked into the pattern)
// Each entry is { p, y }: the aim-drift kick (pitch up / yaw) added AFTER that
// shot leaves the barrel (first bullet always flies true to the crosshair).
// ---------------------------------------------------------------------------
function makeSprayPattern(o) {
  const shots = o.shots;
  const base = o.base;
  const amp = o.amp || 0;
  const period = o.period || 8;
  const phase = o.phase || 0;
  const ramp = o.ramp !== undefined ? o.ramp : 4;
  const decay = o.decay || 6;
  const rnd = mulberry32(o.seed || 1);
  const out = [];
  for (let i = 0; i < shots; i++) {
    const n1 = rnd() * 2 - 1;
    const n2 = rnd() * 2 - 1;
    let p;
    let y;
    if (i < ramp) {
      // Opening shots: strong, clean vertical climb with a whisper of lateral.
      p = base * (0.82 + (0.18 * i) / Math.max(1, ramp - 1)) * (1 + n1 * 0.05);
      y = base * 0.05 * n2;
    } else {
      // Settled spray: reduced climb, alternating horizontal wander.
      const k = i - ramp;
      p = base * (0.30 + 0.32 * Math.exp(-k / decay)) * (1 + n1 * 0.08);
      y = amp * Math.sin((k / period) * Math.PI * 2 + phase) + amp * 0.25 * n2;
    }
    out.push({ p: p, y: y });
  }
  return out;
}

// ---------------------------------------------------------------------------
// WEAPONS
// ---------------------------------------------------------------------------
export const WEAPONS = {
  // ------------------------------------------------------------- slot 3 ----
  knife: {
    id: 'knife',
    name: 'Knife',
    slot: 3,
    price: 0,
    damage: 34,
    damageBack: 65,          // backstab damage (combat may use)
    headshotMult: 1.0,
    rpm: 120,
    magSize: 0,
    reserve: 0,
    reloadTime: 0,
    killReward: 1500,
    auto: true,              // hold LMB to keep swinging
    melee: true,
    meleeRange: 1.8,
    spreadBase: 0,
    spreadMove: 0,
    spreadJump: 0,
    recoil: {
      pitchPerShot: 0.004,
      yawJitter: 0.003,
      recovery: 10,
      pattern: makeSprayPattern({ shots: 4, base: 0.004, amp: 0.001, ramp: 2, seed: 10 }),
    },
    bloomPerShot: 0,
    bloomMax: 0,
    penetration: 0,
    falloffStart: 2,
    falloffEnd: 3,
    falloffMinScale: 1,
    moveSpeedMult: 1.0,
    zoomFov: null,
    fireSound: 'knife',
    tracerEvery: 0,
    viewmodel: 'knife',
  },

  // ------------------------------------------------------------- slot 2 ----
  glock: {
    id: 'glock',
    name: 'G-18',
    slot: 2,
    price: 200,
    damage: 26,
    headshotMult: 4,
    rpm: 400,
    magSize: 20,
    reserve: 120,
    reloadTime: 2.2,
    killReward: 300,
    auto: false,
    spreadBase: 0.0035,
    spreadMove: 0.030,
    spreadJump: 0.10,
    recoil: {
      pitchPerShot: 0.006,
      yawJitter: 0.002,
      recovery: 7,
      pattern: makeSprayPattern({ shots: 20, base: 0.006, amp: 0.0012, period: 7, phase: 2.6, ramp: 3, seed: 11 }),
    },
    bloomPerShot: 0.0022,
    bloomMax: 0.012,
    penetration: 0.25,
    falloffStart: 14,
    falloffEnd: 55,
    falloffMinScale: 0.5,
    moveSpeedMult: 0.95,
    zoomFov: null,
    fireSound: 'glock',
    tracerEvery: 1,
    viewmodel: 'pistol',
  },

  usp: {
    id: 'usp',
    name: 'USP-S',
    slot: 2,
    price: 200,
    damage: 34,
    headshotMult: 4,
    rpm: 352,
    magSize: 12,
    reserve: 100,
    reloadTime: 2.2,
    killReward: 300,
    auto: false,
    quiet: true,             // suppressed — audio plays it muffled
    spreadBase: 0.0028,
    spreadMove: 0.028,
    spreadJump: 0.10,
    recoil: {
      pitchPerShot: 0.007,
      yawJitter: 0.002,
      recovery: 7,
      pattern: makeSprayPattern({ shots: 12, base: 0.0068, amp: 0.0011, period: 7, phase: -2.6, ramp: 3, seed: 12 }),
    },
    bloomPerShot: 0.0020,
    bloomMax: 0.010,
    penetration: 0.3,
    falloffStart: 16,
    falloffEnd: 60,
    falloffMinScale: 0.5,
    moveSpeedMult: 0.95,
    zoomFov: null,
    fireSound: 'usp',
    tracerEvery: 1,
    viewmodel: 'pistol',
  },

  deagle: {
    id: 'deagle',
    name: 'Night Hawk',
    slot: 2,
    price: 700,
    damage: 58,
    headshotMult: 4,
    rpm: 160,                // heavy, deliberate
    magSize: 7,
    reserve: 35,
    reloadTime: 2.2,
    killReward: 300,
    auto: false,
    spreadBase: 0.0045,
    spreadMove: 0.045,
    spreadJump: 0.14,
    recoil: {
      pitchPerShot: 0.030,
      yawJitter: 0.008,
      recovery: 5,
      pattern: makeSprayPattern({ shots: 7, base: 0.030, amp: 0.005, period: 5, phase: 2.4, ramp: 2, decay: 4, seed: 13 }),
    },
    bloomPerShot: 0.011,
    bloomMax: 0.035,
    penetration: 0.6,
    falloffStart: 20,
    falloffEnd: 70,
    falloffMinScale: 0.55,
    moveSpeedMult: 0.95,
    zoomFov: null,
    fireSound: 'deagle',
    tracerEvery: 1,
    viewmodel: 'pistol-heavy',
  },

  // ------------------------------------------------------------- slot 1 ----
  mp5: {
    id: 'mp5',
    name: 'MP-5',
    slot: 1,
    price: 1500,
    damage: 26,
    headshotMult: 4,
    rpm: 750,
    magSize: 30,
    reserve: 120,
    reloadTime: 2.6,
    killReward: 600,
    auto: true,
    spreadBase: 0.0028,
    spreadMove: 0.018,
    spreadJump: 0.09,
    recoil: {
      pitchPerShot: 0.0078,
      yawJitter: 0.0028,
      recovery: 9,
      pattern: makeSprayPattern({ shots: 30, base: 0.0078, amp: 0.0019, period: 7.5, phase: 2.8, ramp: 4, decay: 7, seed: 14 }),
    },
    bloomPerShot: 0.0009,
    bloomMax: 0.008,
    penetration: 0.4,
    falloffStart: 12,
    falloffEnd: 50,
    falloffMinScale: 0.45,
    moveSpeedMult: 0.92,
    zoomFov: null,
    fireSound: 'mp5',
    tracerEvery: 1,
    viewmodel: 'smg',
  },

  ak47: {
    id: 'ak47',
    name: 'AK-47',
    slot: 1,
    price: 2700,
    damage: 36,
    headshotMult: 4,         // one-tap headshot vs armored and unarmored
    rpm: 600,
    magSize: 30,
    reserve: 90,
    reloadTime: 2.5,
    killReward: 300,
    auto: true,
    spreadBase: 0.0022,
    spreadMove: 0.045,
    spreadJump: 0.14,
    recoil: {
      pitchPerShot: 0.0135,
      yawJitter: 0.004,
      recovery: 6.5,
      // The classic: 4 shots straight up, then swinging left-first drift.
      pattern: makeSprayPattern({ shots: 30, base: 0.0135, amp: 0.0038, period: 9, phase: 2.9, ramp: 4, decay: 6, seed: 15 }),
    },
    bloomPerShot: 0.0014,
    bloomMax: 0.011,
    penetration: 0.9,
    falloffStart: 25,
    falloffEnd: 90,
    falloffMinScale: 0.65,
    moveSpeedMult: 0.85,
    zoomFov: null,
    fireSound: 'ak47',
    tracerEvery: 1,
    viewmodel: 'rifle-ak',
  },

  m4a1: {
    id: 'm4a1',
    name: 'M4-A1',
    slot: 1,
    price: 3100,
    damage: 33,
    headshotMult: 4,
    rpm: 666,
    magSize: 30,
    reserve: 90,
    reloadTime: 3.0,
    killReward: 300,
    auto: true,
    spreadBase: 0.0018,
    spreadMove: 0.040,
    spreadJump: 0.13,
    recoil: {
      pitchPerShot: 0.011,
      yawJitter: 0.0032,
      recovery: 7.5,
      pattern: makeSprayPattern({ shots: 30, base: 0.0112, amp: 0.0030, period: 8, phase: -2.9, ramp: 4, decay: 6.5, seed: 16 }),
    },
    bloomPerShot: 0.0012,
    bloomMax: 0.010,
    penetration: 0.85,
    falloffStart: 25,
    falloffEnd: 90,
    falloffMinScale: 0.62,
    moveSpeedMult: 0.85,
    zoomFov: null,
    fireSound: 'm4a1',
    tracerEvery: 1,
    viewmodel: 'rifle-m4',
  },

  awp: {
    id: 'awp',
    name: 'AWP',
    slot: 1,
    price: 4750,
    damage: 115,
    headshotMult: 2.5,
    rpm: 41,                 // bolt action
    magSize: 10,
    reserve: 30,
    reloadTime: 3.6,
    killReward: 100,
    auto: false,
    spreadBase: 0,           // scoped + stationary: exactly on the reticle
    spreadUnscoped: 0.05,    // unscoped: a prayer
    spreadMove: 0.06,
    spreadJump: 0.16,
    recoil: {
      pitchPerShot: 0.045,
      yawJitter: 0.006,
      recovery: 4,
      pattern: makeSprayPattern({ shots: 10, base: 0.045, amp: 0.004, period: 5, phase: 2.4, ramp: 1, decay: 3, seed: 17 }),
    },
    bloomPerShot: 0,
    bloomMax: 0,
    penetration: 0.95,
    falloffStart: 150,
    falloffEnd: 300,
    falloffMinScale: 0.9,
    moveSpeedMult: 0.72,
    zoomFov: [26, 11],       // RMB: 0 -> 1 -> 2 -> 0
    fireSound: 'awp',
    tracerEvery: 1,
    viewmodel: 'sniper',
  },

  // ------------------------------------------------------------- slot 4 ----
  hegrenade: {
    id: 'hegrenade',
    name: 'HE Grenade',
    slot: 4,
    price: 300,
    damage: 98,              // max, radial falloff (combat resolves)
    radius: 9,
    headshotMult: 1,
    rpm: 0,
    magSize: 1,
    maxCarry: 1,
    reserve: 0,
    reloadTime: 0,
    killReward: 300,
    auto: false,
    grenade: true,
    fuse: 1.6,
    throwStrength: 14,
    spreadBase: 0,
    spreadMove: 0,
    spreadJump: 0,
    recoil: { pitchPerShot: 0, yawJitter: 0, recovery: 8, pattern: [] },
    bloomPerShot: 0,
    bloomMax: 0,
    penetration: 0,
    falloffStart: 0,
    falloffEnd: 9,
    falloffMinScale: 0,
    moveSpeedMult: 0.98,
    zoomFov: null,
    fireSound: null,
    tracerEvery: 0,
    viewmodel: 'grenade-he',
  },

  flashbang: {
    id: 'flashbang',
    name: 'Flashbang',
    slot: 4,
    price: 200,
    damage: 0,
    headshotMult: 1,
    rpm: 0,
    magSize: 2,
    maxCarry: 2,
    reserve: 0,
    reloadTime: 0,
    killReward: 300,
    auto: false,
    grenade: true,
    fuse: 1.6,
    throwStrength: 14,
    spreadBase: 0,
    spreadMove: 0,
    spreadJump: 0,
    recoil: { pitchPerShot: 0, yawJitter: 0, recovery: 8, pattern: [] },
    bloomPerShot: 0,
    bloomMax: 0,
    penetration: 0,
    falloffStart: 0,
    falloffEnd: 18,
    falloffMinScale: 0,
    moveSpeedMult: 0.98,
    zoomFov: null,
    fireSound: null,
    tracerEvery: 0,
    viewmodel: 'grenade-flash',
  },

  smokegrenade: {
    id: 'smokegrenade',
    name: 'Smoke',
    slot: 4,
    price: 300,
    damage: 0,
    headshotMult: 1,
    rpm: 0,
    magSize: 1,
    maxCarry: 1,
    reserve: 0,
    reloadTime: 0,
    killReward: 300,
    auto: false,
    grenade: true,
    duration: 15,
    throwStrength: 14,
    spreadBase: 0,
    spreadMove: 0,
    spreadJump: 0,
    recoil: { pitchPerShot: 0, yawJitter: 0, recovery: 8, pattern: [] },
    bloomPerShot: 0,
    bloomMax: 0,
    penetration: 0,
    falloffStart: 0,
    falloffEnd: 0,
    falloffMinScale: 0,
    moveSpeedMult: 0.98,
    zoomFov: null,
    fireSound: null,
    tracerEvery: 0,
    viewmodel: 'grenade-smoke',
  },
};

// ---------------------------------------------------------------------------
// Gear pseudo-items (handled specially by Weapons.buy; listed so the HUD can
// render name + price rows for them).
// ---------------------------------------------------------------------------
export const GEAR = {
  armor: {
    id: 'armor',
    name: 'Kevlar Vest',
    slot: 0,
    price: CONFIG.ECON.ARMOR_PRICE,
    gear: true,
  },
  kit: {
    id: 'kit',
    name: 'Defuse Kit',
    slot: 0,
    price: CONFIG.ECON.KIT_PRICE,
    gear: true,
  },
};

// ---------------------------------------------------------------------------
// Buy menu layout for the HUD.
// ---------------------------------------------------------------------------
export const BUY_MENU = [
  { category: 'Pistols', items: ['glock', 'usp', 'deagle'] },
  { category: 'SMG', items: ['mp5'] },
  { category: 'Rifles', items: ['ak47', 'm4a1', 'awp'] },
  { category: 'Gear', items: ['armor', 'kit'] },
  { category: 'Grenades', items: ['hegrenade', 'flashbang', 'smokegrenade'] },
];

// HUD convenience: resolves real weapons AND gear pseudo-items.
export function getItemDef(id) {
  return WEAPONS[id] || GEAR[id] || null;
}
