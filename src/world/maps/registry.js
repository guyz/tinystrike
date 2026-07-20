import { CITADEL } from './citadel.js';
import { FROSTLINE } from './frostline.js';
import { HARBOR } from './harbor.js';
import { NEON_FOUNDRY } from './neon-foundry.js';

export const WORLD_MAP_DEFINITIONS = Object.freeze({
  frostline: FROSTLINE,
  neon_foundry: NEON_FOUNDRY,
  harbor: HARBOR,
  citadel: CITADEL,
});

export function worldMapDefinition(mapId) {
  return WORLD_MAP_DEFINITIONS[mapId] || null;
}
