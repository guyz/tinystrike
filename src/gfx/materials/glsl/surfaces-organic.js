/**
 * Wood, fabric, sandbag/burlap, foliage, rubber, glass.
 *
 * `h` is written to albedo.a by generator.js AND is the height the tangent
 * normal is Sobel-filtered from. On foliage it therefore has to be both the
 * alpha-test cutout and a usable leaf relief at the same time; see FOLIAGE for
 * how the range is split.
 */

/**
 * Sawn timber. uParam selects the LAYOUT, which is the difference between a
 * deck and a packing case:
 *
 *   uParam.x  slats per tile          (0 -> 5, the decking default)
 *   uParam.y  board lengths per tile  (0 -> 2, a butt joint every half tile)
 *   uParam.z  weathering 0..1         (0 -> 1, fully silvered)
 *
 * Why this is a parameter and not one layout for everything: at 2 boards per
 * tile with a hashed stagger the generator lays a running bond, and on a 0.62 m
 * crate tile that bond is 310 x 124 mm blocks with a 4 mm dark joint — which is
 * ashlar masonry, and is exactly what all 16 crate placements in Dustyard read
 * as. Decking really is butt-jointed over its joists and staggered course to
 * course, so the layout is right there and wrong on a case; a packing case is
 * slats running the full width of the box, jointed only at the corner post.
 */
export const WOOD = /* glsl */ `
void owSurface(vec2 uv, out vec3 alb, out float h, out float rough, out float metal, out float ao){
  const vec2 P = vec2(8.0);
  float PLANKS = uParam.x > 0.5 ? uParam.x : 5.0;
  float BOARDS = uParam.y > 0.5 ? uParam.y : 2.0;
  float AGE    = uParam.z > 0.0 ? uParam.z : 1.0;
  vec2 p = uv * P + uSeed * 12.9;

  // ---- plank layout: rows running along X, staggered butt joints ----
  float rowF = uv.y * PLANKS;
  float row = floor(rowF);
  float rf = fract(rowF);
  float stagger = owHash11(row + uSeed * 2.0);
  float lenF = uv.x * BOARDS + stagger;
  float board = floor(lenF);
  float lf = fract(lenF);
  vec4 rnd = owHash42(vec2(board, row) + uSeed);

  // gaps between boards
  const float GY = 0.035, GX = 0.010;
  float ey = min(smoothstep(0.0, GY, rf), smoothstep(0.0, GY, 1.0 - rf));
  float ex = min(smoothstep(0.0, GX, lf), smoothstep(0.0, GX, 1.0 - lf));
  float face = min(ex, ey);

  // ---- grain: rings stretched along the board, warped, with knots ----
  vec2 gp = vec2(lf * 2.0 + rnd.x * 13.0, rf + rnd.y * 7.0);
  vec2 GP = vec2(16.0, 8.0);
  float warp = owFbm(vec2(gp.x * 3.0, gp.y * 12.0), vec2(GP.x * 3.0, GP.y * 12.0), 4, 0.55);
  float ringCoord = gp.y * (14.0 + rnd.z * 12.0) + warp * 2.2 + rnd.w * 5.0;

  // knots pull the rings into a tight radial swirl
  vec2 knotP = vec2(0.25 + rnd.x * 0.5, 0.35 + rnd.y * 0.3);
  float kd = length((vec2(lf, rf) - knotP) * vec2(2.2, 1.0));
  float hasKnot = step(0.68, rnd.z);
  float knotPull = hasKnot * exp(-kd * 9.0);
  ringCoord = mix(ringCoord, kd * 42.0, clamp(knotPull * 1.6, 0.0, 1.0));

  float rings = fract(ringCoord);
  float ringDark = smoothstep(0.42, 0.5, rings) * (1.0 - smoothstep(0.5, 0.62, rings));
  float latewood = smoothstep(0.30, 0.52, rings);

  // fine fibre along the grain
  float fibre = owFbm01(owShear(p * 6.0, 0.0, 40.0), owShearPer(P * 6.0, 40.0), 4, 0.5);
  float micro = owFbm01(p * 22.0, P * 22.0, 3, 0.5);

  // ---- colour ----
  /**
   * Timber reflectance.
   *
   * MEASURED (top-mip readback of the baked albedo, linear luma): this program
   * used to average 0.090 for the case bake and 0.082 for the decking one.
   * Weathered softwood boarding measures 0.15-0.25 and silvered grey timber
   * 0.12-0.18, so every crate, door, lintel and boarded wall in the game was
   * 1-2 stops under the material it represents. In full sun the exposure hid it;
   * in shade it collapsed — the Dustyard review's "west wall renders at ~10%
   * luminance ... all of it is crushed" was a 0.061 albedo, not a lighting bug.
   *
   * Linear values these land on: light sapwood (0.34, 0.22, 0.115), mid heart
   * (0.175, 0.105, 0.048), ring/knot (0.055, 0.030, 0.016), silvered
   * (0.155, 0.145, 0.128). The grime layers at the bottom of this function are
   * raised by the same factor, or they simply take the gain straight back out.
   */
  vec3 wLight = owSRGB(vec3(0.618, 0.506, 0.373));
  vec3 wMid   = owSRGB(vec3(0.455, 0.358, 0.243));
  vec3 wDark  = owSRGB(vec3(0.260, 0.190, 0.133));
  vec3 wGrey  = owSRGB(vec3(0.430, 0.417, 0.393));   // weathered silver-grey
  vec3 c = mix(wLight, wMid, rnd.w * 0.8 + latewood * 0.5);
  c = mix(c, wDark, ringDark * 0.65);
  c *= 0.90 + 0.18 * fibre;
  c = mix(c, wDark * 0.7, clamp(knotPull * 2.2, 0.0, 1.0) * 0.8);

  // weathering: UV-bleached, silvered, worst on the exposed boards
  // 0.78, not 0.68: the grey target is a desaturated silver (blue at 83% of
  // red) and it is the only thing in this program that takes the pine hue out.
  // AGE scales the field, so this only really bites on the fully-silvered
  // decking bake (AGE 1) and barely moves the months-old case timber (AGE 0.45).
  float weather = smoothstep(0.20, 0.85, owFbm01(p * 0.8, P * 0.8, 3, 0.6)) * (0.4 + 0.6 * rnd.x) * AGE;
  c = mix(c, wGrey, weather * 0.78);
  // Case timber is months old, not years: it still has its own colour. This is
  // the second half of why a crate read as stone — silvered pine is grey.
  c = mix(c, mix(c, wLight, 0.42), (1.0 - AGE) * 0.55);

  float faceH = 0.74 - ringDark * 0.02 - latewood * 0.012 + (fibre - 0.5) * 0.03 + (micro - 0.5) * 0.008;
  faceH += (rnd.y - 0.5) * 0.035;              // boards cup and sit at different heights
  faceH -= clamp(knotPull * 1.5, 0.0, 1.0) * 0.03;

  // splits and checks running along the grain
  float split = owScratches(vec2(p.x, p.y) * 2.0, P * 2.0, 30.0, 0.0, 0.66) * weather;
  faceH -= split * 0.10;
  c = mix(c, wDark * 0.45, split * 0.7);

  // saw marks across the board
  float saw = owFbm01(owShear(p * 3.0, 0.0, 1.0) * vec2(30.0, 1.0), vec2(P.x * 90.0, P.y * 3.0), 3, 0.5);
  faceH += (saw - 0.5) * 0.012;

  // rounded / bashed board edges
  float edgeD = min(min(rf, 1.0 - rf) / GY, min(lf, 1.0 - lf) / GX);
  float bevel = 1.0 - smoothstep(0.0, 2.4, edgeD);
  faceH -= bevel * 0.035;
  c *= 1.0 - bevel * 0.10;
  c = mix(c, wLight * 1.15, bevel * smoothstep(0.5, 0.9, owFbm01(p * 20.0, P * 20.0, 3, 0.5)) * 0.35);

  // ---- gap between boards: dark, deep ----
  float m = smoothstep(0.05, 0.7, face);
  h = mix(0.44, faceH, m);
  c = mix(wDark * 0.25, c, m);
  rough = mix(0.95, 0.62 + 0.22 * fibre + weather * 0.20 + split * 0.15, m);
  ao = mix(0.25, 1.0, smoothstep(0.0, 0.5, face)) - bevel * 0.12 * m;
  metal = 0.0;

  /**
   * ---- nails ----
   *
   * Fixings are regularly SPACED — three per board length, where the batten
   * behind crosses it — but they are driven by hand, so they are never on an
   * exact lattice. The Dustyard review read "the nail dots sit on a regular
   * grid" straight off the unjittered fract(lf * 3.0 + 0.5) this replaces
   * (identical phase on every board, identical height on every row).
   *
   * Per fixing: +/-0.10 of the 1/3-board spacing along the board (+/-38 mm at
   * the 1.15 m case tile), +/-0.05 of the board width up it (+/-11 mm on a
   * 230 mm board), and one in six not driven at all.
   */
  float nCell = lf * 3.0 + 0.5;
  vec4 nr = owHash42(vec2(floor(nCell), row) * 1.31 + uSeed * 3.7);
  float nailY = 0.22 + (nr.y - 0.5) * 0.10;
  float nd = length(vec2(fract(nCell) - 0.5 + (nr.x - 0.5) * 0.20, rf - nailY) * vec2(1.4, 1.0));
  float nail = smoothstep(0.055, 0.030, nd) * m * step(0.3, rnd.w) * step(0.16, nr.z);
  h -= nail * 0.02;
  c = mix(c, owSRGB(vec3(0.230, 0.200, 0.170)), nail * 0.85);
  rough = mix(rough, 0.55, nail);
  metal = mix(metal, 0.85, nail * 0.7);
  ao -= nail * 0.25;
  // rust weep under the nail
  float weep = smoothstep(0.11, 0.05, nd) * step(0.3, rnd.w) * step(0.16, nr.z)
             * smoothstep(0.0, 0.6, rf - nailY) * m;
  c = mix(c, owSRGB(vec3(0.330, 0.185, 0.095)), clamp(weep, 0.0, 1.0) * 0.4);

  // grime — raised with the wood palette above (linear 0.030 / 0.045 luma), so
  // the cavity and soil layers still read as dirt rather than as a black wash
  float cavity = 1.0 - smoothstep(0.55, 0.78, h);
  c = mix(c, owSRGB(vec3(0.190, 0.176, 0.156)), cavity * 0.45);
  // ground-in dirt over the whole board
  float soil = smoothstep(0.40, 0.88, owFbm01(owWarp(p * 2.2 + 5.0, P * 2.2, 0.9, 3), P * 2.2, 5, 0.6));
  c = mix(c, owSRGB(vec3(0.235, 0.215, 0.183)), soil * 0.40);
  rough += soil * 0.08;

  alb = clamp(c, vec3(0.02), vec3(0.80));
  rough = clamp(rough, 0.25, 0.99);
  ao = clamp(ao, 0.12, 1.0);
  h = clamp(h, 0.0, 1.0);
}
`;

export const FABRIC = /* glsl */ `
void owSurface(vec2 uv, out vec3 alb, out float h, out float rough, out float metal, out float ao){
  const vec2 P = vec2(8.0);
  const float THREADS = 96.0;
  vec2 p = uv * P + uSeed * 3.9;

  // ---- plain weave: warp over weft on alternating cells ----
  vec2 t = uv * THREADS;
  vec2 cell = floor(t);
  vec2 f = fract(t) - 0.5;
  float over = mod(cell.x + cell.y, 2.0);   // 0 -> warp on top, 1 -> weft on top

  float warpProfile = cos(f.x * 3.14159) ;
  float weftProfile = cos(f.y * 3.14159);
  float top = mix(warpProfile, weftProfile, over);
  float bot = mix(weftProfile, warpProfile, over) * 0.45;
  float weave = max(top, bot);
  float threadId = owHash12(cell + uSeed);

  // ---- fuzz and slubs ----
  float fuzz = owFbm01(p * 12.0, P * 12.0, 3, 0.55);
  float slub = owFbm01(p * 14.0, P * 14.0, 4, 0.5);
  float macro = owFbm01(p * 1.2, P * 1.2, 4, 0.6);

  vec3 cA = uTintA;
  vec3 cB = uTintB;
  vec3 c = mix(cA, cB, threadId * 0.6 + slub * 0.4);
  c *= 0.865 + 0.215 * (weave * 0.5 + 0.5);
  c *= 0.960 + 0.075 * fuzz;
  c *= 0.90 + 0.20 * macro;

  h = 0.55 + weave * 0.30 + (fuzz - 0.5) * 0.03 + (slub - 0.5) * 0.05;
  rough = 0.86 + (1.0 - weave) * 0.08 + (fuzz - 0.5) * 0.06;
  metal = 0.0;
  ao = mix(0.82, 1.0, smoothstep(-0.4, 0.9, weave));

  // ---- drape folds ---------------------------------------------------------
  // Cloth under tension gathers into soft parallel ridges roughly a hand's width
  // apart, wandering as they run. At the 0.26 m mapping the awnings use, 2.6
  // cycles across the tile is a ~10 cm fold. A weave alone reads as printed
  // canvas; the fold field is what gives a canopy its shape between its poles.
  float foldC = uv.y * 2.6 + uv.x * 0.55 + owFbm01(p * 0.9, P * 0.9, 3, 0.62) * 2.2;
  float foldT = abs(fract(foldC) - 0.5) * 2.0;          // 0 at crest, 1 in trough
  float crest = 1.0 - foldT;
  float foldR = owHash11(floor(foldC) * 2.13 + uSeed);
  float fold = crest * crest * (0.55 + 0.75 * foldR);
  h += (fold - 0.30) * 0.115;
  c *= 0.895 + 0.21 * fold;
  ao -= (1.0 - crest) * 0.14;
  // the crease line itself is polished by handling and holds the dust
  float creaseLine = 1.0 - smoothstep(0.0, 0.10, foldT);
  rough -= creaseLine * 0.06;
  c *= 1.0 + creaseLine * 0.05;

  // ---- wear: threadbare patches, fraying, pulled threads ----
  float wearField = smoothstep(0.58, 0.82, owFbm01(owWarp(p * 2.0, P * 2.0, 0.8, 3), P * 2.0, 4, 0.55));
  c = mix(c, c * 1.35 + 0.02, wearField * 0.5);
  rough += wearField * 0.06;
  h -= wearField * 0.05;

  float pulled = owScratches(p * 3.0, P * 3.0, 18.0, 1.0, 0.68);
  h += pulled * 0.05;
  c *= 1.0 - pulled * 0.10;

  // ---- stains and dust ----
  float stain = smoothstep(0.55, 0.9, owFbm01(owWarp(p * 1.5 + 7.0, P * 1.5, 1.0, 3), P * 1.5, 5, 0.6));
  c = mix(c, c * 0.42 + owSRGB(vec3(0.09, 0.08, 0.06)), stain * 0.55);
  rough += stain * 0.05;

  float dust = smoothstep(0.4, 0.85, owFbm01(p * 6.0, P * 6.0, 4, 0.5));
  c = mix(c, owSRGB(vec3(0.400, 0.375, 0.335)), dust * 0.14);

  alb = clamp(c, vec3(0.02), vec3(0.85));
  rough = clamp(rough, 0.5, 0.99);
  ao = clamp(ao, 0.25, 1.0);
  h = clamp(h, 0.0, 1.0);
}
`;

export const BURLAP = /* glsl */ `
void owSurface(vec2 uv, out vec3 alb, out float h, out float rough, out float metal, out float ao){
  const vec2 P = vec2(8.0);
  const float THREADS = 34.0;      // hessian is coarse
  vec2 p = uv * P + uSeed * 4.7;

  vec2 t = uv * THREADS;
  vec2 cell = floor(t);
  vec2 f = fract(t) - 0.5;
  float over = mod(cell.x + cell.y, 2.0);

  // hessian threads are irregular: each one has its own thickness
  float twx = 0.62 + 0.30 * owHash12(vec2(cell.x, 0.0) + uSeed);
  float twy = 0.62 + 0.30 * owHash12(vec2(0.0, cell.y) + uSeed * 1.7);
  float warpP = cos(clamp(f.x / twx, -0.5, 0.5) * 3.14159);
  float weftP = cos(clamp(f.y / twy, -0.5, 0.5) * 3.14159);
  float top = mix(warpP, weftP, over);
  float bot = mix(weftP, warpP, over) * 0.40;
  float weave = max(top, bot);

  float fibre = owFbm01(owShear(p * 12.0, 0.0, 8.0), owShearPer(P * 12.0, 8.0), 3, 0.5);
  float macro = owFbm01(p * 1.0, P * 1.0, 4, 0.62);
  float dirt  = owFbm01(owWarp(p * 2.5, P * 2.5, 0.8, 3), P * 2.5, 5, 0.55);

  /**
   * Undyed jute is a grey-buff, not an ochre.
   *
   * MEASURED: the baked albedo averaged linear (0.265, 0.185, 0.082) — blue at
   * 31% of red. Real hessian sits near (0.19, 0.155, 0.105), i.e. blue at 55%
   * of red at about the same luma (0.16). Saturation, not value, was the bug:
   * with the sandbag key's warm tint on top, a Dustyard emplacement came out at
   * blue = 21% of red and read as a slab of gold — the most saturated object in
   * the frame, brighter than the plaster wall behind it.
   *
   * New linear values: jute (0.19, 0.155, 0.105), sun-bleached (0.30, 0.26,
   * 0.20). Luma is deliberately unchanged.
   */
  vec3 cJute = owSRGB(vec3(0.473, 0.430, 0.358));
  vec3 cPale = owSRGB(vec3(0.584, 0.547, 0.485));
  vec3 cSoil = owSRGB(vec3(0.230, 0.180, 0.120));
  vec3 c = mix(cJute, cPale, owHash12(cell + 3.0) * 0.5 + fibre * 0.15);
  c *= 0.855 + 0.235 * (weave * 0.5 + 0.5);
  c *= 0.90 + 0.18 * macro;
  c = mix(c, cSoil, smoothstep(0.42, 0.85, dirt) * 0.60);

  h = 0.50 + weave * 0.38 + (fibre - 0.5) * 0.05;
  rough = 0.90 + (1.0 - weave) * 0.06;
  metal = 0.0;
  ao = mix(0.74, 1.0, smoothstep(-0.4, 0.9, weave));

  // sun rot: bleached and frayed on the exposed side
  float rot = smoothstep(0.55, 0.9, owFbm01(p * 0.7 + 11.0, P * 0.7, 3, 0.6));
  c = mix(c, cPale * 1.15, rot * 0.4);
  rough += rot * 0.05;

  // loose fibres standing off the surface
  float loose = owScratches(p * 4.0, P * 4.0, 10.0, 2.0, 0.70);
  h += loose * 0.06;
  c = mix(c, cPale, loose * 0.3);

  // spilled sand caught in the weave — linear (0.30, 0.245, 0.165), a warm buff
  // that is still less saturated than the old jute it used to sit on
  float sand = smoothstep(0.5, 0.85, owFbm01(p * 12.0, P * 12.0, 4, 0.5)) * (1.0 - smoothstep(0.2, 0.7, weave));
  c = mix(c, owSRGB(vec3(0.584, 0.532, 0.443)), sand * 0.45);

  alb = clamp(c, vec3(0.02), vec3(0.80));
  rough = clamp(rough, 0.6, 0.99);
  ao = clamp(ao, 0.2, 1.0);
  h = clamp(h, 0.0, 1.0);
}
`;

/**
 * One layer of leaves on a jittered lattice, periodic on `cells`.
 *
 * `cells` leaves across the tile, sampled over the 3x3 neighbourhood so a leaf
 * can overlap into its neighbours'. Returns the UNION coverage in .x (this is
 * what fills the card), the top leaf's depth in .y, the along-leaf position of
 * the shading pixel in .z and its venation in .w, and writes the top leaf's
 * colour through `col`.
 *
 * Leaves are 0.62-0.88 x 0.27-0.40 of a cell in half-axes, i.e. ~0.65 of a cell
 * in area. That is deliberately big enough that neighbours overlap: one layer
 * unions to roughly 1 - exp(-0.65) = 48% coverage and two layers to ~73%, which
 * is what a canopy has to be before it reads as a mass rather than as confetti
 * on a background.
 */
export const FOLIAGE = /* glsl */ `
vec4 owLeafLayer(vec2 uv, float cells, float sd, out vec3 col){
  vec2 lp = uv * cells;
  vec2 ip = floor(lp), fp = fract(lp);
  float cover = 0.0, bestD = -1.0, bestGrad = 0.5, bestVein = 0.0;
  col = vec3(0.0);
  for (int y = -1; y <= 1; y++){
    for (int x = -1; x <= 1; x++){
      vec2 g = vec2(float(x), float(y));
      vec2 cell = mod(ip + g, vec2(cells));
      vec4 r  = owHash42(cell + sd);
      vec4 r2 = owHash42(cell * 1.7 + 9.0 + sd);
      vec2 centre = g + 0.5 + (r.xy - 0.5) * 0.9 - fp;
      vec2 q = owRot(centre, r.z * 6.28318);
      vec2 s = vec2(0.62 + r.w * 0.26, 0.27 + r2.x * 0.13);
      vec2 e = q / s;
      // a leaf is an ellipse tapering to a point at its tip
      float along = clamp(e.x * 0.5 + 0.5, 0.0, 1.0);
      float taper = 1.0 - 0.45 * along;
      float d = length(vec2(e.x, e.y / max(taper, 0.22)));
      // atan(0, 0) is undefined, and the leaf centre can land on a texel centre
      float serr = sin(atan(e.y, e.x + 1e-5) * 22.0) * 0.035;   // toothed margin
      float cv = smoothstep(1.0 + serr, 0.90 + serr, d);
      cover = max(cover, cv);
      if (cv > 0.35 && r2.y > bestD){
        bestD = r2.y;
        bestGrad = along;
        // midrib, plus secondaries running out to the margin
        float rib = 1.0 - smoothstep(0.0, 0.14, abs(e.y));
        float sec = smoothstep(0.70, 1.0, abs(fract(e.x * 3.5 + abs(e.y) * 2.6) * 2.0 - 1.0));
        bestVein = clamp(rib + sec * 0.55, 0.0, 1.0);
        /**
         * Leaf reflectance, not "green paint".
         *
         * MEASURED (top-mip readback of the baked albedo, linear): this tile
         * used to average (0.036, 0.058, 0.020) — luma 0.051. A broadleaf in
         * the visible bands reflects 0.05-0.08 red, 0.12-0.20 green and
         * 0.03-0.05 blue (luma ~0.10-0.13); a dark evergreen bottoms out around
         * 0.08 green. So the canopy was a full stop under the darkest real leaf,
         * and no amount of transmission or sheen can rescue a surface that dark:
         * the "solid black cards" report survived the cutout fix because of THIS,
         * not because of the mask.
         *
         * These three are authored in sRGB and converted, so the linear values
         * they land on are: young (0.055, 0.175, 0.028), mature
         * (0.038, 0.105, 0.020), senescent (0.200, 0.155, 0.045).
         */
        vec3 cYoung = owSRGB(vec3(0.260, 0.455, 0.183));
        vec3 cOld   = owSRGB(vec3(0.215, 0.358, 0.152));
        vec3 cDry   = owSRGB(vec3(0.485, 0.430, 0.235));
        vec3 lc = mix(cYoung, cOld, r2.z);
        // A quarter of the leaves are going over, not two fifths: at 0.62/0.85
        // every third leaf on a palm frond was straw-yellow and the fronds read
        // as dead rather than dusty.
        lc = mix(lc, cDry, smoothstep(0.74, 1.0, r2.w) * 0.70);
        col = lc;
      }
    }
  }
  return vec4(cover, max(bestD, 0.0), bestGrad, bestVein);
}

/**
 * Vegetation, for props built out of QUADS (see kit/props.js: shrub, weedTuft
 * and every palm leaflet are PlaneGeometry) as well as solid ones (produceHeap).
 *
 * The mapping is mesh-uv at scale 1, so this tile covers exactly ONE quad and
 * everything below is authored in quad space. That is what lets a single
 * material serve a 0.85 m bush card and a 0.16 m palm leaflet: the silhouette is
 * a property of the quad, not of a world-space lattice.
 *
 * Two things were wrong before, and they were the same thing twice:
 *  - the leaf lattice covered ~18% of the tile and wrote vec3(0) everywhere
 *    else, so with the cutout disabled (which mesh foliage needs, or the mask
 *    eats the leaflets) every bush in the game rendered as a black card with a
 *    few green ellipses painted on it, in shadow AND in full sun;
 *  - the same void is what a bush mips to at range, so even where the cutout
 *    worked the mid-ground went black-green.
 * So the canopy is now opaque colour end to end, and the cutout cuts the CARD
 * rather than the leaves.
 */
void owSurface(vec2 uv, out vec3 alb, out float h, out float rough, out float metal, out float ao){
  const vec2 P = vec2(8.0);
  vec2 p = uv * P + uSeed * 5.9;

  // Two layers: 5 big leaves across the card behind 7 smaller ones on top. A
  // leaf is 1.24-1.76 cells long, so on the 0.6-0.98 m cards kit/props.js builds
  // a shrub from that is a 150-250 mm leaf; on a 0.16 m palm leaflet the same
  // tile becomes a 25-40 mm mottle, which is the right read for the leaflet's
  // own surface.
  vec3 colU, colT;
  vec4 under = owLeafLayer(uv + vec2(0.13, 0.37), 5.0, uSeed * 2.0 + 17.0, colU);
  vec4 top   = owLeafLayer(uv, 7.0, uSeed * 2.0, colT);

  // ---- the canopy behind the leaves ---------------------------------------
  // Never black: this is the shaded interior of the bush, and it is also the
  // colour the whole prop averages to once the tile has mipped away.
  //
  // It is LEAF, seen deeper in, so it is a leaf colour with the occlusion left
  // to the AO channel below (which runs down to 0.26) rather than painted into
  // the albedo twice. 0.55x the mature leaf, i.e. linear (0.021, 0.058, 0.011),
  // spread over 0.78-1.55 => 0.045-0.090 green. At the old (0.105,0.150,0.072)
  // sRGB this band was linear 0.008-0.016 green — a *quarter* of the darkest
  // real foliage — and it is ~50% of the card by area, so it set the value of
  // every bush in the game and everything the tile mipped down to at range.
  float depth = owFbm01(p * 2.2, P * 2.2, 4, 0.6);
  vec3 cShade = owSRGB(vec3(0.156, 0.267, 0.106));
  vec3 c = mix(cShade * 0.78, cShade * 1.55, depth);
  c = mix(c, colU * 0.74, under.x * 0.88);
  c = mix(c, colT, top.x);

  // A leaf is lighter toward its tip and its veins catch the light.
  c *= mix(1.0, 0.82 + 0.40 * top.z, top.x);
  c = mix(c, c * 1.30, top.w * top.x * 0.55);

  // blotching, mildew and scorch
  float spots = owFbm01(p * 16.0, P * 16.0, 3, 0.5);
  c *= 0.90 + 0.21 * spots;
  c = mix(c, owSRGB(vec3(0.360, 0.300, 0.120)), smoothstep(0.80, 0.97, spots) * 0.42 * top.x);
  // Road dust settles on a roadside bush and is most of why it is not saturated.
  // Weighted to the upper leaf faces (top.z is the along-leaf coordinate) and at
  // 0.30, because in full sun an undusted canopy is the only saturated thing in
  // an ochre frame and reads as set dressing from another game.
  // (0.46,0.44,0.38) sRGB = linear (0.178, 0.162, 0.117): settled mineral dust
  // is 0.18-0.25 reflectance, i.e. LIGHTER than the leaf it sits on. The old
  // (0.34,0.32,0.265) is linear 0.095/0.084/0.056 — darker than the new leaf
  // green, so the dust layer was quietly shading the canopy instead of dulling it.
  float dust = smoothstep(0.50, 0.90, owFbm01(p * 5.0, P * 5.0, 4, 0.55));
  c = mix(c, owSRGB(vec3(0.460, 0.440, 0.380)), dust * (0.20 + 0.16 * top.x));

  // ---- silhouette ---------------------------------------------------------
  // A superellipse with n = 2.15 covers 80% of the quad; the wobble breaks the
  // outline so it never reads as a drawn ellipse, and the leaf union is allowed
  // to poke out past it so the edge is made of leaf tips rather than a curve.
  vec2 qq = (uv - 0.5) * 2.0;
  float th = atan(qq.y, qq.x + 1e-5);
  float wob = sin(th * 5.0 + uSeed * 1.7) * 0.13 + sin(th * 11.0 - uSeed * 3.1) * 0.07;
  float rr = pow(pow(abs(qq.x), 2.15) + pow(abs(qq.y), 2.15), 1.0 / 2.15);
  float body = smoothstep(1.00 + wob, 0.78 + wob, rr);
  float fringe = smoothstep(1.30 + wob, 0.95 + wob, rr);
  float mask = clamp(max(body, max(top.x, under.x * 0.9) * fringe), 0.0, 1.0);
  // Four gaps of ~0.14 of the card you can see through, ~6% of its area. A bush
  // is not a slab, and on a palm leaflet these read as the splits a frond gets.
  vec4 gap = owWorley(p * 0.55 + 4.0, P * 0.55, 1.0);
  mask *= 1.0 - smoothstep(0.30, 0.06, gap.x) * step(0.78, gap.w) * 0.95;

  /**
   * h is BOTH the alpha-test cutout and the height the normal is derived from,
   * so the range is split: inside the silhouette it never drops below 0.55 and
   * carries the leaf relief in the top 0.45, outside it is 0. An alpha test at
   * 0.30 therefore cuts the card's outline and nothing else, while the Sobel
   * still sees 0.45 of range worth of leaf curl, midrib and stacking.
   */
  float lift = 0.30
    + top.x * (0.30 + top.w * 0.20 + top.z * 0.12)
    + under.x * 0.12
    + (top.y - 0.5) * 0.24
    + (spots - 0.5) * 0.10;
  h = mask * (0.55 + clamp(lift, 0.0, 1.0) * 0.45);

  // Waxy cuticle on the leaf faces, matte and dusty in the canopy behind them.
  rough = mix(0.86, 0.48 + 0.14 * (1.0 - top.w), top.x);
  rough += (spots - 0.5) * 0.10 + dust * 0.20;
  metal = 0.0;
  // Canopy depth. Without this a stack of cards is one flat sheet in ambient.
  ao = mix(0.26, 1.0, top.x * (0.55 + 0.45 * top.y) + under.x * 0.22);

  alb = clamp(c, vec3(0.02), vec3(0.62));
  rough = clamp(rough, 0.32, 0.97);
  ao = clamp(ao, 0.22, 1.0);
  h = clamp(h, 0.0, 1.0);
}
`;

export const RUBBER = /* glsl */ `
void owSurface(vec2 uv, out vec3 alb, out float h, out float rough, out float metal, out float ao){
  const vec2 P = vec2(8.0);
  vec2 p = uv * P + uSeed * 9.6;

  // moulded pebble grain
  vec4 pb = owWorley(p * 12.0, P * 12.0, 1.0);
  float pebble = smoothstep(0.42, 0.10, pb.x);
  float fine = owFbm01(p * 12.0, P * 12.0, 3, 0.5);
  float macro = owFbm01(p * 1.5, P * 1.5, 4, 0.6);

  h = 0.60 + pebble * 0.10 + (fine - 0.5) * 0.02 + (macro - 0.5) * 0.03;
  // 0.20 sRGB ~= 0.031 linear. Anything darker lands under the 0.02 albedo
  // floor applied below, which clamps the entire surface flat (a black,
  // detail-free rubber that violates the "no flat surfaces" bar).
  vec3 c = owSRGB(vec3(0.200, 0.200, 0.206));
  c *= 0.85 + 0.25 * (pebble * 0.5 + 0.5);
  c *= 0.94 + 0.10 * fine;

  rough = 0.88 - pebble * 0.06 + (fine - 0.5) * 0.08;
  metal = 0.0;
  ao = mix(0.6, 1.0, pebble * 0.5 + 0.5);

  // mould seam
  float seam = 1.0 - smoothstep(0.0, 0.012, abs(fract(uv.y * 2.0 + 0.5) - 0.5));
  h += seam * 0.03;
  c *= 1.0 + seam * 0.35;
  rough -= seam * 0.10;

  // scuffs: rubber goes chalky-grey where it abrades
  float scuff = smoothstep(0.55, 0.88, owFbm01(owWarp(p * 3.0, P * 3.0, 0.8, 3), P * 3.0, 4, 0.55));
  c = mix(c, owSRGB(vec3(0.220, 0.218, 0.212)), scuff * 0.45);
  rough += scuff * 0.06;
  h -= scuff * 0.015;

  // cracking from ozone / age
  float crack = owCracks(p * 7.0, P * 7.0, 0.9, 0.028, 0.62);
  h -= crack * 0.06;
  c *= 1.0 - crack * 0.35;
  ao -= crack * 0.35;

  // dust
  float dust = smoothstep(0.5, 0.9, owFbm01(p * 8.0, P * 8.0, 4, 0.5));
  c = mix(c, owSRGB(vec3(0.290, 0.275, 0.250)), dust * 0.16);

  alb = clamp(c, vec3(0.02), vec3(0.35));
  rough = clamp(rough, 0.55, 0.99);
  ao = clamp(ao, 0.3, 1.0);
  h = clamp(h, 0.0, 1.0);
}
`;

export const GLASS = /* glsl */ `
void owSurface(vec2 uv, out vec3 alb, out float h, out float rough, out float metal, out float ao){
  const vec2 P = vec2(8.0);
  vec2 p = uv * P + uSeed * 2.2;

  float smear = owFbm01(owShear(p * 3.0, 1.0, 6.0), owShearPer(P * 3.0, 6.0), 4, 0.5);
  float dustF = owFbm01(p * 5.0, P * 5.0, 5, 0.55);
  float spots = owWorley(p * 24.0, P * 24.0, 1.0).x;
  float fine = owFbm01(p * 12.0, P * 12.0, 3, 0.5);

  // glass itself is almost black in albedo; the look comes from reflections
  vec3 c = owSRGB(vec3(0.045, 0.050, 0.052));

  float dirty = smoothstep(0.45, 0.85, dustF);
  c = mix(c, owSRGB(vec3(0.300, 0.290, 0.265)), dirty * 0.35);

  rough = 0.045 + smear * 0.10 * smoothstep(0.3, 0.9, dustF) + dirty * 0.22;
  rough += smoothstep(0.30, 0.05, spots) * 0.25;             // water spots
  rough += (fine - 0.5) * 0.02;

  // fine scratches
  float scr = owScratches(p * 2.0, P * 2.0, 24.0, 1.0, 0.70);
  rough += scr * 0.25;
  c += scr * 0.02;

  h = 0.5 + (smear - 0.5) * 0.004;
  metal = 0.0;
  ao = 1.0 - dirty * 0.1;

  alb = clamp(c, vec3(0.02), vec3(0.5));
  rough = clamp(rough, 0.02, 0.7);
  h = clamp(h, 0.0, 1.0);
}
`;
