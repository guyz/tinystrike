// ============================================================================
// OPERATION GOLDENEYE — src/ui/hud.js
// The entire 2D layer: status panels, ammo, money, timer/scores, killfeed,
// rotating radar, dynamic crosshair, hitmarkers, damage feedback, flash
// whiteout, AWP scope, buy menu, scoreboard, round messages, defuse bar,
// death overlay, main menu, pause overlay and game-end screen.
// CS 1.6-flavored styling: translucent dark panels, olive-green text,
// condensed bold system fonts. No external assets.
// ============================================================================

import * as THREE from 'three';

const clamp = THREE.MathUtils.clamp;

// ---------------------------------------------------------------------------
// Static data (fallbacks — live names/prices are pulled from weapons/data.js
// via a dynamic import so the HUD still works against stubs).
// ---------------------------------------------------------------------------

const FALLBACK_NAMES = {
  knife: 'Knife',
  glock: 'G-18',
  usp: 'USP-S',
  deagle: 'Night Hawk',
  mp5: 'MP-5',
  ak47: 'AK-47',
  m4a1: 'M4-A1',
  awp: 'AWP',
  hegrenade: 'HE Grenade',
  flashbang: 'Flashbang',
  smokegrenade: 'Smoke',
  armor: 'Kevlar Vest',
  kit: 'Defuse Kit',
};

const FALLBACK_PRICES = {
  glock: 200, usp: 200, deagle: 700, mp5: 1500,
  ak47: 2700, m4a1: 3100, awp: 4750,
  hegrenade: 300, flashbang: 200, smokegrenade: 300,
};

const FALLBACK_BUY = [
  { category: 'Pistols', items: ['glock', 'usp', 'deagle'] },
  { category: 'SMG', items: ['mp5'] },
  { category: 'Rifles', items: ['ak47', 'm4a1', 'awp'] },
  { category: 'Gear', items: ['armor', 'kit'] },
  { category: 'Grenades', items: ['hegrenade', 'flashbang', 'smokegrenade'] },
];

const CONTROLS = [
  ['W A S D', 'Move'],
  ['MOUSE', 'Aim'],
  ['LMB', 'Fire'],
  ['RMB', 'Scope (AWP)'],
  ['R', 'Reload'],
  ['B', 'Buy Menu'],
  ['E', 'Defuse Bomb'],
  ['SHIFT', 'Walk'],
  ['CTRL', 'Crouch'],
  ['SPACE', 'Jump'],
  ['TAB', 'Scoreboard'],
  ['1 – 4', 'Weapons'],
];

const MATCH_PHASES = { freeze: 1, live: 1, planted: 1, roundEnd: 1 };

const SVG_CROSS =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
  '<path fill="currentColor" d="M9 2h6v7h7v6h-7v7H9v-7H2V9h7z"/></svg>';
const SVG_SHIELD =
  '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">' +
  '<path fill="currentColor" d="M12 1l9 4v6c0 5.6-3.8 10.5-9 12-5.2-1.5-9-6.4-9-12V5z"/></svg>';

// Radar tuning
const RADAR_SIZE = 140;          // CSS pixels
const RADAR_RANGE = 38;          // meters shown from center to edge
const RADAR_EDGE = RADAR_SIZE / 2 - 7;
const RADAR_SCALE = RADAR_EDGE / RADAR_RANGE;
const ENEMY_SPOT_DIST = 25;      // meters — enemy blip always shown inside this
const ENEMY_FIRE_MEMORY = 2;     // seconds an enemy shot keeps them on radar
const ENEMY_FIRE_MATCH = 3.5;    // meters — blip↔shot position association

// scratch object for radar blip clamping (no per-frame allocation)
const RT = { x: 0, y: 0, cl: false };
// fallback radar bounds until the world module is available
const FALLBACK_RB = { minX: -52, maxX: 52, minZ: -42, maxZ: 42 };

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ============================================================================

export default class HUD {
  constructor(game) {
    this.game = game;

    this._root = null;
    this._built = false;
    this._el = {};

    // clocks / timers
    this._time = 0;
    this._radarTimer = 0;
    this._fpsTimer = 0;

    // interaction state
    this._locked = false;
    this._buyOpen = false;
    this._buyMoney = -1;
    this._lastBuyToggle = 0;
    this._pauseShown = false;

    // combat feedback state
    this._dmg = 0;               // damage vignette energy
    this._dmgOpacity = -1;
    this._flash = null;          // { i, dur, t }
    this._flashOpacity = -1;
    this._hit = null;            // { t, dur }
    this._wedges = [];           // pooled damage-direction wedges
    this._enemyFire = [];        // recent enemy shot positions for radar

    // feed / stats
    this._feed = [];
    this._stats = new Map();
    this._sbDirty = true;
    this._sbVisible = false;
    this._deathKiller = '';
    this._endInfo = null;

    // scope
    this._scopeShown = false;
    this._scopeLevel = -1;
    this._scopeFov = 0;

    // radar bounds cache
    this._rb = null;
    this._radarCtx = null;
    this._radarDpr = 1;

    // cached DOM values — only touch the DOM when these change
    this._cache = {
      phase: null, hp: -1, hpLow: null, armor: -1, armorVis: null,
      money: -1, mag: null, reserve: null, magLow: null, wname: null,
      timerSec: -1, timerRed: null, bombIco: null,
      scoreCt: -1, scoreT: -1, round: -1,
      gap: -1, crossVis: null, dead: null,
      defuse: -1, defuseVis: null, hintVis: null, kitNote: null,
      reloading: false, fps: '',
    };

    // message
    this._msgUntil = -1;

    // buy data (fallbacks now, real data async)
    this._names = { ...FALLBACK_NAMES };
    this._prices = {
      ...FALLBACK_PRICES,
      armor: game?.config?.ECON?.ARMOR_PRICE ?? 650,
      kit: game?.config?.ECON?.KIT_PRICE ?? 400,
    };
    this._buyCats = FALLBACK_BUY.map((c) => ({ category: c.category, items: c.items.slice() }));
    this._buyRows = [];
    this._loadWeaponData();

    if (game && game.hudRoot) this._build(game.hudRoot);
    this._bindEvents();
  }

  // Public — weapons module may peek at this.
  get buyOpen() { return this._buyOpen; }

  // --------------------------------------------------------------------------
  // Data loading
  // --------------------------------------------------------------------------

  _loadWeaponData() {
    import('../weapons/data.js').then((m) => {
      if (m && m.WEAPONS && typeof m.WEAPONS === 'object') {
        for (const id in m.WEAPONS) {
          const w = m.WEAPONS[id];
          if (!w) continue;
          if (w.name) this._names[id] = w.name;
          if (Number.isFinite(w.price)) this._prices[id] = w.price;
        }
      }
      if (m && Array.isArray(m.BUY_MENU) && m.BUY_MENU.length) {
        const cats = m.BUY_MENU
          .filter((c) => c && c.category && Array.isArray(c.items) && c.items.length)
          .map((c) => ({ category: c.category, items: c.items.slice() }));
        if (cats.length) {
          const hasGear = cats.some((c) => c.items.indexOf('armor') !== -1 || c.items.indexOf('kit') !== -1);
          if (!hasGear) cats.push({ category: 'Gear', items: ['armor', 'kit'] });
          this._buyCats = cats;
        }
      }
      if (this._built && this._el.buyCats) this._buildBuyRows();
    }).catch(() => { /* fallback tables remain in use */ });
  }

  // --------------------------------------------------------------------------
  // DOM construction
  // --------------------------------------------------------------------------

  _build(root) {
    if (this._built) return;
    this._built = true;
    this._root = root;
    root.style.pointerEvents = 'none';

    const style = document.createElement('style');
    style.id = 'hud-style';
    style.textContent = this._css();
    root.appendChild(style);

    root.insertAdjacentHTML('beforeend', this._html());

    const $ = (id) => root.querySelector('#' + id);
    this._el = {
      game: $('hud-game'),
      healthNum: $('hud-health-num'),
      healthBox: $('hud-health'),
      armorBox: $('hud-armor'),
      armorNum: $('hud-armor-num'),
      moneyBox: $('hud-money'),
      moneyNum: $('hud-money-num'),
      ammoBox: $('hud-ammo'),
      ammoMag: $('hud-ammo-mag'),
      ammoRes: $('hud-ammo-reserve'),
      weaponName: $('hud-weapon-name'),
      reload: $('hud-reload'),
      timerNum: $('hud-timer-num'),
      bombIco: $('hud-bomb-ico'),
      scoreCt: $('hud-score-ct'),
      scoreT: $('hud-score-t'),
      round: $('hud-round'),
      feed: $('hud-killfeed'),
      radar: $('hud-radar'),
      radarCanvas: $('hud-radar-canvas'),
      crosshair: $('hud-crosshair'),
      chL: $('hud-ch-l'), chR: $('hud-ch-r'), chT: $('hud-ch-t'), chB: $('hud-ch-b'),
      hitmarker: $('hud-hitmarker'),
      killcue: $('hud-killcue'),
      killcueMain: $('hud-killcue-main'),
      killcueName: $('hud-killcue-name'),
      vignette: $('hud-vignette'),
      wedges: $('hud-wedges'),
      flash: $('hud-flash'),
      scope: $('hud-scope'),
      scopeZoom: $('hud-scope-zoom'),
      msg: $('hud-msg'),
      msgMain: $('hud-msg-main'),
      msgSub: $('hud-msg-sub'),
      defuse: $('hud-defuse'),
      defuseFill: $('hud-defuse-fill'),
      defuseNote: $('hud-defuse-note'),
      useHint: $('hud-usehint'),
      death: $('hud-death'),
      deathKiller: $('hud-death-killer'),
      scoreboard: $('hud-scoreboard'),
      sbScore: $('hud-sb-score'),
      sbBody: $('hud-sb-body'),
      buy: $('hud-buy'),
      buyCats: $('hud-buy-cats'),
      buyFunds: $('hud-buy-funds'),
      menu: $('hud-menu'),
      start: $('hud-start'),
      pause: $('hud-pause'),
      end: $('hud-end'),
      endTitle: $('hud-end-title'),
      endSub: $('hud-end-sub'),
      endScore: $('hud-end-score'),
      endKd: $('hud-end-kd'),
      restart: $('hud-restart'),
      fps: $('hud-fps'),
    };

    // wedge pool
    for (let i = 0; i < 4; i++) {
      const w = document.createElement('div');
      w.className = 'hud-wedge';
      this._el.wedges.appendChild(w);
      this._wedges.push({ el: w, yaw: 0, ttl: 0, visible: false });
    }

    // radar backing store
    const dpr = this._radarDpr = Math.min(window.devicePixelRatio || 1, 2);
    const rc = this._el.radarCanvas;
    if (rc) {
      rc.width = RADAR_SIZE * dpr;
      rc.height = RADAR_SIZE * dpr;
      this._radarCtx = rc.getContext('2d');
    }

    this._buildBuyRows();

    // interactive bits
    if (this._el.start) {
      this._el.start.addEventListener('click', () => {
        this.game.events.emit('ui:start');
        if (this.game.input && typeof this.game.input.requestLock === 'function') {
          this.game.input.requestLock();
        }
      });
    }
    if (this._el.restart) {
      this._el.restart.addEventListener('click', () => {
        this._stats.clear();
        this._sbDirty = true;
        this._clearFeed();
        this._endInfo = null;
        this.game.events.emit('ui:restart');
        if (this.game.input && typeof this.game.input.requestLock === 'function') {
          this.game.input.requestLock();
        }
      });
    }
    if (this._el.pause) {
      this._el.pause.addEventListener('click', () => {
        if (this.game.input && typeof this.game.input.requestLock === 'function') {
          this.game.input.requestLock();
        }
      });
    }

    // initial visibility matches phase 'menu' until first update flips it
    if (this._el.game) this._el.game.style.display = 'none';
    if (this._el.menu) this._el.menu.style.display = 'flex';
  }

  // --------------------------------------------------------------------------
  // Event wiring
  // --------------------------------------------------------------------------

  _bindEvents() {
    const ev = this.game && this.game.events;
    if (!ev) return;

    ev.on('kill', (d) => this._onKill(d || {}));
    ev.on('hud:hitmarker', (d) => this._onHitmarker(d || {}));
    ev.on('player:damage', (d) => this._onPlayerDamage(d || {}));
    ev.on('player:death', (d) => this._onPlayerDeath(d || {}));
    ev.on('hud:flash', (d) => this._onFlash(d || {}));
    ev.on('weapon:scope', (d) => { if (d) { this._scopeFov = d.fov || 0; } });
    ev.on('weapon:reload:start', () => this._setReloading(true));
    ev.on('weapon:reload:end', () => this._setReloading(false));
    ev.on('weapon:equip', () => this._setReloading(false));
    ev.on('round:start', () => this._onRoundStart());
    ev.on('round:phase', (d) => this._onRoundPhase(d || {}));
    ev.on('round:end', (d) => this._onRoundEnd(d || {}));
    ev.on('game:end', (d) => { this._endInfo = d || null; });
    ev.on('econ:kill', (d) => this._moneyPop(d && d.reward));
    ev.on('ui:toggle-buy', () => this._toggleBuy());
    ev.on('input:lock', () => {
      this._locked = true;
      if (this._buyOpen) this._setBuyOpen(false, false); // clicked back into the game
    });
    ev.on('input:unlock', () => { this._locked = false; });
    ev.on('bot:fire', (d) => this._onBotFire(d || {}));
    ev.on('bot:death', () => { this._sbDirty = true; });

    // Backup key handling while the buy menu is open (pointer unlocked, the
    // input module may or may not route keys then). Debounced against the
    // 'ui:toggle-buy' the weapons module emits for the same keydown.
    this._onKeydownDom = (e) => {
      if (!this._buyOpen) return;
      const k = (e.key || '').toLowerCase();
      if (k === 'escape' || k === 'b') {
        e.preventDefault();
        // 'b' is already routed by the weapons module (input emits keydown
        // even while unlocked), so only Escape needs the fallback emission —
        // emitting for both would double audio's UI click.
        if (k === 'escape') ev.emit('ui:toggle-buy');
      }
    };
    window.addEventListener('keydown', this._onKeydownDom);
  }

  // --------------------------------------------------------------------------
  // Per-frame update
  // --------------------------------------------------------------------------

  update(dt) {
    if (!this._built) {
      const r = (this.game && this.game.hudRoot) || document.getElementById('hud');
      if (!r) return;
      this._build(r);
    }
    this._time += dt;

    const g = this.game;
    const st = (g && g.state) || {};
    const phase = st.phase || 'menu';

    if (phase !== this._cache.phase) this._onPhaseChange(phase);
    const inGame = phase !== 'menu' && phase !== 'gameEnd';

    if (inGame) {
      this._updateStats(st);
      this._updateAmmo();
      this._updateTop(st, phase);
      this._updateCrosshair(phase);
      this._updateFeed();
      this._updateDefuse(st, phase);
      this._updateScope();
      this._updateDeath(phase);
      this._updateScoreboard(phase);
      this._updateBuy(st);

      this._radarTimer += dt;
      if (this._radarTimer >= 0.05) {         // ~20 Hz
        this._radarTimer %= 0.05;
        this._drawRadar(st);
      }
    }

    this._updateOverlays(dt);
    this._updateMsg();
    this._updatePause(phase);
    if (g && g.debug) this._updateFps(dt);
  }

  // --------------------------------------------------------------------------
  // Phase transitions
  // --------------------------------------------------------------------------

  _onPhaseChange(phase) {
    this._cache.phase = phase;
    const el = this._el;
    const inGame = phase !== 'menu' && phase !== 'gameEnd';

    if (el.game) el.game.style.display = inGame ? 'block' : 'none';
    if (el.menu) el.menu.style.display = phase === 'menu' ? 'flex' : 'none';

    if (phase === 'gameEnd') {
      // Release the pointer so the RESTART button is actually clickable.
      if (!this.game.debug && document.pointerLockElement && document.exitPointerLock) {
        document.exitPointerLock();
      }
      this._fillEndScreen();
      if (el.end) el.end.style.display = 'flex';
    } else if (el.end) {
      el.end.style.display = 'none';
    }

    if (!inGame && this._buyOpen) this._setBuyOpen(false, false);
    if (phase === 'menu') {
      this._deathKiller = '';
      this._cache.dead = null;
    }
  }

  _onRoundStart() {
    this._sbDirty = true;
    this._dmg = 0;
    this._deathKiller = '';
    this._cache.dead = null;
    this._enemyFire.length = 0;
    for (const w of this._wedges) w.ttl = 0;
    if (this._el.death) this._el.death.style.display = 'none';
  }

  _onRoundPhase(d) {
    const cfg = (this.game && this.game.config) || {};
    switch (d.phase) {
      case 'freeze': {
        const dur = Math.max(1.5, (cfg.MATCH && cfg.MATCH.FREEZE_TIME || 6) - 0.5);
        this._showMsg('BUY PHASE', 'PRESS B TO BUY EQUIPMENT', dur);
        break;
      }
      case 'live':
        this._showMsg('GO GO GO!', '', 1.3);
        break;
      case 'planted': {
        const fuse = (cfg.MATCH && cfg.MATCH.BOMB_TIME) || 40;
        const site = d.site ? ('SITE ' + String(d.site).toUpperCase() + ' — ') : '';
        this._showMsg('THE BOMB HAS BEEN PLANTED', site + fuse + ' SECONDS TO DETONATION', 3.2);
        break;
      }
      default:
        break;
    }
  }

  _onRoundEnd(d) {
    this._sbDirty = true;
    const st = (this.game && this.game.state) || {};
    const winRounds = (this.game && this.game.config && this.game.config.MATCH &&
      this.game.config.MATCH.WIN_ROUNDS) || 8;
    const main = d.winner === 'ct' ? 'COUNTER-TERRORISTS WIN' : 'TERRORISTS WIN';
    const reasons = {
      elimination: 'ENEMY TEAM ELIMINATED',
      time: 'TIME RAN OUT',
      bomb: 'THE BOMB HAS DETONATED',
      defuse: 'THE BOMB HAS BEEN DEFUSED',
    };
    let sub = reasons[d.reason] || '';
    const sc = st.scores || {};
    if (sc.ct === winRounds - 1 || sc.t === winRounds - 1) {
      sub += (sub ? '  ·  ' : '') + 'MATCH POINT';
    }
    this._showMsg(main, sub, 3.6);
  }

  // --------------------------------------------------------------------------
  // Combat feedback handlers
  // --------------------------------------------------------------------------

  _onKill(d) {
    const killer = d.killerName || '?';
    const victim = d.victimName || '?';
    this._stat(killer).k += 1;
    this._stat(victim).d += 1;
    this._sbDirty = true;
    this._addFeed(d);
    if (d.killerName === 'You') this._showKillCue(d);
  }

  _showKillCue(d) {
    const el = this._el.killcue;
    if (!el) return;
    const hs = !!d.headshot;
    el.classList.toggle('hs', hs);
    if (this._el.killcueMain) this._el.killcueMain.textContent = hs ? 'HEADSHOT KILL' : 'ENEMY DOWN';
    if (this._el.killcueName) {
      this._el.killcueName.textContent = '✕  ' + (d.victimName || '');
    }
    // Retrigger the pop animation from the start.
    el.classList.remove('show');
    void el.offsetWidth; // force reflow so the animation replays
    el.classList.add('show');
  }

  _onHitmarker(d) {
    const el = this._el.hitmarker;
    if (!el) return;
    const dur = d.kill ? 0.42 : 0.26;
    const scale = d.headshot ? 1.55 : (d.kill ? 1.25 : 1.0);
    el.classList.toggle('kill', !!d.kill);
    el.style.transform = 'rotate(45deg) scale(' + scale + ')';
    el.style.opacity = '1';
    this._hit = { t: dur, dur };
  }

  _onPlayerDamage(d) {
    const amount = Number.isFinite(d.amount) ? d.amount : 15;
    this._dmg = Math.min(0.8, this._dmg + 0.16 + amount / 90);
    if (typeof d.dirYaw === 'number') {
      // grab the most-expired wedge from the pool
      let slot = this._wedges[0];
      for (const w of this._wedges) if (w.ttl < slot.ttl) slot = w;
      slot.yaw = d.dirYaw;
      slot.ttl = 1.0;
    }
  }

  _onPlayerDeath(d) {
    const k = d && d.killer;
    this._deathKiller = (k && k.name) ? k.name : (typeof k === 'string' ? k : '');
    this._sbDirty = true;
  }

  _onFlash(d) {
    const i = clamp(Number.isFinite(d.intensity) ? d.intensity : 1, 0, 1);
    const dur = Math.max(0.15, Number.isFinite(d.duration) ? d.duration : 2.5);
    // keep the stronger of overlapping flashes
    if (!this._flash || i * (dur) > this._flash.i * (this._flash.dur - this._flash.t)) {
      this._flash = { i, dur, t: 0 };
    }
  }

  _onBotFire(d) {
    const bot = d.bot;
    if (!bot || !bot.pos || bot.team === 'ct') return;
    const list = this._enemyFire;
    list.push({ x: bot.pos.x, z: bot.pos.z, t: this._time });
    if (list.length > 16) list.shift();
  }

  _setReloading(on) {
    if (on === this._cache.reloading) return;
    this._cache.reloading = on;
    if (this._el.reload) this._el.reload.style.display = on ? 'block' : 'none';
  }

  // --------------------------------------------------------------------------
  // Status panels
  // --------------------------------------------------------------------------

  _updateStats(st) {
    const c = this._cache;
    const p = this.game.player;

    const hp = Math.max(0, Math.round((p && Number.isFinite(p.health)) ? p.health : 100));
    if (hp !== c.hp) {
      c.hp = hp;
      if (this._el.healthNum) this._el.healthNum.textContent = String(hp);
    }
    const low = hp > 0 && hp <= 25;
    if (low !== c.hpLow) {
      c.hpLow = low;
      if (this._el.healthBox) this._el.healthBox.classList.toggle('low', low);
    }

    const ar = Math.max(0, Math.round((p && Number.isFinite(p.armor)) ? p.armor : 0));
    if (ar !== c.armor) {
      c.armor = ar;
      if (this._el.armorNum) this._el.armorNum.textContent = String(ar);
    }
    const arVis = ar > 0;
    if (arVis !== c.armorVis) {
      c.armorVis = arVis;
      if (this._el.armorBox) this._el.armorBox.style.display = arVis ? 'flex' : 'none';
    }

    const money = Math.max(0, Math.round(Number.isFinite(st.money) ? st.money : 0));
    if (money !== c.money) {
      c.money = money;
      if (this._el.moneyNum) this._el.moneyNum.textContent = String(money);
      if (this._el.moneyBox) {
        this._el.moneyBox.classList.remove('pulse');
        void this._el.moneyBox.offsetWidth; // restart animation (rare — on change only)
        this._el.moneyBox.classList.add('pulse');
      }
    }
  }

  _updateAmmo() {
    const c = this._cache;
    const w = this.game.weapons;
    const def = (w && typeof w.current === 'function') ? w.current() : null;
    const ammo = (w && typeof w.currentAmmo === 'function') ? w.currentAmmo() : null;

    const name = (def && def.name) ? def.name : '';
    if (name !== c.wname) {
      c.wname = name;
      if (this._el.weaponName) this._el.weaponName.textContent = name;
    }

    const mag = (ammo && Number.isFinite(ammo.mag)) ? ammo.mag : null;
    const res = (ammo && Number.isFinite(ammo.reserve)) ? ammo.reserve : null;
    if (mag !== c.mag) {
      c.mag = mag;
      if (this._el.ammoMag) this._el.ammoMag.textContent = mag === null ? '—' : String(mag);
    }
    if (res !== c.reserve) {
      c.reserve = res;
      if (this._el.ammoRes) this._el.ammoRes.textContent = res === null ? '' : '/ ' + res;
    }
    const magLow = mag !== null && def && Number.isFinite(def.magSize) &&
      mag <= Math.max(1, Math.ceil(def.magSize * 0.25));
    if (magLow !== c.magLow) {
      c.magLow = magLow;
      if (this._el.ammoMag) this._el.ammoMag.classList.toggle('low', !!magLow);
    }
  }

  _updateTop(st, phase) {
    const c = this._cache;
    const t = Math.max(0, Number.isFinite(st.timer) ? st.timer : 0);
    const sec = Math.floor(t);
    if (sec !== c.timerSec) {
      c.timerSec = sec;
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      if (this._el.timerNum) this._el.timerNum.textContent = m + ':' + (s < 10 ? '0' : '') + s;
    }
    const red = t < 10 && (phase === 'live' || phase === 'planted');
    if (red !== c.timerRed) {
      c.timerRed = red;
      if (this._el.timerNum) this._el.timerNum.classList.toggle('red', red);
    }
    const bombIco = phase === 'planted' || !!(st.bomb && st.bomb.planted);
    if (bombIco !== c.bombIco) {
      c.bombIco = bombIco;
      if (this._el.bombIco) this._el.bombIco.style.display = bombIco ? 'inline-block' : 'none';
    }

    const sc = st.scores || {};
    const ct = sc.ct | 0;
    const tt = sc.t | 0;
    if (ct !== c.scoreCt) {
      c.scoreCt = ct;
      if (this._el.scoreCt) this._el.scoreCt.textContent = String(ct);
      if (this._el.sbScore) this._el.sbScore.textContent = 'CT ' + ct + '  :  ' + tt + ' T';
    }
    if (tt !== c.scoreT) {
      c.scoreT = tt;
      if (this._el.scoreT) this._el.scoreT.textContent = String(tt);
      if (this._el.sbScore) this._el.sbScore.textContent = 'CT ' + ct + '  :  ' + tt + ' T';
    }

    const round = st.round | 0;
    if (round !== c.round) {
      c.round = round;
      const winRounds = (this.game.config && this.game.config.MATCH &&
        this.game.config.MATCH.WIN_ROUNDS) || 8;
      if (this._el.round) this._el.round.textContent = 'ROUND ' + round + '  ·  FIRST TO ' + winRounds;
    }
  }

  // --------------------------------------------------------------------------
  // Crosshair + hitmarker
  // --------------------------------------------------------------------------

  _updateCrosshair(phase) {
    const c = this._cache;
    const w = this.game.weapons;
    const p = this.game.player;
    const scoped = !!(w && typeof w.isScoped === 'function' && w.isScoped());

    const vis = !scoped && !this._buyOpen &&
      (p ? p.alive !== false : true) &&
      phase !== 'menu' && phase !== 'gameEnd';
    if (vis !== c.crossVis) {
      c.crossVis = vis;
      if (this._el.crosshair) this._el.crosshair.style.display = vis ? 'block' : 'none';
    }
    if (!vis) return;

    const spread = (w && typeof w.currentSpread === 'function') ? w.currentSpread() : 0.012;
    let gap = 2.5 + clamp(spread, 0, 0.085) * 900;
    gap = Math.round(gap * 2) / 2;
    if (gap !== c.gap) {
      c.gap = gap;
      const len = 8;
      if (this._el.chL) this._el.chL.style.transform = 'translate(' + (-gap - len) + 'px,0)';
      if (this._el.chR) this._el.chR.style.transform = 'translate(' + gap + 'px,0)';
      if (this._el.chT) this._el.chT.style.transform = 'translate(0,' + (-gap - len) + 'px)';
      if (this._el.chB) this._el.chB.style.transform = 'translate(0,' + gap + 'px)';
    }
  }

  // --------------------------------------------------------------------------
  // Scope overlay
  // --------------------------------------------------------------------------

  _updateScope() {
    const w = this.game.weapons;
    const scoped = !!(w && typeof w.isScoped === 'function' && w.isScoped());
    if (scoped !== this._scopeShown) {
      this._scopeShown = scoped;
      if (this._el.scope) this._el.scope.style.display = scoped ? 'block' : 'none';
    }
    if (!scoped) { this._scopeLevel = -1; return; }
    const level = (w && Number.isFinite(w.scopeLevel)) ? w.scopeLevel : 1;
    if (level !== this._scopeLevel) {
      this._scopeLevel = level;
      let text = 'ZOOM ' + level;
      const baseFov = (this.game.config && this.game.config.PLAYER && this.game.config.PLAYER.FOV) || 74;
      const fov = this._scopeFov;
      if (fov > 0 && fov < baseFov) {
        const mag = Math.tan(baseFov * Math.PI / 360) / Math.tan(fov * Math.PI / 360);
        text = mag.toFixed(1) + '×';
      }
      if (this._el.scopeZoom) this._el.scopeZoom.textContent = text;
    }
  }

  // --------------------------------------------------------------------------
  // Killfeed
  // --------------------------------------------------------------------------

  _addFeed(d) {
    if (!this._el.feed) return;
    const row = document.createElement('div');
    row.className = 'kf-entry';
    if (d.victimName === 'You') row.classList.add('kf-death');
    else if (d.killerName === 'You') row.classList.add('kf-mine');

    const wname = this._names[d.weaponId] || d.weaponId || '?';
    const kTeam = d.killerTeam === 't' ? 't' : 'ct';
    const vTeam = d.victimTeam === 't' ? 't' : 'ct';
    row.innerHTML =
      '<span class="kf-name kf-' + kTeam + '">' + esc(d.killerName || '?') + '</span>' +
      '<span class="kf-weap">[' + esc(wname) + ']</span>' +
      (d.headshot ? '<span class="kf-hs">HS</span>' : '') +
      '<span class="kf-name kf-' + vTeam + '">' + esc(d.victimName || '?') + '</span>';

    this._el.feed.appendChild(row);
    this._feed.push({ el: row, t: this._time, fading: false });
    while (this._feed.length > 5) {
      const old = this._feed.shift();
      if (old.el.parentNode) old.el.parentNode.removeChild(old.el);
    }
  }

  _updateFeed() {
    const feed = this._feed;
    for (let i = feed.length - 1; i >= 0; i--) {
      const e = feed[i];
      const age = this._time - e.t;
      if (age > 5.2) {
        if (e.el.parentNode) e.el.parentNode.removeChild(e.el);
        feed.splice(i, 1);
      } else if (age > 4.5 && !e.fading) {
        e.fading = true;
        e.el.classList.add('kf-fade');
      }
    }
  }

  _clearFeed() {
    for (const e of this._feed) if (e.el.parentNode) e.el.parentNode.removeChild(e.el);
    this._feed.length = 0;
  }

  // --------------------------------------------------------------------------
  // Radar
  // --------------------------------------------------------------------------

  _radarBounds() {
    if (this._rb) return this._rb;
    const w = this.game.world;
    if (w && Array.isArray(w.colliders) && w.colliders.length) {
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const b of w.colliders) {
        if (!b || !b.min || !b.max) continue;
        if (b.max.x - b.min.x > 300 || b.max.z - b.min.z > 300) continue; // skip mega-boxes
        if (b.min.x < minX) minX = b.min.x;
        if (b.max.x > maxX) maxX = b.max.x;
        if (b.min.z < minZ) minZ = b.min.z;
        if (b.max.z > maxZ) maxZ = b.max.z;
      }
      if (minX < maxX && minZ < maxZ) {
        this._rb = {
          minX: clamp(minX, -140, 140), maxX: clamp(maxX, -140, 140),
          minZ: clamp(minZ, -140, 140), maxZ: clamp(maxZ, -140, 140),
        };
        return this._rb;
      }
    }
    return FALLBACK_RB; // not cached — retry once real colliders exist
  }

  _clampBlip(x, y) {
    const r = Math.hypot(x, y);
    if (r > RADAR_EDGE) {
      const k = RADAR_EDGE / r;
      RT.x = x * k; RT.y = y * k; RT.cl = true;
    } else {
      RT.x = x; RT.y = y; RT.cl = false;
    }
    return RT;
  }

  _drawRadar(st) {
    const c = this._radarCtx;
    if (!c) return;
    const g = this.game;
    const dpr = this._radarDpr;
    const S = RADAR_SIZE, half = S / 2;

    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, S, S);

    // background + grid
    c.fillStyle = 'rgba(7,10,4,0.62)';
    c.fillRect(0, 0, S, S);
    c.strokeStyle = 'rgba(154,178,107,0.08)';
    c.lineWidth = 1;
    c.beginPath();
    for (let i = 20; i < S; i += 20) {
      c.moveTo(i, 0); c.lineTo(i, S);
      c.moveTo(0, i); c.lineTo(S, i);
    }
    c.stroke();

    const p = g.player;
    const px = (p && p.position) ? p.position.x : 0;
    const pz = (p && p.position) ? p.position.z : 0;
    const yaw = (p && Number.isFinite(p.yaw)) ? p.yaw : 0;

    c.save();
    c.translate(half, half);
    c.rotate(yaw); // rotate the world so the player's facing is up

    // world bounds
    const b = this._radarBounds();
    c.strokeStyle = 'rgba(154,178,107,0.35)';
    c.lineWidth = 1.2;
    c.strokeRect((b.minX - px) * RADAR_SCALE, (b.minZ - pz) * RADAR_SCALE,
      (b.maxX - b.minX) * RADAR_SCALE, (b.maxZ - b.minZ) * RADAR_SCALE);

    // active smoke clouds (combat exposes .smokes)
    const smokes = g.combat && g.combat.smokes;
    if (Array.isArray(smokes)) {
      c.fillStyle = 'rgba(170,170,170,0.22)';
      for (const s of smokes) {
        if (!s || !s.pos) continue;
        c.beginPath();
        c.arc((s.pos.x - px) * RADAR_SCALE, (s.pos.z - pz) * RADAR_SCALE,
          Math.max(2, (s.radius || 3) * RADAR_SCALE), 0, Math.PI * 2);
        c.fill();
      }
    }

    // bomb sites (label + zone outline)
    const world = g.world;
    if (world && Array.isArray(world.bombSites)) {
      for (const site of world.bombSites) {
        if (!site || !site.center) continue;
        const sx = (site.center.x - px) * RADAR_SCALE;
        const sy = (site.center.z - pz) * RADAR_SCALE;
        if (site.box && site.box.min && site.box.max) {
          c.strokeStyle = 'rgba(200,214,185,0.22)';
          c.lineWidth = 1;
          c.strokeRect((site.box.min.x - px) * RADAR_SCALE, (site.box.min.z - pz) * RADAR_SCALE,
            (site.box.max.x - site.box.min.x) * RADAR_SCALE,
            (site.box.max.z - site.box.min.z) * RADAR_SCALE);
        }
        const bl = this._clampBlip(sx, sy);
        c.save();
        c.translate(bl.x, bl.y);
        c.rotate(-yaw);
        c.font = '700 11px "Arial Narrow", Arial, sans-serif';
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillStyle = bl.cl ? 'rgba(200,214,185,0.35)' : 'rgba(200,214,185,0.85)';
        c.fillText(site.name || '?', 0, 0);
        c.restore();
      }
    }

    // planted bomb
    const bomb = st.bomb;
    if (bomb && bomb.planted && bomb.pos) {
      const bl = this._clampBlip((bomb.pos.x - px) * RADAR_SCALE, (bomb.pos.z - pz) * RADAR_SCALE);
      const pulse = 0.55 + 0.45 * Math.sin(this._time * 7);
      c.fillStyle = 'rgba(232,64,42,' + (bl.cl ? pulse * 0.5 : pulse).toFixed(3) + ')';
      c.fillRect(bl.x - 3, bl.y - 3, 6, 6);
    }

    // prune stale enemy-fire memory
    const fires = this._enemyFire;
    while (fires.length && this._time - fires[0].t > ENEMY_FIRE_MEMORY) fires.shift();

    // blips
    const bots = g.bots;
    const blips = (bots && typeof bots.getRadarBlips === 'function') ? bots.getRadarBlips() : null;
    if (Array.isArray(blips)) {
      for (const bp of blips) {
        if (!bp || bp.alive === false) continue;
        const dx = bp.x - px;
        const dz = bp.z - pz;
        const friendly = bp.team === 'ct';
        if (!friendly) {
          // enemies: only when spotted — within 25 m OR fired within last 2 s
          const near = (dx * dx + dz * dz) <= ENEMY_SPOT_DIST * ENEMY_SPOT_DIST;
          let heard = false;
          if (!near) {
            for (let i = 0; i < fires.length; i++) {
              const f = fires[i];
              const fx = bp.x - f.x, fz = bp.z - f.z;
              if (fx * fx + fz * fz <= ENEMY_FIRE_MATCH * ENEMY_FIRE_MATCH) { heard = true; break; }
            }
          }
          if (!near && !heard) continue;
        }
        const bl = this._clampBlip(dx * RADAR_SCALE, dz * RADAR_SCALE);
        const alpha = bl.cl ? 0.45 : 1;
        c.beginPath();
        c.arc(bl.x, bl.y, bl.cl ? 2.4 : 3, 0, Math.PI * 2);
        c.fillStyle = friendly
          ? 'rgba(127,179,230,' + alpha + ')'
          : 'rgba(226,96,79,' + alpha + ')';
        c.fill();
        if (bp.isBombCarrier) {
          c.beginPath();
          c.arc(bl.x, bl.y, 5, 0, Math.PI * 2);
          c.strokeStyle = 'rgba(240,161,60,' + alpha + ')';
          c.lineWidth = 1.4;
          c.stroke();
        }
      }
    }

    // north marker (world -Z)
    c.save();
    c.translate(0, -(half - 9));
    c.rotate(-yaw);
    c.font = '700 8px Arial, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = 'rgba(154,178,107,0.55)';
    c.fillText('N', 0, 0);
    c.restore();

    c.restore();

    // player: view cone + arrow (screen space — always facing up)
    c.save();
    c.translate(half, half);
    c.fillStyle = 'rgba(210,228,190,0.07)';
    c.beginPath();
    c.moveTo(0, 0); c.lineTo(-17, -27); c.lineTo(17, -27);
    c.closePath();
    c.fill();
    c.beginPath();
    c.moveTo(0, -5.5); c.lineTo(4.4, 4.4); c.lineTo(0, 2); c.lineTo(-4.4, 4.4);
    c.closePath();
    c.fillStyle = '#eef4e2';
    c.fill();
    c.strokeStyle = 'rgba(0,0,0,0.7)';
    c.lineWidth = 0.8;
    c.stroke();
    c.restore();
  }

  // --------------------------------------------------------------------------
  // Overlays — vignette, wedges, flash, hitmarker
  // --------------------------------------------------------------------------

  _updateOverlays(dt) {
    // damage vignette (+ persistent low-HP pulse)
    this._dmg = Math.max(0, this._dmg - dt * (1.1 + this._dmg));
    let base = 0;
    const p = this.game.player;
    if (p && p.alive !== false && Number.isFinite(p.health) && p.health > 0 && p.health <= 25 &&
      this._cache.phase !== 'menu') {
      base = 0.13 + 0.05 * Math.sin(this._time * 3.4);
    }
    const op = Math.min(0.85, base + this._dmg);
    if (Math.abs(op - this._dmgOpacity) > 0.008) {
      this._dmgOpacity = op;
      if (this._el.vignette) this._el.vignette.style.opacity = op.toFixed(3);
    }

    // directional damage wedges
    const pyaw = (p && Number.isFinite(p.yaw)) ? p.yaw : 0;
    for (const w of this._wedges) {
      if (w.ttl > 0) {
        w.ttl -= dt;
        if (w.ttl <= 0) {
          w.ttl = 0;
          if (w.visible) { w.visible = false; w.el.style.opacity = '0'; }
        } else {
          const rot = pyaw - w.yaw; // attacker bearing → screen rotation
          w.el.style.transform = 'rotate(' + rot.toFixed(3) + 'rad) translateY(-128px)';
          w.el.style.opacity = Math.min(1, w.ttl * 1.7).toFixed(3);
          w.visible = true;
        }
      }
    }

    // flash whiteout
    if (this._flash) {
      const f = this._flash;
      f.t += dt;
      const rem = f.dur - f.t;
      let op2 = 0;
      if (rem > 0) {
        const fadeSpan = f.dur * 0.45;
        op2 = rem >= fadeSpan ? f.i : f.i * Math.pow(rem / fadeSpan, 1.35);
      } else {
        this._flash = null;
      }
      if (Math.abs(op2 - this._flashOpacity) > 0.006) {
        this._flashOpacity = op2;
        if (this._el.flash) this._el.flash.style.opacity = op2.toFixed(3);
      }
    } else if (this._flashOpacity !== 0) {
      this._flashOpacity = 0;
      if (this._el.flash) this._el.flash.style.opacity = '0';
    }

    // hitmarker fade
    if (this._hit) {
      this._hit.t -= dt;
      if (this._hit.t <= 0) {
        this._hit = null;
        if (this._el.hitmarker) this._el.hitmarker.style.opacity = '0';
      } else if (this._el.hitmarker) {
        this._el.hitmarker.style.opacity = (this._hit.t / this._hit.dur).toFixed(3);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Defuse bar + use hint
  // --------------------------------------------------------------------------

  _updateDefuse(st, phase) {
    const c = this._cache;
    const bomb = st.bomb || {};
    const prog = Number.isFinite(bomb.defuseProgress) ? bomb.defuseProgress : 0;
    const p = this.game.player;
    const cfg = (this.game.config && this.game.config.MATCH) || {};

    const show = prog > 0 && phase === 'planted';
    if (show !== c.defuseVis) {
      c.defuseVis = show;
      if (this._el.defuse) this._el.defuse.style.display = show ? 'block' : 'none';
      c.defuse = -1;
    }
    if (show) {
      const hasKit = !!(p && p.hasKit);
      const need = hasKit ? (cfg.DEFUSE_TIME_KIT || 5) : (cfg.DEFUSE_TIME || 10);
      const frac = clamp(prog / need, 0, 1);
      if (Math.abs(frac - c.defuse) > 0.004) {
        c.defuse = frac;
        if (this._el.defuseFill) this._el.defuseFill.style.transform = 'scaleX(' + frac.toFixed(4) + ')';
      }
      if (hasKit !== c.kitNote) {
        c.kitNote = hasKit;
        if (this._el.defuseNote) {
          this._el.defuseNote.textContent = hasKit ? 'DEFUSE KIT ATTACHED' : 'NO KIT — HOLD STEADY';
          this._el.defuseNote.classList.toggle('kit', hasKit);
        }
      }
    }

    // proximity hint
    let hint = false;
    if (!show && phase === 'planted' && p && p.alive !== false && bomb.pos && p.position) {
      const dx = p.position.x - bomb.pos.x;
      const dz = p.position.z - bomb.pos.z;
      hint = (dx * dx + dz * dz) < 2.4 * 2.4;
    }
    if (hint !== c.hintVis) {
      c.hintVis = hint;
      if (this._el.useHint) this._el.useHint.style.display = hint ? 'block' : 'none';
    }
  }

  // --------------------------------------------------------------------------
  // Death overlay
  // --------------------------------------------------------------------------

  _updateDeath(phase) {
    const c = this._cache;
    const p = this.game.player;
    const dead = !!(p && p.alive === false) && MATCH_PHASES[phase] === 1;
    if (dead !== c.dead) {
      c.dead = dead;
      if (this._el.death) this._el.death.style.display = dead ? 'flex' : 'none';
      if (dead && this._el.deathKiller) {
        this._el.deathKiller.textContent = this._deathKiller
          ? 'ELIMINATED BY ' + this._deathKiller.toUpperCase() + ' — SPECTATING'
          : 'SPECTATING';
      }
    }
  }

  // --------------------------------------------------------------------------
  // Scoreboard
  // --------------------------------------------------------------------------

  _updateScoreboard(phase) {
    const input = this.game.input;
    const show = !!(input && typeof input.isDown === 'function' && input.isDown('tab')) &&
      phase !== 'menu' && phase !== 'gameEnd' && !this._buyOpen;
    if (show !== this._sbVisible) {
      this._sbVisible = show;
      if (this._el.scoreboard) this._el.scoreboard.style.display = show ? 'flex' : 'none';
      if (show && this._sbDirty) this._rebuildScoreboard();
    } else if (show && this._sbDirty) {
      this._rebuildScoreboard();
    }
  }

  _stat(name) {
    let s = this._stats.get(name);
    if (!s) { s = { k: 0, d: 0 }; this._stats.set(name, s); }
    return s;
  }

  _rebuildScoreboard() {
    this._sbDirty = false;
    if (!this._el.sbBody) return;
    const p = this.game.player;
    const rows = [{ name: 'You', team: (p && p.team) || 'ct', alive: p ? p.alive !== false : true }];
    const bots = this.game.bots && this.game.bots.all;
    if (Array.isArray(bots)) {
      for (const b of bots) {
        if (b && b.name) rows.push({ name: b.name, team: b.team || 't', alive: !!b.alive });
      }
    }
    let html = '';
    for (const team of ['ct', 't']) {
      const label = team === 'ct' ? 'COUNTER-TERRORISTS' : 'TERRORISTS';
      html += '<div class="sb-team sb-' + team + '"><div class="sb-team-h">' + label + '</div>' +
        '<table><thead><tr><th class="sb-n">OPERATIVE</th><th>K</th><th>D</th><th class="sb-s">STATUS</th></tr></thead><tbody>';
      for (const r of rows) {
        if (r.team !== team) continue;
        const s = this._stat(r.name);
        html += '<tr class="' + (r.alive ? '' : 'sb-dead') + (r.name === 'You' ? ' sb-you' : '') + '">' +
          '<td class="sb-n">' + esc(r.name) + '</td><td>' + s.k + '</td><td>' + s.d + '</td>' +
          '<td class="sb-s">' + (r.alive ? 'ALIVE' : 'DEAD') + '</td></tr>';
      }
      html += '</tbody></table></div>';
    }
    this._el.sbBody.innerHTML = html;
  }

  // --------------------------------------------------------------------------
  // Buy menu
  // --------------------------------------------------------------------------

  _buildBuyRows() {
    const wrap = this._el.buyCats;
    if (!wrap) return;
    wrap.innerHTML = '';
    this._buyRows.length = 0;
    for (const cat of this._buyCats) {
      const cd = document.createElement('div');
      cd.className = 'buy-cat';
      const h = document.createElement('div');
      h.className = 'buy-cat-h';
      h.textContent = String(cat.category).toUpperCase();
      cd.appendChild(h);
      for (const id of cat.items) {
        const price = this._prices[id];
        const row = document.createElement('div');
        row.className = 'buy-item';
        const n = document.createElement('span');
        n.className = 'bi-name';
        n.textContent = this._names[id] || id;
        const pr = document.createElement('span');
        pr.className = 'bi-price';
        pr.textContent = Number.isFinite(price) ? '$' + price : '—';
        row.appendChild(n);
        row.appendChild(pr);
        row.addEventListener('click', () => this._tryBuy(id));
        cd.appendChild(row);
        this._buyRows.push({ id, price: Number.isFinite(price) ? price : 0, el: row, afford: null });
      }
      wrap.appendChild(cd);
    }
    this._buyMoney = -1;
  }

  _tryBuy(id) {
    const w = this.game.weapons;
    if (!w || typeof w.buy !== 'function') return;
    w.buy(id);
    this._buyMoney = -1; // force affordability refresh
  }

  _canOpenBuy() {
    const st = (this.game && this.game.state) || {};
    if (!st.canBuy) return false;
    if (st.phase !== 'freeze' && st.phase !== 'live') return false;
    const p = this.game.player;
    if (p && p.alive === false) return false;
    return true;
  }

  _toggleBuy() {
    const now = performance.now();
    if (now - this._lastBuyToggle < 140) return; // key handled twice (event + DOM)
    this._lastBuyToggle = now;
    if (!this._buyOpen && !this._canOpenBuy()) {
      const st = (this.game && this.game.state) || {};
      if (MATCH_PHASES[st.phase]) this._showMsg('', 'BUY PERIOD OVER', 1.1);
      return;
    }
    this._setBuyOpen(!this._buyOpen);
  }

  _setBuyOpen(open, relock = true) {
    if (open === this._buyOpen) return;
    this._buyOpen = open;
    if (this.game && this.game.state) this.game.state.buyOpen = open;
    if (this._el.buy) this._el.buy.style.display = open ? 'flex' : 'none';
    if (open) {
      // release the pointer so rows can be clicked
      if (!this.game.debug && document.pointerLockElement && document.exitPointerLock) {
        document.exitPointerLock();
      }
      this._buyMoney = -1;
      this._refreshBuy();
    } else if (relock) {
      const st = (this.game && this.game.state) || {};
      if (MATCH_PHASES[st.phase] && !this._locked &&
        this.game.input && typeof this.game.input.requestLock === 'function') {
        this.game.input.requestLock();
      }
    }
  }

  _updateBuy(st) {
    if (!this._buyOpen) return;
    if (!st.canBuy || (this.game.player && this.game.player.alive === false)) {
      this._setBuyOpen(false);
      return;
    }
    const money = Math.round(Number.isFinite(st.money) ? st.money : 0);
    if (money !== this._buyMoney) this._refreshBuy();
  }

  _refreshBuy() {
    const st = (this.game && this.game.state) || {};
    const money = Math.round(Number.isFinite(st.money) ? st.money : 0);
    this._buyMoney = money;
    if (this._el.buyFunds) this._el.buyFunds.textContent = '$ ' + money;
    for (const r of this._buyRows) {
      const afford = r.price <= money;
      if (afford !== r.afford) {
        r.afford = afford;
        r.el.classList.toggle('na', !afford);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Pause overlay
  // --------------------------------------------------------------------------

  _updatePause(phase) {
    const show = !this._locked && !this.game.debug && MATCH_PHASES[phase] === 1 && !this._buyOpen;
    if (show !== this._pauseShown) {
      this._pauseShown = show;
      if (this._el.pause) this._el.pause.style.display = show ? 'flex' : 'none';
    }
  }

  // --------------------------------------------------------------------------
  // Center messages
  // --------------------------------------------------------------------------

  _showMsg(main, sub, dur) {
    if (!this._el.msg) return;
    if (this._el.msgMain) {
      this._el.msgMain.textContent = main;
      this._el.msgMain.style.display = main ? 'block' : 'none';
    }
    if (this._el.msgSub) {
      this._el.msgSub.textContent = sub;
      this._el.msgSub.style.display = sub ? 'block' : 'none';
    }
    this._el.msg.classList.add('show');
    this._msgUntil = this._time + (dur || 2.5);
  }

  _updateMsg() {
    if (this._msgUntil >= 0 && this._time > this._msgUntil) {
      this._msgUntil = -1;
      if (this._el.msg) this._el.msg.classList.remove('show');
    }
  }

  // --------------------------------------------------------------------------
  // Money popup
  // --------------------------------------------------------------------------

  _moneyPop(reward) {
    if (!this._el.moneyBox || !Number.isFinite(reward)) return;
    const s = document.createElement('span');
    s.className = 'money-pop';
    s.textContent = '+$' + reward;
    s.addEventListener('animationend', () => {
      if (s.parentNode) s.parentNode.removeChild(s);
    });
    this._el.moneyBox.appendChild(s);
  }

  // --------------------------------------------------------------------------
  // Game end screen
  // --------------------------------------------------------------------------

  _fillEndScreen() {
    const st = (this.game && this.game.state) || {};
    const info = this._endInfo || {};
    const scores = info.scores || st.scores || { ct: 0, t: 0 };
    let winner = info.winner;
    if (!winner) winner = (scores.ct >= scores.t) ? 'ct' : 't';
    const won = winner === 'ct';
    if (this._el.endTitle) {
      this._el.endTitle.textContent = won ? 'MISSION ACCOMPLISHED' : 'MISSION FAILED';
      this._el.endTitle.classList.toggle('lost', !won);
    }
    if (this._el.endSub) {
      this._el.endSub.textContent = won
        ? 'COUNTER-TERRORISTS WIN THE MATCH'
        : 'TERRORISTS WIN THE MATCH';
    }
    if (this._el.endScore) {
      this._el.endScore.textContent = 'CT  ' + (scores.ct | 0) + '  :  ' + (scores.t | 0) + '  T';
    }
    if (this._el.endKd) {
      const s = this._stat('You');
      this._el.endKd.textContent = 'YOUR RECORD — ' + s.k + ' KILLS  /  ' + s.d + ' DEATHS';
    }
  }

  // --------------------------------------------------------------------------
  // Debug FPS
  // --------------------------------------------------------------------------

  _updateFps(dt) {
    this._fpsTimer += dt;
    if (this._fpsTimer < 0.5) return;
    this._fpsTimer = 0;
    const text = Math.round(this.game.fps || 0) + ' FPS';
    if (text !== this._cache.fps) {
      this._cache.fps = text;
      if (this._el.fps) {
        this._el.fps.style.display = 'block';
        this._el.fps.textContent = text;
      }
    }
  }

  // ==========================================================================
  // Markup
  // ==========================================================================

  _html() {
    const controls = CONTROLS.map(
      (c) => '<div class="mn-ctl"><kbd>' + esc(c[0]) + '</kbd><span>' + esc(c[1]) + '</span></div>'
    ).join('');

    return (
      // ------------------------------------------------ in-game layer
      '<div id="hud-game">' +

      // scope overlay (under everything else in the game layer)
      '<div id="hud-scope">' +
      '<div class="scope-h"></div><div class="scope-v"></div>' +
      '<div class="scope-hole"></div><div class="scope-ring"></div><div class="scope-ring2"></div>' +
      '<div id="hud-scope-zoom"></div>' +
      '</div>' +

      // full-screen feedback
      '<div id="hud-vignette"></div>' +
      '<div id="hud-wedges"></div>' +
      '<div id="hud-death"><div class="death-inner"><div class="death-main">YOU ARE DEAD</div>' +
      '<div class="death-sub" id="hud-death-killer">SPECTATING</div></div></div>' +

      // crosshair + hitmarker
      '<div id="hud-crosshair">' +
      '<div class="ch ch-h" id="hud-ch-l"></div><div class="ch ch-h" id="hud-ch-r"></div>' +
      '<div class="ch ch-v" id="hud-ch-t"></div><div class="ch ch-v" id="hud-ch-b"></div>' +
      '<div class="ch ch-dot"></div>' +
      '</div>' +
      '<div id="hud-hitmarker">' +
      '<div class="hm hm-l"></div><div class="hm hm-r"></div>' +
      '<div class="hm hm-t"></div><div class="hm hm-b"></div>' +
      '</div>' +

      // centered kill confirmation banner (player kills only)
      '<div id="hud-killcue">' +
      '<div class="kc-main" id="hud-killcue-main">ENEMY DOWN</div>' +
      '<div class="kc-name" id="hud-killcue-name"></div>' +
      '</div>' +

      // bottom-left: health / armor
      '<div id="hud-status">' +
      '<div class="hud-panel stat-box" id="hud-health">' +
      '<span class="stat-ico">' + SVG_CROSS + '</span>' +
      '<span class="hud-num stat-num" id="hud-health-num">100</span>' +
      '</div>' +
      '<div class="hud-panel stat-box" id="hud-armor" style="display:none">' +
      '<span class="stat-ico">' + SVG_SHIELD + '</span>' +
      '<span class="hud-num stat-num" id="hud-armor-num">0</span>' +
      '</div>' +
      '</div>' +

      // bottom-center-left: money
      '<div class="hud-panel" id="hud-money">' +
      '<span class="money-sign">$</span><span class="hud-num" id="hud-money-num">800</span>' +
      '</div>' +

      // bottom-right: ammo
      '<div class="hud-panel" id="hud-ammo">' +
      '<div id="hud-reload">RELOADING</div>' +
      '<div class="ammo-row"><span class="hud-num" id="hud-ammo-mag">—</span>' +
      '<span class="hud-num" id="hud-ammo-reserve"></span></div>' +
      '<div id="hud-weapon-name"></div>' +
      '</div>' +

      // top-center: timer / scores / round
      '<div class="hud-panel" id="hud-top">' +
      '<div id="hud-timer"><span id="hud-bomb-ico">C4</span>' +
      '<span class="hud-num" id="hud-timer-num">0:00</span></div>' +
      '<div id="hud-scores"><span class="sc-ct">CT</span> <span class="hud-num" id="hud-score-ct">0</span>' +
      '<span class="sc-colon">:</span><span class="hud-num" id="hud-score-t">0</span> <span class="sc-t">T</span></div>' +
      '<div id="hud-round">ROUND 1 · FIRST TO 8</div>' +
      '</div>' +

      // top-right: killfeed
      '<div id="hud-killfeed"></div>' +

      // top-left: radar
      '<div class="hud-panel" id="hud-radar">' +
      '<canvas id="hud-radar-canvas" width="140" height="140"></canvas>' +
      '</div>' +

      // center: messages / defuse / hint
      '<div id="hud-msg"><div id="hud-msg-main"></div><div id="hud-msg-sub"></div></div>' +
      '<div class="hud-panel" id="hud-defuse">' +
      '<div class="df-label">DEFUSING…</div>' +
      '<div class="df-track"><div id="hud-defuse-fill"></div></div>' +
      '<div id="hud-defuse-note">NO KIT — HOLD STEADY</div>' +
      '</div>' +
      '<div id="hud-usehint">HOLD <kbd>E</kbd> TO DEFUSE THE BOMB</div>' +

      // scoreboard
      '<div id="hud-scoreboard"><div class="hud-panel sb-panel">' +
      '<div class="sb-title">OPERATION GOLDENEYE</div>' +
      '<div class="sb-sub" id="hud-sb-score">CT 0 : 0 T</div>' +
      '<div id="hud-sb-body"></div>' +
      '</div></div>' +

      // buy menu
      '<div id="hud-buy"><div class="hud-panel buy-panel">' +
      '<div class="buy-head"><span>BUY EQUIPMENT</span>' +
      '<span class="buy-funds" id="hud-buy-funds">$ 800</span></div>' +
      '<div id="hud-buy-cats"></div>' +
      '<div class="buy-foot"><kbd>B</kbd> / <kbd>ESC</kbd> — CLOSE &nbsp;·&nbsp; CLICK AN ITEM TO PURCHASE</div>' +
      '</div></div>' +

      // flash whiteout — over everything in the game layer
      '<div id="hud-flash"></div>' +
      '</div>' + // /hud-game

      // ------------------------------------------------ pause overlay
      '<div id="hud-pause"><div class="pause-inner">' +
      '<div class="pause-main">CLICK TO RESUME</div>' +
      '<div class="pause-sub">POINTER RELEASED — THE OPERATION CONTINUES</div>' +
      '</div></div>' +

      // ------------------------------------------------ main menu
      '<div id="hud-menu">' +
      '<div class="mn-scan"></div>' +
      '<div class="mn-top">' +
      '<div class="mn-op">OPERATION</div>' +
      '<div class="mn-title">GOLDENEYE</div>' +
      '<div class="mn-sub">TACTICAL STRIKE — BOMB DEFUSAL</div>' +
      '</div>' +
      '<button id="hud-start">START MISSION</button>' +
      '<div class="mn-controls">' + controls + '</div>' +
      '<div class="mn-note">You are a Counter-Terrorist. First to 8 rounds wins the operation.</div>' +
      '</div>' +

      // ------------------------------------------------ game end
      '<div id="hud-end">' +
      '<div class="mn-scan"></div>' +
      '<div class="end-inner">' +
      '<div id="hud-end-title">MISSION ACCOMPLISHED</div>' +
      '<div id="hud-end-sub"></div>' +
      '<div id="hud-end-score" class="hud-num">CT 0 : 0 T</div>' +
      '<div id="hud-end-kd"></div>' +
      '<button id="hud-restart">RESTART OPERATION</button>' +
      '</div></div>' +

      // ------------------------------------------------ debug fps
      '<div id="hud-fps" style="display:none"></div>'
    );
  }

  // ==========================================================================
  // Styles
  // ==========================================================================

  _css() {
    return `
#hud {
  position: fixed; inset: 0; overflow: hidden; z-index: 10;
  pointer-events: none; user-select: none; -webkit-user-select: none;
  font-family: "Rajdhani", "Arial Narrow", Arial, system-ui, sans-serif;
  font-stretch: condensed;
  color: #9ab26b;
  -webkit-font-smoothing: antialiased;
  --olive: #9ab26b;
  --olive-bright: #cfe0b8;
  --olive-dim: #66744c;
  --panel-border: rgba(154, 178, 107, 0.30);
  --red: #e2503e;
}
#hud * { box-sizing: border-box; margin: 0; padding: 0; }
#hud kbd {
  display: inline-block; min-width: 30px; text-align: center;
  padding: 2px 8px; border: 1px solid rgba(154,178,107,.45); border-radius: 3px;
  background: rgba(10, 13, 6, 0.85); color: var(--olive-bright);
  font: inherit; font-size: 12px; letter-spacing: .08em;
  box-shadow: 0 2px 0 rgba(0,0,0,.6);
}
.hud-panel {
  background: linear-gradient(180deg, rgba(17, 20, 11, 0.52), rgba(8, 10, 5, 0.68));
  border: 1px solid var(--panel-border); border-radius: 3px;
  box-shadow: inset 0 0 16px rgba(0, 0, 0, 0.35), 0 1px 8px rgba(0, 0, 0, 0.45);
}
.hud-num {
  font-variant-numeric: tabular-nums; font-weight: 700; letter-spacing: .02em;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9);
}
#hud-game { position: absolute; inset: 0; z-index: 1; pointer-events: none; }

/* ---------- bottom-left: health / armor ---------- */
#hud-status { position: absolute; left: 18px; bottom: 18px; display: flex; gap: 10px; }
.stat-box { display: flex; align-items: center; gap: 9px; padding: 7px 16px 8px 13px; }
.stat-ico { display: flex; color: var(--olive); filter: drop-shadow(0 1px 1px rgba(0,0,0,.8)); }
.stat-num { font-size: 33px; line-height: 1; color: var(--olive-bright); min-width: 52px; }
#hud-health.low { border-color: rgba(226, 80, 62, 0.65); }
#hud-health.low .stat-num, #hud-health.low .stat-ico { color: #e2503e; }

/* ---------- bottom-center-left: money ---------- */
#hud-money {
  position: absolute; left: 33%; bottom: 18px; padding: 8px 16px;
  font-size: 24px; font-weight: 700; color: #8ede6e; display: flex; gap: 6px; align-items: baseline;
}
#hud-money .money-sign { font-size: 17px; opacity: .8; }
#hud-money.pulse { animation: hud-money-pulse .35s ease-out; }
@keyframes hud-money-pulse {
  0% { box-shadow: inset 0 0 16px rgba(0,0,0,.35), 0 0 14px rgba(142, 222, 110, 0.5); }
  100% { box-shadow: inset 0 0 16px rgba(0,0,0,.35), 0 1px 8px rgba(0,0,0,.45); }
}
.money-pop {
  position: absolute; right: 4px; top: -14px; font-size: 15px; font-weight: 700;
  color: #8ede6e; text-shadow: 0 1px 2px #000; pointer-events: none;
  animation: hud-money-rise 1.1s ease-out forwards;
}
@keyframes hud-money-rise {
  from { opacity: 1; transform: translateY(0); }
  to { opacity: 0; transform: translateY(-34px); }
}

/* ---------- bottom-right: ammo ---------- */
#hud-ammo { position: absolute; right: 18px; bottom: 18px; padding: 6px 16px 9px; text-align: right; min-width: 148px; }
.ammo-row { display: flex; align-items: baseline; justify-content: flex-end; gap: 7px; }
#hud-ammo-mag { font-size: 40px; line-height: 1; color: var(--olive-bright); }
#hud-ammo-mag.low { color: #e2503e; }
#hud-ammo-reserve { font-size: 19px; color: var(--olive-dim); }
#hud-weapon-name {
  font-size: 11px; letter-spacing: .28em; color: var(--olive); text-transform: uppercase;
  margin-top: 2px; text-shadow: 0 1px 2px #000;
}
#hud-reload {
  display: none; font-size: 11px; letter-spacing: .3em; color: #e0b23c;
  animation: hud-blink .55s step-end infinite alternate; margin-bottom: 2px;
}
@keyframes hud-blink { from { opacity: 1; } to { opacity: .25; } }

/* ---------- top-center: timer / scores ---------- */
#hud-top {
  position: absolute; top: 14px; left: 50%; transform: translateX(-50%);
  text-align: center; padding: 5px 26px 7px; min-width: 168px;
}
#hud-timer { display: flex; align-items: center; justify-content: center; gap: 8px; }
#hud-timer-num { font-size: 27px; line-height: 1.1; color: var(--olive-bright); }
#hud-timer-num.red { color: #e2503e; }
#hud-bomb-ico {
  display: none; font-size: 11px; font-weight: 800; letter-spacing: .05em;
  color: #fff; background: rgba(200, 40, 24, 0.85); border: 1px solid rgba(255, 120, 100, 0.7);
  border-radius: 2px; padding: 1px 5px;
  animation: hud-bomb-pulse .8s ease-in-out infinite;
}
@keyframes hud-bomb-pulse {
  0%, 100% { opacity: 1; box-shadow: 0 0 10px rgba(226, 60, 40, 0.9); }
  50% { opacity: .55; box-shadow: 0 0 2px rgba(226, 60, 40, 0.3); }
}
#hud-scores { font-size: 15px; margin-top: 1px; display: flex; justify-content: center; gap: 6px; align-items: baseline; }
#hud-scores .hud-num { font-size: 16px; color: var(--olive-bright); }
.sc-ct { color: #9cc2ea; font-weight: 700; letter-spacing: .06em; }
.sc-t { color: #e0a05c; font-weight: 700; letter-spacing: .06em; }
.sc-colon { color: var(--olive-dim); }
#hud-round { font-size: 9.5px; letter-spacing: .24em; color: var(--olive-dim); margin-top: 2px; }

/* ---------- top-right: killfeed ---------- */
#hud-killfeed {
  position: absolute; top: 16px; right: 16px; display: flex; flex-direction: column;
  gap: 6px; align-items: flex-end; max-width: 60vw; z-index: 3;
}
.kf-entry {
  display: flex; gap: 10px; align-items: baseline; padding: 7px 14px;
  background: rgba(5, 7, 3, 0.6); border: 1px solid rgba(154, 178, 107, 0.18);
  border-radius: 3px; font-size: 22px; font-weight: 800; letter-spacing: .03em;
  transition: opacity .6s; white-space: nowrap;
}
.kf-entry.kf-fade { opacity: 0; }
.kf-entry.kf-mine {
  border-color: rgba(154, 178, 107, 0.8); background: rgba(28, 36, 14, 0.78);
  box-shadow: 0 0 14px rgba(154, 178, 107, 0.35);
}
.kf-entry.kf-death { border-color: rgba(226, 80, 62, 0.8); background: rgba(44, 11, 8, 0.78); }
.kf-name { text-shadow: 0 1px 3px #000; }
.kf-mine .kf-name { text-shadow: 0 0 8px rgba(190, 220, 150, 0.5), 0 1px 3px #000; }
.kf-ct { color: #9cc2ea; }
.kf-t { color: #e0a05c; }
.kf-weap { color: var(--olive); font-size: 17px; font-weight: 500; letter-spacing: .06em; }
.kf-hs {
  font-size: 14px; font-weight: 800; color: #fff; background: rgba(210, 44, 26, 0.95);
  border-radius: 2px; padding: 2px 6px; letter-spacing: .1em; align-self: center;
}

/* ---------- centered kill confirmation banner ---------- */
#hud-killcue {
  position: absolute; left: 50%; top: 38%; z-index: 6;
  transform: translate(-50%, -50%); text-align: center;
  opacity: 0; pointer-events: none;
}
#hud-killcue.show { animation: killcue-pop 1.6s cubic-bezier(.16, .84, .3, 1) forwards; }
.kc-main {
  font-size: 44px; font-weight: 900; letter-spacing: .14em; color: #eef5df;
  text-shadow: 0 0 22px rgba(154, 178, 107, 0.75), 0 3px 8px rgba(0, 0, 0, 0.85);
  -webkit-text-stroke: 1px rgba(0, 0, 0, 0.35);
}
.kc-name {
  margin-top: 6px; font-size: 22px; font-weight: 700; letter-spacing: .18em;
  color: #e0a05c; text-shadow: 0 2px 6px #000;
}
#hud-killcue.hs .kc-main {
  color: #ffd54a;
  text-shadow: 0 0 26px rgba(255, 96, 40, 0.9), 0 3px 8px rgba(0, 0, 0, 0.85);
}
@keyframes killcue-pop {
  0%   { opacity: 0; transform: translate(-50%, -50%) scale(1.55); }
  12%  { opacity: 1; transform: translate(-50%, -50%) scale(0.95); }
  24%  { transform: translate(-50%, -50%) scale(1.03); }
  34%  { transform: translate(-50%, -50%) scale(1); }
  72%  { opacity: 1; }
  100% { opacity: 0; transform: translate(-50%, -50%) scale(1); }
}

/* ---------- top-left: radar ---------- */
#hud-radar { position: absolute; top: 16px; left: 16px; width: 148px; height: 148px; padding: 3px; }
#hud-radar-canvas { display: block; width: 140px; height: 140px; border-radius: 2px; }

/* ---------- crosshair ---------- */
#hud-crosshair { position: absolute; left: 50%; top: 50%; width: 0; height: 0; z-index: 4; }
.ch { position: absolute; background: #4de54d; box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.5); }
.ch-h { width: 8px; height: 2px; left: 0; top: -1px; }
.ch-v { width: 2px; height: 8px; top: 0; left: -1px; }
.ch-dot { width: 2px; height: 2px; left: -1px; top: -1px; }

/* ---------- hitmarker ---------- */
#hud-hitmarker {
  position: absolute; left: 50%; top: 50%; width: 0; height: 0; z-index: 5;
  opacity: 0; transform: rotate(45deg);
}
.hm {
  position: absolute; background: #fff; border-radius: 1px;
  box-shadow: 0 0 3px rgba(0, 0, 0, 0.9);
}
.hm-l { left: -19px; top: -1.5px; width: 13px; height: 3px; }
.hm-r { left: 6px; top: -1.5px; width: 13px; height: 3px; }
.hm-t { top: -19px; left: -1.5px; width: 3px; height: 13px; }
.hm-b { top: 6px; left: -1.5px; width: 3px; height: 13px; }
#hud-hitmarker.kill .hm {
  background: #ff4436;
  box-shadow: 0 0 8px rgba(255, 68, 54, 0.95), 0 0 3px rgba(0, 0, 0, 0.9);
}

/* ---------- damage / flash ---------- */
#hud-vignette {
  position: absolute; inset: 0; opacity: 0; z-index: 2;
  background: radial-gradient(ellipse at center, rgba(255, 0, 0, 0) 40%, rgba(190, 22, 10, 0.65) 100%);
}
#hud-wedges { position: absolute; left: 50%; top: 50%; z-index: 2; }
.hud-wedge {
  position: absolute; left: 0; top: 0; width: 112px; height: 34px;
  margin-left: -56px; margin-top: -17px; opacity: 0;
  clip-path: polygon(50% 0, 86% 100%, 14% 100%);
  background: linear-gradient(to bottom, rgba(255, 62, 40, 0.95), rgba(255, 62, 40, 0));
}
#hud-flash { position: absolute; inset: 0; background: #fff; opacity: 0; z-index: 30; }

/* ---------- scope ---------- */
#hud-scope { position: absolute; inset: 0; display: none; z-index: 1; }
.scope-hole {
  position: absolute; left: 50%; top: 50%; width: 94vmin; height: 94vmin;
  transform: translate(-50%, -50%); border-radius: 50%;
  box-shadow: 0 0 0 200vmax rgba(2, 3, 2, 0.985), inset 0 0 130px rgba(0, 0, 0, 0.9);
}
.scope-ring {
  position: absolute; left: 50%; top: 50%; width: calc(94vmin - 10px); height: calc(94vmin - 10px);
  transform: translate(-50%, -50%); border-radius: 50%;
  border: 3px solid rgba(8, 10, 8, 0.95);
  box-shadow: inset 0 0 0 1px rgba(190, 210, 170, 0.14);
}
.scope-ring2 {
  position: absolute; left: 50%; top: 50%; width: calc(94vmin - 42px); height: calc(94vmin - 42px);
  transform: translate(-50%, -50%); border-radius: 50%;
  border: 1px solid rgba(190, 210, 170, 0.10);
}
.scope-h { position: absolute; left: 0; right: 0; top: 50%; height: 1.6px; margin-top: -0.8px; background: rgba(0, 0, 0, 0.92); }
.scope-v { position: absolute; top: 0; bottom: 0; left: 50%; width: 1.6px; margin-left: -0.8px; background: rgba(0, 0, 0, 0.92); }
#hud-scope-zoom {
  position: absolute; left: 50%; bottom: 7%; transform: translateX(-50%);
  font-size: 13px; letter-spacing: .35em; color: rgba(190, 210, 170, 0.65); text-shadow: 0 1px 2px #000;
}

/* ---------- center messages ---------- */
#hud-msg {
  position: absolute; left: 0; right: 0; top: 25%; text-align: center;
  opacity: 0; transition: opacity .35s; z-index: 6; pointer-events: none;
}
#hud-msg.show { opacity: 1; }
#hud-msg-main {
  font-size: 33px; font-weight: 800; letter-spacing: .2em; color: #e8efdb;
  text-shadow: 0 0 22px rgba(154, 178, 107, 0.45), 0 2px 2px #000;
}
#hud-msg-sub { font-size: 13px; letter-spacing: .34em; color: var(--olive); margin-top: 7px; text-shadow: 0 1px 2px #000; }

/* ---------- defuse ---------- */
#hud-defuse {
  position: absolute; left: 50%; bottom: 21%; transform: translateX(-50%);
  width: 300px; padding: 9px 14px 11px; display: none; text-align: center; z-index: 6;
}
.df-label { font-size: 13px; letter-spacing: .34em; color: var(--olive-bright); margin-bottom: 7px; }
.df-track { height: 11px; border: 1px solid var(--panel-border); background: rgba(0, 0, 0, 0.55); }
#hud-defuse-fill {
  height: 100%; width: 100%; transform: scaleX(0); transform-origin: left center;
  background: linear-gradient(90deg, #6f9a45, #cfe0b8);
}
#hud-defuse-note { font-size: 9.5px; letter-spacing: .22em; color: var(--olive-dim); margin-top: 6px; }
#hud-defuse-note.kit { color: #8ede6e; }
#hud-usehint {
  position: absolute; left: 50%; bottom: 21%; transform: translateX(-50%);
  display: none; font-size: 13px; letter-spacing: .2em; color: var(--olive-bright);
  text-shadow: 0 1px 3px #000; z-index: 6;
}

/* ---------- death ---------- */
#hud-death {
  position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
  background: radial-gradient(ellipse at center, rgba(12, 14, 15, 0.30) 0%, rgba(4, 5, 6, 0.82) 100%);
  z-index: 2;
}
.death-inner { text-align: center; margin-top: -10vh; }
.death-main {
  font-size: 42px; font-weight: 800; letter-spacing: .26em; color: #c8552f;
  text-shadow: 0 0 26px rgba(200, 60, 30, 0.4), 0 2px 3px #000;
}
.death-sub { font-size: 12px; letter-spacing: .32em; color: #8a8f80; margin-top: 10px; }

/* ---------- scoreboard ---------- */
#hud-scoreboard { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; z-index: 10; }
.sb-panel { width: min(560px, 90vw); padding: 18px 24px 20px; }
.sb-title { text-align: center; font-size: 19px; font-weight: 800; letter-spacing: .3em; color: var(--olive-bright); }
.sb-sub { text-align: center; font-size: 13px; letter-spacing: .2em; color: var(--olive-dim); margin: 4px 0 12px; }
.sb-team { margin-top: 10px; }
.sb-team-h { font-size: 12px; font-weight: 800; letter-spacing: .26em; padding-bottom: 4px; border-bottom: 1px solid var(--panel-border); }
.sb-ct .sb-team-h { color: #9cc2ea; }
.sb-t .sb-team-h { color: #e0a05c; }
.sb-team table { width: 100%; border-collapse: collapse; margin-top: 3px; }
.sb-team th {
  font-size: 9.5px; letter-spacing: .22em; color: var(--olive-dim); font-weight: 700;
  text-align: center; padding: 3px 6px;
}
.sb-team th.sb-n, .sb-team td.sb-n { text-align: left; width: 55%; }
.sb-team th.sb-s, .sb-team td.sb-s { text-align: right; width: 20%; }
.sb-team td {
  font-size: 14.5px; font-weight: 700; color: var(--olive-bright); padding: 3.5px 6px;
  text-align: center; font-variant-numeric: tabular-nums;
}
.sb-team td.sb-s { font-size: 10px; letter-spacing: .2em; color: var(--olive); }
.sb-team tr.sb-dead td { opacity: .38; }
.sb-team tr.sb-you td { background: rgba(154, 178, 107, 0.13); }
.sb-team tr.sb-you td:first-child { box-shadow: inset 2px 0 0 var(--olive); }

/* ---------- buy menu ---------- */
#hud-buy { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; z-index: 12; }
.buy-panel { pointer-events: auto; cursor: default; width: min(780px, 94vw); padding: 16px 20px 14px; }
.buy-head {
  display: flex; justify-content: space-between; align-items: baseline;
  font-size: 17px; font-weight: 800; letter-spacing: .3em; color: var(--olive-bright);
  border-bottom: 1px solid var(--panel-border); padding-bottom: 9px; margin-bottom: 12px;
}
.buy-funds { font-size: 19px; letter-spacing: .06em; color: #8ede6e; font-variant-numeric: tabular-nums; }
#hud-buy-cats { display: grid; grid-template-columns: repeat(auto-fit, minmax(136px, 1fr)); gap: 12px; }
.buy-cat-h {
  font-size: 10.5px; font-weight: 800; letter-spacing: .26em; color: var(--olive-dim);
  border-bottom: 1px solid rgba(154, 178, 107, 0.18); padding-bottom: 4px; margin-bottom: 5px;
}
.buy-item {
  display: flex; justify-content: space-between; gap: 8px; align-items: baseline;
  padding: 6px 8px; margin: 2px 0; border: 1px solid transparent; border-radius: 2px;
  cursor: pointer; transition: background .08s, border-color .08s;
}
.buy-item:hover { background: rgba(154, 178, 107, 0.15); border-color: rgba(154, 178, 107, 0.45); }
.buy-item:active { background: rgba(154, 178, 107, 0.3); }
.buy-item .bi-name { font-size: 13.5px; font-weight: 700; color: var(--olive-bright); }
.buy-item .bi-price { font-size: 12px; color: #8ede6e; font-variant-numeric: tabular-nums; }
.buy-item.na { opacity: .32; cursor: default; pointer-events: none; }
.buy-item.na .bi-price { color: #c86050; }
.buy-foot {
  margin-top: 13px; padding-top: 9px; border-top: 1px solid var(--panel-border);
  font-size: 9.5px; letter-spacing: .2em; color: var(--olive-dim); text-align: center;
}
.buy-foot kbd { font-size: 9.5px; min-width: 20px; padding: 1px 5px; }

/* ---------- pause ---------- */
#hud-pause {
  position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
  background: rgba(3, 4, 2, 0.6); z-index: 40; pointer-events: auto; cursor: pointer;
}
.pause-inner { text-align: center; }
.pause-main {
  font-size: 30px; font-weight: 800; letter-spacing: .3em; color: var(--olive-bright);
  text-shadow: 0 0 20px rgba(154, 178, 107, 0.4), 0 2px 2px #000;
  animation: hud-blink 1s step-end infinite alternate;
}
.pause-sub { font-size: 11px; letter-spacing: .3em; color: var(--olive-dim); margin-top: 12px; }

/* ---------- menu / end screens ---------- */
#hud-menu, #hud-end {
  position: absolute; inset: 0; display: none; flex-direction: column;
  align-items: center; justify-content: center; gap: 30px; z-index: 50;
  background: radial-gradient(ellipse at 50% 30%, #222a15 0%, #10150a 48%, #05080a 100%);
  pointer-events: auto; cursor: default;
}
.mn-scan {
  position: absolute; inset: 0; pointer-events: none; opacity: .5;
  background: repeating-linear-gradient(0deg, rgba(255, 255, 255, 0.025) 0 1px, transparent 1px 3px);
}
.mn-top { text-align: center; position: relative; }
.mn-op { font-size: 17px; font-weight: 700; letter-spacing: .85em; color: var(--olive); text-indent: .85em; }
.mn-title {
  font-size: clamp(52px, 9vw, 96px); font-weight: 800; line-height: 1.02; letter-spacing: .06em;
  color: var(--olive-bright);
  text-shadow: 0 0 34px rgba(154, 178, 107, 0.35), 0 3px 0 rgba(0, 0, 0, 0.9);
}
.mn-sub { font-size: 12px; letter-spacing: .5em; color: var(--olive-dim); margin-top: 10px; text-indent: .5em; }
#hud-start, #hud-restart {
  pointer-events: auto; cursor: pointer; position: relative;
  font-family: inherit; font-stretch: condensed; font-size: 21px; font-weight: 800; letter-spacing: .32em; text-indent: .32em;
  color: var(--olive-bright); background: rgba(154, 178, 107, 0.09);
  border: 1px solid var(--olive); border-radius: 2px; padding: 15px 52px;
  text-shadow: 0 1px 2px #000;
  transition: background .12s, box-shadow .12s, transform .06s;
}
#hud-start:hover, #hud-restart:hover {
  background: rgba(154, 178, 107, 0.26);
  box-shadow: 0 0 26px rgba(154, 178, 107, 0.35), inset 0 0 14px rgba(154, 178, 107, 0.2);
}
#hud-start:active, #hud-restart:active { transform: translateY(1px); }
.mn-controls {
  position: relative; display: grid; grid-template-columns: repeat(2, minmax(200px, 240px));
  gap: 7px 42px; padding: 18px 26px;
  background: rgba(5, 7, 3, 0.45); border: 1px solid rgba(154, 178, 107, 0.2); border-radius: 3px;
}
.mn-ctl { display: flex; align-items: center; gap: 13px; }
.mn-ctl kbd { min-width: 62px; }
.mn-ctl span { font-size: 13px; letter-spacing: .12em; color: var(--olive); }
.mn-note { position: relative; font-size: 11px; letter-spacing: .24em; color: var(--olive-dim); text-align: center; }

.end-inner { position: relative; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 18px; }
#hud-end-title {
  font-size: clamp(38px, 6vw, 62px); font-weight: 800; letter-spacing: .14em;
  color: var(--olive-bright); text-shadow: 0 0 30px rgba(154, 178, 107, 0.4), 0 2px 0 #000;
}
#hud-end-title.lost { color: #c8552f; text-shadow: 0 0 30px rgba(200, 60, 30, 0.4), 0 2px 0 #000; }
#hud-end-sub { font-size: 13px; letter-spacing: .4em; color: var(--olive); }
#hud-end-score { font-size: 34px; color: var(--olive-bright); }
#hud-end-kd { font-size: 12px; letter-spacing: .26em; color: var(--olive-dim); margin-bottom: 8px; }

/* ---------- debug fps ---------- */
#hud-fps {
  position: absolute; left: 6px; bottom: 4px; font-size: 10px; letter-spacing: .1em;
  color: rgba(154, 178, 107, 0.6); text-shadow: 0 1px 1px #000; z-index: 2;
}
`;
  }
}
