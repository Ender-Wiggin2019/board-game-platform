import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useMemo, useRef } from 'react';

export type PlatformNotificationOwnerKind = 'achievement';
export type PlatformNotificationOwnerMatcher = (
  content: Readonly<Record<string, unknown>>,
) => boolean;

export interface PlatformNotificationOwnership {
  readonly registerNotificationOwner: (
    gameId: string,
    kind: PlatformNotificationOwnerKind,
    matcher: PlatformNotificationOwnerMatcher,
  ) => () => void;
  readonly hasNotificationOwner: (
    gameId: string | undefined,
    kind: PlatformNotificationOwnerKind,
    content: Readonly<Record<string, unknown>>,
  ) => boolean;
}

const emptyOwnership: PlatformNotificationOwnership = {
  registerNotificationOwner: () => () => undefined,
  hasNotificationOwner: () => false,
};

const PlatformNotificationOwnershipContext = createContext(emptyOwnership);

export function PlatformNotificationOwnershipProvider({
  children,
}: {
  readonly children: ReactNode;
}): React.JSX.Element {
  const owners = useRef(
    new Map<
      string,
      Map<
        PlatformNotificationOwnerKind,
        Map<symbol, PlatformNotificationOwnerMatcher>
      >
    >(),
  );
  const registerNotificationOwner = useCallback(
    (
      gameId: string,
      kind: PlatformNotificationOwnerKind,
      matcher: PlatformNotificationOwnerMatcher,
    ): (() => void) => {
      let gameOwners = owners.current.get(gameId);
      if (!gameOwners) {
        gameOwners = new Map();
        owners.current.set(gameId, gameOwners);
      }
      let kindOwners = gameOwners.get(kind);
      if (!kindOwners) {
        kindOwners = new Map();
        gameOwners.set(kind, kindOwners);
      }
      const owner = Symbol(kind);
      kindOwners.set(owner, matcher);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        kindOwners?.delete(owner);
        if (kindOwners?.size === 0) gameOwners?.delete(kind);
        if (gameOwners?.size === 0) owners.current.delete(gameId);
      };
    },
    [],
  );
  const hasNotificationOwner = useCallback(
    (
      gameId: string | undefined,
      kind: PlatformNotificationOwnerKind,
      content: Readonly<Record<string, unknown>>,
    ): boolean => {
      if (!gameId) return false;
      const kindOwners = owners.current.get(gameId)?.get(kind);
      return (
        kindOwners !== undefined &&
        [...kindOwners.values()].some((matcher) => matcher(content))
      );
    },
    [],
  );
  const value = useMemo(
    () => ({ registerNotificationOwner, hasNotificationOwner }),
    [hasNotificationOwner, registerNotificationOwner],
  );

  return (
    <PlatformNotificationOwnershipContext.Provider value={value}>
      {children}
    </PlatformNotificationOwnershipContext.Provider>
  );
}

export function usePlatformNotificationOwnership(): PlatformNotificationOwnership {
  return useContext(PlatformNotificationOwnershipContext);
}
