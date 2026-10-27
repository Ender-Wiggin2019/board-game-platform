import { GamePortalProvider } from '@board-game/components';
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useState,
} from 'react';
import type { GameClientRegistration } from './GameClientRegistration.js';

/** Installs a game's presentation contexts and scoped theme around its contribution. */
export function GameClientProviders({
  registration,
  children,
}: {
  registration?: GameClientRegistration;
  children: ReactNode;
}): React.JSX.Element {
  const Providers = registration?.providers;
  const content = Providers ? <Providers>{children}</Providers> : children;
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const setContainerRef = useCallback((node: HTMLDivElement | null) => {
    setContainer((current) => (current === node ? current : node));
  }, []);
  if (!registration) return <>{content}</>;
  const style = {
    ...registration.theme?.tokens,
    ...(registration.palette?.accent
      ? { '--game-palette-accent': registration.palette.accent }
      : {}),
  } as CSSProperties;
  return (
    <div
      className='contents'
      ref={setContainerRef}
      data-game={registration.gameId}
      data-game-release={
        registration.releaseId
          ? `${registration.gameId}/${registration.releaseId}`
          : undefined
      }
      data-theme={registration.theme?.dataTheme}
      data-game-theme={registration.theme?.dataTheme}
      data-game-theme-scope={registration.theme?.scope}
      style={style}
    >
      <GamePortalProvider container={container}>{content}</GamePortalProvider>
    </div>
  );
}
