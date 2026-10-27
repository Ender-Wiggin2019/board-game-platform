const AUTH_REFRESH_LOCK_NAME = 'seti-auth-refresh';
const AUTH_REFRESH_DB_NAME = 'seti-auth-coordination';
const AUTH_REFRESH_STORE_NAME = 'locks';
const AUTH_REFRESH_LOCK_KEY = 'refresh';
const AUTH_REFRESH_LEASE_MS = 30_000;
const AUTH_REFRESH_WAIT_MS = 15_000;
const AUTH_REFRESH_RETRY_MS = 40;

interface ILockManagerLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

interface IAuthRefreshLease {
  owner: string;
  expiresAt: number;
  nonce: string;
}

const TAB_ID = createOwnerId();

/**
 * Refresh cookies are shared by every tab. Serializing the rotation prevents
 * two tabs from presenting the same one-time refresh token simultaneously and
 * triggering refresh-family revocation.
 */
export function withAuthRefreshLock<T>(action: () => Promise<T>): Promise<T> {
  const lockManager = getLockManager();
  if (lockManager) {
    return lockManager.request(AUTH_REFRESH_LOCK_NAME, action);
  }

  return withIndexedDbLease(action);
}

export function isPermanentAuthRefreshFailure(error: unknown): boolean {
  const status = getErrorStatus(error);
  if (status === 401) return true;

  // A successful response that cannot be hydrated is a broken auth contract,
  // rather than a transport failure that should silently discard a session.
  return (
    error instanceof Error &&
    error.message === 'Invalid auth response: missing token'
  );
}

export function getErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as {
    status?: unknown;
    response?: { status?: unknown };
  };
  if (typeof candidate.status === 'number') return candidate.status;
  return typeof candidate.response?.status === 'number'
    ? candidate.response.status
    : undefined;
}

/** Startup and background renewal must respect the same retry schedule. */
export function getAuthRefreshRetryAfterMs(error: unknown): number {
  const retryAfterSeconds =
    error && typeof error === 'object'
      ? (error as { retryAfterSeconds?: unknown }).retryAfterSeconds
      : undefined;
  return typeof retryAfterSeconds === 'number' &&
    Number.isFinite(retryAfterSeconds) &&
    retryAfterSeconds >= 0
    ? retryAfterSeconds * 1_000
    : 0;
}

export function getAuthRefreshRetryDelay(
  error: unknown,
  attempt: number,
): number {
  return Math.max(
    getAuthRefreshRetryAfterMs(error),
    Math.min(1_000 * 2 ** attempt, 30_000),
  );
}

function getLockManager(): ILockManagerLike | undefined {
  if (typeof navigator === 'undefined') return undefined;
  const candidate = (navigator as Navigator & { locks?: unknown }).locks;
  if (!candidate || typeof candidate !== 'object') return undefined;
  const request = (candidate as { request?: unknown }).request;
  return typeof request === 'function'
    ? (candidate as ILockManagerLike)
    : undefined;
}

async function withIndexedDbLease<T>(action: () => Promise<T>): Promise<T> {
  const database = getIndexedDb();
  if (!database) throw new Error('Auth refresh coordination unavailable');

  const lease = await acquireIndexedDbLease(database);
  try {
    return await action();
  } finally {
    await releaseIndexedDbLease(database, lease);
  }
}

async function acquireIndexedDbLease(
  database: IDBFactory,
): Promise<IAuthRefreshLease> {
  const deadline = Date.now() + AUTH_REFRESH_WAIT_MS;
  while (Date.now() < deadline) {
    const candidate: IAuthRefreshLease = {
      owner: TAB_ID,
      expiresAt: Date.now() + AUTH_REFRESH_LEASE_MS,
      nonce: createOwnerId(),
    };
    if (await tryClaimIndexedDbLease(database, candidate)) return candidate;
    await wait(AUTH_REFRESH_RETRY_MS);
  }

  throw new Error('Auth refresh coordination timed out');
}

async function tryClaimIndexedDbLease(
  database: IDBFactory,
  candidate: IAuthRefreshLease,
): Promise<boolean> {
  let db: IDBDatabase;
  try {
    db = await openLockDatabase(database);
  } catch {
    return false;
  }

  return new Promise((resolve) => {
    let claimed = false;
    let settled = false;
    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      db.close();
      resolve(result);
    };

    let transaction: IDBTransaction;
    try {
      transaction = db.transaction(AUTH_REFRESH_STORE_NAME, 'readwrite');
    } catch {
      finish(false);
      return;
    }
    transaction.oncomplete = () => finish(claimed);
    transaction.onerror = () => finish(false);
    transaction.onabort = () => finish(false);
    const store = transaction.objectStore(AUTH_REFRESH_STORE_NAME);
    const request = store.get(AUTH_REFRESH_LOCK_KEY);
    request.onerror = () => {
      try {
        transaction.abort();
      } catch {
        finish(false);
      }
    };
    request.onsuccess = () => {
      const current = parseLease(request.result);
      if (current && current.expiresAt > Date.now()) return;
      try {
        store.put(candidate, AUTH_REFRESH_LOCK_KEY);
        claimed = true;
      } catch {
        try {
          transaction.abort();
        } catch {
          finish(false);
        }
      }
    };
  });
}

async function releaseIndexedDbLease(
  database: IDBFactory,
  lease: IAuthRefreshLease,
): Promise<void> {
  let db: IDBDatabase;
  try {
    db = await openLockDatabase(database);
  } catch {
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      db.close();
      resolve();
    };
    let transaction: IDBTransaction;
    try {
      transaction = db.transaction(AUTH_REFRESH_STORE_NAME, 'readwrite');
    } catch {
      finish();
      return;
    }
    transaction.oncomplete = finish;
    transaction.onerror = finish;
    transaction.onabort = finish;
    const store = transaction.objectStore(AUTH_REFRESH_STORE_NAME);
    const request = store.get(AUTH_REFRESH_LOCK_KEY);
    request.onerror = () => {
      try {
        transaction.abort();
      } catch {
        finish();
      }
    };
    request.onsuccess = () => {
      const current = parseLease(request.result);
      if (current?.owner === lease.owner && current.nonce === lease.nonce) {
        try {
          store.delete(AUTH_REFRESH_LOCK_KEY);
        } catch {
          try {
            transaction.abort();
          } catch {
            finish();
          }
        }
      }
    };
  });
}

function openLockDatabase(database: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = database.open(AUTH_REFRESH_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(AUTH_REFRESH_STORE_NAME)) {
        db.createObjectStore(AUTH_REFRESH_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Auth lock database blocked'));
  });
}

function parseLease(value: unknown): IAuthRefreshLease | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const lease = value as Partial<IAuthRefreshLease>;
  return typeof lease.owner === 'string' &&
    typeof lease.expiresAt === 'number' &&
    typeof lease.nonce === 'string'
    ? (lease as IAuthRefreshLease)
    : undefined;
}

function getIndexedDb(): IDBFactory | undefined {
  if (typeof indexedDB === 'undefined') return undefined;
  return indexedDB;
}

function createOwnerId(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return crypto.randomUUID();
    }
  } catch {
    // Use the fallback for older browsers and restricted contexts.
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function wait(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
