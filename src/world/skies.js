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
// rather than remembered: Dustyard 9.0 m over 104 x 84 m (map.js default
// bounds), Harbor 8.5 over 104 x 84, Frostline 8.5 over 100 x 80, Citadel 10.0
// over 100 x 84, Neon Foundry 9.0 over 104 x 76 (`perimeter(bounds, h, ...)`).
//
// A wall of height h with the key at altitude a throws h/tan(a) across the
// floor. That is the constraint the previous pass solved, and it solved it —
// but it solved the WRONG one. The perimeter is 8.5-10 m and there are four of
// them; the cover is 2 m and there are two hundred of it. What actually decides
// whether a fight space is lit is the throw of a 2 m crate:
//
//   altitude   2 m cover throws   9 m wall throws
//     21 deg        5.21 m            23.5 m
//     24 deg        4.49 m            20.2 m      <- what this file shipped
//     33 deg        3.08 m            13.9 m
//     36 deg        2.75 m            12.4 m
//     38 deg        2.56 m            11.5 m
//
// At 24 degrees every 2 m box shades four and a half metres down-sun of itself,
// and these maps are BUILT from 2 m boxes at 3-6 m spacing, so the floor between
// them never sees the key. Measured on Dustyard at the shipped 23.94 deg, over
// the whole playable floor from a top-down GPU difference: 33.9 per cent of it
// in direct sun, but only 6.9 per cent of the MID-LANE FRAME at eye height, 2.6
// per cent of the facade frame and 1.3 per cent at A site. The sun was landing
// on roofs. Three independent reviews of five maps each blamed this one number.
//
// So both levers are now used, and the second one matters as much as the first:
//
//   ELEVATION gets the key past the cover. 33-38 degrees halves the cover throw
//   and, because a ground normal takes the beam at sin(altitude), multiplies
//   what the key delivers to the floor by sin(38)/sin(24) = 1.51. That is the
//   whole of the "fill out-guns key on every horizontal surface" complaint: a
//   vertical wall was always fine (it takes cos(altitude)), the floor was not.
//
//   AZIMUTH rakes the light ALONG the streets instead of across them. Dustyard
//   and Harbor run their lanes down Z; Citadel and Neon run theirs down X. A key
//   that crosses a lane is blocked by the buildings on one side of it for the
//   lane's whole length; a key that runs down it lights the length and only
//   shadows the cross-streets. MEASURED on Dustyard at a fixed 38 deg, moving
//   the key from 283.6 to 249.0 took the T-lane frame from 55.3% sunlit to
//   88.4% and A site from 45.4% to 71.4%, at a cost of 0.2 on the wall key:fill.
//
// Computed from the presets below by the same celestial.js the renderer runs:
//
//                      was            now            2 m cover   wall throw
//   Dustyard    23.94 / 283.6   38.00 / 249.0          2.56 m      11.5 m
//   Harbor      23.96 /  31.1   35.00 /  50.0          2.86 m      12.1 m
//   Frostline   20.91 / 338.6   33.00 / 338.6          3.08 m      13.1 m
//   Citadel     24.00 / 233.0   36.00 / 233.0          2.75 m      13.8 m
//   Neon (moon) 31.00 / 268.9   31.00 / 268.9  (unchanged, see below)
//
// (0 = north = -Z, 90 = east = +X.) Citadel and Frostline keep their world
// azimuth because the sweep said so, not because it was safer: Citadel's 233 is
// already 8 degrees off the SW diagonal and the best raking angle in the game,
// and swinging Frostline from 338.6 to 318 turned its mid-lane walls edge-on and
// cost 0.38 of wall key:fill for nothing the floor could use.
//
// NEON IS DELIBERATELY NOT TOUCHED, and this is the measurement that decided it.
// It is the only map keyed by a moon, and `syncExposure` meters off the key, so
// raising the moon does not add light — it moves light from the shade into the
// highlights and then stops the lens down. Moon 31 -> 38 deg: ground key:fill
// 2.64 -> 3.23 and the mid-lane frame 20.4% -> 28.4% sunlit, but exposure fell
// 3.673 -> 2.952 and the fraction of the core facade's shade side crushed under
// code value 2 went 35.96% -> 52.65%. That facade is already a standing
// complaint. The foundry's ground is at 2.64 and 60.4% sunlit as it stands,
// which is the best floor coverage of the five maps; its problem is the crush,
// and the sun angle is not the lever for it.
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
// KEY:FILL is quoted the way the reviews quote it — on the pixels the key
// actually reaches, the ratio of scene-linear luminance with the key to the same
// pixel with the key at zero, i.e. (key + fill) / fill. 1.0 is no key at all.
// The image is un-tone-mapped through the inverse of the shipped ACES fit at the
// live exposure before the ratio is taken, so it is a light ratio and not a code
// ratio, and it does not move when auto-exposure does.
//
// GROUND is the top-down pass with the camera's NEAR PLANE PARKED AT 3.2 m, so
// every roof and wall top is clipped out of the raster and what is measured is
// the play space — floor, low cover, crate tops — and nothing a player cannot
// stand on. The shadow map is fitted to the arena AABB, not to that camera, so
// roofs still cast into it and a covered floor still reads as shade. Fog is off
// for the top-down only: it is a 140 m camera and every preset's far plane is
// 165-240 m, so the aerial term would otherwise be a third of every ground pixel
// and would wash the key delta out of the image (it did, on the first run:
// ground key:fill read 1.32 with fog on and 2.72 with it off, on the same frame).
//
// WALL is |normal.y| < 0.35, classified by a MeshNormalMaterial override pass at
// the same camera and resolution, so it is vertical geometry and not a band of
// the frame.
//
// Read back off the framebuffer through the shipped post chain, exposure settled
// (Frostline's meter takes ~15 s of sim to come off the previous map's value —
// read it early and it reports 1.443 instead of its own 0.668, which inflates
// every ratio on the map because the snow is then sitting in the ACES shoulder
// and the inverse fit is ill-conditioned there):
//
//                     floor in sun      ground key:fill    wall key:fill
//   dustyard          33.9 -> 45.6 %     2.73 -> 3.65      3.75 -> 3.16
//   harbor            39.8 -> 52.3 %     1.99 -> 2.56      4.75 -> 3.30
//   frostline         33.6 -> 48.5 %     1.99 -> 2.53      2.93 -> 2.55
//   citadel           40.2 -> 57.2 %     2.48 -> 3.28      3.15 -> 2.98
//   neon (moon)          60.4 %             2.63              1.58
//
// Harbor's wall figure looks like a regression and is not: 4.75 was measured on a
// frame with 1.1 % of it in sun, so it is the ratio on a handful of grazing
// pixels. The same camera after is 34.3 % sunlit at 3.30.
//
// Frostline's IS a regression and is the one real trade in this pass. A ground
// normal takes the beam at sin(alt) and a wall at cos(alt), so on the one map
// where the sun cannot get high enough to win both, they pull opposite ways:
// 20.9 -> 33 degrees bought the floor 0.54 of key:fill and cost the walls 0.38.
// It was taken deliberately — the review's complaint on this map was the ground
// ("the sun only carries a third of the light on the ground"), the snow is 8,700
// square metres of the frame, and a cast shadow on it went from 1.42:1 to 1.74:1
// in code values (sunlit 165 -> 182, shaded 116 -> 104 of 255).
//
// And what it does to an eye-level frame, per cent of the frame the key reaches:
//
//                     main lane      second camera
//   dustyard           6.9 -> 16.8    A site   1.3 -> 71.4     (critic's numbers)
//   harbor             1.1 -> 34.3    pier    15.6 -> 49.6
//   frostline         34.3 -> 62.2    A site  36.1 -> 41.4
//   citadel           22.9 -> 32.5    A site  47.7 -> 52.0
//
// WHAT IT COSTS. A higher sun is a whiter sun: Dustyard's beam goes from
// (1.000, 0.804, 0.570) to (1.000, 0.858, 0.675), so blue-over-red climbs from
// 0.57 to 0.68 and the map loses about a third of its golden-hour cast. That was
// checked against the obvious buy-back and turbidity does not do it — sweeping
// Dustyard 2.1 / 2.6 / 3.2 / 3.8 moved the beam colour by 0.000 in every channel
// and only took 2 % off its intensity. The warmth that is left is real warmth at
// a real altitude, and 38 degrees still throws a 1.8 m player 2.3 m of shadow,
// which is what the raking look was actually made of.
//
// The previous pass concluded from a 40.8 % top-down figure that Dustyard's floor
// was fine. It was measuring the whole map including the verges nobody fights on,
// and it never put the camera at eye height in a lane. Both figures are kept
// above for exactly that reason: the top-down is the coverage, the frame is the
// experience, and on this map they disagreed by a factor of five.
// ============================================================================

export const SKY_PRESETS = {
  // Dustyard — mid-afternoon over a Moroccan freight district. 15.223 local at
  // lat 31 on day 250 (early September) computes to altitude 38.00, azimuth
  // 249.0: 38 degrees up in the west-south-west.
  //
  // The hour comes off the elevation and the northAngle off the azimuth, both
  // solved rather than dialled — cos(H) = (sin(alt) - sin(lat)sin(decl)) /
  // (cos(lat)cos(decl)) gives the hour angle, and northAngleDeg is then just the
  // difference between the azimuth that falls out of it and the one wanted.
  //
  // 249 rather than the old 283.6 because mid, the T lane and both site
  // approaches all run down Z on this map, and a key from due west crosses every
  // one of them. Swinging it 34.6 degrees south puts the beam down the lanes:
  // measured at a fixed 38 degrees, the T-lane frame goes 55.3 -> 88.4 % sunlit
  // and A site 45.4 -> 71.4 %, against 0.2 lost on wall key:fill (3.39 -> 3.17)
  // and 2 points on the top-down floor (47.6 -> 45.6 %) because the south wall
  // now casts as well as the west one. The frames are where the players are.
  desert: {
    hour: 15.2229,
    site: { latitudeDeg: 31, dayOfYear: 250, northAngleDeg: -1.721 },
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

  // Harbor — storm coast, mid-morning, broken cover and sea haze. 9.304 local
  // at lat 54 on day 105 (mid-April) computes to altitude 35.00, azimuth 50.0.
  //
  // The hour is what the map is about, so the season moved to buy the altitude:
  // at lat 54 on day 69 the sun's NOON maximum is 31.2 degrees, so 35 was not
  // reachable at any hour of that date. Day 105 raises the ceiling to 45.6 and
  // 9.3 in the morning lands on 35 with the sun still in the east, which is the
  // only thing the shot actually needs from the clock.
  //
  // This map had the worst floor in the game: ground key:fill 1.99, and the mid
  // lane looking south measured 1.1 % of frame in sun — the apron carried no
  // light direction at all. Two changes, because elevation alone could not do it:
  //
  //   * 24 -> 35 degrees. Ground key:fill 1.99 -> 2.41 on its own. It cannot go
  //     much further: a vertical face takes the beam at cos(altitude), so past
  //     about 36 the wall ratio drops under 3:1 (measured 2.41 at 39 degrees)
  //     and the trade stops paying.
  //   * cloudCoverage 0.62 -> 0.36. `_applyLightIntensities` scales the key by
  //     0.58 + 0.42 * cloudOcclusion, so 0.62 of cover was holding the key at
  //     2.60 against a 3.64 clear value — 0.48 stops, which on a map whose fill
  //     was already out-gunning its key was most of the problem. It is the one
  //     lever here that adds key WITHOUT the meter taking it back: syncExposure
  //     reads `_baseSunIntensity`, which is measured before the cloud term, so
  //     exposure held at 1.443 across the change and the extra light stayed on
  //     the ground (sunlit ground 115 -> 130, shaded 53 -> 54). Broken cover
  //     with the sun coming through it is still a storm coast; 0.62 was overcast.
  //
  // Result: ground key:fill 1.99 -> 2.60, wall 3.28, floor in sun 39.8 -> 52.3 %,
  // mid lane 1.1 -> 34.3 % of frame, pier 15.6 -> 49.6 %, and the shade side of
  // the mid-lane walls got BRIGHTER (44.4 -> 50.5 of 255), not darker.
  coastal: {
    hour: 9.3036,
    site: { latitudeDeg: 54, dayOfYear: 105, northAngleDeg: -78.62 },
    weather: {
      turbidity: 2.8,
      cloudCoverage: 0.36,
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

  // Frostline — arctic, late spring. 14.462 local at lat 66 on day 120 (end of
  // April) computes to altitude 33.00, azimuth 338.6.
  //
  // This was the flattest map in the game and the reason was arithmetic, not
  // taste. At lat 68 on the equinox the sun's noon maximum is 21.19 degrees, so
  // the previous 20.91 was already the ceiling of that site — there was nowhere
  // for it to go. A ground normal takes the beam at sin(altitude), which at 21
  // degrees is 0.358, and against a 0.75 snow albedo the indirect terms simply
  // out-gunned it: ground key:fill 1.91, sunlit snow 208 against shaded 172 out
  // of 255. A cast shadow was 1.2:1. That is why nothing on this map had form.
  //
  // Moving the site to the Arctic Circle proper and the date to the end of April
  // raises the ceiling to 38.6 and 33 is comfortably inside it: ground key:fill
  // 1.99 -> 2.53, floor in sun 33.6 -> 48.5 %, mid lane 34.3 -> 62.2 % of frame,
  // sunlit snow 165 -> 182 against shaded 116 -> 104. Still snow at 66 N at the
  // end of April.
  //
  // The azimuth is unchanged, and that was tested rather than assumed: swinging
  // it to 318 turned the mid-lane walls edge-on to the key and cost 0.38 of wall
  // key:fill for 0.7 of a point of floor coverage. 338.6 stays.
  //
  // 33 degrees is where this one stops, and it is already past the crossover:
  // wall key:fill goes 2.93 -> 2.55 across this change, because a wall takes the
  // beam at cos(alt) and this is the one site where the sun cannot get high
  // enough to win both surfaces. The floor was the complaint and the floor is
  // 8,700 square metres of the frame, so the floor won. Going further does not
  // help either — the snow's sunlit median is 182 of 255 with the ACES shoulder
  // above it, so past here a brighter key buys highlight and no shape.
  arctic: {
    hour: 14.462,
    site: { latitudeDeg: 66, dayOfYear: 120, northAngleDeg: 114.704 },
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
  //
  // The sun-angle pass that raised the other four LEFT THIS ONE ALONE, measured.
  // 268.9 already runs straight down mid, which is the axis this map fights on,
  // and the elevation is the wrong lever on a night map: syncExposure meters off
  // the key, so raising the moon redistributes light instead of adding it. Moon
  // 31 -> 38 degrees measured ground key:fill 2.64 -> 3.23 and the mid lane
  // 20.4 -> 28.4 % of frame, but exposure fell 3.673 -> 2.952 and the shade side
  // of the core facade went from 35.96 % to 52.65 % of its pixels crushed under
  // code value 2. Its floor is already 60.4 % in direct key — the best coverage
  // of the five — at 2.64 ground key:fill. What is wrong with this map is the
  // crush, and the moon is not the lever for it.
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

  // Citadel — afternoon on a mountain fortress. 15.890 local at lat 39 on day
  // 210 computes to altitude 36.00, azimuth 233.0 (south-west). Thin air, so the
  // sky is deep and the shadows are hard.
  //
  // The azimuth does not move, and it is the only one of the five that was right
  // to begin with: 233 is 8 degrees off the south-west diagonal, so every mass in
  // the fort gets a bright face, a mid face and a shade side instead of one lit
  // wall and two flat ones. Sweeping it to 250 bought 3 points of top-down floor
  // and cost A site 12 points of frame, so it stays.
  //
  // The elevation does move, and this is the tallest perimeter in the game at
  // 10 m: at 24 degrees it threw 22.5 m into an 84 m depth and put the whole T
  // approach in wall shadow while the CT side was lit, which is not a fair
  // opening frame. At 36 it throws 13.8 m. Ground key:fill 2.48 -> 3.27, floor in
  // sun 40.2 -> 56.7 %, mid lane 22.9 -> 32.7 % of frame, wall key:fill 3.01.
  //
  // 36 and not more: 41 degrees reads 3.54 on the ground but takes the wall to
  // 2.88, and on a map made of ashlar the walls are the subject.
  citadel: {
    hour: 15.8896,
    site: { latitudeDeg: 39, dayOfYear: 210, northAngleDeg: -32.447 },
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
