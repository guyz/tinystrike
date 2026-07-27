import assert from 'node:assert/strict';
import test from 'node:test';

import Input from '../src/core/input.js';
import GameSettings, {
  KEY_BINDING_DEFINITIONS,
  SETTINGS_STORAGE_KEY,
  formatKeyLabel,
} from '../src/core/settings.js';
import { exposureWithBrightnessEv } from '../src/gfx/sky/index.js';
import { BASE_LOOK_SENSITIVITY, lookSensitivityFor } from '../src/player/player.js';
import HUD from '../src/ui/hud.js';

class MemoryStorage {
  constructor(seed = {}) {
    this.data = new Map(Object.entries(seed));
    this.writes = [];
  }
  getItem(key) { return this.data.get(key) ?? null; }
  setItem(key, value) {
    this.data.set(key, String(value));
    this.writes.push([key, String(value)]);
  }
}

class FakeTarget {
  constructor() {
    this.listeners = new Map();
    this.listenerOptions = new Map();
  }
  addEventListener(name, listener, options) {
    const list = this.listeners.get(name) || [];
    list.push(listener);
    this.listeners.set(name, list);
    const optionList = this.listenerOptions.get(name) || [];
    optionList.push(options);
    this.listenerOptions.set(name, optionList);
  }
}

function eventBus() {
  const emitted = [];
  const listeners = new Map();
  return {
    emitted,
    on(name, listener) {
      const list = listeners.get(name) || [];
      list.push(listener);
      listeners.set(name, list);
    },
    emit(name, detail) {
      emitted.push({ name, detail });
      for (const listener of listeners.get(name) || []) listener(detail);
    },
  };
}

function installInputGlobals(t) {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = new FakeTarget();
  globalThis.document = new FakeTarget();
  globalThis.document.visibilityState = 'visible';
  globalThis.document.pointerLockElement = null;
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  });
}

test('settings persist sensitivity, brightness and a unique swapped keyboard layout', () => {
  const storage = new MemoryStorage();
  const events = eventBus();
  const game = { events };
  const settings = new GameSettings(game, storage);
  game.settings = settings;

  assert.equal(settings.lookSensitivity, 1);
  assert.equal(settings.brightnessEv, 0);
  assert.equal(settings.get('moveForward'), 'w');
  assert.equal(formatKeyLabel(settings.get('jump')), 'SPACE');

  settings.setLookSensitivity(1.75);
  settings.setBrightnessEv(-0.3);
  const swapped = settings.rebind('moveForward', 's');
  assert.equal(swapped.swappedActionId, 'moveBackward');
  assert.equal(settings.get('moveForward'), 's');
  assert.equal(settings.get('moveBackward'), 'w');

  const restored = new GameSettings(null, storage);
  assert.equal(restored.lookSensitivity, 1.75);
  assert.equal(restored.brightnessEv, -0.3);
  assert.equal(restored.get('moveForward'), 's');
  assert.equal(restored.get('moveBackward'), 'w');
  assert.ok(storage.writes.every(([key]) => key === SETTINGS_STORAGE_KEY));
  assert.ok(events.emitted.some((entry) => entry.name === 'settings:changed'));
});

test('a displaced default key is disabled and corrupt storage repairs safely', () => {
  const settings = new GameSettings(null, null);
  settings.rebind('moveForward', 'i');
  assert.equal(settings.resolveInputKey('i'), 'w');
  assert.equal(settings.resolveInputKey('w'), null, 'the old W binding must not keep moving');
  assert.equal(settings.resolveInputKey('x'), 'x', 'unrelated keys still pass through');

  const corrupt = new MemoryStorage({
    [SETTINGS_STORAGE_KEY]: JSON.stringify({
      lookSensitivity: 99,
      brightnessEv: -99,
      bindings: Object.fromEntries(KEY_BINDING_DEFINITIONS.map((entry) => [entry.id, 'z'])),
    }),
  });
  const repaired = new GameSettings(null, corrupt);
  assert.equal(repaired.lookSensitivity, 3);
  assert.equal(repaired.brightnessEv, -0.5);
  assert.equal(new Set(Object.values(repaired.bindings)).size, KEY_BINDING_DEFINITIONS.length);

  const malformed = new GameSettings(null, new MemoryStorage({
    [SETTINGS_STORAGE_KEY]: '{ definitely not json',
  }));
  assert.equal(malformed.lookSensitivity, 1);
  assert.equal(malformed.get('scoreboard'), 'tab');

  const wrongTypes = new GameSettings(null, new MemoryStorage({
    [SETTINGS_STORAGE_KEY]: JSON.stringify({
      bindings: { moveForward: {}, moveBackward: true, reload: 42 },
    }),
  }));
  assert.equal(wrongTypes.get('moveForward'), 'w');
  assert.equal(wrongTypes.get('moveBackward'), 's');
  assert.equal(wrongTypes.get('reload'), 'r');
});

test('blocked storage keeps settings live for the current session', () => {
  const storage = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); },
  };
  const settings = new GameSettings(null, storage);
  assert.doesNotThrow(() => settings.setBrightnessEv(0.4));
  assert.doesNotThrow(() => settings.rebind('reload', 'f'));
  assert.equal(settings.brightnessEv, 0.4);
  assert.equal(settings.get('reload'), 'f');
});

test('input remaps hardware before gameplay while semantic touch actions stay fixed', (t) => {
  installInputGlobals(t);
  const events = eventBus();
  const game = { debug: false, canvas: {}, events };
  game.settings = new GameSettings(game, null);
  const input = new Input(game);
  assert.equal(globalThis.window.listenerOptions.get('keydown')[0].capture, true);
  game.input = input;

  game.settings.rebind('moveForward', 'i');
  input._onKeyDown({ key: 'i', repeat: false });
  assert.equal(input.isDown('w'), true);
  assert.ok(events.emitted.some((entry) =>
    entry.name === 'input:keydown' && entry.detail.key === 'w'
  ));
  input._onKeyUp({ key: 'i' });
  assert.equal(input.isDown('w'), false);

  input._onKeyDown({ key: 'w', repeat: false });
  assert.equal(input.isDown('w'), false, 'the displaced physical W key is inert');

  input.setVirtualAction('moveForward', true);
  assert.equal(input.isDown('w'), true, 'touch still means Move Forward after remapping');
  input.setVirtualAction('moveForward', false);
});

test('key capture consumes the assignment, Escape cancels, and Tab navigates while unlocked', (t) => {
  installInputGlobals(t);
  const events = eventBus();
  const game = { debug: false, canvas: {}, events };
  game.settings = new GameSettings(game, null);
  const input = new Input(game);

  let captured = null;
  let prevented = false;
  let stopped = false;
  assert.equal(input.captureNextKey((key, meta) => { captured = { key, meta }; }), true);
  input._onKeyDown({
    key: 'f',
    repeat: false,
    preventDefault() { prevented = true; },
    stopImmediatePropagation() { stopped = true; },
  });
  assert.deepEqual(captured, { key: 'f', meta: { cancelled: false } });
  assert.equal(prevented, true);
  assert.equal(stopped, true);
  assert.equal(input.isDown('f'), false);
  assert.equal(events.emitted.some((entry) => entry.name === 'input:keydown'), false);

  input.captureNextKey((key, meta) => { captured = { key, meta }; });
  input._onKeyDown({ key: 'Escape', preventDefault() {}, stopImmediatePropagation() {} });
  assert.equal(captured.key, null);
  assert.equal(captured.meta.cancelled, true);

  prevented = false;
  input._onKeyDown({ key: 'Tab', repeat: false, preventDefault() { prevented = true; } });
  assert.equal(prevented, false, 'Tab must navigate the unlocked Settings panel');
  input._onKeyUp({ key: 'Tab' });
  input.locked = true;
  input._onKeyDown({ key: 'Tab', repeat: false, preventDefault() { prevented = true; } });
  assert.equal(prevented, true, 'locked Tab remains the scoreboard key');

  input._onKeyUp({ key: 'Tab' });
  game.settings.rebind('scoreboard', 'x');
  prevented = false;
  input._onKeyDown({ key: 'Tab', repeat: false, preventDefault() { prevented = true; } });
  assert.equal(prevented, true, 'a displaced physical Tab still cannot move browser focus');
  assert.equal(input.isDown('tab'), false, 'displaced Tab does not enter gameplay state');

  game.settings.rebind('reload', 'f5');
  prevented = false;
  input._onKeyDown({ key: 'F5', repeat: false, preventDefault() { prevented = true; } });
  assert.equal(prevented, true, 'a browser-reserved key is suppressed when bound');
  assert.equal(input.isDown('r'), true);

  game.settings.reset();
  prevented = false;
  input._onKeyDown({
    key: 'r',
    ctrlKey: true,
    repeat: false,
    preventDefault() { prevented = true; },
  });
  assert.equal(prevented, true, 'crouch plus reload cannot refresh the page');
});

test('look and brightness helpers preserve authored defaults and scoped ratios', () => {
  assert.equal(lookSensitivityFor(1), BASE_LOOK_SENSITIVITY);
  assert.equal(lookSensitivityFor(3), BASE_LOOK_SENSITIVITY * 3);
  assert.equal(lookSensitivityFor(1, 1), BASE_LOOK_SENSITIVITY * 0.45);
  assert.equal(lookSensitivityFor(1, 2), BASE_LOOK_SENSITIVITY * 0.22);
  assert.equal(exposureWithBrightnessEv(0.95, 0), 0.95);
  assert.ok(Math.abs(exposureWithBrightnessEv(0.95, 0.5) - 0.95 * Math.SQRT2) < 1e-12);
  assert.ok(Math.abs(exposureWithBrightnessEv(0.95, -0.5) - 0.95 / Math.SQRT2) < 1e-12);
});

test('the default menu keeps Settings collapsed and uses its existing quick-action slot', () => {
  const hud = Object.create(HUD.prototype);
  hud.game = { settings: new GameSettings(null, null) };
  const html = hud._html();

  assert.match(html, /id="hud-settings-open"[^>]*>SETTINGS/);
  assert.match(html, /id="hud-menu-settings"[^>]*hidden/);
  assert.equal((html.match(/data-binding-action=/g) || []).length, KEY_BINDING_DEFINITIONS.length);
  assert.doesNotMatch(html, /id="hud-controls-open"/);
});
