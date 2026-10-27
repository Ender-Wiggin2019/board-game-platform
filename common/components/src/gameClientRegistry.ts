import type { SessionRoute } from '@board-game/contracts';
import type { GameClientDefinition } from './GameClientRegistration.js';

export interface GameClientRegistry<
  Registration extends GameClientDefinition = GameClientDefinition,
> {
  readonly register: (registration: Registration) => void;
  readonly get: (gameId: string | undefined) => Registration | undefined;
  readonly list: () => readonly Registration[];
  /** Remote registries resolve this exact immutable release; there is no latest fallback. */
  readonly resolve?: (
    gameId: string,
    releaseId: string,
    route?: SessionRoute,
  ) => Promise<Registration | undefined>;
}

export function createGameClientRegistry<
  Registration extends GameClientDefinition = GameClientDefinition,
>(initial: readonly Registration[] = []): GameClientRegistry<Registration> {
  const registrations = new Map<string, Registration>();
  const register = (registration: Registration): void => {
    if (registrations.has(registration.gameId)) {
      throw new Error(
        `Duplicate game client registration: ${registration.gameId}`,
      );
    }
    registrations.set(registration.gameId, registration);
  };
  for (const registration of initial) register(registration);
  return {
    register,
    get: (gameId) => (gameId ? registrations.get(gameId) : undefined),
    list: () => [...registrations.values()],
  };
}
