import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { LeaderboardError, LeaderboardStore } from '../src/server/leaderboard.mjs';
import { rooms, server, setLeaderboardStore, startServer } from '../server.mjs';

function nextMessage(ws, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 2000);
    const onMessage = (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== type) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(message);
    };
    ws.on('message', onMessage);
  });
}

test('leaderboard HTTP API creates identity, scores facts, deduplicates, and reads rankings', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tiny-strike-api-'));
  let tokenCounter = 0;
  const store = new LeaderboardStore({
    filePath: join(directory, 'leaderboard.json'),
    makeId: () => 'api-player',
    makeToken: () => `api-secret-${++tokenCounter}`,
  });
  setLeaderboardStore(store);
  startServer(0);
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  let socket = null;
  let duplicateSocket = null;
  let reconnectHostSocket = null;
  let reconnectGuestSocket = null;
  let resumedGuestSocket = null;
  t.after(async () => {
    if (socket) socket.terminate();
    if (duplicateSocket) duplicateSocket.terminate();
    if (reconnectHostSocket) reconnectHostSocket.terminate();
    if (reconnectGuestSocket) reconnectGuestSocket.terminate();
    if (resumedGuestSocket) resumedGuestSocket.terminate();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });

  const healthResponse = await fetch(`${origin}/health`);
  assert.equal(healthResponse.status, 200);
  assert.deepEqual(await healthResponse.json(), {
    ok: true,
    service: 'tiny-strike',
    leaderboard: 'ready',
  });

  const preflightResponse = await fetch(`${origin}/api/leaderboard/session`, {
    method: 'OPTIONS',
    headers: {
      origin: 'https://guyzyskind.com',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization, content-type',
    },
  });
  assert.equal(preflightResponse.status, 204);
  assert.equal(preflightResponse.headers.get('access-control-allow-origin'), 'https://guyzyskind.com');
  assert.match(preflightResponse.headers.get('access-control-allow-headers'), /Authorization/);

  const crossOriginBoard = await fetch(`${origin}/api/leaderboard`, {
    headers: { origin: 'https://guyzyskind.com' },
  });
  assert.equal(crossOriginBoard.status, 200);
  assert.equal(crossOriginBoard.headers.get('access-control-allow-origin'), 'https://guyzyskind.com');

  const rejectedOrigin = await fetch(`${origin}/api/leaderboard`, {
    headers: { origin: 'https://attacker.example' },
  });
  assert.equal(rejectedOrigin.status, 403);
  assert.equal(rejectedOrigin.headers.get('access-control-allow-origin'), null);

  const sessionResponse = await fetch(`${origin}/api/leaderboard/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerName: 'API Ace' }),
  });
  assert.equal(sessionResponse.status, 201);
  const session = await sessionResponse.json();
  assert.equal(session.player.name, 'API Ace');
  assert.equal(session.progression.level, 1);
  assert.equal(session.progression.lifetime.matches, 0);
  assert.equal(session.progression.dailyContract.id, 'daily_bot_ops');

  const payload = {
    matchId: 'api_match_001',
    playerName: 'Cannot Override Identity',
    mapId: 'harbor',
    mode: 'bots',
    winner: 'ct',
    teamWon: true,
    scores: { ct: 8, t: 6 },
    kills: 17,
    deaths: 9,
    headshots: 8,
    durationSeconds: 900,
    roundsPlayed: 14,
    completedAt: new Date().toISOString(),
  };
  const submit = () => fetch(`${origin}/api/leaderboard/matches`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${session.token}`,
    },
    body: JSON.stringify(payload),
  });
  const acceptedResponse = await submit();
  assert.equal(acceptedResponse.status, 201);
  const accepted = await acceptedResponse.json();
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.duplicate, false);
  assert.equal(accepted.player.name, 'API Ace');
  assert.ok(accepted.result.points.bots > 0);
  assert.equal(accepted.player.score, accepted.result.points.overall);
  assert.equal(accepted.player.overallRank, 1);
  assert.equal(accepted.progression.lifetime.matches, 1);
  assert.equal(accepted.rewards.xpEarned, accepted.result.points.overall);

  const meResponse = await fetch(`${origin}/api/leaderboard/me`, {
    headers: { authorization: `Bearer ${session.token}` },
  });
  assert.equal(meResponse.status, 200);
  const me = await meResponse.json();
  assert.equal(me.player.id, session.player.id);
  assert.equal(me.progression.xp, accepted.progression.xp);
  assert.equal(me.standing.overallRank, 1);

  const unauthorizedMe = await fetch(`${origin}/api/leaderboard/me`, {
    headers: { authorization: 'Bearer invalid-token' },
  });
  assert.equal(unauthorizedMe.status, 401);

  const retryResponse = await submit();
  assert.equal(retryResponse.status, 200);
  assert.equal((await retryResponse.json()).duplicate, true);

  const boardResponse = await fetch(`${origin}/api/leaderboard?category=bots&limit=50`);
  assert.equal(boardResponse.status, 200);
  const board = await boardResponse.json();
  assert.equal(board.entries[0].name, 'API Ace');
  assert.equal(board.entries[0].matches, 1);
  assert.ok(board.rules.scoring.humans.win > board.rules.scoring.bots.win);

  const unauthorized = await fetch(`${origin}/api/leaderboard/matches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, matchId: 'api_match_002' }),
  });
  assert.equal(unauthorized.status, 401);

  const rejectedSocket = new WebSocket(origin.replace('http:', 'ws:') + '/ws', {
    origin: 'https://attacker.example',
  });
  const rejectedUpgrade = await new Promise((resolve, reject) => {
    rejectedSocket.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
    rejectedSocket.once('error', reject);
  });
  assert.equal(rejectedUpgrade, 403);

  const ws = socket = new WebSocket(origin.replace('http:', 'ws:') + '/ws', {
    origin: 'https://guyzyskind.com',
  });
  await once(ws, 'open');
  const welcomePromise = nextMessage(ws, 'welcome');
  ws.send(JSON.stringify({
    type: 'hello',
    action: 'create',
    room: 'RANK01',
    name: 'Spoofed Name',
    mode: 'mixed',
    mapId: 'citadel',
    leaderboardToken: session.token,
    authorityProtocol: 1,
  }));
  const welcome = await welcomePromise;
  assert.equal(welcome.mapId, 'citadel');
  assert.equal(welcome.ranked, true);

  duplicateSocket = new WebSocket(origin.replace('http:', 'ws:') + '/ws', {
    origin: 'https://guyzyskind.com',
  });
  await once(duplicateSocket, 'open');
  const duplicateError = nextMessage(duplicateSocket, 'error');
  duplicateSocket.send(JSON.stringify({
    type: 'hello',
    action: 'join',
    room: 'RANK01',
    name: 'Second Tab',
    leaderboardToken: session.token,
    authorityProtocol: 1,
  }));
  const conflict = await duplicateError;
  assert.equal(conflict.code, 'ranked_identity_in_use');
  assert.match(conflict.message, /ranked identity is already playing/i);
  assert.equal(rooms.get('RANK01').players.size, 1);

  const changedLobby = nextMessage(ws, 'lobby');
  ws.send(JSON.stringify({ type: 'set_map', mapId: 'harbor' }));
  assert.equal((await changedLobby).mapId, 'harbor');
  const teamLobby = nextMessage(ws, 'lobby');
  ws.send(JSON.stringify({ type: 'set_team', team: 't' }));
  assert.equal((await teamLobby).players[0].team, 't');
  const matchStart = nextMessage(ws, 'match_start');
  ws.send(JSON.stringify({ type: 'start_match' }));
  const started = await matchStart;
  assert.equal(started.mapId, 'harbor');
  assert.match(started.matchId, /^[0-9a-f-]{36}$/);

  // Make this fast integration test represent an eligible two-minute match.
  rooms.get('RANK01').startedAt -= 120_000;
  ws.send(JSON.stringify({
    type: 'event',
    authorityEpoch: started.authorityEpoch,
    event: 'kill',
    data: {
      killerId: welcome.id,
      victimId: null,
      victimTeam: 'ct',
      headshot: true,
    },
  }));
  const persistentSubmit = store.submitMatchForPlayer.bind(store);
  let roomSubmitAttempts = 0;
  store.submitMatchForPlayer = (playerId, candidate) => {
    if (candidate?.matchId === started.matchId && roomSubmitAttempts++ === 0) {
      throw new Error('simulated transient leaderboard outage');
    }
    return persistentSubmit(playerId, candidate);
  };
  const roomReward = nextMessage(ws, 'leaderboard_result');
  ws.send(JSON.stringify({
    type: 'snapshot',
    authorityEpoch: started.authorityEpoch,
    snapshot: {
      state: {
        phase: 'planted',
        round: 1,
        scores: { ct: 0, t: 0 },
        bomb: { planted: true, carrierId: welcome.id },
      },
    },
  }));
  ws.send(JSON.stringify({
    type: 'snapshot',
    authorityEpoch: started.authorityEpoch,
    snapshot: {
      state: { phase: 'gameEnd', scores: { ct: 0, t: 8 }, matchWinner: 't' },
    },
  }));
  const roomRewardMessage = await roomReward;
  assert.equal(roomRewardMessage.playerId, welcome.id);
  assert.equal(roomRewardMessage.matchId, started.matchId);
  assert.equal(roomRewardMessage.response.accepted, true);
  assert.equal(roomRewardMessage.response.duplicate, false);
  assert.ok(roomRewardMessage.response.rewards.xpEarned > 0);
  assert.equal(roomSubmitAttempts, 2);
  assert.equal(rooms.get('RANK01').rankedFinalized, true);
  assert.equal(rooms.get('RANK01').rankedDeliveries[welcome.id].status, 'delivered');
  const rankedPlayer = store.leaderboard('bots').entries.find((entry) => entry.name === 'API Ace');
  assert.equal(rankedPlayer.matches, 2);
  assert.equal(rankedPlayer.kills, 18);
  assert.equal(rankedPlayer.plants, 1);
  assert.equal(store.leaderboard('humans').entries.length, 0);

  const failedSessionResponse = await fetch(`${origin}/api/leaderboard/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerName: 'Rejected Ace' }),
  });
  assert.equal(failedSessionResponse.status, 201);
  const failedSession = await failedSessionResponse.json();
  const failureWelcomePromise = nextMessage(duplicateSocket, 'welcome');
  duplicateSocket.send(JSON.stringify({
    type: 'hello',
    action: 'create',
    room: 'FAIL01',
    name: 'Rejected Ace',
    mode: 'mixed',
    mapId: 'harbor',
    leaderboardToken: failedSession.token,
    authorityProtocol: 1,
  }));
  const failureWelcome = await failureWelcomePromise;
  const failureStartPromise = nextMessage(duplicateSocket, 'match_start');
  duplicateSocket.send(JSON.stringify({ type: 'start_match' }));
  const failureStart = await failureStartPromise;
  rooms.get('FAIL01').startedAt -= 120_000;

  store.submitMatchForPlayer = (playerId, candidate) => {
    if (candidate?.matchId === failureStart.matchId) {
      throw new LeaderboardError(422, 'sensitive internal validation detail');
    }
    return persistentSubmit(playerId, candidate);
  };
  let failureFrames = 0;
  duplicateSocket.on('message', (raw) => {
    if (JSON.parse(raw.toString()).type === 'leaderboard_error') failureFrames++;
  });
  const rankedFailurePromise = nextMessage(duplicateSocket, 'leaderboard_error');
  const rejectedSnapshot = {
    type: 'snapshot',
    authorityEpoch: failureStart.authorityEpoch,
    snapshot: {
      state: { phase: 'gameEnd', scores: { ct: 8, t: 0 }, matchWinner: 'ct' },
    },
  };
  duplicateSocket.send(JSON.stringify(rejectedSnapshot));
  const rankedFailure = await rankedFailurePromise;
  assert.equal(rankedFailure.playerId, failureWelcome.id);
  assert.equal(rankedFailure.matchId, failureStart.matchId);
  assert.equal(rankedFailure.code, 'leaderboard_submission_failed');
  assert.match(rankedFailure.message, /career progress is safe/i);
  assert.doesNotMatch(rankedFailure.message, /sensitive internal/i);
  assert.equal(rooms.get('FAIL01').rankedFinalized, true);
  assert.equal(rooms.get('FAIL01').rankedDeliveries[failureWelcome.id].status, 'rejected');
  assert.equal(rooms.get('FAIL01').rankedDeliveries[failureWelcome.id].failureNotified, true);

  // A duplicate final snapshot must not emit the permanent failure twice.
  duplicateSocket.send(JSON.stringify(rejectedSnapshot));
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(failureFrames, 1);

  const reconnectSessionResponse = await fetch(`${origin}/api/leaderboard/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerName: 'Reconnect Ace' }),
  });
  const reconnectSession = await reconnectSessionResponse.json();
  reconnectHostSocket = new WebSocket(origin.replace('http:', 'ws:') + '/ws', {
    origin: 'https://guyzyskind.com',
  });
  reconnectGuestSocket = new WebSocket(origin.replace('http:', 'ws:') + '/ws', {
    origin: 'https://guyzyskind.com',
  });
  await Promise.all([once(reconnectHostSocket, 'open'), once(reconnectGuestSocket, 'open')]);
  const reconnectHostWelcomePromise = nextMessage(reconnectHostSocket, 'welcome');
  reconnectHostSocket.send(JSON.stringify({
    type: 'hello',
    action: 'create',
    room: 'LATER1',
    name: 'Unranked Host',
    mode: 'mixed',
    mapId: 'harbor',
    authorityProtocol: 1,
  }));
  await reconnectHostWelcomePromise;
  const reconnectGuestWelcomePromise = nextMessage(reconnectGuestSocket, 'welcome');
  reconnectGuestSocket.send(JSON.stringify({
    type: 'hello',
    action: 'join',
    room: 'LATER1',
    name: 'Reconnect Ace',
    leaderboardToken: reconnectSession.token,
    authorityProtocol: 1,
  }));
  const reconnectGuestWelcome = await reconnectGuestWelcomePromise;
  const reconnectMatchStartPromise = nextMessage(reconnectHostSocket, 'match_start');
  reconnectHostSocket.send(JSON.stringify({ type: 'start_match' }));
  const reconnectMatchStart = await reconnectMatchStartPromise;
  rooms.get('LATER1').startedAt -= 120_000;
  const guestClosed = once(reconnectGuestSocket, 'close');
  reconnectGuestSocket.terminate();
  await guestClosed;

  store.submitMatchForPlayer = (playerId, candidate) => {
    if (candidate?.matchId === reconnectMatchStart.matchId) {
      throw new LeaderboardError(422, 'another detail that must stay server-side');
    }
    return persistentSubmit(playerId, candidate);
  };
  reconnectHostSocket.send(JSON.stringify({
    type: 'snapshot',
    authorityEpoch: reconnectMatchStart.authorityEpoch,
    snapshot: {
      state: { phase: 'gameEnd', scores: { ct: 8, t: 0 }, matchWinner: 'ct' },
    },
  }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const queuedDelivery = rooms.get('LATER1').rankedDeliveries[reconnectGuestWelcome.id];
  assert.equal(queuedDelivery.status, 'rejected');
  assert.equal(queuedDelivery.failureNotified, false);

  resumedGuestSocket = new WebSocket(origin.replace('http:', 'ws:') + '/ws', {
    origin: 'https://guyzyskind.com',
  });
  await once(resumedGuestSocket, 'open');
  const reconnectFailurePromise = nextMessage(resumedGuestSocket, 'leaderboard_error');
  resumedGuestSocket.send(JSON.stringify({
    type: 'hello',
    action: 'reconnect',
    room: 'LATER1',
    reconnectToken: reconnectGuestWelcome.reconnectToken,
    authorityProtocol: 1,
  }));
  const reconnectFailure = await reconnectFailurePromise;
  assert.equal(reconnectFailure.playerId, reconnectGuestWelcome.id);
  assert.equal(reconnectFailure.matchId, reconnectMatchStart.matchId);
  assert.equal(reconnectFailure.code, 'leaderboard_submission_failed');
  assert.equal(rooms.get('LATER1').rankedDeliveries[reconnectGuestWelcome.id].failureNotified, true);
});
