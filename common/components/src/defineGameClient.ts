import { defineGameOptions } from './defineGameOptions.js';
import type { GameClientDefinition } from './GameClientRegistration.js';

function invalid(message: string): never {
  throw new Error(`Invalid game client definition: ${message}`);
}

/**
 * Defines the game-owned portion of a client registration. Platform routes,
 * account pages and legacy extensions are attached by the platform package.
 */
export function defineGameClient<const Definition extends GameClientDefinition>(
  definition: Definition,
): Readonly<Definition> {
  if (!definition || typeof definition !== 'object') invalid('definition');
  if (definition.gameId.trim().length === 0) invalid('gameId');
  if (typeof definition.entry.loadLive !== 'function')
    invalid('entry.loadLive');
  if (definition.setup.options) defineGameOptions(definition.setup.options);
  return Object.freeze(definition);
}
