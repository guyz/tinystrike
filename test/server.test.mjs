import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import {
  parseAllowedOrigins,
  resolveLeaderboardFilePath,
  rooms,
  server,
  startServer,
} from '../server.mjs';

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

function expectNoMessage(ws, type, waitMs = 80) {
  return new Promise((resolve, reject) => {
    const onMessage = (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== type) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      reject(new Error(`Unexpected ${type} message.`));
    };
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      resolve();
    }, waitMs);
    ws.on('message', onMessage);
  });
}

async function openClient(url) {
  const ws = new WebSocket(url);
  await once(ws, 'open');
  return ws;
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for server state.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('production origins and persistent data directories are normalized safely', () => {
  assert.deepEqual(
    [...parseAllowedOrigins('https://guyzyskind.com, http://localhost:9000/')],
    ['https://guyzyskind.com', 'http://localhost:9000']
  );
  assert.throws(() => parseAllowedOrigins('*'), /Invalid exact origin/);
  assert.equal(
    resolveLeaderboardFilePath({ TINY_STRIKE_DATA_DIR: '/var/lib/tiny-strike' }, '/srv/app'),
    '/var/lib/tiny-strike/leaderboard.json'
  );
  assert.equal(
    resolveLeaderboardFilePath({ TINY_STRIKE_LEADERBOARD_PATH: 'data/ranks.json' }, '/srv/app'),
    '/srv/app/data/ranks.json'
  );
});

test('two clients can create, join, start, and relay authoritative messages', async (t) => {
  startServer(0);
  await once(server, 'listening');
  const { port } = server.address();
  const url = `ws://127.0.0.1:${port}/ws`;
  const host = await openClient(url);
  const guest = await openClient(url);
  let late = null;
  let resumedHost = null;
  t.after(async () => {
    host.close();
    guest.close();
    if (late) late.close();
    if (resumedHost) resumedHost.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const hostWelcome = nextMessage(host, 'welcome');
  host.send(JSON.stringify({
    type: 'hello', action: 'create', room: 'TEST01', name: 'Alpha', characterId: '#ff00ff', mode: 'humans', mapId: 'frostline',
  }));
  const hostInfo = await hostWelcome;
  assert.equal(hostInfo.room, 'TEST01');
  assert.equal(hostInfo.mapId, 'frostline');

  const guestWelcome = nextMessage(guest, 'welcome');
  const hostLobby = nextMessage(host, 'lobby');
  guest.send(JSON.stringify({
    type: 'hello', action: 'join', room: 'TEST01', name: 'Bravo', characterId: 'ranger',
  }));
  const guestInfo = await guestWelcome;
  const lobby = await hostLobby;
  assert.equal(guestInfo.mapId, 'frostline');
  assert.equal(lobby.players.length, 2);
  assert.deepEqual(new Set(lobby.players.map((p) => p.team)), new Set(['ct', 't']));
  assert.deepEqual(new Set(lobby.players.map((p) => p.characterId)), new Set(['vanguard', 'ranger']));

  rooms.set('EMPTY1', { code: 'EMPTY1', players: new Map(), discoverable: true });
  const waitingRooms = await fetch(`http://127.0.0.1:${port}/api/rooms`).then((response) => response.json());
  assert.equal(rooms.has('EMPTY1'), false, 'empty rooms are pruned during discovery');
  assert.deepEqual(waitingRooms.rooms.map((entry) => entry.code), ['TEST01']);
  assert.deepEqual(waitingRooms.rooms[0], {
    code: 'TEST01',
    room: 'TEST01',
    mapId: 'frostline',
    mode: 'humans',
    started: false,
    phase: 'waiting',
    joinable: true,
    players: 2,
    maxPlayers: 10,
    reservedPlayers: 2,
    currentRound: null,
  });

  const hostMapLobby = nextMessage(host, 'lobby');
  const guestMapLobby = nextMessage(guest, 'lobby');
  host.send(JSON.stringify({ type: 'set_map', mapId: 'harbor' }));
  const mapLobbies = await Promise.all([hostMapLobby, guestMapLobby]);
  assert.ok(mapLobbies.every((message) => message.mapId === 'harbor'));

  const hostStart = nextMessage(host, 'match_start');
  const guestStart = nextMessage(guest, 'match_start');
  host.send(JSON.stringify({ type: 'start_match' }));
  const starts = await Promise.all([hostStart, guestStart]);
  assert.ok(starts.every((message) => message.mapId === 'harbor'));
  assert.equal(starts[0].matchId, starts[1].matchId);

  host.send(JSON.stringify({
    type: 'snapshot',
    snapshot: { state: { round: 3, phase: 'live', scores: { ct: 1, t: 1 } }, bots: [] },
  }));
  await waitFor(() => rooms.get('TEST01')?.currentRound === 3);

  late = await openClient(url);
  const lateWelcome = nextMessage(late, 'welcome');
  const lateResume = nextMessage(late, 'match_resume');
  late.send(JSON.stringify({
    type: 'hello', action: 'join', room: 'TEST01', name: 'Charlie', characterId: 'shadow',
  }));
  const lateInfo = await lateWelcome;
  const resume = await lateResume;
  assert.equal(lateInfo.lateJoin, true);
  assert.equal(lateInfo.waitingForRound, true);
  assert.equal(lateInfo.eligibleRound, 4);
  assert.equal(resume.snapshot.state.round, 3);
  assert.equal(resume.spectating, true);
  assert.equal(resume.players.find((entry) => entry.id === lateInfo.id).alive, false);
  assert.equal(
    rooms.get('TEST01').matchPlayers.some((entry) => entry.id === lateInfo.id),
    false,
    'an unreleased spectator is not enrolled for ranked match credit'
  );

  const activeRooms = await fetch(`http://127.0.0.1:${port}/api/rooms`).then((response) => response.json());
  assert.equal(activeRooms.rooms[0].started, true);
  assert.equal(activeRooms.rooms[0].phase, 'live');
  assert.equal(activeRooms.rooms[0].currentRound, 3);
  assert.equal(activeRooms.rooms[0].players, 3);
  assert.equal(activeRooms.rooms[0].joinable, true);
  assert.equal('hostId' in activeRooms.rooms[0], false);

  const blockedState = expectNoMessage(host, 'player_state');
  late.send(JSON.stringify({ type: 'player_state', state: { alive: true, pos: { x: 9, y: 9, z: 9 } } }));
  await blockedState;
  assert.equal(rooms.get('TEST01').players.get(lateInfo.id).alive, false);

  const blockedFire = expectNoMessage(host, 'fire');
  late.send(JSON.stringify({
    type: 'fire', weaponId: 'glock', origin: { x: 0, y: 1, z: 0 }, dir: { x: 0, y: 0, z: -1 },
  }));
  await blockedFire;

  const playerReady = nextMessage(late, 'player_ready');
  host.send(JSON.stringify({
    type: 'snapshot',
    snapshot: { state: { round: 4, phase: 'freeze', scores: { ct: 1, t: 1 } }, bots: [] },
  }));
  assert.deepEqual(await playerReady, { type: 'player_ready', id: lateInfo.id, round: 4 });
  assert.equal(rooms.get('TEST01').players.get(lateInfo.id).joinRound, null);
  assert.equal(rooms.get('TEST01').players.get(lateInfo.id).alive, true);
  assert.equal(rooms.get('TEST01').matchPlayers.some((entry) => entry.id === lateInfo.id), true);

  const releasedState = nextMessage(host, 'player_state');
  late.send(JSON.stringify({ type: 'player_state', state: { alive: true, pos: { x: 9, y: 2, z: 1 } } }));
  assert.equal((await releasedState).id, lateInfo.id);

  const relayedState = nextMessage(host, 'player_state');
  guest.send(JSON.stringify({
    type: 'player_state', state: { pos: { x: 1, y: 2, z: 3 }, alive: true, characterId: 'url(javascript:bad)' },
  }));
  const stateMessage = await relayedState;
  assert.equal(stateMessage.state.pos.x, 1);
  assert.equal(stateMessage.state.characterId, 'vanguard');

  const relayedShot = nextMessage(host, 'fire');
  guest.send(JSON.stringify({
    type: 'fire', weaponId: 'glock', origin: { x: 0, y: 1, z: 0 }, dir: { x: 0, y: 0, z: -1 },
  }));
  assert.equal((await relayedShot).shooterId, guestInfo.id);

  host.terminate();
  await waitFor(() => rooms.get('TEST01')?.players.get(hostInfo.id)?.connected === false);
  resumedHost = await openClient(url);
  const resumedWelcome = nextMessage(resumedHost, 'welcome');
  const resumedMatch = nextMessage(resumedHost, 'match_resume');
  resumedHost.send(JSON.stringify({
    type: 'hello',
    action: 'reconnect',
    room: 'TEST01',
    reconnectToken: hostInfo.reconnectToken,
  }));
  const resumedInfo = await resumedWelcome;
  assert.equal(resumedInfo.id, hostInfo.id);
  assert.equal(resumedInfo.resumed, true);
  assert.equal((await resumedMatch).matchId, starts[0].matchId);

  const resumedState = nextMessage(guest, 'player_state');
  resumedHost.send(JSON.stringify({
    type: 'player_state', state: { pos: { x: 4, y: 2, z: 1 }, alive: true },
  }));
  assert.equal((await resumedState).id, hostInfo.id);
});
