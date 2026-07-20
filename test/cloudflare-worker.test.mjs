import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  ensureLeaderboardPlayerShape,
  leaderboardFromData,
  newLeaderboardData,
  submitMatchToData,
} from '../src/shared/leaderboard-core.mjs';
import { validateLeaderboardImport } from '../worker/leaderboard-do.mjs';
import { allowedOrigins } from '../worker/index.mjs';
import { cleanRoomCode, roomPayload } from '../worker/room-do.mjs';

const NOW = Date.UTC(2026, 6, 20, 12, 0, 0);

function player(id = 'player-0001', name = 'Worker Ace') {
  return ensureLeaderboardPlayerShape({
    id,
    name,
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    lastPlayedAt: null,
    stats: {},
  });
}

function botResult(overrides = {}) {
  return {
    matchId: 'worker_match_001',
    mapId: 'harbor',
    mode: 'bots',
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

test('Worker scoring core preserves Node leaderboard points and idempotency', () => {
  const data = newLeaderboardData('season-1');
  data.players['player-0001'] = player();
  const accepted = submitMatchToData(data, 'player-0001', botResult(), NOW);
  assert.equal(accepted.result.points.bots, 187);
  assert.equal(accepted.result.points.overall, 187);
  assert.equal(accepted.result.breakdown.bots.farmingMultiplier, 1);
  assert.equal(accepted.standing.overallRank, 1);

  const duplicate = submitMatchToData(data, 'player-0001', botResult(), NOW);
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.result, accepted.result);
  assert.equal(leaderboardFromData(data, 'bots', 50, NOW).entries[0].matches, 1);
});

test('one-time import validator accepts the disk schema and rejects forged references', () => {
  const valid = newLeaderboardData('season-1');
  valid.players['player-0001'] = player();
  valid.sessions['a'.repeat(64)] = {
    playerId: 'player-0001',
    createdAt: new Date(NOW).toISOString(),
  };
  const normalized = validateLeaderboardImport(valid);
  assert.equal(normalized.players['player-0001'].name, 'Worker Ace');
  assert.equal(normalized.sessions['a'.repeat(64)].playerId, 'player-0001');

  const forged = structuredClone(valid);
  forged.sessions['b'.repeat(64)] = { playerId: 'missing-player' };
  assert.throws(() => validateLeaderboardImport(forged), /invalid session/i);
  assert.throws(
    () => validateLeaderboardImport({ ...valid, version: 999 }),
    /schema version 1/i,
  );
});

test('gateway and room projections enforce exact origins and hide durable credentials', () => {
  const origins = allowedOrigins(
    { ALLOWED_ORIGINS: 'https://guyzyskind.com' },
    'https://tiny-strike-service.example.workers.dev/health',
  );
  assert.equal(origins.has('https://guyzyskind.com'), true);
  assert.equal(origins.has('https://tiny-strike-service.example.workers.dev'), true);
  assert.equal(origins.has('https://attacker.example'), false);
  assert.throws(() => allowedOrigins({ ALLOWED_ORIGINS: '*' }), /Invalid exact allowed origin/);
  assert.equal(cleanRoomCode(' cs-01! '), 'CS01');

  const lobby = roomPayload({
    code: 'ROOM01',
    mode: 'mixed',
    mapId: 'citadel',
    started: false,
    hostId: 'host',
    players: {
      host: {
        id: 'host',
        name: 'Host',
        team: 'ct',
        alive: true,
        characterId: 'javascript:bad',
        reconnectToken: 'must-not-leak',
        leaderboardPlayerId: 'also-private',
      },
    },
  });
  assert.equal(lobby.players[0].characterId, 'vanguard');
  assert.equal('reconnectToken' in lobby.players[0], false);
  assert.equal('leaderboardPlayerId' in lobby.players[0], false);
});

test('Wrangler configuration declares only SQLite Durable Object exports', async () => {
  const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.vars.ALLOWED_ORIGINS, 'https://guyzyskind.com');
  assert.equal(config.exports.LeaderboardDurableObject.storage, 'sqlite');
  assert.equal(config.exports.RoomDurableObject.storage, 'sqlite');
  assert.equal('migrations' in config, false);
  assert.deepEqual(
    config.durable_objects.bindings.map((binding) => binding.name).sort(),
    ['LEADERBOARD', 'ROOMS'],
  );
});
