import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';

import HUD, { MAP_SELECT_LOAD_DEBOUNCE_MS } from '../src/ui/hud.js';

const MAP_IDS = ['dustyard', 'frostline', 'neon_foundry', 'harbor', 'citadel'];

function mapButton(mapId) {
  const classes = new Set();
  const attributes = new Map();
  return {
    dataset: { mapId },
    classes,
    attributes,
    classList: {
      toggle(name, active) {
        if (active) classes.add(name);
        else classes.delete(name);
      },
    },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    scrollIntoView() {},
  };
}

function installStorage(t) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const writes = [];
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      setItem(key, value) { writes.push([key, value]); },
    },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  });
  return writes;
}

function makeHud() {
  const emitted = [];
  const buttons = MAP_IDS.map(mapButton);
  const startSub = { textContent: '' };
  let lockRequests = 0;
  const game = {
    selectedMapId: 'dustyard',
    sessionMode: null,
    events: {
      emit(type, payload) { emitted.push([type, payload]); },
    },
    input: {
      requestLock() { lockRequests++; },
    },
  };
  const hud = Object.create(HUD.prototype);
  hud.game = game;
  hud._selectedMapId = 'dustyard';
  hud._pendingMapSelectId = null;
  hud._mapSelectTimer = null;
  hud._el = {
    mapPicker: {
      querySelectorAll() { return buttons; },
    },
    startSub,
  };
  return {
    hud,
    game,
    emitted,
    buttons,
    startSub,
    lockRequests: () => lockRequests,
  };
}

test('map selection updates the card, PLAY label, game state, and storage inside 100 ms', (t) => {
  const writes = installStorage(t);
  const fixture = makeHud();
  t.after(() => fixture.hud._cancelMapSelection());

  const started = performance.now();
  fixture.hud._selectMap('harbor');
  const elapsed = performance.now() - started;

  assert.ok(elapsed < 100, `selection took ${elapsed.toFixed(1)} ms`);
  assert.equal(fixture.hud._selectedMapId, 'harbor');
  assert.equal(fixture.game.selectedMapId, 'harbor');
  assert.equal(fixture.startSub.textContent, 'ON HARBOR');
  assert.deepEqual(writes, [['tiny-strike-map', 'harbor']]);
  assert.deepEqual(fixture.emitted, [], 'the expensive map event must not run in the click turn');

  for (const button of fixture.buttons) {
    const selected = button.dataset.mapId === 'harbor';
    assert.equal(button.classes.has('selected'), selected);
    assert.equal(button.attributes.get('aria-pressed'), selected ? 'true' : 'false');
  }
});

test('rapid card changes coalesce into one delayed world-selection event', async (t) => {
  installStorage(t);
  const fixture = makeHud();
  t.after(() => fixture.hud._cancelMapSelection());

  fixture.hud._selectMap('frostline');
  fixture.hud._selectMap('neon_foundry');
  fixture.hud._selectMap('citadel');

  assert.deepEqual(fixture.emitted, []);
  await new Promise((resolve) => setTimeout(resolve, MAP_SELECT_LOAD_DEBOUNCE_MS + 40));
  assert.deepEqual(fixture.emitted, [['ui:map-select', { mapId: 'citadel' }]]);
});

test('PLAY flushes a pending map selection before starting the solo match', (t) => {
  installStorage(t);
  const fixture = makeHud();
  t.after(() => fixture.hud._cancelMapSelection());

  fixture.hud._selectMap('neon_foundry');
  fixture.hud._startSoloMatch();

  assert.equal(fixture.game.sessionMode, 'solo');
  assert.deepEqual(fixture.emitted, [
    ['ui:map-select', { mapId: 'neon_foundry' }],
    ['ui:start', { mapId: 'neon_foundry' }],
  ]);
  assert.equal(fixture.lockRequests(), 1);
  assert.equal(fixture.hud._pendingMapSelectId, null);
  assert.equal(fixture.hud._mapSelectTimer, null);
});
