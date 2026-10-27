import type { SessionRoute } from '@board-game/contracts';
import { useQuery } from '@tanstack/react-query';
import type { GameClientRegistration } from '../GameClientRegistration.js';
import {
  getGameClient,
  hasGameClientResolver,
  resolveGameClient,
} from './gameClientRegistry.js';

export interface ResolvedGameClient {
  readonly registration: GameClientRegistration | undefined;
  readonly isPending: boolean;
  readonly isFetching: boolean;
  readonly isError: boolean;
  readonly isUnavailable: boolean;
  readonly error: unknown;
  readonly refetch: () => Promise<unknown>;
}

function routeKey(route: SessionRoute | undefined): string | null {
  if (!route) return null;
  return JSON.stringify([
    route.sessionId,
    route.modeId,
    route.releaseId,
    route.backendBindingId,
    route.storageBindingId,
    route.ownershipEpoch,
  ]);
}

/**
 * Resolve the release selected by platform JSON or a frozen session route.
 * Embedded registries have no resolver and intentionally retain their current
 * synchronous registration for compatibility. A remote resolver never falls
 * back to a different release when an exact lookup fails.
 */
export function useResolvedGameClient(
  gameId: string | undefined,
  releaseId: string | undefined,
  route?: SessionRoute,
): ResolvedGameClient {
  const remote = hasGameClientResolver();
  const query = useQuery({
    queryKey: [
      'platform',
      'game-client',
      gameId ?? null,
      releaseId ?? null,
      routeKey(route),
    ],
    queryFn: async () => {
      if (!gameId || !releaseId)
        throw new Error('platform.client.release_required');
      return (await resolveGameClient(gameId, releaseId, route)) ?? null;
    },
    enabled: remote && Boolean(gameId && releaseId),
    retry: false,
    staleTime: 5 * 60 * 1000,
  });

  const registration = remote
    ? (query.data ?? undefined)
    : gameId
      ? getGameClient(gameId)
      : undefined;
  const exactReleaseRequested = remote && Boolean(gameId && releaseId);
  return {
    registration,
    isPending: exactReleaseRequested && query.isPending,
    isFetching: exactReleaseRequested && query.isFetching,
    isError: exactReleaseRequested && query.isError,
    isUnavailable:
      exactReleaseRequested && query.isFetched && query.data === null,
    error: query.error,
    refetch: query.refetch,
  };
}
