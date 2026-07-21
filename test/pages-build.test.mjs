import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildPages, verifyPagesBuild } from '../tools/build-pages.mjs';

test('Pages build is self-contained, configured, and deterministic', async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'tiny-strike-pages-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const firstOutput = path.join(temporary, 'first');
  const secondOutput = path.join(temporary, 'second');
  const options = {
    serviceUrl: 'https://play-api.example.test',
  };

  const first = await buildPages({ ...options, outputDir: firstOutput });
  const second = await buildPages({ ...options, outputDir: secondOutput });

  assert.deepEqual(first.manifest, second.manifest);
  assert.equal(first.manifest.endpoints.leaderboard, 'https://play-api.example.test/api/leaderboard');
  assert.equal(first.manifest.endpoints.websocket, 'wss://play-api.example.test/ws');
  assert.ok(first.browserModules.includes('src/main.js'));
  assert.ok(first.browserModules.includes('src/core/touch-controls.js'));
  assert.ok(first.browserModules.includes('tools/trailer.js'));
  assert.ok(!first.browserModules.includes('src/server/leaderboard.mjs'));

  const index = await readFile(path.join(firstOutput, 'index.html'), 'utf8');
  assert.doesNotMatch(index, /node_modules/);
  assert.match(index, /\.\/vendor\/three\/three\.module\.min\.js/);
  assert.match(index, /viewport-fit=cover/);
  assert.doesNotMatch(index, /user-scalable\s*=\s*no|maximum-scale\s*=\s*1/);
  assert.ok(index.indexOf('./runtime-config.js') < index.indexOf('./src/main.js'));

  const touchControls = await readFile(path.join(firstOutput, 'src', 'core', 'touch-controls.js'), 'utf8');
  assert.match(touchControls, /touch-gameplay/);
  assert.match(touchControls, /touch-action:manipulation/);

  const runtimeConfig = await readFile(path.join(firstOutput, 'runtime-config.js'), 'utf8');
  assert.match(runtimeConfig, /https:\/\/play-api\.example\.test\/api\/leaderboard/);
  assert.match(runtimeConfig, /wss:\/\/play-api\.example\.test\/ws/);
  assert.ok(first.verification.files > 20);
  assert.ok(first.verification.assets > 5);
});

test('Pages verifier reports a missing browser dependency', async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'tiny-strike-pages-broken-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  await buildPages({ outputDir: temporary });
  const mainPath = path.join(temporary, 'src', 'main.js');
  const main = await readFile(mainPath, 'utf8');
  await writeFile(mainPath, `${main}\nimport './missing-production-module.js';\n`);
  await assert.rejects(
    () => verifyPagesBuild(temporary),
    /src\/main\.js has missing dependency \.\/missing-production-module\.js/,
  );
});
