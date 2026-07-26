// The shadow map's coverage of the arena, asserted without a GPU.
//
// This exists because the failure it guards against is SILENT. A receiver that
// falls outside the directional light's ortho box does not render "unshadowed
// because there is no data here" — three's `getShadow()` initialises its result
// to 1.0 and only overwrites it inside the frustum, so the surface renders in
// FULL SUN. Nothing warns, nothing errors, and the frame looks plausible: it
// just has a corner of the map where a 10 m wall and a roof directly overhead
// cast nothing at all.
//
// It shipped that way. A ±40 m box was chosen for texel density and covered
// 79-94 % of each arena depending on the map and where the player stood, and the
// missing wedges were at the corners — measured on Citadel's north-west corner,
// 18.28 % of every pixel on screen was rendering in full sun that should have
// been in shadow. See the trade written up above `ARENA_MARGIN` in
// `src/gfx/sky/index.js`.
//
// So the invariant is asserted here rather than left to a review: for every
// shipped arena, at every sun angle the sky can produce, the fitted ortho
// contains the whole playable footprint.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { shadowFitExtents, SHADOW_ARENA_MARGIN } from '../src/gfx/sky/index.js';
import { WORLD_MAP_DEFINITIONS } from '../src/world/maps/registry.js';
import { SKY_PRESETS } from '../src/world/skies.js';
import { Celestial, SITE, dirFromAltAz } from '../src/gfx/sky/celestial.js';

const DEG = Math.PI / 180;

// The runaway guard in sky/index.js. Duplicated deliberately: if someone widens
// it there without a map that needs it, or adds a map that busts it, exactly one
// of these two tests fails and says which.
const GUARD = { x: 62, z: 54, y0: -8, y1: 34 };

// Dustyard is the one hand-built map with no entry in the registry, so its
// footprint comes from its own source (`src/world/map.js` builds it against
// x[-50,50] z[-40,40]) rather than from a `bounds` object. Wall heights and
// thicknesses are read off each map's own `perimeter(bounds, h, t, mat)` call.
const ARENAS = [
  { id: 'dustyard', theme: 'desert', bounds: { x0: -50, x1: 50, z0: -40, z1: 40 }, wall: 9.0, thick: 1.5 },
  ...Object.entries(WORLD_MAP_DEFINITIONS).map(([id, def]) => ({
    id,
    theme: def.theme?.key ?? def.themeKey ?? id,
    bounds: def.bounds,
    wall: id === 'citadel' ? 10.0 : id === 'neon_foundry' ? 9.0 : 8.5,
    thick: id === 'citadel' ? 1.8 : id === 'neon_foundry' ? 1.6 : 1.5,
  })),
];

/**
 * The box `_measureArena` would produce for this arena: the perimeter's outer
 * face (the boxes straddle the bounds line, so half the thickness sticks out),
 * the wall height, a metre under the floor for the ground plane, plus the
 * margin. MEASURED against the real thing in the browser, this is within 1 m of
 * the scene's own caster/receiver AABB on all five maps.
 */
function arenaBox(a) {
  const half = a.thick / 2;
  return new THREE.Box3(
    new THREE.Vector3(a.bounds.x0 - half, -1, a.bounds.z0 - half),
    new THREE.Vector3(a.bounds.x1 + half, a.wall, a.bounds.z1 + half)
  ).expandByScalar(SHADOW_ARENA_MARGIN);
}

/** The shadow camera the runtime builds from those extents, ready to project. */
function shadowCamera(box, dir) {
  const e = shadowFitExtents(box, dir, new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const cam = new THREE.OrthographicCamera(-e.x, e.x, e.y, -e.y, 1, 2 * e.z + 60);
  cam.up.set(...(Math.abs(dir.y) > 0.98 ? [0, 0, 1] : [0, 1, 0]));
  cam.position.copy(centre).addScaledVector(dir, e.z + 40);
  cam.lookAt(centre);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  return { cam, extent: e };
}

/**
 * Worst-case |ndc| over a grid on the playable footprint, at boot height and at
 * eye height. Anything over 1 on x or y is a surface that renders in full sun.
 */
function worstNdc(box, dir, bounds) {
  const { cam } = shadowCamera(box, dir);
  const m = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  const v = new THREE.Vector3();
  let worst = 0;
  for (let x = bounds.x0; x <= bounds.x1; x += 2) {
    for (let z = bounds.z0; z <= bounds.z1; z += 2) {
      for (const y of [0, 1.7]) {
        v.set(x, y, z).applyMatrix4(m);
        worst = Math.max(worst, Math.abs(v.x), Math.abs(v.y), Math.abs(v.z));
      }
    }
  }
  return worst;
}

/** The key direction each shipped preset actually runs, sun or moon. */
function shippedKeyDir(theme) {
  const preset = SKY_PRESETS[theme] ?? SKY_PRESETS.desert;
  const c = new Celestial({ ...SITE, ...preset.site }).setHour(preset.hour);
  // The renderer hands the shadow map to whichever body is brighter, which after
  // dark is the moon; altitude is the honest proxy here and it is only ever
  // ambiguous at twilight, where both are near the horizon and both are tested.
  return c.sunAlt > 0 ? c.sun.clone() : c.moon.clone();
}

test('every shipped arena is fully inside its own shadow ortho', () => {
  for (const a of ARENAS) {
    const box = arenaBox(a);
    const dir = shippedKeyDir(a.theme);
    const worst = worstNdc(box, dir, a.bounds);
    assert.ok(
      worst <= 1,
      `${a.id}: the playable footprint reaches |ndc| ${worst.toFixed(3)} in the shadow ` +
        'frustum, so part of it renders with shadow = 1.0 (full sun) instead of being ' +
        'shadowed at all'
    );
  }
});

test('the fit holds for any sun angle, not just the shipped hours', () => {
  // A day/night cycle (`sky.setTimeRate`) or a retimed preset must not be able to
  // open a hole. Every 15 degrees of azimuth, every 10 of altitude from the
  // lowest the clamp in `_placeLight` allows (0.34 deg) to overhead.
  for (const a of ARENAS) {
    const box = arenaBox(a);
    const dir = new THREE.Vector3();
    for (let altDeg = 0.35; altDeg < 90; altDeg += 10) {
      for (let azDeg = 0; azDeg < 360; azDeg += 15) {
        dirFromAltAz(altDeg * DEG, azDeg * DEG, 0, dir);
        const worst = worstNdc(box, dir, a.bounds);
        assert.ok(
          worst <= 1,
          `${a.id} at altitude ${altDeg} azimuth ${azDeg}: |ndc| ${worst.toFixed(3)} > 1`
        );
      }
    }
  }
});

test('the fitted box stays inside the runaway guard on every map', () => {
  // If this fails, a new map is larger than the guard in sky/index.js and part of
  // it would be clamped out of the shadow pass. Raise the guard there and
  // re-measure the texel table in the same comment.
  for (const a of ARENAS) {
    const box = arenaBox(a);
    assert.ok(
      box.min.x >= -GUARD.x && box.max.x <= GUARD.x,
      `${a.id}: x ${box.min.x}..${box.max.x} outside the ±${GUARD.x} m guard`
    );
    assert.ok(
      box.min.z >= -GUARD.z && box.max.z <= GUARD.z,
      `${a.id}: z ${box.min.z}..${box.max.z} outside the ±${GUARD.z} m guard`
    );
    assert.ok(
      box.min.y >= GUARD.y0 && box.max.y <= GUARD.y1,
      `${a.id}: y ${box.min.y}..${box.max.y} outside the ${GUARD.y0}..${GUARD.y1} m guard`
    );
  }
});

test('covering the whole arena still leaves a texel a crate can cast into', () => {
  // The point of fitting a RECTANGLE rather than a square: the up-beam extent is
  // the arena compressed by sin(altitude), so full coverage costs a factor of
  // 1.8, not the 2.6 a square box over the same diagonal would. 6 cm keeps a 2 m
  // crate over 30 texels on its short axis, which is where the previous ±78 m
  // square box (7.6 / 18.7 cm) failed.
  for (const a of ARENAS) {
    const box = arenaBox(a);
    const dir = shippedKeyDir(a.theme);
    const { extent } = shadowCamera(box, dir);
    const across = (2 * extent.x) / 3072;
    const alongGround = (2 * extent.y) / 3072 / Math.max(0.05, Math.abs(dir.y));
    assert.ok(
      across <= 0.06 && alongGround <= 0.06,
      `${a.id}: ground texel ${(across * 100).toFixed(2)} cm across the beam, ` +
        `${(alongGround * 100).toFixed(2)} cm along it — over the 6 cm budget`
    );
  }
});
