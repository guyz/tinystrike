import assert from 'node:assert/strict';
import test from 'node:test';

import {
  botCountsForRoster,
  botCountsForSnapshot,
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
