import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  ensureLeaderboardPlayerShape,
  leaderboardFromData,
  newLeaderboardData,
  submitMatchToData,
} from '../src/shared/leaderboard-core.mjs';
import { sanitizePlayerState } from '../src/shared/rooms-core.mjs';
import { validateLeaderboardImport } from '../worker/leaderboard-do.mjs';
import worker, { allowedOrigins } from '../worker/index.mjs';
import { cleanRoomCode, connectionAttachment, roomPayload } from '../worker/room-do.mjs';

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
