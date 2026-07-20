import assert from 'node:assert/strict';
import test from 'node:test';

import Multiplayer, {
  botCountsForRoster,
  botCountsForSnapshot,
  unrankedRetryHello,
} from '../src/network/multiplayer.js';

function human(id, team, joinRound = null) {
  return { id, team, joinRound };
}

test('mixed rooms fill each side to five while allowing ten humans', () => {
  assert.deepEqual(botCountsForRoster([
    human('a', 'ct'),
    human('b', 't'),
    human('c', 'ct'),
  ], 'mixed'), { ct: 3, t: 4 });

  assert.deepEqual(botCountsForRoster([
    human('a', 'ct'),
    human('b', 't'),
    human('c', 'ct'),
    human('d', 't'),
  ], 'mixed'), { ct: 3, t: 3 });

  const fullRoom = Array.from({ length: 10 }, (_, index) =>
    human(String(index), index < 5 ? 'ct' : 't')
  );
  assert.deepEqual(botCountsForRoster(fullRoom, 'mixed'), { ct: 0, t: 0 });
  assert.deepEqual(botCountsForRoster(fullRoom, 'humans'), { ct: 0, t: 0 });
});

test('a late human replaces a bot only on their eligible round', () => {
  const roster = [
    human('host', 'ct'),
    human('guest', 't'),
    human('late', 'ct', 4),
  ];
  assert.deepEqual(botCountsForRoster(roster, 'mixed', 3), { ct: 4, t: 4 });
  assert.deepEqual(botCountsForRoster(roster, 'mixed', 4), { ct: 3, t: 4 });
});

test('late spectators mirror the host snapshot bot roster for the current round', () => {
  assert.deepEqual(botCountsForSnapshot({
    bots: [
      { team: 'ct' }, { team: 'ct' }, { team: 'ct' }, { team: 'ct' },
      { team: 't' }, { team: 't' }, { team: 't' }, { team: 't' },
    ],
  }), { ct: 4, t: 4 });
});

test('a second window retries an occupied ranked identity as an unranked guest', () => {
  const hello = {
    type: 'hello',
    action: 'join',
    room: 'ROOM01',
    name: 'Second Window',
    leaderboardToken: 'shared-browser-token',
  };

  assert.deepEqual(unrankedRetryHello({
    type: 'error',
    code: 'ranked_identity_in_use',
    message: 'That ranked identity is already playing in this room.',
  }, hello), {
    ...hello,
    leaderboardToken: '',
  });

  assert.deepEqual(unrankedRetryHello({
    type: 'error',
    message: 'That ranked identity is already playing in this room. Reconnect the existing player instead.',
  }, hello), {
    ...hello,
    leaderboardToken: '',
  }, 'the deployed pre-code server remains compatible during rollout');

  assert.equal(unrankedRetryHello({ type: 'error', code: 'room_full' }, hello), null);
  assert.equal(unrankedRetryHello({
    type: 'error', code: 'ranked_identity_in_use',
  }, { ...hello, leaderboardToken: '' }), null, 'the fallback cannot retry forever');
});

test('joining does not rename the shared ranked profile before identity ownership is known', async () => {
  const updates = [];
  const leaderboardNames = [];
  let sentHello = null;
  const multiplayer = Object.assign(Object.create(Multiplayer.prototype), {
    game: {
      profile: {
        name: 'Primary Profile',
        characterId: 'ranger',
        update(value) { updates.push(value); },
      },
      leaderboard: {
        setPlayerName(value) { leaderboardNames.push(value); },
        async ensureSession() { return 'shared-browser-token'; },
      },
      selectedMapId: 'harbor',
    },
    socket: null,
    _connecting: false,
    _ui: {
      name: { value: 'Second Window' },
      room: { value: 'ROOM01' },
      mode: { value: 'mixed' },
    },
    _setConnecting() {},
    _status() {},
    _openSocket(hello) { sentHello = hello; },
  });

  await multiplayer.connect('join');

  assert.equal(updates.length, 0);
  assert.equal(leaderboardNames.length, 0);
  assert.equal(sentHello.name, 'Second Window');
  assert.equal(sentHello.leaderboardToken, 'shared-browser-token');
  assert.deepEqual(multiplayer._pendingProfile, {
    name: 'Second Window', characterId: 'ranger',
  });
});

test('only a non-conflicting room join commits its callsign to shared profile storage', () => {
  const updates = [];
  const multiplayer = Object.assign(Object.create(Multiplayer.prototype), {
    game: { profile: { update(value) { updates.push(value); } } },
    _pendingProfile: { name: 'Guest Tab', characterId: 'shadow' },
    _unrankedIdentityConflict: true,
  });

  multiplayer._commitPendingProfile();
  assert.deepEqual(updates, []);

  multiplayer._pendingProfile = { name: 'Primary Renamed', characterId: 'shadow' };
  multiplayer._unrankedIdentityConflict = false;
  multiplayer._commitPendingProfile();
  assert.deepEqual(updates, [{ name: 'Primary Renamed', characterId: 'shadow' }]);
});
