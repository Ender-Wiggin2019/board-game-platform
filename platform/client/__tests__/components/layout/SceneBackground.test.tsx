import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  SceneBackground,
  SceneProvider,
  useSceneHero,
} from '@/components/layout/SceneBackground';

function HeroSetter({
  src,
  footer,
}: {
  src: string | null;
  footer?: string;
}): React.JSX.Element {
  useSceneHero(src, footer);
  return <div data-testid='probe' />;
}

describe('SceneBackground', () => {
  it('restores the default footer when leaving a route with its own artwork', () => {
    const { rerender } = render(
      <SceneProvider>
        <SceneBackground />
        <HeroSetter
          src='/assets/platform/lobby/lobby.webp'
          footer='/assets/platform/lobby/footer.webp'
        />
      </SceneProvider>,
    );

    expect(screen.getByTestId('scene-footer').style.backgroundImage).toContain(
      '/assets/platform/lobby/footer.webp',
    );

    rerender(
      <SceneProvider>
        <SceneBackground />
        <HeroSetter src='/assets/platform/scenes/profile.webp' />
      </SceneProvider>,
    );

    expect(screen.getByTestId('scene-footer').style.backgroundImage).toBe('');
    expect(screen.getByTestId('scene-hero').style.backgroundImage).toContain(
      '/assets/platform/scenes/profile.webp',
    );

    rerender(
      <SceneProvider>
        <SceneBackground />
        <HeroSetter
          src='/assets/platform/lobby/lobby.webp'
          footer='/assets/platform/lobby/footer.webp'
        />
      </SceneProvider>,
    );
    rerender(
      <SceneProvider>
        <SceneBackground />
      </SceneProvider>,
    );
    expect(screen.getByTestId('scene-footer').style.backgroundImage).toBe('');
    expect(screen.queryByTestId('scene-hero')).toBeNull();
  });

  it('renders only the footer banner when no hero is registered', () => {
    render(
      <SceneProvider>
        <SceneBackground />
      </SceneProvider>,
    );

    expect(screen.getByTestId('scene-background')).toBeInTheDocument();
    expect(screen.getByTestId('scene-footer')).toBeInTheDocument();
    expect(screen.queryByTestId('scene-hero')).toBeNull();
  });

  it('renders the hero registered by a route via useSceneHero', () => {
    render(
      <SceneProvider>
        <SceneBackground />
        <HeroSetter src='/assets/platform/scenes/lobby.webp' />
      </SceneProvider>,
    );

    const hero = screen.getByTestId('scene-hero');
    expect(hero.style.backgroundImage).toContain(
      '/assets/platform/scenes/lobby.webp',
    );
  });

  it('clears the hero when the registering component unmounts', () => {
    const { rerender } = render(
      <SceneProvider>
        <SceneBackground />
        <HeroSetter src='/assets/platform/scenes/profile.webp' />
      </SceneProvider>,
    );

    expect(screen.getByTestId('scene-hero')).toBeInTheDocument();

    rerender(
      <SceneProvider>
        <SceneBackground />
      </SceneProvider>,
    );

    expect(screen.queryByTestId('scene-hero')).toBeNull();
  });
});
