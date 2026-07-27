import * as THREE from 'three';

import { blit, hdrTarget } from './fullscreen.js';
import {
  ATMO,
  SCENE_LUX,
  SUN_ILLUMINANCE_TOP,
  MOON_ILLUMINANCE_NIGHT,
  transmittanceToSpace,
} from './atmosphere.js';
import { SkyLuts } from './luts.js';
import { SkyDome } from './dome.js';
import { Celestial, SITE } from './celestial.js';
import { cloudSunOcclusion } from './clouds.js';

/**
 * Floor on the beam's *luminous* transmittance, as a fraction of unity — see
 * the beam-floor note in `_updateCelestial`. 0.35 puts a 4-degree sun about a
 * stop of luminance under a noon sun (whose luminous transmittance is 0.77)
 * while leaving its physical hue untouched, which is what keeps a golden hour
 * reading as a key light instead of as an ambient wash.
 */
const SUN_LUM_FLOOR = 0.35;

/**
 * Gain on the sun's DIRECTIONAL LIGHT only — not on the irradiance the
 * atmosphere scatters, and not on the sky.
 *
 * This was 1.55, and it was paying an albedo deficit that has since been
 * measured and is mostly not there. The original argument was that the
 * photometric chain in atmosphere.js predicts a sunlit stucco wall at ~0.32
 * radiance units while a facade in the old 16:30 frame came back at 0.144 —
 * 1.1 stops under. The material forge has replaced those surfaces since.
 *
 * RE-MEASURED against the shipped materials, by rendering each map material on
 * a unit quad under a single white directional light of irradiance pi at normal
 * incidence, so the readback IS the albedo the shader produces (bake x tint x
 * the runtime macro, dust and grime layers). A white lambertian reference
 * reads 1.0000 on the same instrument.
 *
 *   dustyard wallN plaster   0.317 0.244 0.168   luminance 0.254
 *   dustyard wallA brick     0.136 0.087 0.066             0.096
 *   dustyard padWarm         0.200 0.192 0.171             0.192
 *   dustyard ground dirt     0.194 0.126 0.071             0.137
 *   dustyard sand            0.377 0.247 0.115             0.265
 *
 * Beam luminance on Dustyard is 3.5685 and the key's irradiance on a
 * sun-facing vertical wall is 3.2615 at unity gain, so that plaster renders at
 * 0.254 x 3.2615 / pi = 0.264 against the model's 0.32 — 0.28 stops under, not
 * 1.1. At 1.55 the same wall came out at 0.409, which is 0.35 stops OVER the
 * model: the gain had gone from under-paying a deficit to over-paying one.
 *
 * So: 1.0. What is left is 0.28 stops of albedo, it is 0.28 stops in the BAKE
 * (a lime plaster is 0.35-0.50 reflectance and this one is 0.25), and it
 * belongs to src/gfx/materials — not here. Paying it here is not even neutral:
 * `map.js` keys its global interior-floor AmbientLight off `sunLight.intensity`,
 * so every stop added to the key was also added to the largest single fill term
 * in the frame, and the key:fill ratio the gain was supposed to protect barely
 * moved. Measured on Dustyard, dropping 1.55 -> 1.0 costs the key 0.63 stops
 * and gives 0.63 stops back on that ambient.
 */
const SUN_KEY_GAIN = 1.0;

/**
 * The moon's half of SUN_KEY_GAIN, and for the same reason.
 *
 * MOON_ILLUMINANCE_NIGHT is 0.30 scene units — already four orders of magnitude
 * over a real full moon, because night is a graded convention, not a photometric
 * reading. But the indirect terms the world builds out of the published ambient
 * do not scale with the moon, they scale with the sky the moon lights, and the
 * flat interior ambient does not scale with anything. Measured at the foundry
 * that left the moon's beam at 0.15 against 0.26 of fill: the one directional
 * light in a night frame was HALF a stop under the ambient it was supposed to
 * shape, so nothing had a moon shadow, a rim, or a lit side.
 *
 * 4.0 puts it 1.0 stop over the fill and 1.6 under a neon practical at 6 m,
 * which is the order a night map wants: lamps key, moon shapes, sky fills. As
 * with the sun, the METER is deliberately held off it (see syncExposure) so the
 * gain moves the ratio and not the level — a night map metered off its own moon
 * would come back as an overcast afternoon.
 */
const MOON_KEY_GAIN = 4.0;

/**
 * Whole-sky diffuse illuminance as a fraction of the beam. Real clear-sky
 * daylight runs 12-18% of the direct component; this is the CPU stand-in the
 * renderer scales its sky-fill band off (see `ambientColor`).
 */
const SKY_AMBIENT_FRACTION = 0.15;

/** Cool night hue for the published ambient — moonlight after the Purkinje shift. */
const NIGHT_AMBIENT_HUE = [0.35, 0.5, 1.0];

/**
 * Moonlit-sky illuminance as a fraction of the moon's own beam.
 *
 * The daytime figure above is 0.15 and this used to be 0.9 — six times as
 * generous, on the argument that at night the sky is the only thing separating a
 * shadow from black. It is not: the maps that run at night have practicals and
 * neon, and the world scales its hemisphere fill off this number and then
 * multiplies by the 2.2 night indirect budget (map.js `_bounce`), so 0.9
 * published a fill that came out OVER the moon's own beam and a night frame with
 * its key 2.4 stops under its fill — no moon shadow, no rim, no lit side on
 * anything. A moonlit sky is a somewhat larger fraction of its own key than a
 * daylit one is — the moon is a small source in a big sky — but it is a
 * fraction, not a multiple. Measured at the foundry, 0.30 lands the sky fill at
 * 0.05 and the flat interior floor at 0.08 against a moon of 0.38 and neon
 * practicals of 0.5 to 2.5, which is the order those lamps were placed to be
 * seen in.
 */
const NIGHT_AMBIENT_FRACTION = 0.30;

// ---------------------------------------------------------------------------
//  Shadow fit
// ---------------------------------------------------------------------------

/**
 * HOW THE ONE SHADOW MAP IS SPENT — and why it is no longer spent on a sphere
 * following the player.
 *
 * There is one directional shadow map and a 104 x 84 m arena to put it on, and
 * exactly three ways to spend it. This file has now shipped two of them, so the
 * trade is written down instead of re-argued:
 *
 *  1. A SQUARE BOX FOLLOWING THE CAMERA — what this replaced. 3072^2 over a
 *     ±40 m box is 2.60 cm/texel, the best texel of the three, and it is still
 *     the wrong answer, because a receiver OUTSIDE the ortho does not get "no
 *     shadow map here" from three, it gets `shadow = 1.0`: full sun. What the
 *     box covers on the ground is an ellipse — 40 m across the beam, 40/sin(alt)
 *     = 98 m along it at 24 degrees — so the shortfall is entirely in the two
 *     corners on the across-beam axis. MEASURED, per cent of each arena's own
 *     footprint inside that box, on a 1 m grid at ground height, over nine
 *     camera placements (centre, both long axes, four corners):
 *
 *       harbor    79.1 - 83.8      frostline 78.6 - 85.4
 *       citadel   84.0 - 87.4      dustyard  91.2 - 94.3
 *       neon      98.9 - 100
 *
 *     i.e. up to 21 per cent of Harbor renders with no cast shadow in it at all,
 *     and it is at the corners, which is where the defuses happen. Top-down on
 *     Citadel the perimeter wall's own shadow band stops dead short of the
 *     north-west corner and the south-east tower casts nothing at all.
 *     (Neon is nearly covered by luck: its moon sits due west, so its
 *     across-beam axis is the map's 76 m short axis, which fits in ±40.)
 *
 *  2. A STATIC BOX FITTED TO THE ARENA — what this is now. The box is the
 *     scene's own caster/receiver AABB, projected onto the light's axes, so it
 *     is a RECTANGLE, not a square: the across-beam extent is the arena's
 *     diagonal but the up-beam extent is that diagonal compressed by sin(alt)
 *     plus the wall height by cos(alt). MEASURED per map (3072^2, ground texel,
 *     across the beam / along it, and the fraction of the footprint covered):
 *
 *       map        was                 now                     covered
 *       dustyard   2.60 / 6.42 cm      3.53 / 4.98 cm          91-94% -> 100%
 *       citadel    2.60 / 6.40         4.42 / 5.55             84-87% -> 100%
 *       harbor     2.60 / 6.41         4.58 / 5.29             79-84% -> 100%
 *       frostline  2.60 / 7.30         4.23 / 4.86             79-85% -> 100%
 *       neon       2.60 / 5.06         2.74 / 4.38             99-100% -> 100%
 *
 *     "Covered" is the fraction of the arena's own footprint inside the ortho, on
 *     a 1 m grid at ground height, and the 100 is 100 from all nine camera
 *     placements on all five maps, because the box no longer depends on the
 *     camera at all.
 *
 *     Across the beam it is up to 1.76x coarser; ALONG the beam it is finer on
 *     every map, because that is the axis the old square box was wasting. A 2 m
 *     crate's shadow is 44 x 38 texels instead of 77 x 31 — the smallest
 *     dimension it has anywhere went UP. Cost: every caster is now inside the
 *     frustum every frame, so none are culled out of the depth pass. MEASURED
 *     with `post.profile(60)` on Citadel, three interleaved A/B pairs at
 *     2560x1440: chain 13.59 / 14.71 / 13.74 ms fitted against 13.37 / 13.85 /
 *     13.26 square, i.e. about +0.3 ms on 13.4 — a third of the ±1.1 ms spread
 *     between repeats of the same configuration.
 *
 *     What it fixes, measured from the player's eye rather than from above:
 *     standing in Citadel's north-west corner looking in, the shadow term
 *     covered 32.75 % of the frame and now covers 51.01 % — 18.28 % of every
 *     pixel on screen went from "full sun" to "in shadow", and 0.02 % went the
 *     other way. The south-east corner is the same figure (21.06 -> 39.35 %,
 *     +18.35 / -0.04). That corner is a roofed timber deck, and what it looked
 *     like before is the review finding this rewrite answers: the roof directly
 *     overhead cast nothing, so the boards under it rendered in full afternoon
 *     sun. From the map centre the same comparison is +0.98 / -0.21 %, which is
 *     why this was easy to miss — the hole is only large when you are in it.
 *
 *  3. CASCADES. Two or more boxes need per-fragment cascade selection in the lit
 *     material's shader, which lives in `gfx/materials/shader.js`, and would buy
 *     a texel this arena size does not need: at 4.5 cm the limit on shadow
 *     detail here is the PCF kernel, not the grid.
 *
 * The static box also throws away two problems the moving one had: nothing
 * crawls (the box is nailed to world space, so no texel snapping is needed at
 * all), and shadow quality no longer depends on where the player happens to be
 * standing.
 */

/**
 * Metres of margin around the measured arena box.
 *
 * The box is measured off the scene rather than hard-coded per map, so a new
 * arena is covered without touching this file. MEASURED, the union AABB of every
 * shadow caster and receiver: dustyard 104 x 84 x 11.3, harbor 108 x 88 x 10.7,
 * frostline 104 x 84 x 9.7, citadel 104 x 88 x 12.2, neon 108 x 80 x 11.9. One
 * metre covers the half-thickness a perimeter box sticks out past the bounds it
 * was built from.
 */
const ARENA_MARGIN = 1.0;

/**
 * Runaway guard on the measured box, metres.
 *
 * One rogue mesh — a 500 m ground plane that someone flags `receiveShadow`, a
 * debug helper at the origin scaled by a thousand — would silently coarsen every
 * texel in the game, and a shadow map that quietly got worse is exactly the
 * class of bug this whole rewrite is fixing. The largest arena measures ±54 x
 * ±44 with a 1 m margin on top, so these leave about 13 per cent of headroom and
 * `_measureArena` says so in the console when they bind.
 */
const ARENA_MAX_X = 62;
const ARENA_MAX_Z = 54;
const ARENA_MIN_Y = -8;
const ARENA_MAX_Y = 34;

/**
 * Metres of caster headroom along the beam, above the top of the arena box, and
 * the pad past its far side.
 *
 * A caster can only darken the box if it is between the box and the light, and
 * the box already contains every static caster in the map by construction — this
 * is only the room a thrown grenade or a bot on the tallest roof needs. 40 m is
 * far more than any of that and it costs nothing: the frustum is bounded
 * LATERALLY by the fit, which is what culls; `near`/`far` only set the depth
 * range the bias is normalised against.
 */
const SHADOW_CASTER_HEADROOM = 40;
const SHADOW_DEPTH_PAD = 20;

/** Scratch for `shadowFitExtents`; it runs once per map load, never per frame. */
const _fitRight = new THREE.Vector3();
const _fitUp = new THREE.Vector3();
const _fitHalf = new THREE.Vector3();

/**
 * Half-extents of the shadow ortho that exactly contains `box` seen from `dir`.
 *
 * `out` comes back as (across the beam, up the beam, along the beam). An
 * axis-aligned box's support along a unit axis is the dot of its half-extents
 * with that axis' absolute components, so this is exact — the returned box is the
 * tightest one that contains all eight corners, not a bounding sphere.
 *
 * Exported because it is the whole coverage guarantee in four lines, and
 * `test/gfx-shadow-fit.test.mjs` asserts it against every shipped arena and every
 * shipped sun angle without needing a GPU.
 */
export function shadowFitExtents(box, dir, out) {
  const up = Math.abs(dir.y) > 0.98 ? UP_ALT : UP;
  const right = _fitRight.copy(up).cross(dir).normalize();
  const upv = _fitUp.copy(dir).cross(right);
  const h = box.getSize(_fitHalf).multiplyScalar(0.5);
  const support = (a) => h.x * Math.abs(a.x) + h.y * Math.abs(a.y) + h.z * Math.abs(a.z);
  return out.set(support(right), support(upv), support(dir));
}

/** Metres of margin the fit adds around a measured arena. See `_measureArena`. */
export const SHADOW_ARENA_MARGIN = ARENA_MARGIN;

/**
 * Depth bias and normal offset, in shadow texels.
 *
 * "The texel" is now the GEOMETRIC MEAN of the box's two texel sizes, because
 * the box is a rectangle: sqrt(2rx/N * 2ry/N). That is the one scaling that
 * leaves both offsets where they were measured when the fit changed shape —
 * the fitted rectangle trades across-beam precision for up-beam precision, so
 * its mean texel is 2.46-3.13 cm against the square box's flat 2.604.
 *
 * Both were absolute before that: `bias = -0.0004` over a near/far of 200..1000,
 * i.e. an 800 m depth range, which is 32 cm of depth pushed into every receiver.
 * With the sun at 21 degrees that detaches a shadow from its caster by
 * 32/tan(21) = 83 cm — a crate's shadow started a crate's width away from the
 * crate. Tying both to the texel instead means the frustum can be refitted
 * without retuning anything: 0.15 texels of depth on a 2.604 cm texel is 3.9 mm.
 *
 * ---------------------------------------------------------------------------
 * WHY THE DEPTH BIAS IS 0.15 AND THE NORMAL OFFSET IS 1.3
 * ---------------------------------------------------------------------------
 * Both offsets push the shadow along the light's axis, so on a floor they slide
 * the shadow away from its caster by `(depth + normal) / tan(altitude)`. At
 * 0.9 + 1.6 texels on a 2.604 cm texel that is 6.51 cm, and at Dustyard's
 * 23.94-degree sun **14.7 cm** of detachment — a bright band of sand between a
 * barrel and its own shadow, which is the "nothing in this map is grounded" the
 * critics led with. At Frostline's 20.91 degrees it was 17.0 cm.
 *
 * The two offsets do NOT buy the same thing, and that is the whole point:
 *
 *   - the NORMAL offset is slope-aware. It moves the sample point along the
 *     receiver's own normal, so it grows exactly where the depth gradient across
 *     a texel grows, and it is what actually suppresses acne.
 *   - the DEPTH bias is a flat constant in normalised depth. It cannot know the
 *     slope, so it has to be sized for the worst receiver in the scene, and
 *     everywhere else it is pure peter-panning tax.
 *
 * The instrument, unchanged from when 0.15 was chosen: render the frame twice,
 * once with the key light casting and once with `castShadow = false`, and divide
 * — that is the shadow term per pixel with no material or exposure term in it.
 * "Spurious" is a shadowed pixel more than 10 px from anything already shadowed
 * at a deliberately over-biased 3.0/1.8 reference, i.e. one that cannot belong to
 * a real terminator. MEASURED on the 20 m top-down (the eye-level view reads 0.000
 * for every row below, on every map — nothing there is acne-prone), with the
 * fitted box above:
 *
 *   normal   frostline            harbor               citadel
 *            gap      spurious    gap      spurious    gap      spurious
 *   1.6      12.42 cm  0.016 %    12.35 cm  0.005 %    12.42 cm  0.312 %
 *   1.3      10.29     0.022      10.23     0.006      10.29     0.366
 *   1.1        8.87    0.177        8.82    0.068        8.87    0.384
 *   0.9        7.45    0.500        7.41    0.672         —        —
 *
 * The knee is at 1.1: one row below it the spurious rate goes up an order of
 * magnitude on both of the acne-prone maps (Frostline is flat 0.75-albedo snow
 * with drift relief in it; Harbor is a flat wet quay). 1.3 sits one row above the
 * knee at 1.4x the speckle of 1.6, and buys back everything the bigger box cost.
 * Contact gap, MEASURED before -> after, i.e. ±40 m square at 1.6 texels ->
 * fitted box at 1.3:
 *
 *   dustyard 10.27 -> 8.73 cm    citadel 10.23 -> 10.29    harbor 10.26 -> 10.23
 *   frostline 11.93 -> 10.29     neon      7.58 ->  6.00
 *
 * So the whole arena gets a cast shadow AND nothing in the game peter-pans worse
 * than it did — three maps improve, two are inside 0.06 cm. (Citadel's spurious
 * rate is 0.31-0.38 % at every row, barely moving with the offset: that map is
 * stepped stone and most of what the metric counts there is real terminator too
 * fine for the reference to have dilated over, not acne.)
 *
 * The residual ~8 cm is the normal offset alone (3.5 cm / tan 24). Buying it back
 * means a smaller texel — a 4096 map is 134 MB with its depth buffer against 76 —
 * and it is not worth 3 cm; a contact-shadow or AO pass is, and the AO pass now
 * exists (`gfx/post/ssao.js`).
 */
const SHADOW_DEPTH_BIAS_TEXELS = 0.15;
const SHADOW_NORMAL_BIAS_TEXELS = 1.3;

// ---------------------------------------------------------------------------
//  Metering limits
// ---------------------------------------------------------------------------

/**
 * Hard stops on `toneMappingExposure`. See `syncExposure` for what sets the
 * value between them.
 *
 * These are a RUNAWAY GUARD, not a grade. They used to be [0.45, 1.55] and the
 * ceiling was doing grading work without saying so: measured, Neon Foundry
 * meters at 2.053 and was being served 1.55, so 0.41 EV of the night look was
 * coming out of a clamp rather than out of `exposureBias` — silently, with
 * nothing in the console and no way to tell a deliberately dark night from a
 * metering bug. The daylight maps meter at 0.64-0.66, and the brightest beam
 * any preset can produce (zenith sun, turbidity 1.0, luminance 4.39) meters at
 * 0.524, so the old floor sat a tenth of a stop under the brightest sky in the
 * game.
 *
 * [0.35, 2.0] puts half a stop of air under the floor and leaves the night's
 * darkness where it can be read and argued with — `exposureBias` contributes
 * 0.55 EV of it after dark, on purpose, in a constant with a comment on it.
 * When a clamp does bind, `syncExposure` says so.
 *
 * The ceiling then started binding again, for a different reason: REF_KEY went
 * 2.3 -> 3.4 to put the level back after the key gain and the indirect budget
 * were both cut, and that scales every metered exposure by 1.48. MEASURED at the
 * foundry: metered 2.292 against a ceiling of 2.0, i.e. 0.20 EV of the night's
 * darkness silently coming out of a clamp again — the exact failure the widened
 * range was opened to stop. With the ground-albedo term below the foundry meters
 * at 3.67, so the guard is 4.0: nothing any shipped preset can reach, which is
 * the only thing a runaway guard should be.
 */
const EXPOSURE_MIN = 0.35;
const EXPOSURE_MAX = 4.0;

/**
 * Ground-albedo metering: reference reflectance, and how much of the difference
 * from it is paid back as exposure compensation.
 *
 * `syncExposure` meters off the KEY LIGHT — it opens up until a surface in full
 * key lands in the same place on the tone curve at any hour. That is the right
 * film speed for a day/night cycle and the wrong one for five maps whose ground
 * reflectance spans 14x, because the beam does not know what it is falling on.
 * MEASURED with the same key at each preset's own hour, Rec.709 luminance of the
 * sunlit ground, sRGB code value out of 255 (`keyFill` on three 32 m top-downs):
 *
 *   map        ground albedo   lit ground   shaded ground
 *   dustyard       0.350        106-125         40-65
 *   citadel        0.288         80-99          36-42
 *   harbor         0.132         57-74          28-45
 *   frostline      0.751        150-194        148-150   <- on the ACES shoulder
 *   neon (night)   0.053         18-31          1.3-7.5  <- crushed to black
 *
 * Frostline is the clearest read: a 0.75 snowfield metered to the same key as a
 * 0.35 sand yard lands its ground at 150-194, which is over the knee, and a full
 * stop of shadow there compresses into 44 code values. Harbor is the same error
 * with the sign flipped — a 0.13 wet-concrete quay comes out at 57-74, two thirds
 * of a stop under the desert. Every stills photographer meters the SCENE and
 * opens up for a coal cellar and stops down for snow; the ground albedo is the
 * one honest proxy for scene reflectance this system already has (it is passed in
 * per preset for the sky's own first bounce, see skies.js `groundAlbedo`).
 *
 * REF is Dustyard's own 0.350, so the desert is unchanged BY CONSTRUCTION — that
 * is the map REF_KEY was measured on and its numbers must not move underneath it.
 *
 * The weight is 0.5, not 1.0, because the ground is about half of what a frame at
 * eye level actually contains; the walls, props and sky carry the rest and they
 * do not scale with it. At 0.5 the compensation is, in EV (+ is stop down):
 * dustyard 0.00, citadel -0.14, harbor -0.71, frostline +0.55, neon -1.36.
 *
 * Night runs at half that again (0.25 weight): after dark the practicals and the
 * neon are most of the light in the frame, and they are absolute — they do not
 * care what the beam is or what the ground returns — so only the moonlit half of
 * a night frame is the ground's to argue about. The foundry still gets -0.68 EV
 * of it, which is what takes its yard off 18/255.
 */
const METER_GROUND_ALBEDO = 0.35;
const ALBEDO_METER_WEIGHT_DAY = 0.5;
const ALBEDO_METER_WEIGHT_NIGHT = 0.25;

const UP = new THREE.Vector3(0, 1, 0);
/** lookAt degenerates when the light is within ~11 degrees of the camera up. */
const UP_ALT = new THREE.Vector3(0, 0, 1);

/**
 * Sky, atmosphere and global lighting.
 *
 * Ported from the OVERWATCH engine and adapted to Tiny Strike: the atmosphere,
 * LUTs, dome, clouds and starfield are unchanged; the raymarched volumetrics
 * are not ported (we keep three.Fog, coloured from this sky by `applyFogTo`),
 * and the class is constructed directly with a renderer/scene/camera instead of
 * through a subsystem registry.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS OWNS
 * ---------------------------------------------------------------------------
 *   - A Hillaire/Bruneton atmosphere (Rayleigh + Mie + ozone + multiple
 *     scattering) evaluated through three LUTs, drawn as a full-screen dome
 *     with a limb-darkened solar disc and an analytic circumsolar aureole that
 *     restores the Mie forward peak the LUT resolution destroys.
 *                                                               dome.js luts.js
 *   - Sun and moon positions from real spherical astronomy.       celestial.js
 *   - A starfield with a magnitude power law, blackbody colours, airmass
 *     extinction, scintillation, and a Milky Way with dust lanes.     stars.js
 *   - Two procedural cloud decks, self-shadowed and correctly lit.   clouds.js
 *   - A PMREM environment map regenerated from the sky whenever the sun moves
 *     meaningfully, published as `scene.environment` — the image-based light
 *     that replaced the maps' hemisphere+ambient pair.
 *   - The sun/moon `DirectionalLight`s, one of which casts the single shadow
 *     map — fitted to the whole arena as a rectangle in the light's own axes, so
 *     no part of any map is silently shadowless.       _fitShadow _measureArena
 *
 * ---------------------------------------------------------------------------
 * PUBLIC API — `game.world.sky`
 * ---------------------------------------------------------------------------
 *   sky.setTimeOfDay(hours)      0..24, local solar time. Rebakes everything.
 *   sky.timeOfDay                current hour
 *   sky.setTimeRate(hoursPerSec) animate the sun (0 = frozen; default 0)
 *   sky.sunDirection             Vector3 pointing AT the sun   (read only)
 *   sky.moonDirection            Vector3 pointing AT the moon  (read only)
 *   sky.sunAltitude              radians above the horizon
 *   sky.keyLight                 whichever of sun/moon the cascades follow
 *   sky.sunLight  sky.moonLight  THREE.DirectionalLight
 *   sky.envMap                   the PMREM currently published
 *   sky.ambientColor             Color, approximate whole-sky tint AND level:
 *                                the sky's own model of whole-sky irradiance
 *                                (15% of the beam by day, moonlit at night).
 *                                The renderer scales its sky-fill band off it.
 *   sky.indirectScale            indirect-light budget for the current sun
 *                                elevation: ~0.45 at golden hour, 1 by day, 2.2
 *                                after dark. See _updateCelestial. The world
 *                                multiplies its hemisphere fill by this.
 *   sky.exposureBias             EV of metering compensation for this sun
 *                                elevation (+ is darker). `render` adds it to
 *                                settings.exposureBias.
 *   sky.cloudShadowAt(x, z)      0..1 direct sunlight reaching a ground point
 *   sky.setWeather({ ... })      coverage, cirrus, turbidity, windSpeed, windAngle
 *   sky.applyFogTo(scene, ...)   three.Fog coloured from the current sky
 *
 * Events emitted on the game bus:
 *   `sky:changed`  { hour, sunDir, sunIntensity, moonIntensity }  time changed
 *   `sky:env`      { envMap, sunDir }                             IBL rebaked
 *
 * ---------------------------------------------------------------------------
 * COST
 * ---------------------------------------------------------------------------
 * Measured at 1920x1080, ultra, headless ANGLE/Metal on an Apple silicon laptop, in a scene
 * of ~7M triangles and ~1300 draw calls:
 *
 *   sky dome (one full-screen pass, LUT lookups)   ~0.9 ms
 *
 * The LUTs, the ambient probe and the PMREM only run when the sun has moved
 * more than 0.35 degrees, so a frozen time of day pays none of that. With
 * `setTimeRate` running, the sky-view LUT rebakes a few times a second
 * (~0.6 ms) and the PMREM at most every 250 ms.
 */
export class SkySystem {
  /**
   * Tiny Strike drives this directly rather than through a subsystem registry.
   *
   * @param {object} opts
   *   renderer  THREE.WebGLRenderer — must be the one drawing the frame
   *   scene     the world scene; the dome and the sun/moon lights are added to it
   *   camera    the player camera
   *   events    optional EventBus for `sky:changed` / `sky:env`
   *   quality   'low' | 'high' — low drops the star field and halves the IBL
   *   exposure  renderer.toneMappingExposure, so the dome tone maps like
   *             everything else (we render straight to the 8-bit canvas, and a
   *             ShaderMaterial gets no tone mapping injected for it)
   */
  constructor(opts) {
    this.renderer = opts.renderer;
    this.scene = opts.scene;
    this.camera = opts.camera;
    this.events = opts.events ?? null;
    this.quality = opts.quality ?? 'high';
    this._elapsed = 0;

    // Merge, never replace: a preset that names only a latitude must keep the
    // default lunar orbit, or the moon's altitude comes out NaN and takes the
    // published ambient colour (and therefore the fog) with it.
    this.celestial = new Celestial({ ...SITE, ...(opts.site ?? {}) });
    this.hour = opts.hour ?? 16.5;
    this.timeRate = 0;
    this.debug = opts.debug ?? false;

    // ---- weather / atmosphere state ---------------------------------------
    this.weather = {
      /** Aerosol multiplier. 1 clear, 2-3 hazy, 5 dust storm. */
      turbidity: 1.35,
      /** Fewer, deeper cumulus. Below ~0.34 the deck breaks into discrete
       *  masses with clean blue between them instead of one lumpy sheet. */
      cloudCoverage: 0.30,
      /** Raised with the coverage drop: a cloud that survives the erosion is
       *  now optically deep, so its self-shadowed base sits 2-3 stops under its
       *  sunlit top and the billow reads as a solid with volume. */
      cloudDensity: 1.9,
      /**
       * Cirrus is banded, not a glaze. Coverage and opacity both came down here
       * because the sky behind them is now 1.65 stops darker (see the photometric
       * note in atmosphere.js) while the decks, which were always on the correct
       * scale, did not move — so the layer gained that much contrast against the
       * blue for free and at the old settings it dominated the upper half of every
       * daylight frame and read as hatching.
       */
      cirrusCoverage: 0.21,
      cirrusOpacity: 0.30,
      windSpeed: 0.0042, // km/s at the cloud deck (~4 m/s)
      windAngle: 0.7,
      horizonMurk: 0.13,
      /**
       * The land beyond the arena: [skyline height in sin(elevation), skyline
       * detail in cycles per turn, albedo variation, haze scale in metres].
       * Carried in `weather` rather than as its own constructor option because
       * that is the bundle the world hands over on every map switch, so a per-map
       * horizon reaches the dome through the path that already exists.
       */
      horizon: [0.038, 3.5, 0.35, 16000],
      ...(opts.weather ?? {}),
    };

    // ---- shared uniform objects -------------------------------------------
    // Every pass and the dome reference these same objects, so one write per
    // frame updates the entire subsystem. Same trick render/materialpatch uses.
    const viewR = ATMO.groundRadiusMM + ATMO.viewAltitudeMM;
    this.shared = {
      uMieScale: { value: this.weather.turbidity },
      uViewPos: { value: new THREE.Vector3(0, viewR, 0) },

      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
      uSunIrradiance: { value: new THREE.Vector3() },
      uMoonIrradiance: { value: new THREE.Vector3() },
      uSunDiscRadiance: { value: new THREE.Vector3() },
      uMoonDiscRadiance: { value: new THREE.Vector3() },
      uSunAltitude: { value: 0 },
      uMoonAltitude: { value: 0 },
      uMoonRelAz: { value: 0 },
      // x/y are the true angular radii of the sun and moon; z/w scale them up for
      // readability. 3.0 puts the solar disc at 1.6 degrees across — a 22 pixel
      // dot in a 75-degree frame, which is the smallest that still reads as a disc
      // rather than as a hot pixel once the bloom prefilter has clamped it.
      // skSunDisc divides by z*z so enlarging it adds no energy.
      uDisc: { value: new THREE.Vector4(0.004654, 0.004516, 3.0, 4.2) },
      // Lower hemisphere of the IBL. This town is sand and lime plaster, not
      // asphalt: a 0.32 warm albedo is both correct for the setting and the
      // only warm fill a shaded alley gets once the sun is off it.
      uGroundAlbedo: {
        value: new THREE.Vector3().fromArray(opts.groundAlbedo ?? [0.33, 0.29, 0.225]),
      },
      uHorizonMurk: { value: this.weather.horizonMurk },
      // What is beyond the perimeter wall: skyline height (sin of elevation),
      // skyline detail (cycles per turn of azimuth), albedo variation on the
      // plain, and the haze scale in metres. Written by _applyWeather from
      // `weather.horizon`; see skSkyline / skGround in dome.js and the per-map
      // values in world/skies.js.
      uHorizon: { value: new THREE.Vector4() },
      // Sky highlight roll-off: knee in scene radiance, overshoot room above it.
      // Driven off the beam luminance every time the sun moves — see skRolloff.
      uSkyRolloff: { value: new THREE.Vector2(0.30, 1.5) },

      uStarParams: { value: new THREE.Vector4(0, 0.5, 0, 0) },
      uCelestial: { value: new THREE.Matrix3() },

      uCloudParams: {
        value: new THREE.Vector4(
          this.weather.cloudCoverage,
          this.weather.cloudDensity,
          1,
          0
        ),
      },
      uCloudParams2: {
        value: new THREE.Vector4(
          this.weather.cirrusCoverage,
          this.weather.cirrusOpacity,
          0.004,
          0.0016
        ),
      },

      // camera (the dome rebuilds its ray basis from these)
      uInvProj: { value: new THREE.Matrix4() },
      uCamWorld: { value: new THREE.Matrix4() },
      uCamPos: { value: new THREE.Vector3() },
      // The dome tone maps itself — Tiny Strike renders straight to the canvas.
      uOutputExposure: { value: opts.exposure ?? 1 },
    };

    // ---- LUTs -------------------------------------------------------------
    this.luts = new SkyLuts(this.renderer, this.shared);
    this.luts.bakeStatic();

    // ---- visible sky ------------------------------------------------------
    this.dome = new SkyDome(this.shared, { baked: opts.bakedDome !== false });
    this.scene.add(this.dome.mesh);
    // We paint the sky ourselves; drop any fallback background so it is not
    // drawn underneath us every frame for nothing.
    this.scene.background = null;

    // ---- lights -----------------------------------------------------------
    // We have one shadow map, not cascades, so whichever body is the key light
    // casts it — see _applyLightIntensities — and it is fitted to the ARENA, not
    // to the player (see the trade above `ARENA_MARGIN`, and `_fitShadow`).
    //
    // 3072 on desktop, 2048 on a phone. 3072 is 76 MB with its depth buffer
    // against 34 MB, and it is worth it here because the fit is a rectangle
    // rather than a square: 2.7-4.5 cm across the beam and 4.4-5.5 cm along it,
    // against the 7.6 / 18.7 cm of the ±78 m square box this was ported with.
    this._shadowMapSize = Math.min(
      this.quality === 'low' ? 2048 : 3072,
      this.renderer.capabilities.maxTextureSize
    );
    /**
     * The box the shadow map is spent on: every shadow caster and receiver in
     * the arena, measured off the scene by `_measureArena`. It starts as the
     * runaway-guard box, which is a superset of every shipped arena — so the
     * frames between construction and the first measurement are coarse, never
     * uncovered.
     */
    this._arenaBox = new THREE.Box3(
      new THREE.Vector3(-ARENA_MAX_X, ARENA_MIN_Y, -ARENA_MAX_Z),
      new THREE.Vector3(ARENA_MAX_X, ARENA_MAX_Y, ARENA_MAX_Z)
    );
    this._arenaDirty = true;
    /** Preallocated fit state — `_fitShadow` runs every frame. */
    this._fitCentre = new THREE.Vector3();
    this._sExtent = new THREE.Vector3();
    this._sHalf = new THREE.Vector3();
    this._sBox = new THREE.Box3();
    this._sCorner = new THREE.Vector3();

    this.sunLight = new THREE.DirectionalLight(0xffffff, 4.0);
    this.sunLight.name = 'sky-sun';
    this.sunLight.target.name = 'sky-sun-target';
    this._configureShadow(this.sunLight, true);
    this.scene.add(this.sunLight, this.sunLight.target);

    this.moonLight = new THREE.DirectionalLight(0x9fc0ff, 0.0);
    this.moonLight.name = 'sky-moon';
    this._configureShadow(this.moonLight, false);
    this.scene.add(this.moonLight, this.moonLight.target);

    this.keyLight = this.sunLight;

    // ---- IBL --------------------------------------------------------------
    // Equirect -> PMREM at cube size 128, which is what three's own equirect
    // environments use. Baked from the *same* shader and the *same* uniform
    // objects as the visible sky, so the IBL can never disagree with it.
    /**
     * One equirect serves two jobs: it is the source the PMREM is built from,
     * and — when the dome is in baked mode — it IS the visible sky. That is why
     * it is 2048x1024 rather than the 512x256 an IBL alone would need: it is
     * magnified straight onto a 2560-wide frame, and at 512 the horizon band
     * lands on ~1.4 texels per degree and the cloud edges stair-step visibly.
     * The 1.4-degree skyline skGround draws needs that resolution too.
     */
    const envW = this.quality === 'low' ? 512 : 2048;
    this.envEquirect = hdrTarget(envW, envW / 2, { name: 'sky-equirect' });
    this.envEquirect.texture.mapping = THREE.EquirectangularReflectionMapping;
    this.envEquirect.texture.minFilter = THREE.LinearFilter;
    this.envEquirect.texture.generateMipmaps = false;
    this.dome.uniforms.uSkyTex.value = this.envEquirect.texture;
    /** Seconds between visible-sky re-blits; the cloud deck drifts at ~4 m/s. */
    this._skyTexInterval = this.quality === 'low' ? 0.8 : 0.4;
    this._skyTexAge = 1e9;
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.pmrem.compileEquirectangularShader();
    this._pmremTarget = null;
    this.envMap = null;

    // ---- bookkeeping ------------------------------------------------------
    this.ambientColor = new THREE.Color(0, 0, 0);
    /** Indirect-light budget for this sun elevation, 0..1. See _updateCelestial. */
    this.indirectScale = 1;
    /** EV of exposure compensation for this sun elevation; + is darker. */
    this.exposureBias = 0;
    this._beamGain = 1;
    this._beamLuminance = 0;
    this._sunT = [0, 0, 0];
    this._moonT = [0, 0, 0];
    this._envSunDir = new THREE.Vector3(0, -1, 0);
    this._cloudOcclusion = 1;
    this._cloudOccTarget = 1;
    this._baseSunIntensity = 0;
    this._baseMoonIntensity = 0;
    this._envAge = 1e9;
    /** '' | 'floor' | 'ceiling' — which stop the meter is currently sitting on. */
    this._exposureBind = '';
    this._skyDirty = true;
    this._envDirty = true;
    this._cloudTime = 0;
    this._occParams = { coverage: 0, density: 0, windX: 0, windZ: 0, time: 0 };

    // The arena the shadow box is fitted to is rebuilt on every map load, and
    // `map:changed` is the last thing `world.loadMap` emits — after the solids
    // and the dressing are in the scene with their matrices updated, which is
    // exactly what `_measureArena` needs to read.
    this._offMapChanged = this.events?.on?.('map:changed', () => {
      // Back to the superset until the new arena has been measured, so the
      // "coarse, never uncovered" promise on `_arenaBox` holds across a map
      // change too — the previous map's box can be SMALLER on an axis than the
      // incoming one (neon is ±41 on Z where citadel is ±45).
      this._arenaBox.min.set(-ARENA_MAX_X, ARENA_MIN_Y, -ARENA_MAX_Z);
      this._arenaBox.max.set(ARENA_MAX_X, ARENA_MAX_Y, ARENA_MAX_Z);
      this._arenaDirty = true;
    });

    this._applyWeather();
    this.setTimeOfDay(this.hour);
    this.syncExposure();

    console.info(
      `[sky] atmosphere ready · lat ${this.celestial.site.latitudeDeg} · ` +
        `1 unit = ${SCENE_LUX} lx · shadow ${this._shadowMapSize}^2, ` +
        `fitted to the arena (see _fitShadow)`
    );
  }

  /**
   * One shadow map, fitted to the arena.
   *
   * Only the key light casts; the other one is switched off — and has its map
   * released — so a moonlit map never pays for two shadow passes or holds two
   * 34-76 MB targets. Everything that does not depend on the light's DIRECTION
   * is set once here; the box itself is `_applyShadowFit`, because its shape is
   * the arena seen from wherever the sun is.
   */
  _configureShadow(light, enabled) {
    light.castShadow = enabled;
    light.shadow.mapSize.set(this._shadowMapSize, this._shadowMapSize);
    /** Direction toward the body, clamped off the horizon. Written by _placeLight. */
    light.userData.fitDir = new THREE.Vector3(0, 1, 0);
    /** Last fitted half-extents, so a frozen sun refits the projection once. */
    light.userData.fitExtent = new THREE.Vector3(0, 0, 0);
    this._applyShadowFit(light);
  }

  /**
   * Measure the arena: the union AABB of every shadow caster and receiver.
   *
   * Casters AND receivers, because both failure modes are silent. A caster
   * outside the box is clipped out of the depth pass and stops casting; a
   * receiver outside it reads `shadow = 1.0` and renders in full sun. MEASURED,
   * the two boxes are within about a metre of each other on all five maps (the
   * receiving ground plane runs to the outer face of the perimeter, the casting
   * walls to its centre line), which is what `ARENA_MARGIN` is sized for.
   *
   * Runs once per map load — a `map:changed` sets `_arenaDirty` — and walks ~400
   * to 530 merged meshes to do it. Nothing here is per-frame.
   */
  _measureArena() {
    const box = this._sBox.makeEmpty();
    const v = this._sCorner;
    // `world.loadMap` updates its own two groups before it says `map:changed`,
    // but a caster parented anywhere else would be measured off a stale matrix.
    // Once per map load, so the walk costs nothing worth saving.
    this.scene.updateMatrixWorld();
    this.scene.traverse((o) => {
      if (!o.isMesh || !o.geometry || !(o.castShadow || o.receiveShadow)) return;
      const g = o.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      const bb = g.boundingBox;
      if (!bb || !Number.isFinite(bb.min.x) || bb.isEmpty()) return;
      for (let i = 0; i < 8; i++) {
        v.set(
          i & 1 ? bb.max.x : bb.min.x,
          i & 2 ? bb.max.y : bb.min.y,
          i & 4 ? bb.max.z : bb.min.z
        ).applyMatrix4(o.matrixWorld);
        box.expandByPoint(v);
      }
    });
    // No geometry yet (the sky is built before the map it stands over). Stay
    // dirty and keep the guard box, which covers everything, until there is.
    if (box.isEmpty()) return;

    box.expandByScalar(ARENA_MARGIN);
    const bound =
      box.min.x < -ARENA_MAX_X ||
      box.max.x > ARENA_MAX_X ||
      box.min.z < -ARENA_MAX_Z ||
      box.max.z > ARENA_MAX_Z ||
      box.min.y < ARENA_MIN_Y ||
      box.max.y > ARENA_MAX_Y;
    box.min.x = Math.max(box.min.x, -ARENA_MAX_X);
    box.max.x = Math.min(box.max.x, ARENA_MAX_X);
    box.min.z = Math.max(box.min.z, -ARENA_MAX_Z);
    box.max.z = Math.min(box.max.z, ARENA_MAX_Z);
    box.min.y = Math.max(box.min.y, ARENA_MIN_Y);
    box.max.y = Math.min(box.max.y, ARENA_MAX_Y);
    if (bound) {
      // Not fatal, but it means something in the scene is far larger than an
      // arena and whatever is past the clamp now casts and receives nothing.
      console.warn(
        '[sky] arena box hit the runaway guard — a caster or receiver is outside ' +
          `±${ARENA_MAX_X} x ±${ARENA_MAX_Z} m or outside y ${ARENA_MIN_Y}..${ARENA_MAX_Y}; ` +
          'shadows are clipped to the guard box'
      );
    }
    this._arenaBox.copy(box);
    this._arenaDirty = false;

    if (this.debug) {
      const s = this._sHalf;
      box.getSize(s);
      console.info(
        `[sky] arena ${s.x.toFixed(1)} x ${s.z.toFixed(1)} x ${s.y.toFixed(1)} m`
      );
    }
  }

  /**
   * Fit the ortho box to the arena for this light's direction, and retune both
   * biases to the texel that comes out of it.
   *
   * The box is the arena AABB projected onto the light's own three axes — an
   * axis-aligned box's support along a unit axis is just the dot of its
   * half-extents with the axis' absolute components — so it is a RECTANGLE whose
   * up-beam extent shrinks as the sun drops. That is the whole reason the whole
   * arena is affordable: see the table above `ARENA_MARGIN`.
   *
   * Nothing depends on the camera, so nothing here crawls, and no texel snapping
   * is needed: the box is nailed to world space and only moves if the sun does.
   */
  _applyShadowFit(light) {
    const dir = light.userData.fitDir;
    const cam = light.shadow.camera;
    // The same basis three's own lookAt builds inside LightShadow: with the eye
    // at target + dir, z is dir, x is cross(up, z), y is cross(z, x). `up` has to
    // be handed to the shadow camera as well, or three builds a different basis
    // than the one the extents were solved in.
    cam.up.copy(Math.abs(dir.y) > 0.98 ? UP_ALT : UP);

    const c = this._arenaBox.getCenter(this._fitCentre);
    const e = shadowFitExtents(this._arenaBox, dir, this._sExtent);
    const rx = e.x;
    const ry = e.y;
    const rd = e.z;

    // Rebuilding the projection is only free if it is rare. Every shipped preset
    // has a frozen sun, so this runs once per map load; `setTimeRate` animating
    // the sun is what the 1 mm threshold is for.
    const last = light.userData.fitExtent;
    if (
      Math.abs(last.x - rx) > 1e-3 ||
      Math.abs(last.y - ry) > 1e-3 ||
      Math.abs(last.z - rd) > 1e-3
    ) {
      last.set(rx, ry, rd);
      cam.left = -rx;
      cam.right = rx;
      cam.top = ry;
      cam.bottom = -ry;
      // Everything from just under the light down to the far side of the box.
      // The range is ~200 m rather than the 800 m it was ported with, which is
      // what makes the bias below a centimetre figure instead of a third of a
      // metre.
      cam.near = 1;
      cam.far = rd + SHADOW_CASTER_HEADROOM + rd + SHADOW_DEPTH_PAD;
      cam.updateProjectionMatrix();

      const n = this._shadowMapSize;
      const texel = Math.sqrt(((2 * rx) / n) * ((2 * ry) / n));
      light.shadow.bias = -(SHADOW_DEPTH_BIAS_TEXELS * texel) / (cam.far - cam.near);
      light.shadow.normalBias = SHADOW_NORMAL_BIAS_TEXELS * texel;
    }

    light.position.copy(c).addScaledVector(dir, rd + SHADOW_CASTER_HEADROOM);
    light.target.position.copy(c);
    light.updateMatrixWorld(true);
    light.target.updateMatrixWorld(true);
  }

  /** Per-frame entry point: measure the arena if it changed, then fit to it. */
  _fitShadow() {
    const light = this.sunLight.castShadow ? this.sunLight : this.moonLight;
    if (!light.castShadow) return;
    if (this._arenaDirty) this._measureArena();
    this._applyShadowFit(light);
  }

  // =========================================================================
  //  public API
  // =========================================================================

  get timeOfDay() {
    return this.hour;
  }
  get sunDirection() {
    return this.celestial.sun;
  }
  get moonDirection() {
    return this.celestial.moon;
  }
  get sunAltitude() {
    return this.celestial.sunAlt;
  }

  /** Hour of day, 0..24 local solar time. Rebakes the sky and the IBL. */
  setTimeOfDay(hours) {
    this.hour = ((hours % 24) + 24) % 24;
    this._skyDirty = true;
    this._envDirty = true;
    this._updateCelestial();
    this._bakeSky();
    this._bakeEnv();
    this.events?.emit?.('sky:changed', {
      hour: this.hour,
      sunDir: this.celestial.sun,
      sunIntensity: this.sunLight.intensity,
      moonIntensity: this.moonLight.intensity,
    });
    if (this.debug) {
      const c = this.celestial;
      const sc = this.sunLight.color;
      console.info(
        `[sky] t=${this.hour.toFixed(2)} sunAlt=${((c.sunAlt * 180) / Math.PI).toFixed(1)} ` +
          `sunI=${this.sunLight.intensity.toFixed(3)} sunCol=${sc.r.toFixed(2)},${sc.g.toFixed(2)},${sc.b.toFixed(2)} ` +
          `moonI=${this.moonLight.intensity.toFixed(4)} beamLum=${(this._beamLuminance ?? 0).toFixed(3)} ` +
          `amb=${this.ambientColor.r.toFixed(3)},${this.ambientColor.g.toFixed(3)},${this.ambientColor.b.toFixed(3)} ` +
          `indirect=${this.indirectScale.toFixed(2)} evBias=${this.exposureBias.toFixed(2)} ` +
          `knee=${this.shared.uSkyRolloff.value.x.toFixed(3)}`
      );
    }
    return this;
  }

  /** Hours of sky time per second of wall clock. 0 freezes the sun. */
  setTimeRate(hoursPerSecond) {
    this.timeRate = hoursPerSecond || 0;
    return this;
  }

  setWeather(patch = {}) {
    Object.assign(this.weather, patch);
    this._applyWeather();
    // Turbidity is baked into all three LUTs, so it needs the static bake too.
    if (patch.turbidity !== undefined) this.luts.bakeStatic();
    this._skyDirty = true;
    this._envDirty = true;
    return this;
  }

  /** Fraction of direct sunlight reaching a ground point through the clouds. */
  cloudShadowAt(x, z) {
    // Reuses one preallocated params object: this runs every frame.
    const p = this._occParams;
    p.coverage = this.weather.cloudCoverage;
    p.density = this.weather.cloudDensity;
    p.windX = this.shared.uCloudParams2.value.z;
    p.windZ = this.shared.uCloudParams2.value.w;
    p.time = this._cloudTime;
    return cloudSunOcclusion(x, z, this.celestial.sun, p);
  }

  // =========================================================================
  //  frame
  // =========================================================================

  update(dt) {
    this._elapsed += dt;
    this._cloudTime = this._elapsed;
    this.shared.uCloudParams.value.w = this._cloudTime;
    this.shared.uStarParams.value.z = this._cloudTime;

    if (this.timeRate !== 0) {
      this.hour = (this.hour + this.timeRate * dt) % 24;
      this._updateCelestial();
    }

    // A cloud crossing the sun is a real, large-scale lighting change. Sampled
    // on the CPU from the same macro field the shader draws (clouds.js) and
    // eased hard, because a snapping key light reads as a bug.
    const cam = this.camera;
    this._cloudOccTarget = this.cloudShadowAt(cam.position.x, cam.position.z);
    const k = Math.min(1, dt * 0.9);
    this._cloudOcclusion += (this._cloudOccTarget - this._cloudOcclusion) * k;
    this._applyLightIntensities();
    // Before anything is drawn: `world` updates ahead of `player`, so this reads
    // last frame's camera. At 7 m/s that is 12 cm against a 15 m lead.
    this._fitShadow();
    this.syncExposure();

    if (this._skyDirty) this._bakeSky();

    this._envAge += dt;
    // Cheap when nothing moves; the dirty flag is only set by a real sun move.
    if (this._envDirty && this._envAge > 0.2) this._bakeEnv();

    // The visible sky is a texture (see dome.js DOME_TEX_FRAG). Re-blitting it
    // a couple of times a second at 1024x512 costs a fraction of what
    // evaluating the atmosphere per pixel per frame does, and the only thing
    // moving in it is a cloud deck at walking pace.
    this._skyTexAge += dt;
    if (this.dome.baked && this._skyTexAge >= this._skyTexInterval) this._bakeSkyTexture();

    // The dome refreshes its own ray basis in onBeforeRender; this keeps the
    // CPU-side copy current for anything else that asks.
    cam.updateMatrixWorld();
    this.shared.uCamPos.value.setFromMatrixPosition(cam.matrixWorld);
  }

  // =========================================================================
  //  internals
  // =========================================================================

  _applyWeather() {
    const w = this.weather;
    this.shared.uMieScale.value = w.turbidity;
    this.shared.uHorizonMurk.value = w.horizonMurk;
    const cp = this.shared.uCloudParams.value;
    cp.x = w.cloudCoverage;
    cp.y = w.cloudDensity;
    const cp2 = this.shared.uCloudParams2.value;
    cp2.x = w.cirrusCoverage;
    cp2.y = w.cirrusOpacity;
    cp2.z = Math.cos(w.windAngle) * w.windSpeed;
    cp2.w = Math.sin(w.windAngle) * w.windSpeed;
    if (w.horizon) this.shared.uHorizon.value.fromArray(w.horizon);
  }

  /** Sun/moon geometry, colours and intensities for the current hour. */
  _updateCelestial() {
    const c = this.celestial.setHour(this.hour);
    const s = this.shared;

    s.uSunDir.value.copy(c.sun);
    s.uMoonDir.value.copy(c.moon);
    s.uSunAltitude.value = c.sunAlt;
    s.uMoonAltitude.value = c.moonAlt;
    // The sky-view LUT is baked with the sun at azimuth 0, so the moon only
    // needs its azimuth *relative* to the sun.
    let rel = c.moonAz - c.sunAz;
    while (rel > Math.PI) rel -= 2 * Math.PI;
    while (rel < -Math.PI) rel += 2 * Math.PI;
    s.uMoonRelAz.value = rel;
    c.celestialMatrix(s.uCelestial.value);

    const mie = this.weather.turbidity;

    // ---- sun ---------------------------------------------------------------
    const muS = Math.sin(c.sunAlt);
    // Fraction of the solar disc above the horizon: without this the key light
    // snaps off at sunset instead of dimming through the last half degree.
    const discS = THREE.MathUtils.clamp(0.5 + muS / (2 * 0.004654), 0, 1);
    transmittanceToSpace(Math.max(muS, 0.0008), mie, this._sunT);
    // The solar spectrum is a touch warm of D65 even before the atmosphere.
    const tint = [1.0, 0.975, 0.94];
    const T = this._sunT;
    // ---- the key is the disc PLUS its aureole -------------------------------
    // Transmittance alone is the extinction of the *disc*, and at four degrees of
    // elevation it is (0.51, 0.23, 0.06) — a beam with essentially no blue in it,
    // which is why the 19:20 frame came out as a single orange hue with the whole
    // street the same colour as the sky. But a surface at golden hour is not lit
    // by the disc alone: the aerosol forward peak puts a solar aureole ten to
    // fifteen degrees wide around it, that light arrives from within a few degrees
    // of the beam direction, and it is *far* less reddened because it was scattered
    // out of the column near the observer rather than travelling the whole of it.
    //
    // Raising the transmittance to a power below one is the cheap, monotonic way
    // to express "the effective key is the disc convolved with its aureole": it
    // keeps the ordering and the hue direction (still red-dominant, still tracks
    // turbidity and elevation) while pulling the saturation back to what a golden
    // hour photograph actually shows. Exponent 1 above 16 degrees, so the daytime
    // sun is untouched.
    const aureoleP = THREE.MathUtils.lerp(
      0.55,
      1.0,
      THREE.MathUtils.smoothstep(THREE.MathUtils.radToDeg(c.sunAlt), 0, 16)
    );
    const sr = Math.pow(T[0], aureoleP) * tint[0];
    const sg = Math.pow(T[1], aureoleP) * tint[1];
    const sb = Math.pow(T[2], aureoleP) * tint[2];
    const smax = Math.max(1e-6, sr, sg, sb);
    this.sunLight.color.setRGB(sr / smax, sg / smax, sb / smax);

    // ---- beam floor --------------------------------------------------------
    // The transmittance at 4 degrees elevation is (0.51, 0.23, 0.06): the beam
    // keeps its red channel but loses two thirds of its LUMINANCE, while the
    // whole west sky is at its brightest. Left alone that inverts the frame —
    // the shaded wall comes out brighter than the sunlit one, which is what the
    // 19:20 shot was doing. A real golden hour still reads as a key light.
    //
    // So: the beam's *hue* stays exactly on the physical transmittance curve,
    // and only its luminance is floored, at about a stop below the noon value,
    // for as long as any part of the disc can see the scene (down to -2 deg).
    // Below that it releases and the beam dies out normally into blue hour.
    const lumT = 0.2126 * sr + 0.7152 * sg + 0.0722 * sb;
    const altDeg = THREE.MathUtils.radToDeg(c.sunAlt);
    // 1 while the disc still lights the street, 0 by the time it is 6 deg under.
    const beamAlive = THREE.MathUtils.smoothstep(altDeg, -6.0, -1.0);
    const lumFloor = SUN_LUM_FLOOR * beamAlive;
    // Applied as a gain on the physical value so nothing above ~12 deg moves.
    const beamGain = Math.max(1, lumFloor / Math.max(lumT, 1e-5));
    this._beamGain = beamGain;
    this._baseSunIntensity = SUN_ILLUMINANCE_TOP * smax * discS * beamGain;
    // Luminous beam level, in scene units — the reference the indirect terms
    // are held against so the key:fill ratio is elevation-invariant.
    this._beamLuminance = SUN_ILLUMINANCE_TOP * Math.max(lumT * beamGain, 1e-6) * discS;

    // Irradiance handed to the sky LUT is the *extraterrestrial* value: the
    // scattering raymarch applies the transmittance itself.
    s.uSunIrradiance.value.set(
      SUN_ILLUMINANCE_TOP * tint[0],
      SUN_ILLUMINANCE_TOP * tint[1],
      SUN_ILLUMINANCE_TOP * tint[2]
    );

    // Solar disc radiance is E/omega = 5.12/6.8e-5 = 75000 units, which
    // overflows a half-float target once bloom touches it. Clamped to 4000:
    // still six stops above anything else in the frame, so it tone-maps to
    // pure white and blooms hard, which is all the number is for.
    const discRad = 4000;
    s.uSunDiscRadiance.value.set(discRad * tint[0], discRad * tint[1], discRad * tint[2]);

    // ---- night ramps -------------------------------------------------------
    // Key handover: the moon may only become the brightest light once the sun
    // is genuinely gone, or the renderer would fit its cascades to the wrong one.
    const keyRamp = THREE.MathUtils.smoothstep(-altDeg, -3, 5);
    // Presentation ramp for stars, Milky Way and the moon disc.
    const nightRamp = THREE.MathUtils.smoothstep(-altDeg, 0, 9);

    // ---- moon --------------------------------------------------------------
    const muM = Math.sin(c.moonAlt);
    const discM = THREE.MathUtils.clamp(0.5 + muM / (2 * 0.004516), 0, 1);
    transmittanceToSpace(Math.max(muM, 0.0008), mie, this._moonT);
    const MT = this._moonT;
    // Moonlight is physically warm (lunar regolith is reddish) but reads cool
    // because scotopic vision peaks blue — the Purkinje shift. Cinema has
    // rendered night blue for a century; we follow it, and modulate that tint
    // by the real atmospheric reddening so a low moon still goes amber.
    const cool = [0.66, 0.80, 1.0];
    const mr = MT[0] * cool[0];
    const mg = MT[1] * cool[1];
    const mb = MT[2] * cool[2];
    const mmax = Math.max(1e-6, mr, mg, mb);
    this.moonLight.color.setRGB(mr / mmax, mg / mmax, mb / mmax);
    let moonI = MOON_ILLUMINANCE_NIGHT * c.moonPhase * mmax * discM * keyRamp;

    // The renderer switches its own 4.3-intensity fallback sun back on if no
    // foreign directional light is brighter than 0.01. Keep a floor so that
    // never happens during the handover minute.
    if (Math.max(this._baseSunIntensity, moonI) < 0.03) moonI = 0.03;
    // Physical level, before MOON_KEY_GAIN. Everything that must stay on the
    // atmosphere's own scale — the published ambient, the sky roll-off knee and
    // the meter — reads this; only the light itself takes the gain.
    this._baseMoonIntensity = moonI;

    const moonIrr = MOON_ILLUMINANCE_NIGHT * c.moonPhase * keyRamp;
    s.uMoonIrradiance.value.set(moonIrr * cool[0], moonIrr * cool[1], moonIrr * cool[2]);

    // Day: a pale disc a little above the daytime sky, which is what the moon
    // actually looks like at 16:30. Night: far enough above the night sky to
    // clip to white and bloom, the way every photograph of a moon does.
    // Both numbers are *ratios to the sky the LUT produces*, so they moved with
    // the pi correction in atmosphere.js rather than being retuned by eye.
    const moonDisc = THREE.MathUtils.lerp(0.35, 3.5, nightRamp);
    s.uMoonDiscRadiance.value.set(moonDisc, moonDisc * 0.985, moonDisc * 0.95);

    // ---- ambient colour (published, not used for lighting) -----------------
    // The real ambient is the PMREM; this is a cheap CPU stand-in so the HUD and
    // gameplay code can ask "what colour is the daylight right now" without a
    // GPU readback. Whole-sky diffuse illuminance runs about 15% of the beam,
    // and the hue swings from Rayleigh blue overhead to the beam's own colour as
    // the sun sets, because at that point most of the sky *is* the sunset.
    //
    // Two things this must NOT do. It must not go warm at night: below the
    // horizon the sun's transmittance is (0.09, 0.009, 0.0001) and normalising
    // that gives pure sodium orange, so an unguarded lerp toward "the beam's
    // colour" published a street-lamp-coloured night ambient and every shadow
    // in the frame came out the same hue as the practicals. And the warm swing
    // at sunset belongs to the sun's own *hue*, not to a dead beam, so it is
    // gated on the beam still being alive.
    const warm = (1 - THREE.MathUtils.smoothstep(altDeg, 1, 22)) * beamAlive;
    const night = 1 - beamAlive;
    const nh = NIGHT_AMBIENT_HUE;
    const ar = THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(0.36, nh[0], night),
      this.sunLight.color.r,
      warm
    );
    const ag = THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(0.56, nh[1], night),
      this.sunLight.color.g,
      warm
    );
    const ab = THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(1.0, nh[2], night),
      this.sunLight.color.b,
      warm
    );
    // The moon term is deliberately generous against the day term (0.55 vs 0.15
    // of the key): a moonlit sky is a much larger fraction of its own key than a
    // daylit one, and it is the only thing separating a night shadow from black.
    const aLevel =
      SKY_AMBIENT_FRACTION * this._baseSunIntensity + NIGHT_AMBIENT_FRACTION * moonI;
    this.ambientColor.setRGB(ar * aLevel, ag * aLevel, ab * aLevel);

    // ---- indirect budget, published for the renderer ------------------------
    // The other half of the beam floor. A low sun does not just redden: the whole
    // western sky lights up, and the PMREM integrates that into an irradiance
    // that can exceed the beam's own luminance — which is how a sunset ends up
    // with its shaded walls brighter than its sunlit ones. The sky is physically
    // right; what is wrong is that a hemispherical average taken off a 20-degree
    // horizon glow over-reports how much of it any vertical surface can see.
    //
    // So the indirect terms come down on the same elevation curve the beam is
    // floored on, which makes the key:fill ratio elevation-invariant rather than
    // something that happens to work at 16:30. `render` multiplies its IBL
    // diffuse budget by this (see RenderSystem._updateBounceFill).
    // Sky shoulder. The knee tracks the beam's luminance because autoexposure
    // does: 7.5% of the beam lands a couple of stops under display white at any
    // hour, so a daylight zenith (2% of the beam) passes through untouched while
    // a sunset horizon glow (200%+ of it) is rolled off into a gradient instead
    // of a plateau. Floored so the night sky and the stars are never touched.
    // The knee comes down as the sun does. At 30 degrees the only thing over it
    // is a sunlit cumulus top, which SHOULD be near white; at 5 degrees the
    // whole western half of the dome is over it and it is the difference
    // between a graded amber ramp and a cream void.
    const kneeFrac = THREE.MathUtils.lerp(
      0.045,
      0.11,
      THREE.MathUtils.smoothstep(altDeg, 2.0, 15.0)
    );
    s.uSkyRolloff.value.set(
      Math.max(kneeFrac * this._beamLuminance, 0.02 + 6.0 * moonI),
      0.34
    );

    // ---- exposure compensation for the time of day --------------------------
    // At four degrees of elevation a street canyon is ENTIRELY in shadow — the
    // sun only reaches the top two floors of the leeward side — so a meter that
    // is (correctly) weighted onto the geometry opens up two stops and puts the
    // sky, which has not moved, on the flat top of the tone curve. That is the
    // whole reason the 19:20 sky was one achromatic plateau with no Rayleigh
    // column in it: not the atmosphere model, the exposure.
    //
    // Every stills photographer shooting a golden hour stops down for the sky
    // and lets the street go dark. This is that decision, on a curve, so the sky
    // stays inside the part of the tone curve that still has a gradient in it.
    this.exposureBias =
      1.35 * (1 - THREE.MathUtils.smoothstep(altDeg, 1.0, 13.0)) * beamAlive +
      // ...and just under a stop after dark. The meter is (correctly) weighted
      // onto the geometry, and once the only key is a moon plus twenty-two
      // sodium lamps it opens up until a midnight street reads as an overcast
      // evening. Every night frame ever shot is underexposed on purpose.
      //
      // This was 0.55, and the other 0.41 EV of the night's darkness was coming
      // out of the exposure CEILING instead: measured at the foundry the meter
      // asked for 2.053 and the clamp handed back 1.55, silently. A grade is
      // allowed to be a decision; it is not allowed to be a clamp nobody can
      // see, so 0.955 moved that 0.41 EV into a named constant. (At the REF_KEY
      // of 2.3 it was measured against, 2.3 / 0.765 x 2^-0.955 = 1.552 — the
      // shipped level exactly. REF_KEY is 3.4 now and the same 0.955 meters the
      // foundry at 2.292; with the ground-albedo term below it lands at 3.673.
      // The night level is therefore three named numbers and no clamp, which is
      // the point of the line, not the 1.55.)
      0.955 * (1 - beamAlive);

    // ...plus what the GROUND is, which the beam has no way of knowing. See
    // METER_GROUND_ALBEDO: the key-light meter is elevation-invariant by design
    // and scene-reflectance-blind by accident, and across the five presets the
    // ground spans 0.053 to 0.751 — 3.8 stops — so the same key puts Frostline's
    // snow on the ACES shoulder and Harbor's wet concrete two thirds of a stop
    // under it. This is the grey card the meter never had.
    const ga = s.uGroundAlbedo.value;
    // Floored at 0.02 so a black-ground preset cannot hand log2 a zero. The top
    // end needs no clamp: an albedo is <= 1, so the term cannot exceed
    // log2(1/0.35) x 0.5 = +0.76 EV in the other direction.
    const gaLum = 0.2126 * ga.x + 0.7152 * ga.y + 0.0722 * ga.z;
    this.exposureBias +=
      Math.log2(Math.max(gaLum, 0.02) / METER_GROUND_ALBEDO) *
      THREE.MathUtils.lerp(ALBEDO_METER_WEIGHT_NIGHT, ALBEDO_METER_WEIGHT_DAY, beamAlive);

    // This is a SHAPE, not a level: 1.0 is the daylight reference and the world
    // sizes its absolute hemisphere budget against that (map.js `_bounce`, which
    // multiplies the published whole-sky level by 1.7 and this). Do not pay a
    // level correction here — the world already paid one, and two corrections
    // stacked take a shaded wall past a shadow and into a hole. What this curve
    // says, and all it says, is that a hemispherical average over-reports what a
    // vertical surface can see of a 20-degree horizon glow, and under-reports
    // the moonlit sky's share of a night frame.
    //
    // Released — and then some — once the beam is gone. After dark the moonlit
    // sky is the ONLY fill there is, the warm ground bounce that made the daytime
    // budget need cutting is not there to swamp it, and a night frame with a
    // fifth of its pixels under code value 12 is not a night frame, it is an
    // empty one. The night rebalance that WAS needed is in the level the ambient
    // publishes, not here — see NIGHT_AMBIENT_FRACTION.
    this.indirectScale = THREE.MathUtils.lerp(
      2.2,
      THREE.MathUtils.lerp(0.45, 1.0, THREE.MathUtils.smoothstep(altDeg, 0.0, 14.0)),
      beamAlive
    );

    // ---- stars -------------------------------------------------------------
    // Calibrated against the moonlit sky the LUT actually produces: the
    // brightest first-magnitude stars sit about two stops above the zenith
    // radiance, the Milky Way's spine about half a stop below it. Anything
    // dimmer than that and the night sky is empty; anything brighter and it
    // reads as a planetarium ceiling. The level tracks the sky, so it dropped by
    // pi with the photometric fix in atmosphere.js instead of being re-eyeballed.
    s.uStarParams.value.x = 0.07 * nightRamp;
    s.uStarParams.value.y = 0.55;
    s.uStarParams.value.w = 0.16 * nightRamp;

    // ---- light transforms --------------------------------------------------
    // Clamp the light direction just above the horizon: a directional light at
    // exactly 0 degrees degenerates the cascade fit.
    this._placeLight(this.sunLight, c.sun, 0.006);
    this._placeLight(this.moonLight, c.moon, 0.026);

    this._applyLightIntensities();
    this._skyDirty = true;
    if (this._envSunDir.dot(c.sun) < Math.cos(0.35 * (Math.PI / 180))) this._envDirty = true;
  }

  /**
   * Publish the light's direction, and refit the box to it.
   *
   * The box's SHAPE depends on the direction — a lower sun makes it wider across
   * the beam and shorter up it — so the fit has to happen here as well as in
   * `_fitShadow`, or a `setTimeOfDay` outside the frame loop would leave the
   * projection describing the previous sun.
   */
  _placeLight(light, dir, minY) {
    const d = light.userData.fitDir;
    d.copy(dir);
    if (d.y < minY) {
      d.y = minY;
      d.normalize();
    }
    this._applyShadowFit(light);
  }

  _applyLightIntensities() {
    // A cloud crossing the sun dims the whole street, so the range has to stay
    // narrow: this light is global, and a hard 4x drop reads as somebody pulling
    // the exposure rather than as weather. Real broken cover on the ground swings
    // maybe a stop, which is what 0.58..1.0 gives.
    const occ = 0.58 + 0.42 * this._cloudOcclusion;
    this.sunLight.intensity = this._baseSunIntensity * occ * SUN_KEY_GAIN;
    this.moonLight.intensity = this._baseMoonIntensity * MOON_KEY_GAIN;

    const sunI = this.sunLight.intensity;
    const moonI = this.moonLight.intensity;
    // Hysteresis on the handover. The cloud term above swings the sun's
    // intensity by up to a stop over a few seconds, so a bare `moonI > sunI`
    // test flickers the key — and with it the shadow DIRECTION and, below, a
    // 34-76 MB allocation — for as long as the two are within that swing.
    const wasMoon = this.keyLight === this.moonLight;
    const moonKey = wasMoon ? moonI > sunI * 0.85 : moonI > sunI * 1.18;
    this.keyLight = moonKey ? this.moonLight : this.sunLight;

    // We have one shadow map, so it follows whichever body is actually the key.
    // Handover happens once, at dusk. Each body carries its OWN frustum (the fit
    // is the arena seen from that direction, so the two are different rectangles)
    // but both cover the whole arena — so the switch cannot move a shadow, only
    // change its direction.
    if (this.sunLight.castShadow === moonKey) {
      this.sunLight.castShadow = !moonKey;
      this.moonLight.castShadow = moonKey;
      // Give the retiring body's map back. Two 3072 targets with their depth
      // buffers are 150 MB, and a map whose sun never rises would hold both for
      // the whole session. Three reallocates lazily if it ever casts again.
      const idle = moonKey ? this.sunLight : this.moonLight;
      idle.shadow.map?.dispose();
      idle.shadow.map = null;
    }
  }

  /**
   * Metering.
   *
   * The atmosphere works in absolute units — a noon beam is 5.1 and a moonlit
   * one is 0.03, four orders of magnitude apart — so a fixed
   * `toneMappingExposure` cannot serve both a desert afternoon and a night
   * shift at the foundry. This is the film speed: expose for the key light, so
   * a mid-grey surface in full key lands in the same place on the curve at
   * every hour, and let `exposureBias` (which the atmosphere raises at golden
   * hour and after dark, where a meter weighted onto the geometry would open up
   * and blow the sky, and which also carries the grey-card correction for what
   * the map's ground actually reflects — see METER_GROUND_ALBEDO) stop it down
   * from there.
   *
   * The clamp is EXPOSURE_MIN..EXPOSURE_MAX and it is a guard, not a grade: if
   * it binds, the frame is being exposed by a constant instead of by its own
   * key light, and that is a thing worth saying out loud rather than shipping
   * silently. Hence the log below, which fires on each transition on and off
   * the stop rather than every frame.
   */
  syncExposure() {
    /**
     * Film speed, and it is a MEASURED number.
     *
     * Read off the framebuffer on Dustyard with the camera in the mid lane
     * (gl.readPixels, luminance percentiles over the ground band):
     *
     *   REF_KEY 2.3 -> exposure 0.645, ground median 28/255, p90 36
     *   REF_KEY 3.4 -> exposure 0.95,  ground median ~62
     *
     * At 2.3 the street was black — a shaded road between 20 and 36 out of 255
     * with nothing in it, which is not a night look, it is an unexposed frame.
     * The value had been correct earlier and stopped being so when the key
     * light lost SUN_KEY_GAIN and the indirect budget was cut at the same time:
     * three reductions landed on one image and only the metering could put the
     * level back, because it is the one lever that moves level without touching
     * the key:fill ratio those two changes were made to fix.
     *
     * It is measured ON DUSTYARD and it stays that way: the ground-albedo term in
     * `exposureBias` (see METER_GROUND_ALBEDO) is referenced to Dustyard's own
     * 0.350 ground, so this number still means what it was measured to mean and
     * the other four maps move around it rather than under it.
     */
    const REF_KEY = 3.4;
    // The moon term is the PHYSICAL beam, not the one MOON_KEY_GAIN publishes:
    // metering off the gained light would give the gain straight back as a
    // darker frame and leave the ratio exactly where it started.
    const key = Math.max(this._beamLuminance, 8 * this._baseMoonIntensity, 0.35);
    const metered = (REF_KEY / key) * Math.pow(2, -this.exposureBias);
    const e = THREE.MathUtils.clamp(metered, EXPOSURE_MIN, EXPOSURE_MAX);

    // 0.5% of deadband so a value sitting exactly on a stop cannot chatter the
    // log; anything that actually matters is tenths of a stop, i.e. 7%+.
    const bind =
      metered > e * 1.005 ? 'ceiling' : metered < e * 0.995 ? 'floor' : '';
    if (bind !== this._exposureBind) {
      this._exposureBind = bind;
      if (bind) {
        console.info(
          `[sky] exposure on the ${bind}: metered ${metered.toFixed(3)} -> ${e.toFixed(3)} ` +
            `(${Math.abs(Math.log2(metered / e)).toFixed(2)} EV clipped) · ` +
            `beam ${this._beamLuminance.toFixed(3)} moon ${this._baseMoonIntensity.toFixed(4)} ` +
            `evBias ${this.exposureBias.toFixed(2)} · hour ${this.hour.toFixed(2)}`
        );
      } else {
        console.info(`[sky] exposure metered freely at ${e.toFixed(3)}`);
      }
    }
    this.exposure = e;
    this.renderer.toneMappingExposure = e;
    // The dome tone maps itself and must use the identical value, or the sky
    // and the geometry in front of it are exposed differently.
    this.shared.uOutputExposure.value = e;
    return e;
  }

  _bakeSky() {
    this.luts.bakeSkyView();
    this._skyDirty = false;
    this.renderer.setRenderTarget(null);
  }

  /**
   * Aerial perspective for the LDR pipeline: three.Fog, coloured from the sky
   * the atmosphere just produced instead of from a hand-picked hex. `gain`
   * lifts it off the ambient level toward the horizon band, which is brighter
   * than the whole-sky average by roughly that much.
   */
  applyFogTo(scene, near, far, gain = 1.7, tintTowards = null, tintAmount = 0) {
    if (!scene.fog) scene.fog = new THREE.Fog(0x000000, near, far);
    scene.fog.near = near;
    scene.fog.far = far;
    const c = scene.fog.color.copy(this.ambientColor).multiplyScalar(gain);
    if (tintTowards) c.lerp(new THREE.Color(tintTowards), tintAmount);
    return scene.fog;
  }

  /** Re-render the equirect sky. Cheap: 0.5 Mpx of the full atmosphere. */
  _bakeSkyTexture() {
    blit(this.renderer, this.dome.envMaterial, this.envEquirect);
    this.renderer.setRenderTarget(null);
    this._skyTexAge = 0;
  }

  _bakeEnv() {
    // One equirect draw of the same sky shader, then PMREM. The first call
    // allocates; every later call reuses the target so nothing churns.
    blit(this.renderer, this.dome.envMaterial, this.envEquirect);
    this._skyTexAge = 0;
    this._pmremTarget = this.pmrem.fromEquirectangular(
      this.envEquirect.texture,
      this._pmremTarget
    );
    this._pmremTarget.texture.name = 'sky-env';
    this.envMap = this._pmremTarget.texture;
    // Image-based lighting for every standard material in the world: this is
    // what puts sky colour in the shadows and a real horizon reflection on
    // metal, and it replaces the hemisphere+ambient pair the maps used to run.
    this.scene.environment = this.envMap;
    this.renderer.setRenderTarget(null);

    this._envSunDir.copy(this.celestial.sun);
    this._envDirty = false;
    this._envAge = 0;

    this.events?.emit?.('sky:env', { envMap: this.envMap, sunDir: this.celestial.sun });
  }

  dispose() {
    this._offMapChanged?.();
    this._offMapChanged = null;
    this.scene.remove(this.dome.mesh);
    this.dome.dispose();
    this.luts.dispose();
    this.envEquirect.dispose();
    this._pmremTarget?.dispose();
    this.pmrem.dispose();
    this.scene.remove(this.sunLight, this.sunLight.target);
    this.scene.remove(this.moonLight, this.moonLight.target);
    if (this.scene.environment === this.envMap) this.scene.environment = null;
    this.sunLight.dispose();
    this.moonLight.dispose();
  }
}
