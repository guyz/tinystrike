import * as THREE from 'three';

/**
 * Full-screen pass infrastructure for the HDR post chain.
 *
 * Deliberately not `three/addons/postprocessing/EffectComposer`: the Pages
 * build (tools/build-pages.mjs) vendors exactly four addon files and skips any
 * `three/addons/` specifier when it walks the import graph, so an
 * EffectComposer import resolves in dev against node_modules and 404s in
 * production. Everything here is built on the `three` core entry point only.
 *
 * One full-screen TRIANGLE, not a quad. A quad is two triangles that meet on
 * the diagonal, and GPUs shade in 2x2 quads, so every pixel along that seam is
 * shaded twice; one oversized triangle clipped to the viewport has no seam and
 * no double-shaded diagonal. The geometry, scene, camera and mesh are module
 * singletons — a pass is just a material we swap onto the same mesh, so the
 * whole chain allocates nothing per frame.
 */

const _geometry = new THREE.BufferGeometry();
// Vertices at (-1,-1), (3,-1), (-1,3): a triangle twice the size of the NDC
// box, so the visible region is exactly the screen with no seam across it.
_geometry.setAttribute(
  'position',
  new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3)
);
_geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
// The triangle is built in clip space and never transformed, so a real bounding
// sphere would cull it. An enormous one keeps it permanently visible.
_geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e8);

const _scene = new THREE.Scene();
_scene.matrixAutoUpdate = false;
const _camera = new THREE.Camera();
const _mesh = new THREE.Mesh(_geometry, null);
_mesh.frustumCulled = false;
_mesh.matrixAutoUpdate = false;
_scene.add(_mesh);

export const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

/** Rec.709 luma. Shared by the bloom prefilter and the FXAA edge test. */
export const LUMA_GLSL = /* glsl */ `
float pfLum( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }
`;

/** Draw `material` over `target` (null = canvas). */
export function blit(renderer, material, target) {
  _mesh.material = material;
  renderer.setRenderTarget(target);
  renderer.render(_scene, _camera);
}

/** A post pass: a ShaderMaterial plus the uniforms it owns. */
export class Pass {
  constructor(name, fragmentShader, uniforms, opts = {}) {
    this.name = name;
    this.uniforms = uniforms;
    this.material = new THREE.ShaderMaterial({
      name,
      uniforms,
      vertexShader: FS_VERT,
      fragmentShader,
      // Nothing in the chain reads or writes depth, and leaving the test on
      // would need a cleared depth buffer on every intermediate target.
      depthTest: false,
      depthWrite: false,
      blending: opts.blending ?? THREE.NoBlending,
      transparent: opts.blending !== undefined && opts.blending !== THREE.NoBlending,
    });
    // three only injects its tone-map and output-encode chunks into its own
    // materials, never into a ShaderMaterial, so these passes write exactly the
    // values they compute. That is what lets the composite own the tone curve.
    this.material.toneMapped = false;
  }

  render(renderer, target) {
    blit(renderer, this.material, target);
  }

  dispose() {
    this.material.dispose();
  }
}

/**
 * Half-float colour target.
 *
 * RGBA16F, not RGBA8: the whole point of the chain is that the sun disc, a
 * muzzle flash and a specular glint arrive at the tone curve with their real
 * radiance instead of having been clipped to 1.0 at write time. Half float
 * carries ~5 decades, which covers everything the sky system produces.
 *
 * No depth or stencil by default — only the scene target needs them, and a
 * depth renderbuffer on each of the six bloom mips would be pure bandwidth.
 */
export function hdrTarget(w, h, opts = {}) {
  const rt = new THREE.WebGLRenderTarget(Math.max(1, Math.floor(w)), Math.max(1, Math.floor(h)), {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    ...opts,
  });
  rt.texture.name = opts.name ?? 'hdr';
  return rt;
}
