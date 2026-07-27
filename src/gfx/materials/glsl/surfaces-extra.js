/**
 * Surfaces Tiny Strike needs that the ported library does not carry: wind-packed
 * snow (Frostline) and hand-dressed ashlar masonry (Citadel).
 *
 * Same contract as every other generator in glsl/: one `owSurface` that writes
 * albedo (linear, authored through owSRGB so the swatches read like paint
 * chips), height 0..1, roughness, metalness and cavity AO, using only the
 * periodic helpers from noise.js so the bake tiles seamlessly.
 *
 * Both take a mode flag in `uParam.x`, the same way CONCRETE separates a
 * board-formed wall from a poured slab, so one generator serves two library
 * entries that are genuinely different surfaces rather than two seeds of one.
 */

/**
 * Wind-packed snow.  uParam.x: 0 = open drift field, 1 = trodden walkway.
 *
 * The thing that makes CG snow read as white plastic is treating it as one
 * bright value with a bump map on it. Real snow is a *height field carrying
 * four different finishes*, and all four have to be present or the eye rejects
 * it: matte crystalline crest, glazed wind slab that fractures into plates,
 * blue skylight pooling in every hollow (the hollow is lit by sky alone, and
 * snow absorbs red over a path length of a few centimetres — that blue is
 * subsurface, not a stylisation), and the occasional facet catching the sun.
 *
 * Authored for a 4 m tile, which is what puts the structure at real sizes:
 *   drifts     2 m        the shape you walk over
 *   sastrugi   1.3 x 0.33 m   wind-carved ridges, hard lee face
 *   ripples    45 mm      transverse wind ripples on the windward slopes
 *   plates     200 mm     wind-slab fracture
 *   grain      23 mm      6 texels at 1024, so it survives the mip chain
 * Albedo tops out at 0.90 — snow is bright, not emissive.
 */
export const SNOW = /* glsl */ `
void owSurface(vec2 uv, out vec3 alb, out float h, out float rough, out float metal, out float ao){
  const vec2 P = vec2(8.0);
  float trodden = uParam.x;
  vec2 p = uv * P + uSeed * 5.7;

  // ---- height: drifts, sastrugi, ripples ---------------------------------
  // The drift band is the coarsest thing a 4 m tile can hold; anything larger
  // is the macro-relief layer's job (see library.js snow.macroRelief).
  float drift = owFbm01(p * 0.25, P * 0.25, 4, 0.62);

  // Sastrugi. Sheared onto one axis so the whole field has one prevailing
  // wind, and profiled asymmetrically: wind erodes a long windward ramp and
  // leaves an abrupt lee face, which is the single cue that says "wind" rather
  // than "lumpy".
  vec2 sp = owShear(p * 1.5, 1.0, 4.0);
  vec2 sPer = owShearPer(P * 1.5, 4.0);
  float sast = owFbm01(sp, sPer, 4, 0.5);
  float ridge = pow(smoothstep(0.28, 0.86, sast), 1.9);
  // The lee face. Sampling the same field one step downwind and taking the
  // difference gives the sign of the slope, which is what separates the long
  // eroded windward ramp from the abrupt scoured face behind the ridge — a
  // symmetric value band cannot, and that is why symmetric "sastrugi" read as
  // random lumps.
  float sastDn = owFbm01(sp + vec2(0.40, 0.0), sPer, 4, 0.5);
  float lee = smoothstep(0.0, 0.10, sast - sastDn);

  // Transverse ripples, only on the windward slopes — a ripple field that
  // covers the lee faces as well reads as corduroy.
  vec2 rp = owShear(p * 11.0, 0.0, 0.25);
  float ripple = owFbm01(rp, owShearPer(P * 11.0, 0.25), 3, 0.5);
  float rippleMask = smoothstep(0.30, 0.62, sast) * (1.0 - lee);

  float pack = owFbm01(p * 4.0, P * 4.0, 5, 0.5);
  float grain = owFbm01(p * 22.0, P * 22.0, 4, 0.55);

  h = 0.50 + (drift - 0.5) * 0.34 + (ridge - 0.5) * 0.24
    + (pack - 0.5) * 0.06 + (grain - 0.5) * 0.018;
  h += (ripple - 0.5) * 0.045 * rippleMask;
  h -= lee * 0.06;

  // ---- wind slab: a glazed crust that fractures into plates ---------------
  // Slab forms where the wind scours (the crests), not in the hollows where
  // fresh snow keeps collecting, so the plate field is gated on height.
  vec4 crust = owWorley(p * 2.5, P * 2.5, 1.0);
  float slabZone = smoothstep(0.44, 0.68, drift * 0.55 + sast * 0.65) * (1.0 - trodden * 0.55);
  float plateEdge = smoothstep(0.075, 0.0, crust.y - crust.x);
  float plate = slabZone * step(0.30, crust.w);
  // Broken edges stand proud a few mm where one plate has been tipped up.
  h += plateEdge * plate * 0.055 * (0.4 + 0.6 * crust.z);

  // ---- trodden: boot compaction and the churn either side of a path ------
  float boot = 0.0;
  if (trodden > 0.0) {
    // A walkway is a trench: compacted 30-60 mm below the field, with the
    // ridges knocked flat and the print pattern still legible in the crust.
    vec4 tread = owWorley(p * 6.0, P * 6.0, 0.85);
    boot = smoothstep(0.34, 0.05, tread.x) * step(0.25, tread.w) * trodden;
    h = mix(h, 0.42 + (pack - 0.5) * 0.10 + (grain - 0.5) * 0.03, trodden * 0.72);
    h -= boot * 0.10;
    h += smoothstep(0.30, 0.0, tread.y - tread.x) * boot * 0.04;  // squeezed rim
  }

  // ---- colour -------------------------------------------------------------
  vec3 cCrest  = owSRGB(vec3(0.930, 0.944, 0.962));
  vec3 cHollow = owSRGB(vec3(0.734, 0.786, 0.864));   // sky-lit, hence blue
  vec3 cDeep   = owSRGB(vec3(0.572, 0.660, 0.786));   // deep hollow / crevice
  vec3 cGrit   = owSRGB(vec3(0.512, 0.520, 0.532));   // blown grit, old snow
  /**
   * The blend is biased HIGH: a snowfield is mostly crest with blue only in
   * the hollows that are genuinely shadowed from the sun and lit by sky alone.
   * Centring it on the mean height instead (0.32 -> 0.72, so 0.45 crest at
   * h = 0.5) painted the whole basin the hollow colour and Frostline came out
   * lilac under a blue-ambient sky.
   */
  vec3 c = mix(cHollow, cCrest, smoothstep(0.24, 0.58, h));
  c = mix(cDeep, c, smoothstep(0.06, 0.30, h));
  // Grit and soot blown off the plant behind the station. Heavier on the
  // walkway, where it is trodden in rather than blown across.
  float grit = smoothstep(0.66, 0.95, owFbm01(p * 2.0 + 13.0, P * 2.0, 4, 0.5));
  c = mix(c, cGrit, grit * (0.20 + 0.34 * trodden));
  c *= 0.965 + 0.06 * grain;
  c *= 1.0 - (ripple - 0.5) * 0.05 * rippleMask;

  // ---- glazed ice in the troughs -----------------------------------------
  // Melt-freeze glaze pools where meltwater ran and refroze: darker (it is
  // transparent over dark air pockets), far smoother, distinctly cyan.
  float ice = smoothstep(0.42, 0.14, h)
            * smoothstep(0.40, 0.76, owFbm01(p * 1.0 + 4.0, P * 1.0, 3, 0.6));
  ice = max(ice, boot * 0.55);          // a boot print glazes as it refreezes
  c = mix(c, owSRGB(vec3(0.600, 0.694, 0.772)), ice * 0.58);

  // Wind slab is a hair darker and greyer than fresh crest — it is denser, so
  // less light gets back out of it.
  c = mix(c, c * vec3(0.955, 0.968, 0.990), plate * 0.7);

  // ---- facet sparkle ------------------------------------------------------
  // Individual crystals catching the sun. 15 mm cells at the authored 4 m tile
  // is ~4 texels at 1024 — small enough to read as glitter, big enough to
  // survive the bake. Driven mostly through ROUGHNESS: a glint is a specular
  // event, and pushing albedo past white is what makes CG snow look like icing.
  vec4 fac = owWorley(p * 34.0, P * 34.0, 1.0);
  float spark = smoothstep(0.13, 0.0, fac.x) * step(0.955, fac.z) * (1.0 - trodden * 0.4);

  // ---- material -----------------------------------------------------------
  // Crystalline snow is genuinely rough; wind slab is glazed; ice is near
  // polished. Three separate populations, not one value with noise on it.
  rough = 0.86 + (grain - 0.5) * 0.12;
  rough = mix(rough, 0.38, plate * 0.75);
  rough = mix(rough, 0.17, ice * 0.80);
  rough -= spark * 0.40;
  rough += grit * 0.06;

  metal = 0.0;
  ao = 1.0 - smoothstep(0.48, 0.16, h) * 0.20 - plateEdge * plate * 0.06 - boot * 0.10;

  alb = clamp(c + spark * 0.04, vec3(0.02), vec3(0.90));
  rough = clamp(rough, 0.10, 0.97);
  ao = clamp(ao, 0.66, 1.0);
  h = clamp(h, 0.0, 1.0);
}
`;

/**
 * Ashlar masonry — squared, hand-dressed blocks in lime joints.
 * uParam.x: 0 = wall, 1 = paving.
 *
 * Distinct from BRICK in every way that matters at 2 m. A brick is a moulded
 * unit: 6 x 18 identical modules per tile, and the variation is in the firing.
 * An ashlar block is a piece of quarried rock a mason squared up by hand, so
 * the things that have to vary are the ones a mason cannot control:
 *
 *   * course heights differ — the quarry sells what the bed yields, so the
 *     courses are 0.72x to 1.28x each other and no two walls scan the same;
 *   * the number of blocks in a course differs (2-4 here), and each course is
 *     shoved along by its own random, so no perpend ever lines up vertically;
 *   * every block is dressed with a claw chisel in ITS OWN direction, which is
 *     the texture you actually read at 1 m;
 *   * arrises are chipped, and a chip shows pale unweathered stone under the
 *     grey outer skin;
 *   * lichen grows where water sits — in the joints and on the upper arrises —
 *     never as an even wash over the face.
 *
 * Authored for a 2 m tile: a 3-block course gives 667 x 330 mm blocks (a stone
 * two people can lift), an 18 mm perpend and a 20 mm bed. At the library's old
 * 2.6 m default the blocks came out a metre wide and the fortress read as a
 * cartoon castle.
 */
export const STONE = /* glsl */ `
void owSurface(vec2 uv, out vec3 alb, out float h, out float rough, out float metal, out float ao){
  const vec2 P = vec2(8.0);
  const int  ROWS = 6;
  // Joint widths as a fraction of the TILE, so they stay 18/20 mm however many
  // blocks the course happens to have.
  const float JOINT_X = 0.009;
  const float JOINT_Y = 0.010;
  float floorMode = uParam.x;
  vec2 p = uv * P + uSeed * 4.3;

  // ---- courses of unequal height -----------------------------------------
  float total = 0.0;
  for (int i = 0; i < ROWS; i++) total += 0.72 + 0.56 * owHash11(float(i) * 7.3 + uSeed);
  float y = uv.y * total;
  float row = 0.0, rh = 1.0, rowBase = 0.0, acc = 0.0;
  for (int i = 0; i < ROWS; i++) {
    float hI = 0.72 + 0.56 * owHash11(float(i) * 7.3 + uSeed);
    if (y >= acc && y < acc + hI) { row = float(i); rh = hI; rowBase = acc; }
    acc += hI;
  }
  float rf = (y - rowBase) / rh;

  // ---- blocks: 2-4 per course, each course shoved by its own random -------
  float cols = 2.0 + floor(owHash11(row * 3.17 + uSeed + 0.5) * 2.999);
  float shove = owHash11(row * 1.91 + uSeed);
  float colF = uv.x * cols + shove;
  float col = floor(colF);
  vec2 id = vec2(mod(col, cols), row);
  vec4 rnd = owHash42(id + uSeed * 2.0);
  vec4 rnd2 = owHash42(id * 1.61 + 13.0 + uSeed);

  // Hand-dressed: a hair out of square and out of plane.
  vec2 f = vec2(fract(colF), rf);
  vec2 fj = f + (rnd.xy - 0.5) * vec2(0.018, 0.030);

  // Joint half-widths in block-local units.
  float JX = JOINT_X * cols * (1.0 + floorMode * 0.5);
  float JY = JOINT_Y * (total / rh) * (1.0 + floorMode * 0.5);
  float dxj = min(fj.x, 1.0 - fj.x);
  float dyj = min(fj.y, 1.0 - fj.y);

  // The joint edge wanders — a hand-cut arris is never a drawn line. SIGNED, so
  // joints do not all fatten: an unsigned wander added up to half a joint width
  // everywhere and turned the ashlar into rubble masonry.
  float chipN = owFbm01(p * 14.0, P * 14.0, 4, 0.5) - 0.5;
  float ex = smoothstep(JX * 0.74, JX * (1.02 + chipN * 0.40), dxj);
  float ey = smoothstep(JY * 0.74, JY * (1.02 + chipN * 0.40), dyj);
  float face = min(ex, ey);

  // ---- per-block surface coordinates -------------------------------------
  // Aspect-corrected, so tool marks and pitting stay isotropic whether the
  // course has two blocks in it or four.
  float aspect = (total / cols) / rh;
  vec2 bp = fj * vec2(aspect, 1.0) + rnd.zw * 27.0;
  vec2 BP = vec2(20.0);

  // Bedding planes: sedimentary stone splits along its bed, so the face has a
  // faint lamination running one way. Which way depends on how the mason set
  // the block — most beds laid flat, the odd one face-bedded.
  float bedK = step(0.82, rnd2.z) * 1.0;
  float bed = owFbm01(owShear(bp * 2.4, bedK, 3.0), owShearPer(BP * 2.4, 3.0), 4, 0.55);

  // Claw-chisel dressing. owScratches puts the cross-pitch at (1/stretch)/freq
  // of a block height, so bp*5.5 at stretch 7 is 9 mm — a real claw comb — with
  // ~60 mm strokes, running in this block's own direction. This is the band
  // that reads at 1 m and the reason a dressed stone is not a noise field.
  float claw = owScratches(bp * 5.5, BP * 5.5, 7.0, floor(rnd2.x * 2.0), 0.60);
  // Coarser punch work at 42 mm pitch, near the arrises where the mason
  // squared the block up before dressing the middle.
  float punch = owScratches(bp * 2.6, BP * 2.6, 3.0, floor(rnd2.y * 3.0), 0.66);
  float edgeN = min(dxj, dyj);                       // 0 at the joint, 0.5 mid-block
  float arrisZone = 1.0 - smoothstep(0.04, 0.20, edgeN);

  float pitN = owFbm01(bp * 6.5, BP * 6.5, 5, 0.5);
  /**
   * Vughs — the shelly voids in oolitic limestone. bp.y spans one block height,
   * so bp * 24 is a 14 mm cell on a 330 mm course (7 texels at the authored
   * 2 m tile, which is the smallest thing that survives the bake). At bp * 10
   * they were 33 mm across and a third of the cells were open: the wall read as
   * pumice, and the dot field was the loudest thing on it at half a metre.
   */
  vec4 pit = owWorley(bp * 24.0, BP * 24.0, 1.0);
  float vugh = smoothstep(0.16, 0.02, pit.x) * step(0.80, pit.w);

  // Broken arrises. ~1.6 joint-widths in from the edge, on a third of the
  // blocks: a knocked corner shows stone that never weathered, which is the
  // only genuinely light value on an otherwise grey wall.
  float edgeD = min(dxj / max(JX, 1e-4), dyj / max(JY, 1e-4));
  float chipMask = smoothstep(1.6, 0.2, edgeD)
                 * smoothstep(0.58, 0.80, owFbm01(bp * 7.0 + 3.0, BP * 7.0, 4, 0.5))
                 * step(0.62, rnd2.z);

  float faceH = 0.72 + (bed - 0.5) * 0.075 + (pitN - 0.5) * 0.05
              - vugh * 0.085 - claw * 0.048 - punch * arrisZone * 0.055
              - chipMask * 0.10
              + (rnd.z - 0.5) * 0.055;                 // each block sits proud/shy

  // Paving is walked flat: the blocks sit level and dish in the middle instead.
  float dish = 1.0 - smoothstep(0.0, 0.55, length(fj - 0.5));
  faceH = mix(faceH, 0.74 + (bed - 0.5) * 0.03 - dish * 0.045 + (rnd.z - 0.5) * 0.018,
              floorMode);

  // ---- the joint ----------------------------------------------------------
  float mSand = owFbm01(p * 20.0, P * 20.0, 4, 0.5);
  vec4 mGrain = owWorley(p * 26.0, P * 26.0, 1.0);
  // Pointing varies along the wall: struck flush here, raked back there, and
  // in places the lime has simply washed out and left a hole.
  float pointing = owFbm01(p * 1.0 + 6.0, P * 1.0, 3, 0.55);
  float jointDepth = 0.10 + 0.090 * pointing;
  float lost = smoothstep(0.68, 0.90, owFbm01(p * 3.5 + 21.0, P * 3.5, 4, 0.5));
  jointDepth += lost * 0.100;
  float mortarH = 0.72 - jointDepth - (mSand - 0.5) * 0.016
                - smoothstep(0.5, 0.0, mGrain.x) * 0.012;

  h = mix(mortarH, faceH, face);

  // ---- colour: five quarry families --------------------------------------
  vec3 cWarm = owSRGB(vec3(0.640, 0.590, 0.470));   // fresh oolite
  vec3 cPale = owSRGB(vec3(0.722, 0.702, 0.632));   // bleached, sun-facing
  vec3 cCool = owSRGB(vec3(0.508, 0.502, 0.478));   // grey, damp-weathered
  vec3 cIron = owSRGB(vec3(0.556, 0.436, 0.318));   // iron-stained bed
  vec3 cDark = owSRGB(vec3(0.298, 0.286, 0.260));   // sooted / deeply damp

  vec3 stone = mix(cCool, cWarm, rnd.w);
  stone = mix(stone, cPale, step(0.74, rnd2.w) * 0.62);
  stone = mix(stone, cIron, step(0.88, rnd2.y) * 0.55);
  stone *= 0.90 + 0.20 * rnd2.x;                     // block-to-block value
  stone *= 0.88 + 0.24 * bed;                        // lamination banding
  stone *= 0.93 + 0.14 * pitN;
  stone = mix(stone, cDark, vugh * 0.38);
  // The claw marks catch light on one flank and hold dirt in the groove. Both
  // halves are needed: a groove that only brightens reads as a scratch on
  // glass, and one that only darkens reads as a stain.
  stone = mix(stone, stone * 1.20, claw * 0.55);
  stone = mix(stone, stone * 0.86, punch * arrisZone * 0.55);

  stone = mix(stone, cPale * 1.10, chipMask * 0.75);

  vec3 mortar = mix(owSRGB(vec3(0.562, 0.545, 0.500)), owSRGB(vec3(0.322, 0.312, 0.288)),
                    smoothstep(0.25, 0.80, mSand));
  mortar *= 0.86 + 0.28 * owFbm01(p * 7.0, P * 7.0, 4, 0.6);
  // Sharp sand in the lime shows as bright specks.
  mortar = mix(mortar, owSRGB(vec3(0.640, 0.620, 0.575)),
               smoothstep(0.26, 0.02, mGrain.x) * 0.35);
  mortar = mix(mortar, cDark * 0.8, lost * 0.55);    // shadow where it washed out

  vec3 c = mix(mortar, stone, face);

  // ---- biology: two lichen species, both where water sits -----------------
  // Crustose grey-green on the damp band and along the beds, and black spot
  // lichen which colonises the joint faces first. Both are matte: lichen
  // RAISES roughness, which is the giveaway when it is done the other way.
  float damp = smoothstep(0.20, 0.62, owFbm01(p * 0.75, P * 0.75, 3, 0.6));
  float lich = smoothstep(0.52, 0.84, owFbm01(owWarp(p * 3.0 + 9.0, P * 3.0, 0.5, 3), P * 3.0, 5, 0.55));
  lich *= damp * mix(1.0, 0.32, face);
  float spot = smoothstep(0.74, 0.93, owFbm01(p * 8.0 + 31.0, P * 8.0, 4, 0.5)) * damp;
  spot *= mix(1.0, 0.45, face);
  c = mix(c, owSRGB(vec3(0.352, 0.386, 0.262)), lich * (0.52 - floorMode * 0.18));
  c = mix(c, owSRGB(vec3(0.152, 0.158, 0.140)), spot * 0.42);

  // ---- weathering ---------------------------------------------------------
  // Wall: rain sheets off every bed and stains the stone below it. The streak
  // runs along the FIRST shear axis, so it is fed p.yx — a streak elongated in
  // x is a tide mark, not rain. These are short: the metre-long runs under a
  // real ledge are added at runtime by the shader's runoff model.
  float streak = owScratches(p.yx * 1.25, P * 1.25, 9.0, 0.0, 0.66) * (1.0 - floorMode);
  c = mix(c, cDark, streak * 0.20);
  // Paving: no runoff, but a traffic lane worn along the route people take.
  float lane = smoothstep(0.35, 0.80,
                          owFbm01(vec2(p.x * 0.5, p.y * 1.5) + 17.0,
                                  vec2(P.x * 0.5, P.y * 1.5), 3, 0.6)) * floorMode;
  c = mix(c, c * 0.86, lane * 0.5);
  float silt = smoothstep(0.4, 0.9, mSand) * (1.0 - face) * floorMode;
  c = mix(c, owSRGB(vec3(0.240, 0.228, 0.196)), silt * 0.45);

  // Hairline fracture through a block or two — quarried stone splits.
  float crack = owCracks(p * 1.5, P * 1.5, 0.85, 0.030, 0.70);
  h -= crack * 0.06;
  c = mix(c, c * 0.42, crack * 0.65);

  // ---- material -----------------------------------------------------------
  // Weathered limestone is matte; lichen is matter still; the traffic lane on
  // paving is genuinely polished, which is the only gloss a courtyard has.
  rough = 0.90 + (pitN - 0.5) * 0.10 - smoothstep(0.45, 0.90, bed) * 0.06;
  rough += lich * 0.05 + spot * 0.04 + chipMask * 0.05;
  rough = mix(rough, 0.94 + (mSand - 0.5) * 0.06, 1.0 - face);   // mortar is matte
  rough -= lane * 0.26 * face;
  rough -= dish * floorMode * 0.10 * face;
  metal = 0.0;

  ao = mix(0.30, 1.0, smoothstep(0.0, 0.72, face));
  ao -= vugh * 0.20 + chipMask * 0.22 + lost * (1.0 - face) * 0.30 + crack * 0.40;

  alb = clamp(c, vec3(0.02), vec3(0.85));
  rough = clamp(rough, 0.32, 1.0);
  ao = clamp(ao, 0.12, 1.0);
  h = clamp(h, 0.0, 1.0);
}
`;
