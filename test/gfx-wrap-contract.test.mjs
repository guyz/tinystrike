// The warm bounce wrap is a producer/consumer pair that spans two files:
// `src/world/map.js` writes `wrapUniforms` once a frame out of `World.update()`,
// and `src/gfx/materials/shader.js` declares them, merges them into every
// material's uniform block by reference, and adds the term to indirect diffuse.
//
// This is the same shape as the screen-space AO term, which shipped complete and
// measured and then stayed DEAD through two art-review rounds because the patch
// on the consumer side was never applied (see test/gfx-ssao-contract.test.mjs and
// SPEC amendment rule 4). These tests fail if this link is ever broken the same
// way: a uniform that nothing reads, a value that nothing writes, a term that
// lands on the wrong side of the occlusion multiply, or a gate that would let it
// touch a surface the sun is already lighting.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { wrapUniforms } from '../src/gfx/materials/shader.js';

const shaderSrc = await readFile(new URL('../src/gfx/materials/shader.js', import.meta.url), 'utf8');
const mapSrc = await readFile(new URL('../src/world/map.js', import.meta.url), 'utf8');

test('the shared wrap uniforms exist and start inert', () => {
  for (const key of ['owWrapDir', 'owWrapCol']) {
    assert.ok(wrapUniforms[key], `wrapUniforms.${key} must exist`);
    assert.ok(wrapUniforms[key].value, `wrapUniforms.${key}.value must be an object three can upload`);
  }
  const c = wrapUniforms.owWrapCol.value;
  assert.equal(
    c.r + c.g + c.b,
    0,
    'the wrap colour must default to black so a build whose World.update() never ' +
      'ran — a hidden tab, a headless test — renders with the term off rather than ' +
      'with a stale irradiance from another map'
  );
});

test('the shader merges the wrap uniforms by reference, never by copy', () => {
  assert.match(
    shaderSrc,
    /Object\.assign\(\s*u\s*,\s*wrapUniforms\s*\)/,
    'the uniforms must be merged by reference — cloning them gives each material a ' +
      'private copy that World.update() never writes to, so the term stays black forever'
  );
  const merged = {};
  Object.assign(merged, wrapUniforms);
  assert.equal(merged.owWrapCol, wrapUniforms.owWrapCol, 'Object.assign must preserve identity');
  assert.equal(merged.owWrapDir, wrapUniforms.owWrapDir, 'Object.assign must preserve identity');
});

test('the shader declares the wrap and actually applies it', () => {
  assert.match(
    shaderSrc,
    /\$\{WRAP_PARS_FRAGMENT\}/,
    'PARS_FRAGMENT must interpolate ${WRAP_PARS_FRAGMENT} so owWrapIrradiance() is declared'
  );
  for (const decl of [/uniform\s+vec3\s+owWrapDir\s*;/, /uniform\s+vec3\s+owWrapCol\s*;/]) {
    assert.match(shaderSrc, decl, 'every wrap uniform must be declared in the fragment pars block');
  }
  assert.match(
    shaderSrc,
    /reflectedLight\.indirectDiffuse\s*\+=\s*owWrapIrradiance\(/,
    'the aomap_fragment override must actually add the term — a declared uniform that ' +
      'nothing reads is exactly the failure SPEC rule 4 exists for'
  );
});

test('the wrap is indirect light, and it is occluded', () => {
  // Everything between the ambientOcclusion assignment and the multiply is what
  // the occlusion term will scale.
  const block = shaderSrc.slice(
    shaderSrc.indexOf('float ambientOcclusion ='),
    shaderSrc.indexOf('reflectedLight.indirectDiffuse *= ambientOcclusion;')
  );
  assert.ok(block.length > 0, 'the aomap_fragment override must still compute and apply ambientOcclusion');
  assert.match(
    block,
    /reflectedLight\.indirectDiffuse\s*\+=\s*owWrapIrradiance\(/,
    'the wrap must be added BEFORE the ambientOcclusion multiply so that both the baked ' +
      'cavity term and the screen-space AO occlude it — a crevice cannot see the sunlit ' +
      'wall across the street any more than it can see the sky'
  );

  // Indirect only. A bounce is not a light source with a specular lobe, which is
  // the whole reason this is a material patch and not a second DirectionalLight
  // aimed from the sun's opposite side. The leading dot keeps `indirectDiffuse`
  // from matching the `directDiffuse` alternative as a substring.
  assert.doesNotMatch(
    shaderSrc,
    /\.(directDiffuse|directSpecular|indirectSpecular)\s*\+=\s*owWrap/,
    'the wrap must never be added to direct light or to any specular accumulator'
  );
});

test('the gate cannot touch a surface the sun is already lighting', () => {
  const gate = shaderSrc.slice(
    shaderSrc.indexOf('float owSunShadowed()'),
    shaderSrc.indexOf('vec3 owWrapIrradiance(')
  );
  assert.ok(gate.length > 0, 'owSunShadowed() must exist — it is the gate');

  // The gate is sun VISIBILITY, not a normal-only dot product. Shaded ground and
  // sunlit ground have the SAME NORMAL, so a `-dot(N, sunDir)` gate cannot reach
  // the up-facing shaded ground this term exists for; and gating on visibility is
  // what makes a lit fragment measure bit-identical before and after.
  assert.match(
    gate,
    /texture2DCompare\(\s*directionalShadowMap\[\s*0\s*\]/,
    'the gate must read the key light shadow map, so a fragment the sun reaches gets nothing'
  );
  assert.match(
    gate,
    /return\s+0\.0\s*;/,
    'every early-out — no shadow map, outside the shadow frustum, receiveShadow off — must ' +
      'return "not shadowed" so the term fails OFF rather than lighting the whole map'
  );
  assert.match(
    gate,
    /if\s*\(\s*!\s*receiveShadow\s*\)/,
    'a mesh that does not receive shadows is fully lit by the key, so it must not be filled'
  );

  const lobe = shaderSrc.slice(shaderSrc.indexOf('vec3 owWrapIrradiance('));
  assert.match(
    lobe,
    /dot\(\s*nWorld\s*,\s*owWrapDir\s*\)/,
    'the lobe must be oriented by owWrapDir, the horizontal anti-sun direction'
  );
  assert.match(
    lobe,
    /owSunShadowed\(\s*\)/,
    'the lobe must be multiplied by the shadow gate, not applied on its own'
  );
});

test('World.update writes the wrap every frame, from the sky', () => {
  assert.match(mapSrc, /import\s*\{\s*wrapUniforms\s*\}/, 'map.js must import the shared block');

  const update = mapSrc.slice(mapSrc.indexOf('  update(dt) {'), mapSrc.indexOf('  decorMaterial('));
  assert.ok(update.length > 0, 'World.update() must still exist');
  assert.match(
    update,
    /wrapUniforms\.owWrapDir\.value\.copy\(/,
    'the direction must be written from World.update(), next to the bounce-fill retint — ' +
      'the sun moves, and a wrap pointing the wrong way is worse than no wrap'
  );
  assert.match(
    update,
    /wrapUniforms\.owWrapCol\.value[\s\S]{0,400}?WRAP_FORM/,
    'the colour must be written from World.update() and scaled by WRAP_FORM'
  );
  // It is a bounce off THIS map's ground, in the colour of THIS beam.
  assert.match(
    update,
    /wrapUniforms\.owWrapCol\.value[\s\S]{0,400}?_bounceAlbedo/,
    'the wrap must be tinted by the map ground albedo — a bounce is the colour of what it ' +
      'bounced off, which is the entire point of the term'
  );
  assert.match(
    update,
    /wrapUniforms\.owWrapDir\.value[\s\S]{0,300}?wrapDir/,
    'the direction must come from the key light, not be a constant'
  );
  assert.match(
    mapSrc,
    /wrapDir\.y\s*=\s*0\s*;/,
    'the lobe axis is HORIZONTAL: the sunlit surfaces doing the bouncing sit around the ' +
      'horizon, not at the anti-sun pole, which for a 38 degree sun is underground'
  );
});
