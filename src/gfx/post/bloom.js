import * as THREE from 'three';
import { Pass, hdrTarget, LUMA_GLSL } from './pass.js';

/**
 * Bloom: the progressive dual-filter pyramid from "Next Generation Post
 * Processing in Call of Duty: Advanced Warfare" (Jimenez 2014).
 *
 * Not UnrealBloomPass, for three reasons that all matter here:
 *
 *  1. UnrealBloomPass thresholds raw, un-exposed radiance. This game's exposure
 *     is not fixed — SkySystem.syncExposure meters the scene and drives
 *     `toneMappingExposure` over 0.5..1.25 with the time of day — so a fixed
 *     linear threshold would mean a different number of stops over white at
 *     every hour. The prefilter below applies exposure FIRST, so the threshold
 *     is stated in display-referred terms once and holds all day.
 *  2. It has no firefly clamp. With the dome writing raw radiance (see
 *     src/gfx/post/index.js) the sun disc arrives four decades over white; an
 *     unclamped 5-mip Gaussian chain turns that into a screen-wide white wash.
 *  3. Its mips are summed, which multiplies total energy by the mip count and
 *     reads as haze. The tent upsample here blends at 50%, so the pyramid is
 *     energy preserving and the composite's strength is a real percentage.
 *
 * Cost is dominated by the first level; every level after it is a quarter of
 * the pixels of the one before, so the whole pyramid is ~1.33x the first mip.
 */

const DOWNSAMPLE = /* glsl */ `
precision highp float;
${LUMA_GLSL}
uniform sampler2D tSrc;
uniform vec2 uTexel;    // texel size of the SOURCE
uniform vec4 uParams;   // x prefilter on/off, y threshold, z knee, w exposure
varying vec2 vUv;

vec3 fetch( vec2 uv ) { return max( texture2D( tSrc, uv ).rgb, vec3( 0.0 ) ); }

// Karis average: weight each tap by 1/(1+luma) before averaging, so one
// blindingly hot pixel contributes about as much as a merely bright one and
// cannot pump an entire mip on its own. This is what stops a subpixel specular
// glint from strobing as the camera turns.
float karisWeight( vec3 c ) { return 1.0 / ( 1.0 + pfLum( c ) ); }

// Soft-knee highlight prefilter. Driven by the MAX CHANNEL rather than
// luminance so a saturated light — a red tracer, an orange muzzle flash — blooms
// as readily as a white one of the same intensity instead of being judged on a
// luma that its own hue suppresses. Below the knee the response is quadratic,
// so there is no hard edge where the effect switches on.
vec3 prefilter( vec3 c, float thr, float knee ) {
  float l = max( max( c.r, c.g ), c.b );
  float soft = clamp( l - thr + knee, 0.0, 2.0 * knee );
  soft = soft * soft / ( 4.0 * knee + 1e-5 );
  return c * ( max( soft, l - thr ) / max( l, 1e-4 ) );
}

void main() {
  vec2 t = uTexel;
  // 13-tap "downsample" kernel: a 3x3 box at 2-texel spacing plus a 2x2 box at
  // 1-texel spacing. Sampling the source at half its Nyquist rate this way is
  // what keeps the pyramid stable under motion — a naive 2x2 box aliases and
  // the bloom crawls.
  vec3 a = fetch( vUv + vec2( -2.0 * t.x,  2.0 * t.y ) );
  vec3 b = fetch( vUv + vec2(  0.0,        2.0 * t.y ) );
  vec3 c = fetch( vUv + vec2(  2.0 * t.x,  2.0 * t.y ) );
  vec3 d = fetch( vUv + vec2( -2.0 * t.x,  0.0 ) );
  vec3 e = fetch( vUv );
  vec3 f = fetch( vUv + vec2(  2.0 * t.x,  0.0 ) );
  vec3 g = fetch( vUv + vec2( -2.0 * t.x, -2.0 * t.y ) );
  vec3 h = fetch( vUv + vec2(  0.0,       -2.0 * t.y ) );
  vec3 i = fetch( vUv + vec2(  2.0 * t.x, -2.0 * t.y ) );
  vec3 j = fetch( vUv + vec2( -t.x,  t.y ) );
  vec3 k = fetch( vUv + vec2(  t.x,  t.y ) );
  vec3 l = fetch( vUv + vec2( -t.x, -t.y ) );
  vec3 m = fetch( vUv + vec2(  t.x, -t.y ) );

  vec3 result;
  if ( uParams.x > 0.5 ) {
    float ex = uParams.w;
    a *= ex; b *= ex; c *= ex; d *= ex; e *= ex; f *= ex; g *= ex;
    h *= ex; i *= ex; j *= ex; k *= ex; l *= ex; m *= ex;
    float thr = uParams.y;
    float knee = max( uParams.z, 1e-4 );
    a = prefilter( a, thr, knee ); b = prefilter( b, thr, knee );
    c = prefilter( c, thr, knee ); d = prefilter( d, thr, knee );
    e = prefilter( e, thr, knee ); f = prefilter( f, thr, knee );
    g = prefilter( g, thr, knee ); h = prefilter( h, thr, knee );
    i = prefilter( i, thr, knee ); j = prefilter( j, thr, knee );
    k = prefilter( k, thr, knee ); l = prefilter( l, thr, knee );
    m = prefilter( m, thr, knee );
    // Karis weighting is applied to the five 2x2 groups, not to the 13 taps
    // individually — that is the form the CoD paper uses and it keeps the
    // kernel's frequency response intact.
    vec3 g0 = ( a + b + d + e ) * 0.25;
    vec3 g1 = ( b + c + e + f ) * 0.25;
    vec3 g2 = ( d + e + g + h ) * 0.25;
    vec3 g3 = ( e + f + h + i ) * 0.25;
    vec3 g4 = ( j + k + l + m ) * 0.25;
    float w0 = karisWeight( g0 ) * 0.125;
    float w1 = karisWeight( g1 ) * 0.125;
    float w2 = karisWeight( g2 ) * 0.125;
    float w3 = karisWeight( g3 ) * 0.125;
    float w4 = karisWeight( g4 ) * 0.5;
    result = ( g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4 ) /
             max( w0 + w1 + w2 + w3 + w4, 1e-5 );
    // Firefly clamp, in exposure-scaled units: 24 is ~4.6 stops over display
    // white, which is as much overshoot as the widest mip can spread before it
    // stops reading as glare around an object and starts reading as fog over
    // the frame. The sun disc (skSunDisc returns four decades over white) and a
    // point-blank muzzle flash both land far above this.
    result = min( result, vec3( 24.0 ) );
  } else {
    // Plain 13-tap weighted downsample for every level after the first: the
    // threshold has already been applied, applying it again would eat the tail.
    result = e * 0.125;
    result += ( a + c + g + i ) * 0.03125;
    result += ( b + d + f + h ) * 0.0625;
    result += ( j + k + l + m ) * 0.125;
  }
  gl_FragColor = vec4( result, 1.0 );
}
`;

const UPSAMPLE = /* glsl */ `
precision highp float;
uniform sampler2D tSrc;
uniform vec2 uTexel;   // texel size of the SOURCE (the smaller mip)
uniform float uRadius;
uniform float uWeight;
varying vec2 vUv;

void main() {
  vec2 t = uTexel * uRadius;
  vec3 a = texture2D( tSrc, vUv + vec2( -t.x,  t.y ) ).rgb;
  vec3 b = texture2D( tSrc, vUv + vec2(  0.0,  t.y ) ).rgb;
  vec3 c = texture2D( tSrc, vUv + vec2(  t.x,  t.y ) ).rgb;
  vec3 d = texture2D( tSrc, vUv + vec2( -t.x,  0.0 ) ).rgb;
  vec3 e = texture2D( tSrc, vUv ).rgb;
  vec3 f = texture2D( tSrc, vUv + vec2(  t.x,  0.0 ) ).rgb;
  vec3 g = texture2D( tSrc, vUv + vec2( -t.x, -t.y ) ).rgb;
  vec3 h = texture2D( tSrc, vUv + vec2(  0.0, -t.y ) ).rgb;
  vec3 i = texture2D( tSrc, vUv + vec2(  t.x, -t.y ) ).rgb;
  vec3 sum = e * 4.0 + ( b + d + f + h ) * 2.0 + ( a + c + g + i );
  // Alpha 0.5 with normal blending is lerp(dst, src, 0.5) — an energy
  // PRESERVING accumulation. Adding the mips outright, which is what most WebGL
  // bloom does, multiplies total energy by the number of levels and turns the
  // whole frame into haze.
  gl_FragColor = vec4( sum * 0.0625, uWeight );
}
`;

export class Bloom {
  constructor() {
    this.down = new Pass('ts-bloom-down', DOWNSAMPLE, {
      tSrc: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uParams: { value: new THREE.Vector4(0, 1.0, 0.55, 1) },
    });
    this.up = new Pass('ts-bloom-up', UPSAMPLE, {
      tSrc: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uRadius: { value: 1.0 },
      uWeight: { value: 0.5 },
    }, { blending: THREE.NormalBlending });
    this.up.material.premultipliedAlpha = false;

    /**
     * Threshold and knee, in EXPOSURE-SCALED linear light — the prefilter applies
     * exposure before it thresholds, so these hold at every hour of the day even
     * though `syncExposure` drives `toneMappingExposure` over 0.35..4.0.
     *
     * Where 1.0 actually sits. Evaluating this chain's own tone curve
     * (composite.js: `linearToSRGB( ACESFilmic( x / 0.6 ) )`, three's fit
     * verbatim) gives the response in output code values:
     *
     *   linear   0.40   0.53   1.00   1.60   2.00   4.00   10.0   24.0
     *   sRGB    183.8  200.0  226.4  238.1  242.0  249.6  254.0  255.0
     *
     * So 1.0 is NOT display white — the curve still has 29 code values of
     * gradation above it and does not actually clip until about 24, which is
     * where the prefilter's firefly clamp sits. The threshold is a deliberate
     * style choice: glare starts at 226/255, on things that read as bright before
     * they read as blown. An earlier version of this comment claimed 1.0 was
     * "what the tone curve could not have shown anyway", which the table above
     * disproves.
     *
     * What the number has to protect is the daylight sky, and that is measured
     * rather than assumed. Frostline (the highest-albedo map) pointed straight up
     * away from the sun, at its metered exposure of 0.978: the frame's 99.9th
     * percentile is 200.0 code values, i.e. **0.53 exposure-scaled linear**, and
     * the bloom pyramid's level 0 comes back with a maximum of 0.0136 and a mean
     * of 0.00018 — empty. Chain versus direct-to-canvas over that whole sky
     * differs by at most 0.3 code values. Dustyard's sky measures the same.
     *
     * The knee (0.55) puts the soft foot at 0.45, which is 0.08 BELOW that sky
     * peak, so the sky does sit just inside the ramp: soft^2/(4*knee) = 0.0029,
     * i.e. it contributes 0.55% of its own radiance, which is the 0.3 code values
     * above. Deliberately left there rather than tightened, because the cost is
     * unmeasurable in the frame and a narrower knee makes highlights pop on.
     *
     * HEADROOM, for whoever tunes the lighting: the sky's RAW peak radiance is
     * 0.542, so it crosses the threshold outright once the metered exposure
     * exceeds 1/0.542 = **1.85**. Today's daylight maps meter at 0.95-0.98, which
     * is 0.9 stops of margin, but EXPOSURE_MAX in src/gfx/sky/index.js is 4.0 and
     * Neon Foundry already meters at 2.0. A daylight map that ever metered above
     * 1.85 would start seeding the pyramid with flat sky, and the symptom is the
     * whole frame hazing rather than anything localised.
     */
    this.threshold = 1.0;
    this.knee = 0.55;

    this.mips = [];
    this.texture = null;
  }

  /**
   * `w`/`h` are the FULL-resolution drawing buffer dimensions; level 0 is half
   * of that. Levels are derived from the short edge so a small window does not
   * get a 4-pixel-wide top mip (whose tent filter would smear the whole frame):
   * stop at 6, which at 1080p makes the widest mip 30px tall — a glare radius
   * of about 1/32 of the screen, matching what a real lens does around the sun.
   */
  setSize(w, h) {
    this.dispose(true);
    const levels = THREE.MathUtils.clamp(Math.floor(Math.log2(Math.min(w, h))) - 4, 3, 6);
    let mw = w;
    let mh = h;
    for (let i = 0; i < levels; i++) {
      mw = Math.max(1, Math.floor(mw / 2));
      mh = Math.max(1, Math.floor(mh / 2));
      this.mips.push({ rt: hdrTarget(mw, mh, { name: `ts-bloom${i}` }), w: mw, h: mh });
      if (mw <= 2 || mh <= 2) break;
    }
  }

  /** Returns the level-0 texture: half-res, thresholded, exposure-scaled glare. */
  render(renderer, sourceTexture, sourceW, sourceH, exposure) {
    const n = this.mips.length;
    if (n === 0) return null;

    // The upsample BLENDS onto the mip the downsample just wrote — that read of
    // the destination IS the algorithm. three clears the bound target at the
    // top of every `render()` when `autoClear` is on, which would leave each
    // level blending against black and collapse the pyramid to its coarsest
    // mip. The downsamples cover their target completely with blending off, so
    // they lose nothing by skipping the clear either.
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;

    const du = this.down.uniforms;
    for (let i = 0; i < n; i++) {
      const src = i === 0 ? sourceTexture : this.mips[i - 1].rt.texture;
      const sw = i === 0 ? sourceW : this.mips[i - 1].w;
      const sh = i === 0 ? sourceH : this.mips[i - 1].h;
      du.tSrc.value = src;
      du.uTexel.value.set(1 / sw, 1 / sh);
      du.uParams.value.set(i === 0 ? 1 : 0, this.threshold, this.knee, exposure);
      this.down.render(renderer, this.mips[i].rt);
    }

    const uu = this.up.uniforms;
    for (let i = n - 1; i > 0; i--) {
      uu.tSrc.value = this.mips[i].rt.texture;
      uu.uTexel.value.set(1 / this.mips[i].w, 1 / this.mips[i].h);
      // The coarsest mips are the ones that reach tens of pixels across a
      // silhouette, and that reach is what dissolves a roofline against a bright
      // sky. Tighten the tent and drop the blend weight on the widest two
      // levels: the low-frequency component of the glare survives, its radius
      // does not.
      //
      // What that costs, measured. The upsample is a 50% lerp, so level k's share
      // of the final level 0 is a product of the weights above it: 0.5^k for the
      // fine levels, and 0.34^2 * 0.5^3 = 0.0145 for the widest instead of
      // 0.5^5 = 0.031. Annular mean of (chain - direct) about a 3 px neon bar on
      // Neon Foundry at 2560x1440, in code values:
      //
      //   r <= 1     2     4     8    16    32
      //     54.1  22.0   8.3   1.0  0.24  0.09
      //
      // i.e. the halo around a THIN source is gone by ~8 px, well inside the
      // ~1/32-of-screen reach a real lens has. Deliberately not loosened: for a
      // source with real area the reach is fine — the same chain on Frostline
      // moves 1.92% of the whole frame by more than a code value, with a peak
      // gain of +121.6 (93.5 -> 215.0) — and the failure mode of widening it is a
      // roofline that dissolves into the sky, which is worse than a tight halo on
      // a 12 cm strip. The strip's own core still goes 128.0 -> 254.8, which is
      // what makes it read as a light source rather than a pale pink rectangle.
      const wide = i >= n - 2;
      uu.uRadius.value = wide ? 0.62 : 1.0;
      uu.uWeight.value = wide ? 0.34 : 0.5;
      this.up.render(renderer, this.mips[i - 1].rt);
    }

    renderer.autoClear = prevAutoClear;
    this.texture = this.mips[0].rt.texture;
    return this.texture;
  }

  dispose(targetsOnly = false) {
    for (const m of this.mips) m.rt.dispose();
    this.mips.length = 0;
    this.texture = null;
    if (targetsOnly) return;
    this.down.dispose();
    this.up.dispose();
  }
}
