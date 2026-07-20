import {
  NAME_KEY,
  LEGACY_NAME_KEY,
  normalizePlayerName,
} from '../player/profile.js';

export { normalizePlayerName } from '../player/profile.js';
const PENDING_KEY = 'tiny-strike-pending-matches';
const SESSION_KEY = 'tiny-strike-leaderboard-token';
const VALID_CATEGORIES = new Set(['humans', 'bots', 'overall']);
const DEFAULT_BASE_URL = '/api/leaderboard';
const MAX_PENDING = 12;

function storageAvailable(storage) {
  return storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function';
}

export function normalizeLeaderboardCategory(value) {
  return VALID_CATEGORIES.has(value) ? value : 'overall';
}

function finiteInt(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Math.round(Number(value)) : fallback;
}

function normalizeEntry(row, index) {
  const stats = row && row.stats && typeof row.stats === 'object' ? row.stats : row || {};
  const rawWinRate = Math.max(0, Number(stats.winRate) || 0);
  return {
    rank: Math.max(1, finiteInt(row && (row.rank ?? row.position), index + 1)),
    playerName: normalizePlayerName(row && (row.playerName ?? row.name ?? row.player)),
    score: Math.max(0, finiteInt(row && (row.score ?? row.rating ?? row.points))),
    wins: Math.max(0, finiteInt(stats.wins)),
    matches: Math.max(0, finiteInt(stats.matches ?? stats.gamesPlayed ?? stats.games)),
    kills: Math.max(0, finiteInt(stats.kills)),
    deaths: Math.max(0, finiteInt(stats.deaths)),
    headshots: Math.max(0, finiteInt(stats.headshots)),
    winRate: Math.min(100, rawWinRate <= 1 ? rawWinRate * 100 : rawWinRate),
  };
}

function parseEntries(body) {
  const rows = Array.isArray(body)
    ? body
    : (body && (body.entries || body.leaderboard || body.data));
  return Array.isArray(rows) ? rows.map(normalizeEntry) : [];
}

function matchId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

export class LeaderboardClient {
  constructor(game, options = {}) {
    this.game = game;
    this.baseUrl = String(
      options.baseUrl || globalThis.TINY_STRIKE_API?.leaderboard || DEFAULT_BASE_URL
    ).replace(/\/$/, '');
    this.fetch = options.fetchImpl || globalThis.fetch?.bind(globalThis);
    this.storage = options.storage || globalThis.localStorage || null;
    this.now = options.now || (() => Date.now());
    this._startedAt = this.now();
    this._roundsPlayed = 0;
    this._stats = this._emptyStats();
    this._submitted = false;
    this._sessionPromise = null;
    this._bindEvents();
    if (options.autoSession !== false) this.ensureSession({ refresh: true }).catch(() => {});
  }

  getPlayerName() {
    if (this.game?.profile?.name) return normalizePlayerName(this.game.profile.name);
    if (!storageAvailable(this.storage)) return 'Operative';
    return normalizePlayerName(
      this.storage.getItem(NAME_KEY) || this.storage.getItem(LEGACY_NAME_KEY)
    );
  }

  setPlayerName(value) {
    const name = normalizePlayerName(value);
    const previous = this.getPlayerName();
    if (this.game?.profile && typeof this.game.profile.setName === 'function') {
      this.game.profile.setName(name);
    } else if (storageAvailable(this.storage)) {
      this.storage.setItem(NAME_KEY, name);
      // Keep older multiplayer builds in sync during the rename transition.
      this.storage.setItem(LEGACY_NAME_KEY, name);
    }
    if (this.game?.multiplayer) {
      if (!this.game.multiplayer.active) this.game.multiplayer.localName = name;
      if (this.game.multiplayer._ui?.name) this.game.multiplayer._ui.name.value = name;
    }
    if (name !== previous) this.ensureSession({ refresh: true }).catch(() => {});
    return name;
  }

  async ensureSession({ refresh = false } = {}) {
    const stored = this._sessionToken();
    if (this._sessionPromise) return this._sessionPromise;
    if (stored && !refresh) return stored;
    if (!this.fetch) throw new Error('Leaderboard service is unavailable in this browser.');
    this._sessionPromise = this._openSession(stored, true)
      .finally(() => { this._sessionPromise = null; });
    return this._sessionPromise;
  }

  async list(category = 'overall', limit = 50) {
    if (!this.fetch) throw new Error('Leaderboard service is unavailable in this browser.');
    const safeCategory = normalizeLeaderboardCategory(category);
    const safeLimit = Math.max(1, Math.min(100, finiteInt(limit, 50)));
    const url = this.baseUrl + '?category=' + encodeURIComponent(safeCategory) +
      '&limit=' + safeLimit;
    const response = await this.fetch(url, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    });
    const body = await this._json(response);
    if (!response.ok) throw new Error(body?.error || body?.message || 'Could not load the leaderboard.');
    return {
      category: safeCategory,
      entries: parseEntries(body),
      updatedAt: body?.updatedAt || body?.generatedAt || null,
      scoring: body?.rules || body?.scoring || body?.meta?.scoring || null,
      season: body?.season || null,
    };
  }

  async submitMatch(payload, allowSessionRetry = true) {
    if (!this.fetch) throw new Error('Leaderboard service is unavailable in this browser.');
    const token = await this.ensureSession();
    const response = await this.fetch(this.baseUrl + '/matches', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: 'Bearer ' + token,
      },
      credentials: 'same-origin',
      body: JSON.stringify({ ...payload, sessionToken: token }),
    });
    const body = await this._json(response);
    if (response.status === 401 && allowSessionRetry) {
      this._clearSessionToken();
      await this.ensureSession({ refresh: true });
      return this.submitMatch(payload, false);
    }
    if (!response.ok) throw new Error(body?.error || body?.message || 'Could not record this match.');
    return body || {};
  }

  buildMatchPayload(result = {}) {
    const state = this.game?.state || {};
    const player = this.game?.player || {};
    const sessionMode = this.game?.sessionMode || 'solo';
    const opponents = sessionMode === 'solo' ? 'bots' :
      sessionMode === 'humans' ? 'humans' : 'mixed';
    const scores = result.scores || state.scores || {};
    const winner = result.winner || (finiteInt(scores.ct) >= finiteInt(scores.t) ? 'ct' : 't');
    const playerTeam = player.team === 't' ? 't' : 'ct';
    const roster = Array.isArray(this.game?.multiplayer?.roster)
      ? this.game.multiplayer.roster
      : [];
    const localId = this.game?.multiplayer?.localId;
    const humanOpponents = roster.filter((entry) =>
      entry && entry.id !== localId && entry.team && entry.team !== playerTeam
    ).length;
    const bots = Array.isArray(this.game?.bots?.all) ? this.game.bots.all : [];
    const botOpponents = bots.filter((entry) => entry && entry.team !== playerTeam).length;
    const primaryCategory = humanOpponents > 0 ? 'humans' : 'bots';
    const duration = Math.max(0, Math.round((this.now() - this._startedAt) / 1000));
    return {
      matchId: matchId(),
      playerName: this.getPlayerName(),
      mapId: this.game?.selectedMapId || 'dustyard',
      mode: opponents,
      opponents,
      multiplayer: sessionMode !== 'solo',
      playerTeam,
      localTeam: playerTeam,
      winner,
      won: winner === playerTeam,
      teamWon: winner === playerTeam,
      scores: { ct: Math.max(0, finiteInt(scores.ct)), t: Math.max(0, finiteInt(scores.t)) },
      kills: this._stats.kills,
      deaths: this._stats.deaths,
      headshots: this._stats.headshots,
      killsHumans: this._stats.killsHumans,
      killsBots: this._stats.killsBots,
      plants: this._stats.plants,
      defuses: this._stats.defuses,
      objectives: { plants: this._stats.plants, defuses: this._stats.defuses },
      humanOpponents,
      botOpponents,
      primaryCategory,
      rankingCategories: ['overall', primaryCategory],
      roundsPlayed: Math.max(this._roundsPlayed, finiteInt(state.round)),
      durationSeconds: duration,
      duration,
      completedAt: new Date(this.now()).toISOString(),
    };
  }

  async flushPending() {
    const pending = this._readPending();
    if (!pending.length) return 0;
    const remaining = [];
    let sent = 0;
    for (const payload of pending) {
      try {
        await this.submitMatch(payload);
        sent++;
      } catch {
        remaining.push(payload);
      }
    }
    this._writePending(remaining);
    return sent;
  }

  _bindEvents() {
    const events = this.game?.events;
    if (!events || typeof events.on !== 'function') return;
    events.on('ui:start', () => this._resetMatch());
    events.on('ui:restart', () => this._resetMatch());
    events.on('profile:changed', (event) => {
      if (event?.previous?.name !== event?.name) this.ensureSession({ refresh: true }).catch(() => {});
    });
    events.on('round:end', () => { this._roundsPlayed++; });
    events.on('kill', (event) => this._trackKill(event || {}));
    events.on('bomb:planted', (event) => {
      if (this._isLocalActor(event?.by)) this._stats.plants++;
    });
    events.on('bomb:defused', (event) => {
      if (this._isLocalActor(event?.by)) this._stats.defuses++;
    });
    events.on('game:end', (result) => this._onGameEnd(result || {}));
  }

  _resetMatch() {
    this._startedAt = this.now();
    this._roundsPlayed = 0;
    this._stats = this._emptyStats();
    this._submitted = false;
    this.flushPending().catch(() => {});
  }

  _isLocalName(value) {
    const name = String(value || '').trim();
    const multiplayerName = this.game?.multiplayer?.localName;
    return name === 'You' || !!(multiplayerName && name === multiplayerName) || name === this.getPlayerName();
  }

  _trackKill(event) {
    const localId = this.game?.player?.networkId || this.game?.multiplayer?.localId;
    const isKiller = (localId && event.killerId === localId) || this._isLocalName(event.killerName);
    const isVictim = (localId && event.victimId === localId) || this._isLocalName(event.victimName);
    if (isKiller && !isVictim) {
      this._stats.kills++;
      if (event.headshot) this._stats.headshots++;
      if (event.victimId) this._stats.killsHumans++;
      else this._stats.killsBots++;
    }
    if (isVictim && !isKiller) this._stats.deaths++;
  }

  _isLocalActor(actor) {
    if (actor === 'player' || actor === this.game?.player) return true;
    const localId = this.game?.player?.networkId || this.game?.multiplayer?.localId;
    return !!(localId && actor && actor.networkId === localId);
  }

  _emptyStats() {
    return { kills: 0, deaths: 0, headshots: 0, killsHumans: 0, killsBots: 0, plants: 0, defuses: 0 };
  }

  async _onGameEnd(result) {
    if (this._submitted) return;
    this._submitted = true;
    if (this.game?.multiplayer?.active) {
      this.game?.events?.emit('leaderboard:server-recorded', {
        matchId: this.game.multiplayer.matchId || null,
      });
      return;
    }
    const payload = this.buildMatchPayload(result);
    this.game?.events?.emit('leaderboard:submitting', { payload });
    try {
      const response = await this.submitMatch(payload);
      this.game?.events?.emit('leaderboard:submitted', { payload, response });
    } catch (error) {
      this._queue(payload);
      this.game?.events?.emit('leaderboard:submit-error', {
        payload,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async _json(response) {
    try { return await response.json(); } catch { return null; }
  }

  async _openSession(existingToken, allowRetry) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (existingToken) headers.Authorization = 'Bearer ' + existingToken;
    const response = await this.fetch(this.baseUrl + '/session', {
      method: 'POST',
      headers,
      credentials: 'same-origin',
      body: JSON.stringify({
        playerName: this.getPlayerName(),
        ...(existingToken ? { token: existingToken } : {}),
      }),
    });
    const body = await this._json(response);
    if (response.status === 401 && existingToken && allowRetry) {
      this._clearSessionToken();
      return this._openSession(null, false);
    }
    if (!response.ok || !body?.token) {
      throw new Error(body?.error || body?.message || 'Could not open a leaderboard session.');
    }
    if (storageAvailable(this.storage)) this.storage.setItem(SESSION_KEY, body.token);
    if (body.player?.name) {
      const serverName = normalizePlayerName(body.player.name);
      if (this.game?.profile && typeof this.game.profile.setName === 'function') {
        this.game.profile.setName(serverName);
      } else if (storageAvailable(this.storage)) {
        this.storage.setItem(NAME_KEY, serverName);
      }
    }
    return body.token;
  }

  _sessionToken() {
    if (!storageAvailable(this.storage)) return '';
    return String(this.storage.getItem(SESSION_KEY) || '').trim();
  }

  _clearSessionToken() {
    if (this.storage && typeof this.storage.removeItem === 'function') {
      this.storage.removeItem(SESSION_KEY);
    } else if (storageAvailable(this.storage)) {
      this.storage.setItem(SESSION_KEY, '');
    }
  }

  _readPending() {
    if (!storageAvailable(this.storage)) return [];
    try {
      const value = JSON.parse(this.storage.getItem(PENDING_KEY) || '[]');
      return Array.isArray(value) ? value.slice(-MAX_PENDING) : [];
    } catch { return []; }
  }

  _writePending(value) {
    if (!storageAvailable(this.storage)) return;
    try { this.storage.setItem(PENDING_KEY, JSON.stringify(value.slice(-MAX_PENDING))); } catch { /* quota */ }
  }

  _queue(payload) {
    const pending = this._readPending().filter((entry) => entry.matchId !== payload.matchId);
    pending.push(payload);
    this._writePending(pending);
  }
}

export default LeaderboardClient;
