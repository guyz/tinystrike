import test from 'node:test';
import assert from 'node:assert/strict';

import { EventBus } from '../src/shared/events.js';
import PlayerProfile, {
  PLAYER_CHARACTERS,
  PROFILE_KEY,
  getCharacterPalette,
  normalizeCharacterId,
  normalizePlayerName,
} from '../src/player/profile.js';

class MemoryStorage {
  constructor(initial = {}) { this.values = new Map(Object.entries(initial)); }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
}

test('player profiles migrate names, persist changes, and expose compatibility aliases', () => {
  const storage = new MemoryStorage({ 'tiny-strike-player-name': '  <Ace>\n Player ' });
  const events = new EventBus();
  const changes = [];
  events.on('profile:changed', (event) => changes.push(event));
  const game = { events, player: { name: 'You' } };
  const profile = new PlayerProfile(game, { storage });

  assert.equal(profile.name, 'Ace Player');
  assert.equal(profile.characterId, 'vanguard');
  const result = profile.update({ callsign: ' Nova_7 ', appearanceId: 'shadow' });
  assert.deepEqual(result, {
    name: 'Nova_7', characterId: 'shadow', callsign: 'Nova_7', appearanceId: 'shadow',
  });
  assert.equal(game.player.name, 'Nova_7');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].profile.characterId, 'shadow');
  assert.deepEqual(JSON.parse(storage.getItem(PROFILE_KEY)), {
    name: 'Nova_7', characterId: 'shadow',
  });
});

test('character customization is a four-entry whitelist with fixed palettes', () => {
  assert.deepEqual(
    PLAYER_CHARACTERS.map((entry) => entry.id),
    ['vanguard', 'ranger', 'breacher', 'shadow']
  );
  assert.equal(normalizeCharacterId('SHADOW'), 'shadow');
  assert.equal(normalizeCharacterId('#ff00ff'), 'vanguard');
  assert.equal(normalizePlayerName('🔥 <Rogue>'), 'Rogue');
  assert.notEqual(getCharacterPalette('ranger', 'ct').sleeve, getCharacterPalette('breacher', 'ct').sleeve);
  assert.notEqual(getCharacterPalette('shadow', 'ct').uniform, getCharacterPalette('shadow', 't').uniform);
});

test('malformed or unavailable persistence falls back safely', () => {
  const malformed = new MemoryStorage({ [PROFILE_KEY]: '{bad json' });
  assert.doesNotThrow(() => new PlayerProfile(null, { storage: malformed }));
  const throwing = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
  };
  const profile = new PlayerProfile(null, { storage: throwing });
  assert.equal(profile.name, 'Operative');
  assert.equal(profile.characterId, 'vanguard');
  assert.doesNotThrow(() => profile.setName('Safe'));
});
