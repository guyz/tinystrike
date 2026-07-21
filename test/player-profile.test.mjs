import test from 'node:test';
import assert from 'node:assert/strict';

import { EventBus } from '../src/shared/events.js';
import PlayerProfile, {
  PLAYER_CHARACTERS,
  PROFILE_KEY,
  generateRandomPlayerName,
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
    name: 'Nova_7', characterId: 'shadow', nameCustomized: true,
  });
});

test('fresh and legacy-default profiles receive one stable random callsign', () => {
  const values = [0, 0, 0.5];
  const random = () => values.shift() ?? 0.75;
  const storage = new MemoryStorage();
  const profile = new PlayerProfile(null, { storage, random });

  assert.equal(profile.name, 'ArcticCobra-550');
  assert.match(profile.name, /^[\p{L}\p{N}_. -]{1,20}$/u);
  assert.notEqual(profile.name.toLowerCase(), 'operative');
  assert.equal(storage.getItem('tiny-strike-player-name'), profile.name);
  assert.equal(storage.getItem('goldeneye-name'), profile.name);
  assert.deepEqual(JSON.parse(storage.getItem(PROFILE_KEY)), {
    name: profile.name, characterId: 'vanguard', nameCustomized: false,
  });

  // Leaderboard session resume echoes the current name; that must not turn an
  // untouched generated callsign into an explicit user customization.
  profile.setName(profile.name);
  assert.equal(JSON.parse(storage.getItem(PROFILE_KEY)).nameCustomized, false);

  const reloaded = new PlayerProfile(null, { storage, random: () => 0.99 });
  assert.equal(reloaded.name, profile.name);

  const legacy = new MemoryStorage({
    [PROFILE_KEY]: JSON.stringify({ name: 'Operative', characterId: 'shadow' }),
  });
  const migrated = new PlayerProfile(null, { storage: legacy, random: () => 0 });
  assert.equal(migrated.name, 'ArcticCobra-100');
  assert.equal(migrated.characterId, 'shadow');
});

test('custom callsigns survive migration and explicit Operative remains a valid choice', () => {
  const malformed = new MemoryStorage({
    [PROFILE_KEY]: '{bad json',
    'tiny-strike-player-name': 'LegacyAce',
  });
  let generated = false;
  const profile = new PlayerProfile(null, {
    storage: malformed,
    random: () => { generated = true; return 0; },
  });
  assert.equal(profile.name, 'LegacyAce');
  assert.equal(generated, false);

  profile.setName('Operative');
  assert.equal(new PlayerProfile(null, { storage: malformed, random: () => 0.9 }).name, 'Operative');
});

test('random callsign generation stays valid at the edge of its random range', () => {
  const name = generateRandomPlayerName(() => 1);
  assert.equal(name, 'SteelZero-999');
  assert.ok(name.length <= 20);
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
  assert.doesNotThrow(() => new PlayerProfile(null, { storage: malformed, random: () => 0 }));
  const throwing = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
  };
  const profile = new PlayerProfile(null, { storage: throwing, random: () => 0 });
  assert.equal(profile.name, 'ArcticCobra-100');
  assert.equal(profile.characterId, 'vanguard');
  assert.doesNotThrow(() => profile.setName('Safe'));
});
