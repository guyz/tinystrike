import test from 'node:test';
import assert from 'node:assert/strict';

import { EventBus } from '../src/shared/events.js';
import LeaderboardClient, {
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
  assert.equal(JSON.parse(matchCall.options.body).sessionToken, 'old-token');

  const postsBeforeServerMatch = calls.filter((call) => call.url.endsWith('/matches')).length;
  let serverRecorded = null;
  game.events.on('leaderboard:server-recorded', (event) => { serverRecorded = event; });
  game.multiplayer.active = true;
  game.multiplayer.matchId = 'authoritative-match';
  game.events.emit('game:end', { winner: 'ct', scores: { ct: 8, t: 5 } });
  await Promise.resolve();
  assert.equal(serverRecorded.matchId, 'authoritative-match');
  assert.equal(calls.filter((call) => call.url.endsWith('/matches')).length, postsBeforeServerMatch);
});

test('leaderboard names and categories are safely normalized', () => {
  assert.equal(normalizePlayerName('  <Ace>\n Player  '), 'Ace Player');
  assert.equal(normalizePlayerName(''), 'Operative');
  assert.equal(normalizeLeaderboardCategory('bots'), 'bots');
  assert.equal(normalizeLeaderboardCategory('weekly'), 'overall');
});
