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
export const PROGRESSION_SCHEMA_VERSION = 1;
const MIN_DURATION_SECONDS = 60;
const MAX_DURATION_SECONDS = 2 * 60 * 60;
const BOT_DAILY_FULL_VALUE_MATCHES = 5;
const BOT_DAILY_HALF_VALUE_MATCHES = 10;
const BOT_DAILY_POINT_CAP = 1200;
const BOT_MATCH_COMPLETION_XP = 30;
const MAX_RESULT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

export const BOT_DAILY_CONTRACT = Object.freeze({
  id: 'daily_bot_ops',
  title: 'Daily Bot Ops',
  description: 'Complete 3 bot matches, win 2, and eliminate 20 bots.',
  targets: Object.freeze({ matches: 3, wins: 2, kills: 20 }),
  rewardXp: 250,
});

export const PROGRESSION_TIERS = Object.freeze([
  Object.freeze({ id: 'recruit', name: 'Recruit', minLevel: 1 }),
  Object.freeze({ id: 'bronze', name: 'Bronze', minLevel: 5 }),
  Object.freeze({ id: 'silver', name: 'Silver', minLevel: 10 }),
  Object.freeze({ id: 'gold', name: 'Gold', minLevel: 20 }),
  Object.freeze({ id: 'platinum', name: 'Platinum', minLevel: 35 }),
  Object.freeze({ id: 'elite', name: 'Elite', minLevel: 50 }),
]);

export const ACHIEVEMENT_CATALOG = Object.freeze([
  Object.freeze({ id: 'first_match', title: 'Deployed', description: 'Complete your first match.' }),
  Object.freeze({ id: 'first_win', title: 'Mission Accomplished', description: 'Win your first match.' }),
  Object.freeze({ id: 'first_headshot', title: 'On Target', description: 'Land your first headshot.' }),
  Object.freeze({ id: 'eliminator_10', title: 'Eliminator', description: 'Reach 10 lifetime eliminations.' }),
  Object.freeze({ id: 'veteran_10', title: 'Veteran', description: 'Complete 10 matches.' }),
  Object.freeze({ id: 'headhunter_25', title: 'Headhunter', description: 'Reach 25 lifetime headshots.' }),
  Object.freeze({ id: 'win_streak_3', title: 'Hot Streak', description: 'Win 3 matches in a row.' }),
  Object.freeze({ id: 'objective_10', title: 'Objective Specialist', description: 'Complete 10 bomb objectives.' }),
  Object.freeze({ id: 'eliminator_100', title: 'Century', description: 'Reach 100 lifetime eliminations.' }),
  Object.freeze({ id: 'map_master', title: 'Five Fronts', description: 'Win on every battleground.' }),
  Object.freeze({ id: 'flawless_match', title: 'Untouchable', description: 'Win with at least 5 kills and no deaths.' }),
  Object.freeze({ id: 'daily_bot_ops', title: 'Contract Complete', description: 'Complete a Daily Bot Ops contract.' }),
]);

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

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function blankProgressTotals() {
  return {
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

function normalizedProgressTotals(value = {}) {
  const totals = { ...blankProgressTotals() };
  for (const key of Object.keys(totals)) {
    const number = Number(value?.[key]);
    totals[key] = Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
  }
  return totals;
}

function legacyLifetimeFromStats(stats = {}) {
  return normalizedProgressTotals(stats);
}

function blankProgression(stats = {}) {
  const lifetime = legacyLifetimeFromStats(stats);
  return {
    version: PROGRESSION_SCHEMA_VERSION,
    // Existing season score is the deterministic migration seed. It preserves
    // every established player's progress without pretending historic matches
    // can be reconstructed into new map, mode, record, or streak dimensions.
    xp: Math.max(0, Math.round(Number(stats.score) || 0)),
    lifetime,
    byMap: {},
    byMode: {},
    records: {},
    streaks: {
      winsCurrent: 0,
      winsBest: 0,
      playDaysCurrent: lifetime.matches > 0 ? 1 : 0,
      playDaysBest: lifetime.matches > 0 ? 1 : 0,
      lastActiveDay: null,
    },
    achievements: {},
  };
}

function ensureProgressionShape(player) {
  const overall = player.stats?.overall || blankLeaderboardStats();
  if (!player.progression || typeof player.progression !== 'object' || Array.isArray(player.progression)) {
    player.progression = blankProgression(overall);
  }
  const progression = player.progression;
  progression.version = PROGRESSION_SCHEMA_VERSION;
  progression.xp = Math.max(0, Math.round(Number(progression.xp) || 0));
  progression.lifetime = normalizedProgressTotals(progression.lifetime || overall);
  progression.byMap ||= {};
  progression.byMode ||= {};
  for (const [key, totals] of Object.entries(progression.byMap)) {
    progression.byMap[key] = normalizedProgressTotals(totals);
  }
  for (const [key, totals] of Object.entries(progression.byMode)) {
    progression.byMode[key] = normalizedProgressTotals(totals);
  }
  progression.records = progression.records && typeof progression.records === 'object'
    ? progression.records
    : {};
  progression.streaks = {
    winsCurrent: 0,
    winsBest: 0,
    playDaysCurrent: 0,
    playDaysBest: 0,
    lastActiveDay: null,
    ...(progression.streaks || {}),
  };
  for (const key of ['winsCurrent', 'winsBest', 'playDaysCurrent', 'playDaysBest']) {
    progression.streaks[key] = Math.max(0, Math.round(Number(progression.streaks[key]) || 0));
  }
  progression.streaks.lastActiveDay = /^\d{4}-\d{2}-\d{2}$/.test(progression.streaks.lastActiveDay || '')
    ? progression.streaks.lastActiveDay
    : null;
  progression.achievements = progression.achievements && typeof progression.achievements === 'object'
    ? progression.achievements
    : {};
  return progression;
}

export function xpForLevel(level) {
  const safeLevel = Math.max(1, Math.floor(Number(level) || 1));
  return 500 + (safeLevel - 1) * 150;
}

export function levelFromXp(xp) {
  const safeXp = Math.max(0, Math.floor(Number(xp) || 0));
  const completedLevels = Math.floor((-425 + Math.sqrt(425 * 425 + 300 * safeXp)) / 150);
  return Math.max(1, completedLevels + 1);
}

function cumulativeXpForLevel(level) {
  const completedLevels = Math.max(0, Math.floor(Number(level) || 1) - 1);
  return 75 * completedLevels * completedLevels + 425 * completedLevels;
}

export function progressionTier(level) {
  const safeLevel = Math.max(1, Math.floor(Number(level) || 1));
  return PROGRESSION_TIERS.reduce(
    (selected, tier) => safeLevel >= tier.minLevel ? tier : selected,
    PROGRESSION_TIERS[0],
  );
}

function ensureDailyShape(value = {}) {
  const contract = value.contract && typeof value.contract === 'object' ? value.contract : {};
  return {
    botMatches: Math.max(0, Math.round(Number(value.botMatches) || 0)),
    botPoints: Math.max(0, Math.round(Number(value.botPoints) || 0)),
    contract: {
      matches: Math.max(0, Math.round(Number(contract.matches) || 0)),
      wins: Math.max(0, Math.round(Number(contract.wins) || 0)),
      kills: Math.max(0, Math.round(Number(contract.kills) || 0)),
      completed: contract.completed === true,
      completedAt: contract.completedAt || null,
      bonusXpAwarded: Math.max(0, Math.round(Number(contract.bonusXpAwarded) || 0)),
    },
  };
}

function publicDailyContract(day, daily) {
  const contract = ensureDailyShape(daily).contract;
  const nextDay = new Date(`${day}T00:00:00.000Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  return {
    id: BOT_DAILY_CONTRACT.id,
    title: BOT_DAILY_CONTRACT.title,
    description: BOT_DAILY_CONTRACT.description,
    day,
    targets: { ...BOT_DAILY_CONTRACT.targets },
    progress: {
      matches: contract.matches,
      wins: contract.wins,
      kills: contract.kills,
    },
    completed: contract.completed,
    completedAt: contract.completedAt,
    rewardXp: BOT_DAILY_CONTRACT.rewardXp,
    expiresAt: nextDay.toISOString(),
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
    botDailyContract: BOT_DAILY_CONTRACT,
    minDurationSeconds: MIN_DURATION_SECONDS,
    scoring: SCORE_WEIGHTS,
    progression: {
      xpPolicy: 'XP follows awarded leaderboard points, with a 30 XP completed-match floor for bot play and completed daily contract bonuses.',
      botMatchCompletionXp: BOT_MATCH_COMPLETION_XP,
      tiers: PROGRESSION_TIERS,
      achievements: ACHIEVEMENT_CATALOG,
    },
  };
}

export function ensureLeaderboardPlayerShape(player) {
  player.stats ||= {};
  for (const category of LEADERBOARD_CATEGORIES) {
    player.stats[category] = { ...blankLeaderboardStats(), ...(player.stats[category] || {}) };
  }
  ensureProgressionShape(player);
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
  const level = levelFromXp(player.progression.xp);
  const scores = {};
  const ranks = {};
  const stats = {};
  for (const category of LEADERBOARD_CATEGORIES) {
    scores[category] = player.stats[category].score;
    stats[category] = clone(player.stats[category]);
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
    level,
    tier: { ...progressionTier(level) },
    score: scores.overall,
    overallRank: ranks.overall,
    scores,
    ranks,
    stats,
  };
}

export function progressionFromData(data, playerId, nowMs = Date.now(), standingOverride = null) {
  const player = data.players[playerId];
  if (!player) return null;
  const progression = ensureProgressionShape(ensureLeaderboardPlayerShape(player));
  const level = levelFromXp(progression.xp);
  const tier = progressionTier(level);
  const levelFloor = cumulativeXpForLevel(level);
  const day = leaderboardDayKey(nowMs);
  const daily = ensureDailyShape(data.daily?.[`${player.id}:${day}`]);
  const achievements = ACHIEVEMENT_CATALOG
    .filter((definition) => progression.achievements[definition.id])
    .map((definition) => ({
      ...definition,
      ...clone(progression.achievements[definition.id]),
    }));
  return {
    version: PROGRESSION_SCHEMA_VERSION,
    playerId: player.id,
    playerName: player.name,
    xp: progression.xp,
    level,
    tier: { ...tier },
    xpIntoLevel: progression.xp - levelFloor,
    xpForNextLevel: xpForLevel(level),
    nextLevelXp: levelFloor + xpForLevel(level),
    lifetime: clone(progression.lifetime),
    byMap: clone(progression.byMap),
    byMode: clone(progression.byMode),
    records: clone(progression.records),
    streaks: clone(progression.streaks),
    achievements,
    achievementCount: achievements.length,
    achievementTotal: ACHIEVEMENT_CATALOG.length,
    dailyContract: publicDailyContract(day, daily),
    standing: standingOverride || playerStandingFromData(data, player.id),
  };
}

function applyTotals(totals, match) {
  totals.matches++;
  totals.wins += match.result === 'win' ? 1 : 0;
  totals.losses += match.result === 'loss' ? 1 : 0;
  totals.draws += match.result === 'draw' ? 1 : 0;
  totals.kills += match.kills;
  totals.deaths += match.deaths;
  totals.headshots += match.headshots;
  totals.plants += match.plants;
  totals.defuses += match.defuses;
  totals.roundsWon += match.roundsWon;
  totals.roundsLost += match.roundsLost;
  totals.timePlayed += match.duration;
  return totals;
}

function dayDistance(previousDay, currentDay) {
  if (!previousDay || !currentDay) return Infinity;
  const previous = Date.parse(`${previousDay}T00:00:00.000Z`);
  const current = Date.parse(`${currentDay}T00:00:00.000Z`);
  return Number.isFinite(previous) && Number.isFinite(current)
    ? Math.round((current - previous) / 86_400_000)
    : Infinity;
}

function updateStreaks(streaks, match, acceptedDay) {
  if (match.result === 'win') streaks.winsCurrent++;
  else streaks.winsCurrent = 0;
  streaks.winsBest = Math.max(streaks.winsBest, streaks.winsCurrent);

  const distance = dayDistance(streaks.lastActiveDay, acceptedDay);
  if (!streaks.lastActiveDay) streaks.playDaysCurrent = 1;
  else if (distance === 1) streaks.playDaysCurrent++;
  else if (distance > 1) streaks.playDaysCurrent = 1;
  // Multiple accepted matches on one UTC day do not inflate the day streak.
  streaks.playDaysBest = Math.max(streaks.playDaysBest, streaks.playDaysCurrent);
  streaks.lastActiveDay = acceptedDay;
}

const RECORD_DEFINITIONS = Object.freeze([
  Object.freeze({ id: 'matchScore', label: 'Best match score', value: ({ points }) => points.overall }),
  Object.freeze({ id: 'kills', label: 'Most kills', value: ({ match }) => match.kills }),
  Object.freeze({ id: 'headshots', label: 'Most headshots', value: ({ match }) => match.headshots }),
  Object.freeze({ id: 'kd', label: 'Best K/D', value: ({ match }) => round2(match.kills / Math.max(1, match.deaths)) }),
  Object.freeze({ id: 'objectives', label: 'Most objectives', value: ({ match }) => match.plants + match.defuses }),
  Object.freeze({
    id: 'fastestWin',
    label: 'Fastest win',
    lowerIsBetter: true,
    value: ({ match }) => match.result === 'win' ? match.duration : null,
  }),
]);

function updateRecords(progression, match, points) {
  const improved = [];
  const establishingBaseline = Object.keys(progression.records).length === 0;
  for (const definition of RECORD_DEFINITIONS) {
    const value = definition.value({ match, points });
    if (!Number.isFinite(value)) continue;
    const previousRecord = progression.records[definition.id];
    const previous = Number(previousRecord?.value);
    const better = !Number.isFinite(previous) || (definition.lowerIsBetter ? value < previous : value > previous);
    if (!better) continue;
    const record = {
      value,
      matchId: match.matchId,
      mapId: match.mapId,
      mode: match.mode,
      achievedAt: match.completedAt,
    };
    progression.records[definition.id] = record;
    if (!establishingBaseline) {
      improved.push({
        id: definition.id,
        label: definition.label,
        previous: Number.isFinite(previous) ? previous : null,
        ...record,
      });
    }
  }
  return improved;
}

function achievementSatisfied(id, progression, match, contractCompletedNow) {
  const lifetime = progression.lifetime;
  switch (id) {
    case 'first_match': return lifetime.matches >= 1;
    case 'first_win': return lifetime.wins >= 1;
    case 'first_headshot': return lifetime.headshots >= 1;
    case 'eliminator_10': return lifetime.kills >= 10;
    case 'veteran_10': return lifetime.matches >= 10;
    case 'headhunter_25': return lifetime.headshots >= 25;
    case 'win_streak_3': return progression.streaks.winsBest >= 3;
    case 'objective_10': return lifetime.plants + lifetime.defuses >= 10;
    case 'eliminator_100': return lifetime.kills >= 100;
    case 'map_master': return LEADERBOARD_MAPS.every((mapId) => progression.byMap[mapId]?.wins > 0);
    case 'flawless_match': return match.result === 'win' && match.kills >= 5 && match.deaths === 0;
    case 'daily_bot_ops': return contractCompletedNow;
    default: return false;
  }
}

function unlockAchievements(progression, match, contractCompletedNow, nowMs) {
  const unlocked = [];
  for (const definition of ACHIEVEMENT_CATALOG) {
    if (progression.achievements[definition.id]) continue;
    if (!achievementSatisfied(definition.id, progression, match, contractCompletedNow)) continue;
    const unlock = {
      unlockedAt: new Date(nowMs).toISOString(),
      matchId: match.matchId,
    };
    progression.achievements[definition.id] = unlock;
    unlocked.push({ ...definition, ...unlock });
  }
  return unlocked;
}

export function submitMatchToData(data, playerId, payload, nowMs) {
  data.matches ||= {};
  data.daily ||= {};
  const player = data.players[playerId];
  if (!player) throw new LeaderboardError(401, 'Leaderboard player not found.');
  ensureLeaderboardPlayerShape(player);
  const match = validateLeaderboardResult(payload, nowMs);
  const submissionKey = `${player.id}:${match.matchId}`;
  const existing = data.matches[submissionKey];
  if (existing) {
    const standing = playerStandingFromData(data, player.id);
    return {
      accepted: true,
      duplicate: true,
      result: existing.publicResult,
      rewards: existing.publicRewards || null,
      // Rewards describe that historical match, while career state must stay
      // current. An old stored snapshot would roll a retrying client backward.
      progression: progressionFromData(data, player.id, nowMs, standing),
      player,
      standing,
    };
  }

  const beforeStanding = playerStandingFromData(data, player.id);
  const beforeProgression = progressionFromData(data, player.id, nowMs, beforeStanding);
  const breakdown = {};
  const points = { humans: 0, bots: 0, overall: 0 };
  const creditedCategories = [];
  let contractBonusXp = 0;
  let contractCompletedNow = false;
  for (const category of ['humans', 'bots']) {
    const split = match.splits[category];
    if (split.share <= 0) continue;
    const score = scoreCategory(category, match, split);
    let multiplier = 1;
    let dailyCapAdjustment = 0;
    if (category === 'bots') {
      const key = `${player.id}:${leaderboardDayKey(nowMs)}`;
      const daily = data.daily[key] = ensureDailyShape(data.daily[key]);
      if (daily.botMatches >= BOT_DAILY_HALF_VALUE_MATCHES) multiplier = 0.25;
      else if (daily.botMatches >= BOT_DAILY_FULL_VALUE_MATCHES) multiplier = 0.5;
      const tapered = Math.round(score.raw * multiplier);
      const remaining = Math.max(0, BOT_DAILY_POINT_CAP - daily.botPoints);
      points.bots = Math.min(tapered, remaining);
      dailyCapAdjustment = tapered - points.bots;
      daily.botMatches++;
      daily.botPoints += points.bots;
      daily.contract.matches++;
      daily.contract.wins += match.result === 'win' ? 1 : 0;
      daily.contract.kills += split.kills;
      const targets = BOT_DAILY_CONTRACT.targets;
      if (!daily.contract.completed &&
          daily.contract.matches >= targets.matches &&
          daily.contract.wins >= targets.wins &&
          daily.contract.kills >= targets.kills) {
        daily.contract.completed = true;
        daily.contract.completedAt = new Date(nowMs).toISOString();
        daily.contract.bonusXpAwarded = BOT_DAILY_CONTRACT.rewardXp;
        contractBonusXp = BOT_DAILY_CONTRACT.rewardXp;
        contractCompletedNow = true;
      }
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

  const progression = ensureProgressionShape(player);
  applyTotals(progression.lifetime, match);
  const mapTotals = progression.byMap[match.mapId] = normalizedProgressTotals(progression.byMap[match.mapId]);
  const modeTotals = progression.byMode[match.mode] = normalizedProgressTotals(progression.byMode[match.mode]);
  applyTotals(mapTotals, match);
  applyTotals(modeTotals, match);
  updateStreaks(progression.streaks, match, leaderboardDayKey(nowMs));

  // Ranked score remains tapered and capped. Career level still advances at a
  // small, server-bounded pace after the bot score cap so another completed
  // training match never feels literally worthless.
  const completionXp = match.splits.bots.share > 0
    ? Math.max(0, BOT_MATCH_COMPLETION_XP - points.overall)
    : 0;
  const xpEarned = points.overall + completionXp + contractBonusXp;
  progression.xp += xpEarned;
  const newRecords = updateRecords(progression, match, points);
  const newAchievements = unlockAchievements(progression, match, contractCompletedNow, nowMs);

  player.updatedAt = new Date(nowMs).toISOString();
  player.lastPlayedAt = match.completedAt;
  const publicResult = {
    matchId: match.matchId,
    mode: match.mode,
    mapId: match.mapId,
    points,
    breakdown,
  };
  const standing = playerStandingFromData(data, player.id);
  const publicProgression = progressionFromData(data, player.id, nowMs, standing);
  const levelBefore = beforeProgression.level;
  const levelAfter = publicProgression.level;
  const publicRewards = {
    xpEarned,
    completionXp,
    contractBonusXp,
    scoreBefore: beforeStanding?.score || 0,
    scoreAfter: standing?.score || 0,
    rankBefore: beforeStanding?.overallRank ?? null,
    rankAfter: standing?.overallRank ?? null,
    rankChange: beforeStanding?.overallRank && standing?.overallRank
      ? beforeStanding.overallRank - standing.overallRank
      : null,
    levelBefore,
    levelAfter,
    leveledUp: levelAfter > levelBefore,
    tierBefore: { ...progressionTier(levelBefore) },
    tierAfter: { ...progressionTier(levelAfter) },
    newRecords,
    newAchievements,
  };
  data.matches[submissionKey] = {
    playerId: player.id,
    acceptedAt: new Date(nowMs).toISOString(),
    match,
    publicResult,
    publicRewards,
    publicProgression,
  };
  return {
    accepted: true,
    duplicate: false,
    result: publicResult,
    rewards: publicRewards,
    progression: publicProgression,
    player,
    standing,
  };
}

export function leaderboardFromData(data, category = 'overall', limit = 50, nowMs = Date.now()) {
  if (!LEADERBOARD_CATEGORIES.includes(category)) {
    throw new LeaderboardError(400, `category must be one of: ${LEADERBOARD_CATEGORIES.join(', ')}.`);
  }
  const safeLimit = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 50));
  const entries = Object.values(data.players)
    .map((player) => {
      ensureLeaderboardPlayerShape(player);
      const stats = player.stats[category];
      const level = levelFromXp(player.progression.xp);
      const winRate = stats.matches ? stats.wins / stats.matches : 0;
      const kd = stats.deaths ? stats.kills / stats.deaths : stats.kills;
      const headshotRate = stats.kills ? stats.headshots / stats.kills : 0;
      return {
        playerId: player.id,
        name: player.name,
        level,
        tier: { ...progressionTier(level) },
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
