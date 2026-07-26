// ============================================================================
// TINY STRIKE — per-map atmosphere presets.
//
// The sky is a physical model (src/gfx/sky): you do not pick a sun colour, you
// pick a place, a date and a time, and the atmosphere produces the light. Each
// preset below is chosen so the map keeps the mood its theme block described —
// Dustyard's low warm key, Frostline's flat arctic light, Neon Foundry at
// night — while the actual sun position, sky radiance, IBL and fog all come out
// of the same scattering solution.
//
//   hour          local solar time, 0..24
//   latitudeDeg   drives how high the sun can get and how fast it sets
//   dayOfYear     172 = summer solstice, 355 = midwinter
//   northAngleDeg rotates the whole sky so the key light lands where the map
//                 was lit from originally (world north is -Z)
//   turbidity     aerosol load: 1 clear, 2-3 hazy, 5 dust storm
//   groundAlbedo  first-bounce colour under the horizon — this is what tints
//                 the lower half of the IBL, so it matters as much as the sky.
//                 IT ALSO SETS THE FILM SPEED: see the exposure table below.
//   horizon       what is beyond the perimeter wall: [skyline height in
//                 sin(elevation), skyline detail in cycles per turn of azimuth,
//                 albedo variation across the plain, haze scale in metres].
//                 See skSkyline / skGround in gfx/sky/dome.js.
//   fog           three.Fog range, plus how far its colour is pulled off the
//                 sky's own ambient toward a map-specific tint
//
// ---------------------------------------------------------------------------
// THE ONE CONSTRAINT EVERY SUN ANGLE HERE IS SOLVED AGAINST
// ---------------------------------------------------------------------------
// Every arena is a walled box. The perimeters, read off the map definitions
// rather than remembered: Dustyard 9.0 m over 100 x 80 m (map.js), Harbor 8.5
// over 104 x 84, Frostline 8.5 over 100 x 80, Citadel 10.0 over 100 x 84, Neon
// Foundry 9.0 over 104 x 76 (src/world/maps/*.js `perimeter(bounds, h, ...)`).
//
// A wall of height h with the key at altitude a throws h/tan(a) across the
// floor — the worst case, when the light runs square at the wall — so the sun
// angle is not a mood choice, it is a coverage choice, and the presets this
// file shipped with had never been checked against it.
//
// Every figure in the `now` columns is COMPUTED from the preset immediately
// below by the same celestial.js the renderer runs, not estimated:
//
//                          was             threw      now             throws
//   Dustyard   wall  9.0 m  38.3 deg        11.4 m     23.94 deg       20.3 m
//   Harbor     wall  8.5 m  14.5 deg        32.8 m     23.96 deg       19.1 m
//   Frostline  wall  8.5 m   6.5 deg        74.5 m     20.91 deg       22.2 m
//   Citadel    wall 10.0 m  33.6 deg        15.1 m     24.00 deg       22.5 m
//   Neon (moon) wall 9.0 m  76.4 deg         2.2 m     31.00 deg       15.0 m
//
// Frostline was the broken one: at 6.5 degrees its own south wall shadowed 74 m
// of an 80 m map, so the entire playable floor sat in permanent shade and the
// only thing lighting it was bounce off the snow. Dustyard was the opposite —
// its comment claimed a 20-degree sun and it was actually at 38, which is why
// nothing in that map had a shadow long enough to read as late afternoon.
//
// Everything now throws between 15 and 23 m: 18 to 28 per cent of each map's
// short axis as a deep raking band along the upwind edge, which is shape, and
// daylight on the rest of the floor, which is playable. Neon is the shortest
// throw because it is the only map keyed by a moon, and a 31-degree moon is
// still six times the 2.2 m the old 76-degree one gave.
//
// The WORLD azimuth of every key light is unchanged to the degree —
// northAngleDeg was re-solved after each hour change — so every face the map
// was authored to be lit from is still the face that is lit. Computed: Dustyard
// 283.6, Harbor 31.1, Frostline 338.6, Citadel 233.0, Neon's moon 268.9
// (0 = north = -Z, 90 = east = +X).
//
// ---------------------------------------------------------------------------
// groundAlbedo IS ALSO THE GREY CARD — CHANGE IT AND THE MAP CHANGES EXPOSURE
// ---------------------------------------------------------------------------
// `syncExposure` meters off the key light, which is right for a day/night cycle
// and blind to what the light is falling on. Across these five presets the
// ground spans 0.053 to 0.751 in luminance — 3.8 stops — and metered to the same
// key that put Frostline's snow over the ACES knee and the foundry's asphalt on
// the floor. `sky/index.js` METER_GROUND_ALBEDO therefore pays back half the
// difference from Dustyard's own 0.350 as exposure compensation (a quarter of it
// after dark, where the practicals are most of the frame and do not scale with
// the ground). MEASURED before -> after, Rec.709 luminance out of 255 read back
// off the framebuffer over three 32 m ground top-downs per map:
//
//   preset      albedo lum   EV     exposure        sunlit ground   median
//   desert         0.350    0.00   0.953 -> 0.953    106-125 -> 107-126   46-91 -> 46-88
//   citadel        0.288   -0.14   0.941 -> 1.038     80-99  -> 86-109    50-66 -> 57-73
//   coastal        0.132   -0.71   0.965 -> 1.575     57-74  -> 84-106    55-64 -> 81-93
//   arctic         0.751   +0.55   0.978 -> 0.668     71-194 -> 51-171    68-153 -> 50-125
//   neon (night)   0.053   -0.68   2.000 -> 3.673     18-31  -> 34-55     18-24 -> 33-42
//
// Neon was ALSO on the exposure ceiling: it metered 2.292 against a cap of 2.0,
// so a fifth of a stop of its darkness was a silent clamp. Both are fixed, and
// the fraction of its ground under code value 25 went from 52-76% to 20-33% with
// its ground key:fill unchanged at 0.9-2.3 stops — darker, but with structure in
// it instead of black.
//
// So: a groundAlbedo edit is no longer only a colour decision. Nudging arctic's
// snow from 0.75 to 0.60 would open the map up by 0.16 EV as a side effect.
//
// ---------------------------------------------------------------------------
// RE-BASELINE: WHAT THESE FIVE PRESETS ACTUALLY PUT ON THE FLOOR
// ---------------------------------------------------------------------------
// Every number above was measured before `tools/MEASURING.md` was written, i.e.
// possibly against a dead indirect rig (no bounce fill, no interior floor, IBL
// at 2.4x budget — see that file). So all five were measured again from scratch,
// correctly: 150 `world.update` steps first, `world._bounce.intensity > 0` and
// `scene.environmentIntensity < 1` asserted, sim frozen, then read back off the
// framebuffer through the shipped post chain.
//
// The instrument for "is this floor in sun or in shade" is a difference, not a
// raycast: render the top-down twice, once normally and once with the key light's
// intensity at 0, and a pixel is sunlit if the key adds more than 5 code values
// to it. The split is clean, not a judgement call — the 5th and 25th percentiles
// of that difference are 0.0 and the 50th is 41. Surfaces are classified by a
// second pass with `scene.overrideMaterial` writing world height and normal.y,
// so "the floor" is up-facing geometry below 0.8 m rather than "the bottom of
// the frame". Fog is off for the top-down only (it is an 80 m camera and Neon's
// fog would otherwise contribute 29-42 % of the ground's value); the eye-level
// rows are the shipped image, fog and all.
//
// Rec.709 luminance out of 255, whole arena from above, 1 m inside the wall:
//
//   map        key alt/az     floor in sun   sunlit   shaded   ratio   frame
//   dustyard   23.94 / 283.6      40.8 %     126.6     57.5    2.20     80.8
//   citadel    24.00 / 233.0      37.9 %      86.2     40.6    2.12     70.4
//   harbor     23.96 /  31.1      46.0 %     103.7     63.7    1.63     67.2
//   frostline  20.91 / 338.6      39.7 %     167.3    119.0    1.41    116.4
//   neon(moon) 31.00 / 268.9      68.3 %      33.2     15.2    2.18     33.2
//
// and on a WALL, at eye height, sunlit vs shaded median over three cameras per
// map (the class is |normal.y| < 0.35, so it is vertical surface, not a frame
// band): dustyard 1.6-3.6x, citadel 2.2-3.5x, harbor 2.2-2.8x, frostline
// 1.5-2.1x, neon 1.7-11.4x.
//
// THE ANSWER TO THE QUESTION THAT PROMPTED THIS: no, Dustyard's play space is
// not sitting in its own wall shadow. 40.8 % of its floor is in direct sun, at
// 1.14 stops over the shaded floor, and the 20.3 m the 9 m west wall throws is
// 20 % of the map's 100 m width — a raking band along the upwind edge, which is
// the intent. It reads as wall shadow from ONE spot: standing at the south end
// of mid looking north, 0 % of the visible floor is sunlit and 20 % of the
// visible wall is, because you are looking up-sun. Turn around at the same
// spot — camera (0,1.7,-30) looking north — and 69 % of the floor in frame is
// sunlit. That is what a low key does and it is not a bug, so NOTHING in this
// file changed: every preset here is confirmed, not re-tuned.
//
// The one number worth watching is Frostline's 1.41 (half a stop). It is the
// flattest floor in the game and it is physically correct for a 0.75 snow albedo
// under a 21-degree sun — the fill IS most of the light — but it is also the map
// with the least room before the ACES shoulder (sunlit median 167 of 255), so a
// brighter key there buys contrast nowhere.
// ============================================================================

export const SKY_PRESETS = {
  // Dustyard — late afternoon over a Moroccan freight district. 16.35 local at
  // lat 31 on day 250 (early September) computes to altitude 23.94, azimuth
  // 283.6 — 24 degrees up in the west-north-west — which is what throws the
  // 20.3 m of shadow across mid and lights the A-site face. The old 15.2 was
  // 38.3 degrees up: the same azimuth, and 11.4 m, which is half the shadow.
  desert: {
    hour: 16.35,
    site: { latitudeDeg: 31, dayOfYear: 250, northAngleDeg: 22 },
    weather: {
      turbidity: 2.1,
      cloudCoverage: 0.16,
      cloudDensity: 1.7,
      cirrusCoverage: 0.24,
      cirrusOpacity: 0.26,
      horizonMurk: 0.30,
      windAngle: 0.4,
      // Low desert hills at 2.4 degrees, broad and few, over a plain with a lot
      // of albedo variation — dune shadow and gravel pan. Dust keeps the haze
      // scale down to 14 km even on a clear afternoon.
      horizon: [0.042, 3.0, 0.42, 14000],
    },
    // Sand and lime plaster: a bright, warm bounce. This is the only fill a
    // shaded alley gets once the sun is off it.
    groundAlbedo: [0.40, 0.345, 0.255],
    fog: { near: 75, far: 235, gain: 1.35, tint: 0xd9b48a, tintAmount: 0.35 },
  },

  // Harbor — storm coast, mid-morning, heavy broken cover and sea haze. The
  // hour is what the map is about, so the season moved instead: at lat 54 in
  // late autumn the sun could not reach 24 degrees at ANY hour (its noon
  // maximum was 22.2), and at 9.4 it was 14.5 degrees up with the sea wall
  // shadowing 33 m of the map. Early March, same hour, same world azimuth of
  // 31, and the sun clears the wall properly.
  coastal: {
    hour: 9.6,
    site: { latitudeDeg: 54, dayOfYear: 69, northAngleDeg: -109 },
    weather: {
      turbidity: 2.8,
      cloudCoverage: 0.62,
      cloudDensity: 2.2,
      cirrusCoverage: 0.30,
      cirrusOpacity: 0.34,
      horizonMurk: 0.42,
      windSpeed: 0.0075,
      windAngle: 1.9,
      // Sea. A 0.4-degree skyline is a headland, not a range, and the plain
      // barely varies because water does not. 5 km of haze is a wet onshore
      // wind and it is what makes the far water dissolve rather than end.
      horizon: [0.007, 2.0, 0.10, 5000],
    },
    // Wet concrete and seawater: dark, slightly green bounce.
    groundAlbedo: [0.115, 0.135, 0.145],
    fog: { near: 55, far: 195, gain: 1.7, tint: 0x9bb7be, tintAmount: 0.5 },
  },

  // Frostline — arctic, and the sun still never gets far up: at lat 68 on the
  // spring equinox its noon maximum is 21.19 degrees, and 12.6 local — 36
  // minutes off the meridian — computes to 20.91, so the key rakes all day
  // exactly as the map wants and there is nowhere on this site it could go
  // higher. What changed is that it now reaches the floor: 22.2 m of throw off
  // an 8.5 m wall, against the 74.5 m it threw at 6.5 degrees, on a map that is
  // only 80 m deep. The beam at 21 degrees is (1.00, 0.78, 0.53) — warm,
  // physically, and that is the point: against a 0.75 snow albedo the fill is
  // blue-white and the key is amber, which is the largest key/fill colour
  // separation in the game and what polar light actually looks like.
  arctic: {
    hour: 12.6,
    site: { latitudeDeg: 68, dayOfYear: 79, northAngleDeg: 149 },
    weather: {
      turbidity: 1.25,
      cloudCoverage: 0.34,
      cloudDensity: 1.6,
      cirrusCoverage: 0.36,
      cirrusOpacity: 0.28,
      horizonMurk: 0.10,
      windSpeed: 0.0060,
      windAngle: 2.6,
      // A mountain range at 3.4 degrees, jagged, over near-uniform snow. Cold
      // dry air is the clearest there is: 34 km, so the peaks keep their own
      // tone instead of dissolving.
      horizon: [0.060, 5.5, 0.14, 34000],
    },
    // Snow: the brightest ground albedo there is, and the reason arctic shadows
    // are blue-white rather than black.
    groundAlbedo: [0.72, 0.755, 0.80],
    fog: { near: 65, far: 210, gain: 1.6, tint: 0xcfe4ec, tintAmount: 0.55 },
  },

  // Neon Foundry — after hours. Genuinely night: the sun computes to -33.5, and
  // the moon at altitude 31.00 / azimuth 268.9 is the only natural key. It used
  // to be 76.4 degrees up, which is very nearly straight down: 2.2 m of throw
  // off a 9 m wall, no shadow longer than its caster is tall, no rim on
  // anything, and a 2 m crate lit like a studio product shot. Due west at 31
  // degrees rakes 15.0 m across the yard instead, and the phase drops to 0.536
  // so the terminator reads and the disc is a sphere rather than a white dot.
  neon: {
    hour: 21.9,
    site: {
      latitudeDeg: 41,
      dayOfYear: 100,
      northAngleDeg: 20,
      moonHourOffsetDeg: 265,
      moonDeclinationDeg: 6,
    },
    weather: {
      turbidity: 2.6,
      cloudCoverage: 0.30,
      cloudDensity: 2.0,
      cirrusCoverage: 0.20,
      cirrusOpacity: 0.24,
      horizonMurk: 0.34,
      windAngle: 1.1,
      // A works skyline: low, busy, and close enough that the sodium haze in
      // front of it never quite clears — 8 km.
      horizon: [0.024, 9.0, 0.28, 8000],
    },
    // Oiled asphalt and slag: almost no bounce, which is what lets the neon
    // read as the brightest thing in the frame.
    groundAlbedo: [0.055, 0.052, 0.058],
    fog: { near: 45, far: 165, gain: 2.6, tint: 0x1b2636, tintAmount: 0.6 },
  },

  // Citadel — golden hour on a mountain fortress. 16.92 local at lat 39 on day
  // 210 computes to altitude 24.00, azimuth 233.0 (south-west). Thin air, so
  // the sky is deep and the shadows are hard. This is the tallest perimeter in
  // the game at 10 m, and 24 degrees is the lowest the sun can go and still put
  // light on the courtyard floor: it throws 22.5 m into an 84 m depth, and one
  // more degree down costs another metre of it. The warmth therefore comes from
  // the air rather than from a lower sun, which is what turbidity 1.5 at 24
  // degrees gives: (1.00, 0.81, 0.60).
  citadel: {
    hour: 16.92,
    site: { latitudeDeg: 39, dayOfYear: 210, northAngleDeg: -42.2 },
    weather: {
      turbidity: 1.5,
      cloudCoverage: 0.22,
      cloudDensity: 1.9,
      cirrusCoverage: 0.28,
      cirrusOpacity: 0.30,
      horizonMurk: 0.20,
      windAngle: 0.9,
      // The range the fortress is built on: 5 degrees of skyline, and 28 km of
      // visibility because there is a third less air up here.
      horizon: [0.087, 4.0, 0.22, 28000],
    },
    groundAlbedo: [0.32, 0.285, 0.225],
    fog: { near: 80, far: 240, gain: 1.3, tint: 0xc2a783, tintAmount: 0.35 },
  },
};

export function skyPresetFor(theme) {
  return SKY_PRESETS[theme.key] ?? SKY_PRESETS.desert;
}
