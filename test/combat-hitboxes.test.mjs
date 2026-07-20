import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import Combat from '../src/combat/combat.js';
import Weapons from '../src/weapons/weapons.js';
import { WEAPONS } from '../src/weapons/data.js';
import { EventBus } from '../src/shared/events.js';

const CONFIG = {
  PLAYER: { RADIUS: 0.35, HEIGHT_STAND: 1.83, RUN_SPEED: 5.2, FOV: 74 },
  BOT: { RADIUS: 0.35, HEIGHT: 1.83 },
};

function combatWithBot(overrides = {}) {
  const events = new EventBus();
  const bot = {
    alive: true,
    team: 't',
    pos: new THREE.Vector3(0, 0, -10),
    radius: 0.35,
    height: 1.83,
    crouching: false,
    ...overrides,
  };
  const game = {
    events,
    config: CONFIG,
    player: null,
    bots: { all: [bot] },
    multiplayer: null,
  };
  return { combat: new Combat(game), bot };
}

function castAt(combat, x, y) {
  return combat._testCharacters(
    new THREE.Vector3(x, y, 0),
    new THREE.Vector3(0, 0, -1),
    100,
    null
  );
}

test('headshots use the visible head sphere instead of the body radius', () => {
  const { combat } = combatWithBot();

  assert.ok(castAt(combat, 0.16, 1.65) >= 0, 'visible helmet should be hittable');
  assert.equal(combat._hitPartBest, 'head');

  assert.equal(
    castAt(combat, 0.24, 1.65),
    -1,
    'air beside the helmet must not inherit the 0.35 m torso radius'
  );

  assert.ok(castAt(combat, 0.25, 1.25) >= 0, 'broad torso remains hittable');
  assert.equal(combat._hitPartBest, 'body');

  assert.ok(castAt(combat, 0.29, 1.46) >= 0, 'shoulder volume remains hittable');
  assert.equal(combat._hitPartBest, 'body');
});

test('crouched bot head hitbox follows the visible crouch pose', () => {
  const { combat } = combatWithBot({ crouching: true, height: 1.83 * 0.7 });

  assert.ok(castAt(combat, 0, 1.25) >= 0);
  assert.equal(combat._hitPartBest, 'head');
  assert.equal(combat._hitHeight, 1.83 * 0.78);
});

test('stationary scoped AWP fires through reticle despite prior recoil drift', () => {
  const events = new EventBus();
  let shot = null;
  events.on('weapon:fire', (payload) => { shot = payload; });

  const player = {
    alive: true,
    moveSpeed2D: 0,
    onGround: true,
    crouching: false,
    eyePos: () => new THREE.Vector3(0, 1.62, 0),
    addViewPunch() {},
  };
  const camera = {
    fov: 74,
    getWorldDirection(out) { return out.set(0, 0, -1); },
    updateProjectionMatrix() {},
  };
  const weapons = new Weapons({
    events,
    config: CONFIG,
    player,
    camera,
    state: { phase: 'live', buyOpen: false },
    input: { locked: true, firing: false },
  });
  weapons.currentId = 'awp';
  weapons.scopeLevel = 1;
  weapons._driftP = 0.08;
  weapons._driftY = -0.06;

  assert.equal(WEAPONS.awp.spreadBase, 0);
  weapons._fireShot(WEAPONS.awp, player, false);

  assert.ok(shot);
  assert.ok(Math.abs(shot.dir.x) < 1e-12);
  assert.ok(Math.abs(shot.dir.y) < 1e-12);
  assert.ok(Math.abs(shot.dir.z + 1) < 1e-12);
});

test('a demoted host retires its grenade and replicas cannot advance projectile physics', () => {
  const events = new EventBus();
  let authority = true;
  const game = {
    events,
    config: CONFIG,
    player: null,
    bots: { all: [] },
    multiplayer: {
      active: true,
      isAuthority() { return authority; },
    },
  };
  const combat = new Combat(game);
  const oldHostProjectile = {
    active: true,
    type: 'hegrenade',
    fuse: 0.01,
    pos: new THREE.Vector3(),
    vel: new THREE.Vector3(),
    spin: new THREE.Vector3(),
    resting: false,
    grounded: false,
    thrower: null,
    throwerTeam: 'ct',
    mesh: { visible: true },
  };
  combat._projectiles.push(oldHostProjectile);
  combat.smokes.push({ pos: new THREE.Vector3(), radius: 3, until: 10 });

  authority = false;
  assert.equal(combat.applyNetworkSnapshot({
    projectiles: [{
      type: 'hegrenade',
      pos: { x: 1, y: 2, z: 3 },
      vel: { x: 0, y: 0, z: 0 },
      fuse: 0.5,
    }],
    smokes: [],
  }), true);

  assert.equal(oldHostProjectile.active, false);
  assert.equal(oldHostProjectile.mesh.visible, false);
  assert.equal(combat.smokes.length, 0);

  // Even a projectile left active by an event racing with demotion must stay
  // inert until this replica is explicitly given authority again.
  oldHostProjectile.active = true;
  oldHostProjectile.fuse = 0.01;
  let detonations = 0;
  combat._detonateHE = () => { detonations++; };
  combat.update(0.5);

  assert.equal(oldHostProjectile.fuse, 0.01);
  assert.equal(detonations, 0);
});
