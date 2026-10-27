import type { SessionRoute } from '@board-game/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GameClientRegistration } from '@/GameClientRegistration.js';
import { createGameClientRegistry } from '@/gameClientRegistry';
import type { GameClientRegistry } from '@/gameClientRegistry.js';
import { configurePlatformGameClientRegistry } from '@/platform/gameClientRegistry';
import { useResolvedGameClient } from '@/platform/useGameClient';

const route: SessionRoute = {
  gameId: 'brass',
  modeId: 'standard',
  releaseId: 'brass-v2',
  sessionId: 'session-1',
  backendBindingId: 'backend-1',
  storageBindingId: 'storage-1',
  ownershipEpoch: 'epoch-1',
};

function registration(releaseId: string): GameClientRegistration {
  return {
    gameId: 'brass',
    releaseId,
    metadata: { nameKey: 'brass.name' },
    setup: {
      default: () => ({}),
      getPlayerCount: (_setup, fallback) => fallback,
      updatePlayerCount: (setup) => setup,
    },
    entry: {
      loadLive: async () => ({ default: () => <p>Brass</p> }),
    },
  };
}

function Probe({
  releaseId,
}: {
  readonly releaseId: string;
}): React.JSX.Element {
  const result = useResolvedGameClient('brass', releaseId, route);
  if (result.isPending) return <p>loading</p>;
  if (result.isError) return <p>error</p>;
  return <p>{result.registration?.releaseId ?? 'missing'}</p>;
}

function renderProbe(): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <Probe releaseId='brass-v2' />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  configurePlatformGameClientRegistry(createGameClientRegistry());
});

describe('useResolvedGameClient', () => {
  it('loads the exact release and frozen session route', async () => {
    const current = registration('brass-v1');
    const resolved = registration('brass-v2');
    const resolve = vi.fn(
      async (gameId: string, releaseId: string, received?: SessionRoute) => {
        expect(gameId).toBe('brass');
        expect(releaseId).toBe('brass-v2');
        expect(received).toEqual(route);
        return resolved;
      },
    );
    const embedded = createGameClientRegistry([current]);
    const remote: GameClientRegistry = { ...embedded, resolve };
    configurePlatformGameClientRegistry(remote);

    renderProbe();

    expect(await screen.findByText('brass-v2')).toBeInTheDocument();
    expect(resolve).toHaveBeenCalledOnce();
  });

  it('does not fall back to the current release after an exact 404', async () => {
    const current = registration('brass-v1');
    const embedded = createGameClientRegistry([current]);
    const remote: GameClientRegistry = {
      ...embedded,
      resolve: vi.fn(async () => undefined),
    };
    configurePlatformGameClientRegistry(remote);

    renderProbe();

    await waitFor(() =>
      expect(screen.getByText('missing')).toBeInTheDocument(),
    );
    expect(screen.queryByText('brass-v1')).not.toBeInTheDocument();
  });

  it('keeps the synchronous embedded registration when no resolver exists', async () => {
    configurePlatformGameClientRegistry(
      createGameClientRegistry([registration('brass-v1')]),
    );

    renderProbe();

    expect(await screen.findByText('brass-v1')).toBeInTheDocument();
  });
});
