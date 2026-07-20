import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fetchRoomDirectory,
  normalizeRoomDirectory,
  roomStatus,
} from '../src/network/room-directory.js';

test('room discovery normalizes, sorts, and labels lobby and live rooms', () => {
  const rooms = normalizeRoomDirectory({ rooms: [
    {
      code: 'LIVE03', mapId: 'harbor', mode: 'mixed', started: true,
      phase: 'live', players: 3, maxPlayers: 10, currentRound: 4,
    },
    {
      room: 'LOBBY2', map: 'citadel', mode: 'humans', phase: 'waiting',
      playerCount: 2, capacity: 10,
    },
    {
      code: 'FULL10', mapId: 'dustyard', phase: 'live', players: 10,
      maxPlayers: 10,
    },
  ] });

  assert.deepEqual(rooms.map((room) => room.code), ['LOBBY2', 'LIVE03', 'FULL10']);
  assert.deepEqual(roomStatus(rooms[0]), { label: 'LOBBY', detail: 'JOIN NOW' });
  assert.deepEqual(roomStatus(rooms[1]), { label: 'ROUND 4', detail: 'JOIN TO SPECTATE' });
  assert.deepEqual(roomStatus(rooms[2]), { label: 'FULL', detail: 'ROOM FULL' });
});

test('room discovery never exposes malformed room codes as join targets', () => {
  const rooms = normalizeRoomDirectory({ rooms: [null, {}, { code: ' ab-12! ', players: 1 }] });
  assert.equal(rooms.length, 1);
  assert.equal(rooms[0].code, 'AB12');
});

test('room discovery fetch does not send credentials', async () => {
  const calls = [];
  const result = await fetchRoomDirectory({
    endpoint: 'https://rooms.example.test/api/rooms',
    fetchImpl: async (...args) => {
      calls.push(args);
      return {
        ok: true,
        json: async () => [{ code: 'ROOM01', players: [{}, {}], capacity: 8 }],
      };
    },
  });
  assert.equal(result.rooms[0].players, 2);
  assert.equal(result.rooms[0].maxPlayers, 8);
  assert.equal(calls[0][1].credentials, 'omit');
  assert.equal(calls[0][1].cache, 'no-store');
});
