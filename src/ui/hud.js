// ============================================================================
// TINY STRIKE — src/ui/hud.js
// The entire 2D layer: status panels, ammo, money, timer/scores, killfeed,
// rotating radar, dynamic crosshair, hitmarkers, damage feedback, flash
// whiteout, AWP scope, buy menu, scoreboard, round messages, defuse bar,
// death overlay, main menu, pause overlay and game-end screen.
// CS 1.6-flavored styling: translucent dark panels, olive-green text,
// condensed bold system fonts. No external assets.
// ============================================================================

import * as THREE from 'three';
import { MAP_CATALOG, normalizeMapId } from '../maps/catalog.js';

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

// Gun stat readouts for the buy menu (overwritten by live data.js values).
const FALLBACK_STATS = {
  glock: { dmg: 26, rpm: 400 }, usp: { dmg: 34, rpm: 352 }, deagle: { dmg: 58, rpm: 160 },
  mp5: { dmg: 26, rpm: 750 }, ak47: { dmg: 36, rpm: 600 }, m4a1: { dmg: 33, rpm: 666 },
  awp: { dmg: 115, rpm: 41 },
};
const FALLBACK_MAXCARRY = { hegrenade: 1, flashbang: 2, smokegrenade: 1 };
const GRENADE_IDS = { hegrenade: 1, flashbang: 1, smokegrenade: 1 };

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
const SVG_SKULL =
  '<svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true">' +
  '<path fill="currentColor" d="M12 2a8 8 0 0 0-8 8c0 2.9 1.6 5.4 4 6.7V20h2v-2h1v2h2v-2h1v2h2v-3.3c2.4-1.3 4-3.8 4-6.7a8 8 0 0 0-8-8zM8.5 12a1.8 1.8 0 1 1 0-3.6 1.8 1.8 0 0 1 0 3.6zm7 0a1.8 1.8 0 1 1 0-3.6 1.8 1.8 0 0 1 0 3.6z"/></svg>';

// Compact, dependency-free silhouettes for every buy-menu choice. Keeping
// these inline makes the menu immediately useful while the 3D GLBs stream in,
// and lets CSS recolor owned/unaffordable items without maintaining PNG sets.
const BUY_ICON_SHAPES = {
  glock:
    '<path d="M18 10h52l10 6-4 8H56l-3 15H35l2-15H18z"/>' +
    '<path d="M57 25h14l-5 5H56z" opacity=".48"/>',
  usp:
    '<path d="M7 11h40v-3h31v5H47l14 6-4 7H42l-3 13H23l3-16H11z"/>' +
    '<rect x="79" y="9" width="27" height="8" rx="2"/>',
  deagle:
    '<path d="M10 9h62l14 8-5 10H57l-3 12H34l2-16H15z"/>' +
    '<path d="M25 8h38l7 5H23z" opacity=".5"/>',
  mp5:
    '<path d="M9 13h67l10 5-4 9H56l-3 12H40l1-13H12z"/>' +
    '<path d="M55 27h16l-5 13H54zM80 16h26v7H83z" opacity=".72"/>',
  ak47:
    '<path d="M5 15h21l8-6h38l12 7h31v7H80l-8 6H45l-7-6H7z"/>' +
    '<path d="M57 27h15c-1 8 3 11 9 13H65c-7-3-10-7-8-13zM25 13L12 6H3v7z" opacity=".72"/>',
  m4a1:
    '<path d="M5 16h20l10-7h42l8 5h30v8H82l-8 7H41l-8-7H5z"/>' +
    '<path d="M55 27h12l5 13H58zM26 14L12 7H4v8zM39 6h31v5H39z" opacity=".68"/>',
  awp:
    '<path d="M3 18h35l7-7h37l9 6h26v6H87l-8 6H47l-8-6H3z"/>' +
    '<path d="M48 8h34v6H48zM55 27h13l-4 13H51z" opacity=".7"/>' +
    '<circle cx="52" cy="10" r="5"/><circle cx="78" cy="10" r="5"/>',
  armor:
    '<path d="M38 5l13 6h18l13-6 12 14-9 7v14H35V26l-9-7z"/>' +
    '<path d="M51 11l-5 12 14 13 14-13-5-12z" opacity=".42"/>',
  kit:
    '<path d="M28 12h64a6 6 0 0 1 6 6v19H22V18a6 6 0 0 1 6-6z"/>' +
    '<path d="M47 12V7h26v5h-6V11H53v1zM56 18h8v6h7v7h-7v6h-8v-6h-7v-7h7z" opacity=".45"/>',
  hegrenade:
    '<path d="M44 13h32l6 8v14l-7 6H45l-7-6V21z"/>' +
    '<path d="M49 5h22v9H49zM69 6h15l7 7-5 4-7-6H69z" opacity=".72"/>',
  flashbang:
    '<path d="M43 9h34l5 8v20l-5 5H43l-5-5V17z"/>' +
    '<path d="M48 3h24v8H48zM77 6h12l7 7-5 4-8-6h-6z" opacity=".72"/>' +
    '<path d="M46 18h28v4H46zm0 8h28v4H46zm0 8h28v4H46z" opacity=".38"/>',
  smokegrenade:
    '<path d="M42 11h36l4 7v20l-5 4H43l-5-4V18z"/>' +
    '<path d="M48 4h24v9H48zM76 7h13l7 7-5 4-8-6h-7z" opacity=".72"/>' +
    '<path d="M47 20h26v14H47z" opacity=".32"/>',
};

function buyIcon(id) {
  const shape = BUY_ICON_SHAPES[id] || '<path d="M18 12h84v18H18z"/>';
  return '<span class="bi-icon" aria-hidden="true"><svg viewBox="0 0 120 44" ' +
    'focusable="false"><g fill="currentColor">' + shape + '</g></svg></span>';
}

export function compareScoreboardRows(a, b) {
  const aStats = a?.stats || {};
  const bStats = b?.stats || {};
  const byKills = (Number(bStats.k) || 0) - (Number(aStats.k) || 0);
  if (byKills) return byKills;
  const byDeaths = (Number(aStats.d) || 0) - (Number(bStats.d) || 0);
  if (byDeaths) return byDeaths;
  const byName = String(a?.name || '').localeCompare(String(b?.name || ''), 'en', {
    sensitivity: 'base',
  });
  if (byName) return byName;
  const byId = String(a?.sortId || '').localeCompare(String(b?.sortId || ''), 'en');
  return byId || (Number(a?.order) || 0) - (Number(b?.order) || 0);
}

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
    this._selectedMapId = normalizeMapId(game && game.selectedMapId);
    this._leaderboardOpen = false;
    this._leaderboardCategory = 'overall';
    this._leaderboardRequest = 0;
    this._leaderboardReturnFocus = null;
    this._profileOpen = false;
    this._profileAppearance = 'vanguard';
    this._profileReturnFocus = null;

    // combat feedback state
    this._dmg = 0;               // damage vignette energy
    this._dmgOpacity = -1;
    this._deathFxOpacity = -1;
    this._flash = null;          // { i, dur, t }
    this._flashOpacity = -1;
    this._hit = null;            // { t, dur }
    this._wedges = [];           // pooled damage-direction wedges
    this._enemyFire = [];        // recent enemy shot positions for radar

    // feed / stats
    this._feed = [];
    this._stats = new Map();
    this._networkStatsById = new Map();
    this._sbDirty = true;
    this._sbVisible = false;
    this._deathKiller = '';
    this._spectatorTarget = null;
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
      gap: -1, crossVis: null, dead: null, dying: null, spectatorKey: null,
      defuse: -1, defuseVis: null, hintVis: null, kitNote: null,
      reloading: false, fps: '', buyHint: '',
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
    this._wstats = {};
    for (const id in FALLBACK_STATS) this._wstats[id] = { ...FALLBACK_STATS[id] };
    this._maxCarry = { ...FALLBACK_MAXCARRY };
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
          if ((w.slot === 1 || w.slot === 2) &&
            Number.isFinite(w.damage) && Number.isFinite(w.rpm) && w.rpm > 0) {
            this._wstats[id] = { dmg: w.damage, rpm: w.rpm };
          }
          if (Number.isFinite(w.maxCarry)) this._maxCarry[id] = w.maxCarry;
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
      deathFx: $('hud-deathfx'),
      wedges: $('hud-wedges'),
      flash: $('hud-flash'),
      scope: $('hud-scope'),
      scopeZoom: $('hud-scope-zoom'),
      msg: $('hud-msg'),
      msgMain: $('hud-msg-main'),
      msgSub: $('hud-msg-sub'),
      defuse: $('hud-defuse'),
      defuseLabel: $('hud-defuse-label'),
      defuseFill: $('hud-defuse-fill'),
      defuseNote: $('hud-defuse-note'),
      useHint: $('hud-usehint'),
      death: $('hud-death'),
      deathMain: $('hud-death-main'),
      deathKiller: $('hud-death-killer'),
      scoreboard: $('hud-scoreboard'),
      sbScore: $('hud-sb-score'),
      sbBody: $('hud-sb-body'),
      buy: $('hud-buy'),
      buyCats: $('hud-buy-cats'),
      buyFunds: $('hud-buy-funds'),
      buyTimer: $('hud-buy-timer'),
      buyClose: $('hud-buy-close'),
      buyFeedback: $('hud-buy-feedback'),
      buyFeedbackText: $('hud-buy-feedback-text'),
      menu: $('hud-menu'),
      start: $('hud-start'),
      mapPicker: $('hud-map-picker'),
      leaderboardOpen: $('hud-leaderboard-open'),
      leaderboard: $('hud-leaderboard'),
      leaderboardClose: $('hud-leaderboard-close'),
      leaderboardRefresh: $('hud-leaderboard-refresh'),
      leaderboardBody: $('hud-leaderboard-body'),
      leaderboardStatus: $('hud-leaderboard-status'),
      leaderboardName: $('hud-leaderboard-name'),
      leaderboardCharacter: $('hud-leaderboard-character'),
      leaderboardAvatar: $('hud-leaderboard-avatar'),
      profile: $('hud-profile'),
      profileClose: $('hud-profile-close'),
      profileCancel: $('hud-profile-cancel'),
      profileForm: $('hud-profile-form'),
      profileName: $('hud-profile-name'),
      profileCharacters: $('hud-profile-characters'),
      profileMenuLabel: $('hud-menu-profile-label'),
      pause: $('hud-pause'),
      end: $('hud-end'),
      endTitle: $('hud-end-title'),
      endSub: $('hud-end-sub'),
      endScore: $('hud-end-score'),
      endKd: $('hud-end-kd'),
      endRank: $('hud-end-rank'),
      endLeaderboard: $('hud-end-leaderboard'),
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
    this._bindMenuControls();

    // interactive bits
    if (this._el.start) {
      this._el.start.addEventListener('click', () => {
        this.game.sessionMode = 'solo';
        this.game.events.emit('ui:start', { mapId: this._selectedMapId });
        if (this.game.input && typeof this.game.input.requestLock === 'function') {
          this.game.input.requestLock();
        }
      });
    }
    if (this._el.restart) {
      this._el.restart.addEventListener('click', () => {
        this._stats.clear();
        this._networkStatsById.clear();
        this._sbDirty = true;
        this._clearFeed();
        this._endInfo = null;
        this._setEndRank('');
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
    if (this._el.buyClose) {
      this._el.buyClose.addEventListener('click', () => this._setBuyOpen(false));
    }

    // initial visibility matches phase 'menu' until first update flips it
    if (this._el.game) this._el.game.style.display = 'none';
    if (this._el.menu) this._el.menu.style.display = 'flex';
  }

  _bindMenuControls() {
    if (this._el.mapPicker) {
      for (const button of this._el.mapPicker.querySelectorAll('[data-map-id]')) {
        button.addEventListener('click', () => this._selectMap(button.dataset.mapId));
      }
    }
    this._selectMap(this._selectedMapId, false);

    const open = () => this._setLeaderboardOpen(true);
    if (this._el.leaderboardOpen) this._el.leaderboardOpen.addEventListener('click', open);
    if (this._el.endLeaderboard) this._el.endLeaderboard.addEventListener('click', open);
    if (this._el.leaderboardClose) {
      this._el.leaderboardClose.addEventListener('click', () => this._setLeaderboardOpen(false));
    }
    if (this._el.leaderboardRefresh) {
      this._el.leaderboardRefresh.addEventListener('click', () => {
        this._loadLeaderboard(this._leaderboardCategory);
      });
    }
    if (this._el.leaderboard) {
      this._el.leaderboard.addEventListener('click', (event) => {
        if (event.target === this._el.leaderboard) this._setLeaderboardOpen(false);
      });
      for (const tab of this._el.leaderboard.querySelectorAll('[data-leaderboard-category]')) {
        tab.addEventListener('click', () => this._loadLeaderboard(tab.dataset.leaderboardCategory));
      }
    }

    this._renderProfileChoices();
    this._syncProfileUi();
    for (const button of this._root.querySelectorAll('.hud-profile-open')) {
      button.addEventListener('click', () => this._setProfileOpen(true, button));
    }
    if (this._el.profileClose) {
      this._el.profileClose.addEventListener('click', () => this._setProfileOpen(false));
    }
    if (this._el.profileCancel) {
      this._el.profileCancel.addEventListener('click', () => this._setProfileOpen(false));
    }
    if (this._el.profile) {
      this._el.profile.addEventListener('click', (event) => {
        if (event.target === this._el.profile) this._setProfileOpen(false);
      });
    }
    if (this._el.profileForm) {
      this._el.profileForm.addEventListener('submit', (event) => {
        event.preventDefault();
        this._saveProfile();
        this._setProfileOpen(false);
      });
    }
  }

  _profileSnapshot() {
    const profile = this.game && this.game.profile;
    if (profile) {
      const current = typeof profile.get === 'function' ? profile.get() : profile;
      return {
        callsign: String(current?.callsign || profile.callsign || 'Operative'),
        appearanceId: String(current?.appearanceId || profile.appearanceId || 'vanguard'),
      };
    }
    const leaderboard = this.game && this.game.leaderboard;
    return {
      callsign: leaderboard && typeof leaderboard.getPlayerName === 'function'
        ? String(leaderboard.getPlayerName() || 'Operative')
        : 'Operative',
      appearanceId: 'vanguard',
    };
  }

  _profilePresets() {
    const presets = this.game?.profile?.presets;
    if (Array.isArray(presets) && presets.length) return presets;
    return [
      { id: 'vanguard', label: 'Vanguard', description: 'Classic field uniform', swatch: '#71845a' },
      { id: 'ranger', label: 'Ranger', description: 'Urban tactical kit', swatch: '#526d78' },
      { id: 'breacher', label: 'Breacher', description: 'Heavy assault fatigues', swatch: '#9a7851' },
      { id: 'shadow', label: 'Shadow', description: 'Dark operations gear', swatch: '#3f4941' },
    ];
  }

  _renderProfileChoices() {
    if (!this._el.profileCharacters) return;
    const presets = this._profilePresets();
    this._el.profileCharacters.innerHTML = presets.map((preset) =>
      '<button class="profile-character" type="button" data-appearance-id="' + esc(preset.id) +
      '" aria-pressed="false"><span class="profile-portrait" aria-hidden="true"><i></i></span>' +
      '<span class="profile-character-copy"><strong>' + esc(preset.label || preset.id) + '</strong>' +
      '<small>' + esc(preset.description || 'Tactical operative') + '</small></span><b>SELECTED</b></button>'
    ).join('');
    for (const [index, button] of [...this._el.profileCharacters.querySelectorAll('[data-appearance-id]')].entries()) {
      const swatch = String(presets[index]?.swatch || '#71845a');
      button.style.setProperty('--profile-swatch', swatch);
      button.addEventListener('click', () => {
        this._profileAppearance = button.dataset.appearanceId || 'vanguard';
        this._syncProfileSelection();
      });
    }
  }

  _syncProfileSelection() {
    if (!this._el.profileCharacters) return;
    for (const button of this._el.profileCharacters.querySelectorAll('[data-appearance-id]')) {
      const selected = button.dataset.appearanceId === this._profileAppearance;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    }
  }

  _syncProfileUi() {
    const current = this._profileSnapshot();
    this._profileAppearance = current.appearanceId;
    const preset = this._profilePresets().find((item) => item.id === current.appearanceId);
    const appearanceLabel = String(preset?.label || current.appearanceId || 'Vanguard').toUpperCase();
    if (this._el.profileName) this._el.profileName.value = current.callsign;
    if (this._el.leaderboardName) this._el.leaderboardName.textContent = current.callsign;
    if (this._el.leaderboardCharacter) this._el.leaderboardCharacter.textContent = appearanceLabel;
    if (this._el.profileMenuLabel) {
      this._el.profileMenuLabel.textContent = current.callsign.toUpperCase() + ' · ' + appearanceLabel;
    }
    const swatch = String(preset?.swatch || '#71845a');
    if (this._el.leaderboardAvatar) this._el.leaderboardAvatar.style.setProperty('--profile-swatch', swatch);
    this._syncProfileSelection();
  }

  _saveProfile() {
    const callsign = String(this._el.profileName?.value || '').trim();
    const profile = this.game && this.game.profile;
    if (profile && typeof profile.update === 'function') {
      profile.update({ callsign, appearanceId: this._profileAppearance });
    } else {
      const leaderboard = this.game && this.game.leaderboard;
      if (leaderboard && typeof leaderboard.setPlayerName === 'function') {
        leaderboard.setPlayerName(callsign);
      }
    }
    this._syncProfileUi();
  }

  _setProfileOpen(open, returnFocus = null) {
    this._profileOpen = !!open;
    if (!this._el.profile) return;
    if (open) {
      this._profileReturnFocus = returnFocus || document.activeElement;
      this._syncProfileUi();
    }
    this._el.profile.style.display = open ? 'flex' : 'none';
    this._el.profile.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (open) {
      requestAnimationFrame(() => this._el.profileName?.focus());
    } else if (this._profileReturnFocus && typeof this._profileReturnFocus.focus === 'function') {
      this._profileReturnFocus.focus();
      this._profileReturnFocus = null;
    }
  }

  _selectMap(value, notify = true) {
    const id = normalizeMapId(value);
    this._selectedMapId = id;
    if (this.game) this.game.selectedMapId = id;
    try { localStorage.setItem('tiny-strike-map', id); } catch { /* private mode */ }
    if (this._el.mapPicker) {
      for (const button of this._el.mapPicker.querySelectorAll('[data-map-id]')) {
        const selected = button.dataset.mapId === id;
        button.classList.toggle('selected', selected);
        button.setAttribute('aria-pressed', selected ? 'true' : 'false');
      }
    }
    if (notify && this.game?.events) this.game.events.emit('ui:map-select', { mapId: id });
  }

  _setLeaderboardOpen(open) {
    this._leaderboardOpen = !!open;
    if (!this._el.leaderboard) return;
    if (open) this._leaderboardReturnFocus = document.activeElement;
    this._el.leaderboard.style.display = open ? 'flex' : 'none';
    this._el.leaderboard.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (open) {
      this._syncProfileUi();
      this._loadLeaderboard(this._leaderboardCategory);
      requestAnimationFrame(() => this._el.leaderboardClose?.focus());
    } else if (this._leaderboardReturnFocus && typeof this._leaderboardReturnFocus.focus === 'function') {
      this._leaderboardReturnFocus.focus();
      this._leaderboardReturnFocus = null;
    }
  }

  async _loadLeaderboard(category) {
    const client = this.game && this.game.leaderboard;
    this._leaderboardCategory = ['humans', 'bots', 'overall'].includes(category) ? category : 'overall';
    if (this._el.leaderboard) {
      for (const tab of this._el.leaderboard.querySelectorAll('[data-leaderboard-category]')) {
        const active = tab.dataset.leaderboardCategory === this._leaderboardCategory;
        tab.classList.toggle('active', active);
        tab.setAttribute('aria-selected', active ? 'true' : 'false');
      }
    }
    const request = ++this._leaderboardRequest;
    this._setLeaderboardState('loading', 'CONTACTING MATCH SERVERS…');
    if (!client || typeof client.list !== 'function') {
      this._setLeaderboardState('error', 'LEADERBOARD SERVICE IS NOT READY');
      return;
    }
    try {
      const result = await client.list(this._leaderboardCategory, 50);
      if (request !== this._leaderboardRequest) return;
      this._renderLeaderboard(result.entries || []);
      this._renderScoringRules(result.scoring);
      const updated = result.updatedAt ? new Date(result.updatedAt) : null;
      const suffix = updated && !Number.isNaN(updated.getTime())
        ? ' · UPDATED ' + updated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : '';
      this._setLeaderboardStatus('TOP 50 OPERATIVES' + suffix);
    } catch (error) {
      if (request !== this._leaderboardRequest) return;
      const message = error instanceof Error ? error.message : String(error || 'Unknown error');
      this._setLeaderboardState('error', message.toUpperCase());
    }
  }

  _setLeaderboardState(state, message) {
    if (this._el.leaderboardBody) {
      this._el.leaderboardBody.innerHTML =
        '<div class="lb-state ' + esc(state) + '"><span class="lb-state-mark"></span>' +
        '<strong>' + esc(message) + '</strong>' +
        (state === 'error' ? '<small>PRESS REFRESH TO TRY AGAIN</small>' : '') + '</div>';
    }
    this._setLeaderboardStatus(state === 'loading' ? 'SYNCING GLOBAL RANKINGS' : 'SERVICE STATUS');
  }

  _setLeaderboardStatus(text) {
    if (this._el.leaderboardStatus) this._el.leaderboardStatus.textContent = text;
  }

  _renderLeaderboard(entries) {
    if (!this._el.leaderboardBody) return;
    if (!entries.length) {
      this._el.leaderboardBody.innerHTML =
        '<div class="lb-state empty"><span class="lb-state-mark">◇</span>' +
        '<strong>THE BOARD IS WIDE OPEN</strong><small>COMPLETE A MATCH TO CLAIM FIRST PLACE</small></div>';
      return;
    }
    let rows = '';
    for (const entry of entries) {
      const kd = entry.deaths > 0 ? (entry.kills / entry.deaths).toFixed(2) : entry.kills.toFixed(2);
      const winRate = Number(entry.winRate) > 0
        ? Math.round(entry.winRate)
        : (entry.matches > 0 ? Math.round(entry.wins / entry.matches * 100) : 0);
      const medal = entry.rank === 1 ? '◆' : entry.rank === 2 ? '◇' : entry.rank === 3 ? '△' : '';
      rows += '<div class="lb-row rank-' + entry.rank + '">' +
        '<span class="lb-rank">' + (medal ? '<b>' + medal + '</b>' : '') + '#' + entry.rank + '</span>' +
        '<span class="lb-player">' + esc(entry.playerName) + '</span>' +
        '<span class="lb-score">' + Number(entry.score).toLocaleString() + '</span>' +
        '<span>' + entry.wins + '</span><span>' + winRate + '%</span><span>' + kd + '</span>' +
        '</div>';
    }
    this._el.leaderboardBody.innerHTML =
      '<div class="lb-row lb-head"><span>RANK</span><span>OPERATIVE</span><span>SCORE</span>' +
      '<span>WINS</span><span>WIN%</span><span>K/D</span></div>' + rows;
  }

  _renderScoringRules(rules) {
    const el = this._el.leaderboard && this._el.leaderboard.querySelector('#hud-leaderboard-rules');
    if (!el) return;
    if (!rules || typeof rules !== 'object') {
      el.textContent = 'Wins matter most. Kills, headshots, objectives, and completed rounds add score.';
      return;
    }
    const parts = [];
    if (rules.summary) parts.push(String(rules.summary));
    if (Number.isFinite(Number(rules.humanWeight))) {
      parts.push('Human matches earn ' + Number(rules.humanWeight).toFixed(1).replace(/\.0$/, '') + '× value');
    }
    if (Number.isFinite(Number(rules.botDailyFullValueMatches))) {
      parts.push('first ' + Math.round(Number(rules.botDailyFullValueMatches)) + ' bot matches daily score at full value');
    }
    if (Number.isFinite(Number(rules.botDailyReducedRate))) {
      parts.push('later bot matches score ' + Math.round(Number(rules.botDailyReducedRate) * 100) + '%');
    }
    el.textContent = parts.filter(Boolean).join(' · ') ||
      'Wins matter most. Kills, headshots, objectives, and completed rounds add score.';
  }

  _setEndRank(text, state = '') {
    if (!this._el.endRank) return;
    this._el.endRank.textContent = text || '';
    this._el.endRank.className = state;
  }

  _onLeaderboardSubmitted(data) {
    const response = data.response || {};
    const result = response.result || {};
    const entry = response.entry || response.player || response;
    const score = Number(result.points?.overall ?? entry.score ?? response.score);
    const rank = Number(entry.overallRank ?? entry.rank ?? response.rank);
    let text = 'MATCH RECORDED';
    if (Number.isFinite(score)) text += ' · ' + Math.round(score).toLocaleString() + ' SCORE';
    if (Number.isFinite(rank) && rank > 0) text += ' · #' + Math.round(rank) + ' OVERALL';
    this._setEndRank(text, 'success');
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
    ev.on('spectator:target', (d) => {
      this._spectatorTarget = d && d.target ? d.target : null;
      this._cache.spectatorKey = null;
    });
    ev.on('hud:flash', (d) => this._onFlash(d || {}));
    ev.on('weapon:scope', (d) => { if (d) { this._scopeFov = d.fov || 0; } });
    ev.on('weapon:reload:start', () => this._setReloading(true));
    ev.on('weapon:reload:end', () => this._setReloading(false));
    ev.on('weapon:equip', () => this._setReloading(false));
    ev.on('round:start', () => this._onRoundStart());
    ev.on('round:phase', (d) => this._onRoundPhase(d || {}));
    ev.on('round:end', (d) => this._onRoundEnd(d || {}));
    ev.on('game:end', (d) => { this._endInfo = d || null; });
    ev.on('leaderboard:submitting', () => this._setEndRank('CALCULATING YOUR RANK…'));
    ev.on('leaderboard:submitted', (d) => this._onLeaderboardSubmitted(d || {}));
    ev.on('leaderboard:server-recorded', () => {
      this._setEndRank('RANK RECORDED BY MATCH SERVER · OPEN LEADERBOARDS TO VIEW', 'success');
    });
    ev.on('leaderboard:submit-error', () => {
      this._setEndRank('SCORE SAVED — IT WILL SYNC WHEN THE LEADERBOARD IS ONLINE', 'queued');
    });
    ev.on('econ:kill', (d) => this._moneyPop(d && d.reward));
    ev.on('hud:notice', (d) => this._showMsg(d && d.text ? d.text : 'NETWORK UPDATE', '', 2.5));
    ev.on('ui:toggle-buy', () => this._toggleBuy());
    ev.on('input:lock', () => {
      this._locked = true;
      if (this._buyOpen) this._setBuyOpen(false, false); // clicked back into the game
    });
    ev.on('input:unlock', () => { this._locked = false; });
    ev.on('bot:fire', (d) => this._onBotFire(d || {}));
    ev.on('bot:death', () => { this._sbDirty = true; });
    ev.on('ui:map-select', () => { this._rb = null; });
    ev.on('map:changed', (d) => {
      this._rb = null;
      if (d && d.mapId) this._selectMap(d.mapId, false);
    });
    ev.on('profile:changed', () => {
      this._sbDirty = true;
      this._syncProfileUi();
    });

    // Backup key handling while the buy menu is open (pointer unlocked, the
    // input module may or may not route keys then). Debounced against the
    // 'ui:toggle-buy' the weapons module emits for the same keydown.
    this._onKeydownDom = (e) => {
      if (this._profileOpen && (e.key || '').toLowerCase() === 'escape') {
        e.preventDefault();
        this._setProfileOpen(false);
        return;
      }
      if (this._leaderboardOpen && (e.key || '').toLowerCase() === 'escape') {
        e.preventDefault();
        this._setLeaderboardOpen(false);
        return;
      }
      if ((this._profileOpen || this._leaderboardOpen) && e.key === 'Tab') {
        const modal = this._profileOpen ? this._el.profile : this._el.leaderboard;
        const focusable = modal ? [...modal.querySelectorAll(
          'button:not([disabled]), input:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'
        )] : [];
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (first && last && (e.shiftKey ? document.activeElement === first : document.activeElement === last)) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
          return;
        }
      }
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
    if (inGame && this._leaderboardOpen) this._setLeaderboardOpen(false);
    if (inGame && this._profileOpen) this._setProfileOpen(false);

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
      this._cache.dying = null;
    }
  }

  _onRoundStart() {
    this._sbDirty = true;
    this._dmg = 0;
    this._deathKiller = '';
    this._spectatorTarget = null;
    this._cache.dead = null;
    this._cache.dying = null;
    this._cache.spectatorKey = null;
    this._enemyFire.length = 0;
    for (const w of this._wedges) w.ttl = 0;
    if (this._el.death) this._el.death.style.display = 'none';
    if (this._el.deathFx) this._el.deathFx.style.opacity = '0';
    this._deathFxOpacity = 0;
  }

  _onRoundPhase(d) {
    const cfg = (this.game && this.game.config) || {};
    switch (d.phase) {
      case 'freeze': {
        const dur = Math.max(1.5, (cfg.MATCH && cfg.MATCH.FREEZE_TIME || 6) - 0.5);
        const buyPrompt = this.game.input?.touchMode
          ? 'TAP $ BUY FOR EQUIPMENT'
          : 'PRESS B TO BUY EQUIPMENT';
        this._showMsg('BUY PHASE', buyPrompt, dur);
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
    if (d.killerId && this._networkStatsById.has(String(d.killerId))) {
      this._networkStatsById.get(String(d.killerId)).k += 1;
    }
    if (d.victimId && this._networkStatsById.has(String(d.victimId))) {
      this._networkStatsById.get(String(d.victimId)).d += 1;
    }
    this._sbDirty = true;
    this._addFeed(d);
    const mp = this.game.multiplayer;
    if (d.killerName === 'You' || (mp && mp.active && (d.killerId === mp.localId || d.killerName === mp.localName))) {
      this._showKillCue(d);
    }
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
    // Hold a strong impact vignette for the opening beat of the collapse.
    this._dmg = Math.max(this._dmg, 0.8);
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
    const observed = p && p.alive === false && this.game.spectator
      ? this.game.spectator.target
      : null;
    const statusActor = observed && observed.alive !== false ? observed : p;

    const hp = Math.max(0, Math.round((statusActor && Number.isFinite(statusActor.health))
      ? statusActor.health
      : 100));
    if (hp !== c.hp) {
      c.hp = hp;
      if (this._el.healthNum) this._el.healthNum.textContent = String(hp);
    }
    const low = hp > 0 && hp <= 25;
    if (low !== c.hpLow) {
      c.hpLow = low;
      if (this._el.healthBox) this._el.healthBox.classList.toggle('low', low);
    }

    const ar = Math.max(0, Math.round((statusActor && Number.isFinite(statusActor.armor))
      ? statusActor.armor
      : 0));
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
    const p = this.game.player;
    const observed = p && p.alive === false && this.game.spectator
      ? this.game.spectator.target
      : null;
    const spectating = !!(observed && observed.alive !== false);
    const w = this.game.weapons;
    const def = !spectating && w && typeof w.current === 'function' ? w.current() : null;
    const ammo = !spectating && w && typeof w.currentAmmo === 'function' ? w.currentAmmo() : null;

    const observedWeaponId = spectating && observed.weaponId ? String(observed.weaponId) : '';
    const name = spectating
      ? (this._names[observedWeaponId] || observedWeaponId.toUpperCase())
      : ((def && def.name) ? def.name : '');
    if (name !== c.wname) {
      c.wname = name;
      if (this._el.weaponName) this._el.weaponName.textContent = name;
    }

    const mag = spectating
      ? (Number.isFinite(observed.mag) ? observed.mag : null)
      : ((ammo && Number.isFinite(ammo.mag)) ? ammo.mag : null);
    const res = spectating ? null : ((ammo && Number.isFinite(ammo.reserve)) ? ammo.reserve : null);
    const magDisplay = mag === null ? (spectating ? '' : '—') : String(mag);
    const resDisplay = res === null ? '' : '/ ' + res;
    if (magDisplay !== c.mag) {
      c.mag = magDisplay;
      if (this._el.ammoMag) this._el.ammoMag.textContent = magDisplay;
    }
    if (resDisplay !== c.reserve) {
      c.reserve = resDisplay;
      if (this._el.ammoRes) this._el.ammoRes.textContent = resDisplay;
    }
    const magLow = !spectating && mag !== null && def && Number.isFinite(def.magSize) &&
      mag <= Math.max(1, Math.ceil(def.magSize * 0.25));
    if (magLow !== c.magLow) {
      c.magLow = magLow;
      if (this._el.ammoMag) this._el.ammoMag.classList.toggle('low', !!magLow);
    }
    if (spectating && c.reloading) this._setReloading(false);
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
      '<span class="kf-weap">' + esc(wname) + '</span>' +
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
        const friendly = bp.team === ((p && p.team) || 'ct');
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

    // Remote human teammates/enemies use the same visibility rules as bots.
    const remotes = g.multiplayer && g.multiplayer.remotePlayers;
    if (Array.isArray(remotes)) {
      for (const rp of remotes) {
        if (!rp || !rp.alive || !rp.position) continue;
        const dx = rp.position.x - px;
        const dz = rp.position.z - pz;
        const friendly = rp.team === ((p && p.team) || 'ct');
        if (!friendly && dx * dx + dz * dz > ENEMY_SPOT_DIST * ENEMY_SPOT_DIST) continue;
        const bl = this._clampBlip(dx * RADAR_SCALE, dz * RADAR_SCALE);
        c.beginPath();
        c.arc(bl.x, bl.y, bl.cl ? 2.5 : 3.2, 0, Math.PI * 2);
        c.fillStyle = friendly ? 'rgba(127,179,230,.95)' : 'rgba(226,96,79,.95)';
        c.fill();
        if (st.bomb && st.bomb.carrierId === rp.networkId) {
          c.beginPath(); c.arc(bl.x, bl.y, 5.2, 0, Math.PI * 2);
          c.strokeStyle = 'rgba(240,161,60,.95)'; c.lineWidth = 1.4; c.stroke();
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

    // Briefly drain the scene into a dark red wash while the first-person
    // collapse plays. It clears before spectator ownership changes, making
    // the camera cut feel deliberate instead of instantaneous.
    let deathOp = 0;
    const phase = this._cache.phase;
    if (p && p.alive === false && p.spectatorReady === false && MATCH_PHASES[phase] === 1) {
      const duration = Math.max(0.001, Number(p.deathTransitionDuration) || 1.55);
      const progress = clamp((Number(p.deathElapsed) || 0) / duration, 0, 1);
      deathOp = 0.7 * Math.pow(1 - progress, 0.58);
    }
    if (Math.abs(deathOp - this._deathFxOpacity) > 0.008 ||
      (deathOp === 0 && this._deathFxOpacity !== 0)) {
      this._deathFxOpacity = deathOp;
      if (this._el.deathFx) this._el.deathFx.style.opacity = deathOp.toFixed(3);
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
    const plantProg = Number.isFinite(bomb.plantProgress) ? bomb.plantProgress : 0;
    const p = this.game.player;
    const cfg = (this.game.config && this.game.config.MATCH) || {};

    const planting = plantProg > 0 && phase === 'live';
    const show = (prog > 0 && phase === 'planted') || planting;
    if (show !== c.defuseVis) {
      c.defuseVis = show;
      if (this._el.defuse) this._el.defuse.style.display = show ? 'block' : 'none';
      if (this._el.moneyBox && this.game.input?.touchMode) {
        this._el.moneyBox.style.visibility = show ? 'hidden' : '';
      }
      c.defuse = -1;
    }
    if (show) {
      const hasKit = !!(p && p.hasKit);
      const need = planting ? (cfg.PLANT_TIME || 3.2) : (hasKit ? (cfg.DEFUSE_TIME_KIT || 5) : (cfg.DEFUSE_TIME || 10));
      const frac = clamp((planting ? plantProg : prog) / need, 0, 1);
      if (this._el.defuseLabel) this._el.defuseLabel.textContent = planting ? 'PLANTING…' : 'DEFUSING…';
      if (planting && this._el.defuseNote) {
        c.kitNote = null;
        this._el.defuseNote.textContent = 'ARMING C4 — HOLD STEADY';
        this._el.defuseNote.classList.remove('kit');
      }
      if (Math.abs(frac - c.defuse) > 0.004) {
        c.defuse = frac;
        if (this._el.defuseFill) this._el.defuseFill.style.transform = 'scaleX(' + frac.toFixed(4) + ')';
      }
      if (!planting && hasKit !== c.kitNote) {
        c.kitNote = hasKit;
        if (this._el.defuseNote) {
          this._el.defuseNote.textContent = hasKit ? 'DEFUSE KIT ATTACHED' : 'NO KIT — HOLD STEADY';
          this._el.defuseNote.classList.toggle('kit', hasKit);
        }
      }
    }

    // proximity hint
    let hint = false;
    let hintText = 'HOLD E TO DEFUSE THE BOMB';
    if (!show && phase === 'planted' && p && p.team === 'ct' && p.alive !== false && bomb.pos && p.position) {
      const dx = p.position.x - bomb.pos.x;
      const dz = p.position.z - bomb.pos.z;
      hint = (dx * dx + dz * dz) < 2.4 * 2.4;
    } else if (!show && phase === 'live' && p && p.team === 't' && p.alive !== false &&
      p.networkId && bomb.carrierId === p.networkId && p.position) {
      const sites = this.game.world && this.game.world.bombSites;
      if (Array.isArray(sites)) {
        for (const site of sites) {
          if (site.box && site.center && site.box.containsPoint(
            { x: p.position.x, y: site.center.y, z: p.position.z }
          )) { hint = true; hintText = 'HOLD E TO PLANT THE BOMB'; break; }
        }
      }
    }
    if (hint !== c.hintVis) {
      c.hintVis = hint;
      if (this._el.useHint) this._el.useHint.style.display = hint ? 'block' : 'none';
    }
    if (hint && this._el.useHint) this._el.useHint.innerHTML = hintText.replace(' E ', ' <kbd>E</kbd> ');
  }

  // --------------------------------------------------------------------------
  // Death overlay
  // --------------------------------------------------------------------------

  _updateDeath(phase) {
    const c = this._cache;
    const p = this.game.player;
    const dead = !!(p && p.alive === false) && MATCH_PHASES[phase] === 1;
    const dying = dead && p && p.spectatorReady === false;
    const mp = this.game.multiplayer;
    const waiting = !!(dead && mp && mp.active && mp.waitingForNextRound);
    const joinRound = waiting && Number.isFinite(Number(mp.joinRound)) ? Math.floor(Number(mp.joinRound)) : null;
    const target = !dying && dead && p && p.spectatorTarget
      ? p.spectatorTarget
      : (!dying && dead ? this._spectatorTarget : null);
    const targetKey = `${waiting ? `waiting:${joinRound || '?'}` : ''}:${target ? String(target.id || target.name || '') : ''}`;
    if (dead !== c.dead || dying !== c.dying || targetKey !== c.spectatorKey) {
      c.dead = dead;
      c.dying = dying;
      c.spectatorKey = targetKey;
      if (this._el.death) this._el.death.style.display = dead ? 'flex' : 'none';
      if (this._el.death) this._el.death.classList.toggle('transitioning', dying);
      if (dead) {
        if (this._el.deathMain) {
          this._el.deathMain.textContent = waiting
            ? `SPAWNING ROUND ${joinRound || 'NEXT'}`
            : target
            ? 'SPECTATING ' + String(target.name || 'TEAMMATE').toUpperCase()
            : 'YOU ARE DEAD';
        }
        if (this._el.deathKiller) {
          if (target) {
            const team = target.team === 't' ? 'TERRORIST' : 'COUNTER-TERRORIST';
            const kind = target.kind === 'bot' ? 'BOT' : 'PLAYER';
            const next = this.game.input?.touchMode ? 'NEXT — SWITCH PLAYER' : 'SPACE — NEXT PLAYER';
            this._el.deathKiller.textContent = waiting
              ? 'MID-ROUND JOIN · SPECTATING ' + String(target.name || 'TEAMMATE').toUpperCase() + ' · ' + next
              : team + ' · ' + kind + ' · ' + next;
          } else {
            this._el.deathKiller.textContent = waiting
              ? 'MID-ROUND JOIN · WAITING FOR DEPLOYMENT'
              : this._deathKiller
              ? 'ELIMINATED BY ' + this._deathKiller.toUpperCase()
              : (dying ? 'ELIMINATED' : 'NO LIVING TEAMMATES');
          }
        }
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

  applyNetworkPlayerStats(roster) {
    for (const entry of Array.isArray(roster) ? roster : []) {
      if (!entry?.id || !entry.stats || typeof entry.stats !== 'object') continue;
      this._networkStatsById.set(String(entry.id), {
        k: Math.max(0, Math.floor(Number(entry.stats.kills) || 0)),
        d: Math.max(0, Math.floor(Number(entry.stats.deaths) || 0)),
      });
    }
    this._sbDirty = true;
  }

  _rebuildScoreboard() {
    this._sbDirty = false;
    if (!this._el.sbBody) return;
    const p = this.game.player;
    const mp = this.game.multiplayer;
    const localName = mp && mp.active
      ? mp.localName
      : String(this.game?.profile?.name || p?.name || 'Operative');
    const rows = [{
      name: localName,
      team: (p && p.team) || 'ct',
      alive: p ? p.alive !== false : true,
      local: true,
      sortId: String(mp?.localId || 'local'),
    }];
    if (mp && mp.active) {
      for (const rp of mp.remotePlayers) {
        rows.push({
          name: rp.name,
          team: rp.team,
          alive: rp.alive,
          local: false,
          sortId: String(rp.networkId || rp.id || ''),
        });
      }
    }
    const bots = this.game.bots && this.game.bots.all;
    if (Array.isArray(bots)) {
      for (let i = 0; i < bots.length; i++) {
        const b = bots[i];
        if (b && b.name) {
          rows.push({
            name: b.name,
            team: b.team || 't',
            alive: !!b.alive,
            local: false,
            sortId: String(b.networkId || b.id || `bot-${i}`),
          });
        }
      }
    }
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      // Solo combat events retain the protocol-safe "You" token; the row
      // still presents the customized callsign while reading those stats.
      row.stats = (mp && mp.active && this._networkStatsById.get(row.sortId)) ||
        this._stat(row.local && !(mp && mp.active) ? 'You' : row.name);
      row.order = i;
    }
    let html = '';
    for (const team of ['ct', 't']) {
      const label = team === 'ct' ? 'COUNTER-TERRORISTS' : 'TERRORISTS';
      html += '<div class="sb-team sb-' + team + '"><div class="sb-team-h">' + label + '</div>' +
      '<table><thead><tr><th class="sb-n">OPERATIVE</th><th>K</th><th>D</th><th class="sb-s">STATUS</th></tr></thead><tbody>';
      const teamRows = rows.filter((row) => row.team === team).sort(compareScoreboardRows);
      for (const r of teamRows) {
        const s = r.stats;
        const status = r.alive
          ? '<span class="sb-alive">ALIVE</span>'
          : '<span class="sb-kia">' + SVG_SKULL + ' DEAD</span>';
        const rowClass = [r.alive ? '' : 'sb-dead', r.local ? 'sb-you' : ''].filter(Boolean).join(' ');
        const current = r.local ? ' aria-current="true"' : '';
        const ownTag = r.local ? '<span class="sb-self-tag">YOU</span>' : '';
        html += '<tr class="' + rowClass + '"' + current + '>' +
          '<td class="sb-n"><span class="sb-name-wrap"><span class="sb-callsign">' + esc(r.name) +
          '</span>' + ownTag + '</span></td><td>' + s.k + '</td><td>' + s.d + '</td>' +
          '<td class="sb-s">' + status + '</td></tr>';
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
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'buy-item';
        const s = this._wstats[id];
        let bars = '';
        if (s && s.rpm > 0) {
          const d = Math.round(clamp(s.dmg / 120, 0.04, 1) * 100);
          const r = Math.round(clamp(s.rpm / 900, 0.04, 1) * 100);
          bars =
            '<div class="bi-bars">' +
            '<div class="bi-bar"><em>DMG</em><span class="bi-track"><i style="width:' + d + '%"></i></span></div>' +
            '<div class="bi-bar"><em>RPM</em><span class="bi-track"><i style="width:' + r + '%"></i></span></div>' +
            '</div>';
        }
        row.innerHTML =
          buyIcon(id) + '<div class="bi-info"><div class="bi-top">' +
          '<span class="bi-name">' + esc(this._names[id] || id) + '</span>' +
          '<span class="bi-price">' + (Number.isFinite(price) ? '$' + price : '—') + '</span>' +
          '<span class="bi-owned">✓ OWNED</span></div>' + bars + '</div>';
        row.addEventListener('click', () => this._tryBuy(id));
        cd.appendChild(row);
        this._buyRows.push({
          id,
          price: Number.isFinite(price) ? price : 0,
          el: row,
          afford: null,
          owned: null,
          grenade: !!GRENADE_IDS[id],
        });
      }
      wrap.appendChild(cd);
    }
    this._buyMoney = -1;
  }

  _tryBuy(id) {
    const w = this.game.weapons;
    if (!w || typeof w.buy !== 'function') return false;
    const bought = w.buy(id);
    this._buyMoney = -1; // force affordability refresh
    // Paint funds/ownership in the same task as the tap. Waiting for the next
    // animation frame felt like a dead button on iPhone, especially because
    // the equipped weapon is hidden behind this full-screen panel.
    this._refreshBuy();

    const label = String(this._names[id] || id).toUpperCase();
    if (bought) {
      const current = typeof w.current === 'function' ? w.current() : null;
      const equipped = w.currentId === id || current?.id === id;
      this._setBuyFeedback('✓ ' + label + ' PURCHASED' + (equipped ? ' · EQUIPPED' : ''), true);
      const row = this._buyRows.find((entry) => entry.id === id);
      if (row?.el) {
        row.el.classList.remove('purchased');
        void row.el.offsetWidth; // restart the confirmation pulse on repeat grenade buys
        row.el.classList.add('purchased');
      }
    } else {
      this._setBuyFeedback('PURCHASE UNAVAILABLE', false);
    }
    return bought;
  }

  _setBuyFeedback(text, success) {
    if (this._el.buyFeedbackText) this._el.buyFeedbackText.textContent = text;
    if (this._el.buyFeedback) {
      this._el.buyFeedback.classList.toggle('feedback-success', !!success);
      this._el.buyFeedback.classList.toggle('feedback-error', !success);
    }
  }

  _clearBuyFeedback() {
    if (this._el.buyFeedbackText) this._el.buyFeedbackText.textContent = 'SELECT AN ITEM TO PURCHASE';
    if (this._el.buyFeedback) {
      this._el.buyFeedback.classList.remove('feedback-success', 'feedback-error');
    }
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
      this._cache.buyHint = '';
      this._clearBuyFeedback();
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

    // header hint — updates only when the whole-second value flips
    const sec = Math.max(0, Math.ceil(Number.isFinite(st.timer) ? st.timer : 0));
    const hint = st.phase === 'freeze'
      ? 'ROUND LIVE IN ' + sec + 'S'
      : 'BUY WINDOW OPEN';
    if (hint !== this._cache.buyHint) {
      this._cache.buyHint = hint;
      if (this._el.buyTimer) this._el.buyTimer.textContent = hint;
    }
  }

  _refreshBuy() {
    const st = (this.game && this.game.state) || {};
    const money = Math.round(Number.isFinite(st.money) ? st.money : 0);
    this._buyMoney = money;
    if (this._el.buyFunds) this._el.buyFunds.textContent = '$ ' + money;
    const w = this.game.weapons;
    const p = this.game.player;
    const maxArmor = (this.game.config && this.game.config.PLAYER &&
      this.game.config.PLAYER.MAX_ARMOR) || 100;
    for (const r of this._buyRows) {
      let owned = false;
      if (r.id === 'armor') owned = !!(p && p.armor >= maxArmor);
      else if (r.id === 'kit') owned = !!(p && p.hasKit);
      else if (r.grenade) {
        const arr = w && w.slots && Array.isArray(w.slots[4]) ? w.slots[4] : null;
        let n = 0;
        if (arr) for (let i = 0; i < arr.length; i++) if (arr[i] === r.id) n++;
        owned = n >= (this._maxCarry[r.id] || 1);
      } else if (w && typeof w.owns === 'function') {
        owned = w.owns(r.id);
      }
      if (owned !== r.owned) {
        r.owned = owned;
        r.el.classList.toggle('owned', owned);
      }
      const afford = owned || r.price <= money;
      if (afford !== r.afford) {
        r.afford = afford;
        r.el.classList.toggle('na', !afford);
      }
      r.el.disabled = owned || !afford;
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
    const maps = MAP_CATALOG.map((map, index) =>
      '<button class="mn-map" type="button" data-map-id="' + esc(map.id) + '" aria-pressed="false" ' +
      'style="--map-a:' + esc(map.colors[0]) + ';--map-b:' + esc(map.colors[1]) + ';--map-c:' + esc(map.colors[2]) + '">' +
      '<span class="mn-map-art" aria-hidden="true"><i></i><i></i><i></i><em>0' + (index + 1) + '</em></span>' +
      '<span class="mn-map-copy"><strong>' + esc(map.name) + '</strong><small>' + esc(map.location) + '</small>' +
      '<span>' + esc(map.tempo) + '</span></span><b>SELECTED</b></button>'
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
      '<div id="hud-deathfx"></div>' +
      '<div id="hud-wedges"></div>' +
      '<div id="hud-death"><div class="death-inner"><div class="death-main" id="hud-death-main">YOU ARE DEAD</div>' +
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
      '<div class="df-label" id="hud-defuse-label">DEFUSING…</div>' +
      '<div class="df-track"><div id="hud-defuse-fill"></div></div>' +
      '<div id="hud-defuse-note">NO KIT — HOLD STEADY</div>' +
      '</div>' +
      '<div id="hud-usehint">HOLD <kbd>E</kbd> TO DEFUSE THE BOMB</div>' +

      // scoreboard
      '<div id="hud-scoreboard"><div class="hud-panel sb-panel">' +
      '<i class="hud-corner tr"></i><i class="hud-corner bl"></i>' +
      '<div class="sb-titlebar"><span class="sb-title">TINY STRIKE — SCOREBOARD</span></div>' +
      '<div class="sb-sub" id="hud-sb-score">CT 0 : 0 T</div>' +
      '<div id="hud-sb-body"></div>' +
      '</div></div>' +

      // buy menu
      '<div id="hud-buy"><div class="hud-panel buy-panel">' +
      '<i class="hud-corner tr"></i><i class="hud-corner bl"></i>' +
      '<div class="buy-head"><div class="buy-head-l"><span class="buy-title">BUY EQUIPMENT</span>' +
      '<span class="buy-hint" id="hud-buy-timer"></span></div>' +
      '<div class="buy-head-actions"><span class="buy-funds" id="hud-buy-funds">$ 800</span>' +
      '<button id="hud-buy-close" class="buy-close" type="button" aria-label="Close buy menu">×</button></div></div>' +
      '<div id="hud-buy-cats"></div>' +
      '<div class="buy-foot" id="hud-buy-feedback">' +
      '<span class="buy-desktop-hint"><kbd>B</kbd> / <kbd>ESC</kbd> — CLOSE &nbsp;·&nbsp; </span>' +
      '<span id="hud-buy-feedback-text" role="status" aria-live="polite" aria-atomic="true">SELECT AN ITEM TO PURCHASE</span></div>' +
      '</div></div>' +

      // flash whiteout — over everything in the game layer
      '<div id="hud-flash"></div>' +
      '</div>' + // /hud-game

      // ------------------------------------------------ pause overlay
      '<div id="hud-pause"><div class="pause-inner">' +
      '<div class="pause-main">CLICK TO RESUME</div>' +
      '<div class="pause-sub">POINTER RELEASED — THE MATCH CONTINUES</div>' +
      '</div></div>' +

      // ------------------------------------------------ main menu
      '<div id="hud-menu">' +
      '<div class="mn-scan"></div>' +
      '<div class="mn-top">' +
      '<div class="mn-op">TACTICAL BOMB DEFUSAL</div>' +
      '<div class="mn-title" data-title="TINY STRIKE">TINY STRIKE</div>' +
      '<div class="mn-sub">FIVE BATTLEGROUNDS · ONE GLOBAL RANK</div>' +
      '</div>' +
      '<section class="mn-map-picker" id="hud-map-picker" aria-label="Choose a battleground">' +
      '<div class="mn-section-head"><span>CHOOSE BATTLEGROUND</span><small>MAP VOTE · SOLO DEPLOYMENT</small></div>' +
      '<div class="mn-map-grid">' + maps + '</div>' +
      '</section>' +
      '<div class="mn-actions">' +
      '<button id="hud-start"><span class="btn-main">START MATCH</span>' +
      '<span class="btn-sub">SOLO + BOTS</span></button>' +
      '<button id="hud-leaderboard-open"><span class="btn-main">LEADERBOARDS</span>' +
      '<span class="btn-sub">HUMANS · BOTS · OVERALL</span></button>' +
      '<button id="hud-profile-menu-open" class="hud-profile-open" type="button"><span class="btn-main">PROFILE</span>' +
      '<span class="btn-sub" id="hud-menu-profile-label">OPERATIVE · VANGUARD</span></button>' +
      '</div>' +
      '<div class="mn-controls">' + controls + '</div>' +
      '<div class="mn-note">WIN MATCHES · PLAY OBJECTIVES · CLIMB THE GLOBAL RANKS</div>' +
      '</div>' +

      // ------------------------------------------------ leaderboard overlay
      '<div id="hud-leaderboard" role="dialog" aria-modal="true" aria-hidden="true" aria-labelledby="hud-lb-title">' +
      '<div class="lb-panel">' +
      '<div class="lb-accent"></div>' +
      '<header class="lb-top"><div><small>TINY STRIKE NETWORK</small><h2 id="hud-lb-title">LEADERBOARDS</h2></div>' +
      '<button id="hud-leaderboard-close" type="button" aria-label="Close leaderboard">×</button></header>' +
      '<div class="lb-toolbar"><div class="lb-identity"><span class="lb-avatar" id="hud-leaderboard-avatar" aria-hidden="true"><i></i></span>' +
      '<span class="lb-identity-copy"><small>YOUR OPERATIVE</small><strong id="hud-leaderboard-name">Operative</strong>' +
      '<span id="hud-leaderboard-character">VANGUARD</span></span>' +
      '<button class="lb-profile-edit hud-profile-open" type="button">EDIT PROFILE</button></div>' +
      '<div class="lb-tabs" role="tablist" aria-label="Leaderboard category">' +
      '<button type="button" data-leaderboard-category="humans" role="tab">HUMANS</button>' +
      '<button type="button" data-leaderboard-category="bots" role="tab">BOTS</button>' +
      '<button type="button" data-leaderboard-category="overall" class="active" role="tab" aria-selected="true">OVERALL</button>' +
      '</div><button id="hud-leaderboard-refresh" type="button">↻ REFRESH</button></div>' +
      '<div class="lb-meta"><span id="hud-leaderboard-status">TOP 50 OPERATIVES</span></div>' +
      '<div id="hud-leaderboard-body"><div class="lb-state loading"><span class="lb-state-mark"></span>' +
      '<strong>CONTACTING MATCH SERVERS…</strong></div></div>' +
      '<details class="lb-scoring"><summary><strong>SCORING DETAILS</strong>' +
      '<span>SEE HOW RANKING POINTS ARE EARNED</span><b aria-hidden="true">+</b></summary>' +
      '<div id="hud-leaderboard-rules">Wins matter most. Kills, headshots, objectives, and completed rounds add score.</div>' +
      '</details>' +
      '<footer class="lb-foot"><span>COMPLETE MATCHES TO SCORE</span><span class="lb-desktop-hint">ESC — CLOSE</span></footer>' +
      '</div></div>' +

      // ------------------------------------------------ profile editor
      '<div id="hud-profile" role="dialog" aria-modal="true" aria-hidden="true" aria-labelledby="hud-profile-title">' +
      '<div class="profile-panel"><div class="profile-accent"></div>' +
      '<header class="profile-top"><div><small>OPERATIVE IDENTITY</small><h2 id="hud-profile-title">CUSTOMIZE PROFILE</h2></div>' +
      '<button id="hud-profile-close" type="button" aria-label="Close profile editor">×</button></header>' +
      '<form id="hud-profile-form"><label class="profile-name"><span>CALLSIGN</span>' +
      '<input id="hud-profile-name" maxlength="20" autocomplete="nickname" spellcheck="false" value="Operative" ' +
      'aria-describedby="hud-profile-name-help"><small id="hud-profile-name-help">Shown in matches and global rankings</small></label>' +
      '<fieldset><legend>CHOOSE YOUR OPERATIVE</legend><div id="hud-profile-characters" class="profile-characters"></div></fieldset>' +
      '<div class="profile-note"><strong>LOADOUT READY</strong><span>Your appearance is applied to your arms and player model.</span></div>' +
      '<footer class="profile-actions"><button id="hud-profile-cancel" type="button">CANCEL</button>' +
      '<button class="profile-save" type="submit">SAVE PROFILE</button></footer>' +
      '</form></div></div>' +

      // ------------------------------------------------ game end
      '<div id="hud-end">' +
      '<div class="mn-scan"></div>' +
      '<div class="end-inner">' +
      '<div id="hud-end-title">MISSION ACCOMPLISHED</div>' +
      '<div id="hud-end-sub"></div>' +
      '<div id="hud-end-score" class="hud-num">CT 0 : 0 T</div>' +
      '<div id="hud-end-kd"></div>' +
      '<div id="hud-end-rank"></div>' +
      '<div class="end-actions"><button id="hud-restart"><span class="btn-main">PLAY AGAIN</span>' +
      '<span class="btn-sub">RE-DEPLOY</span></button>' +
      '<button id="hud-end-leaderboard"><span class="btn-main">VIEW RANKS</span>' +
      '<span class="btn-sub">GLOBAL LEADERBOARD</span></button></div>' +
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
  font-family: "Avenir Next Condensed", "Arial Narrow", "Helvetica Neue", Arial, system-ui, sans-serif;
  font-stretch: condensed;
  color: #9ab26b;
  -webkit-font-smoothing: antialiased;
  --olive: #9ab26b;
  --olive-bright: #d6e5b8;
  --olive-dim: #6a7850;
  --panel-border: rgba(154, 178, 107, 0.34);
  --ct: #7fa8d6;
  --t: #d98a4a;
  --red: #e2503e;
  --money: #9fe07a;
}
#hud * { box-sizing: border-box; margin: 0; padding: 0; }
#hud kbd {
  display: inline-block; min-width: 30px; text-align: center;
  padding: 2px 8px; border: 1px solid rgba(154,178,107,.45);
  background: linear-gradient(180deg, rgba(24, 29, 15, 0.95), rgba(8, 11, 5, 0.95));
  color: var(--olive-bright);
  font: inherit; font-size: 12px; font-weight: 700; letter-spacing: .08em;
  box-shadow: 0 2px 0 rgba(0,0,0,.6), inset 0 1px 0 rgba(200,220,170,.12);
  clip-path: polygon(4px 0, 100% 0, 100% calc(100% - 4px), calc(100% - 4px) 100%, 0 100%, 0 4px);
}
.hud-panel {
  position: relative;
  background:
    linear-gradient(180deg, rgba(24, 29, 15, 0.66) 0%, rgba(11, 14, 7, 0.78) 55%, rgba(5, 7, 3, 0.86) 100%);
  border: 1px solid var(--panel-border);
  box-shadow:
    inset 0 1px 0 rgba(202, 222, 168, 0.10),
    inset 0 0 0 1px rgba(154, 178, 107, 0.05),
    inset 0 0 24px rgba(0, 0, 0, 0.42);
  clip-path: polygon(
    var(--notch, 9px) 0, 100% 0,
    100% calc(100% - var(--notch, 9px)), calc(100% - var(--notch, 9px)) 100%,
    0 100%, 0 var(--notch, 9px));
}
.hud-corner {
  position: absolute; width: 15px; height: 15px; pointer-events: none; opacity: .8;
}
.hud-corner.tr { top: 5px; right: 5px; border-top: 2px solid var(--olive); border-right: 2px solid var(--olive); }
.hud-corner.bl { bottom: 5px; left: 5px; border-bottom: 2px solid var(--olive); border-left: 2px solid var(--olive); }
.hud-num {
  font-variant-numeric: tabular-nums; font-weight: 700; letter-spacing: .02em;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9);
}
#hud-game { position: absolute; inset: 0; z-index: 1; pointer-events: none; }

/* ---------- bottom-left: health / armor ---------- */
#hud-status { position: absolute; left: 18px; bottom: 18px; display: flex; gap: 10px; }
.stat-box { display: flex; align-items: center; gap: 10px; padding: 8px 18px 9px 14px; }
.stat-ico { display: flex; color: var(--olive); filter: drop-shadow(0 1px 1px rgba(0,0,0,.8)); }
.stat-num { font-size: 33px; line-height: 1; color: var(--olive-bright); min-width: 52px; }
#hud-health.low { border-color: rgba(226, 80, 62, 0.75); animation: hud-low-pulse 1.05s ease-in-out infinite; }
#hud-health.low .stat-num, #hud-health.low .stat-ico { color: #e8604e; }
@keyframes hud-low-pulse {
  0%, 100% { box-shadow: inset 0 1px 0 rgba(202,222,168,.10), inset 0 0 24px rgba(0,0,0,.42); }
  50% { box-shadow: inset 0 0 0 1px rgba(226,70,50,.5), inset 0 0 26px rgba(150,20,10,.55); }
}

/* ---------- bottom-center-left: money ---------- */
#hud-money {
  position: absolute; left: 33%; bottom: 18px; padding: 9px 18px 10px;
  font-size: 25px; font-weight: 700; color: var(--money); display: flex; gap: 7px; align-items: baseline;
}
#hud-money .money-sign { font-size: 16px; opacity: .75; font-weight: 800; }
#hud-money.pulse { animation: hud-money-pulse .4s ease-out; }
@keyframes hud-money-pulse {
  0% { box-shadow: inset 0 0 0 1px rgba(159,224,122,.55), inset 0 0 22px rgba(90,160,60,.35); }
  100% { box-shadow: inset 0 1px 0 rgba(202,222,168,.10), inset 0 0 24px rgba(0,0,0,.42); }
}
.money-pop {
  position: absolute; right: 6px; top: -16px; font-size: 15px; font-weight: 800;
  color: var(--money); text-shadow: 0 1px 2px #000; pointer-events: none; letter-spacing: .04em;
  animation: hud-money-rise 1.1s ease-out forwards;
}
@keyframes hud-money-rise {
  from { opacity: 1; transform: translateY(0); }
  to { opacity: 0; transform: translateY(-34px); }
}

/* ---------- bottom-right: ammo ---------- */
#hud-ammo { position: absolute; right: 18px; bottom: 18px; padding: 7px 18px 10px; text-align: right; min-width: 158px; }
.ammo-row { display: flex; align-items: baseline; justify-content: flex-end; gap: 7px; }
#hud-ammo-mag { font-size: 40px; line-height: 1; color: var(--olive-bright); }
#hud-ammo-mag.low { color: #e8604e; }
#hud-ammo-reserve { font-size: 19px; color: var(--olive-dim); }
#hud-weapon-name {
  font-size: 11px; letter-spacing: .3em; color: var(--olive); text-transform: uppercase;
  margin-top: 3px; text-shadow: 0 1px 2px #000;
}
#hud-reload {
  display: none; font-size: 11px; font-weight: 700; letter-spacing: .3em; color: #e0b23c;
  animation: hud-blink .55s step-end infinite alternate; margin-bottom: 2px;
}
@keyframes hud-blink { from { opacity: 1; } to { opacity: .25; } }

/* ---------- top-center: timer / scores ---------- */
#hud-top {
  position: absolute; top: 14px; left: 50%; transform: translateX(-50%);
  text-align: center; padding: 7px 30px 8px; min-width: 190px;
}
#hud-top::before {
  content: ''; position: absolute; left: 22%; right: 22%; top: 0; height: 2px;
  background: linear-gradient(90deg, transparent, var(--olive), transparent); opacity: .55;
}
#hud-timer { display: flex; align-items: center; justify-content: center; gap: 8px; }
#hud-timer-num { font-size: 28px; line-height: 1.1; color: var(--olive-bright); }
#hud-timer-num.red { color: #e8604e; }
#hud-bomb-ico {
  display: none; font-size: 11px; font-weight: 800; letter-spacing: .05em;
  color: #fff; background: rgba(200, 40, 24, 0.85); border: 1px solid rgba(255, 120, 100, 0.7);
  padding: 1px 6px;
  clip-path: polygon(3px 0, 100% 0, 100% calc(100% - 3px), calc(100% - 3px) 100%, 0 100%, 0 3px);
  animation: hud-bomb-pulse .8s ease-in-out infinite;
}
@keyframes hud-bomb-pulse {
  0%, 100% { opacity: 1; box-shadow: 0 0 10px rgba(226, 60, 40, 0.9); }
  50% { opacity: .55; box-shadow: 0 0 2px rgba(226, 60, 40, 0.3); }
}
#hud-scores { font-size: 15px; margin-top: 2px; display: flex; justify-content: center; gap: 7px; align-items: baseline; }
#hud-scores .hud-num { font-size: 17px; color: var(--olive-bright); }
.sc-ct { color: var(--ct); font-weight: 800; letter-spacing: .08em; }
.sc-t { color: var(--t); font-weight: 800; letter-spacing: .08em; }
.sc-colon { color: var(--olive-dim); }
#hud-round { font-size: 9.5px; letter-spacing: .26em; color: var(--olive-dim); margin-top: 3px; }

/* ---------- top-right: killfeed ---------- */
#hud-killfeed {
  position: absolute; top: 16px; right: 16px; display: flex; flex-direction: column;
  gap: 6px; align-items: flex-end; max-width: 60vw; z-index: 3;
}
.kf-entry {
  display: flex; gap: 11px; align-items: center; padding: 7px 16px 7px 14px;
  background: linear-gradient(180deg, rgba(13, 17, 8, 0.72), rgba(5, 7, 3, 0.8));
  border: 1px solid rgba(154, 178, 107, 0.2);
  box-shadow: inset 0 1px 0 rgba(202, 222, 168, 0.07);
  clip-path: polygon(7px 0, 100% 0, 100% calc(100% - 7px), calc(100% - 7px) 100%, 0 100%, 0 7px);
  font-size: 22px; font-weight: 800; letter-spacing: .03em;
  transition: opacity .6s; white-space: nowrap;
  animation: kf-in .26s cubic-bezier(.18, .8, .3, 1);
}
@keyframes kf-in {
  from { opacity: 0; transform: translateX(28px); }
  to { opacity: 1; transform: translateX(0); }
}
.kf-entry.kf-fade { opacity: 0; }
.kf-entry.kf-mine {
  border-color: rgba(154, 178, 107, 0.8); background: linear-gradient(180deg, rgba(33, 42, 17, 0.82), rgba(18, 24, 9, 0.86));
  box-shadow: inset 0 0 14px rgba(154, 178, 107, 0.18), inset 0 1px 0 rgba(202, 222, 168, 0.1);
}
.kf-entry.kf-death {
  border-color: rgba(226, 80, 62, 0.8);
  background: linear-gradient(180deg, rgba(52, 13, 9, 0.82), rgba(30, 7, 5, 0.86));
}
.kf-name { text-shadow: 0 1px 3px #000; }
.kf-mine .kf-name { text-shadow: 0 0 8px rgba(190, 220, 150, 0.5), 0 1px 3px #000; }
.kf-ct { color: var(--ct); }
.kf-t { color: var(--t); }
.kf-weap {
  color: var(--olive-bright); font-size: 12px; font-weight: 700; letter-spacing: .18em;
  text-transform: uppercase; padding: 3px 9px;
  background: rgba(154, 178, 107, 0.12); border: 1px solid rgba(154, 178, 107, 0.35);
  clip-path: polygon(4px 0, 100% 0, 100% calc(100% - 4px), calc(100% - 4px) 100%, 0 100%, 0 4px);
}
.kf-hs {
  font-size: 12px; font-weight: 800; color: #fff; letter-spacing: .14em; padding: 3px 7px;
  background: linear-gradient(180deg, rgba(226, 56, 34, 0.95), rgba(168, 30, 16, 0.95));
  border: 1px solid rgba(255, 120, 100, 0.55);
  clip-path: polygon(4px 0, 100% 0, 100% calc(100% - 4px), calc(100% - 4px) 100%, 0 100%, 0 4px);
  text-shadow: 0 1px 1px rgba(0,0,0,.6);
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
#hud-deathfx {
  position: absolute; inset: 0; opacity: 0; z-index: 2; pointer-events: none;
  background:
    radial-gradient(ellipse at 50% 44%, rgba(14, 6, 4, 0) 22%, rgba(48, 8, 4, .42) 70%, rgba(2, 2, 1, .88) 100%),
    linear-gradient(180deg, rgba(34, 5, 2, .13), rgba(1, 2, 1, .42));
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
  opacity: 0; transform: translateY(6px);
  transition: opacity .32s, transform .32s; z-index: 6; pointer-events: none;
}
#hud-msg.show { opacity: 1; transform: translateY(0); }
#hud-msg-main {
  font-size: 36px; font-weight: 900; letter-spacing: .24em; text-transform: uppercase;
  color: #eef5df;
  text-shadow: 0 0 26px rgba(154, 178, 107, 0.5), 0 2px 2px #000;
  -webkit-text-stroke: 1px rgba(0, 0, 0, 0.25);
}
#hud-msg-sub {
  font-size: 13px; font-weight: 700; letter-spacing: .36em; text-transform: uppercase;
  color: var(--olive); margin-top: 8px; text-shadow: 0 1px 2px #000;
}

/* ---------- defuse ---------- */
#hud-defuse {
  position: absolute; left: 50%; bottom: 21%; transform: translateX(-50%);
  width: 320px; padding: 10px 16px 12px; display: none; text-align: center; z-index: 6;
}
.df-label {
  font-size: 13px; font-weight: 800; letter-spacing: .36em; text-transform: uppercase;
  color: var(--olive-bright); margin-bottom: 8px;
}
.df-track {
  height: 13px; border: 1px solid var(--panel-border); background: rgba(0, 0, 0, 0.58);
  box-shadow: inset 0 1px 3px rgba(0,0,0,.7);
}
#hud-defuse-fill {
  height: 100%; width: 100%; transform: scaleX(0); transform-origin: left center;
  background: repeating-linear-gradient(-45deg, #7ba04c 0 9px, #a9c87c 9px 18px);
  box-shadow: inset 0 1px 0 rgba(230, 244, 205, 0.4);
  animation: df-stripes .48s linear infinite;
}
@keyframes df-stripes {
  from { background-position: 0 0; }
  to { background-position: 25.46px 0; }
}
#hud-defuse-note {
  font-size: 9.5px; font-weight: 700; letter-spacing: .24em; color: var(--olive-dim); margin-top: 7px;
}
#hud-defuse-note.kit { color: var(--money); }
#hud-usehint {
  position: absolute; left: 50%; bottom: 21%; transform: translateX(-50%);
  display: none; font-size: 13px; font-weight: 700; letter-spacing: .22em; color: var(--olive-bright);
  text-shadow: 0 1px 3px #000; z-index: 6;
}

/* ---------- death ---------- */
#hud-death {
  position: absolute; left: 50%; bottom: clamp(26px, 6vh, 66px); display: none;
  transform: translateX(-50%); align-items: center; justify-content: center;
  width: min(620px, calc(100vw - 30px)); z-index: 7; pointer-events: none;
}
.death-inner {
  width: 100%; padding: 12px 20px 11px; text-align: center;
  background: linear-gradient(180deg, rgba(14, 17, 10, .90), rgba(5, 7, 4, .94));
  border: 1px solid rgba(212, 86, 44, .62); border-left-width: 4px;
  box-shadow: inset 0 1px rgba(255, 255, 255, .06), 0 9px 30px rgba(0, 0, 0, .42);
  clip-path: polygon(8px 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%, 0 8px);
}
#hud-death.transitioning .death-inner {
  animation: death-card-in .48s cubic-bezier(.2, .75, .25, 1) both;
}
@keyframes death-card-in {
  from { opacity: 0; transform: translateY(12px) scale(.985); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
.death-main {
  font-size: 17px; font-weight: 900; letter-spacing: .2em; text-transform: uppercase;
  color: #eef5df; text-shadow: 0 2px 5px #000;
}
.death-sub {
  font-size: 10px; font-weight: 700; letter-spacing: .18em; color: #b9aa9b;
  margin-top: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* ---------- scoreboard ---------- */
#hud-scoreboard {
  position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
  z-index: 10; padding: clamp(24px, 4vw, 56px); background: rgba(2, 4, 1, 0.52);
}
.sb-panel {
  --notch: 14px; width: min(1050px, 100%); max-height: 100%; padding: 0 0 28px;
  overflow: auto; backdrop-filter: blur(8px);
  border-color: rgba(154, 178, 107, 0.46);
  box-shadow: inset 0 0 34px rgba(0, 0, 0, .5), 0 14px 55px rgba(0, 0, 0, .48);
}
.sb-titlebar {
  padding: 19px 32px 17px; text-align: center;
  background: linear-gradient(180deg, rgba(154, 178, 107, 0.17), rgba(154, 178, 107, 0.03));
  border-bottom: 1px solid var(--panel-border);
}
.sb-title {
  display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 22px; font-weight: 900; letter-spacing: .25em; color: var(--olive-bright);
  text-shadow: 0 1px 2px #000;
}
.sb-sub {
  text-align: center; font-size: 25px; font-weight: 900; letter-spacing: .18em;
  color: var(--olive-bright); margin: 18px 0 5px; font-variant-numeric: tabular-nums;
}
.sb-team { margin: 16px 32px 0; border: 1px solid rgba(154, 178, 107, 0.2); background: rgba(0, 0, 0, 0.3); }
.sb-team-h {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 16px; font-weight: 900; letter-spacing: .24em; padding: 10px 18px 9px;
  text-shadow: 0 1px 2px rgba(0,0,0,.7);
}
.sb-ct .sb-team-h {
  color: #e6f0fb;
  background: linear-gradient(90deg, rgba(62, 96, 136, 0.92), rgba(62, 96, 136, 0.10));
  box-shadow: inset 0 0 0 1px rgba(127, 168, 214, 0.22), inset 3px 0 0 var(--ct);
}
.sb-t .sb-team-h {
  color: #fbeddc;
  background: linear-gradient(90deg, rgba(148, 82, 30, 0.92), rgba(148, 82, 30, 0.10));
  box-shadow: inset 0 0 0 1px rgba(217, 138, 74, 0.22), inset 3px 0 0 var(--t);
}
.sb-team table { width: 100%; table-layout: fixed; border-collapse: collapse; }
.sb-team th {
  font-size: 12px; letter-spacing: .2em; color: var(--olive-dim); font-weight: 900;
  text-align: center; padding: 9px 14px 7px; border-bottom: 1px solid rgba(154, 178, 107, 0.14);
}
.sb-team th.sb-n, .sb-team td.sb-n { text-align: left; width: 54%; padding-left: 22px; }
.sb-team th.sb-s, .sb-team td.sb-s { text-align: right; width: 24%; padding-right: 22px; }
.sb-team td.sb-n {
  max-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.sb-name-wrap { display: flex; align-items: center; gap: 9px; min-width: 0; }
.sb-callsign { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sb-self-tag {
  flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center;
  padding: 3px 7px 2px; border: 1px solid rgba(225, 249, 181, .8);
  background: #b9dc7e; color: #11180b; font-size: 9px; font-weight: 950;
  line-height: 1; letter-spacing: .16em; text-shadow: none;
  box-shadow: 0 0 12px rgba(185, 220, 126, .2);
}
.sb-team td {
  font-size: 19px; font-weight: 750; color: var(--olive-bright); padding: 7px 14px;
  text-align: center; font-variant-numeric: tabular-nums;
}
.sb-team tbody tr:nth-child(odd) td { background: rgba(255, 255, 255, 0.028); }
.sb-team td.sb-s { font-size: 13px; font-weight: 900; letter-spacing: .14em; white-space: nowrap; }
.sb-team td.sb-s .sb-alive { color: #a9d38a; }
.sb-team td.sb-s .sb-kia { color: #b2604e; display: inline-flex; align-items: center; gap: 5px; }
.sb-team td.sb-s .sb-kia svg { opacity: .9; }
.sb-team tr.sb-dead:not(.sb-you) td { opacity: .42; }
.sb-team tbody tr.sb-you td {
  opacity: 1; color: #f3ffdc; font-weight: 900;
  background: linear-gradient(90deg, rgba(154, 191, 91, .38), rgba(91, 119, 48, .22));
  box-shadow: inset 0 1px 0 rgba(213, 242, 159, .45), inset 0 -1px 0 rgba(154, 191, 91, .38);
  text-shadow: 0 1px 2px #000, 0 0 10px rgba(187, 224, 119, .16);
}
.sb-team tbody tr.sb-you td:first-child {
  box-shadow: inset 5px 0 0 #c8eb89, inset 0 1px 0 rgba(213, 242, 159, .45), inset 0 -1px 0 rgba(154, 191, 91, .38);
}
.sb-team tbody tr.sb-you.sb-dead td { opacity: .82; }

/* ---------- buy menu ---------- */
#hud-buy {
  position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
  z-index: 12; padding: clamp(18px, 3vw, 44px); background: rgba(2, 4, 1, 0.58);
}
.buy-panel {
  --notch: 14px; pointer-events: auto; cursor: default;
  display: flex; flex-direction: column; width: min(1180px, 100%); max-height: 100%;
  padding: 0 0 18px; overflow: hidden; backdrop-filter: blur(8px);
  border-color: rgba(154, 178, 107, 0.5);
  box-shadow: inset 0 0 34px rgba(0, 0, 0, .52), 0 14px 60px rgba(0, 0, 0, .56);
}
.buy-head {
  flex: 0 0 auto; display: flex; justify-content: space-between; align-items: center;
  gap: 20px; padding: 17px 26px 15px; margin-bottom: 16px;
  background: linear-gradient(180deg, rgba(154, 178, 107, 0.17), rgba(154, 178, 107, 0.03));
  border-bottom: 1px solid var(--panel-border);
}
.buy-head-l { min-width: 0; display: flex; align-items: baseline; gap: 20px; }
.buy-head-actions { flex: 0 0 auto; display: flex; align-items: center; gap: 12px; }
.buy-title {
  flex: 0 0 auto; font-size: 19px; font-weight: 800; letter-spacing: .3em; color: var(--olive-bright);
  text-shadow: 0 1px 2px #000;
}
.buy-hint {
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 11.5px; font-weight: 700; letter-spacing: .22em; color: var(--olive-dim);
}
.buy-funds {
  flex: 0 0 auto; font-size: 26px; font-weight: 800; letter-spacing: .05em; color: var(--money);
  font-variant-numeric: tabular-nums; text-shadow: 0 1px 2px #000;
}
.buy-close {
  display: none; width: 48px; height: 48px; padding: 0; border: 1px solid rgba(154,178,107,.48);
  background: rgba(0,0,0,.34); color: var(--olive-bright); font: 800 25px/1 Arial,sans-serif;
  cursor: pointer; touch-action: manipulation;
}
.buy-close:hover,.buy-close:focus-visible { background: rgba(154,178,107,.22); border-color: var(--olive); outline: none; }
#hud-buy-cats {
  min-height: 0; overflow: auto; display: grid; grid-template-columns: repeat(5, minmax(0, 1fr));
  align-items: start; gap: 13px; padding: 0 20px 2px;
  scrollbar-width: thin; scrollbar-color: rgba(154,178,107,.55) rgba(0,0,0,.28);
}
.buy-cat {
  min-width: 0; background: rgba(0, 0, 0, 0.32); border: 1px solid rgba(154, 178, 107, 0.2);
  padding: 0 8px 9px;
}
.buy-cat-h {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 12px; font-weight: 800; letter-spacing: .28em; color: var(--olive);
  text-align: center; padding: 9px 5px 8px; margin: 0 -8px 8px;
  background: linear-gradient(180deg, rgba(154, 178, 107, 0.13), rgba(154, 178, 107, 0.0));
  border-bottom: 1px solid rgba(154, 178, 107, 0.2);
  text-shadow: 0 1px 2px #000;
}
.buy-item {
  appearance:none; display: flex; align-items: center; gap: 10px; width:100%; min-width: 0; min-height: 66px;
  padding: 9px 10px; margin: 6px 0;
  font-family:inherit; color:inherit; text-align:left;
  background: rgba(154, 178, 107, 0.05); border: 1px solid rgba(154, 178, 107, 0.17);
  clip-path: polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px);
  cursor: pointer; transition: background .09s, border-color .09s, box-shadow .09s;
}
.buy-item:focus-visible { outline:2px solid var(--olive-bright); outline-offset:1px; }
.buy-item:hover {
  background: rgba(154, 178, 107, 0.17); border-color: rgba(154, 178, 107, 0.6);
  box-shadow: inset 0 0 12px rgba(154, 178, 107, 0.14);
}
.buy-item:active { background: rgba(154, 178, 107, 0.32); }
.buy-item.purchased { animation: buy-purchased .72s ease-out; }
@keyframes buy-purchased {
  0% { border-color: #efffba; box-shadow: inset 0 0 24px rgba(211,239,155,.62), 0 0 18px rgba(176,218,104,.66); }
  100% { border-color: rgba(154,178,107,.42); box-shadow: none; }
}
.bi-icon {
  flex: 0 0 66px; width: 66px; height: 38px; display: grid; place-items: center;
  color: #b7c991; opacity: .92; filter: drop-shadow(0 2px 1px rgba(0,0,0,.75));
  border-right: 1px solid rgba(154,178,107,.16); padding-right: 9px;
}
.bi-icon svg { display: block; width: 100%; height: 100%; }
.bi-info { min-width: 0; flex: 1; }
.bi-top { min-width: 0; display: flex; justify-content: space-between; align-items: baseline; gap: 7px; }
.buy-item .bi-name {
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 15.5px; font-weight: 700; color: var(--olive-bright); letter-spacing: .025em;
}
.buy-item .bi-price { flex: 0 0 auto; font-size: 14px; font-weight: 700; color: var(--money); font-variant-numeric: tabular-nums; }
.buy-item .bi-owned { display: none; font-size: 10px; font-weight: 800; letter-spacing: .12em; color: var(--olive); white-space: nowrap; }
.buy-item.owned {
  cursor: default; pointer-events: none;
  background: rgba(154, 178, 107, 0.11); border-color: rgba(154, 178, 107, 0.42);
}
.buy-item.owned .bi-price { display: none; }
.buy-item.owned .bi-owned { display: inline; }
.buy-item.owned .bi-icon { color: var(--money); }
.buy-item.na {
  opacity: .45; cursor: default; pointer-events: none;
  background: rgba(0, 0, 0, 0.22); border-color: rgba(154, 178, 107, 0.08);
}
.buy-item.na .bi-price { color: #dd6450; }
.bi-bars { margin-top: 7px; display: grid; gap: 4px; }
.bi-bar { display: flex; align-items: center; gap: 6px; }
.bi-bar em {
  font-style: normal; font-size: 8px; font-weight: 800; letter-spacing: .16em;
  color: var(--olive-dim); width: 26px;
}
.bi-track { flex: 1; height: 3px; background: rgba(255, 255, 255, 0.08); overflow: hidden; }
.bi-track i { display: block; height: 100%; background: linear-gradient(90deg, #6d8a45, #c9dfa0); }
.buy-foot {
  flex: 0 0 auto; min-height: 34px; margin: 16px 20px 0; padding: 9px 12px 0; border-top: 1px solid var(--panel-border);
  font-size: 11px; font-weight: 700; letter-spacing: .2em; color: var(--olive-dim); text-align: center;
  transition: color .12s, background .12s, border-color .12s, box-shadow .12s;
}
.buy-foot kbd { font-size: 9.5px; min-width: 20px; padding: 1px 5px; }
.buy-foot.feedback-success {
  color: #e5f7bf; background: rgba(111,145,58,.2); border-color: rgba(190,224,128,.68);
  box-shadow: inset 0 0 14px rgba(165,211,94,.12); text-shadow: 0 1px 2px #000;
}
.buy-foot.feedback-error { color: #ffb09c; background: rgba(141,52,35,.18); border-color: rgba(221,100,80,.58); }

/* Keep the two data-heavy overlays comfortably inside common laptop and
   narrow-window viewports. Their inner content scrolls before edges clip. */
@media (max-width: 1100px) {
  #hud-buy-cats { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .bi-icon { flex-basis: 72px; width: 72px; }
}
@media (max-width: 760px) {
  #hud-scoreboard, #hud-buy { padding: 14px; }
  .sb-panel { padding-bottom: 16px; }
  .sb-titlebar { padding-inline: 18px; }
  .sb-title { font-size: 15px; letter-spacing: .22em; }
  .sb-team { margin-inline: 14px; }
  .sb-team-h { letter-spacing: .2em; }
  .sb-team th.sb-n, .sb-team td.sb-n { width: 48%; padding-left: 12px; }
  .sb-team th.sb-s, .sb-team td.sb-s { width: 30%; padding-right: 12px; }
  #hud-buy-cats { grid-template-columns: repeat(2, minmax(0, 1fr)); padding-inline: 14px; }
  .buy-head { padding: 13px 18px 12px; margin-bottom: 12px; }
  .buy-head-l { display: block; }
  .buy-title { font-size: 16px; }
  .buy-hint { margin-top: 3px; font-size: 9.5px; }
  .buy-funds { font-size: 22px; }
  .buy-foot { margin-inline: 14px; font-size: 9px; letter-spacing: .14em; }
}
@media (max-width: 480px) {
  #hud-buy-cats { grid-template-columns: 1fr; }
  .buy-title { letter-spacing: .2em; }
  .buy-hint { display: none; }
  .sb-title { letter-spacing: .15em; }
  .sb-team td { font-size: 14px; padding-inline: 6px; }
  .sb-team td.sb-s { font-size: 9px; letter-spacing: .08em; }
}

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
  align-items: center; justify-content: center; gap: 20px; z-index: 50;
  background:
    radial-gradient(ellipse at 50% 28%, rgba(46, 58, 26, 0.9) 0%, rgba(16, 21, 10, 0.97) 48%, #04070a 100%),
    #05080a;
  pointer-events: auto; cursor: default;
}
#hud-menu {
  justify-content: flex-start; overflow: auto; gap: clamp(11px, 1.8vh, 18px);
  padding: clamp(16px, 2.5vh, 28px) max(18px, env(safe-area-inset-right)) 24px;
  scrollbar-width: thin; scrollbar-color: rgba(154,178,107,.45) rgba(0,0,0,.2);
}
.mn-scan {
  position: absolute; inset: 0; pointer-events: none; opacity: .5;
  background:
    repeating-linear-gradient(0deg, rgba(255, 255, 255, 0.025) 0 1px, transparent 1px 3px),
    radial-gradient(ellipse at center, transparent 55%, rgba(0, 0, 0, 0.55) 100%);
}
.mn-top { flex: 0 0 auto; text-align: center; position: relative; }
.mn-op { font-size: 11px; font-weight: 800; letter-spacing: .62em; color: var(--olive); text-indent: .62em; }
.mn-title {
  position: relative;
  font-size: clamp(42px, 7.2vw, 76px); font-weight: 900; line-height: .98; letter-spacing: .08em;
  color: var(--olive-bright);
  text-shadow: 0 0 38px rgba(154, 178, 107, 0.4), 0 3px 0 rgba(0, 0, 0, 0.9);
}
.mn-title::after {
  content: attr(data-title); position: absolute; inset: 0; pointer-events: none;
  text-shadow: none;
  background: linear-gradient(100deg, transparent 38%, rgba(255, 255, 250, 0.75) 50%, transparent 62%);
  background-size: 260% 100%; background-position: 130% 0;
  -webkit-background-clip: text; background-clip: text; color: transparent;
  animation: mn-sweep 5s ease-in-out infinite;
}
@keyframes mn-sweep {
  0% { background-position: 130% 0; }
  42% { background-position: -130% 0; }
  100% { background-position: -130% 0; }
}
.mn-sub {
  font-size: 10px; font-weight: 800; letter-spacing: .42em; color: var(--olive-dim);
  margin-top: 7px; text-indent: .42em;
}
.mn-map-picker {
  position: relative; flex: 0 0 auto; width: min(1120px, 94vw); padding: 10px;
  background: rgba(4, 7, 4, .56); border: 1px solid rgba(154,178,107,.22);
  clip-path: polygon(10px 0,100% 0,100% calc(100% - 10px),calc(100% - 10px) 100%,0 100%,0 10px);
  box-shadow: inset 0 1px rgba(255,255,255,.04), 0 16px 45px rgba(0,0,0,.22);
}
.mn-section-head { display: flex; align-items: baseline; justify-content: space-between; padding: 0 3px 8px; }
.mn-section-head span { font-size: 11px; font-weight: 900; letter-spacing: .3em; color: var(--olive-bright); }
.mn-section-head small { font-size: 8px; font-weight: 800; letter-spacing: .24em; color: var(--olive-dim); }
.mn-map-grid { display: grid; grid-template-columns: repeat(5,minmax(0,1fr)); gap: 8px; }
.mn-map {
  appearance: none; min-width: 0; padding: 0; position: relative; overflow: hidden; text-align: left;
  font-family: inherit; color: #fff; cursor: pointer; background: var(--map-c);
  border: 1px solid rgba(255,255,255,.13); transition: transform .12s,border-color .12s,box-shadow .12s;
  clip-path: polygon(7px 0,100% 0,100% calc(100% - 7px),calc(100% - 7px) 100%,0 100%,0 7px);
}
.mn-map:hover { transform: translateY(-2px); border-color: var(--map-a); box-shadow: 0 8px 20px rgba(0,0,0,.38); }
.mn-map:focus-visible { outline: 2px solid var(--olive-bright); outline-offset: 2px; }
.mn-map.selected { border-color: var(--map-a); box-shadow: inset 0 0 0 1px var(--map-a),0 0 20px color-mix(in srgb,var(--map-a) 25%,transparent); }
.mn-map-art {
  display: block; height: 62px; position: relative; overflow: hidden;
  background: radial-gradient(circle at 75% 24%,var(--map-a),transparent 28%),linear-gradient(145deg,var(--map-b),var(--map-c) 70%);
}
.mn-map-art::after { content:''; position:absolute; inset:0; background:linear-gradient(0deg,rgba(0,0,0,.58),transparent 60%),repeating-linear-gradient(115deg,transparent 0 16px,rgba(255,255,255,.035) 17px 18px); }
.mn-map-art i { position:absolute; bottom:-6px; z-index:1; width:44%; height:54%; background:var(--map-c); opacity:.88; transform:skewX(-10deg); box-shadow:0 -1px rgba(255,255,255,.15); }
.mn-map-art i:nth-child(1) { left:-5%; height:38%; }
.mn-map-art i:nth-child(2) { left:30%; height:62%; background:var(--map-b); }
.mn-map-art i:nth-child(3) { right:-8%; height:46%; }
.mn-map-art em { position:absolute; right:7px; top:4px; z-index:2; font-size:9px; font-style:normal; font-weight:900; letter-spacing:.18em; color:rgba(255,255,255,.64); }
.mn-map-copy { display:block; min-width:0; padding:7px 9px 8px; }
.mn-map-copy strong,.mn-map-copy small { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.mn-map-copy strong { font-size:14px; font-weight:900; letter-spacing:.08em; color:#f0f4e9; }
.mn-map-copy small { margin-top:2px; font-size:9px; font-weight:700; letter-spacing:.06em; color:rgba(230,238,218,.68); }
.mn-map-copy span { display:block; margin-top:5px; font-size:9px; font-weight:900; letter-spacing:.14em; text-transform:uppercase; color:var(--map-a); }
.mn-map > b { display:none; position:absolute; right:5px; bottom:5px; padding:2px 4px; background:var(--map-a); color:#101510; font-size:7px; letter-spacing:.12em; }
.mn-map.selected > b { display:block; }
.mn-actions,.end-actions { position:relative; display:flex; align-items:stretch; justify-content:center; gap:10px; }
#hud-start, #hud-restart, #hud-leaderboard-open, #hud-end-leaderboard, #hud-profile-menu-open {
  pointer-events: auto; cursor: pointer; position: relative;
  font-family: inherit; font-stretch: condensed;
  color: var(--olive-bright);
  background: linear-gradient(180deg, rgba(154, 178, 107, 0.2), rgba(154, 178, 107, 0.07));
  border: 1px solid var(--olive); padding: 11px 34px 10px; min-width: 244px;
  text-shadow: 0 1px 2px #000;
  clip-path: polygon(11px 0, 100% 0, 100% calc(100% - 11px), calc(100% - 11px) 100%, 0 100%, 0 11px);
  box-shadow: inset 0 1px 0 rgba(214, 229, 184, 0.25), inset 0 0 0 1px rgba(154, 178, 107, 0.12);
  transition: background .12s, box-shadow .12s, transform .06s;
}
#hud-start .btn-main, #hud-restart .btn-main, #hud-leaderboard-open .btn-main, #hud-end-leaderboard .btn-main, #hud-profile-menu-open .btn-main {
  display: block; font-size: 16px; font-weight: 900; letter-spacing: .27em; text-indent: .27em;
}
#hud-start .btn-sub, #hud-restart .btn-sub, #hud-leaderboard-open .btn-sub, #hud-end-leaderboard .btn-sub, #hud-profile-menu-open .btn-sub {
  display: block; margin-top: 4px; font-size: 10px; font-weight: 700;
  letter-spacing: .44em; text-indent: .44em; color: var(--olive);
}
#hud-start:hover, #hud-restart:hover, #hud-leaderboard-open:hover, #hud-end-leaderboard:hover, #hud-profile-menu-open:hover {
  background: linear-gradient(180deg, rgba(154, 178, 107, 0.36), rgba(154, 178, 107, 0.14));
  box-shadow:
    inset 0 1px 0 rgba(214, 229, 184, 0.35), inset 0 0 22px rgba(154, 178, 107, 0.28),
    inset 0 0 0 1px rgba(154, 178, 107, 0.25);
}
#hud-start:active, #hud-restart:active, #hud-leaderboard-open:active, #hud-end-leaderboard:active, #hud-profile-menu-open:active {
  transform: translateY(1px);
  background: linear-gradient(180deg, rgba(154, 178, 107, 0.42), rgba(154, 178, 107, 0.2));
}
.mn-controls {
  position: relative; flex:0 0 auto; width:min(920px,92vw); display: grid; grid-template-columns: repeat(4,minmax(0,1fr));
  gap: 5px 20px; padding: 11px 16px;
  background: linear-gradient(180deg, rgba(10, 13, 6, 0.55), rgba(4, 6, 2, 0.65));
  border: 1px solid rgba(154, 178, 107, 0.22);
  clip-path: polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px);
  box-shadow: inset 0 1px 0 rgba(202, 222, 168, 0.07);
}
.mn-ctl { min-width:0; display: flex; align-items: center; gap: 8px; }
.mn-ctl kbd { flex:0 0 auto; min-width: 48px; font-size:9px!important; }
.mn-ctl span { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size: 10px; font-weight: 700; letter-spacing: .1em; color: var(--olive); text-transform: uppercase; }
.mn-note { position: relative; font-size: 11px; letter-spacing: .26em; color: var(--olive-dim); text-align: center; }

/* ---------- global leaderboard ---------- */
#hud-leaderboard {
  position:absolute; inset:0; z-index:80; display:none; align-items:center; justify-content:center;
  padding:clamp(24px,4vw,64px); pointer-events:auto; cursor:default;
  background:radial-gradient(circle at 50% 12%,rgba(76,101,43,.28),rgba(2,4,3,.92) 58%);
  backdrop-filter:blur(12px);
}
.lb-panel {
  position:relative; width:min(1180px,100%); height:min(760px,100%); min-height:min(560px,100%);
  display:flex; flex-direction:column; overflow:hidden; color:var(--olive-bright);
  background:linear-gradient(145deg,rgba(21,28,15,.98),rgba(4,7,5,.985));
  border:1px solid rgba(178,207,124,.44); box-shadow:0 25px 100px rgba(0,0,0,.66),inset 0 1px rgba(255,255,255,.08);
  clip-path:polygon(15px 0,100% 0,100% calc(100% - 15px),calc(100% - 15px) 100%,0 100%,0 15px);
}
.lb-accent { flex:0 0 auto; height:3px; background:linear-gradient(90deg,#657c43,#d6e5b8 44%,#d98a4a); box-shadow:0 0 18px rgba(192,220,139,.5); }
.lb-top { flex:0 0 auto; display:flex; align-items:center; justify-content:space-between; padding:22px 30px 18px; border-bottom:1px solid rgba(154,178,107,.17); }
.lb-top small { display:block; margin-bottom:4px; font-size:10px; font-weight:900; letter-spacing:.38em; color:var(--olive-dim); }
.lb-top h2 { font-size:38px; line-height:1; font-weight:900; letter-spacing:.18em; color:#edf4df; }
#hud-leaderboard-close { width:46px; height:46px; cursor:pointer; font-family:inherit; font-size:34px; font-weight:300; line-height:1; color:var(--olive); border:1px solid rgba(154,178,107,.26); background:rgba(0,0,0,.2); }
#hud-leaderboard-close:hover { color:#fff; border-color:var(--olive); background:rgba(154,178,107,.13); }
.lb-toolbar { flex:0 0 auto; display:grid; grid-template-columns:minmax(320px,1fr) auto auto; gap:18px; align-items:center; padding:16px 30px; background:rgba(0,0,0,.2); }
.lb-identity { min-width:0; min-height:50px; display:flex; align-items:center; gap:12px; }
.lb-avatar { --profile-swatch:#71845a; position:relative; flex:0 0 46px; height:46px; overflow:hidden; border:1px solid color-mix(in srgb,var(--profile-swatch) 65%,#9ab26b); background:linear-gradient(145deg,color-mix(in srgb,var(--profile-swatch) 45%,#172011),rgba(18,25,15,.88)); }
.lb-avatar::before { content:''; position:absolute; left:50%; top:8px; width:13px; height:13px; border-radius:50%; transform:translateX(-50%); background:#b9c7a2; }
.lb-avatar i { position:absolute; left:9px; right:9px; bottom:-8px; height:27px; border-radius:15px 15px 0 0; background:var(--profile-swatch); box-shadow:inset 0 7px rgba(255,255,255,.08); }
.lb-identity-copy { min-width:0; display:flex; flex-direction:column; line-height:1.05; }
.lb-identity-copy small { margin-bottom:4px; font-size:9px; font-weight:900; letter-spacing:.25em; color:var(--olive-dim); }
#hud-leaderboard-name { min-width:0; max-width:260px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:20px; font-weight:900; letter-spacing:.08em; color:#f0f5e7; }
#hud-leaderboard-character { margin-top:4px; font-size:10px; font-weight:900; letter-spacing:.2em; color:var(--olive); }
.lb-profile-edit { flex:0 0 auto; margin-left:5px; height:38px; padding:0 13px; cursor:pointer; font-family:inherit; font-size:11px; font-weight:900; letter-spacing:.12em; color:var(--olive-bright); border:1px solid rgba(154,178,107,.35); background:rgba(154,178,107,.08); }
.lb-profile-edit:hover { border-color:var(--olive); background:rgba(154,178,107,.18); }
.lb-tabs { display:flex; height:48px; border:1px solid rgba(154,178,107,.3); }
.lb-tabs button,#hud-leaderboard-refresh { cursor:pointer; font-family:inherit; font-size:14px; font-weight:900; letter-spacing:.13em; color:var(--olive-dim); background:rgba(6,10,6,.8); border:0; }
.lb-tabs button { min-width:104px; padding:0 17px; border-right:1px solid rgba(154,178,107,.18); }
.lb-tabs button:last-child { border-right:0; }
.lb-tabs button:hover { color:var(--olive-bright); background:rgba(154,178,107,.1); }
.lb-tabs button.active { color:#eef5df; background:linear-gradient(180deg,rgba(120,151,72,.72),rgba(67,88,39,.8)); box-shadow:inset 0 0 0 1px rgba(210,233,174,.19); }
#hud-leaderboard-refresh { height:48px; padding:0 18px; border:1px solid rgba(154,178,107,.28); }
#hud-leaderboard-refresh:hover { color:var(--olive-bright); border-color:var(--olive); }
.lb-meta { flex:0 0 auto; display:flex; gap:24px; padding:12px 30px; font-size:13px; font-weight:900; letter-spacing:.14em; color:#9aab7d; border-top:1px solid rgba(255,255,255,.025); border-bottom:1px solid rgba(154,178,107,.13); }
#hud-leaderboard-body { flex:1 1 auto; min-height:0; overflow:auto; padding:0 28px 12px; scrollbar-width:thin; scrollbar-color:rgba(154,178,107,.4) rgba(0,0,0,.22); }
.lb-row { display:grid; grid-template-columns:90px minmax(190px,1fr) 145px 100px 100px 100px; align-items:center; min-width:820px; min-height:56px; padding:0 16px; border-bottom:1px solid rgba(154,178,107,.09); font-size:18px; font-weight:800; color:#cbd8b8; font-variant-numeric:tabular-nums; }
.lb-row:nth-child(odd):not(.lb-head) { background:rgba(255,255,255,.018); }
.lb-row:not(.lb-head):hover { background:rgba(154,178,107,.08); }
.lb-head { position:sticky; top:0; z-index:2; min-height:44px; background:#0b1009; color:var(--olive-dim); font-size:12px; letter-spacing:.16em; }
.lb-player { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; padding-right:16px; color:#edf3e3; font-size:20px; letter-spacing:.04em; }
.lb-score { color:var(--money); font-size:20px; }
.lb-rank { color:var(--olive-dim); }
.lb-rank b { display:inline-block; width:23px; color:var(--olive); text-shadow:0 0 8px currentColor; }
.lb-row.rank-1 { background:linear-gradient(90deg,rgba(214,190,87,.13),transparent 65%); }
.lb-row.rank-1 .lb-rank,.lb-row.rank-1 .lb-player { color:#f2d77b; }
.lb-row.rank-2 .lb-rank { color:#c7d6d9; }
.lb-row.rank-3 .lb-rank { color:#d98a4a; }
.lb-state { min-height:330px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:9px; text-align:center; }
.lb-state-mark { width:30px; height:30px; border:2px solid rgba(154,178,107,.2); border-top-color:var(--olive); border-radius:50%; }
.lb-state.loading .lb-state-mark { animation:lb-spin .85s linear infinite; }
.lb-state.error .lb-state-mark { border:0; border-radius:0; transform:rotate(45deg); background:#9a3d31; box-shadow:0 0 18px rgba(210,70,50,.35); }
.lb-state.empty .lb-state-mark { width:auto; height:auto; border:0; border-radius:0; color:var(--olive); font-size:28px; }
.lb-state strong { font-size:15px; letter-spacing:.2em; color:var(--olive); max-width:620px; }
.lb-state.error strong { color:#d77b69; }
.lb-state small { font-size:11px; letter-spacing:.17em; color:var(--olive-dim); }
@keyframes lb-spin { to { transform:rotate(360deg); } }
.lb-scoring { flex:0 0 auto; border-top:1px solid rgba(154,178,107,.15); background:rgba(154,178,107,.045); }
.lb-scoring summary { min-height:46px; display:flex; align-items:center; gap:14px; padding:0 30px; cursor:pointer; list-style:none; color:var(--olive); }
.lb-scoring summary::-webkit-details-marker { display:none; }
.lb-scoring summary strong { font-size:14px; letter-spacing:.16em; color:var(--money); }
.lb-scoring summary span { font-size:12px; font-weight:800; letter-spacing:.13em; color:var(--olive-dim); }
.lb-scoring summary b { margin-left:auto; font-size:22px; font-weight:400; transition:transform .15s; }
.lb-scoring[open] summary b { transform:rotate(45deg); }
.lb-scoring summary:hover { color:var(--olive-bright); background:rgba(154,178,107,.06); }
#hud-leaderboard-rules { padding:2px 30px 15px; max-width:1000px; font-size:15px; font-weight:650; line-height:1.55; letter-spacing:.025em; color:#bdcbaa; }
.lb-foot { flex:0 0 auto; display:flex; justify-content:space-between; padding:11px 30px 13px; border-top:1px solid rgba(154,178,107,.13); font-size:12px; font-weight:900; letter-spacing:.15em; color:#8fa073; }

/* ---------- profile editor ---------- */
#hud-profile {
  position:absolute; inset:0; z-index:90; display:none; align-items:center; justify-content:center;
  padding:clamp(24px,5vw,72px); pointer-events:auto; cursor:default;
  background:radial-gradient(circle at 50% 18%,rgba(83,105,55,.28),rgba(2,4,3,.94) 62%);
  backdrop-filter:blur(14px);
}
.profile-panel {
  position:relative; width:min(860px,100%); max-height:100%; overflow:auto; color:var(--olive-bright);
  background:linear-gradient(145deg,rgba(22,29,16,.99),rgba(4,7,5,.99));
  border:1px solid rgba(178,207,124,.48); box-shadow:0 28px 100px rgba(0,0,0,.72),inset 0 1px rgba(255,255,255,.08);
  clip-path:polygon(15px 0,100% 0,100% calc(100% - 15px),calc(100% - 15px) 100%,0 100%,0 15px);
}
.profile-accent { height:4px; background:linear-gradient(90deg,#657c43,#d6e5b8 47%,#d98a4a); }
.profile-top { display:flex; align-items:center; justify-content:space-between; padding:24px 30px 20px; border-bottom:1px solid rgba(154,178,107,.18); }
.profile-top small { display:block; margin-bottom:5px; font-size:10px; font-weight:900; letter-spacing:.34em; color:var(--olive-dim); }
.profile-top h2 { font-size:30px; line-height:1; font-weight:900; letter-spacing:.17em; color:#eef5e4; }
#hud-profile-close { width:46px; height:46px; cursor:pointer; font-family:inherit; font-size:34px; font-weight:300; line-height:1; color:var(--olive); border:1px solid rgba(154,178,107,.3); background:rgba(0,0,0,.22); }
#hud-profile-close:hover { color:#fff; border-color:var(--olive); background:rgba(154,178,107,.13); }
#hud-profile-form { padding:22px 30px 28px; }
.profile-name { display:block; }
.profile-name > span, #hud-profile-form legend { display:block; margin-bottom:8px; font-size:12px; font-weight:900; letter-spacing:.22em; color:var(--olive); }
#hud-profile-name { width:100%; height:52px; padding:0 16px; font-family:inherit; font-size:18px; font-weight:900; letter-spacing:.08em; color:#f3f7ec; background:#080d08; border:1px solid rgba(154,178,107,.38); outline:none; }
#hud-profile-name:focus { border-color:var(--olive-bright); box-shadow:0 0 0 3px rgba(154,178,107,.14); }
.profile-name > small { display:block; margin-top:7px; font-size:12px; letter-spacing:.04em; color:#93a27e; }
#hud-profile-form fieldset { min-width:0; margin:24px 0 0; padding:0; border:0; }
.profile-characters { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; }
.profile-character { position:relative; min-width:0; min-height:174px; padding:13px 12px 12px; overflow:hidden; cursor:pointer; text-align:left; font-family:inherit; color:#d7e1c7; background:linear-gradient(160deg,color-mix(in srgb,var(--profile-swatch) 22%,#10160d),#070a06 78%); border:1px solid rgba(154,178,107,.24); transition:transform .12s,border-color .12s,box-shadow .12s; }
.profile-character:hover { transform:translateY(-2px); border-color:var(--profile-swatch); box-shadow:0 10px 25px rgba(0,0,0,.32); }
.profile-character:focus-visible { outline:2px solid var(--olive-bright); outline-offset:2px; }
.profile-character.selected { border-color:var(--profile-swatch); box-shadow:inset 0 0 0 2px color-mix(in srgb,var(--profile-swatch) 60%,transparent),0 0 22px color-mix(in srgb,var(--profile-swatch) 24%,transparent); }
.profile-portrait { position:relative; display:block; width:74px; height:82px; margin:0 auto 10px; overflow:hidden; background:radial-gradient(circle at 50% 35%,color-mix(in srgb,var(--profile-swatch) 60%,#dae5cc),transparent 36%); }
.profile-portrait::before { content:''; position:absolute; z-index:2; left:50%; top:9px; width:25px; height:29px; border-radius:48% 48% 43% 43%; transform:translateX(-50%); background:#b8a184; box-shadow:inset 0 8px var(--profile-swatch); }
.profile-portrait i { position:absolute; left:9px; right:9px; bottom:-8px; height:53px; border-radius:24px 24px 4px 4px; background:var(--profile-swatch); box-shadow:inset 0 12px rgba(255,255,255,.07); }
.profile-portrait::after { content:''; position:absolute; z-index:3; left:22px; right:22px; bottom:4px; height:31px; border:5px solid rgba(20,27,18,.55); border-top-width:9px; }
.profile-character-copy { display:block; min-width:0; }
.profile-character-copy strong,.profile-character-copy small { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.profile-character-copy strong { font-size:16px; font-weight:900; letter-spacing:.1em; color:#eef4e4; }
.profile-character-copy small { margin-top:5px; font-size:11px; font-weight:650; letter-spacing:.035em; color:#9dab88; }
.profile-character > b { display:none; position:absolute; right:8px; top:8px; padding:4px 6px; font-size:8px; letter-spacing:.14em; color:#0a0e08; background:var(--profile-swatch); }
.profile-character.selected > b { display:block; }
.profile-note { display:flex; align-items:center; gap:14px; margin-top:22px; padding:13px 15px; background:rgba(154,178,107,.06); border-left:3px solid var(--olive); }
.profile-note strong { flex:0 0 auto; font-size:11px; letter-spacing:.16em; color:var(--money); }
.profile-note span { font-size:13px; color:#b9c6a7; }
.profile-actions { display:flex; justify-content:flex-end; gap:10px; margin-top:22px; padding-top:20px; border-top:1px solid rgba(154,178,107,.16); }
.profile-actions button { min-width:154px; height:46px; cursor:pointer; font-family:inherit; font-size:13px; font-weight:900; letter-spacing:.15em; color:var(--olive); border:1px solid rgba(154,178,107,.35); background:rgba(0,0,0,.22); }
.profile-actions .profile-save { color:#eff5e4; border-color:var(--olive); background:linear-gradient(180deg,rgba(116,148,71,.7),rgba(59,79,36,.78)); }
.profile-actions button:hover { color:#fff; border-color:var(--olive-bright); filter:brightness(1.12); }
#hud-profile button:focus-visible,#hud-leaderboard button:focus-visible { outline:2px solid var(--olive-bright); outline-offset:2px; }

.end-inner {
  position: relative; text-align: center; display: flex; flex-direction: column; align-items: center;
  gap: 18px; padding: 40px 70px 36px;
  background: linear-gradient(180deg, rgba(14, 18, 8, 0.6), rgba(4, 6, 2, 0.75));
  border: 1px solid rgba(154, 178, 107, 0.25);
  clip-path: polygon(16px 0, 100% 0, 100% calc(100% - 16px), calc(100% - 16px) 100%, 0 100%, 0 16px);
  box-shadow: inset 0 1px 0 rgba(202, 222, 168, 0.08), inset 0 0 40px rgba(0, 0, 0, 0.4);
}
#hud-end-title {
  font-size: clamp(38px, 6vw, 62px); font-weight: 900; letter-spacing: .16em;
  color: var(--olive-bright); text-shadow: 0 0 32px rgba(154, 178, 107, 0.45), 0 2px 0 #000;
}
#hud-end-title.lost { color: #d4562c; text-shadow: 0 0 32px rgba(210, 60, 26, 0.45), 0 2px 0 #000; }
#hud-end-sub { font-size: 13px; font-weight: 700; letter-spacing: .42em; color: var(--olive); }
#hud-end-score { font-size: 34px; color: var(--olive-bright); white-space: pre; letter-spacing: .06em; }
#hud-end-kd { font-size: 12px; font-weight: 700; letter-spacing: .28em; color: var(--olive-dim); margin-bottom: 6px; }
#hud-end-rank { min-height:15px; font-size:10px; font-weight:900; letter-spacing:.22em; color:var(--olive); }
#hud-end-rank.success { color:var(--money); text-shadow:0 0 12px rgba(159,224,122,.3); }
#hud-end-rank.queued { color:#d9b66a; }

@media (max-width: 900px) {
  .mn-map-grid { grid-template-columns:repeat(3,minmax(0,1fr)); }
  .mn-controls { grid-template-columns:repeat(3,minmax(0,1fr)); }
  .lb-toolbar { grid-template-columns:1fr auto; }
  .lb-identity { grid-column:1 / -1; }
  .lb-tabs { grid-row:2; grid-column:1; }
  .lb-tabs button { flex:1; }
  #hud-leaderboard-refresh { grid-row:2; grid-column:2; }
  .lb-meta span:last-child { display:none; }
  .profile-characters { grid-template-columns:repeat(2,minmax(0,1fr)); }
}
@media (max-width: 620px) {
  #hud-menu { padding-inline:12px; }
  .mn-title { font-size:42px; }
  .mn-sub { letter-spacing:.2em; text-indent:.2em; }
  .mn-map-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
  .mn-map:nth-child(5) { grid-column:1 / -1; }
  .mn-actions,.end-actions { width:94vw; flex-direction:column; }
  #hud-start,#hud-restart,#hud-leaderboard-open,#hud-end-leaderboard,#hud-profile-menu-open { width:100%; min-width:0; }
  .mn-controls { grid-template-columns:repeat(2,minmax(0,1fr)); }
  #hud-leaderboard { padding:8px; }
  .lb-panel { min-height:100%; clip-path:none; }
  .lb-top { padding:14px 15px 10px; }
  .lb-top h2 { font-size:21px; letter-spacing:.15em; }
  .lb-toolbar { padding:10px 14px; gap:9px; }
  .lb-identity { flex-wrap:wrap; }
  .lb-profile-edit { margin-left:auto; }
  .lb-tabs button { min-width:0; padding-inline:7px; }
  #hud-leaderboard-refresh { padding-inline:10px; }
  .lb-meta,.lb-foot { padding-inline:15px; }
  #hud-leaderboard-body { padding-inline:12px; }
  .lb-scoring summary,#hud-leaderboard-rules { padding-inline:15px; }
  .lb-scoring summary span { display:none; }
  #hud-profile { padding:8px; }
  .profile-panel { clip-path:none; }
  .profile-top { padding:18px 16px 15px; }
  .profile-top h2 { font-size:21px; letter-spacing:.12em; }
  #hud-profile-form { padding:18px 16px 20px; }
  .profile-characters { grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
  .profile-character { min-height:158px; }
  .profile-note { align-items:flex-start; flex-direction:column; gap:5px; }
  .profile-actions button { min-width:0; flex:1; }
  .end-inner { width:94vw; padding:28px 18px 24px; }
}
@media (max-height: 680px) and (min-width: 621px) {
  #hud-menu { padding-top:10px; gap:8px; }
  .mn-title { font-size:40px; }
  .mn-op,.mn-sub { font-size:8px; }
  .mn-map-picker { padding:7px; }
  .mn-map-art { height:45px; }
  .mn-map-copy { padding-block:5px; }
  .mn-map-copy small { display:none; }
  .mn-controls { padding-block:7px; gap-block:3px; }
  .mn-ctl kbd { padding-block:1px; }
  #hud #mp-panel { padding-block:8px; margin-top:0; }
  .lb-panel { min-height:100%; }
  .lb-state { min-height:220px; }
  #hud-profile { padding:12px 24px; }
  .profile-top { padding-block:15px 12px; }
  #hud-profile-form { padding-block:14px 18px; }
  #hud-profile-name { height:44px; }
  #hud-profile-form fieldset { margin-top:14px; }
  .profile-character { min-height:137px; padding-block:8px; }
  .profile-portrait { width:58px; height:60px; margin-bottom:6px; }
  .profile-portrait::before { top:5px; }
  .profile-portrait i { height:40px; }
  .profile-note { margin-top:13px; padding-block:9px; }
  .profile-actions { margin-top:13px; padding-top:12px; }
}

/* ---------- multiplayer panel harmonization (styles only) ---------- */
#hud #mp-panel {
  position: relative; width: min(640px, 90vw); margin-top: 4px; padding: 14px 20px 12px;
  background: linear-gradient(180deg, rgba(14, 18, 8, 0.6), rgba(4, 6, 2, 0.75));
  border: 1px solid rgba(154, 178, 107, 0.28);
  clip-path: polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px);
  box-shadow: inset 0 1px 0 rgba(202, 222, 168, 0.07);
}
#hud #mp-panel .mp-title {
  font-family: inherit; font-size: 12px; font-weight: 800; letter-spacing: .32em;
  color: var(--olive-bright);
}
#hud #mp-panel input, #hud #mp-panel select, #hud #mp-panel button {
  font-family: inherit; font-stretch: condensed; font-size: 12px; font-weight: 700;
  letter-spacing: .12em; color: var(--olive-bright);
  background: rgba(8, 11, 5, 0.9); border: 1px solid rgba(154, 178, 107, 0.35);
  padding: 8px 10px;
}
#hud #mp-panel button {
  clip-path: polygon(5px 0, 100% 0, 100% calc(100% - 5px), calc(100% - 5px) 100%, 0 100%, 0 5px);
  transition: background .1s;
}
#hud #mp-panel button:hover { background: rgba(154, 178, 107, 0.22); }
#hud #mp-panel #mp-start { background: rgba(82, 107, 46, 0.9) !important; color: #eef5df !important; }
#hud #mp-status { font-family: inherit; font-size: 11px; letter-spacing: .16em; color: var(--olive); }
#hud #mp-roster { font-family: inherit; letter-spacing: .06em; }
#hud #mp-roster .mp-player { border: 1px solid rgba(154, 178, 107, 0.14); }
#hud #mp-roster .mp-player.ct span:last-child { color: var(--ct); }
#hud #mp-roster .mp-player.t span:last-child { color: var(--t); }

/* ---------- debug fps ---------- */
#hud-fps {
  position: absolute; left: 6px; bottom: 4px; font-size: 10px; letter-spacing: .1em;
  color: rgba(154, 178, 107, 0.6); text-shadow: 0 1px 1px #000; z-index: 2;
}
`;
  }
}
