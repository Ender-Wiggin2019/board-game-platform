import { GamePortal } from '@board-game/components';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { lazy, type ReactElement, Suspense } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { GameClientProviders } from '../src/GameClientProviders.js';
import type { GameClientRegistration } from '../src/GameClientRegistration.js';

afterEach(cleanup);

const registration = (releaseId: string): GameClientRegistration => ({
  gameId: 'fixture',
  releaseId,
  metadata: { nameKey: 'fixture.name' },
  setup: {
    default: () => ({}),
    getPlayerCount: () => 1,
    updatePlayerCount: (setup) => setup,
  },
  entry: {
    loadLive: async () => ({ default: () => null }),
  },
});

describe('GameClientProviders portal roots', () => {
  it('keeps release portals under their own scoped wrapper', () => {
    render(
      <>
        <GameClientProviders registration={registration('v1')}>
          <GamePortal>
            <span data-testid='v1-portal'>v1</span>
          </GamePortal>
        </GameClientProviders>
        <GameClientProviders registration={registration('v2')}>
          <GamePortal>
            <span data-testid='v2-portal'>v2</span>
          </GamePortal>
        </GameClientProviders>
      </>,
    );

    const v1Root = document.querySelector('[data-game-release="fixture/v1"]');
    const v2Root = document.querySelector('[data-game-release="fixture/v2"]');
    const v1Portal = screen.getByTestId('v1-portal');
    const v2Portal = screen.getByTestId('v2-portal');
    expect(v1Root?.contains(v1Portal)).toBe(true);
    expect(v2Root?.contains(v2Portal)).toBe(true);
    expect(v1Root?.contains(v2Portal)).toBe(false);
    expect(v2Root?.contains(v1Portal)).toBe(false);
  });

  it('keeps suspended children mounted while the scoped portal root attaches', async () => {
    let resolveLazy!: (module: { default: () => ReactElement }) => void;
    const lazyModule = new Promise<{ default: () => ReactElement }>(
      (resolve) => {
        resolveLazy = resolve;
      },
    );
    const LazyPortal = lazy(() => lazyModule);

    render(
      <Suspense fallback={<span data-testid='lazy-fallback'>loading</span>}>
        <GameClientProviders registration={registration('v1')}>
          <LazyPortal />
        </GameClientProviders>
      </Suspense>,
    );

    expect(screen.getByTestId('lazy-fallback')).toBeInTheDocument();
    resolveLazy({
      default: () => (
        <GamePortal>
          <span data-testid='lazy-portal'>loaded</span>
        </GamePortal>
      ),
    });

    await waitFor(() => {
      expect(screen.getByTestId('lazy-portal')).toBeInTheDocument();
    });
    expect(
      document
        .querySelector('[data-game-release="fixture/v1"]')
        ?.contains(screen.getByTestId('lazy-portal')),
    ).toBe(true);
  });
});
