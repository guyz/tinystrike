import assert from 'node:assert/strict';
import test from 'node:test';

import Input from '../src/core/input.js';
import TouchControls from '../src/core/touch-controls.js';
import {
  isLandscapeViewport,
  normalizeStick,
  shouldEnableTouchControls,
} from '../src/core/touch-controls.js';

class FakeTarget {
  constructor() { this.listeners = new Map(); }
  addEventListener(name, listener) {
    const list = this.listeners.get(name) || [];
    list.push(listener);
    this.listeners.set(name, list);
  }
  dispatch(name, event = {}) {
    for (const listener of this.listeners.get(name) || []) listener(event);
  }
}

class FakeElement extends FakeTarget {
  constructor() {
    super();
    this.hidden = false;
    this._classes = new Set();
    this.classList = {
      add: (name) => this._classes.add(name),
      remove: (name) => this._classes.delete(name),
      contains: (name) => this._classes.has(name),
    };
  }
  setPointerCapture() {}
  hasPointerCapture() { return true; }
  releasePointerCapture() {}
}

function makeInput() {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const fakeWindow = new FakeTarget();
  const fakeDocument = new FakeTarget();
  fakeDocument.visibilityState = 'visible';
  fakeDocument.pointerLockElement = null;
  globalThis.window = fakeWindow;
  globalThis.document = fakeDocument;

  const emitted = [];
  const listeners = new Map();
  const events = {
    emit(name, detail) {
      emitted.push({ name, detail });
      for (const listener of listeners.get(name) || []) listener(detail);
    },
    on(name, listener) {
      const list = listeners.get(name) || [];
      list.push(listener);
      listeners.set(name, list);
    },
  };
  const canvas = {};
  const input = new Input({ debug: false, canvas, events });
  const restore = () => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  };
  return { input, emitted, canvas, restore };
}

test('touch controls are limited to touch-capable devices unless explicitly forced', () => {
  assert.equal(shouldEnableTouchControls({ search: '?touch=1', maxTouchPoints: 0, coarse: false, noHover: false }), true);
  assert.equal(shouldEnableTouchControls({ search: '?touch=0', maxTouchPoints: 5, coarse: true, noHover: true }), false);
  assert.equal(shouldEnableTouchControls({ search: '', maxTouchPoints: 5, coarse: true, noHover: false }), true);
  assert.equal(shouldEnableTouchControls({ search: '', maxTouchPoints: 5, coarse: false, anyCoarse: true, noHover: false }), true);
  assert.equal(shouldEnableTouchControls({ search: '', maxTouchPoints: 5, coarse: false, noHover: false }), false);
  assert.equal(shouldEnableTouchControls({ search: '', maxTouchPoints: 0, coarse: true, noHover: true }), false);
});

test('mobile orientation accepts landscape and rejects square or portrait viewports', () => {
  assert.equal(isLandscapeViewport({ innerWidth: 844, innerHeight: 390 }), true);
  assert.equal(isLandscapeViewport({ innerWidth: 390, innerHeight: 844 }), false);
  assert.equal(isLandscapeViewport({ innerWidth: 600, innerHeight: 600 }), false);
  assert.equal(isLandscapeViewport({ visualViewport: { width: 1024, height: 300 }, innerWidth: 390, innerHeight: 844 }), false);
  assert.equal(isLandscapeViewport({
    visualViewport: { width: 844, height: 280 },
    innerWidth: 390,
    innerHeight: 844,
    matchMedia: (query) => ({ matches: query.includes('portrait') }),
  }), false);
  assert.equal(isLandscapeViewport({
    visualViewport: { width: 320, height: 640 },
    innerWidth: 320,
    innerHeight: 640,
    screen: { orientation: { type: 'landscape-primary' } },
  }), true);
});

test('a hybrid device upgrades virtual focus to real mouse pointer lock', (t) => {
  const { input, canvas, restore } = makeInput();
  t.after(restore);

  let requests = 0;
  canvas.requestPointerLock = () => { requests += 1; };
  input.setTouchMode(true);
  input.requestLock();
  assert.equal(input.locked, true);
  assert.equal(input._virtualLock, true);

  input._onMouseDown({ button: 0, target: canvas, sourceCapabilities: { firesTouchEvents: false } });
  assert.equal(requests, 1);
  assert.equal(input.firing, false, 'the locking click must not fire the weapon');

  globalThis.document.pointerLockElement = canvas;
  globalThis.document.dispatch('pointerlockchange');
  assert.equal(input.locked, true);
  assert.equal(input._virtualLock, false);

  globalThis.document.pointerLockElement = null;
  globalThis.document.dispatch('pointerlockchange');
  assert.equal(input.locked, false);
});

test('the touch look surface passes a hybrid mouse into real pointer lock', (t) => {
  const previousWindow = globalThis.window;
  globalThis.window = new FakeTarget();
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  const look = new FakeElement();
  const requests = [];
  const controls = Object.create(TouchControls.prototype);
  controls._el = { look };
  controls._active = true;
  controls._lookPointer = null;
  controls._pointerReleases = [];
  controls.game = { input: { requestLock: (options) => requests.push(options) } };
  controls._bindLook();

  look.dispatch('pointerdown', {
    pointerId: 4,
    pointerType: 'mouse',
    clientX: 500,
    clientY: 200,
    preventDefault() {},
    stopPropagation() {},
  });

  assert.deepEqual(requests, [{ preferReal: true }]);
  assert.equal(controls._lookPointer, null, 'mouse must not enter bounded touch-drag aiming');
});

test('movement stick applies a radial dead zone and keeps intuitive axes', () => {
  const rect = { left: 10, top: 20, width: 100, height: 100 };
  assert.deepEqual(normalizeStick(60, 70, rect), { x: 0, y: 0, magnitude: 0, knobX: 0, knobY: 0 });

  const forward = normalizeStick(60, 20, rect);
  assert.equal(forward.x, 0);
  assert.ok(forward.y > 0.99);
  assert.ok(forward.magnitude > 0.99);

  const right = normalizeStick(110, 70, rect);
  assert.ok(right.x > 0.99);
  assert.ok(Math.abs(right.y) < Number.EPSILON);
});

test('virtual input shares gameplay edges without sticking or duplicating hybrid input', (t) => {
  const { input, emitted, canvas, restore } = makeInput();
  t.after(restore);

  input.setTouchMode(true);
  input.requestLock();
  assert.equal(input.locked, true);
  assert.equal(emitted.filter((event) => event.name === 'input:lock').length, 1);

  input.setMoveVector(0.8, 0.6);
  assert.deepEqual(input.moveVector(), { x: 0.8, y: 0.6, magnitude: 1 });

  input.addVirtualLook(500, -500);
  assert.deepEqual({ ...input.consumeLook() }, { dx: 180, dy: -180 });

  input.setVirtualKey('w', true);
  assert.equal(input.isDown('w'), true);
  assert.equal(input.wasPressed('w'), true);
  input._onKeyDown({ key: 'w', repeat: false });
  assert.equal(emitted.filter((event) => event.name === 'input:keydown' && event.detail.key === 'w').length, 1);
  input.setVirtualKey('w', false);
  assert.equal(input.isDown('w'), true, 'hardware source remains held');
  input._onKeyUp({ key: 'w' });
  assert.equal(input.isDown('w'), false);

  input.setVirtualButton(0, true);
  input._onMouseDown({ button: 0, target: {} });
  assert.equal(input.firing, true);
  assert.equal(emitted.filter((event) => event.name === 'input:mousedown' && event.detail.button === 0).length, 1);
  input.setVirtualButton(0, false);
  assert.equal(input.firing, true, 'hardware source remains held');
  input._onMouseUp({ button: 0 });
  assert.equal(input.firing, false);
  assert.equal(emitted.filter((event) => event.name === 'input:mouseup' && event.detail.button === 0).length, 1);

  input.setVirtualButton(2, true);
  input.setMoveVector(0.5, -0.25);
  input.addVirtualLook(20, 10);
  input.pulseVirtualKey(' ');
  assert.equal(input.wasPressed(' '), true);
  input.releaseVirtualControls();
  assert.equal(input.aiming, false);
  assert.deepEqual(input.moveVector(), { x: 0, y: 0, magnitude: 0 });
  assert.deepEqual({ ...input.consumeLook() }, { dx: 0, dy: 0 });
  assert.equal(input.wasPressed(' '), false, 'cancelled touch edge cannot leak after rotation');
});

test('touch UI compatibility mouse events never leak into combat', (t) => {
  const { input, emitted, restore } = makeInput();
  t.after(restore);
  input.setTouchMode(true);
  input.requestLock();
  const hudTarget = { closest: (selector) => selector === '#hud' ? {} : null };

  input._onMouseDown({ button: 0, target: hudTarget });

  assert.equal(input.firing, false);
  assert.equal(emitted.filter((event) => event.name === 'input:mousedown').length, 0);
});

test('a long pointer press never replays its action through the native click', (t) => {
  const previousWindow = globalThis.window;
  const previousNow = Date.now;
  const fakeWindow = new FakeTarget();
  globalThis.window = fakeWindow;
  let now = 1_000;
  Date.now = () => now;
  t.after(() => {
    Date.now = previousNow;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });

  const controls = Object.create(TouchControls.prototype);
  controls._active = true;
  controls._pointerReleases = [];
  let actions = 0;
  const button = new FakeElement();
  const pointerEvent = { pointerId: 7, preventDefault() {}, stopPropagation() {} };
  const clickEvent = { preventDefault() {}, stopPropagation() {} };
  controls._bindTap(button, () => actions++);

  button.dispatch('pointerdown', pointerEvent);
  assert.equal(actions, 1);
  now = 5_000; // hold substantially longer than the click suppression window
  button.dispatch('pointerup', pointerEvent);
  button.dispatch('click', clickEvent);
  assert.equal(actions, 1, 'the pointer-origin click is suppressed after release');

  now = 6_000;
  button.dispatch('click', clickEvent);
  assert.equal(actions, 2, 'a later synthesized keyboard/assistive click still works');
});
