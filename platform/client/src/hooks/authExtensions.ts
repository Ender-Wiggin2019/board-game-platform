import type { IAuthUser, IUpdatePreferencesRequest } from '../api/types.js';

export interface IAuthPreferenceExtension {
  updatePreferences: (
    patch: IUpdatePreferencesRequest,
  ) => Promise<IAuthUser | undefined>;
  getSnapshot: () => { isPending: boolean };
  subscribe: (listener: () => void) => () => void;
}

type TLogoutCleanup = (isCurrent: () => boolean) => Promise<void>;

let preferenceExtension: IAuthPreferenceExtension | null = null;
const preferenceListeners = new Set<() => void>();
const logoutCleanups = new Set<TLogoutCleanup>();

function notifyPreferenceListeners(): void {
  for (const listener of preferenceListeners) listener();
}

export function getAuthPreferenceExtension(): IAuthPreferenceExtension | null {
  return preferenceExtension;
}

export function subscribeAuthPreferenceExtensions(
  listener: () => void,
): () => void {
  preferenceListeners.add(listener);
  return () => preferenceListeners.delete(listener);
}

export function registerAuthPreferenceExtension(
  extension: IAuthPreferenceExtension,
): () => void {
  preferenceExtension = extension;
  notifyPreferenceListeners();
  const unsubscribe = extension.subscribe(notifyPreferenceListeners);
  return () => {
    unsubscribe();
    if (preferenceExtension === extension) {
      preferenceExtension = null;
      notifyPreferenceListeners();
    }
  };
}

export function registerAuthLogoutCleanup(cleanup: TLogoutCleanup): () => void {
  logoutCleanups.add(cleanup);
  return () => logoutCleanups.delete(cleanup);
}

export async function runAuthLogoutCleanups(
  isCurrent: () => boolean,
): Promise<void> {
  await Promise.all(
    [...logoutCleanups].map(async (cleanup) => {
      await cleanup(isCurrent);
    }),
  );
}
