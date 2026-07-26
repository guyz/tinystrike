// ============================================================================
// TINY STRIKE — theme -> PBR surface binding.
//
// Every map material key the layout tables reference (`wallN`, `crate`,
// `metal`, ...) is bound here to a surface in the procedural library
// (src/gfx/materials). The keys, and therefore every map definition and the
// whole collision layout, are unchanged: this file only decides what the
// geometry is MADE of.
//
// ---------------------------------------------------------------------------
// HOW `scale` IS CHOSEN
//
// `scale` is metres per texture tile, not a repeat count. The library projects
// in world space (planar/triplanar), so a 40 m wall and a 1 m crate built from
// the same shared unit box both get correct texel density with no per-mesh UV
// work. Two independent things have to come out right:
//
//  1. FEATURE SIZE. Every generator authors a fixed number of features per
//     tile, so metres-per-feature is `scale / N`. This is the one that was
//     wrong nearly everywhere, and it is checkable against a tape measure:
//
//       brick        6 x 18 units / tile  -> 1.35 m gives 225 x 75 mm
//                                            (a 215 mm brick + a 10 mm bed)
//       wood         5 planks x 2 boards  -> 0.62 m gives 124 mm slats
//       burlap       34 threads           -> 0.19 m gives 5.6 mm hessian
//       corrugated   12 ridges, 4/panel   -> 1.75 m gives a 146 mm profile
//                                            on 583 mm sheets
//       gravel       3 grades, 44/80/168  -> 1.90 m gives 43/24/11 mm stone
//       concrete     4 board courses,
//                    3 x 2 tie holes      -> 2.10 m gives 525 mm boards on a
//                                            700 x 1050 mm tie grid
//       concrete_floor  1 saw-cut grid    -> 3.20 m slab bays
//       stone        2-4 blocks x 6
//                    unequal courses      -> 2.00 m gives 500-1000 x 330 mm
//       snow         drift / sastrugi /
//                    ripple / grain       -> 4.00 m gives 1 m / 1.3 m / 45 mm
//                                            / 23 mm
//
//  2. TEXEL DENSITY. A bake is 1024 px on `high`, so one texel is
//     `scale / 1024` metres. At 1080p and a 55 deg vertical fov a screen pixel
//     spans about 0.96 mm per metre of distance, so the base tile is magnified
//     (soft) nearer than roughly `scale` metres and mip-filtered beyond it.
//     A 2.1 m wall is therefore soft inside 2 m and mipped past it, which is
//     why the base tile is never the whole answer:
//
//       0.25 - 5 m   the shared detail layer (fixed 0.26 m world tile, 1024 px
//                    = 0.25 mm/texel) — this is what you read hugging a wall
//       1 - 8 m      the base bake
//       5 - 60 m     the macro layers: `macro[0]` sets a period of
//                    1/macro[0] metres, `macroBig[2]` a second at 1/0.026 =
//                    38 m. Past ~25 m these are the ONLY signal left, so a
//                    surface with no macroBig is a flat colour at range.
//
// A third rule from the reference's quality bar: nothing perfectly clean or
// uniformly repeated. Where a key is used on many separate objects (walls,
// crates) the tint and tile are jittered per variant rather than shared.
//
// ---------------------------------------------------------------------------
// KEYS THIS TABLE EXPOSES
//
// Beyond the keys the maps already name, every wall key gets two tinted
// siblings so a street is not one colour:
//
//     wallN  wallN2  wallN3        wallNs  wallN2s  wallN3s
//     wallA  wallA2  wallA3        wallAs  wallA2s  wallA3s
//     wallB  wallB2  wallB3        wallBs  wallB2s  wallB3s
//
// A `2`/`3` sibling is the same surface and the same generator bake — so it
// costs no extra VRAM and no extra GPU bake, only one more material — with the
// tint rotated a few degrees of hue and 7-8% in value, and the tile shifted
// +/-8% so two adjacent buildings never phase-align. Anything picking a
// material per building mass should hash the mass index into one of the three:
//
//     const key = ['wallN', 'wallN2', 'wallN3'][massIndex % 3];
//
// (`src/world/dressing.js` is owned by another agent; these keys are here for
// it to adopt, and resolve lazily, so an unused variant costs nothing.)
//
// The `s` suffix is the reveal/soffit variant: same masonry at the SAME
// physical size, a stop darker. See the note by `smallOf` below.
//
// ---------------------------------------------------------------------------
// Identical (surface, opts) pairs share one GPU bake AND one material, so a
// theme can recolour a surface a dozen ways for the cost of one texture set.
// ============================================================================
import * as THREE from 'three';

const WHITE = new THREE.Color(1, 1, 1);

/**
 * Theme colours are *finished surface* colours — a wall that already reads
 * "#c8a878" on screen. The shader's tint is a straight multiply over an albedo
 * that already carries its own mid-tone, so feeding the raw theme colour in
 * multiplies two mid-tones together and every surface comes out dark and
 * oversaturated (measured: a 0.57 linear plaster tinted 0.57 lands at 0.32,
 * a full stop under a real rendered wall).
 *
 * So a tint here only shifts *hue and saturation*: the brightest channel is
 * normalised to 1 first, then pulled back toward white by `1 - strength`.
 * `lift` is the one deliberate exposure control, for surfaces that really are
 * darker or lighter than their library bake.
 *
 * Which means the tint's brightest channel is exactly `lift`, and the peak
 * albedo a key can produce is `lift x` its generator's clamp. The clamps run
 * 0.72 (dirt) to 0.90 (snow), and the largest lift in this file is 1.12 on the
 * desert ground: 0.72 x 1.12 = 0.81 linear. Every entry stays inside the
 * 0.02-0.9 reflectance rule. (The runtime macro layer can push a highlight
 * above that; see shader.js `owMacroP.y`.)
 *
 * ---------------------------------------------------------------------------
 * THIS HELPER HAS BEEN ACCUSED OF ERASING ALBEDO VALUE. IT DOES NOT. MEASURED:
 *
 * The charge was that normalising the brightest channel to 1 throws the theme
 * colour's value away, and that a theme whose palette is dark therefore renders
 * as bright as one whose palette is light. The first half is true and
 * deliberate; the second does not follow, because the value comes from the
 * generator, not from here. Finished mean albedo (bake mean x tint, linear
 * luma; the bake means and the method are tabulated in
 * gfx/materials/library.js):
 *
 *              ground   wallN   wallA   wallB   trim    range
 *   desert     0.114    0.215   0.206   0.066   0.088   1.71 stops
 *   citadel    0.088    0.233   0.226   0.263   0.086   1.60
 *   coastal    0.144    0.144   0.139   0.127   0.054   1.43
 *   arctic     0.701    0.079   0.161   0.125   0.049   3.84
 *   neon       0.038    0.074   0.041   0.129   0.164   2.11
 *
 * No theme collapses to one value, and where two keys share a surface the
 * palette's relative value survives exactly, because the tint is a straight
 * multiply: desert wallN/wallA are both plaster and land 0.215/0.206 for palette
 * lumas of 0.416/0.405; arctic's pale cladding stays 0.37 of a stop over its
 * dark concrete. Across DIFFERENT surfaces the bake decides — desert's wallB is
 * the darkest wall in the map because brick bakes at 0.067, not because of
 * anything here. What the tints span is 0.61-1.02 of luma across all five
 * themes (0.74 of a stop), because they are a hue control with `lift` as the one
 * value knob, exactly as documented above.
 *
 * Neon is the map the audit named. Its finished albedos are 0.038 (ground),
 * 0.074 and 0.041 (walls) — the darkest set in the game, 1.5 stops under
 * Dustyard's. If a Neon frame measures hot, the exposure is hot over a dark
 * albedo; the albedo is not the cause. So this helper is unchanged, and the
 * two real defects the same measurement DID turn up were fixed instead: the
 * saturation double-multiply on `sandbag` and on the two timber keys (a
 * saturated bake times a saturated tint), documented at those entries.
 */
function tintOf(color, strength = 0.55, lift = 1) {
  const c = new THREE.Color(color);
  const max = Math.max(c.r, c.g, c.b);
  if (max > 1e-4) c.multiplyScalar(1 / max);
  c.lerp(WHITE, 1 - strength);
  return c.multiplyScalar(lift);
}

/**
 * What the weathering layers are MADE of, per map.
 *
 * The shader's dust, ground-splash, wall/ground wedge and cavity-grime layers
 * all key off two colours, and the library ships one set tuned for a dusty
 * Levantine street. Left alone that paints warm brown desert dust into the
 * wall/ground junction of a snowfield and over a rain-washed quay — the wedge
 * is 25-40 cm tall on every wall in the frame, so it is not a subtlety.
 *
 * Applied as a default: an entry that names its own dustColor/grimeColor keeps
 * it, and the snow surfaces are skipped entirely (their grime is the blue of
 * skylight in a drift hollow, which is a property of snow, not of the map).
 */
const CLIMATE = {
  // Blown sand, and the shaded side of it.
  desert: { dustColor: 0xcdb68d, grimeColor: 0x33291d },
  // Salt bloom and algae, not dust: a quay is washed, never dusty.
  coastal: { dustColor: 0x9aa39a, grimeColor: 0x1d2422 },
  // Spindrift piled against everything, and the grey-blue of wet slush.
  arctic: { dustColor: 0xdae6ee, grimeColor: 0x3d4956 },
  // Soot. A foundry's fallout is carbon, so it is neutral and very dark.
  neon: { dustColor: 0x7c7f83, grimeColor: 0x16171a },
  // Limestone dust off the courts, and the black of centuries of damp.
  citadel: { dustColor: 0xab9c7c, grimeColor: 0x241f18 },
};

const CLIMATE_SKIP = new Set(['snow', 'snow_packed', 'glass', 'foliage']);

function base(theme) {
  return {
    // ---- ground and floor pads ------------------------------------------
    // 3.4 m, not 4.2: the dirt bake is authored for 2.5 m, and relief scales
    // with the tile, so 4.2 m turned a 0.12 m clod field into 0.20 m of
    // corrugation across a 100 m yard. normalStrength pulls the rest back.
    ground: ['dirt', {
      scale: 3.4, tint: tintOf(theme.floor, 0.45),
      normalStrength: 0.85, macroRelief: 0.45,
      // The ground is the largest single surface in the frame and the library
      // ground entries carry no macroBig at all, so past 25 m a 100 m yard was
      // one flat value. 1/0.022 = 45 m period, coarsest band ~15 m.
      macroBig: [1.9, 0.10, 0.022, 0],
    }],
    padWarm: ['concrete_floor', { scale: 3.2, tint: tintOf(theme.wallA, 0.5) }],
    padCool: ['concrete_floor', { scale: 3.2, tint: tintOf(theme.wallB, 0.5) }],
    padPlat: ['concrete_floor', { scale: 3.0, tint: tintOf(theme.wallA, 0.5) }],
    padPlatB: ['concrete_floor', { scale: 3.0, tint: tintOf(theme.wallB, 0.5) }],

    // ---- architecture -----------------------------------------------------
    wallN: ['plaster', { scale: 2.35, tint: tintOf(theme.wall, 0.5) }],
    // 1.35 m is the brick module: the generator lays 6 x 18 units per tile, so
    // this is a 225 x 75 mm course — a 215 mm brick on a 10 mm bed. At the old
    // 1.5 m every brick in the game was 240 x 83 mm.
    wallA: ['brick', { scale: 1.35, tint: tintOf(theme.wallA, 0.5) }],
    wallB: ['concrete', { scale: 2.1, tint: tintOf(theme.wallB, 0.5) }],
    // Precast coping and kerb: `concrete_floor` puts one saw-cut line per tile,
    // which at 1.15 m reads as the joint between precast units. The wall bake
    // would put 290 mm formwork boards across a 200 mm coping instead.
    trim: ['concrete_floor', { scale: 1.15, tint: tintOf(theme.trim, 0.6, 0.72) }],

    // ---- props ------------------------------------------------------------
    /**
     * Crates. `wood_case`, not `wood`: the decking bake lays 2 board lengths to
     * the tile with a hashed stagger, which at 0.62 m is a running bond of
     * 310 x 124 mm blocks with a dark joint — sandstone ashlar, on the most
     * repeated prop in every map. See the library entry.
     *
     * 1.15 m, so one tile covers one face of a 1.1-1.5 m crate: 9 slats of
     * 128 mm, jointed once per tile at a per-row hashed position (the corner
     * post), and no board or knot repeats twice across the same face. Texel
     * density 1.15 m / 1024 = 1.1 mm.
     */
    crate: ['wood_case', { scale: 1.15, tint: tintOf(0xd9bb8c, 0.5, 1.05) }],
    // Deliberately not the same tile as `crate`: two crates side by side with
    // identical board pitch is the tell that they came out of one box. 1.02 m
    // puts this one's slats at 113 mm. Also carries the batten frames, board
    // doors and window frames, which are the same long-slat timber.
    /**
     * strength 0.45, not 0.7, on both timber keys.
     *
     * Two saturated things were being multiplied. The wood bake's own
     * chromaticity is blue at 40% of red (fresh pine), and a 0.7 pull toward a
     * theme brown is another 0.55, so the finished board came out at blue = 22%
     * of red — measured on Harbor's 18 x 14 m pier deck, which is a bright
     * orange plane where a wet quay wants a grey-brown one. Real timber runs
     * blue/red 0.33 (new pine) to 0.7 (silvered), never 0.22. At 0.45 the tint
     * is blue/red 0.71 and the board lands at 0.28 — the new-pine end of real,
     * with the silvering below taking the rest of the way to grey.
     */
    crateDark: ['wood_case', { scale: 1.02, tint: tintOf(theme.wood, 0.45, 0.8) }],
    // Decking and stair treads: 230 mm boards.
    wood: ['wood', { scale: 1.15, tint: tintOf(theme.wood, 0.45, 0.8) }],
    /**
     * Hessian, at 5.6 mm a thread. The bake is 34 threads to the tile, so the
     * old 0.5 m tile wove a 15 mm basket — every sandbag emplacement in the
     * game was wicker. The weave bump scales with the tile too: at 0.19 m it is
     * a 2.6 mm relief, still fatter than real jute, hence normalStrength < 1.
     *
     * The macro layers do the bags. `World.sandbags()` builds an emplacement out
     * of 660 x 340 mm boxes butted flush against each other with no seam, so at
     * a 0.19 m tile the weave ran unbroken across a 3.2 m wall and the whole
     * thing read as one slab of khaki canvas — every bag in it invisible.
     * macro at 0.5 puts the two albedo bands at 0.67 m and 0.63 m features,
     * i.e. bag-sized, and 0.5 of amplitude makes that a +/-23% value swing
     * rather than the +/-15% wash it was: a stack of bags filled from different
     * lots and faded for different lengths of time. macroRelief bulges the top
     * course at the same 0.65 m, which is where you look down on them.
     *
     * (This is a material-side substitute for what the shape should be doing.
     * The key is shared with the theme's hanging tarps and cloth rolls
     * (`clothKey: 'sandbag'` in dressing.js), so a bag lattice with seams and
     * folded ears cannot go in the tile — it would print bags on the laundry.
     * A per-bag form needs the emplacement to stop being flush cuboids.)
     */
    sandbag: ['burlap', {
      /**
       * strength 0.30, not 0.55. The burlap bake now carries jute's real
       * chromaticity (blue at 55% of red — see the library entry), and a 0.55
       * pull toward this khaki multiplied the blue back down to 21% of red: the
       * emplacement came out gold. At 0.30 the tint is (1.00, 0.944, 0.818) and
       * the finished bag lands at blue = 45% of red, which is a sand-stained
       * hessian rather than a brass one.
       */
      scale: 0.19, tint: tintOf(0xb3a276, 0.30), normalStrength: 0.95,
      macro: [0.5, 0.5, 0.2, 0.4],
      macroBig: [1.9, 0.085, 0.11, 0],
      macroRelief: 0.55,
      /**
       * And the bags themselves, out of the repair-patch layer: an 85%-occupied
       * lattice of 660 mm cells on vertical faces, each an inset rectangle at
       * +/-18% value with a 3-6 cm feathered edge and a bright lip. That is a
       * sandbag: bag-sized, soft-edged, standing a little proud, and hashed off
       * world position so no two are alike and nothing repeats with the tile.
       * The layer costs nothing extra to sample — it is arithmetic on macro
       * values the shader has already fetched.
       *
       * 0.18, not 0.13: +/-13% is 0.18 of a stop, and measured against a 3.2 m
       * emplacement wall in full sun that is at the edge of visible — the bag
       * divisions were there and you had to look for them. 0.18 is 0.24 of a
       * stop, still inside the value spread a stack of bags filled from
       * different lots would have.
       */
      patch: [0.85, 0.66, 0.18, -0.05],
    }],
    // A 200 l drum is 580 mm across and 880 mm tall — 1.8 m of circumference.
    // At 0.8 m it wore two rust blooms; at 0.5 m it wears a dozen.
    barrel: ['metal_painted', { scale: 0.5, tint: tintOf(0x8c9a6c, 0.8, 0.85) }],
    barrelRed: ['metal_rust', { scale: 0.46, tint: tintOf(0xb0563a, 0.85, 0.9) }],

    // ---- metals -----------------------------------------------------------
    metal: ['metal_painted', { scale: 1.05, tint: tintOf(0xc8cdd2, 0.4, 1.0) }],
    metalDoor: ['metal_painted', { scale: 0.9, tint: tintOf(theme.metal, 0.55, 0.85) }],
    /**
     * The set-dressing metal: drainpipes (100 mm), brackets (50 mm), railings
     * and rebar (25-30 mm), roof plant, ladder rungs. At the old 1.0 m tile a
     * 30 mm bar sampled 3% of one tile and came out a single flat colour —
     * the biggest untextured-surface failure in the table, on the geometry the
     * player walks closest to. 0.32 m puts a whole brushed-metal patch, with
     * its wear and its grime, on every one of them.
     */
    metalDark: ['metal_brushed', { scale: 0.32, tint: tintOf(0x3c454d, 0.5, 0.42) }],
    // Gratings, walkway mesh and plant housings: 0.5-0.6 m objects.
    metalGrid: ['metal_brushed', { scale: 0.62, tint: tintOf(0x8d9aa3, 0.45, 0.8) }],
    // Shipping containers are 5.8 x 2.6 m; 1.25 m puts four panels of chipping
    // and blistered paint along one, instead of one smear stretched over it.
    accentA: ['metal_painted', { scale: 1.25, tint: tintOf(theme.accentA, 0.92) }],
    accentB: ['metal_painted', { scale: 1.25, tint: tintOf(theme.accentB, 0.92) }],

    // ---- stone (citadel uses it everywhere, other maps for kerbs/plinths) --
    stone: ['stone', { scale: 2.0, tint: tintOf(theme.wall, 0.5) }],
    stoneLight: ['stone', { scale: 2.15, tint: tintOf(theme.wallA, 0.5) }],
    // Rubble and plinths, not walls: this key dresses broken masonry 0.3-0.8 m
    // across and the citadel fountain kerb. At 2.2 m a rubble chunk was a
    // fifth of one block face — no joint, no arris, no tool marks.
    stoneDark: ['stone', { scale: 1.05, tint: tintOf(theme.wallB, 0.5) }],

    // ---- set-dressing surfaces (src/world/dressing.js) --------------------
    /**
     * Vegetation.
     *
     * Every foliage prop in kit/props.js is built from PlaneGeometry — `shrub`
     * is 7 intersecting cards, `weedTuft` 4, and a palm frond is 26 leaflet
     * quads on a spine — and all of them carry uv 0..1 over the quad. So the
     * library tile maps 1:1 onto one card and the cutout is authored in card
     * space, which is the only thing that can serve a 0.85 m bush and a 0.16 m
     * leaflet from one material: it cuts the CARD's outline, not the leaves.
     *
     * The previous binding disabled the cutout (`alphaTest: 0`) because the old
     * generator cut per leaf, which shredded the leaflets. With the mask off,
     * the 82% of the tile that carried no leaf rendered as its vec3(0)
     * background: every bush in the game was a stack of matte black rectangles
     * with a few green ellipses on it, casting a hard black rectangular shadow.
     * Both halves are fixed in the generator now, so nothing is overridden here
     * beyond the tint.
     *
     * NO scale override. See the library entry — 1 is load-bearing twice over.
     */
    foliage: [
      'foliage',
      {
        // Near-neutral: the generator authors the greens. Arctic vegetation is
        // the grey-green of a lichen/scrub, and a stop darker under snow light.
        tint: theme.key === 'arctic'
          ? tintOf(0x93a389, 0.45, 0.9)
          : tintOf(0xbcd08a, 0.40, 1.0),
      },
    ],
    rubber: ['rubber', { scale: 0.45 }],

    // ---- weather-specific -------------------------------------------------
    // No scale override: the library's 4 m tile is the size the drift field,
    // the sastrugi and the crystal grain were authored at, and the dressing
    // berms have to be continuous with the ground they sit on.
    snow: ['snow', {}],
  };
}

// Per-theme overrides. Anything not listed here inherits the base binding.
const THEMES = {
  // Dustyard — sun-bleached mudbrick and rendered block over sand.
  desert: (theme) => ({
    // Compacted dirt, not open dune: a freight yard is driven over daily, and
    // sand's ripple normal reads as corrugated carpet across a 100 m span.
    ground: ['dirt', {
      scale: 3.6, tint: tintOf(0xe4cba0, 0.45, 1.12),
      normalStrength: 0.75, macroRelief: 0.3, macro: [0.055, 0.4, 0.16, 0.35],
      macroBig: [1.9, 0.11, 0.020, 0],
    }],
    /**
     * The T plaza. Wind ripples are 375 mm here (the generator lays 8 crests per
     * tile, 3.0 / 8), and their crests all run the same way, so the tile's
     * signature S-curve cluster was recognisable four-plus times in one frame
     * across the plaza.
     *
     * `uvMode: 'planar'` instead of the library's triplanar, which buys the fix
     * and pays for it at the same time: the pads are flat boxes, so on the face
     * that matters the triplanar blend already collapses to the Y frame alone
     * (weights are `pow(|n|, 5)` normalised) and the other two samples are
     * wasted — 9 fetches for the result of 3. Planar mode also unlocks
     * OW_DETILE, which blends a second sample rotated 36.6 deg and scaled 0.617
     * by a low-frequency mask: the crests then run two ways and the repeat has
     * no fixed phase. Net 6 fetches against the old 9.
     */
    padWarm: ['sand', {
      uvMode: 'planar', detile: 0.6,
      scale: 3.0, tint: tintOf(0xe8d0a4, 0.45, 1.02),
      normalStrength: 0.6, macroRelief: 0.22, macroBig: [1.8, 0.09, 0.022, 0],
    }],
    padCool: ['concrete_floor', { scale: 3.2, tint: tintOf(theme.wallB, 0.5), weather: [0.62, 0.1, 0.2, 0.5] }],
    // Mudbrick render is trowelled by hand in big sweeps, so its blotching is
    // coarser than a city facade's: 2.6 m rather than the 2.35 m base.
    wallN: ['plaster', { scale: 2.6, tint: tintOf(theme.wall, 0.5), weather: [0.55, 0.35, 0.62, 0.5] }],
    wallA: ['plaster', { scale: 2.25, tint: tintOf(theme.wallA, 0.5), patch: [0.34, 2.1, 0.16, -0.08] }],
    wallB: ['brick', { scale: 1.35, tint: tintOf(theme.wallB, 0.5) }],
    // Timber lintels and copings over mudbrick. `wood_case` at 1.8 m puts a
    // 200 mm sawn member across the 200 mm band, running unbroken along it —
    // the decking bake would lay a 475 mm staggered bond across a lintel.
    trim: ['wood_case', { scale: 1.8, tint: tintOf(theme.trim, 0.6, 0.72) }],
  }),

  // Harbor — wet concrete, corrugated warehouses, painted steel.
  coastal: (theme) => ({
    ground: ['concrete_floor', {
      scale: 3.4, tint: tintOf(theme.floor, 0.45),
      // Rain-slick: the whole quay reads darker and glossier than dry concrete.
      roughness: [0.68, -0.14, 0.05], weather: [0.1, 0.62, 0.75, 0.55],
      macroBig: [2.0, 0.115, 0.020, 0],
    }],
    padWarm: ['asphalt', {
      scale: 3.0, tint: tintOf(theme.wallA, 0.5), roughness: [0.7, -0.12, 0.05],
      macroBig: [1.9, 0.10, 0.024, 0],
    }],
    padCool: ['concrete_floor', { scale: 3.2, tint: tintOf(theme.wallB, 0.5), roughness: [0.7, -0.12, 0.05] }],
    wallN: ['concrete', { scale: 2.2, tint: tintOf(theme.wall, 0.5), weather: [0.2, 0.7, 0.75, 0.6] }],
    // 146 mm profile on 583 mm sheets — industrial "big six" cladding. At the
    // old 2.2 m tile the corrugations were 183 mm and the sheets 730 mm, which
    // is a garden shed blown up to warehouse size.
    wallA: ['corrugated', { scale: 1.75, tint: tintOf(theme.wallA, 0.5) }],
    wallB: ['concrete', { scale: 2.2, tint: tintOf(theme.wallB, 0.5), weather: [0.2, 0.7, 0.7, 0.6] }],
    trim: ['metal_painted', { scale: 1.1, tint: tintOf(theme.trim, 0.6, 0.72) }],
    metal: ['metal_painted', { scale: 1.05, tint: tintOf(0xb9c2c6, 0.4, 0.95), roughness: [0.8, -0.1, 0.06] }],
  }),

  // Frostline — a listening station buried in wind-packed snow.
  arctic: (theme) => ({
    ground: ['snow', {}],
    padWarm: ['snow_packed', { scale: 1.5, tint: tintOf(0xdfe9ee, 0.35, 1.0) }],
    padCool: ['snow_packed', { scale: 1.5, tint: tintOf(0xd6e2ea, 0.4, 0.96) }],
    // Walkway grating and equipment decks, not sheet: 1.1 m puts a real
    // brushed panel under foot instead of one smear over a 1.6 m tile.
    padPlat: ['metal_brushed', { scale: 1.1, tint: tintOf(0x9fb0bb, 0.45, 0.8) }],
    padPlatB: ['metal_brushed', { scale: 1.0, tint: tintOf(0x93a5b2, 0.45, 0.75) }],
    // Insulated cladding panels are ~1 m wide; 1.8 m keeps the paint blistering
    // and the panel chipping at the size a hut actually wears them.
    // The splash band runs to 0.85 m because what climbs an arctic wall is a
    // drift, not rain-thrown dirt — and CLIMATE.arctic makes it snow-coloured.
    wallN: ['metal_painted', { scale: 1.8, tint: tintOf(theme.wall, 0.5), weather: [0.3, 0.35, 0.85, 0.5] }],
    wallA: ['corrugated', { scale: 1.75, tint: tintOf(theme.wallA, 0.5), weather: [0.3, 0.4, 0.85, 0.45] }],
    wallB: ['concrete', { scale: 2.2, tint: tintOf(theme.wallB, 0.5), weather: [0.15, 0.5, 0.9, 0.55] }],
    trim: ['metal_painted', { scale: 1.0, tint: tintOf(theme.trim, 0.6, 0.72) }],
    crate: ['wood_case', { scale: 1.15, tint: tintOf(0xc3ad8e, 0.5, 0.98) }],
  }),

  // Neon Foundry — night shift: oiled steel, painted plant, wet floor.
  neon: (theme) => ({
    ground: ['asphalt', {
      scale: 3.2, tint: tintOf(theme.floor, 0.45), roughness: [0.72, -0.12, 0.05],
      macroBig: [2.0, 0.12, 0.022, 0],
    }],
    padWarm: ['concrete_floor', { scale: 3.0, tint: tintOf(theme.wallA, 0.5), roughness: [0.75, -0.1, 0.06] }],
    padCool: ['concrete_floor', { scale: 3.0, tint: tintOf(theme.wallB, 0.5), roughness: [0.75, -0.1, 0.06] }],
    padPlat: ['metal_brushed', { scale: 1.2, tint: tintOf(0x6d7a86, 0.5, 0.6) }],
    padPlatB: ['metal_brushed', { scale: 1.1, tint: tintOf(0x63727f, 0.5, 0.55) }],
    wallN: ['metal_painted', { scale: 1.9, tint: tintOf(theme.wall, 0.5), weather: [0.25, 0.5, 0.6, 0.55] }],
    // The rust bake is authored for 1.2 m; at 2.0 m each bloom was a 300 mm
    // continent and the plant read as camouflage paint.
    wallA: ['metal_rust', { scale: 1.2, tint: tintOf(theme.wallA, 0.5) }],
    wallB: ['concrete', { scale: 2.1, tint: tintOf(theme.wallB, 0.5), weather: [0.2, 0.55, 0.7, 0.6] }],
    trim: ['metal_brushed', { scale: 0.9, tint: tintOf(theme.trim, 0.6, 0.72) }],
    metalGrid: ['metal_brushed', { scale: 0.6, tint: tintOf(0x7f8d97, 0.45, 0.7) }],
  }),

  // Citadel — dressed ashlar, timber galleries, gravel courts.
  citadel: (theme) => ({
    // 43 / 24 / 11 mm aggregate grades. At 2.6 m they were 59/33/15 mm, which
    // is railway ballast; a court is walked on, so it is roadstone.
    ground: ['gravel', {
      scale: 1.9, tint: tintOf(0xbfae8e, 0.45, 1.0),
      macroBig: [1.9, 0.10, 0.020, 0],
    }],
    padWarm: ['stone_floor', { scale: 2.6, tint: tintOf(theme.wallA, 0.5) }],
    padCool: ['stone_floor', { scale: 2.75, tint: tintOf(theme.wallB, 0.5) }],
    padPlat: ['stone_floor', { scale: 2.5, tint: tintOf(theme.wallA, 0.5) }],
    padPlatB: ['stone_floor', { scale: 2.65, tint: tintOf(theme.wallB, 0.5) }],
    // The ashlar bake is authored for a 2 m tile: 2-4 blocks to a course of
    // unequal height, so a block is 500-1000 x 220-390 mm with an 18 mm
    // perpend — a stone two people can lift. The three wall keys sit within
    // 10% of that so the whole fortress is one quarry, cut on three days.
    wallN: ['stone', { scale: 1.95, tint: tintOf(theme.wall, 0.5) }],
    wallA: ['stone', { scale: 1.8, tint: tintOf(theme.wallA, 0.5) }],
    wallB: ['stone', { scale: 2.1, tint: tintOf(theme.wallB, 0.5) }],
    // Timber galleries and door heads in a stone fortress: a sawn beam, so the
    // long-slat bake at 1.8 m — 200 mm members, no staggered bond on a lintel.
    trim: ['wood_case', { scale: 1.8, tint: tintOf(theme.trim, 0.6, 0.72) }],
    crate: ['wood_case', { scale: 1.15, tint: tintOf(0xc7a878, 0.55, 1.0) }],
  }),
};

/**
 * The two tinted siblings of every wall key.
 *
 * A street where every building is the same colour is the loudest procedural
 * tell in the frame, and it is the one thing a limited palette cannot fix by
 * itself. Real terraces differ by a few degrees of hue and a stop of value —
 * the same render mixed on a different day, or repainted a decade apart — so
 * these are small, deliberate shifts, not a rainbow.
 *
 * `scale` moves +/-9% as well, which is the part that matters at range: two
 * neighbouring facades on the same tile scale phase-align, and a brick course
 * running dead level across a party wall is what makes two buildings read as
 * one flat backdrop. On the lattice surfaces this is not a fudge either —
 * +/-9% off the 215 mm metric brick is 197 and 234 mm, both of which are real
 * formats, and on ashlar it is simply a different quarry.
 */
/**
 * The shift is a value scale plus a pull toward one of two references, NOT an
 * HSL hue rotation. `tintOf` normalises its brightest channel to 1, so a theme
 * colour that is already near-neutral (Dustyard's `#a8a69c` becomes
 * `(1.00, 0.99, 0.96)`) has almost no hue left to rotate and any lightness
 * push clips straight to white — measured: `wallB3` came out exactly
 * `(1,1,1)`, i.e. no variant at all. Pulling toward a warm or a cool reference
 * separates the siblings whatever the base is, and cannot clip: both
 * references peak at 1.0 and the value scale tops out at 1.02.
 */
const REF_WARM = new THREE.Color(1.0, 0.93, 0.82); // sunned ochre render
const REF_COOL = new THREE.Color(0.86, 0.93, 1.0); // shaded grey-blue render

const WALL_VARIANTS = [
  { val: 0.85, ref: REF_WARM, chroma: 0.34, tile: 1.09 },
  { val: 1.02, ref: REF_COOL, chroma: 0.28, tile: 0.91 },
];

function wallVariant(entry, v) {
  const [surface, opts] = entry;
  const tint = (opts.tint ? opts.tint.clone() : WHITE.clone());
  tint.multiplyScalar(v.val).lerp(v.ref, v.chroma);
  // The brightest value any generator writes is 0.88 linear (plaster), so a
  // tint channel of 1.02 lands at 0.90 — the ceiling of the reflectance rule.
  const max = Math.max(tint.r, tint.g, tint.b);
  if (max > 1.02) tint.multiplyScalar(1.02 / max);
  return [surface, { ...opts, tint, scale: Math.round((opts.scale ?? 2) * v.tile * 1000) / 1000 }];
}

/**
 * The reveal / soffit variant of a wall.
 *
 * It used to be the same surface at 0.68x the tile, "so the masonry does not
 * read oversized". That reasoning holds for a noise surface like plaster and is
 * backwards for every lattice one: a pilaster is built from the SAME bricks as
 * the wall behind it, and 0.68 shrank a 215 mm brick to 146 mm on every window
 * reveal, arch ring and parapet in the game.
 *
 * Now the physical size matches and the difference is where it actually is on a
 * building: a reveal is a returned face in its own shadow, sheltered from the
 * rain that washes the elevation and holding the dirt that the rain would have
 * taken off. 0.84 is about a third of a stop. It also means an `s` key and its
 * parent are two materials over one bake, not two of each.
 */
function smallOf([surface, opts]) {
  const tint = (opts.tint ? opts.tint.clone() : WHITE.clone()).multiplyScalar(0.84);
  return [surface, { ...opts, tint }];
}

/**
 * Build every material a map needs.
 *
 * Library materials are shared and cached by the MaterialSystem — they must NOT
 * be disposed when a map unloads. The handful of hand-built specials (neon,
 * glow, water) are ours, and come back in `owned` so the world can free them.
 *
 * @param {import('../gfx/materials/index.js').MaterialSystem} materials
 * @param {object} theme  the map definition's theme block
 * @returns {{ mats: Object<string, THREE.Material>, owned: THREE.Material[] }}
 */
export function createThemeMaterials(materials, theme) {
  const table = { ...base(theme), ...(THEMES[theme.key] ? THEMES[theme.key](theme) : {}) };

  // Weathering colours belong to the map, not to the surface: see CLIMATE.
  const climate = CLIMATE[theme.key];
  if (climate) {
    for (const key of Object.keys(table)) {
      const [surface, opts] = table[key];
      if (CLIMATE_SKIP.has(surface)) continue;
      table[key] = [surface, {
        dustColor: climate.dustColor,
        grimeColor: climate.grimeColor,
        ...opts,
      }];
    }
  }

  // Two tinted siblings per wall key, then the reveal variant of all nine.
  for (const key of ['wallN', 'wallA', 'wallB']) {
    table[key + '2'] = wallVariant(table[key], WALL_VARIANTS[0]);
    table[key + '3'] = wallVariant(table[key], WALL_VARIANTS[1]);
  }
  for (const key of ['wallN', 'wallN2', 'wallN3', 'wallA', 'wallA2', 'wallA3',
    'wallB', 'wallB2', 'wallB3']) {
    table[key + 's'] = smallOf(table[key]);
  }

  // ---- specials: emissive, transparent, or otherwise not a plain surface ---
  table.glass = ['glass', { tint: tintOf(theme.key === 'arctic' ? 0xbfe4f0 : 0xdff0f4, 0.35) }];

  table.solar = ['metal_brushed', {
    scale: 1.1,
    tint: tintOf(0x1a2c46, 0.85, 0.28),
    roughness: [0.35, -0.16, 0.04],
    three: { metalness: 1, envMapIntensity: 1.4 },
  }];

  table.hotMetal = ['metal_rust', {
    scale: 0.9,
    tint: tintOf(0x7a4030, 0.8, 0.55),
    three: { emissive: 0xff4c18, emissiveIntensity: 0.55 },
  }];

  // Hazard paint: bright industrial yellow that keeps a little glow at night so
  // it still reads as a warning marker under the foundry's blue key light.
  table.warning = ['metal_painted', {
    scale: 0.7,
    tint: tintOf(0xffc23d, 0.92, 1.0),
    three: { emissive: 0x3a2200, emissiveIntensity: 0.5 },
  }];

  const owned = [];
  const emissive = (color, intensity) => {
    const mat = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: intensity,
      roughness: 0.4,
      metalness: 0,
    });
    owned.push(mat);
    return mat;
  };
  const specials = {
    neonA: () => emissive(new THREE.Color(theme.accentA), 3.2),
    neonB: () => emissive(new THREE.Color(theme.accentB), 3.2),
    iceGlow: () => emissive(new THREE.Color(0x78ddff), 1.8),
    water: () => {
      const mat = new THREE.MeshStandardMaterial({
        color: 0x24515f,
        roughness: 0.08,
        metalness: 0.25,
        transparent: true,
        opacity: 0.82,
        envMapIntensity: 1.6,
      });
      owned.push(mat);
      return mat;
    },
  };

  /**
   * Resolved on first touch, not up front. Every map declares the same key set
   * but uses maybe half of it, and each unused key that resolves eagerly costs
   * a full GPU bake (~250 ms) and ~12 MB of VRAM for a texture set nothing
   * samples — Dustyard was baking snow and ashlar it never draws. The wall
   * variants ride on this too: a map that never asks for `wallN2` pays nothing,
   * and one that does pays for a material, not a bake.
   */
  const resolve = (cache, key, extra) => {
    if (cache.has(key)) return cache.get(key);
    let mat;
    if (specials[key]) mat = specials[key]();
    else if (!table[key]) return undefined;
    else if (materials) mat = materials.get(table[key][0], { ...table[key][1], ...extra });
    else {
      // No library: the Node map tests build a World without a renderer, and
      // they check layout, collision and navigation — not what it is made of.
      mat = new THREE.MeshStandardMaterial({ color: 0x8a8a8a, roughness: 0.9 });
      owned.push(mat);
    }
    cache.set(key, mat);
    return mat;
  };
  const proxy = (extra) => {
    const cache = new Map();
    return new Proxy(Object.create(null), {
      get: (_t, key) => (typeof key === 'string' ? resolve(cache, key, extra) : undefined),
      has: (_t, key) => key in table || key in specials,
      ownKeys: () => [...new Set([...Object.keys(table), ...Object.keys(specials)])],
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    });
  };

  // Two views of the same table. Set dressing (src/world/dressing.js) authors
  // wear/grime/AO into vertex colours, so it needs the variant of each surface
  // that reads them; the map's own boxes share one unit geometry and cannot.
  return { mats: proxy(null), decor: proxy({ vertexMasks: true }), owned };
}
