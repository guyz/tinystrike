import {
  NAME_KEY,
  LEGACY_NAME_KEY,
  normalizePlayerName,
} from '../player/profile.js';

export { normalizePlayerName } from '../player/profile.js';
const PENDING_KEY = 'tiny-strike-pending-matches';
const SESSION_KEY = 'tiny-strike-leaderboard-token';
const CAREER_KEY = 'tiny-strike-career-cache-v1';
const CELEBRATED_KEY = 'tiny-strike-celebrated-matches-v1';
const VALID_CATEGORIES = new Set(['humans', 'bots', 'overall']);
const DEFAULT_BASE_URL = '/api/leaderboard';
const MAX_PENDING = 40;

function storageAvailable(storage) {
  return storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function';
}

function browserStorage(fallback = null) {
  if (fallback) return fallback;
  try { return globalThis.localStorage || null; } catch { return null; }
}

export function normalizeLeaderboardCategory(value) {
  return VALID_CATEGORIES.has(value) ? value : 'overall';
}

function finiteInt(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Math.round(Number(value)) : fallback;
}

export function normalizeEntry(row, index = 0) {
  const stats = row && row.stats && typeof row.stats === 'object' ? row.stats : row || {};
  const rawWinRate = Math.max(0, Number(stats.winRate) || 0);
  return {
    playerId: String(row && (row.playerId ?? row.id) || ''),
    rank: Math.max(1, finiteInt(row && (row.rank ?? row.position), index + 1)),
    playerName: normalizePlayerName(row && (row.playerName ?? row.name ?? row.player)),
    score: Math.max(0, finiteInt(row && (row.score ?? row.rating ?? row.points))),
    wins: Math.max(0, finiteInt(stats.wins)),
    matches: Math.max(0, finiteInt(stats.matches ?? stats.gamesPlayed ?? stats.games)),
    kills: Math.max(0, finiteInt(stats.kills)),
    deaths: Math.max(0, finiteInt(stats.deaths)),
    headshots: Math.max(0, finiteInt(stats.headshots)),
    winRate: Math.min(100, rawWinRate <= 1 ? rawWinRate * 100 : rawWinRate),
    level: Math.max(1, finiteInt(row?.level, 1)),
    tier: row?.tier && typeof row.tier === 'object' ? { ...row.tier } : null,
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
    this.storage = browserStorage(options.storage);
    this.now = options.now || (() => Date.now());
    this._startedAt = this.now();
    this._roundsPlayed = 0;
    this._stats = this._emptyStats();
    this._submitted = false;
    this._sessionPromise = null;
    this.playerId = '';
    this._memoryToken = '';
    this.persistenceStatus = storageAvailable(this.storage) ? 'persistent' : 'memory-only';
    this.progression = this._readCareerCache();
    this.playerId = String(this.progression?.playerId || this.progression?.standing?.id || '');
    this.identityStatus = this._sessionToken() ? 'resuming' : 'new';
    this._celebratedMatches = new Set(this._readCelebrated());
    this._killStreak = 0;
    this._provisionalRecords = new Set();
    this._reconcilePromise = null;
    this._reconcileTimer = null;
    this._bindEvents();
    this._bindLifecycle();
    if (options.autoSession !== false) this.ensureSession({ refresh: true }).catch(() => {});
  }

  getProgression() {
    return this.progression || null;
  }

  getProgressCode() {
    return this._sessionToken();
  }

  getIdentityStatus() {
    return this.identityStatus;
  }

  async loadCareer() {
    if (!this.fetch) throw new Error('Leaderboard service is unavailable in this browser.');
    const token = await this.ensureSession();
    const response = await this.fetch(this.baseUrl + '/me', {
      headers: { Accept: 'application/json', Authorization: 'Bearer ' + token },
      credentials: 'same-origin',
    });
    const body = await this._json(response);
    if (response.status === 401) {
      this._identityLost(body?.error || body?.message || 'This progress key is no longer valid.');
    }
    if (!response.ok) throw new Error(body?.error || body?.message || 'Could not load your career.');
    this._applyProgression(body, { source: 'career' });
    return this.progression;
  }

  async restoreProgressCode(value) {
    const token = String(value || '').trim();
    if (token.length < 20) throw new Error('Enter a valid private progress key.');
    if (!this.fetch) throw new Error('Leaderboard service is unavailable in this browser.');
    await this._openSession(token, false, { preserveServerName: true });
    this.identityStatus = 'ready';
    // Pending matches are tagged with their owning player ID. Keep them while
    // recovering an identity, then send only those that belong to the restored
    // career; clearing here would silently discard offline play after a stale
    // or temporarily invalid browser token.
    await this.flushPending({ ensureIdentity: false });
    await this.loadCareer();
    return this.progression;
  }

  async startFreshProgress() {
    this._clearSessionToken();
    this._writePending([]);
    this._clearCareerCache();
    this.progression = null;
    this.playerId = '';
    this.identityStatus = 'new';
    return this.ensureSession({ refresh: true });
  }

  getPlayerName() {
    if (this.game?.profile?.name) return normalizePlayerName(this.game.profile.name);
    if (!storageAvailable(this.storage)) return 'Operative';
    try {
      return normalizePlayerName(
        this.storage.getItem(NAME_KEY) || this.storage.getItem(LEGACY_NAME_KEY)
      );
    } catch { return 'Operative'; }
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
      self: body?.self ? normalizeEntry(body.self, Math.max(0, finiteInt(body.self.rank, 1) - 1)) : null,
    };
  }

  async submitMatch(payload) {
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
      // Keep the private bearer out of request bodies, which are more likely
      // to be retained by generic application logging.
      body: JSON.stringify(payload),
    });
    const body = await this._json(response);
    if (response.status === 401) this._identityLost(body?.error || body?.message || 'Your saved progress could not be verified.');
    if (!response.ok) {
      const error = new Error(body?.error || body?.message || 'Could not record this match.');
      error.status = response.status;
      error.retryable = response.status === 429 || response.status >= 500;
      throw error;
    }
    this._applyProgression(body, { source: 'match', matchId: payload?.matchId });
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

  async flushPending({ ensureIdentity = true } = {}) {
    const pending = this._readPending();
    if (!pending.length) return 0;
    if (ensureIdentity && !this.playerId) await this.ensureSession({ refresh: true });
    const remaining = [];
    let sent = 0;
    for (const payload of pending) {
      if (payload?._ownerPlayerId && this.playerId && payload._ownerPlayerId !== this.playerId) {
        remaining.push(payload);
        continue;
      }
      try {
        const cleanPayload = { ...payload };
        delete cleanPayload._ownerPlayerId;
        await this.submitMatch(cleanPayload);
        sent++;
      } catch (error) {
        const recoveryRequired = error?.status === 401 || this.identityStatus === 'recovery-required';
        if (recoveryRequired || error?.retryable !== false) remaining.push(payload);
        else this.game?.events?.emit('leaderboard:submit-rejected', {
          payload, error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this._writePending(remaining);
    return sent;
  }

  async reconcileCareer() {
    if (this._reconcilePromise) return this._reconcilePromise;
    this._reconcilePromise = (async () => {
      this.game?.events?.emit('leaderboard:sync-state', { state: 'syncing' });
      try {
        // Validate the saved bearer identity before touching its offline
        // outbox. A cached playerId is not proof that the token is still valid.
        await this.ensureSession({ refresh: true });
        await this.flushPending({ ensureIdentity: false });
        const progression = await this.loadCareer();
        this.game?.events?.emit('leaderboard:sync-state', { state: 'ready', progression });
        return progression;
      } catch (error) {
        this.game?.events?.emit('leaderboard:sync-state', {
          state: 'error', error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        this._reconcilePromise = null;
      }
    })();
    return this._reconcilePromise;
  }

  _bindEvents() {
    const events = this.game?.events;
    if (!events || typeof events.on !== 'function') return;
    events.on('ui:start', () => this._resetMatch());
    events.on('ui:restart', () => this._resetMatch());
    events.on('profile:changed', (event) => {
      if (event?.previous?.name !== event?.name) this.ensureSession({ refresh: true }).catch(() => {});
    });
    events.on('round:start', () => { this._killStreak = 0; });
    events.on('round:end', () => { this._roundsPlayed++; this._killStreak = 0; });
    events.on('kill', (event) => this._trackKill(event || {}));
    events.on('bomb:planted', (event) => {
      if (this._isLocalActor(event?.by)) this._stats.plants++;
    });
    events.on('bomb:defused', (event) => {
      if (this._isLocalActor(event?.by)) this._stats.defuses++;
    });
    events.on('game:end', (result) => this._onGameEnd(result || {}));
    events.on('leaderboard:submitted', (event) => {
      if (event?.response) this._applyProgression(event.response, {
        source: 'match', matchId: event?.payload?.matchId || event?.response?.matchId,
      });
    });
  }

  _bindLifecycle() {
    const schedule = () => {
      if (globalThis.document?.visibilityState === 'hidden') return;
      if (this._reconcileTimer) clearTimeout(this._reconcileTimer);
      this._reconcileTimer = setTimeout(() => {
        this._reconcileTimer = null;
        this.reconcileCareer().catch(() => {});
      }, 250);
    };
    globalThis.addEventListener?.('online', schedule);
    globalThis.document?.addEventListener?.('visibilitychange', schedule);
  }

  _resetMatch() {
    this._startedAt = this.now();
    this._roundsPlayed = 0;
    this._stats = this._emptyStats();
    this._submitted = false;
    this._killStreak = 0;
    this._provisionalRecords.clear();
    this.flushPending().catch(() => {});
  }

  _isLocalName(value) {
    const name = String(value || '').trim();
    const multiplayerName = this.game?.multiplayer?.localName;
    return name === 'You' || !!(multiplayerName && name === multiplayerName) || name === this.getPlayerName();
  }

  _trackKill(event) {
    const localId = this.game?.player?.networkId || this.game?.multiplayer?.localId;
    // New combat events carry collision-proof actor identity. Retain the name
    // fallback only for older event producers; a bot may legitimately have the
    // same callsign as the player.
    const isKiller = typeof event.killerIsLocal === 'boolean'
      ? event.killerIsLocal
      : ((localId && event.killerId === localId) || this._isLocalName(event.killerName));
    const isVictim = typeof event.victimIsLocal === 'boolean'
      ? event.victimIsLocal
      : ((localId && event.victimId === localId) || this._isLocalName(event.victimName));
    if (isKiller && !isVictim) {
      this._stats.kills++;
      if (event.headshot) this._stats.headshots++;
      if (event.victimId) this._stats.killsHumans++;
      else this._stats.killsBots++;
      this._killStreak++;
      this._emitCombatMilestone(event);
    }
    if (isVictim && !isKiller) {
      this._stats.deaths++;
      this._killStreak = 0;
    }
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
      const ranked = typeof this.game.multiplayer.isRankedParticipant === 'function'
        ? this.game.multiplayer.isRankedParticipant()
        : !this.game.multiplayer._unrankedIdentityConflict;
      if (!ranked) {
        this.game?.events?.emit('leaderboard:unranked', {
          matchId: this.game.multiplayer.matchId || null,
          reason: 'identity-conflict',
        });
        return;
      }
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
      const recoveryRequired = error?.status === 401 || this.identityStatus === 'recovery-required';
      if (recoveryRequired || error?.retryable !== false) this._queue(payload);
      this.game?.events?.emit('leaderboard:submit-error', {
        payload,
        error: error instanceof Error ? error.message : String(error),
        permanent: !recoveryRequired && error?.retryable === false,
        recoveryRequired,
      });
    }
  }

  async _json(response) {
    try { return await response.json(); } catch { return null; }
  }

  async _openSession(existingToken, allowRetry, { preserveServerName = false } = {}) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (existingToken) headers.Authorization = 'Bearer ' + existingToken;
    const response = await this.fetch(this.baseUrl + '/session', {
      method: 'POST',
      headers,
      credentials: 'same-origin',
      body: JSON.stringify({
        ...(!preserveServerName ? { playerName: this.getPlayerName() } : {}),
      }),
    });
    const body = await this._json(response);
    if (response.status === 401 && existingToken) {
      const message = body?.error || body?.message || 'Your saved progress could not be verified.';
      if (allowRetry === false) throw new Error(message);
      this._identityLost(message);
    }
    if (!response.ok || !body?.token) {
      throw new Error(body?.error || body?.message || 'Could not open a leaderboard session.');
    }
    this._memoryToken = body.token;
    if (storageAvailable(this.storage)) {
      try {
        this.storage.setItem(SESSION_KEY, body.token);
        this.persistenceStatus = 'persistent';
      } catch {
        this.persistenceStatus = 'memory-only';
        this.game?.events?.emit('leaderboard:persistence-warning', {
          message: 'This browser is blocking saved career storage.',
        });
      }
    }
    this.identityStatus = 'ready';
    this.playerId = String(body.player?.id || body.progression?.playerId || this.playerId || '');
    if (body.player?.name) {
      const serverName = normalizePlayerName(body.player.name);
      if (this.game?.profile && typeof this.game.profile.setName === 'function') {
        this.game.profile.setName(serverName);
      } else if (storageAvailable(this.storage)) {
        this.storage.setItem(NAME_KEY, serverName);
      }
    }
    this._applyProgression(body, { source: body.resumed ? 'resume' : 'session' });
    return body.token;
  }

  _identityLost(message) {
    this.identityStatus = 'recovery-required';
    const error = new Error(message || 'Your saved progress could not be verified.');
    error.status = 401;
    error.retryable = false;
    this.game?.events?.emit('leaderboard:identity-lost', {
      error: error.message,
      hasProgressKey: !!this._sessionToken(),
    });
    throw error;
  }

  _extractProgression(body) {
    if (!body || typeof body !== 'object') return null;
    const candidate = body.progression || body.career || body.player?.progression ||
      body.result?.progression || body.entry?.progression;
    return candidate && typeof candidate === 'object' ? candidate : null;
  }

  _applyProgression(body, context = {}) {
    const next = this._extractProgression(body);
    if (next) {
      const previous = this.progression;
      const previousId = String(previous?.playerId || previous?.standing?.id || '');
      const nextId = String(next.playerId || next.standing?.id || '');
      const inferMissedRewards = !!previous && !!previousId && previousId === nextId &&
        (context.source === 'resume' || context.source === 'career');
      this.progression = next;
      this.playerId = String(next.playerId || body?.player?.id || this.playerId || '');
      this._writeCareerCache(next);
      this.game?.events?.emit('progress:updated', {
        progression: next,
        source: context.source || 'sync',
      });
      this.game?.events?.emit('leaderboard:career', { progression: next });
      if (inferMissedRewards) this._emitMissedProgress(previous, next);
    }

    const rewards = body?.rewards || body?.result?.rewards || null;
    if (!rewards || typeof rewards !== 'object') return;
    const responseMatchId = String(context.matchId || body?.matchId || body?.result?.matchId || '');
    if (responseMatchId && this._celebratedMatches.has(responseMatchId)) return;
    if (responseMatchId) {
      this._celebratedMatches.add(responseMatchId);
      this._writeCelebrated();
    }

    for (const achievement of rewards.newAchievements || rewards.achievementsUnlocked || []) {
      this.game?.events?.emit('progress:achievement', { achievement, rewards, progression: this.progression });
    }
    for (const record of rewards.recordsBroken || rewards.newRecords || []) {
      this.game?.events?.emit('progress:record', { record, rewards, progression: this.progression });
    }
    const before = finiteInt(rewards.levelBefore ?? rewards.beforeLevel, 0);
    const after = finiteInt(rewards.levelAfter ?? rewards.afterLevel, before);
    const tierBefore = String(rewards.tierBefore?.id || rewards.tierBefore?.name || '');
    const tierAfter = String(rewards.tierAfter?.id || rewards.tierAfter?.name || '');
    if (after > before || (tierAfter && tierAfter !== tierBefore)) {
      this.game?.events?.emit('progress:level-up', { rewards, progression: this.progression });
    }
  }

  _emitMissedProgress(previous, next) {
    const previousAchievements = new Set((previous.achievements || []).map((item) => item?.id));
    const newAchievements = (next.achievements || [])
      .filter((item) => item?.id && !previousAchievements.has(item.id))
      .slice(-2);
    for (const achievement of newAchievements) {
      this.game?.events?.emit('progress:achievement', {
        achievement, progression: next, recovered: true,
      });
    }
    const changedRecords = Object.entries(next.records || {})
      .filter(([id, record]) => {
        const prior = previous.records?.[id];
        return record?.matchId && record.matchId !== prior?.matchId;
      })
      .slice(-2);
    for (const [id, record] of changedRecords) {
      this.game?.events?.emit('progress:record', {
        record: { id, name: id, ...record }, progression: next, recovered: true,
      });
    }
    const levelBefore = finiteInt(previous.level, 1);
    const levelAfter = finiteInt(next.level, levelBefore);
    if (levelAfter > levelBefore || next.tier?.id !== previous.tier?.id) {
      this.game?.events?.emit('progress:level-up', {
        progression: next,
        recovered: true,
        rewards: {
          levelBefore,
          levelAfter,
          tierBefore: previous.tier || null,
          tierAfter: next.tier || null,
        },
      });
    }
  }

  _emitCombatMilestone(event) {
    if (this._stats.kills === 1) {
      this.game?.events?.emit('progress:achievement', {
        provisional: true,
        achievement: { id: 'match-first-kill', name: 'FIRST BLOOD', description: 'First elimination this match' },
      });
    }
    const streakNames = { 2: 'DOUBLE KILL', 3: 'TRIPLE KILL', 4: 'QUAD KILL', 5: 'ACE STREAK' };
    if (streakNames[this._killStreak]) {
      this.game?.events?.emit('progress:achievement', {
        provisional: true,
        achievement: {
          id: 'match-streak-' + this._killStreak,
          name: streakNames[this._killStreak],
          description: this._killStreak + ' eliminations without dying',
        },
      });
    }
    const records = this.progression?.records || {};
    const checks = [
      ['kills', this._stats.kills, finiteInt(records.kills?.value ?? records.kills ?? records.bestKills), 'NEW KILL RECORD'],
      ['headshots', this._stats.headshots, finiteInt(records.headshots?.value ?? records.headshots ?? records.bestHeadshots), 'NEW HEADSHOT RECORD'],
    ];
    for (const [id, value, prior, name] of checks) {
      if (value > Math.max(0, prior) && prior > 0 && !this._provisionalRecords.has(id)) {
        this._provisionalRecords.add(id);
        this.game?.events?.emit('progress:record', {
          provisional: true,
          record: { id, name, value, previous: prior, description: 'Finish the match to lock it in' },
        });
      }
    }
    if (event?.headshot && this._stats.headshots === 1) {
      this.game?.events?.emit('progress:achievement', {
        provisional: true,
        achievement: { id: 'match-first-headshot', name: 'PRECISION HIT', description: 'First headshot this match' },
      });
    }
  }

  _sessionToken() {
    if (this._memoryToken) return this._memoryToken;
    if (!storageAvailable(this.storage)) return '';
    try { return String(this.storage.getItem(SESSION_KEY) || '').trim(); } catch {
      this.persistenceStatus = 'memory-only';
      return '';
    }
  }

  _clearSessionToken() {
    this._memoryToken = '';
    try {
      if (this.storage && typeof this.storage.removeItem === 'function') {
        this.storage.removeItem(SESSION_KEY);
      } else if (storageAvailable(this.storage)) {
        this.storage.setItem(SESSION_KEY, '');
      }
    } catch { this.persistenceStatus = 'memory-only'; }
  }

  _readCareerCache() {
    if (!storageAvailable(this.storage)) return null;
    try {
      const value = JSON.parse(this.storage.getItem(CAREER_KEY) || 'null');
      return value && typeof value === 'object' ? value : null;
    } catch { return null; }
  }

  _writeCareerCache(value) {
    if (!storageAvailable(this.storage)) return;
    try { this.storage.setItem(CAREER_KEY, JSON.stringify(value)); } catch { /* private/quota */ }
  }

  _clearCareerCache() {
    try {
      if (this.storage && typeof this.storage.removeItem === 'function') this.storage.removeItem(CAREER_KEY);
      else if (storageAvailable(this.storage)) this.storage.setItem(CAREER_KEY, '');
    } catch { /* private mode */ }
  }

  _readCelebrated() {
    if (!storageAvailable(this.storage)) return [];
    try {
      const value = JSON.parse(this.storage.getItem(CELEBRATED_KEY) || '[]');
      return Array.isArray(value) ? value.filter((item) => typeof item === 'string').slice(-40) : [];
    } catch { return []; }
  }

  _writeCelebrated() {
    if (!storageAvailable(this.storage)) return;
    try {
      this.storage.setItem(CELEBRATED_KEY, JSON.stringify([...this._celebratedMatches].slice(-40)));
    } catch { /* private/quota */ }
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
    pending.push({ ...payload, ...(this.playerId ? { _ownerPlayerId: this.playerId } : {}) });
    this._writePending(pending);
  }
}

export default LeaderboardClient;
