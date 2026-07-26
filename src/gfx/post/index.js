import * as THREE from 'three';
import { hdrTarget } from './pass.js';
import { Bloom } from './bloom.js';
import { createComposite, createFxaa } from './composite.js';
import { Ssao, ssaoConsumed, ssaoUniforms } from './ssao.js';

/**
 * The HDR post chain.
 *
 *   ssao  -> half-res depth prepass + AO   (read by the beauty pass, not by us)
 *   scene -> RGBA16F target        (raw linear radiance, nothing clipped)
 *         -> bloom pyramid          (5-6 levels, half res and down)
 *         -> composite              (exposure + bloom, ACES, sRGB, dither)
 *         -> FXAA                   (on the encoded image)
 *         -> canvas
 *
 * WHY THE SKY DOME IS SPECIAL-CASED
 *
 * three injects its tone-mapping and output-encode chunks into its own
 * materials only, and it skips tone mapping entirely whenever a render target
 * is bound (WebGLRenderer only reads `renderer.toneMapping` when
 * `_currentRenderTarget === null`). So the instant the scene renders into the
 * HDR target, every standard material starts writing raw linear radiance for
 * free — which is exactly what we want.
 *
 * The sky dome is a ShaderMaterial and therefore never got those chunks; it
 * carries its own copy of three's ACES curve and applies it when
 * `uOutputExposure > 0`, because the game used to render straight to an 8-bit
 * canvas where an untone-mapped sky would have clipped to white above the knee.
 * With the chain active that copy would tone map the sky a second time. Zeroing
 * `uOutputExposure` switches it off and the dome writes radiance like
 * everything else.
 *
 * It is zeroed for the duration of the scene render and RESTORED immediately
 * after, rather than being set once at startup, for two reasons: SkySystem's
 * autoexposure rewrites the uniform every frame in `syncExposure`, so a
 * one-time set would not survive; and tools/trailer.js installs its own frame
 * loop that renders direct to the canvas without this chain, where the dome
 * must still tone map itself. Leaving the uniform correct outside our own
 * render is what keeps that path working untouched.
 */

const _size = new THREE.Vector2();

export class PostChain {
  /**
   * Half-float colour targets are not core WebGL2 — RGBA16F only becomes
   * colour-renderable with EXT_color_buffer_float (or the half-float variant).
   * Practically every desktop GPU has it, but a machine without it must fall
   * back to the direct path rather than render into a target that fails to
   * validate.
   */
  static supported(renderer) {
    const ext = renderer.extensions;
    return ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float');
  }

  /**
   * Multisampling an RGBA16F target is legal in WebGL2 with EXT_color_buffer_float,
   * but "legal" and "the driver actually completes the framebuffer" are not the
   * same claim, and getting it wrong is a black screen rather than a soft
   * failure. Probe a 4x4 target and ask the driver directly.
   */
  static _canMultisampleHdr(renderer) {
    if ((renderer.capabilities.maxSamples ?? 0) < 4) return false;
    const gl = renderer.getContext();
    const probe = hdrTarget(4, 4, { depthBuffer: true, samples: 4, name: 'ts-msaa-probe' });
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(probe);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    renderer.setRenderTarget(prev);
    probe.dispose();
    return ok;
  }

  /**
   * `aa` is one of:
   *   'auto'  4x MSAA when the driver can multisample RGBA16F, else FXAA
   *   'msaa'  4x multisampling on the HDR target, composite straight to canvas
   *   'fxaa'  composite to an 8-bit target, then a post-tone-curve edge filter
   *   'none'  neither
   *
   * MSAA is preferred, measured at 1920x1080 on an M1 Pro with `profile()`:
   * the MSAA chain costs 0.68 ms more than the FXAA chain (9.29 vs 8.61 ms
   * total frame) and 0.32 ms more than the direct-to-canvas pipeline it
   * replaces — both far inside budget — and it is the only one of the two that
   * keeps sub-pixel geometry. This game is full of exactly that: railings,
   * cables, and the neon strips on Neon Foundry, where dropping to FXAA moved
   * individual pixels by up to 225 code values because a line thinner than a
   * pixel is either hit or missed entirely, and no post-resolve edge filter can
   * reconstruct what was never sampled.
   *
   * FXAA's one structural advantage is that it filters AFTER the tone curve, so
   * it catches the extreme-contrast edges an MSAA resolve cannot: the resolve
   * averages subsamples in LINEAR light, so a roofline against the sun averages
   * to a value the ACES shoulder still maps to white. That is a narrower class
   * of edge than "every thin object in the level", which is why it is the
   * fallback and not the default.
   */
  constructor(game, { aa = 'auto', ssao = true } = {}) {
    this.game = game;
    this.renderer = game.renderer;
    if (aa === 'auto') aa = PostChain._canMultisampleHdr(this.renderer) ? 'msaa' : 'fxaa';
    this.aa = aa;
    this.width = 0;
    this.height = 0;

    // 4x is the point of diminishing returns for MSAA on geometry edges, and on
    // an RGBA16F target every extra sample is 8 more bytes per pixel to resolve.
    this.samples = aa === 'msaa' ? Math.min(4, this.renderer.capabilities.maxSamples ?? 0) : 0;

    this.sceneRt = null;
    this.ldrRt = null;
    this.bloom = new Bloom();
    this.composite = createComposite();
    this.fxaa = aa === 'fxaa' ? createFxaa() : null;

    /**
     * Screen-space AO, but only if something will actually read it.
     *
     * The term is consumed inside the material shader, not composited here, so
     * this pass is useless on its own — see src/gfx/post/ssao.js. `ssaoConsumed()`
     * is the handshake: src/gfx/materials/shader.js calls
     * `registerSsaoConsumer()` at module scope when it merges the uniform block,
     * and that import chain (main.js -> materials/index.js -> shader.js) is
     * evaluated before this constructor runs. If the material side is not wired
     * up the targets are never allocated and no pass runs, rather than spending
     * 0.6 ms a frame filling a buffer nobody samples.
     */
    this.ssao = ssao !== false && ssaoConsumed() ? new Ssao() : null;
    if (!this.ssao) ssaoUniforms.owSsaoP.value.z = 0;

    // Tuning lives here, not in the uniform, and is written into the uniform
    // every frame. Keeping the uniform purely derived means nothing can leave
    // it in a state the chain never recovers from.
    this.bloomStrength = this.composite.uniforms.uParams.value.y;
    this.dither = this.composite.uniforms.uParams.value.z;

    this.setSize();
  }

  setSize() {
    const renderer = this.renderer;
    renderer.getDrawingBufferSize(_size);
    const w = Math.max(1, _size.x);
    const h = Math.max(1, _size.y);
    if (w === this.width && h === this.height && this.sceneRt) return;
    this.width = w;
    this.height = h;

    this.sceneRt?.dispose();
    this.ldrRt?.dispose();

    this.sceneRt = hdrTarget(w, h, {
      name: 'ts-scene-hdr',
      // The one target in the chain that geometry is drawn into, so it is the
      // one that needs depth. No stencil: nothing in the game masks.
      depthBuffer: true,
      stencilBuffer: false,
      samples: this.samples,
    });

    // 8-bit is correct here, not a waste: the composite has already tone mapped
    // and encoded, so this target holds display-referred values and FXAA wants
    // to read exactly those.
    this.ldrRt = this.fxaa
      ? new THREE.WebGLRenderTarget(w, h, {
          type: THREE.UnsignedByteType,
          format: THREE.RGBAFormat,
          minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter,
          depthBuffer: false,
          stencilBuffer: false,
          generateMipmaps: false,
        })
      : null;
    if (this.ldrRt) this.ldrRt.texture.name = 'ts-composite-ldr';

    this.bloom.setSize(w, h);
    this.ssao?.setSize(w, h);
    this.fxaa?.uniforms.uTexel.value.set(1 / w, 1 / h);
  }

  render(scene, camera) {
    const renderer = this.renderer;
    // Cheap self-check, two property reads. Every target in the chain is sized
    // from the drawing buffer and the composite blits 1:1, so a size the chain
    // has not seen means a stretched frame — and on a phone that is a soft
    // rotation, not a resize event. It also covers a boot in a hidden tab, where
    // the viewport measures 0 and the whole chain is built 2x2 until something
    // resizes it.
    renderer.getDrawingBufferSize(_size);
    if (_size.x !== this.width || _size.y !== this.height) this.setSize();

    // SkySystem.syncExposure meters the scene and writes this every frame; the
    // composite reproduces three's ACES exactly, so reading it here keeps the
    // chain's tone response identical to the direct path it replaced.
    const exposure = renderer.toneMappingExposure;

    // AO first: the beauty pass below samples it inside the material shader, so
    // it has to be finished before any geometry is shaded with it.
    this.ssao?.render(renderer, scene, camera, this.width, this.height, this.game);

    const domeExposure = this.game.world?.sky?.shared?.uOutputExposure ?? null;
    const domePrev = domeExposure ? domeExposure.value : 0;
    if (domeExposure) domeExposure.value = 0;

    renderer.setRenderTarget(this.sceneRt);
    renderer.render(scene, camera);

    const bloomTex = this.bloom.render(renderer, this.sceneRt.texture, this.width, this.height, exposure);

    const cu = this.composite.uniforms;
    cu.tColor.value = this.sceneRt.texture;
    // A degenerate size can leave the pyramid with no levels; bind something
    // valid and contribute nothing rather than leave a null sampler bound.
    cu.tBloom.value = bloomTex ?? this.sceneRt.texture;
    cu.uParams.value.set(exposure, bloomTex ? this.bloomStrength : 0, this.dither, 0);
    this.composite.render(renderer, this.fxaa ? this.ldrRt : null);

    if (this.fxaa) {
      this.fxaa.uniforms.tColor.value = this.ldrRt.texture;
      this.fxaa.render(renderer, null);
    }

    // Every path above ends on the canvas already; this is here so that adding
    // a pass later cannot silently leave a target bound for the next frame's
    // sky bake.
    renderer.setRenderTarget(null);

    if (domeExposure) domeExposure.value = domePrev;
  }

  /**
   * Debug helper: what the chain actually costs, measured rather than guessed.
   * Call from the console: `__game.post.profile()`.
   *
   * Each batch runs `frames` frames back to back and is closed with a 1x1
   * readPixels, which blocks until the queue drains — otherwise the CPU races
   * ahead and you time command submission instead of the GPU.
   *
   * Two traps this deliberately avoids:
   *
   *  - "Scene alone into the HDR target" is NOT a valid baseline. On a
   *    tile-based deferred GPU (all Apple silicon, all mobile) a colour target
   *    that nothing ever samples has its tile-store elided, so that batch
   *    measures a scene render whose output is thrown away and reads ~1.4 ms
   *    cheaper than the real thing. `hdrBaseMs` therefore always consumes the
   *    target with a composite, so the store is paid for in the baseline too.
   *  - `directMs` must run with the dome tone mapping ITSELF, because that is
   *    what the pipeline it stands in for actually did. `render()` restores the
   *    uniform on the way out, so simply not touching it here is correct.
   */
  profile(frames = 120) {
    const renderer = this.renderer;
    const gl = renderer.getContext();
    const scene = this.game.scene;
    const camera = this.game.camera;
    const px = new Uint8Array(4);
    const sync = () => {
      renderer.setRenderTarget(null);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    };
    // Six warm-up frames per batch: switching between canvas and render-target
    // rendering flips three's toneMapping program key and recompiles every
    // material once, which would otherwise land inside the timed region.
    const time = (fn) => {
      for (let i = 0; i < 6; i++) fn();
      sync();
      const t0 = performance.now();
      for (let i = 0; i < frames; i++) fn();
      sync();
      return (performance.now() - t0) / frames;
    };

    const domeExposure = this.game.world?.sky?.shared?.uOutputExposure ?? null;
    const domePrev = domeExposure ? domeExposure.value : 0;

    const directMs = time(() => {
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
    });

    const hdrBaseMs = time(() => {
      if (domeExposure) domeExposure.value = 0;
      renderer.setRenderTarget(this.sceneRt);
      renderer.render(scene, camera);
      const cu = this.composite.uniforms;
      cu.tColor.value = this.sceneRt.texture;
      cu.tBloom.value = this.sceneRt.texture;
      // Bloom strength and dither both 0: this batch is the HDR round trip on
      // its own, so the pyramid it never built cannot be billed to it.
      cu.uParams.value.set(renderer.toneMappingExposure, 0, 0, 0);
      this.composite.render(renderer, null);
      if (domeExposure) domeExposure.value = domePrev;
    });

    const chainMs = time(() => this.render(scene, camera));

    // The AO block on its own: prepass + estimate + two blurs, timed in
    // isolation so the number includes the prepass's draw submission, which is
    // most of what it costs. Note this is NOT free of the beauty pass — the
    // material shader's extra fetch is billed to `chainMs`, and measured
    // separately by flipping `ssao.amount` to 0.
    const ssaoMs = this.ssao
      ? time(() => this.ssao.render(renderer, scene, camera, this.width, this.height, this.game))
      : 0;

    return {
      resolution: `${this.width}x${this.height}`,
      aa: this.aa,
      samples: this.samples,
      bloomLevels: this.bloom.mips.length,
      ssao: this.ssao ? `${this.ssao.width}x${this.ssao.height}` : 'off',
      // Today's shipping path on 'low' and the path this replaced on 'high'.
      directMs: +directMs.toFixed(3),
      // HDR round trip with no bloom, no AA and no AO — the floor for any chain.
      hdrBaseMs: +hdrBaseMs.toFixed(3),
      chainMs: +chainMs.toFixed(3),
      ssaoMs: +ssaoMs.toFixed(3),
      // What bloom + AA cost on top of that floor, with the AO block taken back
      // out so the two are not double counted.
      bloomAndAaMs: +(chainMs - hdrBaseMs - ssaoMs).toFixed(3),
      // The number the budget is stated against: end to end, versus the
      // direct-to-canvas pipeline the chain replaced.
      deltaVsDirectMs: +(chainMs - directMs).toFixed(3),
    };
  }

  dispose() {
    this.sceneRt?.dispose();
    this.ldrRt?.dispose();
    this.sceneRt = null;
    this.ldrRt = null;
    this.bloom.dispose();
    this.ssao?.dispose();
    this.composite.dispose();
    this.fxaa?.dispose();
    // NOT disposeFullScreen(): the triangle is a module singleton shared by
    // every pass, so freeing it here would break any other chain that is still
    // alive. It belongs to the module and dies with the page.
  }
}
