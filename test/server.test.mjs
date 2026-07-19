import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { server, startServer } from '../server.mjs';

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

test('two clients can create, join, start, and relay authoritative messages', async (t) => {
  startServer(0);
  await once(server, 'listening');
  const { port } = server.address();
  const url = `ws://127.0.0.1:${port}/ws`;
  const host = await openClient(url);
  const guest = await openClient(url);
  t.after(async () => {
    host.close();
    guest.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const hostWelcome = nextMessage(host, 'welcome');
  host.send(JSON.stringify({
    type: 'hello', action: 'create', room: 'TEST01', name: 'Alpha', mode: 'humans',
  }));
  const hostInfo = await hostWelcome;
  assert.equal(hostInfo.room, 'TEST01');

  const guestWelcome = nextMessage(guest, 'welcome');
  const hostLobby = nextMessage(host, 'lobby');
  guest.send(JSON.stringify({
    type: 'hello', action: 'join', room: 'TEST01', name: 'Bravo',
  }));
  const guestInfo = await guestWelcome;
  const lobby = await hostLobby;
  assert.equal(lobby.players.length, 2);
  assert.deepEqual(new Set(lobby.players.map((p) => p.team)), new Set(['ct', 't']));

  const hostStart = nextMessage(host, 'match_start');
  const guestStart = nextMessage(guest, 'match_start');
  host.send(JSON.stringify({ type: 'start_match' }));
  await Promise.all([hostStart, guestStart]);

  const relayedState = nextMessage(host, 'player_state');
  guest.send(JSON.stringify({
    type: 'player_state', state: { pos: { x: 1, y: 2, z: 3 }, alive: true },
  }));
  assert.equal((await relayedState).state.pos.x, 1);

  const relayedShot = nextMessage(host, 'fire');
  guest.send(JSON.stringify({
    type: 'fire', weaponId: 'glock', origin: { x: 0, y: 1, z: 0 }, dir: { x: 0, y: 0, z: -1 },
  }));
  assert.equal((await relayedShot).shooterId, guestInfo.id);
});
