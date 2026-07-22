import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  ensureLeaderboardPlayerShape,
  leaderboardFromData,
  newLeaderboardData,
  progressionFromData,
  submitMatchToData,
} from '../src/shared/leaderboard-core.mjs';
import { sanitizePlayerState } from '../src/shared/rooms-core.mjs';
import { LeaderboardDurableObject, validateLeaderboardImport } from '../worker/leaderboard-do.mjs';
import worker, { allowedOrigins } from '../worker/index.mjs';
import { RoomDurableObject, cleanRoomCode, connectionAttachment, roomPayload } from '../worker/room-do.mjs';

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
  assert.deepEqual(duplicate.rewards, accepted.rewards);
  assert.deepEqual(duplicate.progression, accepted.progression);
  assert.equal(leaderboardFromData(data, 'bots', 50, NOW).entries[0].matches, 1);
});

test('daily bot contracts use acceptance day, grant once, reset at UTC midnight, and keep only a small post-cap XP floor', () => {
  const data = newLeaderboardData('season-1');
  data.players['player-0001'] = player();
  const submissions = [];
  for (let index = 0; index < 14; index++) {
    submissions.push(submitMatchToData(data, 'player-0001', botResult({
      matchId: `contract_${String(index).padStart(3, '0')}`,
      kills: 10,
      deaths: 2,
      headshots: 3,
    }), NOW + index));
  }
  assert.equal(submissions[2].progression.dailyContract.completed, true);
  assert.equal(submissions[2].rewards.contractBonusXp, 250);
  assert.equal(submissions[3].rewards.contractBonusXp, 0);
  assert.equal(submissions.at(-1).result.points.bots, 0);
  assert.equal(submissions.at(-1).rewards.xpEarned, 30);
  assert.equal(submissions.at(-1).rewards.completionXp, 30);

  const nextDay = NOW + 86_400_000;
  const backdated = submitMatchToData(data, 'player-0001', botResult({
    matchId: 'contract_next_day',
    kills: 10,
    deaths: 2,
    headshots: 3,
    completedAt: new Date(NOW).toISOString(),
  }), nextDay);
  assert.equal(backdated.progression.dailyContract.day, '2026-07-21');
  assert.equal(backdated.progression.dailyContract.progress.matches, 1);
  assert.equal(backdated.progression.dailyContract.completed, false);
});

test('legacy imports receive deterministic additive progression defaults', () => {
  const legacy = newLeaderboardData('season-1');
  legacy.players['player-0001'] = {
    id: 'player-0001',
    name: 'Legacy Worker',
    stats: {
      overall: { score: 640, matches: 3, wins: 2, kills: 18, deaths: 7 },
      humans: {},
      bots: {},
    },
  };
  const normalized = validateLeaderboardImport(legacy);
  const first = progressionFromData(normalized, 'player-0001', NOW);
  const second = progressionFromData(normalized, 'player-0001', NOW);
  assert.equal(first.xp, 640);
  assert.equal(first.lifetime.kills, 18);
  assert.deepEqual(second, first);
});

test('Worker career reads load one player and derive standing from the ranking projection', () => {
  const currentPlayer = player();
  currentPlayer.stats.overall = {
    ...currentPlayer.stats.overall,
    score: 500,
    matches: 3,
    wins: 2,
    kills: 18,
    deaths: 7,
  };
  currentPlayer.progression.xp = 500;
  const statements = [];
  const durable = Object.create(LeaderboardDurableObject.prototype);
  durable._metadata = () => 'season-1';
  durable.sql = {
    exec(statement) {
      const sql = String(statement);
      statements.push(sql);
      if (/SELECT data FROM players WHERE id/.test(sql)) {
        return { toArray: () => [{ data: JSON.stringify(currentPlayer) }] };
      }
      if (/SELECT data FROM daily/.test(sql)) return { toArray: () => [] };
      if (/SELECT COUNT\(\*\) AS count[\s\S]*FROM rankings/.test(sql)) {
        return { toArray: () => [{ count: 0 }] };
      }
      if (/SELECT player_id, name[\s\S]*FROM rankings/.test(sql)) {
        return { toArray: () => [{ player_id: currentPlayer.id, name: currentPlayer.name }] };
      }
      throw new Error(`Unexpected SQL in test: ${sql}`);
    },
  };

  const career = durable._progression(currentPlayer.id, NOW);
  assert.equal(career.playerId, currentPlayer.id);
  assert.equal(career.standing.overallRank, 1);
  assert.equal(career.standing.score, 500);
  assert.equal(
    statements.some((sql) => /SELECT id, data FROM players/.test(sql)),
    false,
    'ordinary progression reads must not scan every player JSON record',
  );
  assert.ok(statements.some((sql) => /FROM rankings/.test(sql)));
});

test('Worker permanent ranking failures expose one safe targeted frame', () => {
  const frames = [];
  const roomObject = Object.create(RoomDurableObject.prototype);
  roomObject.connections = new Map([['player-1', {
    readyState: 1,
    send(payload) {
      frames.push(JSON.parse(payload));
    },
  }]]);
  const room = {
    matchId: 'worker-match-1',
    players: { 'player-1': { id: 'player-1', connected: true } },
  };
  const delivery = { status: 'rejected', failureNotified: false, lastError: 'private backend detail' };
  delivery.failureNotified = roomObject._sendRankedFailure(room, { id: 'player-1' }, delivery);
  delivery.failureNotified = roomObject._sendRankedFailure(room, { id: 'player-1' }, delivery);

  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], {
    type: 'leaderboard_error',
    playerId: 'player-1',
    matchId: 'worker-match-1',
    code: 'leaderboard_submission_failed',
    message: 'Match rewards could not be recorded. Your existing career progress is safe.',
  });
  assert.doesNotMatch(frames[0].message, /private backend/i);
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

test('room player state and hibernation attachments remain bounded by protocol fields', () => {
  const oversizedJunk = 'x'.repeat(20_000);
  const state = sanitizePlayerState({
    pos: { x: 1, y: 2, z: 3 },
    yaw: 0.5,
    pitch: -0.25,
    health: 91,
    armor: 47,
    hasKit: true,
    alive: true,
    crouching: false,
    walking: true,
    moveSpeed2D: 2.4,
    onGround: true,
    useDown: false,
    weaponId: 'ak47',
    characterId: 'ranger',
    money: 99_999,
    inventory: {
      slots: { 1: 'ak47', 2: 'usp', 3: 'knife', 4: ['flashbang'] },
      ammo: { ak47: { mag: 27.9, reserve: 82.4 } },
      currentId: 'ak47',
      junk: oversizedJunk,
    },
    junk: oversizedJunk,
  });
  assert.deepEqual(state, {
    pos: { x: 1, y: 2, z: 3 },
    yaw: 0.5,
    pitch: -0.25,
    health: 91,
    armor: 47,
    moveSpeed2D: 2.4,
    hasKit: true,
    alive: true,
    crouching: false,
    walking: true,
    onGround: true,
    useDown: false,
    weaponId: 'ak47',
    characterId: 'ranger',
    money: 16_000,
    inventory: {
      slots: { 1: 'ak47', 2: 'usp', 3: 'knife', 4: ['flashbang'] },
      ammo: { ak47: { mag: 27, reserve: 82 } },
      currentId: 'ak47',
    },
  });
  assert.equal('junk' in state, false);

  const attachment = connectionAttachment({
    id: 'player-1',
    name: 'Operative',
    reconnectToken: 'secret',
    state: { ...state, junk: oversizedJunk },
  });
  assert.equal('state' in attachment, false);
  assert.ok(Buffer.byteLength(JSON.stringify(attachment)) < 16_384);
});

test('Wrangler configuration declares only SQLite Durable Object exports', async () => {
  const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.vars.ALLOWED_ORIGINS, 'https://guyzyskind.com');
  assert.equal(config.vars.RECONNECT_GRACE_MS, '120000');
  assert.equal(config.exports.LeaderboardDurableObject.storage, 'sqlite');
  assert.equal(config.exports.RoomDurableObject.storage, 'sqlite');
  assert.equal('migrations' in config, false);
  assert.deepEqual(
    config.durable_objects.bindings.map((binding) => binding.name).sort(),
    ['LEADERBOARD', 'ROOMS'],
  );
});

test('Worker gateway publishes the Durable Object room directory with CORS', async () => {
  let forwardedUrl = '';
  const env = {
    ALLOWED_ORIGINS: 'https://guyzyskind.com',
    ROOMS: {
      getByName() {
        return {
          async fetch(input) {
            forwardedUrl = String(input);
            return new Response(JSON.stringify({ rooms: [{ code: 'OPEN01', players: 3 }] }), {
              headers: { 'Content-Type': 'application/json' },
            });
          },
        };
      },
    },
  };
  const response = await worker.fetch(new Request(
    'https://tiny-strike-service.example.workers.dev/api/rooms',
    { headers: { Origin: 'https://guyzyskind.com' } },
  ), env);
  assert.equal(response.status, 200);
  assert.equal(forwardedUrl, 'https://internal/internal/rooms');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://guyzyskind.com');
  assert.deepEqual(await response.json(), { rooms: [{ code: 'OPEN01', players: 3 }] });
});
