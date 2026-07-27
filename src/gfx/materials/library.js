import * as THREE from 'three';
import { CONCRETE, BRICK, PLASTER, TILE } from './glsl/surfaces-arch.js';
import { ASPHALT, SAND, DIRT, GRAVEL } from './glsl/surfaces-ground.js';
import { METAL_RUST, METAL_PAINTED, METAL_BRUSHED, CORRUGATED } from './glsl/surfaces-metal.js';
import { WOOD, FABRIC, BURLAP, FOLIAGE, RUBBER, GLASS } from './glsl/surfaces-organic.js';
import { SNOW, STONE } from './glsl/surfaces-extra.js';

/**
 * The surface library.
 *
 * `bake`  — how the texture set is generated (resolution, the metres the tile
 *           spans, and the peak-to-trough relief that sets the normal slope).
 * `mat`   — parameters for the material shader extension (see shader.js).
 * `three` — properties applied straight to the THREE material.
 * `surface` — the shared physics/FX surface vocabulary from ARCHITECTURE.md.
 *
 * ---------------------------------------------------------------------------
 * MEASURED MEAN ALBEDO, AND WHAT THE MATERIAL SHOULD REFLECT
 *
 * How to reproduce (the numbers below are from this procedure, `high` quality,
 * so 1K bakes): draw the baked albedo texture across an 8x8 float render target
 * with a `toneMapped: false` MeshBasicMaterial. Each pixel then covers 128x128
 * texels, so the hardware samples mip 7 and the 64 pixels average to the tile
 * mean; the texture is SRGB8 so the sample is already linear. Then
 * `luma = 0.2126 r + 0.7152 g + 0.0722 b`.
 *
 *   surface          mean luma   the real material     verdict
 *   snow_packed      0.703       old snow 0.50-0.70    in band
 *   snow             0.700       "                     in band
 *   stone            0.272       limestone 0.30-0.45   0.2 stops under
 *   stone_floor      0.269       "                     0.2 under
 *   metal_brushed    0.276       (metalness 1: this is F0, steel ~0.56)
 *   sand             0.264       dry sand 0.25-0.40    in band
 *   plaster          0.250       render 0.30-0.45      0.3 under
 *   burlap           0.185       hessian 0.14-0.18     in band
 *   corrugated       0.176       painted sheet 0.20-0.35   0.3 under
 *   concrete         0.150       concrete 0.25-0.35    0.9 under
 *   concrete_floor   0.146       "                     0.9 under
 *   wood_case        0.144       weathered pine 0.15-0.25  at the edge
 *   wood             0.130       silvered timber 0.12-0.18 in band
 *   dirt             0.112       dry earth 0.20-0.30   1.2 under
 *   gravel           0.095       roadstone 0.15-0.25   0.9 under
 *   foliage          0.095       broadleaf 0.10-0.13   at the edge
 *   metal_painted    0.087       painted steel 0.20-0.40   1.5 under
 *   brick            0.067       brick 0.15-0.25       1.6 under
 *   metal_rust       0.051       rust 0.10-0.20        1.2 under
 *   asphalt          0.043       asphalt 0.05-0.12     at the edge
 *   rubber           0.033       tyre 0.02-0.05        in band
 *   glass            0.020       (diffuse ~0.02)       in band
 *
 * Two things follow from this table, and both have been mis-diagnosed before.
 *
 * 1. THE VALUE OF A SURFACE IS SET HERE, NOT BY THE THEME TINT. Across all five
 *    themes every tint `surfaces.js` produces has a luma between 0.61 and 1.02
 *    (0.74 of a stop, and its brightest channel is capped at the reflectance
 *    ceiling), while the bakes above span 0.020 to 0.703 — 5.1 stops. An audit
 *    that reads a theme colour, then a tint, and concludes the material is
 *    "N stops hot" has measured neither the albedo nor the frame.
 * 2. The systematic bias is DOWN, not up: eleven of these are below the material
 *    they represent and only `metal_brushed` (as a specular colour) is arguably
 *    the other way. Raising the frame-dominating ones (dirt, concrete, brick,
 *    metal_painted) is the change that would let the sun and ambient
 *    intensities come DOWN, but it must be done with the lighting pass, not
 *    against it — it moves every frame in the game by most of a stop. The four
 *    prop-scale ones fixed in this wave (foliage, wood, wood_case, burlap) move
 *    the Dustyard mid-lane reference frame by 0.09 of a stop, measured:
 *    median 50.28 -> 53.41, p90 142.86 -> 143.15, at the MEASURING.md camera
 *    ((-2,1.7,20) -> (-2,1.6,-10), world pumped 120 steps).
 */
export const LIBRARY = {
  // ------------------------------------------------------------ masonry ----
  concrete: {
    glsl: CONCRETE,
    surface: 'concrete',
    bake: { size: 1024, worldSize: 2.5, relief: 0.09, seed: 11, param: [1, 0, 0, 0] },
    mat: {
      scale: 2.5,
      parallax: 0.016,
      detile: 0.4,
      detail: [9, 0.95, 0.58, 26],
      macro: [0.085, 0.62, 0.24, 0.45],
      // 3-4 m pour/wash variation at real contrast plus a 12 m band, so a long
      // retaining wall or a barrier run is not one value end to end.
      macroBig: [2.05, 0.130, 0.028, 0],
      patch: [0.28, 2.0, 0.145, -0.08],
      weather: [0.42, 0.4, 0.55, 0.5],
      wearColor: 0x9a978f,
      dustColor: 0x8b7f6a,
      grimeColor: 0x2b2823,
      roughness: [0.98, -0.01, 0.24],
    },
  },
  concrete_floor: {
    glsl: CONCRETE,
    surface: 'concrete',
    bake: { size: 1024, worldSize: 2.5, relief: 0.075, seed: 47, param: [0, 1, 0, 0] },
    mat: {
      scale: 3.2,
      parallax: 0.01,
      detile: 0,
      detail: [9, 0.90, 0.52, 26],
      macro: [0.075, 0.48, 0.18, 0.3],
      macroRelief: 0.3,
      weather: [0.55, 0.1, 0.15, 0.5],
      roughness: [1.0, 0.0, 0.22],
    },
  },
  brick: {
    glsl: BRICK,
    surface: 'concrete',
    bake: { size: 1024, worldSize: 1.35, relief: 0.055, seed: 23 },
    mat: {
      scale: 1.35,
      // 0.12 of height range x 0.024 m = ~2.5 mm of mortar parallax
      parallax: 0.024,
      parallaxLayers: 24,
      detile: 0,
      detail: [7, 0.88, 0.48, 22],
      macro: [0.09, 0.58, 0.22, 0.55],
      macroBig: [1.95, 0.115, 0.03, 0],
      weather: [0.4, 0.5, 0.6, 0.55],
      wearColor: 0xa08678,
      grimeColor: 0x241f19,
      roughness: [0.98, -0.01, 0.26],
    },
  },
  plaster: {
    glsl: PLASTER,
    surface: 'plaster',
    bake: { size: 1024, worldSize: 2.2, relief: 0.06, seed: 5 },
    mat: {
      scale: 2.2,
      parallax: 0.014,
      detile: 0.8,
      detail: [10, 0.95, 0.54, 24],
      // 0.085 puts the coarsest band of the macro map at ~4 m; the contrast
      // expansion is what turns it from a 5% wash into a real 20% swing, and the
      // second band at 0.026 zones the facade at ~13 m. Between them a 12 m
      // elevation reads as damp/dry/bleached areas instead of one flat colour.
      macro: [0.085, 0.72, 0.26, 0.5],
      macroBig: [2.15, 0.150, 0.026, 0],
      // ~18% of every facade is a replastered rectangle at +/-17% value.
      // A 12 m elevation seen at 3 m is mostly ONE surface, so the only thing
      // that can stop it reading as flat colour is structure at 1-4 m.
      patch: [0.34, 2.2, 0.175, -0.10],
      // streaks are gated by the runoff model now, so the amplitude can be real
      weather: [0.34, 0.5, 0.6, 0.5],
      wearColor: 0xb0a692,
      dustColor: 0x9c8a6c,
      grimeColor: 0x2a251d,
      roughness: [0.97, -0.02, 0.26],
    },
  },
  tile: {
    glsl: TILE,
    surface: 'concrete',
    bake: { size: 1024, worldSize: 1.5, relief: 0.03, seed: 31 },
    mat: {
      scale: 1.5,
      // 0.06 of height range x 0.03 m = ~1.8 mm of grout recess
      parallax: 0.03,
      parallaxLayers: 20,
      detail: [8, 0.6, 0.36, 18],
      macro: [0.09, 0.40, 0.16, 0.3],
      // tiled walls are laid in batches: whole areas came from a different kiln
      macroBig: [1.7, 0.075, 0.032, 0],
      patch: [0.14, 1.7, 0.10, -0.05],
      weather: [0.3, 0.2, 0.3, 0.5],
      roughness: [0.9, -0.04, 0.16],
    },
  },

  // ------------------------------------------------------------- ground ----
  asphalt: {
    glsl: ASPHALT,
    surface: 'concrete',
    bake: { size: 1024, worldSize: 3.0, relief: 0.075, seed: 71 },
    mat: {
      scale: 3.0,
      parallax: 0.014,
      detile: 1.0,
      // micro detail is gone by 16 m, so the near ground gains detail instead
      // of shimmering at range
      detail: [8, 0.8, 0.42, 18],
      macro: [0.062, 0.52, 0.22, 0.25],
      macroRelief: 0.55,
      weather: [0.45, 0.05, 0.1, 0.26],
      dustColor: 0x8b8071,
      grimeColor: 0x232120,
      roughness: [0.98, -0.02, 0.3],
    },
  },
  sand: {
    glsl: SAND,
    surface: 'sand',
    bake: { size: 1024, worldSize: 2.5, relief: 0.10, seed: 91 },
    mat: {
      uvMode: 'triplanar',
      scale: 2.5,
      detile: 0,
      detail: [8, 0.7, 0.30, 18],
      macro: [0.050, 0.44, 0.14, 0.35],
      macroRelief: 0.45,
      weather: [0.15, 0.0, 0.0, 0.18],
      dustColor: 0xa89066,
      grimeColor: 0x4c4132,
      roughness: [1.0, 0.0, 0.3],
    },
  },
  dirt: {
    glsl: DIRT,
    surface: 'dirt',
    bake: { size: 1024, worldSize: 2.5, relief: 0.12, seed: 13 },
    mat: {
      uvMode: 'triplanar',
      scale: 2.5,
      detail: [7, 0.85, 0.36, 18],
      macro: [0.055, 0.48, 0.18, 0.4],
      macroRelief: 0.6,
      weather: [0.2, 0.0, 0.0, 0.22],
      dustColor: 0x94805c,
      grimeColor: 0x37301f,
      roughness: [0.98, -0.02, 0.3],
    },
  },
  gravel: {
    glsl: GRAVEL,
    // 1K, not 512: at 512 the 9 mm grade was 2.5 texels wide and baked as
    // noise. Aggregate has to be resolved in the tile or it cannot be resolved
    // at all — the mip chain only ever removes information.
    bake: { size: 1024, worldSize: 1.6, relief: 0.055, seed: 57 },
    surface: 'dirt',
    mat: {
      uvMode: 'triplanar',
      scale: 1.6,
      detail: [6, 0.8, 0.34, 20],
      macro: [0.070, 0.44, 0.2, 0.3],
      macroRelief: 0.7,
      // Cavity grime on a surface whose height field IS its aggregate turns
      // every gap between stones into a black pit; 0.5 was most of the
      // bimodal histogram the critics measured on the road.
      weather: [0.2, 0.0, 0.0, 0.16],
      dustColor: 0xa2947a,
      grimeColor: 0x4a4238,
      roughness: [0.96, -0.03, 0.28],
    },
  },

  // -------------------------------------------------------------- metal ----
  metal_rust: {
    glsl: METAL_RUST,
    surface: 'metal',
    bake: { size: 1024, worldSize: 1.2, relief: 0.035, seed: 37 },
    mat: {
      scale: 1.2,
      parallax: 0.004,
      detail: [9, 0.7, 0.36, 16],
      macro: [0.10, 0.30, 0.14, 0.4],
      weather: [0.25, 0.4, 0.5, 0.35],
      wearColor: 0x8c8f93,
      wearMaterial: [0.28, 1.0, 0, 0.85],
    },
  },
  metal_painted: {
    glsl: METAL_PAINTED,
    surface: 'metal',
    bake: {
      size: 1024,
      worldSize: 1.5,
      relief: 0.018,
      seed: 61,
      tintA: 0x4a5340,
      tintB: 0x2a2f26,
    },
    mat: {
      scale: 1.5,
      parallax: 0.003,
      detail: [10, 0.6, 0.32, 16],
      macro: [0.10, 0.28, 0.14, 0.35],
      weather: [0.3, 0.45, 0.35, 0.35],
      wearColor: 0x8f9296,
      wearMaterial: [0.3, 1.0, 0, 0.9],
      // painted metal has to stay glossy enough to glint, but never mirror
      roughness: [0.92, -0.03, 0.22],
    },
  },
  metal_brushed: {
    glsl: METAL_BRUSHED,
    surface: 'metal',
    bake: { size: 512, worldSize: 0.8, relief: 0.004, seed: 83 },
    mat: {
      scale: 0.8,
      detail: [8, 0.25, 0.15, 8],
      macro: [0.09, 0.14, 0.1, 0.2],
      weather: [0.15, 0.15, 0.2, 0.2],
      wearColor: 0xb9bcc0,
      wearMaterial: [0.16, 1.0, 0, 0.9],
    },
    three: { anisotropy: 0.65, anisotropyRotation: 0, physical: true },
  },
  corrugated: {
    glsl: CORRUGATED,
    surface: 'metal',
    bake: { size: 1024, worldSize: 2.4, relief: 0.075, seed: 29 },
    mat: {
      scale: 2.4,
      parallax: 0.03,
      parallaxLayers: 24,
      detail: [10, 0.6, 0.32, 18],
      macro: [0.09, 0.26, 0.12, 0.3],
      weather: [0.3, 0.5, 0.5, 0.4],
      wearColor: 0x9aa0a4,
      wearMaterial: [0.32, 1.0, 0, 0.85],
    },
  },

  // ------------------------------------------------------------ organic ----
  wood: {
    glsl: WOOD,
    surface: 'wood',
    // param [slats, board-lengths, weathering]: 5 slats and 2 board lengths to
    // the tile, fully silvered — decking, treads, gallery floors. Butt-jointed
    // over its joists and staggered course to course, which is what decking is.
    bake: { size: 1024, worldSize: 2.0, relief: 0.038, seed: 19, param: [5, 2, 1, 0] },
    mat: {
      scale: 2.0,
      parallax: 0.008,
      detail: [10, 0.8, 0.42, 18],
      macro: [0.085, 0.34, 0.14, 0.5],
      weather: [0.3, 0.35, 0.5, 0.45],
      wearColor: 0xa88b62,
      wearMaterial: [0.5, 0.0, 0, 0.7],
    },
  },
  /**
   * Case timber: crates, batten frames, board doors, timber lintels.
   *
   * 9 slats to the tile and ONE board length, so a slat runs the full width of
   * the box and is jointed only where a corner post would be. At the 1.15 m tile
   * `crate` uses that is a 128 mm board with a 9 mm gap — a real packing case —
   * and a 1.1-1.5 m crate face carries one tile, so its boards no longer repeat
   * twice across themselves with the same knot in the same place.
   *
   * Weathering 0.45: a case is months old. The default 1.0 silvers pine to
   * 0x5f5b54 grey, which with a staggered bond is why every crate in the game
   * read as a sandstone block.
   *
   * Costs one extra 1K texture set (~17 MB) over sharing the decking bake. The
   * layout is baked into the tile, so there is no way to have both from one set:
   * `worldSize` is what the normal slope is derived from and `param` is what the
   * lattice is drawn from, and both are bake-time.
   */
  wood_case: {
    glsl: WOOD,
    surface: 'wood',
    bake: { size: 1024, worldSize: 1.15, relief: 0.022, seed: 19, param: [9, 1, 0.45, 0] },
    mat: {
      scale: 1.15,
      // 0.010 x 1.15 m x the 0.30 of height range the slat gap spans = 3.5 mm
      parallax: 0.010,
      parallaxLayers: 20,
      detail: [10, 0.85, 0.45, 18],
      macro: [0.11, 0.30, 0.14, 0.45],
      // Crates arrive in batches and stand in the sun for different lengths of
      // time: a 9 m band so a stack is not one colour end to end.
      macroBig: [1.7, 0.075, 0.11, 0],
      weather: [0.3, 0.25, 0.45, 0.42],
      wearColor: 0xbfa172,
      wearMaterial: [0.5, 0.0, 0, 0.7],
    },
  },
  fabric: {
    glsl: FABRIC,
    surface: 'fabric',
    // The weave carries ~0.3 of the height range, so 0.011 m of relief over a
    // 0.7 m tile is a ~1.5-2 mm thread bump at the 0.26 m mapping the awnings
    // use — a real weave, not a painted grid.
    bake: { size: 512, worldSize: 0.7, relief: 0.008, seed: 43, tintA: 0x5a5445, tintB: 0x3a3830 },
    mat: {
      scale: 0.7,
      detail: [6, 0.42, 0.28, 10],
      // 1.4 m macro at real contrast: sun-bleached panels and damp panels
      macro: [0.12, 0.34, 0.12, 0.3],
      macroBig: [1.8, 0.07, 0.09, 0],
      weather: [0.25, 0.2, 0.3, 0.35],
      normalStrength: 1.15,
      /**
       * Canvas passes 18% of the beam, its underside sits ~0.75 stops under its
       * top, and the drape structure is a 10 cm fold field. This is the whole
       * difference between fabric and painted cardboard.
       */
      cloth: [0.20, 0.72, 0.26, 0],
    },
    three: { physical: true, sheen: 0.55, sheenRoughness: 0.85, sheenColor: 0x8a8272 },
  },
  burlap: {
    glsl: BURLAP,
    surface: 'fabric',
    // hessian is coarse: a fat, visible thread bump
    bake: { size: 512, worldSize: 0.5, relief: 0.018, seed: 67 },
    mat: {
      scale: 0.5,
      parallax: 0.003,
      detail: [6, 0.4, 0.28, 9],
      macro: [0.14, 0.32, 0.12, 0.35],
      macroBig: [1.7, 0.06, 0.11, 0],
      weather: [0.4, 0.15, 0.35, 0.4],
      dustColor: 0x9c8760,
      normalStrength: 1.15,
      // a filled bag transmits far less than a stretched canvas
      cloth: [0.06, 0.86, 0.10, 0],
    },
    three: { physical: true, sheen: 0.4, sheenRoughness: 0.95, sheenColor: 0x9c8b68 },
  },
  /**
   * Vegetation. Mesh-uv at scale 1, i.e. ONE tile per quad — see the generator:
   * the cutout is a property of the card, so the tile has to line up with it.
   *
   * scale must stay 1 for a second reason: three's shadow depth material takes
   * the cutout from `map.a` at the raw `vMapUv` with the texture's own repeat
   * (1), while our extension multiplies by `owTile` — so any other scale makes
   * the shadow silhouette disagree with the visible one.
   *
   * 512 px over a 0.85 m shrub card is 1.7 mm/texel, and the finest thing in the
   * tile is the 14 mm serration on a 140 mm leaf: 8 texels, which survives mip 2
   * (i.e. out to ~7 m before the margin softens).
   */
  foliage: {
    glsl: FOLIAGE,
    surface: 'foliage',
    // 30 mm of leaf curl over a 0.6 m card. relief/worldSize is the normal slope
    // and 0.45 of the height range is leaf (the rest is the cutout step), so the
    // midrib works out at a ~14 deg tilt.
    bake: { size: 512, worldSize: 0.6, relief: 0.030, seed: 79 },
    mat: {
      uvMode: 'mesh',
      scale: 1,
      alphaMask: true,
      // The detail map is a mineral tooth — aggregate, grit, plaster float. On a
      // leaf it is wrong at any strength; the leaf's own surface is in the tile.
      detail: [3, 0.12, 0.06, 6],
      // 6 m band, so one bush in a clump differs from the next.
      macro: [0.17, 0.26, 0.10, 0.55],
      // No rain streaks and no ground splash on a leaf; the cavity term is what
      // darkens the deep canopy, and dust is what a roadside bush is covered in.
      weather: [0.22, 0.0, 0.0, 0.14],
      dustColor: 0xb8ae94,
      grimeColor: 0x1d2415,
      // "Wear" on a leaf is sun scorch, not rubbed-through grey paint.
      wear: [0.35, 0.5, 0.6, 0],
      wearColor: 0xc8c184,
      /**
       * Leaf transmission and the pale leaf underside — the two terms that
       * separate a leaf from a painted chip.
       *
       * cloth[0]: the shader adds `cloth.x * albedo * lobe * light`, and the
       * lobe runs 0.30 at normal incidence to 1.20 looking along the beam. So
       * the EFFECTIVE transmittance is cloth.x x albedo x lobe, not cloth.x:
       * with the leaf green now at 0.14 linear, 0.55 gives 0.023 across the
       * beam and 0.092 down it. A real leaf transmits 0.05-0.20 of green, so
       * that is the bottom half of the real range — which is what you want,
       * because the term is not shadowed. At the old 0.35 over an 0.058 green
       * albedo the peak was 0.024: measurably present, invisible on screen.
       *
       * cloth[1] > 1 is deliberate and it is the abaxial face. A leaf's
       * underside is PALER than its top — stomatal wax and hairs put its
       * visible reflectance ~1.1-1.3x the upper face — so 1.06 is the modest
       * end of that. The 0.88 it replaces was darkening the underside, which
       * doubled up with the AO term and is why a canopy seen from below read as
       * one dark sheet.
       */
      cloth: [0.55, 1.06, 0, 0],
      normalStrength: 1.25,
      roughness: [1.0, 0.0, 0.14],
    },
    three: {
      side: THREE.DoubleSide,
      /**
       * 0.30, matching the generator's split of `h`: inside the silhouette h is
       * >= 0.55, outside it is 0, so this cuts the card outline and never a leaf.
       * Low enough that a mip-blurred card keeps its body at range instead of
       * dissolving, and the mask averages 0.78 so the whole thing stays solid
       * once it is smaller than a mip footprint.
       */
      alphaTest: 0.3,
      physical: true,
      // Waxy cuticle: a tighter, paler lobe than cloth's.
      sheen: 0.45,
      sheenRoughness: 0.55,
      sheenColor: 0xc4d69a,
    },
  },
  rubber: {
    glsl: RUBBER,
    surface: 'rubber',
    bake: { size: 512, worldSize: 0.5, relief: 0.013, seed: 97 },
    mat: {
      scale: 0.45,
      detail: [7, 0.62, 0.42, 13],
      // A tyre stack is a dark mass low in the frame, so it has nothing but its
      // own variation to read by: bleached crowns, damp black sidewalls and the
      // road dust that fills the tread. Without these it is a grey lozenge.
      macro: [0.16, 0.36, 0.20, 0.18],
      macroBig: [1.8, 0.10, 0.11, 0],
      weather: [0.40, 0.18, 0.22, 0.45],
      dustColor: 0x8d8478,
      grimeColor: 0x181715,
      tint: 0xfffaf2,
      normalStrength: 1.25,
      roughness: [0.94, -0.03, 0.34],
    },
  },
  glass: {
    glsl: GLASS,
    surface: 'glass',
    bake: { size: 512, worldSize: 2.0, relief: 0.0008, seed: 3 },
    mat: {
      scale: 2.0,
      detail: [3, 0.06, 0.05, 6],
      macro: [0.05, 0.1, 0.06, 0.1],
      weather: [0.1, 0.3, 0.4, 0.15],
      normalStrength: 0.35,
      roughness: [0.9, -0.01, 0.03],
    },
    three: {
      physical: true,
      transparent: true,
      opacity: 0.22,
      side: THREE.DoubleSide,
      envMapIntensity: 1.6,
      ior: 1.52,
      specularIntensity: 1,
      depthWrite: false,
    },
  },

  // ------------------------------------------------- Tiny Strike additions --
  /**
   * Open drift field. 4 m tile, not 3: the generator's coarsest band is a
   * quarter of the tile, so 3 m capped the drifts at 750 mm and a 100 m basin
   * read as gravel. At 4 m the drift band is 1 m, the sastrugi 1.3 x 0.33 m and
   * the crystal grain 23 mm — 6 texels at 1024, which is the smallest thing
   * that survives mip 1.
   *
   * The macro layers matter more here than on any other surface. Snow is the
   * one material with almost no albedo variation of its own, so a repeated tile
   * is *visible* in a way it never is on brick; the 26 m macro band and the 50 m
   * macroBig band are what stop 25 x 25 tile repeats reading as a chequerboard,
   * and macroRelief is what gives the basin drifts larger than the tile.
   */
  snow: {
    glsl: SNOW,
    surface: 'sand',
    bake: { size: 1024, worldSize: 4.0, relief: 0.11, seed: 73, param: [0, 0, 0, 0] },
    mat: {
      uvMode: 'triplanar',
      scale: 4.0,
      detile: 0,
      // Fade at 30 m, not 20: on every other surface the micro layer is a
      // near-field bonus, but here it is the crystal tooth and it is the only
      // thing between the camera and flat white for the whole mid-ground.
      detail: [8, 0.72, 0.30, 30],
      macro: [0.038, 0.34, 0.16, 0.10],
      macroBig: [1.9, 0.055, 0.020, 0],
      macroRelief: 0.62,
      // Snow does not take dust, rain streaks or ground splash — the only
      // weathering it wants is the cavity term, and even that stays low or the
      // drift hollows go muddy instead of blue.
      weather: [0.0, 0.0, 0.0, 0.12],
      grimeColor: 0x51606e,
      roughness: [1.0, 0.0, 0.08],
    },
  },
  /**
   * Trodden snow on walkways. Not a reseed of the drift field: uParam.x = 1
   * switches the generator to a compacted trench with boot prints, refrozen
   * glaze in the prints and four times the trodden-in grit.
   */
  snow_packed: {
    glsl: SNOW,
    surface: 'sand',
    bake: { size: 1024, worldSize: 1.5, relief: 0.038, seed: 108, param: [1, 0, 0, 0] },
    mat: {
      scale: 1.5,
      detile: 0.5,
      detail: [8, 0.75, 0.30, 22],
      macro: [0.075, 0.36, 0.18, 0.16],
      macroBig: [1.8, 0.07, 0.03, 0],
      weather: [0.18, 0.0, 0.10, 0.30],
      dustColor: 0x8d8f92,
      grimeColor: 0x49525c,
      tint: 0xe6edf2,
      roughness: [0.95, 0.02, 0.12],
    },
  },
  /**
   * Ashlar. 2 m tile: with 2-4 blocks to a course that is a 500-1000 x 330 mm
   * stone, an 18 mm perpend and a 20 mm bed — a block two people can lift, laid
   * with the fat lime beds medieval work actually has. The old 2.6 m tile put
   * the blocks at 870 mm x 430 mm with 26 mm joints, which is quarry-face
   * cyclopean masonry and read as a cartoon castle.
   *
   * No detile. The de-tiler blends a rotated second sample by height, which on
   * a lattice surface crosses two block grids and produces joints that stop
   * halfway across a stone; the variety here comes from the per-course block
   * count and the per-block dressing instead.
   */
  stone: {
    glsl: STONE,
    surface: 'concrete',
    bake: { size: 1024, worldSize: 2.0, relief: 0.055, seed: 37, param: [0, 0, 0, 0] },
    mat: {
      scale: 2.0,
      /**
       * `parallax` is in TILE units, not metres — owPOM offsets the uv, and the
       * uv is world metres / scale. Apparent recess is therefore
       * `parallax x scale x (height fraction)`: 0.032 x 2.0 m x the joint's
       * 0.13 of the height range = 8 mm, which is what a raked lime joint
       * measures. (Elsewhere in this file the same figure is commented as if it
       * were metres; on brick, at scale 1.35, the two readings differ by less
       * than a millimetre, which is why it never showed up.)
       */
      parallax: 0.032,
      parallaxLayers: 24,
      detile: 0,
      detail: [8, 0.9, 0.5, 22],
      macro: [0.075, 0.55, 0.22, 0.45],
      macroBig: [2.0, 0.12, 0.026, 0],
      patch: [0.16, 2.4, 0.11, -0.06],
      weather: [0.4, 0.55, 0.6, 0.6],
      wearColor: 0xa89a80,
      dustColor: 0x93815f,
      grimeColor: 0x231f18,
      roughness: [0.97, -0.01, 0.24],
    },
  },
  /**
   * Paving. uParam.x = 1 dishes the flags, polishes a traffic lane through the
   * middle of them, silts up the joints and drops the lichen — a courtyard is
   * walked on, and the one surface in a fortress with any gloss on it is the
   * route everybody takes.
   */
  stone_floor: {
    glsl: STONE,
    surface: 'concrete',
    bake: { size: 1024, worldSize: 2.6, relief: 0.035, seed: 88, param: [1, 0, 0, 0] },
    mat: {
      scale: 2.6,
      // 0.018 x 2.6 m x 0.13 = 6 mm: a paving joint is shallower than a wall's
      // because it silts up, and a deep one at grazing angles swims.
      parallax: 0.018,
      parallaxLayers: 20,
      detile: 0,
      detail: [8, 0.8, 0.42, 20],
      macro: [0.06, 0.42, 0.20, 0.30],
      macroBig: [1.9, 0.09, 0.024, 0],
      macroRelief: 0.25,
      weather: [0.5, 0.0, 0.18, 0.5],
      wearColor: 0xb0a894,
      dustColor: 0x968a70,
      grimeColor: 0x221e18,
      roughness: [0.94, -0.03, 0.2],
    },
  },
};

/** Alias -> library key, so callers can ask for the physics surface name. */
export const ALIASES = {
  metal: 'metal_painted',
  steel: 'metal_brushed',
  rust: 'metal_rust',
  sandbag: 'burlap',
  ground: 'dirt',
  road: 'asphalt',
  stucco: 'plaster',
  wall: 'concrete',
  floor: 'concrete_floor',
  plank: 'wood',
  crate: 'wood_case',
  leaf: 'foliage',
  window: 'glass',
};

export function resolveName(name) {
  return LIBRARY[name] ? name : (ALIASES[name] ?? name);
}
