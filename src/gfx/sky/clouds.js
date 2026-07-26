/**
 * Two procedural cloud decks on the sky shell.
 *
 *   cumulus  1.5 km   coverage-eroded fbm with a fake vertical extent produced
 *                     by parallax-shifting the sample along the view ray, so the
 *                     deck has billows and a silhouette instead of reading as a
 *                     printed pattern. Self-shadowed with three taps toward the
 *                     sun, powder-darkened bases, silver rims from a forward
 *                     Henyey-Greenstein lobe.
 *   cirrus   7.8 km   two decorrelated families of ridged fbm, each stretched
 *                     3.5:1 (not 9:1) about its own bearing, each bearing 75
 *                     degrees from the other and wandering +-0.55 rad under a
 *                     field that turns every four to six kilometres, each cut
 *                     into 1.5 km fallstreaks by an along-fibre amplitude
 *                     modulation, each gated by its own kilometre-scale patch
 *                     mask so the layer arrives in fronts with clean blue between
 *                     them. Optically thin, almost all forward scatter — the
 *                     layer that turns a sunset pink. Read skCirrusBand below
 *                     before changing any of those numbers: every one of them is
 *                     load bearing against the starburst.
 *
 * Both are intersected against the planet shell rather than a flat plane, and
 * both fade out with the *distance* to that intersection. That fade is not
 * decoration. A deck seen at a grazing angle is fifty kilometres away, and if
 * you do not bleed it into the aerial haze it collapses into a hard grey wall
 * pasted along the horizon, or — for cirrus, whose streaks are parallel in
 * world space — into a starburst converging on a vanishing point. Both are
 * immediate tells.
 *
 * The low-frequency coverage field skCloudMacro is four analytic waves rather
 * than noise, for one specific reason: it has to be evaluated identically on
 * the CPU (see cloudMacro below) so the sun's cloud-occlusion factor — the
 * slow dimming as a cloud crosses the sun — matches the cloud the shader is
 * actually drawing. Correlated, not faked.
 *
 * Radiance convention: sunLow/sunHigh arrive as *irradiance* in scene light
 * units, so every direct term is divided by pi to become framebuffer radiance.
 * See the long note at the end of skRaymarchSky in atmosphere.js.
 */
export const CLOUDS_GLSL = /* glsl */ `
#ifndef SKY_CLOUDS
#define SKY_CLOUDS

// x coverage, y density, z detail gain, w time (seconds)
uniform vec4 uCloudParams;
// x cirrus coverage, y cirrus opacity, z wind x (km/s), w wind z (km/s)
uniform vec4 uCloudParams2;

const float SK_CUMULUS_KM = 1.5;
const float SK_CIRRUS_KM = 7.8;

/**
 * Multiple-scattering floor inside the cumulus deck, as a fraction of the
 * unoccluded beam.
 *
 * skCumulusLight returns a pure Beer-Lambert transmittance, and a cloud is the
 * one medium in this sky where that is badly wrong: the single-scattering
 * albedo of a water droplet at visible wavelengths is 0.9999, so almost nothing
 * is absorbed. Light that leaves the beam is still IN the cloud, bouncing, and
 * it is what lights the shaded half of a billow. Pure extinction has no term
 * for it, so at density 2.0 the three taps below run the self-shadowed side
 * down to exp(-8.8) = 0.00015 and the deck becomes two values with nothing in
 * between them.
 *
 * MEASURED on Neon Foundry before this floor existed (equirect readback, linear
 * radiance, 512x256): the cumulus deck spanned 4.93 stops from its 5th to its
 * 99th percentile and its brightest pixels sat 17.0:1 over the night sky behind
 * them. At night ACES has no shoulder to compress that with — the whole frame
 * sits in the toe, where the curve is very nearly linear — so 17:1 of radiance
 * arrived on screen as code 23 against code 156. THAT is the hard black/white
 * marbling in the night frames. The identical shader measured 2.80 stops on
 * Dustyard, because there the shoulder was doing the work.
 *
 * 0.13 caps the in-cloud top-to-base ratio at 7.7:1 (2.9 stops), which is where
 * photometry of real cumulus lands: a base runs a sixth to a tenth of its own
 * sunlit top, never the six-plus stops extinction alone predicts.
 */
const float SK_CLOUD_MS = 0.13;

/**
 * Optical depth over which the forward-scattering lobe survives, e-folding.
 *
 * A silver lining is few-scattered light making it through a thin margin of
 * cloud, which is why it is always on the EDGE of a billow and never in the
 * middle of one. Applying the Henyey-Greenstein gain to the whole deck gave a
 * cloud CORE facing the moon 3.26x the isotropic level on top of an already
 * unoccluded beam — the white half of the marbling, and the reason the deck
 * read as ink rather than as a solid with a lit side.
 *
 * A photon that has scattered more than a couple of times has forgotten which
 * way it came in, so the anisotropy has to decay with optical depth. exp(-thick
 * / 1.15) keeps the whole lobe on a wisp (thick ~ 0.2 -> 0.84), leaves 42% of it
 * at a silhouette edge (thick ~ 1) and 7% in a core (thick ~ 3), which puts the
 * silvering on the rim where it belongs.
 */
const float SK_CLOUD_ANISO_TAU = 1.15;

/** Beer-Lambert transmittance -> transmittance with a multiple-scatter floor. */
float skCloudMS( float t ) { return SK_CLOUD_MS + ( 1.0 - SK_CLOUD_MS ) * t; }

/** Weather-scale coverage, in kilometres. Mirrored exactly on the CPU. */
float skCloudMacro( vec2 p ) {
  float a = sin( p.x * 0.412 + 0.7 ) * cos( p.y * 0.331 - 0.4 );
  float b = sin( p.x * 0.173 - p.y * 0.209 + 1.9 );
  float c = cos( p.x * 0.0871 + p.y * 0.1123 - 0.6 );
  return clamp( 0.5 + 0.5 * ( 0.42 * a + 0.36 * b + 0.30 * c ), 0.0, 1.0 );
}

/**
 * Ridged noise with a *parabolic* crest instead of an absolute-value one.
 *
 * skRidge2 in noise.js builds its ridge as 1 - |2v-1|, which has a crease at the
 * crest: the derivative flips sign discontinuously, so any threshold applied to
 * it produces a hairline. On the cumulus silhouette that crease is what makes the
 * cauliflower edge, and it is right there. On an anisotropic field stretched
 * across the sky it is a pen stroke, and a sky full of pen strokes was the second
 * half of the cirrus problem — the first was where they pointed.
 *
 * 1 - (2v-1)^2 has the same crest lines and the same statistics but is C1 across
 * them, so a fibre has a soft shoulder and a body several pixels wide. Two
 * octaves only: the third would land near the pixel footprint again.
 */
float skSmoothRidge2( vec2 p, int oct ) {
  float a = 0.62, s = 0.0, n = 0.0;
  for ( int i = 0; i < oct; i ++ ) {
    float v = skVal2( p ) * 2.0 - 1.0;
    s += a * ( 1.0 - v * v );
    n += a;
    p = SK_ROT * p * 2.17 + 3.71;
    a *= 0.45;
  }
  return s / max( n, 1e-4 );
}

/**
 * One family of cirrus, p in kilometres on the deck.
 *
 * WHY THIS IS SHAPED THE WAY IT IS — the starburst, and its two successors.
 *
 * The deck is sampled where the view ray meets a shell 7.8 km up, so the map from
 * screen space to p is a projection whose derivative grows without bound as the
 * ray flattens toward that shell. Three separate artefacts came out of that, and
 * each one had to be answered by a different part of this function:
 *
 *  1  STARBURST. A field with a locally constant direction is a family of
 *     parallel lines, and parallel lines on a plane converge on a vanishing
 *     point. With one rotation field at one turn per 80 km the direction was
 *     effectively constant across a 90-degree frame, so every fibre pointed at
 *     the same spot just above the top of the hero framing.
 *  2  FINGERPRINT. Rotating the anisotropy frame by a full +-1.45 rad instead
 *     removes the vanishing point and replaces it with something worse: the
 *     direction field winds all the way round its own critical points, so the
 *     fibres close into concentric whorls and the sky reads as wood grain.
 *  3  BRUSH STROKES. Even a bounded wander leaves the *silhouette* of the layer
 *     defined by a level set of a ridged field, and a level set is a continuous
 *     curve that runs through as many cells as it likes. That is why raising the
 *     noise frequency only ever made the strokes thinner, never shorter.
 *
 * The answer to all three is to stop letting the anisotropic field decide *where
 * there is cloud*. What survives here is:
 *
 *   silhouette   an isotropic warped fbm, thresholded — the same construction as
 *                the cumulus deck, so it reads as cloud and cannot smear, streak
 *                or whorl no matter how the projection stretches it;
 *   fibre        an anisotropic smooth-ridge field that only *modulates* that
 *                silhouette between 0.35 and 1.2 of its density. Cirrus texture
 *                is a brightness variation inside the patch, which is what it is
 *                in a photograph too;
 *   bearing      per family, +-0.55 rad of wander, and the two families in
 *                skClouds sit 75 degrees apart so no single direction owns the
 *                frame;
 *   fronts       a patch mask at ~8 km, so the layer arrives in bands with clean
 *                blue between them rather than as an even glaze.
 */
float skCirrusBand( vec2 p, float cov, float seed, float base,
                    float rotKmInv, float lenKM, float aniso, int oct ) {
  // ---- silhouette: isotropic, so it can never streak --------------------
  vec2 w = vec2( skVal2( p * 0.30 + seed ), skVal2( p * 0.30 + seed + 11.7 ) ) - 0.5;
  float n = skFbm2( p * 0.78 + w * 1.3, oct + 1 );
  float d = smoothstep( 1.0 - cov * 1.65, 1.0 - cov * 0.60, n );
  if ( d <= 0.001 ) return 0.0;

  // ---- fronts ------------------------------------------------------------
  d *= smoothstep( 0.36, 0.66, skVal2( p * 0.12 + seed * 0.5 ) );
  if ( d <= 0.001 ) return 0.0;

  // ---- fibre texture inside the patch ------------------------------------
  float ang = base + ( skVal2( p * rotKmInv + seed ) - 0.5 ) * 1.1;
  float ca = cos( ang ), sa = sin( ang );
  vec2 pr = vec2( p.x * ca - p.y * sa, p.x * sa + p.y * ca );
  float fa = 1.0 / max( 0.4, lenKM );
  vec2 q = vec2( pr.x * fa, pr.y * fa * aniso );
  float f = skSmoothRidge2( q + vec2( seed ), oct );
  // Never zeroes the patch and never doubles it: the fibres are a texture on the
  // cloud, not the cloud. The mean is close to 1 so coverage stays where the
  // threshold above put it.
  return d * ( 0.35 + 1.05 * f );
}

/** Cumulus optical thickness at a point on the deck, p in kilometres. */
float skCumulusDensity( vec2 p, int oct ) {
  float macro = skCloudMacro( p * 0.22 );
  float cov = clamp( uCloudParams.x * ( 0.34 + 1.30 * macro ), 0.0, 1.0 );

  // Domain warp before the shape fbm. Straight fbm gives evenly sized blobs;
  // warping it stretches some and pinches others, which is what makes a cloud
  // field read as weather rather than as noise.
  vec2 w = vec2( skVal2( p * 0.42 ), skVal2( p * 0.42 + 19.7 ) ) - 0.5;
  float n = skFbm2( p * 1.25 + w * 1.6, oct );

  // Erode from below: coverage sets the threshold, the remainder is thickness.
  float d = smoothstep( 1.0 - cov, 1.0 - cov * 0.34 + 0.05, n );

  // Cauliflower the edges with a higher-frequency ridge, so the silhouette is
  // not just a smooth level set of the base noise.
  if ( d > 0.0 && d < 0.94 && oct > 3 ) {
    float e = skRidge2( p * 5.3 + w * 2.0, 3 );
    d = clamp( d - ( 1.0 - d ) * ( 0.50 - 0.50 * e ), 0.0, 1.0 );
  }
  return d;
}

/**
 * Fraction of sunlight reaching a point on the cumulus deck. Marched along the
 * sun's horizontal projection; the low-sun path through the slab is longer,
 * which is why sunset clouds go dark grey underneath and blaze at the top.
 */
float skCumulusLight( vec2 p, vec3 lightDir, int oct ) {
  vec2 step2 = normalize( lightDir.xz + vec2( 1e-4 ) ) * ( 0.20 / max( 0.12, abs( lightDir.y ) ) );
  float tau = 0.0;
  tau += skCumulusDensity( p + step2 * 1.0, oct ) * 1.0;
  tau += skCumulusDensity( p + step2 * 2.4, oct ) * 0.7;
  tau += skCumulusDensity( p + step2 * 4.6, oct ) * 0.4;
  return exp( -tau * uCloudParams.y * 2.1 );
}

/**
 * Composite both decks for a view ray.
 * Returns rgb = radiance, a = coverage (0 lets the sky through untouched).
 *
 * sunLow/sunHigh are the solar irradiance already extinguished down to each
 * deck's own altitude, so the two layers are lit by genuinely different spectra.
 */
vec4 skClouds( vec3 rayDir,
               vec3 sunDir, vec3 sunLow, vec3 sunHigh,
               vec3 moonDir, vec3 moonLow, vec3 moonHigh,
               vec3 ambient, int quality ) {

  if ( rayDir.y < -0.008 ) return vec4( 0.0 );

  int octD = quality > 0 ? 6 : 3;
  int octL = quality > 0 ? 4 : 2;
  // Cirrus gets two octaves where the cumulus gets six, and that is not a
  // performance decision. This deck is twenty kilometres away, where one screen
  // pixel covers thirty metres of it; an octave finer than that is pure aliasing,
  // and aliasing on an anisotropic field is precisely what a hairline smear is.
  int octC = 2;
  float t = uCloudParams.w;
  vec2 wind = vec2( uCloudParams2.z, uCloudParams2.w ) * t;

  float cosSun = dot( rayDir, sunDir );
  float cosMoon = dot( rayDir, moonDir );

  // ---- cirrus, 7.8 km ----------------------------------------------------
  float tc = skRaySphere( uViewPos, rayDir, SK_GROUND_R + SK_CIRRUS_KM * 0.001 );
  vec4 cirrus = vec4( 0.0 );
  if ( tc > 0.0 ) {
    float distKM = tc * 1000.0;

    // Distance fade, and it is doing antialiasing as much as atmospherics.
    // Below ~15 degrees of elevation this shell is 30 km away or more, and the
    // derivative d(distance)/d(elevation) there is over 400 m per screen pixel —
    // several times the width of a fibre. Nothing sampled per-pixel can survive
    // that: the field aliases into hairline radial striations that all point at
    // the same place on screen, which is one half of what read as a starburst
    // (the other half was the field's own constant direction). Ending the layer
    // at 90 km rather than 260 km removes the entire undersampled band, and a
    // real cirrus deck does fade into the horizon haze at exactly that range.
    float fade = 1.0 - smoothstep( 22.0, 90.0, distKM );

    // Above ~35 degrees of elevation the same derivative blows up the other way:
    // a kilometre on the deck covers a large and rapidly changing solid angle, so
    // whatever the field does it smears radially through the zenith. Keep the
    // layer to a third of its opacity up there — high cirrus overhead is thin
    // anyway, and those smears were the loudest thing in the night frame.
    fade *= 1.0 - 0.66 * smoothstep( 0.55, 0.85, rayDir.y );

    if ( fade > 0.004 ) {
      vec2 p = ( uViewPos + rayDir * tc ).xz * 1000.0 + wind * 2.4;
      float cov = clamp( uCloudParams2.x, 0.0, 1.0 );

      // Two decorrelated families: different seeds, different patch masks,
      // different bearings (0.24 and 1.56 rad — 75 degrees apart), different
      // rotation frequencies (one turn per 7.4 km and per 10.2 km) and different
      // fibre scales. Each square of sky is dominated by one of them, which is how
      // a real cirrus front looks, but the *frame* always contains both — and two
      // families 75 degrees apart cannot share a vanishing point.
      float d1 = skCirrusBand( p, cov, 0.0, 0.24, 0.135, 1.5, 4.0, octC );
      float d2 = skCirrusBand( p + 137.4, cov * 0.92, 4.7, 1.56, 0.098, 2.0, 3.4, octC );
      float d = 1.0 - ( 1.0 - d1 ) * ( 1.0 - d2 * 0.85 );

      // Optically thin: even a solid-looking cirrus front only takes about two
      // thirds of the sky behind it.
      float a = clamp( d * uCloudParams2.y * fade, 0.0, 0.70 );

      // Optically thin: mostly forward scatter plus whatever the sky gives back.
      // Cirrus sit above most of the aerosol, so they keep far more blue than
      // the cumulus below them — which is exactly why a sunset goes pink up high
      // and orange-grey lower down.
      float fwd = skHG( cosSun, 0.74 ) * 3.2 + 0.60;
      vec3 col = ( sunHigh * fwd + moonHigh * ( skHG( cosMoon, 0.68 ) * 2.8 + 0.55 ) )
                 / SK_PI + ambient * 0.85;
      cirrus = vec4( col, a );
    }
  }

  // ---- cumulus, 1.5 km ---------------------------------------------------
  float tk = skRaySphere( uViewPos, rayDir, SK_GROUND_R + SK_CUMULUS_KM * 0.001 );
  vec4 cumulus = vec4( 0.0 );
  if ( tk > 0.0 ) {
    float distKM = tk * 1000.0;
    // Same argument as the cirrus fade above, and this deck needs it MORE: it is
    // five times lower, so the ray flattens against it five times faster. The
    // intersection is 12 km out at 7 degrees of elevation, 28 km at 3 and 57 km
    // at 1.5, and the deck's own features are 800 m across — which at 20 km
    // subtend 0.17 degrees of ELEVATION against the 0.176 degrees one texel of
    // the 2048 x 1024 equirect bake covers. The deck is at its own Nyquist limit
    // by about 3 degrees of elevation and past it below that, and what that
    // produces along the horizon is not a distant cloud bank, it is confetti.
    //
    // The only lever that reaches it is the alpha: dropping octaves does not,
    // because the visible sky is the quality-0 bake (dome.js ENV_FRAG calls
    // skSample with quality 0, and the dome then reads that equirect), so this
    // deck already runs at its 3-octave floor and it is the BASE octave that is
    // aliasing. 55 km rather than 130 ends it at about 1.5 degrees, where its own
    // aerial perspective has already taken it to within 18% of the sky (the
    // bleed term in dome.js skSample). A real 1.5 km deck under this much haze is
    // gone by 40-60 km anyway, so one number does the atmospherics and the
    // antialiasing. Measured on Neon Foundry it takes 2.6% off the adjacent-texel
    // contrast in the 2-10 degree band; the shear clamp below takes the other 26.
    float fade = 1.0 - smoothstep( 12.0, 55.0, distKM );
    if ( fade > 0.004 ) {
      vec2 p0 = ( uViewPos + rayDir * tk ).xz * 1000.0 + wind;

      // Fake vertical extent. A cumulus is several hundred metres tall;
      // sampling a flat deck once gives a decal. So: probe the base, shift the
      // sample along the view ray by the height the cloud would have there, and
      // probe again. The result parallaxes — tops lean away from the camera,
      // bases toward it — which is what gives the silhouette any depth at all.
      float dBase = skCumulusDensity( p0, octD );
      // The parallax offset is CLAMPED, and that clamp is the difference between
      // a billow and an oil slick. 0.85 * d / rayDir.y is the horizontal run of a
      // view ray climbing the cloud's own height, which is right overhead and
      // absurd at a grazing angle: at 6 degrees of elevation it asks for an 8.1 km
      // shift to represent 850 m of cloud. Two samples 8 km apart on a field whose
      // features are 800 m across are not the base and the top of one cloud, they
      // are two unrelated clouds — and taking max() of them draws the union of two
      // silhouettes, which is where the thin bright crescents around dark cores in
      // the night frames came from. 1.2 km is about one cumulus diameter, so the
      // shifted sample still lands on the same cloud. It only binds below ~45
      // degrees of elevation; directly overhead 0.85 * d / 0.7 is already 1.03 max,
      // so nothing about the zenith moves.
      vec2 shear = rayDir.xz * min( 0.85 * dBase / max( 0.10, rayDir.y ), 1.2 );
      float d = max( skCumulusDensity( p0 + shear, octD ), dBase * 0.55 );

      if ( d > 0.003 ) {
        vec2 p = p0 + shear;
        // Beer-Lambert toward each body, then the multiple-scattering floor —
        // see SK_CLOUD_MS. Without it the shaded side of every billow crushes
        // to whatever the sky happens to be giving, which by day is 2.6% of the
        // beam and after dark is nothing at all.
        float lit = skCloudMS( skCumulusLight( p, sunDir, octL ) );
        float litM = skCloudMS( skCumulusLight( p, moonDir, octL ) );

        // Grazing rays travel further through a deck — but only up to a point,
        // past which the deck is simply far away and the haze wins.
        float graze = clamp( 0.09 / ( abs( rayDir.y ) + 0.09 ), 0.0, 1.0 );
        float thick = d * uCloudParams.y * mix( 1.0, 1.7, graze );
        float a = clamp( 1.0 - exp( -thick * 3.4 ), 0.0, 1.0 ) * fade;

        // Powder (dark-edge) term. Note what it does and does not do: it is
        // small where the slab is optically thin, so it darkens the *thin lit
        // edge* relative to the deep lit core, which is the multiple-scattering
        // deficit a real cloud shows against the sun. It is NOT what darkens
        // bases — that is skCumulusLight above, whose sun path through the slab
        // is what puts the underside in shadow. At density 1.9 the top-to-base
        // spread inside a cloud body measures ~3.5 stops (it was the same spread
        // at 1.4, but on a deck so continuous that almost nothing in frame was a
        // lit top, which is why the shots read flat).
        float powder = 1.0 - exp( -thick * 5.5 );
        float rim = pow( clamp( 1.0 - d, 0.0, 1.0 ), 2.0 );

        // How much of the phase function's direction is left after this much
        // cloud. skHG is normalised over the sphere, so the isotropic level a
        // deep core has to fall back to is 1/4pi = 0.0796 — the two mixes below
        // are the SAME expression with skHG replaced by its own mean, which is
        // what makes this a redistribution of the lobe rather than a dimmer.
        float aniso = exp( -thick / SK_CLOUD_ANISO_TAU );
        float hgS = mix( 0.0796, skHG( cosSun, 0.62 ), aniso );
        float hgM = mix( 0.0796, skHG( cosMoon, 0.60 ), aniso );
        float fwdS = hgS * 4.0 + 0.62;
        float fwdM = hgM * 3.4 + 0.55;

        vec3 direct = sunLow * ( lit * ( 0.55 + 0.45 * powder ) * fwdS + rim * lit * 0.9 );
        direct += moonLow * ( litM * ( 0.55 + 0.45 * powder ) * fwdM + rim * litM * 0.9 );
        // Sky fill, and the gradient runs the other way to the one it used to.
        // Skylight reaches a wisp from the whole hemisphere and reaches the
        // middle of a 400 m billow barely at all, so the factor has to FALL with
        // optical depth — it rose with it before, which lit cloud cores brighter
        // than their own edges and is the second half of why the deck read as
        // marbling. The mean over the deck is held near where it was (1.35 ->
        // 0.45 averages 0.86 against the old 0.5 -> 1.5 through its own
        // sun-gate) so the daylight level does not move.
        vec3 fill = ambient * mix( 1.35, 0.45, clamp( d * 1.6, 0.0, 1.0 ) );
        cumulus = vec4( direct / SK_PI + fill, a );
      }
    }
  }

  // Cumulus is below cirrus, so it goes on top from the ground's point of view.
  float outA = cirrus.a + cumulus.a * ( 1.0 - cirrus.a );
  vec3 outC = cirrus.rgb * cirrus.a + cumulus.rgb * cumulus.a * ( 1.0 - cirrus.a );
  if ( outA > 1e-5 ) outC /= outA;
  return vec4( outC, outA );
}

/**
 * Sunlight reaching the ground through the cumulus deck, for a world XZ point.
 * The volumetric fog uses this so shafts carry the cloud pattern; the sun's
 * DirectionalLight uses the CPU twin of skCloudMacro for the same reason.
 */
float skCloudShadow( vec2 worldXZ, vec3 sunDir ) {
  // Walk from the ground point up to the deck along the sun direction. sunDir
  // is unit, so the horizontal offset is just sunDir.xz scaled by the slope.
  vec2 p = worldXZ * 0.001 + sunDir.xz * ( SK_CUMULUS_KM / max( 0.10, sunDir.y ) )
           + vec2( uCloudParams2.z, uCloudParams2.w ) * uCloudParams.w;
  float d = skCumulusDensity( p, 4 );
  return exp( -d * uCloudParams.y * 2.4 );
}

#endif
`;

/**
 * CPU twin of skCloudMacro. Identical expression, so the sun-occlusion factor
 * the DirectionalLight uses is the same field the shader draws. float32 vs
 * float64 differ in the last few bits; nothing here is sensitive to that.
 */
export function cloudMacro(x, y) {
  const a = Math.sin(x * 0.412 + 0.7) * Math.cos(y * 0.331 - 0.4);
  const b = Math.sin(x * 0.173 - y * 0.209 + 1.9);
  const c = Math.cos(x * 0.0871 + y * 0.1123 - 0.6);
  return Math.min(1, Math.max(0, 0.5 + 0.5 * (0.42 * a + 0.36 * b + 0.3 * c)));
}

/**
 * Approximate fraction of direct sunlight surviving the cumulus deck above a
 * world point. Uses the macro field only: the fbm detail modulates *within* a
 * cloud, but whether the sun is behind a cloud at all is a weather-scale
 * question, which is exactly what the macro field answers.
 */
export function cloudSunOcclusion(worldX, worldZ, sunDir, params) {
  const h = 1.5;
  const k = h / Math.max(0.1, sunDir.y);
  const px = worldX * 0.001 + sunDir.x * k + params.windX * params.time;
  const pz = worldZ * 0.001 + sunDir.z * k + params.windZ * params.time;
  const macro = cloudMacro(px * 0.22, pz * 0.22);
  const cov = Math.min(1, Math.max(0, params.coverage * (0.34 + 1.3 * macro)));
  // Expected density for a coverage threshold applied to a [0,1] fbm.
  const d = Math.min(1, Math.max(0, (cov - 0.42) / 0.62));
  return Math.exp(-d * params.density * 1.55);
}
