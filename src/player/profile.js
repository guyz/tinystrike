const PROFILE_KEY = 'tiny-strike-player-profile-v1';
const NAME_KEY = 'tiny-strike-player-name';
const LEGACY_NAME_KEY = 'goldeneye-name';
const DEFAULT_NAME = 'Operative';
const DEFAULT_CHARACTER_ID = 'vanguard';

const CALLSIGN_PREFIXES = Object.freeze([
  'Arctic', 'Black', 'Blue', 'Brave', 'Crimson', 'Echo', 'Ember', 'Frost',
  'Ghost', 'Iron', 'Jade', 'Night', 'Onyx', 'Rogue', 'Silent', 'Steel',
]);
const CALLSIGN_NOUNS = Object.freeze([
  'Cobra', 'Falcon', 'Fox', 'Hawk', 'Jackal', 'Lynx', 'Mantis', 'Raven',
  'Saber', 'Scout', 'Shade', 'Viper', 'Wolf', 'Wraith', 'Zenith', 'Zero',
]);

const character = (definition) => Object.freeze({
  ...definition,
  teams: Object.freeze({
    ct: Object.freeze({ ...definition.teams.ct }),
    t: Object.freeze({ ...definition.teams.t }),
  }),
});

// These are intentionally fixed, game-owned palettes. Multiplayer traffic only
// carries a character ID, never client-provided material values.
export const PLAYER_CHARACTERS = Object.freeze([
  character({
    id: 'vanguard',
    label: 'Vanguard',
    description: 'Classic tactical kit',
    swatch: '#5279a5',
    skin: '#c98f6d',
    headgear: 'helmet',
    teams: {
      ct: { uniform: '#365579', dark: '#172b42', sleeve: '#263e5b' },
      t: { uniform: '#74633b', dark: '#3c3020', sleeve: '#58492d' },
    },
  }),
  character({
    id: 'ranger',
    label: 'Ranger',
    description: 'Field green recon gear',
    swatch: '#74895c',
    skin: '#a96848',
    headgear: 'cap',
    teams: {
      ct: { uniform: '#496b67', dark: '#243c3b', sleeve: '#38554d' },
      t: { uniform: '#637047', dark: '#303a25', sleeve: '#4b5937' },
    },
  }),
  character({
    id: 'breacher',
    label: 'Breacher',
    description: 'Heavy sandstorm armor',
    swatch: '#b18457',
    skin: '#78452f',
    headgear: 'wrap',
    teams: {
      ct: { uniform: '#65758a', dark: '#313d4e', sleeve: '#56657a' },
      t: { uniform: '#9a744a', dark: '#533c29', sleeve: '#765638' },
    },
  }),
  character({
    id: 'shadow',
    label: 'Shadow',
    description: 'Low-profile covert kit',
    swatch: '#594f69',
    skin: '#d3a17f',
    headgear: 'balaclava',
    teams: {
      ct: { uniform: '#3c465b', dark: '#191d29', sleeve: '#303748' },
      t: { uniform: '#604d53', dark: '#2b2228', sleeve: '#463941' },
    },
  }),
]);

const CHARACTER_BY_ID = new Map(PLAYER_CHARACTERS.map((entry) => [entry.id, entry]));

function canStore(storage) {
  return storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function';
}

export function normalizePlayerName(value) {
  const cleaned = String(value || '')
    .replace(/[^\p{L}\p{N} _.-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20);
  return cleaned || DEFAULT_NAME;
}

function secureRandom() {
  try {
    if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
      const value = new Uint32Array(1);
      globalThis.crypto.getRandomValues(value);
      return value[0] / 0x100000000;
    }
  } catch {
    // Fall through to Math.random in privacy-restricted browser contexts.
  }
  return Math.random();
}

function randomIndex(length, random) {
  let value;
  try { value = Number(random()); } catch { value = secureRandom(); }
  if (!Number.isFinite(value)) value = secureRandom();
  value = Math.max(0, Math.min(0.999999999999, value));
  return Math.floor(value * length);
}

export function generateRandomPlayerName(random = secureRandom) {
  const prefix = CALLSIGN_PREFIXES[randomIndex(CALLSIGN_PREFIXES.length, random)];
  const noun = CALLSIGN_NOUNS[randomIndex(CALLSIGN_NOUNS.length, random)];
  const tag = 100 + randomIndex(900, random);
  return `${prefix}${noun}-${tag}`;
}

export function normalizeCharacterId(value) {
  const id = String(value || '').trim().toLowerCase();
  return CHARACTER_BY_ID.has(id) ? id : DEFAULT_CHARACTER_ID;
}

export function getCharacterPreset(value) {
  return CHARACTER_BY_ID.get(normalizeCharacterId(value));
}

export function getCharacterPalette(value, team = 'ct') {
  const preset = getCharacterPreset(value);
  return Object.freeze({
    id: preset.id,
    skin: preset.skin,
    headgear: preset.headgear,
    ...(preset.teams[team === 't' ? 't' : 'ct']),
  });
}

export class PlayerProfile {
  constructor(game = null, options = {}) {
    this.game = game;
    if (options.storage !== undefined) {
      this.storage = options.storage;
    } else {
      try { this.storage = globalThis.localStorage; } catch { this.storage = null; }
    }
    this.random = typeof options.random === 'function' ? options.random : secureRandom;
    this.characters = PLAYER_CHARACTERS;
    this.presets = PLAYER_CHARACTERS;

    const stored = this._read();
    this.name = stored.name;
    this.characterId = stored.characterId;
    this._nameCustomized = stored.nameCustomized;
    this._persist();
  }

  get callsign() { return this.name; }
  get appearanceId() { return this.characterId; }

  get() {
    return Object.freeze({
      name: this.name,
      characterId: this.characterId,
      callsign: this.name,
      appearanceId: this.characterId,
    });
  }

  getProfile() { return this.get(); }

  setName(value) { return this.update({ name: value }); }
  setCallsign(value) { return this.setName(value); }
  setCharacter(value) { return this.update({ characterId: value }); }
  setAppearance(value) { return this.setCharacter(value); }

  update(next = {}) {
    const previous = this.get();
    const hasRequestedName = Object.prototype.hasOwnProperty.call(next, 'name') ||
      Object.prototype.hasOwnProperty.call(next, 'callsign');
    const requestedName = next.name ?? next.callsign ?? this.name;
    const requestedCharacter = next.characterId ?? next.appearanceId ?? this.characterId;
    const normalizedName = normalizePlayerName(requestedName);
    const customizedChanged = hasRequestedName && !this._nameCustomized &&
      (normalizedName !== this.name || normalizedName.toLowerCase() === DEFAULT_NAME.toLowerCase());
    this.name = normalizedName;
    this.characterId = normalizeCharacterId(requestedCharacter);
    if (customizedChanged) this._nameCustomized = true;
    const profile = this.get();
    if (profile.name === previous.name && profile.characterId === previous.characterId && !customizedChanged) {
      return profile;
    }

    this._persist();
    if (this.game?.player) {
      this.game.player.name = profile.name;
      this.game.player.characterId = profile.characterId;
    }
    if (this.game?.multiplayer) {
      this.game.multiplayer.localName = profile.name;
      if (this.game.multiplayer._ui?.name) this.game.multiplayer._ui.name.value = profile.name;
    }
    this.game?.events?.emit('profile:changed', { ...profile, profile, previous });
    return profile;
  }

  _read() {
    if (!canStore(this.storage)) {
      return {
        name: generateRandomPlayerName(this.random),
        characterId: DEFAULT_CHARACTER_ID,
        nameCustomized: false,
      };
    }
    let saved = null;
    let legacyName = null;
    try {
      const raw = this.storage.getItem(PROFILE_KEY);
      if (raw) saved = JSON.parse(raw);
    } catch {
      saved = null;
    }
    try {
      legacyName = this.storage.getItem(NAME_KEY) || this.storage.getItem(LEGACY_NAME_KEY);
    } catch {
      legacyName = null;
    }
    const rawName = saved?.name ?? saved?.callsign ?? legacyName;
    const normalizedName = normalizePlayerName(rawName);
    const explicitlyCustomizedDefault = saved?.nameCustomized === true &&
      /^operative$/i.test(String(rawName || '').trim());
    const shouldGenerate = normalizedName.toLowerCase() === DEFAULT_NAME.toLowerCase() &&
      !explicitlyCustomizedDefault;
    return {
      name: shouldGenerate ? generateRandomPlayerName(this.random) : normalizedName,
      characterId: normalizeCharacterId(saved?.characterId ?? saved?.appearanceId),
      nameCustomized: shouldGenerate ? false : saved?.nameCustomized !== false,
    };
  }

  _persist() {
    if (!canStore(this.storage)) return;
    const profile = {
      name: this.name,
      characterId: this.characterId,
      nameCustomized: this._nameCustomized,
    };
    try {
      this.storage.setItem(PROFILE_KEY, JSON.stringify(profile));
      // Retain the old standalone keys so older builds and existing leaderboard
      // sessions migrate without splitting one person into multiple identities.
      this.storage.setItem(NAME_KEY, this.name);
      this.storage.setItem(LEGACY_NAME_KEY, this.name);
    } catch {
      // Browsers may expose localStorage but reject writes in privacy contexts.
    }
  }
}

export {
  PROFILE_KEY,
  NAME_KEY,
  LEGACY_NAME_KEY,
  DEFAULT_NAME,
  DEFAULT_CHARACTER_ID,
};

export default PlayerProfile;
