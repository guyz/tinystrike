import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SpectatorCamera,
  collectSpectatorCandidates,
  selectSpectatorCandidate,
  spectatorHoverHeight,
} from '../src/player/spectator.js';

const pos = (x, y, z) => ({ x, y, z });
const assertClose = (actual, expected, message) => {
  assert.ok(Math.abs(actual - expected) < 1e-9, message || `${actual} should be close to ${expected}`);
};

test('spectator candidates include only living teammates and prefer humans', () => {
  const local = { team: 'ct' };
  const remoteAlive = { networkId: 'p2', name: 'Ada', team: 'ct', alive: true, position: pos(1, 0, 2) };
  const remoteDead = { networkId: 'p3', name: 'Dead', team: 'ct', alive: false, position: pos(2, 0, 2) };
  const remoteEnemy = { networkId: 'p4', name: 'Enemy', team: 't', alive: true, position: pos(3, 0, 2) };
  const botAlive = { slot: 1, name: 'Ghost', team: 'ct', alive: true, pos: pos(4, 0, 2) };
  const botDead = { slot: 2, name: 'Rex', team: 'ct', alive: false, pos: pos(5, 0, 2) };
  const game = {
    multiplayer: { active: true, remotePlayers: [remoteDead, remoteEnemy, remoteAlive] },
    bots: { all: [botDead, botAlive] },
  };

  const candidates = collectSpectatorCandidates(game, local);
  assert.deepEqual(candidates.map(({ id, name, kind }) => ({ id, name, kind })), [
    { id: 'human:p2', name: 'Ada', kind: 'human' },
    { id: 'bot:ct:1', name: 'Ghost', kind: 'bot' },
  ]);

  game.multiplayer.remotePlayers = []; // disconnected actors disappear immediately
  assert.deepEqual(collectSpectatorCandidates(game, local).map((entry) => entry.id), ['bot:ct:1']);
});

test('spectator selection retains the target, cycles, wraps, and recovers from removal', () => {
  const candidates = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.equal(selectSpectatorCandidate(candidates, 'b').id, 'b');
  assert.equal(selectSpectatorCandidate(candidates, 'b', 1).id, 'c');
  assert.equal(selectSpectatorCandidate(candidates, 'c', 1).id, 'a');
  assert.equal(selectSpectatorCandidate(candidates, 'a', -1).id, 'c');
  assert.equal(selectSpectatorCandidate(candidates, 'gone').id, 'a');
  assert.equal(selectSpectatorCandidate([], 'a'), null);
});

test('spectator leaves the death camera untouched until the collapse finishes', () => {
  let lookFlushes = 0;
  const camera = {
    position: { x: 7, y: 0.7, z: -2, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
    rotation: { x: -0.4, y: 0.2, z: 0.3, order: 'YXZ' },
  };
  const local = { team: 'ct', alive: false, spectatorReady: false, spectatorTarget: null };
  const teammate = {
    slot: 0, name: 'Sarge', team: 'ct', alive: true,
    pos: pos(10, 1, 20), yaw: 0, aimPitch: 0.2,
  };
  const game = {
    state: { phase: 'live' },
    camera,
    config: { PLAYER: {}, BOT: {} },
    input: { wasPressed: () => false, consumeLook() { lookFlushes++; } },
    events: { emit() {} },
    bots: { all: [teammate] },
    multiplayer: { active: false, remotePlayers: [] },
  };
  const spectator = new SpectatorCamera(game, local);

  assert.equal(spectator.update(), false);
  assert.equal(spectator.current(), null);
  assert.deepEqual(
    { x: camera.position.x, y: camera.position.y, z: camera.position.z },
    { x: 7, y: 0.7, z: -2 }
  );
  assert.deepEqual(
    { x: camera.rotation.x, y: camera.rotation.y, z: camera.rotation.z },
    { x: -0.4, y: 0.2, z: 0.3 }
  );
  assert.equal(lookFlushes, 1);

  local.spectatorReady = true;
  assert.equal(spectator.update(), true);
  assert.equal(spectator.current().name, 'Sarge');
  assert.notEqual(camera.position.y, 0.7);
});

test('spectator camera follows above the bot, cycles on a press edge, and skips deaths', () => {
  const emitted = [];
  let pressed = false;
  const camera = {
    position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
    rotation: { x: 0, y: 0, z: 0, order: 'XYZ' },
  };
  const local = { team: 'ct', alive: false, spectatorTarget: null };
  const first = {
    slot: 0, name: 'Sarge', team: 'ct', alive: true,
    pos: pos(10, 1, 20), yaw: 0, aimPitch: 0.2, crouching: false, mesh: { visible: true },
  };
  const second = {
    slot: 1, name: 'Ghost', team: 'ct', alive: true,
    pos: pos(-4, 0, 7), yaw: Math.PI / 2, aimPitch: -0.1, crouching: true, mesh: { visible: true },
  };
  const game = {
    state: { phase: 'live' },
    camera,
    config: { PLAYER: { HEIGHT_STAND: 1.83 }, BOT: { HEIGHT: 1.83 } },
    input: {
      wasPressed: () => pressed,
      consumeLook: () => ({ dx: 0, dy: 0 }),
    },
    events: { emit: (type, payload) => emitted.push({ type, payload }) },
    bots: { all: [first, second] },
    multiplayer: { active: false, remotePlayers: [] },
  };
  const spectator = new SpectatorCamera(game, local);

  assert.equal(spectator.update(), true);
  assert.equal(spectator.current().name, 'Sarge');
  assert.equal(camera.rotation.order, 'YXZ');
  assert.equal(camera.rotation.x, 0.2);
  assertClose(spectatorHoverHeight(first, 'bot', game.config), 2.05);
  assertClose(camera.position.y, 3.05, 'standing camera clears the bot visual top');
  assert.ok(Math.abs(camera.position.z - 19.93) < 1e-9, 'small eye offset avoids pushing through walls');
  assert.equal(first.mesh.visible, true, 'overhead spectating keeps the observed body visible');
  assert.equal(second.mesh.visible, true);

  pressed = true;
  assert.equal(spectator.update(), true);
  pressed = false;
  assert.equal(spectator.current().name, 'Ghost');
  assert.ok(Math.abs(camera.position.x - (-4.07)) < 1e-9);
  assert.ok(Math.abs(spectatorHoverHeight(second, 'bot', game.config) - 1.684) < 1e-9);
  assert.ok(Math.abs(camera.position.y - 1.684) < 1e-9, 'crouched camera clears the lowered bot visual top');
  assert.equal(first.mesh.visible, true, 'cycling does not mutate the previous body');
  assert.equal(second.mesh.visible, true, 'cycling does not mutate the new body');

  second.alive = false;
  assert.equal(spectator.update(), true, 'dead current target is skipped immediately');
  assert.equal(spectator.current().name, 'Sarge');
  assert.equal(second.mesh.visible, true, 'dead target body remains available for its corpse pose');
  assert.equal(first.mesh.visible, true);

  first.alive = false;
  assert.equal(spectator.update(), false);
  assert.equal(spectator.current(), null);
  assert.equal(first.mesh.visible, true, 'last target body remains unchanged when nobody remains');

  local.alive = true;
  first.alive = true;
  assert.equal(spectator.update(), false, 'respawn returns camera ownership to local player');
  assert.equal(local.spectatorTarget, null);
  assert.ok(emitted.some((entry) => entry.type === 'spectator:target' && entry.payload.target === null));
});

test('spectator camera clears standing and crouched remote-human models', () => {
  let pressed = false;
  const camera = {
    position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
    rotation: { x: 0, y: 0, z: 0, order: 'XYZ' },
  };
  const local = { team: 'ct', alive: false, spectatorTarget: null };
  const standing = {
    networkId: 'p2', name: 'Ada', team: 'ct', alive: true,
    position: pos(2, 0.5, 4), yaw: 0, pitch: 0.1, crouching: false, mesh: { visible: true },
  };
  const crouched = {
    networkId: 'p3', name: 'Lin', team: 'ct', alive: true,
    position: pos(-3, 1, 6), yaw: Math.PI / 2, pitch: -0.2, crouching: true, mesh: { visible: true },
  };
  const config = { PLAYER: { HEIGHT_STAND: 1.83 }, BOT: { HEIGHT: 1.83 } };
  const game = {
    state: { phase: 'live' },
    camera,
    config,
    input: { wasPressed: () => pressed, consumeLook() {} },
    events: { emit() {} },
    bots: { all: [] },
    multiplayer: { active: true, remotePlayers: [standing, crouched] },
  };
  const spectator = new SpectatorCamera(game, local);

  assertClose(spectatorHoverHeight(standing, 'human', config), 2.25);
  assert.equal(spectator.update(), true);
  assert.equal(spectator.current().name, 'Ada');
  assertClose(camera.position.y, 2.75, 'standing camera clears the remote headgear');
  assert.equal(standing.mesh.visible, true);

  pressed = true;
  assert.equal(spectator.update(), true);
  pressed = false;
  assert.equal(spectator.current().name, 'Lin');
  assertClose(spectatorHoverHeight(crouched, 'human', config), 2);
  assertClose(camera.position.y, 3, 'crouched camera accounts for the remote render-root drop');
  assert.ok(Math.abs(camera.position.x - (-3.07)) < 1e-9);
  assert.equal(standing.mesh.visible, true);
  assert.equal(crouched.mesh.visible, true);
});

test('spectator leaves body visibility unchanged when the local player respawns', () => {
  const actor = {
    slot: 0, name: 'Falcon', team: 'ct', alive: true, pos: pos(0, 0, 0),
    yaw: 0, aimPitch: 0, crouching: false, mesh: { visible: true },
  };
  const local = { team: 'ct', alive: false, spectatorTarget: null };
  const game = {
    state: { phase: 'live' },
    camera: {
      position: { set() {} },
      rotation: { x: 0, y: 0, z: 0, order: 'YXZ' },
    },
    config: { PLAYER: {}, BOT: {} },
    input: { wasPressed: () => false, consumeLook() {} },
    events: { emit() {} },
    bots: { all: [actor] },
    multiplayer: { active: false, remotePlayers: [] },
  };
  const spectator = new SpectatorCamera(game, local);

  assert.equal(spectator.update(), true);
  assert.equal(actor.mesh.visible, true);
  local.alive = true;
  assert.equal(spectator.update(), false);
  assert.equal(actor.mesh.visible, true);
});
