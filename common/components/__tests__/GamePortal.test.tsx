import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GamePortal,
  GamePortalProvider,
  useGamePortalContainer,
} from '../src/GamePortal.js';

afterEach(() => {
  cleanup();
  document
    .querySelectorAll<HTMLElement>('[data-portal-test-root]')
    .forEach((root) => root.remove());
});

function PortalState(): React.JSX.Element {
  const container = useGamePortalContainer();
  return (
    <output data-testid='portal-state'>
      {container === undefined
        ? 'native'
        : container === null
          ? 'pending'
          : 'scoped'}
    </output>
  );
}

describe('GamePortal', () => {
  it('keeps each release portal in its own container and cleans it up', () => {
    const first = document.createElement('div');
    const second = document.createElement('div');
    first.dataset.portalTestRoot = 'first';
    second.dataset.portalTestRoot = 'second';
    document.body.append(first, second);

    const view = render(
      <>
        <GamePortalProvider container={first}>
          <GamePortal>
            <span data-testid='first-portal'>first</span>
          </GamePortal>
        </GamePortalProvider>
        <GamePortalProvider container={second}>
          <GamePortal>
            <span data-testid='second-portal'>second</span>
          </GamePortal>
        </GamePortalProvider>
      </>,
    );

    expect(first.querySelector('[data-testid="first-portal"]')).toBeTruthy();
    expect(second.querySelector('[data-testid="second-portal"]')).toBeTruthy();
    expect(first.querySelector('[data-testid="second-portal"]')).toBeNull();
    expect(second.querySelector('[data-testid="first-portal"]')).toBeNull();

    view.unmount();
    expect(first.childElementCount).toBe(0);
    expect(second.childElementCount).toBe(0);
  });

  it('does not render while a scoped provider is waiting for its root', () => {
    render(
      <GamePortalProvider container={null}>
        <PortalState />
        <GamePortal>
          <span data-testid='pending-portal'>pending</span>
        </GamePortal>
      </GamePortalProvider>,
    );

    expect(screen.getByTestId('portal-state').textContent).toBe('pending');
    expect(screen.queryByTestId('pending-portal')).toBeNull();
  });

  it('falls back to document.body for native clients without a provider', () => {
    render(
      <>
        <PortalState />
        <GamePortal>
          <span data-testid='native-portal'>native</span>
        </GamePortal>
      </>,
    );

    const portal = screen.getByTestId('native-portal');
    expect(screen.getByTestId('portal-state').textContent).toBe('native');
    expect(portal.parentElement).toBe(document.body);
  });
});
