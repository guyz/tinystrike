import assert from 'node:assert/strict';
import test from 'node:test';

import Weapons from '../src/weapons/weapons.js';

test('weapon inventory snapshots round-trip through the bounded resume adapter', () => {
  const weapons = Object.create(Weapons.prototype);
  weapons.slots = { 1: 'ak47', 2: 'usp', 3: 'knife', 4: ['flashbang'] };
  weapons.ammo = {
    ak47: { mag: 19, reserve: 71 },
    usp: { mag: 8, reserve: 44 },
    flashbang: { mag: 1, reserve: 0 },
  };
  weapons.currentId = 'ak47';
  const snapshot = weapons.networkSnapshot();

  const restored = Object.create(Weapons.prototype);
  restored.slots = { 1: null, 2: 'glock', 3: 'knife', 4: [] };
  restored.ammo = {};
  restored.currentId = 'glock';
  restored._cancelActivity = () => {};
  restored._forceEquip = (id) => { restored.currentId = id; };

  assert.equal(restored.applyNetworkSnapshot(snapshot), true);
  assert.deepEqual(restored.slots, weapons.slots);
  assert.deepEqual(restored.ammo, weapons.ammo);
  assert.equal(restored.currentId, 'ak47');
});

test('resume inventory rejects invalid slots and clamps impossible ammo', () => {
  const weapons = Object.create(Weapons.prototype);
  weapons.slots = { 1: null, 2: null, 3: 'knife', 4: [] };
  weapons.ammo = {};
  weapons.currentId = 'knife';
  weapons._cancelActivity = () => {};
  weapons._forceEquip = (id) => { weapons.currentId = id; };

  assert.equal(weapons.applyNetworkSnapshot({
    slots: { 1: 'usp', 2: 'ak47', 3: 'awp', 4: ['ak47', 'flashbang'] },
    ammo: { flashbang: { mag: 99, reserve: 99 } },
    currentId: 'awp',
  }), true);
  assert.deepEqual(weapons.slots, { 1: null, 2: null, 3: 'knife', 4: ['flashbang'] });
  assert.deepEqual(weapons.ammo.flashbang, { mag: 2, reserve: 0 });
  assert.equal(weapons.currentId, 'knife');
});
