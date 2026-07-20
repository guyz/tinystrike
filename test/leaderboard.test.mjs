import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LeaderboardError,
  LeaderboardStore,
} from '../src/server/leaderboard.mjs';

const NOW = Date.UTC(2026, 6, 20, 12, 0, 0);

function result(overrides = {}) {
  return {
    matchId: 'match_0001',
    playerName: 'Ignored Client Name',
    mapId: 'dustyard',
    mode: 'humans',
    winner: 'ct',
    teamWon: true,
    scores: { ct: 8, t: 4 },
    kills: 14,
    deaths: 7,
    headshots: 5,
    duration: 720,
    roundsPlayed: 12,
    completedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'tiny-strike-leaderboard-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let id = 0;
  let token = 0;
  const store = new LeaderboardStore({
    filePath: join(directory, 'leaderboard.json'),
    now: () => NOW,
    makeId: () => `player-${++id}`,
    makeToken: () => `secret-token-${++token}`,
    ...options,
  });
  return { store, directory };
}

test('sessions persist, resume by opaque token, and never store the raw token', (t) => {
  const { store, directory } = fixture(t);
  const created = store.createSession({ playerName: '  Alpha<script>  ' });
  assert.equal(created.player.name, 'Alphascript');
  assert.equal(created.resumed, false);

  const disk = readFileSync(join(directory, 'leaderboard.json'), 'utf8');
  assert.equal(disk.includes(created.token), false);

  const reloaded = new LeaderboardStore({
    filePath: join(directory, 'leaderboard.json'),
    now: () => NOW,
  });
  assert.equal(reloaded.authenticate(created.token).id, created.player.id);
  const resumed = reloaded.createSession({ playerName: 'Alpha Prime', token: created.token });
  assert.deepEqual(resumed.player, { id: created.player.id, name: 'Alpha Prime' });
  assert.equal(resumed.resumed, true);
  assert.throws(
    () => reloaded.createSession({ playerName: 'Impostor', token: 'invalid-token' }),
    (error) => error instanceof LeaderboardError && error.status === 401
  );
});

test('the server calculates category points, mixed splits, and idempotent retries', (t) => {
  const { store, directory } = fixture(t);
  const human = store.createSession({ playerName: 'Human Ace' });
  const bot = store.createSession({ playerName: 'Bot Ace' });
  const mixed = store.createSession({ playerName: 'Hybrid Ace' });

  const humanResult = store.submitMatchForPlayer(human.player.id, result({ plants: 2, defuses: 1 }));
  const botResult = store.submitMatch(bot.token, result({
    // Match IDs are deduplicated per player, so every participant in a live
    // room may legitimately share the same server-issued match ID.
    matchId: 'match_0001', mode: 'solo', mapId: 'frostline',
  }));
  const mixedResult = store.submitMatchForPlayer(mixed.player.id, result({
    matchId: 'match_0003',
    mode: 'mixed',
    mapId: 'neon_foundry',
    killsHumans: 6,
    killsBots: 8,
    humanOpponents: 2,
    botOpponents: 3,
    plants: 1,
    defuses: 1,
  }));

  assert.ok(humanResult.result.points.humans > botResult.result.points.bots);
  assert.equal(botResult.duplicate, false);
  assert.equal(humanResult.result.points.bots, 0);
  assert.equal(botResult.result.points.humans, 0);
  assert.ok(mixedResult.result.points.humans > 0);
  assert.ok(mixedResult.result.points.bots > 0);
  assert.ok(humanResult.result.breakdown.humans.objectives > 0);
  assert.equal(
    mixedResult.result.points.overall,
    mixedResult.result.points.humans + mixedResult.result.points.bots
  );

  const duplicate = store.submitMatchForPlayer(mixed.player.id, result({
    matchId: 'match_0003',
    mode: 'mixed',
    mapId: 'neon_foundry',
    killsHumans: 6,
    killsBots: 8,
    humanOpponents: 2,
    botOpponents: 3,
    plants: 1,
    defuses: 1,
  }));
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.result, mixedResult.result);
  assert.equal(store.leaderboard('overall').entries.find((entry) => entry.name === 'Hybrid Ace').matches, 1);

  const reloaded = new LeaderboardStore({ filePath: join(directory, 'leaderboard.json'), now: () => NOW });
  assert.equal(reloaded.leaderboard('humans').entries.length, 2);
  assert.equal(reloaded.leaderboard('bots').entries.length, 2);
  assert.equal(reloaded.leaderboard('overall').entries.length, 3);
  const persistedHuman = reloaded.leaderboard('humans').entries.find((entry) => entry.name === 'Human Ace');
  assert.equal(persistedHuman.plants, 2);
  assert.equal(persistedHuman.defuses, 1);
});

test('bot farming tapers, reaches a daily ceiling, and resets on a later UTC day', (t) => {
  let clock = NOW;
  const { store } = fixture(t, { now: () => clock });
  const session = store.createSession({ playerName: 'Grinder' });
  const awards = [];
  for (let index = 0; index < 14; index++) {
    const submission = store.submitMatch(session.token, result({
      matchId: `botmatch_${String(index).padStart(3, '0')}`,
      mode: 'bots',
      kills: 10,
      headshots: 3,
    }));
    awards.push(submission.result.breakdown.bots);
  }
  assert.equal(awards[0].farmingMultiplier, 1);
  assert.equal(awards[5].farmingMultiplier, 0.5);
  assert.equal(awards[10].farmingMultiplier, 0.25);
  assert.ok(store.leaderboard('bots').entries[0].score <= store.rules().botDailyPointCap);

  clock += 24 * 60 * 60 * 1000;
  const nextDay = store.submitMatch(session.token, result({
    matchId: 'botmatch_next_day',
    mode: 'bots',
    completedAt: new Date(clock).toISOString(),
  }));
  assert.equal(nextDay.result.breakdown.bots.farmingMultiplier, 1);
  assert.ok(nextDay.result.points.bots > 0);
});

test('ranking ties are deterministic and ranking metadata explains scoring', (t) => {
  const { store } = fixture(t);
  const bravo = store.createSession({ playerName: 'Bravo' });
  const alpha = store.createSession({ playerName: 'Alpha' });
  store.submitMatchForPlayer(bravo.player.id, result({ matchId: 'bravo_0001' }));
  store.submitMatchForPlayer(alpha.player.id, result({ matchId: 'alpha_0001' }));

  const board = store.leaderboard('humans', 1);
  assert.equal(board.entries.length, 1);
  assert.equal(board.entries[0].name, 'Alpha');
  assert.equal(board.entries[0].rank, 1);
  assert.equal(board.rules.botDailyFullValueMatches, 5);
  assert.equal(board.rules.minDurationSeconds, 60);
  assert.match(board.rules.summary, /Human competition/i);
});

test('implausible or inconsistent results are rejected without changing standings', (t) => {
  const { store } = fixture(t);
  const session = store.createSession({ playerName: 'Validator' });
  const cases = [
    result({ matchId: 'invalid_hs', mode: 'bots', headshots: 15 }),
    result({ matchId: 'invalid_time', mode: 'bots', duration: 20 }),
    result({ matchId: 'invalid_rounds', mode: 'bots', roundsPlayed: 11 }),
    result({ matchId: 'invalid_map', mode: 'bots', mapId: 'not_a_map' }),
    result({ matchId: 'invalid_rate', mode: 'bots', kills: 60, headshots: 0, duration: 100 }),
    result({ matchId: 'invalid_objective', mode: 'bots', plants: 8, defuses: 8 }),
  ];
  for (const candidate of cases) {
    assert.throws(() => store.submitMatch(session.token, candidate), LeaderboardError);
  }
  assert.equal(store.leaderboard('overall').entries.length, 0);
  assert.throws(
    () => store.submitMatch('wrong-token', result()),
    (error) => error instanceof LeaderboardError && error.status === 401
  );
  assert.throws(
    () => store.submitMatch(session.token, result({ matchId: 'human_client', mode: 'humans' })),
    (error) => error instanceof LeaderboardError && error.status === 403
  );
});
