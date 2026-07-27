import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('loading screen covers boot and yields only after the first rendered frame', async () => {
  const [index, main] = await Promise.all([
    readFile(new URL('index.html', root), 'utf8'),
    readFile(new URL('src/main.js', root), 'utf8'),
  ]);

  const loaderIndex = index.indexOf('id="loading-screen"');
  const mainIndex = index.indexOf("import('./src/main.js')");

  assert.ok(loaderIndex >= 0, 'index.html should render the loading screen');
  assert.ok(mainIndex > loaderIndex, 'the loading screen must exist before the game module starts');
  assert.match(index, /role="progressbar"/);
  assert.match(index, /aria-live="polite"/);
  assert.match(index, /TINY_STRIKE_LOADING = Object\.freeze\(\{ setStage, waitForPaint, finish, fail \}\)/);
  assert.match(index, /window\.addEventListener\('error', fail, true\)/);
  assert.match(index, /requestAnimationFrame\(\(\) => requestAnimationFrame\(\(\) => \{/);
  assert.match(index, /import\('\.\/src\/main\.js'\)\.catch\(\(error\) => \{/);
  assert.match(index, /TINY_STRIKE_LOADING\?\.fail\?\.\(\)/);
  assert.match(index, /id="loading-retry"/);

  assert.match(main, /await loadingScreen\?\.waitForPaint\?\.\(\)/);
  assert.match(main, /setStage\?\.\('Building battleground', 38\)/);
  const renderIndex = main.indexOf('else renderer.render(scene, camera);');
  const finishIndex = main.indexOf('loadingScreen?.finish?.();');
  assert.ok(renderIndex >= 0 && finishIndex > renderIndex, 'the first frame must render before loading completes');
  assert.ok(
    finishIndex < main.indexOf('window.__game = game;'),
    'all render paths, including trailer mode, must complete loading',
  );
});
