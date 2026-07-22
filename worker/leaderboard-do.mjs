import {
  DEFAULT_LEADERBOARD_SEASON,
  LEADERBOARD_CATEGORIES,
  LEADERBOARD_SCHEMA_VERSION,
  LeaderboardError,
  cleanLeaderboardMode,
  cleanLeaderboardName,
  ensureLeaderboardPlayerShape,
  leaderboardDayKey,
  leaderboardFromData,
  levelFromXp,
  newLeaderboardData,
  progressionTier,
  progressionFromData,
  publicLeaderboardRules,
  submitMatchToData,
} from '../src/shared/leaderboard-core.mjs';

const MAX_API_BODY_BYTES = 32 * 1024;
const MAX_IMPORT_BODY_BYTES = 8 * 1024 * 1024;
const MAX_IMPORT_PLAYERS = 25_000;
const MAX_IMPORT_SESSIONS = 50_000;
const MAX_IMPORT_MATCHES = 250_000;

function jsonResponse(status, payload, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}

async function readJson(request, maxBytes = MAX_API_BODY_BYTES) {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new LeaderboardError(413, 'Request body is too large.');
  }
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > maxBytes) throw new LeaderboardError(413, 'Request body is too large.');
  if (!bytes.byteLength) return {};
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new LeaderboardError(400, 'Request body must be valid JSON.');
  }
}

function bearerToken(request) {
  const match = String(request.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function randomToken(byteLength = 24) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function tokenHash(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(token)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function parsedObject(value, fallback = null) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function plainRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LeaderboardError(400, `${field} must be an object.`);
  }
  return value;
}

export function validateLeaderboardImport(input) {
  const data = plainRecord(input, 'Leaderboard export');
  if (data.version !== LEADERBOARD_SCHEMA_VERSION) {
    throw new LeaderboardError(400, `Leaderboard export must use schema version ${LEADERBOARD_SCHEMA_VERSION}.`);
  }
  const season = String(data.season || '').trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(season)) {
    throw new LeaderboardError(400, 'Leaderboard season is invalid.');
  }
  const players = plainRecord(data.players, 'players');
  const sessions = plainRecord(data.sessions || {}, 'sessions');
  const matches = plainRecord(data.matches || {}, 'matches');
  const daily = plainRecord(data.daily || {}, 'daily');
  if (Object.keys(players).length > MAX_IMPORT_PLAYERS) throw new LeaderboardError(413, 'Leaderboard export has too many players.');
  if (Object.keys(sessions).length > MAX_IMPORT_SESSIONS) throw new LeaderboardError(413, 'Leaderboard export has too many sessions.');
  if (Object.keys(matches).length > MAX_IMPORT_MATCHES) throw new LeaderboardError(413, 'Leaderboard export has too many matches.');

  const normalizedPlayers = {};
  for (const [id, candidate] of Object.entries(players)) {
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(id) || !candidate || candidate.id !== id) {
      throw new LeaderboardError(400, `Player record ${id || '(blank)'} is invalid.`);
    }
    const player = structuredClone(candidate);
    player.name = cleanLeaderboardName(player.name);
    ensureLeaderboardPlayerShape(player);
    normalizedPlayers[id] = player;
  }
  for (const [hash, session] of Object.entries(sessions)) {
    if (!/^[a-f0-9]{64}$/.test(hash) || !session || !normalizedPlayers[session.playerId]) {
      throw new LeaderboardError(400, 'Leaderboard export contains an invalid session.');
    }
  }
  for (const [key, match] of Object.entries(matches)) {
    if (!match || !normalizedPlayers[match.playerId] || !key.startsWith(`${match.playerId}:`)) {
      throw new LeaderboardError(400, `Leaderboard export contains an invalid match record: ${key}.`);
    }
  }
  for (const [key, value] of Object.entries(daily)) {
    const separator = key.lastIndexOf(':');
    const playerId = separator > 0 ? key.slice(0, separator) : '';
    const date = separator > 0 ? key.slice(separator + 1) : '';
    if (!normalizedPlayers[playerId] || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        !value || !Number.isInteger(value.botMatches) || !Number.isFinite(value.botPoints)) {
      throw new LeaderboardError(400, `Leaderboard export contains an invalid daily record: ${key}.`);
    }
  }
  return {
    version: LEADERBOARD_SCHEMA_VERSION,
    season,
    players: normalizedPlayers,
    sessions,
    matches,
    daily,
  };
}

export class LeaderboardDurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS players (
          id TEXT PRIMARY KEY,
          data TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS rankings (
          player_id TEXT NOT NULL,
          category TEXT NOT NULL CHECK(category IN ('humans', 'bots', 'overall')),
          name TEXT NOT NULL,
          xp INTEGER NOT NULL,
          score INTEGER NOT NULL,
          matches INTEGER NOT NULL,
          wins INTEGER NOT NULL,
          kills INTEGER NOT NULL,
          deaths INTEGER NOT NULL,
          PRIMARY KEY (player_id, category)
        );
        CREATE INDEX IF NOT EXISTS rankings_category_order ON rankings(
          category,
          score DESC,
          wins DESC,
          kills DESC,
          deaths ASC
        ) WHERE matches > 0;
        CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY,
          player_id TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS sessions_player ON sessions(player_id);
        CREATE TABLE IF NOT EXISTS matches (
          player_id TEXT NOT NULL,
          match_id TEXT NOT NULL,
          data TEXT NOT NULL,
          PRIMARY KEY (player_id, match_id)
        );
        CREATE TABLE IF NOT EXISTS daily (
          record_key TEXT PRIMARY KEY,
          data TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS mutation_limits (
          limit_key TEXT PRIMARY KEY,
          window_started_at INTEGER NOT NULL,
          mutation_count INTEGER NOT NULL
        );
      `);
      this.sql.exec(
        'INSERT OR IGNORE INTO metadata(key, value) VALUES (?, ?)',
        'season',
        String(env.SEASON || DEFAULT_LEADERBOARD_SEASON),
      );
      if (this._metadata('rankings_version') !== '1') {
        // Existing Durable Objects may predate the projection. Backfill each
        // legacy player once; ordinary career/session reads never scan players.
        for (const row of this.sql.exec(`
          SELECT p.id, p.data
          FROM players p
          WHERE (SELECT COUNT(*) FROM rankings r WHERE r.player_id = p.id) < 3
        `).toArray()) {
          const player = parsedObject(row.data);
          if (player) this._upsertRanking(ensureLeaderboardPlayerShape(player));
        }
        this.sql.exec(
          'INSERT INTO metadata(key, value) VALUES (?, ?) ' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
          'rankings_version',
          '1',
        );
      }
    });
  }

  _metadata(key) {
    return this.sql.exec('SELECT value FROM metadata WHERE key = ?', key).toArray()[0]?.value || null;
  }

  _allPlayers() {
    const players = {};
    for (const row of this.sql.exec('SELECT id, data FROM players').toArray()) {
      const player = parsedObject(row.data);
      if (player) players[row.id] = ensureLeaderboardPlayerShape(player);
    }
    return players;
  }

  _player(id) {
    const row = this.sql.exec('SELECT data FROM players WHERE id = ?', id).toArray()[0];
    const player = row ? parsedObject(row.data) : null;
    return player ? ensureLeaderboardPlayerShape(player) : null;
  }

  _upsertRanking(player) {
    ensureLeaderboardPlayerShape(player);
    for (const category of LEADERBOARD_CATEGORIES) {
      const stats = player.stats[category];
      this.sql.exec(`
        INSERT INTO rankings(
          player_id, category, name, xp, score, matches, wins, kills, deaths
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(player_id, category) DO UPDATE SET
          name = excluded.name,
          xp = excluded.xp,
          score = excluded.score,
          matches = excluded.matches,
          wins = excluded.wins,
          kills = excluded.kills,
          deaths = excluded.deaths
      `,
      player.id,
      category,
      player.name,
      Math.max(0, Math.round(Number(player.progression?.xp) || 0)),
      Math.round(Number(stats.score) || 0),
      Math.max(0, Math.round(Number(stats.matches) || 0)),
      Math.max(0, Math.round(Number(stats.wins) || 0)),
      Math.max(0, Math.round(Number(stats.kills) || 0)),
      Math.max(0, Math.round(Number(stats.deaths) || 0)));
    }
  }

  _rankForCategory(player, category) {
    const stats = player.stats[category];
    if (!stats.matches) return null;
    const values = [
      category,
      stats.score,
      stats.score, stats.wins,
      stats.score, stats.wins, stats.kills,
      stats.score, stats.wins, stats.kills, stats.deaths,
    ];
    const preceding = Number(this.sql.exec(`
      SELECT COUNT(*) AS count
      FROM rankings
      WHERE category = ? AND matches > 0 AND (
        score > ? OR
        (score = ? AND wins > ?) OR
        (score = ? AND wins = ? AND kills > ?) OR
        (score = ? AND wins = ? AND kills = ? AND deaths < ?)
      )
    `, ...values).toArray()[0]?.count || 0);

    // Keep exact parity with the shared localeCompare tie breaker without
    // loading or sorting unrelated players.
    const ties = this.sql.exec(`
      SELECT player_id, name
      FROM rankings
      WHERE category = ? AND matches > 0
        AND score = ? AND wins = ? AND kills = ? AND deaths = ?
    `, category, stats.score, stats.wins, stats.kills, stats.deaths).toArray();
    const tiedBefore = ties.filter((candidate) => {
      const nameOrder = String(candidate.name).localeCompare(player.name);
      return nameOrder < 0 || (nameOrder === 0 && String(candidate.player_id).localeCompare(player.id) < 0);
    }).length;
    return preceding + tiedBefore + 1;
  }

  _standingForPlayer(player) {
    if (!player) return null;
    ensureLeaderboardPlayerShape(player);
    const scores = {};
    const ranks = {};
    const stats = {};
    for (const category of LEADERBOARD_CATEGORIES) {
      scores[category] = player.stats[category].score;
      ranks[category] = this._rankForCategory(player, category);
      stats[category] = structuredClone(player.stats[category]);
    }
    const level = levelFromXp(player.progression.xp);
    return {
      id: player.id,
      name: player.name,
      level,
      tier: { ...progressionTier(level) },
      score: scores.overall,
      overallRank: ranks.overall,
      scores,
      ranks,
      stats,
    };
  }

  _consumeMutation(limitKey, windowMs, maximum) {
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      const row = this.sql.exec(
        'SELECT window_started_at, mutation_count FROM mutation_limits WHERE limit_key = ?',
        limitKey,
      ).toArray()[0];
      const reset = !row || now - Number(row.window_started_at) >= windowMs;
      const startedAt = reset ? now : Number(row.window_started_at);
      const count = reset ? 0 : Number(row.mutation_count);
      if (count >= maximum) {
        const retryAfterSeconds = Math.max(1, Math.ceil((startedAt + windowMs - now) / 1000));
        throw new LeaderboardError(429, 'Too many leaderboard mutations. Try again shortly.', {
          retryAfterSeconds,
        });
      }
      this.sql.exec(
        'INSERT INTO mutation_limits(limit_key, window_started_at, mutation_count) VALUES (?, ?, ?) ' +
        'ON CONFLICT(limit_key) DO UPDATE SET window_started_at = excluded.window_started_at, ' +
        'mutation_count = excluded.mutation_count',
        limitKey,
        startedAt,
        count + 1,
      );
      this.sql.exec('DELETE FROM mutation_limits WHERE window_started_at < ?', now - 24 * 60 * 60 * 1000);
    });
  }

  async _authenticate(token) {
    const value = String(token || '').trim();
    if (!value || value.length > 256) return null;
    const hash = await tokenHash(value);
    const row = this.sql.exec(
      'SELECT p.data FROM sessions s JOIN players p ON p.id = s.player_id WHERE s.token_hash = ?',
      hash,
    ).toArray()[0];
    const player = row ? parsedObject(row.data) : null;
    return player ? ensureLeaderboardPlayerShape(player) : null;
  }

  _dataWithPlayers() {
    const data = newLeaderboardData(this._metadata('season') || DEFAULT_LEADERBOARD_SEASON);
    data.players = this._allPlayers();
    return data;
  }

  _singlePlayerData(player, nowMs = Date.now()) {
    const data = newLeaderboardData(this._metadata('season') || DEFAULT_LEADERBOARD_SEASON);
    data.players[player.id] = player;
    const dailyKey = `${player.id}:${leaderboardDayKey(nowMs)}`;
    const dailyRow = this.sql.exec('SELECT data FROM daily WHERE record_key = ?', dailyKey).toArray()[0];
    if (dailyRow) data.daily[dailyKey] = parsedObject(dailyRow.data, { botMatches: 0, botPoints: 0 });
    return data;
  }

  _progression(playerId, nowMs = Date.now(), playerOverride = null) {
    const player = playerOverride || this._player(playerId);
    if (!player) return null;
    const standing = this._standingForPlayer(player);
    return progressionFromData(this._singlePlayerData(player, nowMs), player.id, nowMs, standing);
  }

  async _createSession({ playerName, token, requester = 'unknown' } = {}) {
    this._consumeMutation(`session:${String(requester).slice(0, 128)}`, 60_000, 30);
    const suppliedToken = String(token || '').trim();
    if (suppliedToken) {
      const hash = await tokenHash(suppliedToken);
      const row = this.sql.exec(
        'SELECT p.id, p.data FROM sessions s JOIN players p ON p.id = s.player_id WHERE s.token_hash = ?',
        hash,
      ).toArray()[0];
      if (!row) throw new LeaderboardError(401, 'That leaderboard session is no longer valid.');
      const player = ensureLeaderboardPlayerShape(parsedObject(row.data));
      player.name = cleanLeaderboardName(playerName || player.name);
      player.updatedAt = new Date().toISOString();
      this.ctx.storage.transactionSync(() => {
        this.sql.exec('UPDATE players SET data = ? WHERE id = ?', JSON.stringify(player), player.id);
        this._upsertRanking(player);
      });
      return {
        player: { id: player.id, name: player.name },
        token: suppliedToken,
        resumed: true,
        progression: this._progression(player.id, Date.now(), player),
      };
    }

    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const sessionToken = `ts_${randomToken()}`;
    const hash = await tokenHash(sessionToken);
    const player = ensureLeaderboardPlayerShape({
      id,
      name: cleanLeaderboardName(playerName),
      createdAt: now,
      updatedAt: now,
      lastPlayedAt: null,
      stats: {},
    });
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('INSERT INTO players(id, data) VALUES (?, ?)', id, JSON.stringify(player));
      this._upsertRanking(player);
      this.sql.exec(
        'INSERT INTO sessions(token_hash, player_id, created_at) VALUES (?, ?, ?)',
        hash,
        id,
        now,
      );
    });
    return {
      player: { id, name: player.name },
      token: sessionToken,
      resumed: false,
      progression: this._progression(id, Date.now(), player),
    };
  }

  _submissionData(playerId, payload, nowMs) {
    const data = this._dataWithPlayers();
    const rawMatchId = String(payload?.matchId || '');
    const existing = this.sql.exec(
      'SELECT data FROM matches WHERE player_id = ? AND match_id = ?',
      playerId,
      rawMatchId,
    ).toArray()[0];
    if (existing) data.matches[`${playerId}:${rawMatchId}`] = parsedObject(existing.data);
    const dailyKey = `${playerId}:${leaderboardDayKey(nowMs)}`;
    const dailyRow = this.sql.exec('SELECT data FROM daily WHERE record_key = ?', dailyKey).toArray()[0];
    if (dailyRow) data.daily[dailyKey] = parsedObject(dailyRow.data, { botMatches: 0, botPoints: 0 });
    return data;
  }

  _submitForPlayer(playerId, payload) {
    const nowMs = Date.now();
    const data = this._submissionData(playerId, payload, nowMs);
    const result = submitMatchToData(data, playerId, payload, nowMs);
    if (result.duplicate) return result;
    const matchId = result.result.matchId;
    const matchRecord = data.matches[`${playerId}:${matchId}`];
    const dailyKey = `${playerId}:${leaderboardDayKey(nowMs)}`;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('UPDATE players SET data = ? WHERE id = ?', JSON.stringify(data.players[playerId]), playerId);
      this._upsertRanking(data.players[playerId]);
      this.sql.exec(
        'INSERT INTO matches(player_id, match_id, data) VALUES (?, ?, ?)',
        playerId,
        matchId,
        JSON.stringify(matchRecord),
      );
      if (data.daily[dailyKey]) {
        this.sql.exec(
          'INSERT INTO daily(record_key, data) VALUES (?, ?) ON CONFLICT(record_key) DO UPDATE SET data = excluded.data',
          dailyKey,
          JSON.stringify(data.daily[dailyKey]),
        );
      }
    });
    return result;
  }

  async _submit(token, payload, allowHuman = false, playerId = '') {
    let authenticatedPlayerId = playerId;
    if (!authenticatedPlayerId) {
      const value = String(token || '').trim();
      const hash = value && value.length <= 256 ? await tokenHash(value) : '';
      const row = hash ? this.sql.exec(
        'SELECT p.id, p.data FROM sessions s JOIN players p ON p.id = s.player_id WHERE s.token_hash = ?',
        hash,
      ).toArray()[0] : null;
      const player = row ? parsedObject(row.data) : null;
      if (!player) throw new LeaderboardError(401, 'A valid leaderboard session is required.');
      this._consumeMutation(`match:${row.id}`, 60_000, 12);
      authenticatedPlayerId = player.id;
    }
    const mode = cleanLeaderboardMode(payload && payload.mode);
    if (!allowHuman && (mode === 'humans' || mode === 'mixed')) {
      throw new LeaderboardError(403, 'Human and mixed matches are ranked from the live room server.');
    }
    return this._submitForPlayer(authenticatedPlayerId, payload);
  }

  _leaderboard(category, limit) {
    return leaderboardFromData(this._dataWithPlayers(), category, limit, Date.now());
  }

  _standing(playerId) {
    return this._standingForPlayer(this._player(playerId));
  }

  _import(data) {
    const normalized = validateLeaderboardImport(data);
    const existingPlayers = Number(this.sql.exec('SELECT COUNT(*) AS count FROM players').toArray()[0]?.count || 0);
    if (this._metadata('imported_at') || existingPlayers > 0) {
      throw new LeaderboardError(409, 'Leaderboard import is one-time and must run before live sessions are created.');
    }
    const importedAt = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('UPDATE metadata SET value = ? WHERE key = ?', normalized.season, 'season');
      this.sql.exec('INSERT INTO metadata(key, value) VALUES (?, ?)', 'imported_at', importedAt);
      for (const [id, player] of Object.entries(normalized.players)) {
        this.sql.exec('INSERT INTO players(id, data) VALUES (?, ?)', id, JSON.stringify(player));
        this._upsertRanking(player);
      }
      for (const [hash, session] of Object.entries(normalized.sessions)) {
        this.sql.exec(
          'INSERT INTO sessions(token_hash, player_id, created_at) VALUES (?, ?, ?)',
          hash,
          session.playerId,
          String(session.createdAt || importedAt),
        );
      }
      for (const [key, match] of Object.entries(normalized.matches)) {
        const prefix = `${match.playerId}:`;
        const matchId = key.slice(prefix.length);
        this.sql.exec(
          'INSERT INTO matches(player_id, match_id, data) VALUES (?, ?, ?)',
          match.playerId,
          matchId,
          JSON.stringify(match),
        );
      }
      for (const [key, daily] of Object.entries(normalized.daily)) {
        this.sql.exec('INSERT INTO daily(record_key, data) VALUES (?, ?)', key, JSON.stringify(daily));
      }
    });
    return {
      imported: true,
      importedAt,
      season: normalized.season,
      counts: {
        players: Object.keys(normalized.players).length,
        sessions: Object.keys(normalized.sessions).length,
        matches: Object.keys(normalized.matches).length,
        daily: Object.keys(normalized.daily).length,
      },
    };
  }

  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (request.method === 'GET' && url.pathname === '/internal/health') {
        return jsonResponse(200, {
          ok: true,
          storage: 'sqlite',
          season: this._metadata('season'),
          imported: !!this._metadata('imported_at'),
        });
      }
      if (request.method === 'POST' && url.pathname === '/internal/auth') {
        const player = await this._authenticate(bearerToken(request));
        return player
          ? jsonResponse(200, { player: { id: player.id, name: player.name } })
          : jsonResponse(401, { error: 'A valid leaderboard session is required.' });
      }
      if (request.method === 'POST' && url.pathname === '/internal/matches') {
        const body = await readJson(request);
        const result = await this._submit('', body.payload, true, String(body.playerId || ''));
        return jsonResponse(result.duplicate ? 200 : 201, result);
      }
      if (request.method === 'POST' && url.pathname === '/internal/import') {
        return jsonResponse(201, this._import(await readJson(request, MAX_IMPORT_BODY_BYTES)));
      }
      if (request.method === 'GET' && url.pathname === '/api/leaderboard') {
        const category = String(url.searchParams.get('category') || 'overall').toLowerCase();
        return jsonResponse(200, this._leaderboard(category, url.searchParams.get('limit') || 50));
      }
      if (request.method === 'GET' && url.pathname === '/api/leaderboard/rules') {
        return jsonResponse(200, {
          season: this._metadata('season'),
          rules: publicLeaderboardRules(),
        });
      }
      if (request.method === 'GET' && url.pathname === '/api/leaderboard/me') {
        const player = await this._authenticate(bearerToken(request));
        if (!player) throw new LeaderboardError(401, 'A valid leaderboard session is required.');
        const progression = this._progression(player.id, Date.now(), player);
        return jsonResponse(200, {
          player: { id: player.id, name: player.name },
          standing: progression?.standing || this._standing(player.id),
          progression,
        });
      }
      if (request.method === 'POST' && url.pathname === '/api/leaderboard/session') {
        const body = await readJson(request);
        const session = await this._createSession({
          playerName: body.playerName,
          token: bearerToken(request) || body.token,
          requester: request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown',
        });
        return jsonResponse(session.resumed ? 200 : 201, session);
      }
      if (request.method === 'POST' && url.pathname === '/api/leaderboard/matches') {
        const body = await readJson(request);
        const submission = await this._submit(bearerToken(request) || body.sessionToken, body);
        return jsonResponse(submission.duplicate ? 200 : 201, {
          accepted: true,
          duplicate: submission.duplicate,
          result: submission.result,
          rewards: submission.rewards,
          progression: submission.progression,
          player: submission.standing || { id: submission.player.id, name: submission.player.name },
          entry: submission.standing || undefined,
        });
      }
      return jsonResponse(405, { error: 'Method not allowed.' }, { Allow: 'GET, POST' });
    } catch (error) {
      const status = error instanceof LeaderboardError ? error.status : 500;
      if (status === 500) console.error('Leaderboard Durable Object failure:', error);
      return jsonResponse(status, {
        error: status === 500 ? 'Leaderboard service failed.' : error.message,
        ...(error.details ? { details: error.details } : {}),
      });
    }
  }
}
