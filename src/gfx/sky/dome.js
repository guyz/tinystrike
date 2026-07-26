import * as THREE from 'three';
import {
  ATMOSPHERE_GLSL,
  TRANSMITTANCE_LOOKUP_GLSL,
} from './atmosphere.js';
import { SKYVIEW_LOOKUP_GLSL } from './luts.js';
import { NOISE_GLSL } from './noise.js';
import { STARS_GLSL } from './stars.js';
import { CLOUDS_GLSL } from './clouds.js';
import { fullScreenGeometry, SKY_VERT } from './fullscreen.js';

/**
 * The visible sky.
 *
 * Drawn as a full-screen triangle at renderOrder -10000 with depth test and
 * depth write off, exactly the way `scene.background` works internally — so it
 * fills the frame before any geometry and costs one primitive. The ray
 * direction is rebuilt from `camera.projectionMatrixInverse` inside
 * `onBeforeRender`, which means it picks up the renderer's TAA jitter and the
 * sun disc gets properly resolved sub-pixel antialiasing instead of stair steps.
 *
 * `userData.owNoPrepass` keeps it out of the depth/normal/velocity prepass and
 * out of the shadow cascades, per the render contract.
 *
 * Contents, in the order they are layered:
 *   sky-view LUT  -> Rayleigh + Mie + ozone + multiple scattering
 *   aureoles      -> the Mie forward peak the LUT resolution destroys
 *   sun disc      -> limb darkened, extinguished by the view-path transmittance
 *   moon disc     -> procedural albedo, real terminator from the sun direction
 *   night sky     -> Milky Way, three star layers, airglow, attenuated by the
 *                    cloud alpha computed below it — stars do not shine through
 *                    an overcast, and that ordering is the only way to say so
 *   clouds        -> cirrus then cumulus, lit by the same irradiances
 *   ground        -> first-bounce albedo below the horizon (matters for IBL)
 */

const SKY_BODY = /* glsl */ `
${ATMOSPHERE_GLSL}
${TRANSMITTANCE_LOOKUP_GLSL}
${SKYVIEW_LOOKUP_GLSL}
${NOISE_GLSL}
${STARS_GLSL}
${CLOUDS_GLSL}

uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform vec3 uSunIrradiance;      // scene light units, at the ground
uniform vec3 uMoonIrradiance;
uniform vec3 uSunDiscRadiance;    // radiance of the disc before extinction
uniform vec3 uMoonDiscRadiance;
uniform vec4 uDisc;               // x sun ang. radius, y moon ang. radius,
                                  // z sun draw scale, w moon draw scale
uniform vec3 uGroundAlbedo;
uniform float uHorizonMurk;       // city haze piled up at eye level
uniform vec2 uSkyRolloff;         // x knee (scene radiance), y overshoot room
uniform vec4 uHorizon;            // see skSkyline / skGround

float owSkLum( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }

/** 2x1: texel 0 = cosine-weighted sky average, texel 1 = horizon band average. */
uniform sampler2D uSkyAmbientLut;

vec3 skAmbientSky() { return texture( uSkyAmbientLut, vec2( 0.25, 0.5 ) ).rgb; }
vec3 skAmbientHorizon() { return texture( uSkyAmbientLut, vec2( 0.75, 0.5 ) ).rgb; }

/**
 * Radiance of the solar disc, limb darkened. The exponents are the per-channel
 * Hosek-Wilkie limb coefficients: blue falls off fastest, which is why the rim
 * of a low sun is orange while the centre stays white.
 */
vec3 skSunDisc( vec3 rayDir, float theta ) {
  float R = uDisc.x * uDisc.z;
  float aa = max( 1.0e-6, fwidth( theta ) );
  float cover = smoothstep( R + aa, R - aa, theta );
  if ( cover <= 0.0 ) return vec3( 0.0 );
  float r = clamp( theta / R, 0.0, 1.0 );
  float mu = sqrt( max( 0.0, 1.0 - r * r ) );
  vec3 limb = pow( vec3( mu ), vec3( 0.32, 0.44, 0.58 ) );
  // Enlarging the disc for readability must not add energy, so divide by the
  // area factor; bloom then behaves the same as it would at true angular size.
  return uSunDiscRadiance * limb * cover * skTransmittance( uViewPos, uSunDir )
         / ( uDisc.z * uDisc.z );
}

/**
 * Circumsolar aureole — the bright white halo that surrounds a real sun out to
 * ten or fifteen degrees.
 *
 * The sky-view LUT is 384x192, so one texel spans about a degree of azimuth.
 * The Mie phase function at g = 0.8 puts most of its energy inside five
 * degrees, and bilinear interpolation of a one-degree grid destroys exactly
 * that peak — which is why a LUT-based Hillaire sky renders a sun as a hard
 * white dot pasted on flat blue. This adds the missing energy back
 * analytically: the aerosol optical depth along the view ray times the *excess*
 * of the Mie phase over its value at the cutoff angle, so the term is
 * continuous at the edge, vanishes when turbidity goes to zero, and reddens
 * with the sun because it is driven by the same transmittance as everything
 * else. It is a scattering integral, not a lens flare.
 */
vec3 skAureole( vec3 rayDir, vec3 lightDir, vec3 irradiance, float cosTheta ) {
  const float CUT = 0.9135; // cos(24 degrees)
  if ( cosTheta <= CUT ) return vec3( 0.0 );
  // Aerosol column along the ray: sigma_s * H / cos(zenith), floored so a ray
  // at the horizon does not blow up. The floor is small because the aureole of a
  // *low* sun is the whole point: that is the ramp from the amber core out to
  // eight or ten degrees that makes a sunset read as a sunset.
  float mieOd = SK_MIE_S * uMieScale * 0.0012 / max( 0.055, rayDir.y + 0.055 );
  float excess = max( 0.0, skMiePhase( cosTheta ) - skMiePhase( CUT ) );
  // 4.2: the LUT holds a bilinear smear of this peak across a one-degree grid,
  // and this restores what that interpolation threw away. The coefficient is the
  // one number in the sky that is chosen by eye rather than derived, because what
  // it is correcting is a sampling error, not a physical quantity — it is set so
  // the aureole is about a stop over the sky it sits in at eight degrees out,
  // which is what a photograph of a low sun shows. It carries the sun's own
  // reddened spectrum through skTransmittance, so the ramp is amber at 19h and
  // white at noon without a single hand-picked colour anywhere.
  return irradiance * skTransmittance( uViewPos, rayDir ) * ( excess * mieOd * 4.2 );
}

/**
 * Highlight roll-off for the sky, and only for the sky.
 *
 * At four degrees of solar elevation the aerosol forward peak puts the western
 * horizon three to four stops over the street it is lighting. The street is what
 * the meter is set for, so the whole sky above it lands on the flat top of the
 * tone curve: one achromatic plateau, no Rayleigh column, no transition band, no
 * gradient at all — which is exactly what the 19:20 frame was.
 *
 * This is the sky's own shoulder, applied before the discs. A Reinhard knee on
 * LUMINANCE with the chromaticity carried through unchanged, so what comes back
 * is compressed in level but identical in hue: the peach-to-crimson ramp
 * survives instead of desaturating to white the way a per-channel clamp would.
 * The knee is published as a fraction of the beam's own luminance (see
 * SkySystem._updateCelestial), which makes it exposure-invariant — autoexposure
 * follows the beam, so a knee that follows the beam lands at the same code value
 * at every time of day, and a daylight sky, which never reaches it, is untouched.
 *
 *   uSkyRolloff.x  knee, in scene radiance units
 *   uSkyRolloff.y  compression exponent above the knee (1 = none, 0.38 = ~2.6:1)
 */
vec3 skRolloff( vec3 col ) {
  float knee = uSkyRolloff.x;
  if ( knee <= 0.0 ) return col;
  float l = max( owSkLum( col ), 1.0e-6 );
  if ( l <= knee ) return col;
  // POWER compressor, not a Reinhard knee. The Reinhard form asymptotes at
  // knee * (1 + room), which is a hard ceiling: everything from eight degrees
  // off the sun out to the far horizon piles onto the same value and the sunset
  // sky comes back as one cream plateau — the very artefact the roll-off exists
  // to prevent. x^p has no ceiling, so a 40:1 overshoot still comes out as a
  // 4:1 gradient and the peach-to-crimson ramp survives all the way in to the
  // aureole, while the disc (four decades over) still clips and blooms.
  float p = uSkyRolloff.y;
  return col * ( pow( l / knee, p ) * knee / l );
}

/**
 * The land beyond the compound.
 *
 * The arena's own ground plane stops at the perimeter, about 52 m out, and from
 * there down the atmosphere hands back one flat first-bounce colour. That is the
 * right answer for the lower hemisphere of an IBL and the wrong one for a
 * picture: standing on a roof you look over a nine-metre wall at six degrees of
 * featureless matte, which reads as a sea. Two terms fix it for the cost of
 * about seven noise fetches on the half of the dome that is below the horizon.
 *
 * The first is a skyline. It is sampled on a CIRCLE in azimuth rather than on
 * the angle itself, because the angle wraps at +/-pi and a 1D fbm across that
 * seam puts a vertical step down the middle of the equirect bake. Ridged noise,
 * squared: hills have sharp tops and broad flat valleys, and plain fbm has
 * neither.
 *
 * The second is the plain's own texture, in perspective. A ray e radians below
 * the horizon meets a plane H below the eye at H/e metres, so sampling the noise
 * at that intersection compresses the features toward the horizon exactly the
 * way real ground does — no hand-authored gradient can fake that compression,
 * and it is the whole reason a flat plane reads as flat.
 *
 * Both then dissolve into the horizon band on an exponential, which is what
 * actually sells the distance: at fifteen kilometres you are looking at a
 * silhouette of the air in front of a ridge, not at the ridge's albedo. The far
 * limit is 0.90 of the horizon radiance rather than 1.0 — distant ranges sit
 * just under the sky they stand against, and that last 10% is the only thing
 * separating a mountain from the air above it.
 *
 *   uHorizon.x  skyline height, in sin(elevation)   0.038 = 2.2 deg
 *   uHorizon.y  skyline detail, cycles per turn of azimuth
 *   uHorizon.z  albedo variation across the plain, 0..1
 *   uHorizon.w  haze scale: metres at which the ground has lost 1/e of its
 *               contrast against the sky behind it
 */
float skSkyline( vec3 dir ) {
  vec2 p = normalize( vec2( dir.x, dir.z ) + 1.0e-6 ) * uHorizon.y;
  // skRidge2 is normalised by the sum of its octave weights, so it lands in
  // roughly 0.15..0.85 around a mean of 0.5 and never reaches either end. Remap
  // so uHorizon.x means what it says — the elevation of the HIGHEST peaks — and
  // the valley floors sit a quarter of that BELOW the true horizon, so the
  // profile crosses the horizon instead of floating over it as a rampart.
  // Measured before the remap: a nominal 1.4-degree skyline was producing 0.1 to
  // 0.4 degrees and the horizon was a straight line at every azimuth.
  float r = clamp( ( skRidge2( p, 4 ) - 0.30 ) * 1.9, -0.25, 1.0 );
  return uHorizon.x * r;
}

vec3 skGround( vec3 dir, vec3 ambHor, vec3 lit ) {
  // The compound stands 45 m above the plain it looks out over. That number is
  // what decides where the haze acts: at 45 m the first degree below the horizon
  // lands at 2.6 km, which is a third of a clear-air scale height and therefore
  // a visible loss of contrast, while the last tenth of a degree is 26 km out
  // and gone entirely. Put the eye 6 m up instead — level with the roof it is
  // actually seen from — and that whole gradient collapses into the final
  // 0.04 degrees, i.e. into a hard line.
  float e = max( -dir.y, 1.0e-4 );
  float d = min( 45.0 / e, 40000.0 );
  // Ground intersection in metres. |dir.xz| is cos(elevation), which is 1 to
  // within a percent everywhere this branch runs.
  // ~180 m features. Three octaves of value noise cluster hard around 0.5, so a
  // raw fbm modulates the plain by a couple of percent and reads as nothing; the
  // smoothstep pushes it out to the full +/-uHorizon.z the parameter promises.
  float macro = skFbm2( dir.xz * ( d * 0.0055 ), 3 );
  macro = macro * macro * ( 3.0 - 2.0 * macro );
  vec3 ground = lit * ( 1.0 - uHorizon.z * ( 0.5 - macro ) );
  return mix( ambHor * 0.90, ground, exp( -d / uHorizon.w ) );
}

vec3 skMoonDisc( vec3 rayDir, float theta, int oct ) {
  float R = uDisc.y * uDisc.w;
  if ( theta > R * 1.6 ) return vec3( 0.0 );

  vec3 ref = abs( uMoonDir.y ) > 0.97 ? vec3( 0.0, 0.0, 1.0 ) : vec3( 0.0, 1.0, 0.0 );
  vec3 mr = normalize( cross( ref, uMoonDir ) );
  vec3 mu3 = cross( uMoonDir, mr );

  // Gnomonic projection is exact enough over a quarter of a degree.
  vec2 p = vec2( dot( rayDir, mr ), dot( rayDir, mu3 ) ) / R;
  float r2 = dot( p, p );
  // Two pixels of edge, not one: the disc is six stops over the tonemap knee,
  // so a one-pixel edge leaves a dotted rim once TAA and the sharpen filter
  // have had a go at it.
  float aa = max( 1.0e-4, 1.9 * fwidth( r2 ) );
  float cover = smoothstep( 1.0 + aa, 1.0 - aa, r2 );
  if ( cover <= 0.0 ) return vec3( 0.0 );

  vec3 n = normalize( mr * p.x + mu3 * p.y - uMoonDir * sqrt( max( 0.0, 1.0 - min( r2, 1.0 ) ) ) );

  // Maria are basalt floods over anorthositic highlands: albedo 0.06 vs 0.14.
  float highlands = skFbm3( n * 6.5, oct );
  float maria = smoothstep( 0.44, 0.63, skFbm3( n * 2.1 + 5.0, max( 2, oct - 1 ) ) );
  float albedo = mix( 0.105, 0.155, highlands ) * mix( 1.0, 0.52, maria );

  float NdL = max( 0.0, dot( n, uSunDir ) );
  // Lunar regolith backscatters hard: the disc is nearly flat right up to the
  // terminator, which a Lambert cosine gets badly wrong.
  float shade = pow( NdL, 0.42 );
  float earthshine = 0.014;

  return uMoonDiscRadiance * ( albedo / 0.13 ) * ( shade + earthshine ) * cover;
}

/**
 * @param rayDir  normalised world direction
 * @param quality 1 = screen, 0 = environment map (fewer octaves, no star points)
 */
vec3 skSample( vec3 rayDir, int quality ) {
  vec3 ambSky = skAmbientSky();
  vec3 ambHor = skAmbientHorizon();

  vec3 col = skSkyView( rayDir, uSunDir );

  float cosS = dot( rayDir, uSunDir );
  float cosM = dot( rayDir, uMoonDir );
  float thetaS = skSafeAcos( cosS );
  float thetaM = skSafeAcos( cosM );

  // Aureoles go in before the discs so the discs sit *inside* their own glow.
  // Both are driven by the same irradiances that light the scattering, so the
  // lunar halo ends up the same *fraction* of the moonlit sky as the solar
  // aureole is of the daylit sky — it scales with the night's exposure for free.
  col += skAureole( rayDir, uSunDir, uSunIrradiance, cosS );
  col += skAureole( rayDir, uMoonDir, uMoonIrradiance, cosM );

  // ---- clouds -------------------------------------------------------------
  // The two decks sit at very different altitudes, so they see very different
  // solar spectra: the cumulus at 1.5 km looks through nearly the whole aerosol
  // column while the cirrus at 7.8 km is above most of it. Sampling the
  // transmittance LUT at each deck's own altitude is what makes a sunset read
  // as pink cirrus over orange-grey cumulus instead of one flat orange wash.
  vec3 pLow  = vec3( 0.0, SK_GROUND_R + 0.0015, 0.0 );
  vec3 pHigh = vec3( 0.0, SK_GROUND_R + 0.0078, 0.0 );
  vec3 sunLow   = uSunIrradiance  * skTransmittance( pLow,  uSunDir );
  vec3 sunHigh  = uSunIrradiance  * skTransmittance( pHigh, uSunDir );
  vec3 moonLow  = uMoonIrradiance * skTransmittance( pLow,  uMoonDir );
  vec3 moonHigh = uMoonIrradiance * skTransmittance( pHigh, uMoonDir );
  vec4 cl = skClouds( rayDir, uSunDir, sunLow, sunHigh,
                      uMoonDir, moonLow, moonHigh, ambSky, quality );

  // ---- night sky, BEHIND the decks ---------------------------------------
  // Stars have to be occluded by cloud. A star seen *through* an opaque cumulus
  // is the single most obvious tell in a night frame, and it was visible here
  // because the starfield was added to the sky before the decks were composited
  // over it — an 0.6-alpha cloud still let 40% of the field through, and the
  // deck's own radiance at night is so low that 40% of a star is still a star.
  // The multiplier is above one because a deck that is optically thick enough to
  // hide its own texture is thick enough to hide a point source completely.
  vec3 night = skNightSky( rayDir, quality > 0 ? 5 : 3, quality > 0 );
  col += night * ( 1.0 - clamp( cl.a * 1.9, 0.0, 1.0 ) );

  if ( cl.a > 1.0e-4 ) {
    // Aerial perspective on the decks themselves. A cloud twenty kilometres out
    // is seen through twenty kilometres of air, so it loses contrast toward the
    // radiance of the sky in front of it. Keyed off view elevation, which is
    // what sets the path length to a deck of fixed altitude. skClouds has
    // already faded its own alpha with distance; this fades the *colour*, which
    // is what stops a low cloud bank reading as a cut-out.
    float bleed = 1.0 - smoothstep( 0.0, 0.22, rayDir.y );
    col = mix( col, mix( cl.rgb, col, bleed * 0.82 ), cl.a );
  }

  // ---- ground / below the skyline ----------------------------------------
  // The early out keeps the two fbm calls off the 80% of the dome that is
  // unambiguously sky; uHorizon.x is at most 0.08 (4.6 degrees).
  if ( rayDir.y < uHorizon.x + 0.02 ) {
    // First bounce off the street: this is what fills the lower hemisphere of
    // the IBL and gives upward-facing surfaces their warm fill.
    vec3 lit = uGroundAlbedo *
      ( ambHor + uSunIrradiance * max( 0.0, uSunDir.y ) / SK_PI
                + uMoonIrradiance * max( 0.0, uMoonDir.y ) / SK_PI );
    // A skyline is a silhouette against the sky, so the edge is hard — 0.4 deg,
    // about two texels of the 2048 x 1024 bake. What softens the transition is
    // the haze inside skGround, not a wide blend here.
    float sk = skSkyline( rayDir );
    col = mix( col, skGround( rayDir, ambHor, lit ),
               smoothstep( sk + 0.0035, sk - 0.0035, rayDir.y ) );
  }

  // A real city horizon is never clean: dust and exhaust pile up in the first
  // few degrees. Scaled by the sky's own brightness so it can never glow.
  float murk = uHorizonMurk * exp( -abs( rayDir.y ) * 26.0 );
  col = mix( col, ambHor * 1.15, clamp( murk, 0.0, 0.85 ) );

  // ---- horizon roll-off ---------------------------------------------------
  col = skRolloff( col );

  // The discs go in AFTER the roll-off: they are supposed to clip and bloom,
  // and they are the only thing in the sky that is.
  if ( quality > 0 ) col += skSunDisc( rayDir, thetaS );
  col += skMoonDisc( rayDir, thetaM, quality > 0 ? 4 : 2 );

  return max( col, vec3( 0.0 ) );
}
`;

const DOME_VERT = /* glsl */ `
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
out vec3 vRay;
void main() {
  vec2 ndc = position.xy;
  vec4 h = uInvProj * vec4( ndc, 1.0, 1.0 );
  vec3 vd = h.xyz / h.w;
  // Normalise onto the z = -1 plane: that quantity is linear in screen space,
  // so interpolating it and normalising in the fragment shader is exact.
  vd /= max( 1.0e-6, -vd.z );
  vRay = mat3( uCamWorld ) * vd;
  gl_Position = vec4( ndc, 1.0, 1.0 );
}
`;

/**
 * The visible dome tone maps ITSELF.
 *
 * The original engine renders into a half-float buffer and tone maps the whole
 * frame in its composite pass, so the dome writes raw scene radiance. Tiny
 * Strike renders straight to the 8-bit canvas, and three injects neither the
 * tone-mapping nor the output-colour-space chunk into a ShaderMaterial — so
 * writing radiance here would clip every value over 1.0 and the entire sky
 * above the knee would come out flat white.
 *
 * This is three's own ACESFilmicToneMapping, verbatim, driven by the same
 * exposure the renderer applies to every lit surface, followed by the same
 * linear->sRGB encode. Sky and geometry therefore share one response curve.
 * `uOutputExposure` is 0 for the equirect bake below, which must stay linear.
 */
const OUTPUT_GLSL = /* glsl */ `
uniform float uOutputExposure;
vec3 skRRTAndODTFit( vec3 v ) {
  vec3 a = v * ( v + 0.0245786 ) - 0.000090537;
  vec3 b = v * ( 0.983729 * v + 0.4329510 ) + 0.238081;
  return a / b;
}
vec3 skACESFilmic( vec3 color ) {
  const mat3 ACESInputMat = mat3(
    vec3( 0.59719, 0.07600, 0.02840 ),
    vec3( 0.35458, 0.90834, 0.13383 ),
    vec3( 0.04823, 0.01566, 0.83777 )
  );
  const mat3 ACESOutputMat = mat3(
    vec3(  1.60475, -0.10208, -0.00327 ),
    vec3( -0.53108,  1.10813, -0.07276 ),
    vec3( -0.07367, -0.00605,  1.07602 )
  );
  color *= uOutputExposure / 0.6;
  color = ACESInputMat * color;
  color = skRRTAndODTFit( color );
  color = ACESOutputMat * color;
  return clamp( color, 0.0, 1.0 );
}
vec3 skLinearToSRGB( vec3 c ) {
  return mix( pow( c, vec3( 0.41666 ) ) * 1.055 - vec3( 0.055 ), c * 12.92, step( c, vec3( 0.0031308 ) ) );
}
`;

const DOME_FRAG = /* glsl */ `
precision highp float;
${SKY_BODY}
${OUTPUT_GLSL}
in vec3 vRay;
layout(location = 0) out vec4 fragColor;
void main() {
  vec3 col = skSample( normalize( vRay ), 1 );
  if ( uOutputExposure > 0.0 ) col = skLinearToSRGB( skACESFilmic( col ) );
  fragColor = vec4( col, 1.0 );
}
`;

/**
 * The cheap dome: sample the sky that was already baked for the IBL, then draw
 * the sun and moon discs live on top of it.
 *
 * Evaluating the full atmosphere — three LUT fetches, two cloud decks, the
 * Milky Way and three star layers — per pixel per frame is the single most
 * expensive thing in the frame: measured at half the frame time at 3.2 Mpx.
 * And it is almost entirely wasted work, because the sky changes only when the
 * sun moves or the cloud deck drifts, both of which happen over seconds.
 *
 * So the visible dome reads the same equirect the environment map is baked
 * from (re-blitted a couple of times a second, at 1/6 the pixels), which turns
 * a 3.2 Mpx atmosphere evaluation into a 3.2 Mpx texture fetch.
 *
 * The discs are the exception and stay analytic: the sun is 0.53 degrees
 * across, which is under two texels in a 1024x512 equirect, so a baked sun is
 * a blocky smear. Drawn live it is a clean limb-darkened disc that still
 * clips and blooms, and it costs one dot product.
 */
const DOME_TEX_FRAG = /* glsl */ `
precision highp float;
${SKY_BODY}
${OUTPUT_GLSL}
uniform sampler2D uSkyTex;
in vec3 vRay;
layout(location = 0) out vec4 fragColor;
void main() {
  vec3 dir = normalize( vRay );
  // Matches the equirect bake in ENV_FRAG exactly, and three's own equirectUv.
  float az = atan( dir.z, dir.x );
  float lat = asin( clamp( dir.y, -1.0, 1.0 ) );
  vec2 uv = vec2( az / ( 2.0 * SK_PI ) + 0.5, lat / SK_PI + 0.5 );
  vec3 col = texture( uSkyTex, uv ).rgb;

  float thetaS = acos( clamp( dot( dir, uSunDir ), -1.0, 1.0 ) );
  float thetaM = acos( clamp( dot( dir, uMoonDir ), -1.0, 1.0 ) );
  col += skSunDisc( dir, thetaS );
  col += skMoonDisc( dir, thetaM, 4 );

  if ( uOutputExposure > 0.0 ) col = skLinearToSRGB( skACESFilmic( col ) );
  fragColor = vec4( max( col, vec3( 0.0 ) ), 1.0 );
}
`;

/** Equirectangular bake for PMREM. Matches three's `equirectUv` exactly. */
const ENV_FRAG = /* glsl */ `
precision highp float;
${SKY_BODY}
in vec2 vUv;
layout(location = 0) out vec4 fragColor;
void main() {
  float az = ( vUv.x - 0.5 ) * 2.0 * SK_PI;
  float lat = ( vUv.y - 0.5 ) * SK_PI;
  float cl = cos( lat );
  vec3 dir = vec3( cl * cos( az ), sin( lat ), cl * sin( az ) );
  fragColor = vec4( skSample( normalize( dir ), 0 ), 1.0 );
}
`;

export class SkyDome {
  /**
   * @param {object} uniforms shared uniform objects, owned by SkySystem
   */
  constructor(uniforms, opts = {}) {
    this.uniforms = {
      ...uniforms,
      uInvProj: { value: new THREE.Matrix4() },
      uCamWorld: { value: new THREE.Matrix4() },
    };

    // `baked` is the default: see DOME_TEX_FRAG. Passing { baked: false }
    // evaluates the whole atmosphere per pixel, which is what the reference
    // captures use.
    this.baked = opts.baked !== false;
    this.uniforms.uSkyTex = { value: null };

    this.material = new THREE.ShaderMaterial({
      name: this.baked ? 'sky-dome-baked' : 'sky-dome',
      uniforms: this.uniforms,
      vertexShader: DOME_VERT,
      fragmentShader: this.baked ? DOME_TEX_FRAG : DOME_FRAG,
      glslVersion: THREE.GLSL3,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      fog: false,
      toneMapped: false,
    });

    this.mesh = new THREE.Mesh(fullScreenGeometry(), this.material);
    this.mesh.name = 'sky-dome';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10000;
    this.mesh.matrixAutoUpdate = false;
    // Render contract: stay out of the prepass, the cascades and contact shadows.
    this.mesh.userData.owNoPrepass = true;
    this.mesh.userData.owNoShadow = true;

    const u = this.uniforms;
    this.mesh.onBeforeRender = (renderer, scene, camera) => {
      // projectionMatrixInverse is kept in sync with the TAA jitter by the
      // renderer, so the sky is jittered with the rest of the frame.
      u.uInvProj.value.copy(camera.projectionMatrixInverse);
      u.uCamWorld.value.copy(camera.matrixWorld);
    };

    // Environment bake shares every uniform object with the visible sky, so the
    // IBL can never drift out of agreement with what the camera sees.
    this.envMaterial = new THREE.ShaderMaterial({
      name: 'sky-env',
      uniforms: this.uniforms,
      vertexShader: SKY_VERT,
      fragmentShader: ENV_FRAG,
      glslVersion: THREE.GLSL3,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
  }

  dispose() {
    this.material.dispose();
    this.envMaterial.dispose();
  }
}
