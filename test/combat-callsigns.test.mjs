import assert from 'node:assert/strict';
import test from 'node:test';

import Combat from '../src/combat/combat.js';
import Multiplayer from '../src/network/multiplayer.js';

test('combat kill events never publish a remote human placeholder callsign', () => {
  const emitted = [];
  const combat = Object.create(Combat.prototype);
  combat.game = {
    multiplayer: {
      active: true,
      localId: 'local-1',
      localName: 'SilentFalcon-521',
      isAuthority: () => true,
    },
    profile: { name: 'SilentFalcon-521' },
    player: { networkId: 'local-1', team: 'ct' },
    events: { emit(name, data) { emitted.push({ name, data }); } },
  };

  combat._onRemoteDeath({
    player: {
      networkId: 'remote-2',
      name: 'Operative2',
      team: 't',
    },
    killer: null,
    weapon: 'world',
  });

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].name, 'kill');
  assert.doesNotMatch(emitted[0].data.victimName, /^operative\s*\d*$/i);
  assert.equal(emitted[0].data.victimId, 'remote-2');
  assert.equal(combat._localPlayerName(), 'SilentFalcon-521');
});

test('combat preserves an explicitly chosen local Operative callsign', () => {
  const multiplayer = Object.assign(Object.create(Multiplayer.prototype), {
    active: true,
    localId: 'local-1',
    localName: 'Operative',
    _localPlaceholderExplicit: true,
  });
  const combat = Object.create(Combat.prototype);
  combat.game = {
    multiplayer,
    profile: { name: 'Operative', _nameCustomized: true },
    player: { networkId: 'local-1', team: 'ct' },
  };
  multiplayer.game = combat.game;

  assert.equal(combat._localPlayerName(), 'Operative');
});
