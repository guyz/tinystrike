import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import {
  LeaderboardError,
  leaderboardFromData,
  playerStandingFromData,
  submitMatchToData,
} from '../shared/leaderboard-core.mjs';

export { LeaderboardError };

export const LEADERBOARD_CATEGORIES = Object.freeze(['humans', 'bots', 'overall']);
export const LEADERBOARD_MODES = Object.freeze(['humans', 'bots', 'mixed', 'solo']);
export const LEADERBOARD_MAPS = Object.freeze([
  'dustyard',
  'frostline',
  'neon_foundry',
  'harbor',
  'citadel',
]);

const SCHEMA_VERSION = 1;
const DEFAULT_SEASON = 'season-1';
const MIN_DURATION_SECONDS = 60;
const MAX_DURATION_SECONDS = 2 * 60 * 60;
const BOT_DAILY_FULL_VALUE_MATCHES = 5;
const BOT_DAILY_HALF_VALUE_MATCHES = 10;
const BOT_DAILY_POINT_CAP = 1200;
const MAX_RESULT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

const SCORE_WEIGHTS = Object.freeze({
  humans: Object.freeze({
    completion: 30,
    win: 90,
    draw: 45,
    loss: 15,
    round: 5,
    kill: 14,
    headshot: 3,
    efficiency: 3,
    plant: 10,
    defuse: 15,
    minute: 1,
  }),
  bots: Object.freeze({
    completion: 16,
    win: 45,
    draw: 20,
    loss: 8,
    round: 3,
    kill: 6,
    headshot: 1,
    efficiency: 1,
    plant: 4,
    defuse: 6,
    minute: 0.5,
  }),
});

function blankStats() {
  return {
    score: 0,
    matches: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    kills: 0,
    deaths: 0,
    headshots: 0,
    plants: 0,
    defuses: 0,
    roundsWon: 0,
    roundsLost: 0,
    timePlayed: 0,
  };
}

function newData(season) {
  return {
    version: SCHEMA_VERSION,
    season,
    players: {},
    sessions: {},
    matches: {},
    daily: {},
  };
}

function tokenHash(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

function cleanName(value) {
  const name = String(value || '')
    .trim()
    .replace(/[^\p{L}\p{N} _.-]/gu, '')
    .replace(/\s+/g, ' ')
    .slice(0, 20);
  return name || 'Operative';
}

function finiteNumber(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new LeaderboardError(400, `${field} must be a finite number.`);
  return number;
}

function boundedInteger(value, field, min, max) {
  const number = finiteNumber(value, field);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new LeaderboardError(400, `${field} must be an integer from ${min} to ${max}.`);
  }
  return number;
}

function cleanMatchId(value) {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) {
    throw new LeaderboardError(400, 'matchId must be 8–80 letters, numbers, underscores, or dashes.');
  }
  return id;
}

function cleanMode(value) {
  const mode = String(value || '').toLowerCase();
  if (!LEADERBOARD_MODES.includes(mode)) {
    throw new LeaderboardError(400, `mode must be one of: ${LEADERBOARD_MODES.join(', ')}.`);
  }
  return mode;
}

function cleanMapId(value) {
  const mapId = String(value || '').toLowerCase();
  if (!LEADERBOARD_MAPS.includes(mapId)) {
    throw new LeaderboardError(400, `mapId must be one of: ${LEADERBOARD_MAPS.join(', ')}.`);
  }
  return mapId;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function outcomeOf(payload, ct, t) {
  const winner = String(payload.winner || '').toLowerCase();
  if (!['ct', 't', 'draw'].includes(winner)) {
    throw new LeaderboardError(400, 'winner must be ct, t, or draw.');
  }
  if (winner === 'ct' && ct <= t) throw new LeaderboardError(400, 'winner conflicts with scores.');
  if (winner === 't' && t <= ct) throw new LeaderboardError(400, 'winner conflicts with scores.');
  if (winner === 'draw' && ct !== t) throw new LeaderboardError(400, 'A draw requires tied scores.');

  let result;
  if (winner === 'draw') result = 'draw';
  else if (typeof payload.teamWon === 'boolean') result = payload.teamWon ? 'win' : 'loss';
  else if (typeof payload.won === 'boolean') result = payload.won ? 'win' : 'loss';
  else if (payload.playerTeam === 'ct' || payload.playerTeam === 't') result = payload.playerTeam === winner ? 'win' : 'loss';
  else throw new LeaderboardError(400, 'teamWon (or playerTeam) is required for a non-draw result.');
  return { winner, result };
}

function validateResult(payload, nowMs) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new LeaderboardError(400, 'A JSON match result is required.');
  }
  const matchId = cleanMatchId(payload.matchId);
  const mode = cleanMode(payload.mode);
  const mapId = cleanMapId(payload.mapId);
  const scores = payload.scores || {};
  const ct = boundedInteger(scores.ct, 'scores.ct', 0, 8);
  const t = boundedInteger(scores.t, 'scores.t', 0, 8);
  const roundsPlayed = boundedInteger(payload.roundsPlayed, 'roundsPlayed', 1, 15);
  if (ct + t !== roundsPlayed) throw new LeaderboardError(400, 'roundsPlayed must equal scores.ct + scores.t.');
  if (Math.max(ct, t) !== 8 && ct !== t) {
    throw new LeaderboardError(400, 'A completed non-draw match must have a team on 8 rounds.');
  }
  const { winner, result } = outcomeOf(payload, ct, t);
  const duration = finiteNumber(payload.duration ?? payload.durationSeconds, 'duration');
  const plausibleMinimum = Math.max(MIN_DURATION_SECONDS, roundsPlayed * 6);
  if (duration < plausibleMinimum || duration > MAX_DURATION_SECONDS) {
    throw new LeaderboardError(422, `duration must be between ${plausibleMinimum} and ${MAX_DURATION_SECONDS} seconds for this result.`);
  }
  const kills = boundedInteger(payload.kills, 'kills', 0, roundsPlayed * 5);
  const deaths = boundedInteger(payload.deaths, 'deaths', 0, roundsPlayed);
  const headshots = boundedInteger(payload.headshots, 'headshots', 0, kills);
  const objectives = payload.objectives && typeof payload.objectives === 'object' ? payload.objectives : {};
  const plants = boundedInteger(payload.plants ?? objectives.plants ?? 0, 'plants', 0, roundsPlayed);
  const defuses = boundedInteger(payload.defuses ?? objectives.defuses ?? 0, 'defuses', 0, roundsPlayed);
  if (plants + defuses > roundsPlayed) {
    throw new LeaderboardError(422, 'plants + defuses cannot exceed roundsPlayed.');
  }
  if (kills > Math.ceil(duration / 8) + 5) {
    throw new LeaderboardError(422, 'The elimination rate is not plausible for the reported duration.');
  }

  let completedAt = nowMs;
  if (payload.completedAt != null) {
    completedAt = Date.parse(payload.completedAt);
    if (!Number.isFinite(completedAt)) throw new LeaderboardError(400, 'completedAt must be an ISO date.');
    if (completedAt > nowMs + MAX_FUTURE_SKEW_MS || completedAt < nowMs - MAX_RESULT_AGE_MS) {
      throw new LeaderboardError(422, 'completedAt is outside the accepted seven-day submission window.');
    }
  }

  const roundsWon = result === 'draw' ? ct : result === 'win' ? Math.max(ct, t) : Math.min(ct, t);
  const roundsLost = roundsPlayed - roundsWon;
  const humanOpponents = payload.humanOpponents == null
    ? null
    : boundedInteger(payload.humanOpponents, 'humanOpponents', 0, 5);
  const botOpponents = payload.botOpponents == null
    ? null
    : boundedInteger(payload.botOpponents, 'botOpponents', 0, 5);

  let killsHumans;
  let killsBots;
  if (mode === 'humans') {
    killsHumans = kills;
    killsBots = 0;
  } else if (mode === 'bots' || mode === 'solo') {
    killsHumans = 0;
    killsBots = kills;
  } else if (payload.killsHumans != null || payload.killsBots != null) {
    killsHumans = boundedInteger(payload.killsHumans ?? 0, 'killsHumans', 0, kills);
    killsBots = boundedInteger(payload.killsBots ?? 0, 'killsBots', 0, kills);
    if (killsHumans + killsBots !== kills) {
      throw new LeaderboardError(400, 'killsHumans + killsBots must equal kills.');
    }
  } else {
    const humanCount = humanOpponents ?? 1;
    const botCount = botOpponents ?? 1;
    const total = Math.max(1, humanCount + botCount);
    killsHumans = Math.round(kills * humanCount / total);
    killsBots = kills - killsHumans;
  }

  let humanShare = 0;
  if (mode === 'humans') humanShare = 1;
  else if (mode === 'mixed') {
    const humanCount = humanOpponents ?? (killsHumans > 0 ? 1 : 0);
    const botCount = botOpponents ?? (killsBots > 0 ? 1 : 0);
    humanShare = humanCount + botCount > 0 ? humanCount / (humanCount + botCount) : 0.5;
  }
  const botShare = 1 - humanShare;

  // Split headshots proportionally without ever crediting more than the
  // corresponding number of eliminations in either category.
  const humanHeadshots = Math.min(killsHumans, Math.round(headshots * (kills ? killsHumans / kills : humanShare)));
  const botHeadshots = Math.min(killsBots, headshots - humanHeadshots);

  return {
    matchId,
    mode,
    mapId,
    winner,
    result,
    scores: { ct, t },
    duration: Math.round(duration),
    roundsPlayed,
    roundsWon,
    roundsLost,
    kills,
    deaths,
    headshots,
    plants,
    defuses,
    completedAt: new Date(completedAt).toISOString(),
    splits: {
      humans: {
        share: humanShare,
        kills: killsHumans,
        deaths: Math.round(deaths * humanShare),
        headshots: humanHeadshots,
      },
      bots: {
        share: botShare,
        kills: killsBots,
        deaths: deaths - Math.round(deaths * humanShare),
        headshots: botHeadshots,
      },
    },
  };
}

function scoreCategory(category, match, split) {
  const weights = SCORE_WEIGHTS[category];
  const share = split.share;
  const outcome = weights[match.result];
  const components = {
    completion: Math.round(weights.completion * share),
    outcome: Math.round(outcome * share),
    rounds: Math.round(match.roundsWon * weights.round * share),
    eliminations: split.kills * weights.kill,
    headshots: split.headshots * weights.headshot,
    efficiency: Math.max(0, split.kills - split.deaths) * weights.efficiency,
    objectives: Math.round((match.plants * weights.plant + match.defuses * weights.defuse) * share),
    time: Math.round(Math.min(match.duration / 60, 45) * weights.minute * share),
  };
  const raw = Object.values(components).reduce((sum, value) => sum + value, 0);
  return { ...components, raw: Math.round(raw) };
}

function dayKey(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function publicRules() {
  return {
    summary: 'Season score rewards completed matches, wins, rounds, eliminations, headshots, bomb objectives, efficiency, and time played. Human competition is worth more; repeated bot matches taper each UTC day.',
    humanWeight: 2,
    botWeight: 1,
    humanPolicy: 'full competitive value; no daily point cap',
    botPolicy: 'lower base value with anti-farming taper',
    botDailyFullValueMatches: BOT_DAILY_FULL_VALUE_MATCHES,
    botDailyReducedRate: 0.5,
    botDailyLateRate: 0.25,
    botDailyPointCap: BOT_DAILY_POINT_CAP,
    minDurationSeconds: MIN_DURATION_SECONDS,
    scoring: SCORE_WEIGHTS,
  };
}

function ensurePlayerShape(player) {
  player.stats ||= {};
  for (const category of LEADERBOARD_CATEGORIES) {
    player.stats[category] = { ...blankStats(), ...(player.stats[category] || {}) };
  }
  return player;
}

function rankingCompare(a, b) {
  return b.score - a.score ||
    b.wins - a.wins ||
    b.kills - a.kills ||
    a.deaths - b.deaths ||
    a.name.localeCompare(b.name) ||
    a.playerId.localeCompare(b.playerId);
}

/**
 * Persistent leaderboard store for the current lightweight deployment.
 *
 * Identity is an opaque bearer token; only its SHA-256 digest is written to
 * disk. Clients submit raw match facts, never points. The server validates the
 * facts, calculates every category score, deduplicates per player+matchId, and
 * atomically replaces the JSON file after accepted mutations.
 */
export class LeaderboardStore {
  constructor({
    filePath,
    season = DEFAULT_SEASON,
    now = () => Date.now(),
    makeId = () => randomUUID(),
    makeToken = () => `ts_${randomBytes(24).toString('base64url')}`,
  } = {}) {
    if (!filePath) throw new TypeError('LeaderboardStore requires filePath.');
    this.filePath = filePath;
    this.now = now;
    this.makeId = makeId;
    this.makeToken = makeToken;
    this.data = this._load(season);
  }

  _load(season) {
    if (!existsSync(this.filePath)) return newData(season);
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (!parsed || parsed.version !== SCHEMA_VERSION || typeof parsed.players !== 'object') {
        throw new Error('Unsupported leaderboard data schema.');
      }
      parsed.sessions ||= {};
      parsed.matches ||= {};
      parsed.daily ||= {};
      for (const player of Object.values(parsed.players)) ensurePlayerShape(player);
      return parsed;
    } catch (error) {
      const recoveryPath = `${this.filePath}.corrupt-${Date.now()}`;
      renameSync(this.filePath, recoveryPath);
      console.error(`[leaderboard] Preserved unreadable data at ${recoveryPath}: ${error.message}`);
      return newData(season);
    }
  }

  _save() {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${randomBytes(5).toString('hex')}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    renameSync(tempPath, this.filePath);
  }

  rules() {
    return publicRules();
  }

  createSession({ playerName, token } = {}) {
    const suppliedToken = String(token || '').trim();
    if (suppliedToken) {
      const player = this.authenticate(suppliedToken);
      if (!player) throw new LeaderboardError(401, 'That leaderboard session is no longer valid.');
      player.name = cleanName(playerName || player.name);
      player.updatedAt = new Date(this.now()).toISOString();
      this._save();
      return { player: { id: player.id, name: player.name }, token: suppliedToken, resumed: true };
    }

    const createdAt = new Date(this.now()).toISOString();
    const id = this.makeId();
    const sessionToken = this.makeToken();
    const player = ensurePlayerShape({
      id,
      name: cleanName(playerName),
      createdAt,
      updatedAt: createdAt,
      lastPlayedAt: null,
      stats: {},
    });
    this.data.players[id] = player;
    this.data.sessions[tokenHash(sessionToken)] = { playerId: id, createdAt };
    this._save();
    return { player: { id, name: player.name }, token: sessionToken, resumed: false };
  }

  authenticate(token) {
    const value = String(token || '').trim();
    if (!value || value.length > 256) return null;
    const session = this.data.sessions[tokenHash(value)];
    if (!session) return null;
    return this.data.players[session.playerId] || null;
  }

  submitMatch(token, payload) {
    const player = this.authenticate(token);
    if (!player) throw new LeaderboardError(401, 'A valid leaderboard session is required.');
    const mode = cleanMode(payload && payload.mode);
    if (mode === 'humans' || mode === 'mixed') {
      throw new LeaderboardError(403, 'Human and mixed matches are ranked from the live room server.');
    }
    return this.submitMatchForPlayer(player.id, payload);
  }

  /** Used by the WebSocket authority after it has associated a token to a room player. */
  submitMatchForPlayer(playerId, payload) {
    const nowMs = this.now();
    const result = submitMatchToData(this.data, playerId, payload, nowMs);
    if (!result.duplicate) this._save();
    return result;
  }

  playerStanding(playerId) {
    return playerStandingFromData(this.data, playerId);
  }

  leaderboard(category = 'overall', limit = 50) {
    return leaderboardFromData(this.data, category, limit, this.now());
  }
}

export const LEADERBOARD_RULES = Object.freeze(publicRules());
