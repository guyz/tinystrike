import * as THREE from 'three';
import { Pass, LUMA_GLSL } from './pass.js';

/**
 * Final composite: exposure -> additive bloom -> ACES filmic -> sRGB encode,
 * with an ordered dither on the way to 8 bits.
 *
 * All of it in ONE pass over the framebuffer, so the whole tail of the chain
 * costs a single full-resolution read and write rather than one per effect.
 *
 * The tone curve and the encode are three's own `ACESFilmicToneMapping` and
 * `sRGBTransferOETF` chunks reproduced verbatim, including the 0.41666 exponent
 * (three's value, not 1/2.4). That is deliberate and load bearing: with
 * `uBloom` at 0 this pass is bit-identical to what the renderer wrote straight
 * to the canvas before the chain existed, so any pixel difference in an A/B is
 * bloom and nothing else. The sky dome's own copy of the same curve
 * (src/gfx/sky/dome.js) is switched off while the chain is active — see
 * src/gfx/post/index.js — so sky and geometry still share one response.
 */

const COMPOSITE = /* glsl */ `
precision highp float;
${LUMA_GLSL}
uniform sampler2D tColor;
uniform sampler2D tBloom;
uniform vec4 uParams;   // x exposure, y bloom strength, z dither amount, w unused
varying vec2 vUv;

vec3 RRTAndODTFit( vec3 v ) {
  vec3 a = v * ( v + 0.0245786 ) - 0.000090537;
  vec3 b = v * ( 0.983729 * v + 0.4329510 ) + 0.238081;
  return a / b;
}

vec3 ACESFilmic( vec3 color ) {
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
  color = ACESInputMat * color;
  color = RRTAndODTFit( color );
  color = ACESOutputMat * color;
  return clamp( color, 0.0, 1.0 );
}

vec3 linearToSRGB( vec3 c ) {
  return mix( pow( c, vec3( 0.41666 ) ) * 1.055 - vec3( 0.055 ),
              c * 12.92,
              vec3( lessThanEqual( c, vec3( 0.0031308 ) ) ) );
}

// Cheap hash used only as a dither source; one fract chain, no texture.
float hash12( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}

void main() {
  vec3 hdr = max( texture2D( tColor, vUv ).rgb, vec3( 0.0 ) );

  // Exposure in front of the tone curve, exactly where three applies it.
  hdr *= uParams.x;

  // ADDED, not mixed. mix() with the pyramid is veiling glare: it replaces N%
  // of every pixel with a blurred copy of the frame, which is a milky haze you
  // cannot turn up far enough to actually see a specular event. The pyramid
  // only carries what was above display white, so adding it puts light around
  // the sun disc, the neon, the tracers and the muzzle flash, and leaves every
  // other pixel exactly where the tone curve put it.
  hdr += max( texture2D( tBloom, vUv ).rgb, vec3( 0.0 ) ) * uParams.y;

  // three folds the /0.6 into its exposure multiply; the exposure is already
  // applied above, so it appears on its own here. Same curve, same numbers.
  vec3 ldr = linearToSRGB( ACESFilmic( hdr / 0.6 ) );

  // The canvas is 8-bit and the sky is a wide, near-flat gradient — the exact
  // signal 8 bits cannot hold without visible contouring. Half a code value of
  // noise costs nothing and turns the bands into grain the eye reads as
  // continuous. Applied after the encode because banding is a quantisation
  // artefact of the OUTPUT, not of the linear signal.
  ldr += ( hash12( gl_FragCoord.xy ) - 0.5 ) * uParams.z;

  gl_FragColor = vec4( ldr, 1.0 );
}
`;

export function createComposite() {
  return new Pass('ts-composite', COMPOSITE, {
    tColor: { value: null },
    tBloom: { value: null },
    // Bloom strength 0.12. The pyramid is energy preserving and normalised, so
    // this is a true "12% of a blown highlight's energy comes back as glare",
    // not an arbitrary gain. Measured on Harbor at 2560x1440, sweeping 0.06 to
    // 0.22: pixels whose base value is under 40/255 gain 0.01 to 0.04 code
    // values across that whole range — the thresholded pyramid carries almost
    // nothing outside real highlights, so there is no veiling haze to trade
    // against — while pixels over 150/255 gain 0.18 to 0.41. The peak barely
    // moves (170 to 196) because bloom is added in linear light in FRONT of the
    // ACES shoulder, which compresses it; what more strength actually buys is a
    // wider halo, not a brighter core. 0.12 is where the neon on Neon Foundry
    // and the sun disc on Dustyard read as light sources rather than as flat
    // bright shapes, with the darks still measurably untouched.
    // Dither 1/255 peak to peak, i.e. +-half a code value.
    uParams: { value: new THREE.Vector4(1, 0.12, 1 / 255, 0) },
  });
}

/**
 * FXAA 3.11-style edge filter.
 *
 * Runs on the sRGB-encoded LDR image, which is where FXAA is meant to run: its
 * thresholds are perceptual, and a luma computed on linear light would miss
 * every edge in the shadows and over-trigger in the highlights.
 *
 * It also catches something MSAA structurally cannot. An MSAA resolve averages
 * subsamples in LINEAR light before the tone curve, so a silhouette against the
 * sun averages, say, 200.0 and 0.02 to 100.0 — which the shoulder still maps to
 * white. The edge stays hard. Filtering after the curve works on the values the
 * display will actually show, which is why it is the AA that fixes the exact
 * high-dynamic-range edges this chain exists to create.
 */
const FXAA = /* glsl */ `
precision highp float;
${LUMA_GLSL}
uniform sampler2D tColor;
uniform vec2 uTexel;
varying vec2 vUv;

void main() {
  vec3 rgbNW = texture2D( tColor, vUv + vec2( -1.0, -1.0 ) * uTexel ).rgb;
  vec3 rgbNE = texture2D( tColor, vUv + vec2(  1.0, -1.0 ) * uTexel ).rgb;
  vec3 rgbSW = texture2D( tColor, vUv + vec2( -1.0,  1.0 ) * uTexel ).rgb;
  vec3 rgbSE = texture2D( tColor, vUv + vec2(  1.0,  1.0 ) * uTexel ).rgb;
  vec4 texColor = texture2D( tColor, vUv );
  vec3 rgbM = texColor.rgb;

  float lumaNW = pfLum( rgbNW );
  float lumaNE = pfLum( rgbNE );
  float lumaSW = pfLum( rgbSW );
  float lumaSE = pfLum( rgbSE );
  float lumaM  = pfLum( rgbM );
  float lumaMin = min( lumaM, min( min( lumaNW, lumaNE ), min( lumaSW, lumaSE ) ) );
  float lumaMax = max( lumaM, max( max( lumaNW, lumaNE ), max( lumaSW, lumaSE ) ) );

  // Local-contrast early out: 1/32 of the local maximum, floored at ~8 code
  // values. Most of the frame takes this branch, which is why FXAA costs far
  // less than its 12-tap worst case suggests.
  if ( lumaMax - lumaMin < max( 0.0312, lumaMax * 0.125 ) ) {
    gl_FragColor = texColor;
    return;
  }

  vec2 dir = vec2(
    -( ( lumaNW + lumaNE ) - ( lumaSW + lumaSE ) ),
      ( ( lumaNW + lumaSW ) - ( lumaNE + lumaSE ) ) );
  float dirReduce = max( ( lumaNW + lumaNE + lumaSW + lumaSE ) * 0.03125, 0.0078125 );
  float rcpDirMin = 1.0 / ( min( abs( dir.x ), abs( dir.y ) ) + dirReduce );
  dir = clamp( dir * rcpDirMin, -8.0, 8.0 ) * uTexel;

  vec3 rgbA = 0.5 * (
    texture2D( tColor, vUv + dir * ( 1.0 / 3.0 - 0.5 ) ).rgb +
    texture2D( tColor, vUv + dir * ( 2.0 / 3.0 - 0.5 ) ).rgb );
  vec3 rgbB = rgbA * 0.5 + 0.25 * (
    texture2D( tColor, vUv - dir * 0.5 ).rgb +
    texture2D( tColor, vUv + dir * 0.5 ).rgb );

  // The 4-tap estimate is better unless it left the neighbourhood's luma range,
  // which means the edge was too thin for it and the 2-tap is the safe answer.
  float lumaB = pfLum( rgbB );
  gl_FragColor = vec4( ( lumaB < lumaMin || lumaB > lumaMax ) ? rgbA : rgbB, texColor.a );
}
`;

export function createFxaa() {
  return new Pass('ts-fxaa', FXAA, {
    tColor: { value: null },
    uTexel: { value: new THREE.Vector2() },
  });
}
