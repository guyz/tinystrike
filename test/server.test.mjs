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
  let resumedHost = null;
  t.after(async () => {
    host.close();
    guest.close();
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
