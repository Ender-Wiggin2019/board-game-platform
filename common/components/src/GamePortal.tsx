import {
  createContext,
  createElement,
  type ReactNode,
  type ReactPortal,
  useContext,
} from 'react';
import { createPortal } from 'react-dom';

/**
 * `undefined` means that no provider is mounted and keeps native clients on
 * the document body. `null` means that a provider is mounted but its scoped
 * release root is not ready yet.
 */
const gamePortalContainerContext = createContext<
  HTMLElement | null | undefined
>(undefined);

export interface GamePortalProviderProps {
  readonly container: HTMLElement | null;
  readonly children: ReactNode;
}

export function GamePortalProvider({
  container,
  children,
}: GamePortalProviderProps): React.JSX.Element {
  return createElement(
    gamePortalContainerContext.Provider,
    { value: container },
    children,
  );
}

/** Returns the current release-scoped portal root, or `undefined` for native clients. */
export function useGamePortalContainer(): HTMLElement | null | undefined {
  return useContext(gamePortalContainerContext);
}

/**
 * Renders overlays in the current release root. Native clients without the
 * provider retain the historical document-body fallback.
 */
export function GamePortal({
  children,
}: {
  readonly children: ReactNode;
}): ReactPortal | null {
  const container = useGamePortalContainer();
  if (typeof document === 'undefined' || container === null) return null;
  return createPortal(children, container ?? document.body);
}
