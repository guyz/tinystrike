import assert from 'node:assert/strict';
import test from 'node:test';

import {
  nextJoinRound,
  publicRoomSummary,
  releasePlayersForRound,
} from '../src/shared/rooms-core.mjs';

test('a fresh entrant to a started room always waits beyond the current round', () => {
  assert.equal(nextJoinRound({ started: true, lastSnapshot: null }), 2);
  assert.equal(nextJoinRound({
    started: true,
    lastSnapshot: { state: { round: 6, phase: 'planted' } },
  }), 7);
});

test('round release keeps entrants dead until the authoritative round advances', () => {
  const waiting = { id: 'late', connected: true, alive: false, joinRound: 4 };
  const room = { players: new Map([['late', waiting]]) };
  assert.deepEqual(releasePlayersForRound(room, { round: 3, phase: 'roundEnd' }), []);
  assert.equal(waiting.alive, false);
  assert.equal(waiting.joinRound, 4);

  assert.deepEqual(releasePlayersForRound(room, { round: 4, phase: 'freeze' }), [waiting]);
  assert.equal(waiting.alive, true);
  assert.equal(waiting.joinRound, null);
});

test('room discovery exposes counts and join state without player identity data', () => {
  const room = {
    code: 'SAFE01',
    mode: 'mixed',
    mapId: 'harbor',
    started: true,
    currentRound: 2,
    lastSnapshot: { state: { round: 2, phase: 'live' } },
    players: {
      active: { id: 'secret-id', name: 'Secret Name', connected: true },
      reconnecting: { id: 'reserved-id', name: 'Reserved', connected: false },
    },
  };
  assert.deepEqual(publicRoomSummary(room), {
    code: 'SAFE01',
    room: 'SAFE01',
    mapId: 'harbor',
    mode: 'mixed',
    started: true,
    phase: 'live',
    joinable: true,
    players: 1,
    maxPlayers: 10,
    reservedPlayers: 2,
    currentRound: 2,
  });
});
