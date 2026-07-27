import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../tools/trailer.js', import.meta.url), 'utf8');

test('trailer capture uses the same post-processed frame path as live gameplay', () => {
  assert.doesNotMatch(source, /game\.renderer\.render\(game\.scene,\s*game\.camera\)/);
  assert.doesNotMatch(source, /renderer\.render\(game\.scene,\s*game\.camera\)/);
  assert.ok((source.match(/game\.renderFrame\(\)/g) || []).length >= 3);
  assert.match(source, /game\.post\?\.setSize\(\)/);
});

test('trailer stepping includes graphics systems that drive the current sky and materials', () => {
  assert.match(source, /'world',\s*'rounds'/);
  assert.match(source, /'materials'/);
});

test('trailer waits for the current procedural rifles and authored grenade assets', () => {
  assert.match(source, /ak47:\s*'procedural'/);
  assert.match(source, /awp:\s*'procedural'/);
  assert.match(source, /m4a1:\s*'procedural'/);
  assert.match(source, /smokegrenade:\s*'glb'/);
  assert.match(source, /viewmodel\._npcArmsSource/);
});
