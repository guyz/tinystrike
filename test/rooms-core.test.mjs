import assert from 'node:assert/strict';
import test from 'node:test';

import {
  acceptAuthoritySnapshot,
  applyAuthoritativeDamageResult,
  authoritySnapshotEnvelope,
  authorityLeaseExpired,
  nextJoinRound,
  playerResumeState,
  playerStateMatchesRoomRound,
  publicPlayerState,
  publicRoomSummary,
  reconcileRoundEconomy,
  releasePlayersForRound,
  resetPlayerForRound,
  transferRoomAuthority,
} from '../src/shared/rooms-core.mjs';

test('private economy and loadout state is targeted only to its owning player', () => {
  const player = {
    id: 'alpha', alive: true, characterId: 'ranger',
    state: {
      round: 2, pos: { x: 1, y: 2, z: 3 }, health: 90,
      money: 6_200, inventory: { currentId: 'ak47' }, roundReset: 'survived',
    },
  };
  assert.deepEqual(publicPlayerState(player.state), {
    round: 2, pos: { x: 1, y: 2, z: 3 }, health: 90,
  });
  assert.equal(playerResumeState(player).money, 6_200);
  const canonical = acceptAuthoritySnapshot({
    players: new Map([['alpha', player]]), hostId: 'alpha', authorityEpoch: 1, snapshotSeq: 0,
  }, { state: { round: 2, phase: 'live' }, bots: [] });
  assert.equal(canonical.snapshot.players[0].state.money, undefined);
  assert.equal(canonical.snapshot.players[0].state.inventory, undefined);
});

test('server economy and round reset keep a disconnected seat current without stale pose', () => {
  const ct = {
    id: 'ct', team: 'ct', alive: true, lossStreak: 2,
    state: { round: 3, money: 1_000, inventory: { currentId: 'ak47' }, pos: { x: 9, y: 1, z: 9 } },
  };
  const t = {
    id: 't', team: 't', alive: false,
    state: { round: 3, money: 2_000, hasKit: true, inventory: { currentId: 'awp' }, pos: { x: -4, y: 1, z: 5 } },
  };
  const room = { players: new Map([['ct', ct], ['t', t]]), lastEconomyRound: 2 };
  const result = { round: 3, phase: 'roundEnd', roundResult: { winner: 'ct', reason: 'elimination' } };
  assert.equal(reconcileRoundEconomy(room, result), true);
  assert.equal(ct.state.money, 4_250);
  assert.equal(t.state.money, 3_400);
  assert.equal(reconcileRoundEconomy(room, result), false, 'the same round reward is idempotent');

  const alreadyRewarded = {
    id: 'rewarded', team: 'ct', alive: true,
    state: { round: 4, money: 7_250, economyRound: 4 },
  };
  const nextRoom = { players: new Map([['rewarded', alreadyRewarded]]), lastEconomyRound: 3 };
  reconcileRoundEconomy(nextRoom, {
    round: 4, phase: 'roundEnd', roundResult: { winner: 'ct', reason: 'elimination' },
  });
  assert.equal(alreadyRewarded.state.money, 7_250, 'client-applied rewards are not added twice');

  resetPlayerForRound(t, 4);
  assert.equal(t.state.round, 4);
  assert.equal(t.state.roundReset, 'died');
  assert.equal(t.state.hasKit, false);
  assert.equal(t.state.money, 3_400);
  assert.equal('pos' in t.state, false);
});

test('authoritative damage persists through reconnect and cannot resurrect a dead seat', () => {
  const player = {
    alive: true,
    state: { pos: { x: 1, y: 0, z: 2 }, health: 100, armor: 50, alive: true },
  };
  applyAuthoritativeDamageResult(player, { health: 0, armor: 12, alive: false });
  assert.equal(player.alive, false);
  assert.deepEqual(player.state, {
    pos: { x: 1, y: 0, z: 2 }, health: 0, armor: 12, alive: false,
  });

  applyAuthoritativeDamageResult(player, { health: 80, armor: 12, alive: true });
  assert.equal(player.alive, false);
  assert.equal(player.state.alive, false);
  assert.equal(player.state.health, 0);

  const envelope = authoritySnapshotEnvelope({
    hostId: 'host',
    authorityEpoch: 2,
    snapshotSeq: 4,
    players: new Map([['local', { id: 'local', characterId: 'ranger', ...player }]]),
    lastSnapshot: {
      state: { round: 2, phase: 'live' },
      players: [{ id: 'local', state: { health: 100, armor: 50, alive: true } }],
    },
  });
  assert.deepEqual(envelope.snapshot.players[0].state, {
    pos: { x: 1, y: 0, z: 2 }, health: 0, armor: 12, alive: false, characterId: 'ranger',
  });
});

test('a fresh entrant to a started room always waits beyond the current round', () => {
  assert.equal(nextJoinRound({ started: true, lastSnapshot: null }), 2);
  assert.equal(nextJoinRound({
    started: true,
    lastSnapshot: { state: { round: 6, phase: 'planted' } },
  }), 7);
});

test('round release keeps entrants dead until the authoritative round advances', () => {
  const waiting = {
    id: 'late', connected: true, alive: false, joinRound: 4,
    state: { health: 0, armor: 42, alive: false },
  };
  const room = { players: new Map([['late', waiting]]) };
  assert.deepEqual(releasePlayersForRound(room, { round: 3, phase: 'roundEnd' }), []);
  assert.equal(waiting.alive, false);
  assert.equal(waiting.joinRound, 4);

  assert.deepEqual(releasePlayersForRound(room, { round: 4, phase: 'freeze' }), [waiting]);
  assert.equal(waiting.alive, true);
  assert.equal(waiting.joinRound, null);
  assert.deepEqual(waiting.state, {
    health: 100, armor: 42, alive: true, hasKit: false, round: 4, roundReset: 'died',
  });
});

test('modern player poses are fenced to the authoritative round', () => {
  const room = { currentRound: 5, lastSnapshot: { state: { round: 5, phase: 'freeze' } } };
  assert.equal(playerStateMatchesRoomRound(room, { round: 5 }, 1), true);
  assert.equal(playerStateMatchesRoomRound(room, { round: 4 }, 1), false);
  assert.equal(playerStateMatchesRoomRound(room, {}, 1), false);
  assert.equal(playerStateMatchesRoomRound(room, {}, 0), true, 'legacy peers remain position-compatible');
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

test('authority lease is renewed only by accepted snapshots and uses a startup grace', () => {
  const room = {
    started: true,
    hostId: 'host',
    startedAt: 1_000,
    authorityAssignedAt: 1_000,
    authorityEpoch: 2,
    snapshotSeq: 0,
    lastSnapshot: null,
    players: new Map(),
  };
  assert.equal(authorityLeaseExpired(room, 5_999), false);
  assert.equal(authorityLeaseExpired(room, 6_000), true);

  room.players.set('host', {
    id: 'host', alive: true, characterId: 'ranger', state: { pos: { x: 1 }, alive: false },
  });
  const envelope = acceptAuthoritySnapshot(room, {
    state: { phase: 'live', round: 1, timer: 75 },
    bots: [],
  }, 10_000);
  assert.equal(envelope.snapshotSeq, 1);
  assert.deepEqual(envelope.snapshot.players, [{
    id: 'host',
    state: { pos: { x: 1 }, alive: true, characterId: 'ranger' },
  }]);
  assert.equal(authorityLeaseExpired(room, 11_499), false);
  assert.equal(authorityLeaseExpired(room, 11_500), true);
});

test('authority handoff increments its fence and advances the shared wall clock', () => {
  const room = {
    started: true,
    hostId: 'host',
    authorityEpoch: 4,
    snapshotSeq: 8,
    authorityAssignedAt: 500,
    lastAuthoritySnapshotAt: 1_000,
    lastSnapshot: {
      state: { phase: 'planted', round: 3, timer: 20 },
      bots: [{ name: 'Bot' }],
      combat: {
        projectiles: [{ type: 'hegrenade', fuse: 2 }, { type: 'flashbang', fuse: 'invalid' }],
        smokes: [{ remaining: 4 }, { remaining: 0.5 }],
      },
    },
    players: {
      host: { id: 'host' },
      guest: { id: 'guest' },
    },
  };
  const change = transferRoomAuthority(room, 'guest', 2_250, 'stalled');
  assert.equal(change.hostId, 'guest');
  assert.equal(change.authorityEpoch, 5);
  assert.equal(change.snapshotSeq, 9);
  assert.equal(change.reason, 'stalled');
  assert.equal(change.snapshot.state.timer, 18.75);
  assert.deepEqual(change.snapshot.combat.projectiles.map((entry) => entry.fuse), [0.75, 0]);
  assert.deepEqual(change.snapshot.combat.smokes.map((entry) => entry.remaining), [2.75]);
  assert.equal(room.hostId, 'guest');
  assert.equal(room.lastAuthoritySnapshotAt, 2_250);
});
