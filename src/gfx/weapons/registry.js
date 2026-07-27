// ============================================================================
// TINY STRIKE — one weapon build, many instances.
//
// A rifle costs ~40 k triangles and 250 ms to assemble, and the same weapon is
// needed by the player's viewmodel and by every soldier carrying it. So each
// weapon is built exactly once into a template, and everything else is a clone:
// clones share geometry and materials, so a full server of bots costs draw
// calls, not memory.
//
// Templates are never added to a scene and never disposed — they are the
// prototype, and the session keeps them for as long as the material library
// they were built against lives.
// ============================================================================
import { WeaponMaterials } from './materials.js';
import { buildWeaponObject, collapseWeaponObject, resolveParts } from './build.js';
import { buildWeaponModel, PROCEDURAL_WEAPON_IDS } from './catalogue.js';

const templates = new Map(); // id -> { object, model }
/**
 * id -> THREE.Group | null — the merged third-person LOD.
 *
 * Built lazily off the full-detail template the first time a soldier asks for
 * that weapon, and, like `templates`, never disposed: `weaponInstance` hands out
 * clones that share this geometry, so freeing it would pull the guns out of the
 * hands of every bot currently carrying one. Both maps are dropped wholesale if
 * the material library is replaced, which only happens on a session teardown.
 */
const thirdPerson = new Map();
let materials = null;
let library = null;

function ensureMaterials(materialLibrary) {
  if (!materialLibrary) return null;
  if (!materials || library !== materialLibrary) {
    library = materialLibrary;
    materials = new WeaponMaterials(materialLibrary);
    templates.clear();
    thirdPerson.clear();
  }
  return materials;
}

/** Is there a procedural model for this weapon id? */
export function hasWeaponModel(id) {
  return PROCEDURAL_WEAPON_IDS.includes(id);
}

/**
 * The shared `WeaponMaterials` for a library.
 *
 * One instance per library, never two: a second would bake a second copy of
 * every texture and would miss the `envMapIntensity` occlusion factor `get()`
 * applies, so anything surfaced from it would sample the full sky while the gun
 * beside it samples half of it.
 *
 * (This also fed a procedurally modelled pair of first-person hands from the
 * `glove` / `glove_pad` / `glove_seam` / `sleeve` entries. That rig was rejected
 * — the viewmodel now uses the authored character's own arm — so those four
 * entries currently have no consumer. They are lazily baked, so an unused entry
 * costs nothing until something asks for it.)
 */
export function weaponMaterials(materialLibrary) {
  return ensureMaterials(materialLibrary);
}

/**
 * The prototype for a weapon. Built on first request.
 * @returns {{ object: THREE.Group, model: object } | null}
 */
export function weaponTemplate(id, materialLibrary) {
  if (!hasWeaponModel(id)) return null;
  const cached = templates.get(id);
  if (cached) return cached;
  const mats = ensureMaterials(materialLibrary);
  if (!mats) return null;

  let entry = null;
  try {
    const model = buildWeaponModel(id);
    if (model) entry = { model, object: buildWeaponObject(model, mats, { viewmodel: false }) };
  } catch (e) {
    console.warn(`[weapons] procedural build failed for ${id}`, e);
    entry = null;
  }
  templates.set(id, entry);
  return entry;
}

/**
 * The merged third-person prototype: one mesh per third-person material class,
 * every moving part baked in at its rest transform.
 *
 * Derived from the full-detail template, not rebuilt from the model, so it costs
 * a geometry copy and a weld rather than another 150-300 ms of chamfering and
 * mask baking. See `collapseWeaponObject`.
 *
 * @returns {THREE.Group | null}
 */
export function thirdPersonTemplate(id, materialLibrary) {
  if (thirdPerson.has(id)) return thirdPerson.get(id);
  const entry = weaponTemplate(id, materialLibrary);
  let merged = null;
  if (entry) {
    try {
      merged = collapseWeaponObject(entry.object, materials);
    } catch (e) {
      // A gun at 15 draw calls is far better than no gun in the hand, so a
      // failed collapse falls back to the full-detail template.
      console.warn(`[weapons] third-person collapse failed for ${id}`, e);
      merged = null;
    }
  }
  thirdPerson.set(id, merged);
  return merged;
}

/**
 * A fresh instance of a weapon, ready to parent into a scene graph.
 *
 * `viewmodel: true` clones the full-detail template — the animation layer drives
 * its slide, magazine and bolt by name through `userData.parts`, so those nodes
 * have to exist. Anything else clones the merged third-person template, which is
 * the same gun in a third of the draw calls because nothing animates its parts
 * from the outside.
 *
 * @param {string} id
 * @param {object} materialLibrary  game.materials
 * @param {object} opts  { viewmodel } — a viewmodel copy never casts shadows
 *                       and is never frustum culled (it lives at the camera)
 * @returns {THREE.Group | null}  with `userData.parts` resolved on the clone
 */
export function weaponInstance(id, materialLibrary, opts = {}) {
  const entry = weaponTemplate(id, materialLibrary);
  if (!entry) return null;
  const viewmodel = opts.viewmodel === true;
  const source = viewmodel ? entry.object : thirdPersonTemplate(id, materialLibrary) || entry.object;
  const copy = source.clone(true);
  copy.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = !viewmodel;
    o.receiveShadow = true;
    o.frustumCulled = !viewmodel;
  });
  copy.userData.parts = resolveParts(copy);
  copy.userData.model = entry.model;
  return copy;
}

/**
 * Triangle totals, for the boot log.
 *
 * Counts the full-detail templates only. The third-person copies share nothing
 * but the materials, so adding them in would report every gun twice and make the
 * budget line meaningless; `merged` reports them separately.
 */
export function weaponStats() {
  let tris = 0;
  let count = 0;
  for (const entry of templates.values()) {
    if (!entry) continue;
    tris += entry.object.userData.tris;
    count++;
  }
  let mergedTris = 0;
  let mergedCount = 0;
  let mergedMeshes = 0;
  for (const object of thirdPerson.values()) {
    if (!object) continue;
    mergedTris += object.userData.tris;
    mergedMeshes += object.children.length;
    mergedCount++;
  }
  return { tris, count, mergedTris, mergedCount, mergedMeshes };
}
