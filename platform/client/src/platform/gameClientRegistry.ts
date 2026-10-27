import type { SessionRoute } from '@board-game/contracts';
import {
  createGameClientRegistry,
  type GameClientRegistry,
} from '../gameClientRegistry.js';

let registry: GameClientRegistry = createGameClientRegistry([]);
export function configurePlatformGameClientRegistry(
  value: GameClientRegistry,
): void {
  registry = value;
}
export function getGameClient(gameId: string | undefined) {
  return registry.get(gameId);
}
export function listGameClients() {
  return registry.list();
}

/** Resolve an exact release when the host is backed by a remote registry. */
export function resolveGameClient(
  gameId: string,
  releaseId: string,
  route?: SessionRoute,
) {
  return (
    registry.resolve?.(gameId, releaseId, route) ?? Promise.resolve(undefined)
  );
}

/** Embedded registries intentionally keep their synchronous current-client path. */
export function hasGameClientResolver(): boolean {
  return typeof registry.resolve === 'function';
}
