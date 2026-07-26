// ============================================================================
// TINY STRIKE — the weapon rack.
//
// Seven guns derived from three procedurally modelled platforms. Nothing here
// touches ballistics: damage, rate of fire, spread, recoil and price all stay
// in src/weapons/data.js, exactly as they were. This file decides only what
// each weapon LOOKS like.
//
// Everything is authored at real scale, in metres, with the origin at the
// shooting hand's grip anchor and the bore running down -Z — the same
// convention the previous GLB viewmodels used, which is what lets these drop
// into the existing rig and into the soldiers' hand bones unchanged.
// ============================================================================
import { buildRifle } from './models/rifle.js';
import { buildPistol } from './models/pistol.js';
import { buildAK } from './models/ak.js';
import { buildSniper } from './models/sniper.js';
import { buildMP5 } from './models/mp5.js';
import { buildDeagle } from './models/deagle.js';

export const WEAPON_MODELS = {
  // Flat-top carbine, free-float rail, tube red dot on a cantilever mount.
  m4a1: () =>
    buildRifle({ id: 'm4a1', label: 'M4A1-S', furniture: 'polymer' }),

  // Stamped receiver, gas tube over the barrel, wooden furniture, banana
  // magazine — a real AK, modelled as one (models/ak.js).
  ak47: () => buildAK(),

  // Roller-delayed 9 mm: slim cocking tube down the LEFT of the handguard, the
  // rotary drum rear sight, and the A2 fixed stock (models/mp5.js).
  mp5: () => buildMP5(),

  // Bolt action in a thumbhole chassis, 196 mm scope tube in two split rings
  // over an adjustable cheek riser (models/sniper.js).
  awp: () => buildSniper(),

  // Gas-operated .50 with the slab slide, the full-length barrel rail and the
  // gas cylinder under the barrel (models/deagle.js).
  deagle: () => buildDeagle(),

  // Suppressed .45 — the can is 148 mm of the 355 mm overall (14 mm of it
  // threaded down over the barrel), which is why it reads as a different weapon
  // from the Glock at a glance. `node tools/measure-weapons.mjs` is the source
  // of truth for that number; keep this comment in step with it.
  usp: () =>
    buildPistol({
      id: 'usp',
      label: 'USP-S',
      slideLen: 0.194,
      slideMat: 'steel_black',
      frameMat: 'polymer',
      suppressor: true,
      suppressorLen: 0.148,
    }),

  // Striker-fired polymer 9 mm.
  glock: () =>
    buildPistol({ id: 'glock', label: 'Glock-18', slideLen: 0.186, slideMat: 'steel_black' }),
};

export const PROCEDURAL_WEAPON_IDS = Object.keys(WEAPON_MODELS);

export function buildWeaponModel(id) {
  const make = WEAPON_MODELS[id];
  return make ? make() : null;
}
