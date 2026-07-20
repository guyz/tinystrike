import test from 'node:test';
import assert from 'node:assert/strict';

import {
  balancedDefenseIndices,
  balancedRouteIndices,
  selectDiversePointIndex,
} from '../src/ai/tactics.js';

test('attack assignments cover every route before doubling up', () => {
  for (let seed = 0; seed < 12; seed++) {
    const assignments = balancedRouteIndices(5, 3, seed);
    assert.equal(new Set(assignments.slice(0, 3)).size, 3);
    assert.ok(assignments.every((index) => index >= 0 && index < 3));
    assert.deepEqual(assignments, balancedRouteIndices(5, 3, seed));
  }
});

test('defense assignments cover A, B, and mid before adding a second post', () => {
  const areas = [
    { sector: 'A' }, { sector: 'B' }, { sector: 'mid' },
    { sector: 'A' }, { sector: 'B' }, { sector: 'mid' },
  ];
  for (let seed = 0; seed < 12; seed++) {
    const assignments = balancedDefenseIndices(4, areas, seed);
    const firstSectors = assignments.slice(0, 3).map((index) => areas[index].sector);
    assert.deepEqual(new Set(firstSectors), new Set(['A', 'B', 'mid']));
    assert.equal(assignments.length, 4);
  }
});

test('destination selection avoids recent and teammate-reserved points', () => {
  const points = [{ x: 0, z: 0 }, { x: 6, z: 0 }, { x: -6, z: 0 }];
  const options = {
    origin: { x: 0, z: 0 },
    occupied: [{ x: 6, z: 0 }],
    recent: [{ x: 0, z: 0 }],
    salt: 17,
  };
  assert.equal(selectDiversePointIndex(points, options), 2);
  assert.equal(selectDiversePointIndex(points, options), 2, 'same state is deterministic');
  assert.equal(selectDiversePointIndex([], options), -1);
});
