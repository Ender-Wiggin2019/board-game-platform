import {
  type GameClientRegistry as CommonGameClientRegistry,
  createGameClientRegistry as createCommonGameClientRegistry,
} from '@board-game/components';
import type { GameClientRegistration } from './GameClientRegistration.js';
import { registerGameResources } from './i18n.js';

export type GameClientRegistry =
  CommonGameClientRegistry<GameClientRegistration>;

export function createGameClientRegistry(
  initial: readonly GameClientRegistration[] = [],
): GameClientRegistry {
  const registry = createCommonGameClientRegistry<GameClientRegistration>();
  const register = (registration: GameClientRegistration): void => {
    const ids = new Set([
      'lobby',
      'sessions',
      'profile',
      'achievements',
      'rankings',
      'wallet',
      'admin',
    ]);
    for (const page of registration.pages ?? []) {
      if (!/^[a-z][a-z0-9-]*$/.test(page.id) || ids.has(page.id)) {
        throw new Error(
          `Invalid or duplicate game page: ${registration.gameId}/${page.id}`,
        );
      }
      ids.add(page.id);
    }
    const adminIds = new Set<string>();
    for (const page of registration.administration ?? []) {
      if (!/^[a-z][a-z0-9-]*$/.test(page.id) || adminIds.has(page.id)) {
        throw new Error(
          `Invalid or duplicate game administration page: ${registration.gameId}/${page.id}`,
        );
      }
      adminIds.add(page.id);
    }
    registry.register(registration);
    if (registration.locales) {
      registerGameResources(registration.gameId, registration.locales);
    }
  };
  for (const registration of initial) register(registration);
  return { ...registry, register };
}
