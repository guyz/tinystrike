import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import Rounds from '../src/game/rounds.js';

test('a promoted replica preserves the authoritative match winner at round end', () => {
  const emitted = [];
  let authority = false;
  const game = {
    multiplayer: {
      active: true,
      isAuthority: () => authority,
    },
    state: {
      phase: 'live',
      round: 8,
      timer: 1,
      canBuy: false,
      scores: { ct: 7, t: 8 },
      bomb: {},
    },
    config: {
      MATCH: { ROUND_TIME: 90, DEFUSE_TIME: 10, PLANT_TIME: 3.2 },
    },
    player: { alive: true },
    events: { emit(name, data) { emitted.push({ name, data }); } },
  };
  const rounds = Object.assign(Object.create(Rounds.prototype), {
    game,
    _time: 0,
    _matchWinner: null,
    _lastRoundResult: null,
    _plantProgress: 0,
    _bombPos: new THREE.Vector3(),
    _bombInScene: false,
    _removeBombMesh() {},
    _applyRoundEconomy() {},
    _updateBombVisual() {},
    _updateCanBuy() {},
  });

  rounds.applyNetworkSnapshot({
    phase: 'roundEnd',
    round: 8,
    timer: 0,
    scores: { ct: 7, t: 8 },
    bomb: {},
    roundResult: { winner: 't', reason: 'elimination' },
    matchWinner: 't',
  });
  assert.equal(rounds._matchWinner, 't');

  authority = true;
  rounds.update(0.05);
  assert.equal(game.state.phase, 'gameEnd');
  assert.deepEqual(emitted.at(-1), {
    name: 'game:end',
    data: { winner: 't', scores: { ct: 7, t: 8 } },
  });
});
