import { create } from 'zustand';
import type { IAuthUser } from '../api/types.js';

export type { IAuthUser } from '../api/types.js';

export interface IAuthStoreState {
  token: string | null;
  user: IAuthUser | null;
  isAuthenticated: boolean;
  /** True while the refresh cookie is being exchanged during app startup. */
  isRestoring: boolean;
  sessionExpired: boolean;
  /** Changes when the account session starts or ends, not when its token rotates. */
  authEpoch: number;
  login: (token: string, user: IAuthUser) => void;
  refreshSession: (
    token: string,
    user: IAuthUser,
    requestSession: Pick<IAuthStoreState, 'token' | 'user' | 'authEpoch'>,
  ) => void;
  setToken: (token: string | null) => void;
  setUser: (user: IAuthUser) => void;
  setRestoring: (isRestoring: boolean) => void;
  logout: () => void;
  expireSession: () => void;
}

const INITIAL_STATE = {
  token: null,
  user: null,
  isAuthenticated: false,
  isRestoring: false,
  sessionExpired: false,
  authEpoch: 0,
} as const;

/**
 * Access credentials live only in this store. The refresh credential is an
 * HttpOnly cookie owned by the API and therefore never appears in JavaScript,
 * localStorage, IndexedDB, a URL, or an analytics event.
 */
export const useAuthStore = create<IAuthStoreState>()((set) => ({
  ...INITIAL_STATE,
  login: (token, user) => {
    if (!token) {
      set((state) => ({ ...INITIAL_STATE, authEpoch: state.authEpoch + 1 }));
      return;
    }
    set((state) => ({
      token,
      user,
      isAuthenticated: true,
      isRestoring: false,
      sessionExpired: false,
      authEpoch: state.authEpoch + 1,
    }));
  },
  refreshSession: (token, user, requestSession) =>
    set((state) => {
      if (
        state.token !== requestSession.token ||
        state.user?.id !== requestSession.user?.id ||
        state.authEpoch !== requestSession.authEpoch ||
        (requestSession.user !== null && requestSession.user.id !== user.id)
      ) {
        return state;
      }
      const sameAccount = state.isAuthenticated && state.user?.id === user.id;
      return {
        token,
        user:
          sameAccount && state.user !== requestSession.user ? state.user : user,
        isAuthenticated: Boolean(token),
        isRestoring: false,
        sessionExpired: false,
        authEpoch: sameAccount ? state.authEpoch : state.authEpoch + 1,
      };
    }),
  setToken: (token) =>
    set((state) => ({
      ...state,
      token,
      isAuthenticated: Boolean(token && state.user),
    })),
  setUser: (user) =>
    set((state) => ({
      ...state,
      user,
      isAuthenticated: Boolean(state.token && user),
    })),
  setRestoring: (isRestoring) => set({ isRestoring }),
  logout: () =>
    set((state) => ({ ...INITIAL_STATE, authEpoch: state.authEpoch + 1 })),
  expireSession: () =>
    set((state) => ({
      ...INITIAL_STATE,
      sessionExpired: true,
      authEpoch: state.authEpoch + 1,
    })),
}));

/** An async account response may only update the session that submitted it. */
export function isCurrentAuthSession(
  session: { authEpoch: number; user: { id: string } | null } | undefined,
): boolean {
  const current = useAuthStore.getState();
  return Boolean(
    session?.user &&
      current.isAuthenticated &&
      current.authEpoch === session.authEpoch &&
      current.user?.id === session.user?.id,
  );
}

export function isSameAuthSession(
  session:
    | {
        token: string | null;
        user: { id: string } | null;
        authEpoch: number;
      }
    | undefined,
): boolean {
  if (!session) return false;
  const current = useAuthStore.getState();
  return (
    current.token === session.token &&
    current.user?.id === session.user?.id &&
    current.authEpoch === session.authEpoch
  );
}
