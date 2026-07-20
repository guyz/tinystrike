export const LEADERBOARD_CATEGORIES = Object.freeze(['humans', 'bots', 'overall']);
export const LEADERBOARD_MODES = Object.freeze(['humans', 'bots', 'mixed', 'solo']);
export const LEADERBOARD_MAPS = Object.freeze([
  'dustyard',
  'frostline',
  'neon_foundry',
  'harbor',
  'citadel',
]);

export const LEADERBOARD_SCHEMA_VERSION = 1;
export const DEFAULT_LEADERBOARD_SEASON = 'season-1';
const MIN_DURATION_SECONDS = 60;
const MAX_DURATION_SECONDS = 2 * 60 * 60;
const BOT_DAILY_FULL_VALUE_MATCHES = 5;
const BOT_DAILY_HALF_VALUE_MATCHES = 10;
const BOT_DAILY_POINT_CAP = 1200;
const MAX_RESULT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

export const SCORE_WEIGHTS = Object.freeze({
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

export class LeaderboardError extends Error {
  constructor(status, message, details = undefined) {
    super(message);
    this.name = 'LeaderboardError';
    this.status = status;
    this.details = details;
  }
}

export function blankLeaderboardStats() {
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

export function newLeaderboardData(season = DEFAULT_LEADERBOARD_SEASON) {
  return {
    version: LEADERBOARD_SCHEMA_VERSION,
    season,
    players: {},
    sessions: {},
    matches: {},
    daily: {},
  };
}

export function cleanLeaderboardName(value) {
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

export function cleanLeaderboardMode(value) {
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

export function validateLeaderboardResult(payload, nowMs) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new LeaderboardError(400, 'A JSON match result is required.');
  }
  const matchId = cleanMatchId(payload.matchId);
  const mode = cleanLeaderboardMode(payload.mode);
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

export function leaderboardDayKey(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function publicLeaderboardRules() {
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

export function ensureLeaderboardPlayerShape(player) {
  player.stats ||= {};
  for (const category of LEADERBOARD_CATEGORIES) {
    player.stats[category] = { ...blankLeaderboardStats(), ...(player.stats[category] || {}) };
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

export function playerStandingFromData(data, playerId) {
  const player = data.players[playerId];
  if (!player) return null;
  ensureLeaderboardPlayerShape(player);
  const scores = {};
  const ranks = {};
  for (const category of LEADERBOARD_CATEGORIES) {
    scores[category] = player.stats[category].score;
    const ranked = Object.values(data.players)
      .filter((candidate) => ensureLeaderboardPlayerShape(candidate).stats[category].matches > 0)
      .map((candidate) => ({
        playerId: candidate.id,
        name: candidate.name,
        ...candidate.stats[category],
      }))
      .sort(rankingCompare);
    const index = ranked.findIndex((entry) => entry.playerId === player.id);
    ranks[category] = index < 0 ? null : index + 1;
  }
  return {
    id: player.id,
    name: player.name,
    score: scores.overall,
    overallRank: ranks.overall,
    scores,
    ranks,
  };
}

export function submitMatchToData(data, playerId, payload, nowMs) {
  const player = data.players[playerId];
  if (!player) throw new LeaderboardError(401, 'Leaderboard player not found.');
  const match = validateLeaderboardResult(payload, nowMs);
  const submissionKey = `${player.id}:${match.matchId}`;
  const existing = data.matches[submissionKey];
  if (existing) {
    return {
      accepted: true,
      duplicate: true,
      result: existing.publicResult,
      player,
      standing: playerStandingFromData(data, player.id),
    };
  }

  const breakdown = {};
  const points = { humans: 0, bots: 0, overall: 0 };
  const creditedCategories = [];
  for (const category of ['humans', 'bots']) {
    const split = match.splits[category];
    if (split.share <= 0) continue;
    const score = scoreCategory(category, match, split);
    let multiplier = 1;
    let dailyCapAdjustment = 0;
    if (category === 'bots') {
      const key = `${player.id}:${leaderboardDayKey(nowMs)}`;
      const daily = data.daily[key] ||= { botMatches: 0, botPoints: 0 };
      if (daily.botMatches >= BOT_DAILY_HALF_VALUE_MATCHES) multiplier = 0.25;
      else if (daily.botMatches >= BOT_DAILY_FULL_VALUE_MATCHES) multiplier = 0.5;
      const tapered = Math.round(score.raw * multiplier);
      const remaining = Math.max(0, BOT_DAILY_POINT_CAP - daily.botPoints);
      points.bots = Math.min(tapered, remaining);
      dailyCapAdjustment = tapered - points.bots;
      daily.botMatches++;
      daily.botPoints += points.bots;
    } else {
      points.humans = score.raw;
    }
    const awarded = points[category];
    breakdown[category] = {
      ...score,
      farmingMultiplier: multiplier,
      dailyCapAdjustment,
      awarded,
    };
    creditedCategories.push(category);
  }
  points.overall = points.humans + points.bots;
  breakdown.overall = {
    humans: points.humans,
    bots: points.bots,
    awarded: points.overall,
  };

  const won = match.result === 'win' ? 1 : 0;
  const lost = match.result === 'loss' ? 1 : 0;
  const drew = match.result === 'draw' ? 1 : 0;
  for (const category of creditedCategories) {
    const split = match.splits[category];
    const stats = ensureLeaderboardPlayerShape(player).stats[category];
    stats.score += points[category];
    stats.matches++;
    stats.wins += won;
    stats.losses += lost;
    stats.draws += drew;
    stats.kills += split.kills;
    stats.deaths += split.deaths;
    stats.headshots += split.headshots;
    stats.plants += Math.round(match.plants * split.share);
    stats.defuses += Math.round(match.defuses * split.share);
    stats.roundsWon += Math.round(match.roundsWon * split.share);
    stats.roundsLost += Math.round(match.roundsLost * split.share);
    stats.timePlayed += Math.round(match.duration * split.share);
  }
  const overall = ensureLeaderboardPlayerShape(player).stats.overall;
  overall.score += points.overall;
  overall.matches++;
  overall.wins += won;
  overall.losses += lost;
  overall.draws += drew;
  overall.kills += match.kills;
  overall.deaths += match.deaths;
  overall.headshots += match.headshots;
  overall.plants += match.plants;
  overall.defuses += match.defuses;
  overall.roundsWon += match.roundsWon;
  overall.roundsLost += match.roundsLost;
  overall.timePlayed += match.duration;

  player.updatedAt = new Date(nowMs).toISOString();
  player.lastPlayedAt = match.completedAt;
  const publicResult = {
    matchId: match.matchId,
    mode: match.mode,
    mapId: match.mapId,
    points,
    breakdown,
  };
  data.matches[submissionKey] = {
    playerId: player.id,
    acceptedAt: new Date(nowMs).toISOString(),
    match,
    publicResult,
  };
  return {
    accepted: true,
    duplicate: false,
    result: publicResult,
    player,
    standing: playerStandingFromData(data, player.id),
  };
}

export function leaderboardFromData(data, category = 'overall', limit = 50, nowMs = Date.now()) {
  if (!LEADERBOARD_CATEGORIES.includes(category)) {
    throw new LeaderboardError(400, `category must be one of: ${LEADERBOARD_CATEGORIES.join(', ')}.`);
  }
  const safeLimit = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 50));
  const entries = Object.values(data.players)
    .map((player) => {
      const stats = ensureLeaderboardPlayerShape(player).stats[category];
      const winRate = stats.matches ? stats.wins / stats.matches : 0;
      const kd = stats.deaths ? stats.kills / stats.deaths : stats.kills;
      const headshotRate = stats.kills ? stats.headshots / stats.kills : 0;
      return {
        playerId: player.id,
        name: player.name,
        score: stats.score,
        matches: stats.matches,
        wins: stats.wins,
        losses: stats.losses,
        draws: stats.draws,
        winRate: round2(winRate),
        kills: stats.kills,
        deaths: stats.deaths,
        kd: round2(kd),
        headshots: stats.headshots,
        headshotRate: round2(headshotRate),
        plants: stats.plants,
        defuses: stats.defuses,
        timePlayed: stats.timePlayed,
        lastPlayedAt: player.lastPlayedAt,
      };
    })
    .filter((entry) => entry.matches > 0)
    .sort(rankingCompare)
    .slice(0, safeLimit)
    .map((entry, index) => ({ rank: index + 1, ...entry }));
  return {
    category,
    season: data.season,
    generatedAt: new Date(nowMs).toISOString(),
    rules: publicLeaderboardRules(),
    entries,
  };
}

export const LEADERBOARD_RULES = Object.freeze(publicLeaderboardRules());
