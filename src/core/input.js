// ---------------------------------------------------------------------------
// OPERATION GOLDENEYE — src/core/input.js
//
// Keyboard / mouse / pointer-lock input subsystem (spec section A).
//
// Public API (exact, per SPEC.md):
//   locked        (bool)  — pointer lock active. In game.debug the lock is
//                           simulated: true after the canvas is clicked once
//                           or immediately after requestLock().
//   isDown(key)   (bool)  — lowercase single char ('w','b'), ' ' for space,
//                           or 'shift' | 'control' | 'tab' | 'escape'.
//   consumeLook()         — { dx, dy } pixels accumulated since last call,
//                           then zeroed. Accumulates only while locked.
//   firing        (bool)  — LMB currently held (while locked).
//   aiming        (bool)  — RMB currently held (while locked).
//   requestLock()         — request pointer lock on game.canvas.
//   update(dt)            — clears one-frame state (wheel, just-pressed).
//
// Events emitted on game.events:
//   'input:keydown'   { key }     lowercased, physical press only (no repeat)
//   'input:mousedown' { button }  only while locked (0 left, 2 right)
//   'input:mouseup'   { button }  only while locked
//   'input:wheel'     { dir }     +1 down / -1 up, only while locked
//   'input:lock' / 'input:unlock' on pointer-lock change (lock simulated in
//                                 debug mode)
//
// Design notes:
//  - Every listener is attached to `window` (bubble phase) so synthetic
//    events dispatched by automated tests (`new KeyboardEvent(...,
//    { bubbles: true })` etc.) are observed exactly like real input.
//  - Auto-repeat keydown is filtered twice: via `e.repeat` AND via the
//    held-key set (covers synthetic events that forget the repeat flag).
//  - Tab always preventDefault()s (never lose focus to the address bar);
//    space / quote / slash / arrows / alt are suppressed while locked so the
//    page never scrolls or opens quick-find mid-firefight.
//  - contextmenu over the canvas (or while locked) is suppressed so RMB
//    aiming never pops a menu.
//  - Pointer-lock is requested with { unadjustedMovement: true } for raw,
//    accel-free mouse input (falls back cleanly where unsupported).
//  - Huge single-event movement spikes (a known Chromium pointer-lock bug)
//    are discarded in real mode; debug mode accepts anything so tests can
//    fling the view with one large synthetic mousemove.
//  - Window blur / tab-hide / unlock release all held keys and buttons so
//    nothing ever sticks (with matching 'input:mouseup' emissions while the
//    lock is still considered active, keeping listener state consistent —
//    e.g. a wound-up grenade gets its release event).
//  - Zero allocation in per-frame paths: consumeLook() returns a reused
//    object, update() only clears sets/counters.
// ---------------------------------------------------------------------------

// Keys whose browser default is suppressed while the pointer is locked.
const PREVENT_WHILE_LOCKED = new Set([
  ' ',          // page scroll
  "'", '/',     // Firefox quick-find
  'alt',        // menu-bar focus
  'arrowup', 'arrowdown', 'arrowleft', 'arrowright',
]);

// Real-mode spike filter: a legit pointer-lock mousemove is far below this.
const MOVE_SPIKE_PX = 500;

// Wheel: accumulate normalized deltaY and emit one step per threshold cross.
// One discrete notch (~100-120) always yields exactly one 'input:wheel'.
const WHEEL_STEP = 25;
const WHEEL_STALE_MS = 200;

export default class Input {
  constructor(game) {
    this.game = game;

    // --- public state -----------------------------------------------------
    this.locked = false;
    this.firing = false;
    this.aiming = false;

    // --- private state ----------------------------------------------------
    this._down = new Set();          // normalized keys currently held
    this._justPressed = new Set();   // pressed since last update() (one-frame)
    this._buttonsDown = new Set();   // mouse buttons currently held
    this._dx = 0;                    // accumulated look, pixels
    this._dy = 0;
    this._lookOut = { dx: 0, dy: 0 };// reused return object (no per-frame GC)
    this._wheelAcc = 0;
    this._wheelDir = 0;              // one-frame wheel state (cleared in update)
    this._wheelTime = 0;
    this._warnedLockError = false;

    // Bind handlers once so add/removeEventListener stay symmetric.
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onMouseDown = this._onMouseDown.bind(this);
    this._onMouseUp = this._onMouseUp.bind(this);
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onWheel = this._onWheel.bind(this);
    this._onContextMenu = this._onContextMenu.bind(this);
    this._onPointerLockChange = this._onPointerLockChange.bind(this);
    this._onPointerLockError = this._onPointerLockError.bind(this);
    this._onBlur = this._onBlur.bind(this);
    this._onVisibility = this._onVisibility.bind(this);

    // Listen on window so synthetic events (bubbles: true) reach us in tests.
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('mousemove', this._onMouseMove);
    // passive: false — we preventDefault() wheel while locked.
    window.addEventListener('wheel', this._onWheel, { passive: false });
    window.addEventListener('contextmenu', this._onContextMenu);
    window.addEventListener('blur', this._onBlur);

    document.addEventListener('pointerlockchange', this._onPointerLockChange);
    document.addEventListener('pointerlockerror', this._onPointerLockError);
    document.addEventListener('visibilitychange', this._onVisibility);

    // Debug/test convenience: when the match auto-starts (rounds emits the
    // same flow as clicking START), simulate the lock immediately so tests
    // can drive the game without a click. Harmless outside debug (no-op).
    if (game && game.events && typeof game.events.on === 'function') {
      game.events.on('ui:start', () => {
        if (this.game.debug && !this.locked) this.requestLock();
      });
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** True while `key` (normalized: 'w', ' ', 'shift', 'control', ...) is held. */
  isDown(key) {
    return this._down.has(key);
  }

  /**
   * Accumulated mouse look since last call, in pixels; zeroed on read.
   * Returns a reused object — read dx/dy immediately (clone if kept).
   */
  consumeLook() {
    const out = this._lookOut;
    out.dx = this._dx;
    out.dy = this._dy;
    this._dx = 0;
    this._dy = 0;
    return out;
  }

  /** Request pointer lock on the game canvas (simulated in debug mode). */
  requestLock() {
    if (this.locked) return;

    if (this.game.debug) {
      // Simulated lock: no real pointer capture, but the input pipeline
      // behaves exactly as if locked (synthetic events drive the game).
      this.locked = true;
      this._dx = 0;
      this._dy = 0;
      this.game.events.emit('input:lock');
      return;
    }

    const canvas = this._canvas();
    if (!canvas || typeof canvas.requestPointerLock !== 'function') return;

    // Prefer raw (unadjusted) movement for accel-free FPS aim; retry plain
    // if the browser rejects the option. Both paths swallow rejections —
    // Chrome throttles relock attempts right after an Escape-unlock and we
    // do not want an unhandled promise rejection for that.
    try {
      const p = canvas.requestPointerLock({ unadjustedMovement: true });
      if (p && typeof p.catch === 'function') {
        p.catch(() => {
          try {
            const p2 = canvas.requestPointerLock();
            if (p2 && typeof p2.catch === 'function') p2.catch(() => {});
          } catch (_) { /* ignored */ }
        });
      }
    } catch (_) {
      try {
        const p2 = canvas.requestPointerLock();
        if (p2 && typeof p2.catch === 'function') p2.catch(() => {});
      } catch (_2) { /* ignored */ }
    }
  }

  /** Runs last in the frame loop — clears one-frame state. */
  update(dt) { // eslint-disable-line no-unused-vars
    if (this._justPressed.size > 0) this._justPressed.clear();
    this._wheelDir = 0;
    // Drop a stale partial wheel accumulation (e.g. trackpad micro-scroll
    // that never crossed the threshold) so it cannot combine with a scroll
    // seconds later.
    if (this._wheelAcc !== 0 && performance.now() - this._wheelTime > WHEEL_STALE_MS) {
      this._wheelAcc = 0;
    }
  }

  // -------------------------------------------------------------------------
  // Keyboard
  // -------------------------------------------------------------------------

  _onKeyDown(e) {
    const key = this._normalizeKey(e);
    if (key === null) return;

    // Tab is ALWAYS suppressed (spec) — it is the scoreboard key and must
    // never move focus. Other game-conflicting defaults only while locked,
    // and never when a browser chord (Cmd/Ctrl+key) is being pressed.
    // (preventDefault guarded: bare-bones synthetic events may lack it.)
    const canPrevent = typeof e.preventDefault === 'function';
    if (key === 'tab') {
      if (canPrevent) e.preventDefault();
    } else if (
      this.locked &&
      !e.metaKey &&
      !(e.ctrlKey && key !== 'control') &&
      PREVENT_WHILE_LOCKED.has(key)
    ) {
      if (canPrevent) e.preventDefault();
    }

    // Auto-repeat guard: browser flag first, held-set second (synthetic
    // events dispatched by tests may omit `repeat` on held-key repeats).
    if (e.repeat) return;
    if (this._down.has(key)) return;

    this._down.add(key);
    this._justPressed.add(key);
    this.game.events.emit('input:keydown', { key });
  }

  _onKeyUp(e) {
    const key = this._normalizeKey(e);
    if (key === null) return;
    this._down.delete(key);
  }

  /**
   * Normalize a KeyboardEvent to the spec's key space using
   * e.key.toLowerCase(): single lowercase chars, ' ' for space, and named
   * keys like 'shift' / 'control' / 'tab' / 'escape'.
   */
  _normalizeKey(e) {
    const k = e.key;
    if (k === undefined || k === null) return null;
    if (k === ' ' || k === 'Spacebar') return ' '; // legacy alias, same key
    return String(k).toLowerCase();
  }

  // -------------------------------------------------------------------------
  // Mouse
  // -------------------------------------------------------------------------

  _onMouseDown(e) {
    if (!this.locked) {
      // Clicking the canvas while unlocked captures the mouse. In debug the
      // simulated lock engages on any click (tests dispatch on window, where
      // the target can never be the canvas). The locking click itself is
      // swallowed — it must not fire the weapon.
      const canvas = this._canvas();
      if ((canvas && e.target === canvas) || this.game.debug) {
        this.requestLock();
      }
      return;
    }

    // Middle-click autoscroll would fight the camera — kill it.
    if (e.button === 1 && typeof e.preventDefault === 'function') e.preventDefault();

    const button = e.button | 0;
    this._buttonsDown.add(button);
    if (button === 0) this.firing = true;
    else if (button === 2) this.aiming = true;
    this.game.events.emit('input:mousedown', { button });
  }

  _onMouseUp(e) {
    const button = e.button | 0;
    const wasDown = this._buttonsDown.delete(button);
    // Held-state always clears (even if the lock dropped mid-hold) so
    // firing/aiming can never stick.
    if (button === 0) this.firing = false;
    else if (button === 2) this.aiming = false;
    // The event itself only exists inside the lock (spec), and only for
    // presses we actually saw go down — a stray mouseup (e.g. the release
    // of the click that acquired the lock) is not a game event.
    if (this.locked && wasDown) {
      this.game.events.emit('input:mouseup', { button });
    }
  }

  _onMouseMove(e) {
    if (!this.locked) return; // only accumulate while locked (spec)

    const mx = typeof e.movementX === 'number' ? e.movementX : 0;
    const my = typeof e.movementY === 'number' ? e.movementY : 0;
    if (!Number.isFinite(mx) || !Number.isFinite(my)) return;

    // Chromium occasionally reports a massive one-event spike when the OS
    // cursor re-syncs; discarding beats a violent view snap. Debug mode
    // skips the filter so tests may look around with one big delta.
    if (!this.game.debug && (Math.abs(mx) > MOVE_SPIKE_PX || Math.abs(my) > MOVE_SPIKE_PX)) {
      return;
    }

    this._dx += mx;
    this._dy += my;
  }

  _onWheel(e) {
    if (!this.locked) return;
    if (typeof e.preventDefault === 'function') e.preventDefault();

    // Normalize delta across deltaMode (0 pixels / 1 lines / 2 pages).
    let dy = e.deltaY;
    if (!Number.isFinite(dy) || dy === 0) return;
    if (e.deltaMode === 1) dy *= 33;
    else if (e.deltaMode === 2) dy *= 120;

    const now = performance.now();
    if (now - this._wheelTime > WHEEL_STALE_MS) this._wheelAcc = 0;
    this._wheelTime = now;

    this._wheelAcc += dy;
    if (Math.abs(this._wheelAcc) >= WHEEL_STEP) {
      const dir = this._wheelAcc > 0 ? 1 : -1;
      this._wheelAcc = 0; // full reset: one notch == exactly one step
      this._wheelDir = dir;
      this.game.events.emit('input:wheel', { dir });
    }
  }

  _onContextMenu(e) {
    // Never let RMB-aim pop a context menu: suppress over the canvas and
    // any time the (real or simulated) lock is active.
    const canvas = this._canvas();
    if (this.locked || (canvas && e.target === canvas)) {
      if (typeof e.preventDefault === 'function') e.preventDefault();
    }
  }

  // -------------------------------------------------------------------------
  // Pointer lock lifecycle
  // -------------------------------------------------------------------------

  _onPointerLockChange() {
    // Debug mode's lock is simulated and owns `locked` — a real
    // pointerlockchange (there should never be one) must not fight it.
    if (this.game.debug) return;

    const canvas = this._canvas();
    const nowLocked = !!canvas && document.pointerLockElement === canvas;
    if (nowLocked === this.locked) return;

    if (nowLocked) {
      // Discard any motion that accumulated in the same tick as the grab so
      // the view does not jerk on entry.
      this._dx = 0;
      this._dy = 0;
      this.locked = true;
      this.game.events.emit('input:lock');
    } else {
      // Release everything BEFORE flipping the flag so the matching
      // 'input:mouseup' events are still delivered "while locked" and
      // listeners (grenade wind-up, spray state, ...) unwind cleanly.
      this._releaseAll(true);
      this.locked = false;
      this.game.events.emit('input:unlock');
    }
  }

  _onPointerLockError() {
    if (!this._warnedLockError) {
      this._warnedLockError = true;
      console.warn('[input] pointer lock request was rejected by the browser');
    }
  }

  _onBlur() {
    // Alt-tab away: drop all held state so nothing sticks on return.
    this._releaseAll(this.locked);
  }

  _onVisibility() {
    if (document.visibilityState === 'hidden') {
      this._releaseAll(this.locked);
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Lazy canvas lookup (defensive about construction order). */
  _canvas() {
    return (this.game && this.game.canvas) || null;
  }

  /**
   * Clear every held key/button and pending accumulations. When
   * `emitMouseups` is true, emit 'input:mouseup' for each held button first
   * so event-driven listeners stay consistent with `firing`/`aiming`.
   */
  _releaseAll(emitMouseups) {
    if (emitMouseups && this._buttonsDown.size > 0) {
      for (const button of this._buttonsDown) {
        this.game.events.emit('input:mouseup', { button });
      }
    }
    this._buttonsDown.clear();
    this.firing = false;
    this.aiming = false;
    this._down.clear();
    this._justPressed.clear();
    this._dx = 0;
    this._dy = 0;
    this._wheelAcc = 0;
    this._wheelDir = 0;
  }
}
