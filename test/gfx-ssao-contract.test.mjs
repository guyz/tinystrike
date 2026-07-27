// The screen-space AO term is a producer/consumer pair that spans two files:
// `src/gfx/post/ssao.js` produces a half-res AO buffer and publishes it through
// a shared uniform block, and `src/gfx/materials/shader.js` is the only thing
// that reads it.
//
// It shipped complete, measured, wired into PostChain — and stayed dead through
// two full art-review rounds, because the four-line patch it needed on the
// consumer side was written up for a different owner and never applied. Nothing
// failed: `ssaoConsumed()` returned false, so the pass politely declined to
// allocate its targets, and every "nothing in this map touches the ground"
// review finding was made against a build with no AO in it.
//
// These tests fail if that link is ever broken again.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SSAO_APPLY,
  SSAO_PARS_FRAGMENT,
  ssaoUniforms,
  ssaoConsumed,
} from '../src/gfx/post/ssao.js';

// Importing the consumer is what registers it. Nothing else in this file needs
// the module, so the side effect IS the subject under test.
import '../src/gfx/materials/shader.js';

test('importing the material shader registers an SSAO consumer', () => {
  assert.equal(
    ssaoConsumed(),
    true,
    'shader.js must call registerSsaoConsumer() at module scope — without it PostChain ' +
      'skips the AO pass entirely and the term is silently absent from every frame'
  );
});

test('the shader declares the AO helper and calls it', async () => {
  const source = await import('node:fs/promises').then((fs) =>
    fs.readFile(new URL('../src/gfx/materials/shader.js', import.meta.url), 'utf8')
  );

  // The two GLSL fragments must be interpolated into template literals, not
  // pasted as copies that can drift from the producer's definitions.
  assert.match(
    source,
    /\$\{SSAO_PARS_FRAGMENT\}/,
    'PARS_FRAGMENT must interpolate ${SSAO_PARS_FRAGMENT} so owScreenAO() is declared'
  );
  assert.match(
    source,
    /\$\{SSAO_APPLY\}/,
    'the aomap_fragment override must interpolate ${SSAO_APPLY} so the term is actually applied'
  );

  // The producer's own GLSL has to hold up its half of the bargain.
  assert.match(SSAO_PARS_FRAGMENT, /owScreenAO/, 'the pars block must define owScreenAO()');
  assert.match(SSAO_APPLY, /owScreenAO\s*\(\s*\)/, 'the apply snippet must call owScreenAO()');

  // Indirect-only, by design: ambient occlusion is a visibility factor on the
  // ambient integral, so a crate foot in full sun keeps its sharp cast shadow
  // instead of gaining a soft grey smudge.
  assert.match(
    SSAO_APPLY,
    /ambientOcclusion/,
    'the term must modulate ambientOcclusion, not a direct-light or composite result'
  );
  assert.doesNotMatch(
    SSAO_APPLY,
    /directDiffuse|outgoingLight|gl_FragColor/,
    'the AO term must never be applied to direct light or to the composited frame'
  );
});

test('the shader merges the shared uniforms by reference, never by copy', async () => {
  const source = await import('node:fs/promises').then((fs) =>
    fs.readFile(new URL('../src/gfx/materials/shader.js', import.meta.url), 'utf8')
  );

  assert.match(
    source,
    /Object\.assign\(\s*u\s*,\s*ssaoUniforms\s*\)/,
    'the uniforms must be merged by reference — cloning them gives each material a private ' +
      'copy that the post chain never writes to, so the term stays at zero forever'
  );

  // The uniform objects the pass writes each frame must be the ones a material
  // would hand to three, so identity is the property that matters.
  for (const key of ['owSsaoTex', 'owSsaoP', 'owSsaoD']) {
    assert.ok(ssaoUniforms[key], `ssaoUniforms.${key} must exist`);
  }
  const merged = {};
  Object.assign(merged, ssaoUniforms);
  assert.equal(merged.owSsaoP, ssaoUniforms.owSsaoP, 'Object.assign must preserve identity');
});

test('the AO term is off until the pass publishes a strength', () => {
  // `owSsaoP.z` is the strength, and it starts at zero so that a build with no
  // post chain (gfxQuality 'low', ?post=off, no float targets) costs one scalar
  // compare in the shader rather than a texture fetch against an unwritten
  // buffer.
  assert.equal(
    ssaoUniforms.owSsaoP.value.z,
    0,
    'the published strength must default to 0 so the term is inert until Ssao.render() runs'
  );
  assert.match(
    SSAO_PARS_FRAGMENT,
    /owSsaoP\.z\s*<=\s*0\.0/,
    'owScreenAO() must early-out on a zero strength, so the disabled path never samples'
  );
});
