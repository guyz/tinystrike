import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import Player, { DEATH_SPECTATE_DELAY } from '../src/player/player.js';
import { CONFIG } from '../src/shared/config.js';
import { EventBus } from '../src/shared/events.js';

function makeGame() {
  const events = new EventBus();
  return {
    config: CONFIG,
    events,
    camera: new THREE.PerspectiveCamera(74, 16 / 9, 0.05, 250),
    state: { phase: 'live' },
    input: {
      consumeLook: () => ({ dx: 0, dy: 0 }),
      wasPressed: () => false,
    },
    bots: { all: [] },
    multiplayer: { active: false, remotePlayers: [] },
  };
}

test('lethal damage plays the local death camera before handing off to spectator', () => {
  const game = makeGame();
  const player = new Player(game);
  game.player = player;
  player.position.set(4, 2, 8);
  player.yaw = 0.35;
  player.pitch = 0.18;
  player.eyeHeight = CONFIG.PLAYER.EYE_STAND;

  player.takeDamage(200, {
    from: { name: 'Cobra', pos: new THREE.Vector3(4, 2, 3) },
    weapon: 'ak47',
  });

  assert.equal(player.alive, false);
  assert.equal(player.spectatorReady, false);
  assert.equal(player.deathElapsed, 0);
  assert.equal(player.deathTransitionDuration, DEATH_SPECTATE_DELAY);

  player.update(DEATH_SPECTATE_DELAY * 0.5);
  assert.equal(player.spectatorReady, false);
  assert.ok(game.camera.position.y < player.position.y + CONFIG.PLAYER.EYE_STAND);
  assert.ok(game.camera.position.y > player.position.y);
  assert.ok(game.camera.rotation.z > 0, 'the camera visibly rolls during the collapse');

  const deathCamera = game.camera.position.clone();
  game.bots.all.push({
    slot: 0,
    name: 'Sarge',
    team: player.team,
    alive: true,
    pos: new THREE.Vector3(12, 0, 6),
    yaw: 0,
    aimPitch: 0,
  });
  assert.equal(game.spectator.update(), false, 'spectator cannot overwrite the active death camera');
  assert.ok(game.camera.position.equals(deathCamera));

  player.update(DEATH_SPECTATE_DELAY * 0.5 + 0.01);
  assert.equal(player.spectatorReady, true);
  assert.equal(game.spectator.update(), true);
  assert.equal(game.spectator.current().name, 'Sarge');
  assert.notEqual(game.camera.position.x, deathCamera.x);

  player.resetForRound({ pos: new THREE.Vector3(0, 0, 0), yaw: 0 });
  assert.equal(player.alive, true);
  assert.equal(player.spectatorReady, false);
  assert.equal(player.deathElapsed, 0);
  assert.equal(game.spectator.current(), null);
});

test('network-authoritative deaths use the same paced transition', () => {
  const game = makeGame();
  const player = new Player(game);
  game.player = player;

  player.applyNetworkDamage(
    { health: 0, armor: 0, alive: false, amount: 100, weapon: 'awp' },
    { name: 'Ada', position: new THREE.Vector3(1, 0, 0) }
  );

  assert.equal(player.alive, false);
  assert.equal(player.spectatorReady, false);
  player.update(DEATH_SPECTATE_DELAY - 0.01);
  assert.equal(player.spectatorReady, false);
  player.update(0.02);
  assert.equal(player.spectatorReady, true);
});

test('death handoff uses wall time when rendering is heavily throttled', () => {
  const game = makeGame();
  const player = new Player(game);
  game.player = player;

  player.takeDamage(200, { weapon: 'ak47' });
  player._deathStartedAt -= DEATH_SPECTATE_DELAY + 0.05;
  player.update(0.01);

  assert.equal(player.spectatorReady, true);
  assert.equal(player.deathElapsed, DEATH_SPECTATE_DELAY);
  assert.equal(player._deathBlend, 1, 'camera fall catches up with the wall-clock transition');
});
