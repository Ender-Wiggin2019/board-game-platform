interface IServiceWorkerRegistrationLike {
  unregister: () => Promise<unknown>;
}

interface IServiceWorkerContainerLike {
  getRegistrations: () => Promise<readonly IServiceWorkerRegistrationLike[]>;
}

interface ICacheStorageLike {
  keys: () => Promise<string[]>;
  delete: (cacheName: string) => Promise<unknown>;
}

interface ILocationLike {
  href: string;
  replace: (url: string) => void;
}

export interface IReloadEnvironment {
  serviceWorker?: IServiceWorkerContainerLike;
  cacheStorage?: ICacheStorageLike;
  location: ILocationLike;
  now: () => number;
}

async function unregisterServiceWorkers(
  serviceWorker: IServiceWorkerContainerLike | undefined,
): Promise<void> {
  if (!serviceWorker) return;

  try {
    const registrations = await serviceWorker.getRegistrations();
    await Promise.allSettled(
      registrations.map((registration) => registration.unregister()),
    );
  } catch {
    // Navigation still bypasses the cached document when this API is blocked.
  }
}

async function clearCacheStorage(
  cacheStorage: ICacheStorageLike | undefined,
): Promise<void> {
  if (!cacheStorage) return;

  try {
    const cacheNames = await cacheStorage.keys();
    await Promise.allSettled(
      cacheNames.map((cacheName) => cacheStorage.delete(cacheName)),
    );
  } catch {
    // Navigation still bypasses the cached document when this API is blocked.
  }
}

function getBrowserEnvironment(): IReloadEnvironment {
  return {
    serviceWorker:
      typeof navigator !== 'undefined' && 'serviceWorker' in navigator
        ? navigator.serviceWorker
        : undefined,
    cacheStorage:
      typeof window !== 'undefined' && 'caches' in window
        ? window.caches
        : undefined,
    location: window.location,
    now: Date.now,
  };
}

/**
 * Requests a fresh app shell without removing localStorage, IndexedDB, or
 * authentication data. The unique document URL also bypasses the HTTP cache.
 */
export async function forceReloadLatestVersion(
  environment: IReloadEnvironment = getBrowserEnvironment(),
): Promise<void> {
  try {
    await Promise.all([
      unregisterServiceWorkers(environment.serviceWorker),
      clearCacheStorage(environment.cacheStorage),
    ]);
  } finally {
    const target = new URL(environment.location.href);
    target.searchParams.set('__seti_stale_reload', String(environment.now()));
    environment.location.replace(target.href);
  }
}
