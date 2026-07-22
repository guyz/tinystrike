import test from 'node:test';
import assert from 'node:assert/strict';

import { EventBus } from '../src/shared/events.js';
import LeaderboardClient, {
  normalizeEntry,
  normalizeLeaderboardCategory,
  normalizePlayerName,
} from '../src/leaderboard/client.js';
import { MAP_CATALOG, normalizeMapId } from '../src/maps/catalog.js';

class MemoryStorage {
  constructor(initial = {}) { this.values = new Map(Object.entries(initial)); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function progression(overrides = {}) {
  return {
    playerId: 'p1',
    xp: 680,
    level: 2,
    tier: { id: 'recruit', name: 'Recruit', minLevel: 1 },
    xpIntoLevel: 180,
    xpForNextLevel: 650,
    nextLevelXp: 1_150,
    lifetime: { matches: 2, wins: 1, kills: 17, deaths: 8, headshots: 6 },
    byMap: {},
    byMode: {},
    records: {},
    streaks: { winsCurrent: 1, winsBest: 1, playDaysCurrent: 1, playDaysBest: 1 },
    achievements: [],
    achievementCount: 0,
    achievementTotal: 12,
    dailyContract: {
      id: 'daily_bot_ops',
      title: 'Daily Bot Ops',
      targets: { matches: 3, wins: 2, kills: 20 },
      progress: { matches: 1, wins: 1, kills: 10 },
      completed: false,
      rewardXp: 250,
    },
    standing: {
      id: 'p1',
      name: 'Alpha',
      score: 680,
      overallRank: 7,
      scores: { humans: 0, bots: 680, overall: 680 },
      ranks: { humans: null, bots: 4, overall: 7 },
    },
    ...overrides,
  };
}

test('map catalog exposes five stable, normalized battleground IDs', () => {
  assert.deepEqual(
    MAP_CATALOG.map((map) => map.id),
    ['dustyard', 'frostline', 'neon_foundry', 'harbor', 'citadel']
  );
  assert.equal(normalizeMapId('harbor'), 'harbor');
  assert.equal(normalizeMapId('unknown'), 'dustyard');
});

test('leaderboard client resumes identity, normalizes API rows, and submits tracked match stats', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes('/session')) {
      return jsonResponse(200, { player: { id: 'p1', name: 'Alpha' }, token: 'token-1', resumed: true });
    }
    if (options.method === 'POST') {
      return jsonResponse(201, {
        accepted: true,
        result: { points: { humans: 800, bots: 240, overall: 1040 } },
      });
    }
    return jsonResponse(200, {
      category: 'overall',
      generatedAt: '2026-07-20T10:00:00.000Z',
      rules: { summary: 'Wins and objectives lead the scoring.' },
      entries: [{ rank: 1, name: 'Alpha', score: 1040, matches: 1, wins: 1, winRate: 0.62, kills: 2, deaths: 1 }],
    });
  };
  const storage = new MemoryStorage({
    'tiny-strike-player-name': 'Alpha',
    'tiny-strike-leaderboard-token': 'old-token',
  });
  let now = 1_000;
  const player = { team: 'ct', networkId: 'me' };
  const game = {
    events: new EventBus(),
    player,
    selectedMapId: 'harbor',
    sessionMode: 'mixed',
    state: { round: 1, scores: { ct: 8, t: 5 } },
    multiplayer: {
      localId: 'me', localName: 'Alpha',
      roster: [{ id: 'me', team: 'ct' }, { id: 'enemy', team: 't' }],
    },
    bots: { all: [{ team: 't' }, { team: 't' }, { team: 'ct' }] },
  };
  const client = new LeaderboardClient(game, {
    fetchImpl, storage, now: () => now, autoSession: false,
  });

  game.events.emit('ui:start');
  game.events.emit('kill', { killerId: 'me', victimId: 'enemy', killerName: 'Alpha', victimName: 'Bravo', headshot: true });
  game.events.emit('kill', { killerId: 'me', victimId: null, killerName: 'Alpha', victimName: 'Bot' });
  game.events.emit('kill', { killerId: 'enemy', victimId: 'me', killerName: 'Bravo', victimName: 'Alpha' });
  game.events.emit('bomb:planted', { by: player });
  game.events.emit('bomb:defused', { by: 'player' });
  game.events.emit('round:end');
  now = 61_000;

  const payload = client.buildMatchPayload({ winner: 'ct', scores: { ct: 8, t: 5 } });
  assert.equal(payload.playerName, 'Alpha');
  assert.equal(payload.mapId, 'harbor');
  assert.equal(payload.teamWon, true);
  assert.equal(payload.kills, 2);
  assert.equal(payload.killsHumans, 1);
  assert.equal(payload.killsBots, 1);
  assert.equal(payload.deaths, 1);
  assert.equal(payload.headshots, 1);
  assert.equal(payload.plants, 1);
  assert.equal(payload.defuses, 1);
  assert.equal(payload.humanOpponents, 1);
  assert.equal(payload.botOpponents, 2);
  assert.equal(payload.duration, 60);

  const board = await client.list('overall', 50);
  assert.equal(board.entries[0].playerName, 'Alpha');
  assert.equal(board.entries[0].score, 1040);
  assert.equal(board.entries[0].winRate, 62);
  assert.equal(board.scoring.summary, 'Wins and objectives lead the scoring.');

  await client.submitMatch(payload);
  const matchCall = calls.find((call) => call.options.method === 'POST' && call.url.endsWith('/matches'));
  assert.equal(matchCall.options.headers.Authorization, 'Bearer old-token');
  assert.equal('sessionToken' in JSON.parse(matchCall.options.body), false);

  const postsBeforeServerMatch = calls.filter((call) => call.url.endsWith('/matches')).length;
  let serverRecorded = null;
  game.events.on('leaderboard:server-recorded', (event) => { serverRecorded = event; });
  game.multiplayer.active = true;
  game.multiplayer.matchId = 'authoritative-match';
  game.events.emit('game:end', { winner: 'ct', scores: { ct: 8, t: 5 } });
  await Promise.resolve();
  assert.equal(serverRecorded.matchId, 'authoritative-match');
  assert.equal(calls.filter((call) => call.url.endsWith('/matches')).length, postsBeforeServerMatch);

  let unranked = null;
  game.events.on('leaderboard:unranked', (event) => { unranked = event; });
  game.multiplayer._unrankedIdentityConflict = true;
  client._submitted = false;
  serverRecorded = null;
  game.events.emit('game:end', { winner: 'ct', scores: { ct: 8, t: 5 } });
  await Promise.resolve();
  assert.equal(unranked.matchId, 'authoritative-match');
  assert.equal(serverRecorded, null, 'an unranked guest must not wait for an authoritative reward');
  assert.equal(calls.filter((call) => call.url.endsWith('/matches')).length, postsBeforeServerMatch);
});

test('leaderboard names and categories are safely normalized', () => {
  assert.equal(normalizePlayerName('  <Ace>\n Player  '), 'Ace Player');
  assert.equal(normalizePlayerName(''), 'Operative');
  assert.equal(normalizeLeaderboardCategory('bots'), 'bots');
  assert.equal(normalizeLeaderboardCategory('weekly'), 'overall');
});

test('explicit actor identity prevents a same-named bot from corrupting career stats', () => {
  const client = new LeaderboardClient({
    events: new EventBus(),
    profile: { name: 'Sarge' },
    player: {},
  }, {
    autoSession: false,
    storage: new MemoryStorage(),
    fetchImpl: async () => { throw new Error('not used'); },
  });

  client._trackKill({
    killerName: 'Sarge', victimName: 'Bot', victimId: null,
    killerIsLocal: false, victimIsLocal: false,
  });
  client._trackKill({
    killerName: 'Bot', victimName: 'Sarge', victimId: null,
    killerIsLocal: false, victimIsLocal: false,
  });
  assert.equal(client._stats.kills, 0);
  assert.equal(client._stats.deaths, 0);

  client._trackKill({
    killerName: 'Sarge', victimName: 'Bot', victimId: null,
    killerIsLocal: true, victimIsLocal: false,
  });
  client._trackKill({
    killerName: 'Bot', victimName: 'Sarge', victimId: null,
    killerIsLocal: false, victimIsLocal: true,
  });
  assert.equal(client._stats.kills, 1);
  assert.equal(client._stats.deaths, 1);
});

test('an invalid stored progress key is preserved and never forks a fresh identity silently', async () => {
  const storedToken = 'ts_existing-private-progress-key';
  const storage = new MemoryStorage({
    'tiny-strike-player-name': 'Returning Ace',
    'tiny-strike-leaderboard-token': storedToken,
  });
  const events = new EventBus();
  const lost = [];
  events.on('leaderboard:identity-lost', (event) => lost.push(event));
  const calls = [];
  const client = new LeaderboardClient({ events }, {
    storage,
    autoSession: false,
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      return jsonResponse(401, { error: 'That progress key has expired.' });
    },
  });

  await assert.rejects(
    client.ensureSession({ refresh: true }),
    /progress key has expired/i,
  );

  assert.equal(storage.getItem('tiny-strike-leaderboard-token'), storedToken);
  assert.equal(client.getProgressCode(), storedToken);
  assert.equal(client.getIdentityStatus(), 'recovery-required');
  assert.deepEqual(lost, [{
    error: 'That progress key has expired.',
    hasProgressKey: true,
  }]);
  assert.equal(calls.length, 1, 'a rejected resume must not be followed by tokenless identity creation');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${storedToken}`);
  assert.equal('token' in JSON.parse(calls[0].options.body), false,
    'the private bearer belongs only in the Authorization header');
});

test('restoring a private progress key keeps the recovered server callsign', async () => {
  const storage = new MemoryStorage({
    'tiny-strike-player-name': 'RandomLocalName',
    'tiny-strike-leaderboard-token': 'ts_current-private-progress-key',
    'tiny-strike-pending-matches': JSON.stringify([{
      matchId: 'offline_recovered_001',
      kills: 4,
      _ownerPlayerId: 'p1',
    }]),
  });
  const profile = {
    name: 'RandomLocalName',
    setName(value) { this.name = value; },
  };
  const recovered = progression({ playerName: 'RecoveredAce' });
  recovered.standing = { ...recovered.standing, name: 'RecoveredAce' };
  const sessionBodies = [];
  const client = new LeaderboardClient({ events: new EventBus(), profile }, {
    storage,
    autoSession: false,
    fetchImpl: async (url, options = {}) => {
      if (url.endsWith('/session')) {
        sessionBodies.push(JSON.parse(options.body));
        return jsonResponse(200, {
          player: { id: 'p1', name: 'RecoveredAce' },
          token: 'ts_recovered-private-progress-key',
          resumed: true,
          progression: recovered,
        });
      }
      if (url.endsWith('/me')) return jsonResponse(200, { progression: recovered });
      if (url.endsWith('/matches')) return jsonResponse(201, {
        accepted: true,
        result: { matchId: 'offline_recovered_001', points: { overall: 30 } },
        progression: recovered,
        rewards: { xpEarned: 30, newAchievements: [], newRecords: [] },
      });
      throw new Error(`Unexpected request: ${url}`);
    },
  });

  await client.restoreProgressCode('ts_recovered-private-progress-key');
  assert.equal('playerName' in sessionBodies[0], false,
    'the random local profile must not rename a recovered career');
  assert.equal(profile.name, 'RecoveredAce');
  assert.equal(storage.getItem('tiny-strike-leaderboard-token'), 'ts_recovered-private-progress-key');
  assert.deepEqual(JSON.parse(storage.getItem('tiny-strike-pending-matches')), [],
    'offline results owned by the recovered career are flushed, not discarded');
});

test('foreground reconciliation validates identity before flushing and preserves its outbox on 401', async () => {
  const pending = [{
    matchId: 'offline_stale_identity_001',
    kills: 9,
    _ownerPlayerId: 'p1',
  }];
  const storage = new MemoryStorage({
    'tiny-strike-leaderboard-token': 'ts_stale-private-progress-key',
    'tiny-strike-career-cache-v1': JSON.stringify(progression()),
    'tiny-strike-pending-matches': JSON.stringify(pending),
  });
  const calls = [];
  const client = new LeaderboardClient({ events: new EventBus() }, {
    storage,
    autoSession: false,
    fetchImpl: async (url) => {
      calls.push(url);
      return jsonResponse(401, { error: 'Restore your private progress key.' });
    },
  });

  await assert.rejects(client.reconcileCareer(), /restore your private progress key/i);
  assert.deepEqual(calls, ['/api/leaderboard/session']);
  assert.deepEqual(JSON.parse(storage.getItem('tiny-strike-pending-matches')), pending);
  assert.equal(client.getIdentityStatus(), 'recovery-required');
});

test('a rejected match submission keeps its existing identity for later recovery', async () => {
  const storedToken = 'ts_existing-private-progress-key';
  const storage = new MemoryStorage({
    'tiny-strike-player-name': 'Returning Ace',
    'tiny-strike-leaderboard-token': storedToken,
  });
  const events = new EventBus();
  let identityLost = null;
  events.on('leaderboard:identity-lost', (event) => { identityLost = event; });
  const calls = [];
  const client = new LeaderboardClient({ events }, {
    storage,
    autoSession: false,
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      return jsonResponse(401, { error: 'Saved progress could not be verified.' });
    },
  });

  await assert.rejects(
    client.submitMatch({ matchId: 'offline_match_001' }),
    /could not be verified/i,
  );

  assert.equal(storage.getItem('tiny-strike-leaderboard-token'), storedToken);
  assert.equal(client.getIdentityStatus(), 'recovery-required');
  assert.deepEqual(identityLost, {
    error: 'Saved progress could not be verified.',
    hasProgressKey: true,
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/matches$/);
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${storedToken}`);
  assert.equal(calls.some((call) => call.url.endsWith('/session')), false);
});

test('career hydration is cached and confirmed match rewards celebrate once per match', async () => {
  const storage = new MemoryStorage({
    'tiny-strike-player-name': 'Alpha',
    'tiny-strike-leaderboard-token': 'ts_saved-progress-key',
  });
  const events = new EventBus();
  const observed = {
    updated: [], career: [], achievements: [], records: [], levels: [],
  };
  events.on('progress:updated', (event) => observed.updated.push(event));
  events.on('leaderboard:career', (event) => observed.career.push(event));
  events.on('progress:achievement', (event) => observed.achievements.push(event));
  events.on('progress:record', (event) => observed.records.push(event));
  events.on('progress:level-up', (event) => observed.levels.push(event));

  const hydrated = progression();
  const rewarded = progression({
    xp: 1_240,
    level: 3,
    xpIntoLevel: 90,
    xpForNextLevel: 800,
    nextLevelXp: 1_950,
    achievementCount: 1,
    achievements: [{ id: 'first_win', title: 'Mission Accomplished' }],
    standing: {
      ...hydrated.standing,
      score: 990,
      overallRank: 4,
      scores: { humans: 0, bots: 990, overall: 990 },
      ranks: { humans: null, bots: 2, overall: 4 },
    },
  });
  const rewardResponse = {
    accepted: true,
    duplicate: false,
    result: {
      matchId: 'reward_match_001',
      points: { humans: 0, bots: 310, overall: 310 },
    },
    progression: rewarded,
    rewards: {
      xpEarned: 560,
      levelBefore: 2,
      levelAfter: 3,
      tierBefore: { id: 'recruit', name: 'Recruit' },
      tierAfter: { id: 'bronze', name: 'Bronze' },
      newAchievements: [{ id: 'first_win', title: 'Mission Accomplished' }],
      newRecords: [{ id: 'kills', label: 'Most kills', value: 17, previous: 12 }],
    },
  };
  const calls = [];
  const client = new LeaderboardClient({ events }, {
    storage,
    autoSession: false,
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith('/me')) return jsonResponse(200, { progression: hydrated });
      if (url.endsWith('/matches')) return jsonResponse(201, rewardResponse);
      throw new Error(`Unexpected request: ${url}`);
    },
  });

  assert.deepEqual(await client.loadCareer(), hydrated);
  assert.equal(client.playerId, 'p1');
  assert.equal(observed.updated.at(-1).source, 'career');
  assert.deepEqual(observed.career.at(-1).progression, hydrated);
  assert.deepEqual(
    JSON.parse(storage.getItem('tiny-strike-career-cache-v1')),
    hydrated,
  );

  const payload = { matchId: 'reward_match_001' };
  await client.submitMatch(payload);
  await client.submitMatch(payload); // network retry / duplicate delivery
  events.emit('leaderboard:submitted', { payload, response: rewardResponse });

  assert.deepEqual(client.getProgression(), rewarded);
  assert.equal(observed.achievements.length, 1);
  assert.equal(observed.achievements[0].achievement.id, 'first_win');
  assert.equal(observed.records.length, 1);
  assert.equal(observed.records[0].record.id, 'kills');
  assert.equal(observed.levels.length, 1);
  assert.equal(observed.levels[0].rewards.levelAfter, 3);
  assert.equal(calls.filter((call) => call.url.endsWith('/matches')).length, 2);
  assert.equal(calls.some((call) => call.url.endsWith('/session')), false,
    'a stored key should authenticate career and match calls without creating a new session');
});

test('ordinary rewards within the same tier do not emit a false level-up celebration', async () => {
  const events = new EventBus();
  const levelUps = [];
  events.on('progress:level-up', (event) => levelUps.push(event));
  const client = new LeaderboardClient({ events }, {
    autoSession: false,
    storage: new MemoryStorage({ 'tiny-strike-leaderboard-token': 'ts_saved-progress-key' }),
    fetchImpl: async () => jsonResponse(201, {
      result: { matchId: 'same_tier_match_001', points: { overall: 120 } },
      progression: progression({ level: 2, xp: 720 }),
      rewards: {
        levelBefore: 2,
        levelAfter: 2,
        tierBefore: { id: 'recruit', name: 'Recruit' },
        tierAfter: { id: 'recruit', name: 'Recruit' },
        newAchievements: [],
        newRecords: [],
      },
    }),
  });

  await client.submitMatch({ matchId: 'same_tier_match_001' });
  assert.equal(levelUps.length, 0);
});

test('leaderboard normalization retains opaque player identity for reliable self highlighting', async () => {
  const normalized = normalizeEntry({
    id: 'player-self-17',
    name: 'Same Callsign',
    rank: 9,
    score: 450,
    matches: 3,
  });
  assert.equal(normalized.playerId, 'player-self-17');

  const client = new LeaderboardClient({ events: new EventBus() }, {
    autoSession: false,
    storage: new MemoryStorage(),
    fetchImpl: async () => jsonResponse(200, {
      entries: [
        { playerId: 'player-other', name: 'Same Callsign', rank: 8, score: 500 },
        { playerId: 'player-self-17', name: 'Same Callsign', rank: 9, score: 450 },
      ],
      self: { playerId: 'player-self-17', name: 'Same Callsign', rank: 9, score: 450 },
    }),
  });
  const board = await client.list('overall');
  assert.deepEqual(board.entries.map((entry) => entry.playerId), [
    'player-other', 'player-self-17',
  ]);
  assert.equal(board.self.playerId, 'player-self-17');
});
