import * as THREE from 'three';
import { Pass } from './pass.js';

/**
 * Half-resolution, depth-only screen-space ambient occlusion.
 *
 * WHY THIS EXISTS
 *
 * Before this pass the only occlusion in the level was per-texel: `owORM.r`
 * (the baked cavity map) and the dressing's vertex masks. Both are tile-scale,
 * so nothing darkened where a wall met the sand, inside a window reveal, under
 * an awning or between two stacked crates — every object in the frame met the
 * ground on a razor line. That is the single most repeated note from the
 * reference comparison.
 *
 * WHERE IT IS APPLIED, AND WHY THAT MATTERS
 *
 * The term is multiplied into `reflectedLight.indirectDiffuse` inside the
 * material shader (src/gfx/materials/shader.js, the `aomap_fragment` override),
 * NOT over the composited image. Ambient occlusion is a visibility factor on
 * the *ambient* integral; multiplying the final frame by it would darken direct
 * sunlight, which no amount of occlusion geometry can do — a crate foot in full
 * sun has a sharp cast shadow, not a soft grey smudge. The injection point in
 * shader.js already existed and was already indirect-only, which is the
 * physically right place, so this pass only has to deliver a screen-space
 * visibility term to it.
 *
 * The GLSL that consumes it lives HERE (`SSAO_PARS_FRAGMENT` / `SSAO_APPLY`)
 * rather than in shader.js so the whole estimator — the buffer layout, the
 * depth guard and the calibration constants — stays in one file with the pass
 * that produces it. shader.js only has to interpolate two strings and merge one
 * uniform block; see scratchpad/ssao-shader-patch.md.
 *
 * ORDER OF OPERATIONS
 *
 *   depth prepass (half res, MeshDepthMaterial override)   ~0.30 ms
 *     -> AO estimate  (half res, 10 taps)                  ~0.20 ms
 *     -> bilateral blur H then V (half res, 5 taps each)    ~0.10 ms
 *     -> beauty pass reads it by gl_FragCoord
 *
 * The prepass runs BEFORE the beauty pass, which is what lets the material
 * shader read a same-frame AO buffer. The alternative — reusing the beauty
 * pass's own depth and applying the result one frame later — is cheaper by a
 * whole geometry submit but needs reprojection to survive a fast turn, and a
 * 500 deg/s flick at 60 fps moves a pixel 178 px at this FOV. Measured, the
 * prepass costs 0.30 ms on the heaviest map, which is worth paying to keep the
 * term registered to the frame it belongs to.
 */

/**
 * Uniform block SHARED by every extended material. The objects are created once
 * and handed out by reference, so writing `.value` here updates every shader in
 * the scene without touching a single material.
 *
 *   owSsaoTex  half-res AO buffer: .r = visibility 0..1, .g = log depth guard
 *   owSsaoP    x,y = 1 / drawing buffer size   (gl_FragCoord -> uv)
 *              z   = master amount; 0 disables the whole term at zero cost
 *              w   = unused
 *   owSsaoD    log-depth pack: x = 1/log2(far/near), y = -log2(near) * x
 */
export const ssaoUniforms = {
  owSsaoTex: { value: null },
  owSsaoP: { value: new THREE.Vector4(0, 0, 0, 0) },
  owSsaoD: { value: new THREE.Vector2(1, 0) },
};

let _consumers = 0;

/**
 * Called once at module scope by whoever wires `ssaoUniforms` into a material.
 *
 * The handshake exists so this pass costs nothing when the material-side patch
 * is not applied: `PostChain` skips building the targets and running the passes
 * unless something has declared that it will actually read the buffer. Without
 * it, a half-applied change would burn 0.6 ms per frame producing a texture
 * nobody samples.
 */
export function registerSsaoConsumer() {
  _consumers++;
}

/** True when a material shader is wired up to read `owSsaoTex`. */
export function ssaoConsumed() {
  return _consumers > 0;
}

/**
 * Declarations for the material fragment shader. Interpolate into
 * shader.js's PARS_FRAGMENT.
 *
 * THE DEPTH GUARD
 *
 * A half-res buffer sampled bilinearly at full res leaks across silhouettes,
 * and the first-person weapon — 0.2 to 0.6 m from the eye and the largest thing
 * on screen — would otherwise be shaded with occlusion computed from the wall
 * eight metres behind it. So the AO buffer carries its own depth in .g and the
 * term is faded out where that depth disagrees with the fragment's.
 *
 * The depth is stored as log2 over the near..far range rather than linearly:
 * 8 bits over log2(400 / 0.05) = 12.97 octaves is 3.6% relative depth per code
 * value at every distance, where a linear 8-bit encoding would quantise to
 * 1.6 m and be useless for anything closer than the far plane. Log depth also
 * interpolates sanely — a bilinear blend of two log depths is their geometric
 * mean — which matters because this texture is filtered.
 *
 * The 0.02..0.06 rejection window is 20%..71% relative depth (2^(d/k), k =
 * 1/12.97). That is deliberately loose: it has to accept a floor seen at a
 * grazing angle, where two adjacent half-res texels legitimately differ by
 * several per cent, while still rejecting the weapon against the world (26x,
 * fully rejected) and a foreground prop against a distant wall.
 */
export const SSAO_PARS_FRAGMENT = /* glsl */ `
uniform sampler2D owSsaoTex;
uniform vec4  owSsaoP;
uniform vec2  owSsaoD;

float owScreenAO() {
  // One branch on a uniform. It is coherent across every fragment of every draw
  // in the frame, so on 'low' (no post chain), on a machine with no float render
  // targets, or with ?ssao=off, the fetch below is never issued and the whole
  // feature costs one scalar compare.
  if ( owSsaoP.z <= 0.0 ) return 1.0;
  vec2 s = texture2D( owSsaoTex, gl_FragCoord.xy * owSsaoP.xy ).rg;
  // vViewPosition = -mvPosition.xyz, so .z is the positive view depth.
  float mine = log2( max( vViewPosition.z, 1e-4 ) ) * owSsaoD.x + owSsaoD.y;
  float trust = 1.0 - smoothstep( 0.02, 0.06, abs( s.g - mine ) );
  return mix( 1.0, s.r, owSsaoP.z * trust );
}
`;

/**
 * The one line to insert in shader.js's `aomap_fragment` override, immediately
 * after `ambientOcclusion` is computed from the cavity map.
 *
 * It multiplies the SAME variable, so everything downstream — clearcoat and
 * sheen indirect, and `computeSpecularOcclusion` for the environment specular —
 * picks the screen-space term up for free, which is how a GTAO term is meant to
 * be plumbed.
 */
export const SSAO_APPLY = /* glsl */ `
      ambientOcclusion *= owScreenAO();`;

/**
 * AO estimator: the Alchemy obscurance of McGuire et al. 2011, over a
 * golden-angle spiral of taps whose phase is rotated per pixel.
 *
 *   A = 1 - (2 * sigma * r / N) * SUM  max( 0, v.n - bias * z ) / ( v.v + eps )
 *
 * Chosen over the Crytek-style "count the occluded samples" test because it is
 * a continuous function of the sample geometry, so 10 taps are enough to get a
 * usable estimate out of a blur instead of the 24+ a binary test needs.
 *
 * The `1 - v.v/r^2` factor makes it RANGE LIMITED, which is what makes the pass
 * safe to run off a prepass that is not perfectly clean. A sample more than
 * `radius` away in world space contributes exactly nothing, so a tracer three
 * metres in front of a wall, or the weapon in front of the level, cannot cast a
 * dark halo onto it — the geometry that would do so is already outside the
 * kernel. It is also what keeps this an occlusion term and not a distance
 * shader.
 */
const AO = /* glsl */ `
precision highp float;
uniform sampler2D tDepth;
uniform vec4 uProj;     // x = 1/P00, y = 1/P11, z = near, w = far
uniform vec4 uParams;   // x radius (m), y intensity, z bias, w max screen radius (v units)
uniform vec2 uTexel;    // 1 / half-res size
uniform vec2 uPack;     // log-depth pack, same k/c as owSsaoD
varying vec2 vUv;

const int TAPS = 10;

/** Window depth 0..1 -> positive view-space distance. three's perspectiveDepthToViewZ, negated. */
float vDepth( vec2 uv ) {
  float d = texture2D( tDepth, uv ).x;
  return ( uProj.z * uProj.w ) / ( uProj.w - ( uProj.w - uProj.z ) * d );
}

/** View-space position of a screen point at view depth z. */
vec3 vPos( vec2 uv, float z ) {
  vec2 ndc = uv * 2.0 - 1.0;
  return vec3( ndc.x * uProj.x * z, ndc.y * uProj.y * z, -z );
}

/**
 * Interleaved gradient noise (Jimenez 2014). A per-pixel rotation whose spectrum
 * is high frequency and, unlike a hash, spatially structured — which is exactly
 * what the bilateral blur below is good at removing. A plain hash leaves
 * low-frequency clumps that survive a 5-tap blur and read as blotches.
 */
float ign( vec2 p ) {
  return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) );
}

void main() {
  float z = vDepth( vUv );
  // Nothing was drawn here (cleared depth = far): the sky. Return full
  // visibility and the far-plane depth so the guard rejects it anyway.
  if ( z >= uProj.w * 0.999 ) {
    gl_FragColor = vec4( 1.0, 1.0, 0.0, 1.0 );
    return;
  }
  vec3 P = vPos( vUv, z );

  /**
   * Normal from depth, four taps, nearest of each pair.
   *
   * cross( dFdx, dFdy ) of the reconstructed position is one instruction and
   * completely wrong at a silhouette, where the 2x2 quad straddles two surfaces
   * and the derivative describes a sliver joining them. Since AO exists to
   * darken contacts, and a contact IS a depth discontinuity, that error lands
   * precisely where the pass has to be right. Picking the nearer neighbour on
   * each axis keeps the plane fit on the surface the centre pixel belongs to.
   */
  float zl = vDepth( vUv - vec2( uTexel.x, 0.0 ) );
  float zr = vDepth( vUv + vec2( uTexel.x, 0.0 ) );
  float zd = vDepth( vUv - vec2( 0.0, uTexel.y ) );
  float zu = vDepth( vUv + vec2( 0.0, uTexel.y ) );
  vec3 dX = abs( zr - z ) < abs( zl - z )
    ? vPos( vUv + vec2( uTexel.x, 0.0 ), zr ) - P
    : P - vPos( vUv - vec2( uTexel.x, 0.0 ), zl );
  vec3 dY = abs( zu - z ) < abs( zd - z )
    ? vPos( vUv + vec2( 0.0, uTexel.y ), zu ) - P
    : P - vPos( vUv - vec2( 0.0, uTexel.y ), zd );
  vec3 N = normalize( cross( dX, dY ) );

  // World radius projected to screen. P11 already carries the aspect ratio, so
  // a world-space circle is a circle in PIXELS; in uv the u extent is the v
  // extent over the aspect, which is uTexel.x / uTexel.y.
  float rv = min( 0.5 * uParams.x / ( uProj.y * z ), uParams.w );
  vec2 rUv = vec2( rv * uTexel.x / uTexel.y, rv );
  // Under ~1.5 half-res texels the taps all land in the centre texel and the
  // estimate is pure noise. Far geometry gets no AO rather than a shimmer.
  if ( rv < 1.5 * uTexel.y ) {
    gl_FragColor = vec4( 1.0, log2( max( z, 1e-4 ) ) * uPack.x + uPack.y, 0.0, 1.0 );
    return;
  }

  float phase = ign( gl_FragCoord.xy ) * 6.2831853;
  float r2 = uParams.x * uParams.x;
  float sum = 0.0;
  for ( int i = 0; i < TAPS; i ++ ) {
    float fi = float( i ) + 0.5;
    // sqrt for an area-uniform disc; the golden angle (2.399963 rad) keeps
    // successive taps maximally spread instead of forming spokes.
    float a = fi * 2.39996323 + phase;
    vec2 off = vec2( cos( a ), sin( a ) ) * sqrt( fi / float( TAPS ) );
    vec2 suv = vUv + off * rUv;
    float sz = vDepth( suv );
    vec3 v = vPos( suv, sz ) - P;
    float vv = dot( v, v );
    // Bias scaled by depth: the reconstructed normal and the depth buffer are
    // both least accurate far away, and a constant bias that works at 2 m
    // produces a grey wash at 40 m.
    float occ = max( dot( v, N ) - uParams.z * z, 0.0 );
    sum += clamp( 1.0 - vv / r2, 0.0, 1.0 ) * occ / ( vv + 1e-4 );
  }
  // v.n / v.v carries 1/length, so the radius has to come back in for the
  // estimator to be scale invariant — otherwise widening the kernel darkens the
  // frame instead of just reaching further.
  float ao = clamp( 1.0 - sum * ( 2.0 * uParams.y * uParams.x / float( TAPS ) ), 0.0, 1.0 );
  gl_FragColor = vec4( ao, log2( max( z, 1e-4 ) ) * uPack.x + uPack.y, 0.0, 1.0 );
}
`;

/**
 * Separable depth-aware blur. Five taps at 1-texel spacing, run once per axis.
 *
 * Separable rather than a single 5x5 cross: two 5-tap passes cover 25 texels
 * for 10 fetches. The depth weight comes from the AO buffer's OWN .g channel,
 * so the blur never touches the depth texture — one sampler, one fetch per tap.
 *
 * exp2( -64 * |dlog| ): a 20% depth step (dlog 0.02) weighs 0.41, a 70% step
 * (0.06) weighs 0.02. Wide enough to smooth a sloped floor, tight enough not to
 * drag a crate's occlusion out over the sand behind it.
 */
const BLUR = /* glsl */ `
precision highp float;
uniform sampler2D tAo;
uniform vec2 uStep;     // (texel, 0) or (0, texel)
varying vec2 vUv;

void main() {
  vec2 c = texture2D( tAo, vUv ).rg;
  float sum = c.r;
  float wsum = 1.0;
  for ( int i = 1; i <= 2; i ++ ) {
    vec2 o = uStep * float( i );
    vec2 a = texture2D( tAo, vUv + o ).rg;
    vec2 b = texture2D( tAo, vUv - o ).rg;
    float wa = exp2( -64.0 * abs( a.g - c.g ) );
    float wb = exp2( -64.0 * abs( b.g - c.g ) );
    sum += a.r * wa + b.r * wb;
    wsum += wa + wb;
  }
  // .g is carried through unchanged: the second pass and the material shader
  // both still need the depth guard.
  gl_FragColor = vec4( sum / wsum, c.g, 0.0, 1.0 );
}
`;

export class Ssao {
  /**
   * Calibration. Every number here was set by measuring the frame, not by eye —
   * see scratchpad/ssao-shader-patch.md for the readPixels numbers behind them.
   */
  constructor() {
    /**
     * 0.55 m. The occlusion this pass exists to add is contact-scale: a crate
     * foot on sand, the 0.3 m reveal of a window, the base of a wall, the gap
     * between two stacked containers. 0.55 m reaches all of them and stops
     * short of the 2 m+ range at which SSAO stops reading as contact and starts
     * reading as a dirty lens.
     */
    this.radius = 0.55;
    /**
     * 0.7, and this one is not a taste setting — it is calibrated against the
     * one geometry whose ground-truth ambient occlusion is known exactly.
     *
     * At the crease between two perpendicular planes the second plane blocks
     * exactly half of the first's hemisphere, and by symmetry the cosine-weighted
     * visibility there is exactly 0.5. Measured on the Dustyard wall/ground
     * junction at (5.98, 0, 20) from 2.5 m, reading the AO buffer's centre
     * column: the estimator is perfectly linear in this constant
     * (AO = 1 - intensity * 0.722 at every value tried), so
     *
     *   intensity 0.5 -> 0.639 at the crease
     *   intensity 0.7 -> 0.505   <- ground truth
     *   intensity 1.0 -> 0.278
     *   intensity 1.5 -> 0.047   (clipped: the estimator has lost its gradient)
     *
     * In the frame that is -22 code values at the junction, -4 at 0.4 m away,
     * 0 at 0.5 m, and -1.2 on the frame median — a contact term, not a wash.
     * 1.0 and above measurably crush: the same junction goes to 13/255 and then
     * to 1.7/255, on a map whose median is already 45.
     */
    this.intensity = 0.7;
    /**
     * Self-occlusion bias as a fraction of view depth. 0.02 = 2 cm per metre.
     * Sized off the normal-from-depth error rather than off depth precision:
     * a 24-bit buffer over near 0.05 / far 400 resolves 0.12 mm at 10 m, but a
     * plane fitted from two half-res neighbours on a curved or grazing surface
     * is out by far more than that.
     */
    this.bias = 0.02;
    /**
     * Screen-space radius ceiling, in units of screen HEIGHT. Without it the
     * weapon at 0.25 m would ask for a kernel 1.1 screens wide: 10 taps spread
     * over that are pure cache misses and describe nothing local. 0.08 caps the
     * gather at 115 px at 1440p.
     */
    this.maxScreenRadius = 0.08;
    /**
     * How much of the estimate reaches indirect diffuse. 1.0 means a fully
     * occluded pocket loses all of its ambient, which is what the reference
     * does — the term is already indirect-only, so it cannot flatten anything
     * the sun is lighting.
     */
    this.amount = 1.0;

    this.depthRt = null;
    this.aoRt = null;
    this.tmpRt = null;
    this.width = 0;
    this.height = 0;

    // Untextured, unlit, no colour write: the cheapest thing three can be asked
    // to rasterise, and it still inherits skinning, instancing and morph support
    // from three's own chunk set, which a hand-written ShaderMaterial override
    // would silently break on the bots and the dressing.
    this.depthMaterial = new THREE.MeshDepthMaterial();
    this.depthMaterial.colorWrite = false;

    this.ao = new Pass('ts-ssao', AO, {
      tDepth: { value: null },
      uProj: { value: new THREE.Vector4(1, 1, 0.05, 400) },
      // Overwritten from the fields above every frame; these are placeholders.
      uParams: { value: new THREE.Vector4(0.55, 0.7, 0.02, 0.08) },
      uTexel: { value: new THREE.Vector2() },
      uPack: { value: new THREE.Vector2(1, 0) },
    });
    this.blur = new Pass('ts-ssao-blur', BLUR, {
      tAo: { value: null },
      uStep: { value: new THREE.Vector2() },
    });
  }

  /** `w`/`h` are the FULL-resolution drawing buffer dimensions. */
  setSize(w, h) {
    const hw = Math.max(1, Math.floor(w / 2));
    const hh = Math.max(1, Math.floor(h / 2));
    if (hw === this.width && hh === this.height && this.aoRt) return;
    this.width = hw;
    this.height = hh;
    this._disposeTargets();

    // A depth TEXTURE, not a packed-into-RGBA8 depth: the estimator needs the
    // value at full precision to reconstruct view positions, and DEPTH_COMPONENT24
    // is core WebGL2, so there is nothing to fall back from. Nearest filtering
    // is not a choice — a depth texture is not linearly filterable.
    const depthTexture = new THREE.DepthTexture(hw, hh);
    depthTexture.type = THREE.UnsignedIntType;
    depthTexture.format = THREE.DepthFormat;
    depthTexture.minFilter = THREE.NearestFilter;
    depthTexture.magFilter = THREE.NearestFilter;
    depthTexture.name = 'ts-ssao-depth';

    // three always allocates a colour attachment; `colorWrite = false` on the
    // override material means nothing is ever written to it, so an 8-bit one is
    // the cheapest thing that keeps the framebuffer complete.
    this.depthRt = new THREE.WebGLRenderTarget(hw, hh, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
      depthTexture,
    });

    // RGBA8 rather than R8. The AO term is a visibility factor with a 3.6%
    // guard tolerance, so 256 levels is well past what it can use, and RGBA8 is
    // colour-renderable everywhere while R8 render targets are the kind of thing
    // a driver quirk turns into an incomplete framebuffer. The bandwidth
    // difference over the three passes that touch it is ~45 us at 1080p.
    const opts = {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    };
    this.aoRt = new THREE.WebGLRenderTarget(hw, hh, opts);
    this.tmpRt = new THREE.WebGLRenderTarget(hw, hh, opts);
    this.aoRt.texture.name = 'ts-ssao-ao';
    this.tmpRt.texture.name = 'ts-ssao-blur';

    this.ao.uniforms.uTexel.value.set(1 / hw, 1 / hh);
  }

  /**
   * Depth prepass + AO + blur. Leaves the result in `aoRt` and publishes it
   * through `ssaoUniforms`; the caller renders the beauty pass afterwards.
   *
   * `fullW`/`fullH` are the drawing buffer dimensions, which is the space
   * `gl_FragCoord` is in inside the beauty pass.
   */
  render(renderer, scene, camera, fullW, fullH, game) {
    if (!this.aoRt) return;

    const near = camera.near;
    const far = camera.far;
    const pm = camera.projectionMatrix.elements;
    // elements[0] = P00, elements[5] = P11 (column major).
    const k = 1 / Math.log2(far / near);
    const c = -Math.log2(near) * k;

    const au = this.ao.uniforms;
    au.uProj.value.set(1 / pm[0], 1 / pm[5], near, far);
    au.uParams.value.set(this.radius, this.intensity, this.bias, this.maxScreenRadius);
    au.uPack.value.set(k, c);

    // ---- depth prepass ----------------------------------------------------
    //
    // Two things are hidden for it, both because they are drawn with materials
    // whose vertex convention the override material does not share:
    //
    //  - The sky dome is a FULL-SCREEN TRIANGLE (src/gfx/sky/dome.js) whose
    //    vertices live in clip space and are never transformed. Put three's
    //    standard vertex shader on it and those coordinates get run through the
    //    model-view-projection chain, which lands a 4-unit triangle right on top
    //    of the camera and stamps near depth over most of the screen. Hiding it
    //    also keeps its onBeforeRender from refreshing the ray basis twice.
    //  - game.effects.root holds THREE.Points pools and Sprites. Both are drawn
    //    with three's own special-cased vertex shaders; under a mesh material
    //    they would rasterise as 1-pixel dots and small world-space quads at the
    //    wrong depth. They are additive glow with depthWrite off in the beauty
    //    pass and have no business occluding anything.
    const dome = game?.world?.sky?.dome?.mesh ?? null;
    const fx = game?.effects?.root ?? null;
    const domeVis = dome ? dome.visible : false;
    const fxVis = fx ? fx.visible : false;
    if (dome) dome.visible = false;
    if (fx) fx.visible = false;

    // renderer.render() re-renders the shadow map on every call, and this pass
    // does not read it. Suppressing it for the prepass and letting the beauty
    // pass rebuild it is what takes the prepass from 0.50 ms to 0.30 ms.
    const shadowAuto = renderer.shadowMap.autoUpdate;
    const prevAutoClear = renderer.autoClear;
    const prevOverride = scene.overrideMaterial;
    renderer.shadowMap.autoUpdate = false;
    renderer.autoClear = false;
    scene.overrideMaterial = this.depthMaterial;
    renderer.setRenderTarget(this.depthRt);
    // Depth only. The colour attachment is never written, so clearing it would
    // be a full-target write for nothing.
    renderer.clear(false, true, false);
    renderer.render(scene, camera);
    scene.overrideMaterial = prevOverride;
    renderer.shadowMap.autoUpdate = shadowAuto;
    renderer.autoClear = prevAutoClear;
    if (dome) dome.visible = domeVis;
    if (fx) fx.visible = fxVis;

    // ---- estimate, then blur along each axis ------------------------------
    au.tDepth.value = this.depthRt.depthTexture;
    this.ao.render(renderer, this.aoRt);

    const bu = this.blur.uniforms;
    bu.tAo.value = this.aoRt.texture;
    bu.uStep.value.set(1 / this.width, 0);
    this.blur.render(renderer, this.tmpRt);
    bu.tAo.value = this.tmpRt.texture;
    bu.uStep.value.set(0, 1 / this.height);
    this.blur.render(renderer, this.aoRt);

    ssaoUniforms.owSsaoTex.value = this.aoRt.texture;
    ssaoUniforms.owSsaoP.value.set(1 / fullW, 1 / fullH, this.amount, 0);
    ssaoUniforms.owSsaoD.value.set(k, c);
  }

  /** Hand the materials a term that changes nothing, without unbinding the sampler. */
  disable() {
    ssaoUniforms.owSsaoP.value.z = 0;
  }

  _disposeTargets() {
    this.depthRt?.depthTexture?.dispose();
    this.depthRt?.dispose();
    this.aoRt?.dispose();
    this.tmpRt?.dispose();
    this.depthRt = null;
    this.aoRt = null;
    this.tmpRt = null;
  }

  dispose() {
    this.disable();
    if (ssaoUniforms.owSsaoTex.value === this.aoRt?.texture) ssaoUniforms.owSsaoTex.value = null;
    this._disposeTargets();
    this.depthMaterial.dispose();
    this.ao.dispose();
    this.blur.dispose();
  }
}
