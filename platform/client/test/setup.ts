import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach } from 'vitest';
import i18n, { i18nReady } from '../src/i18n.js';

beforeAll(async () => {
  await i18nReady;
});
beforeEach(async () => {
  await i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
});

let refreshLockQueue = Promise.resolve();
function ensureAuthRefreshLock(): void {
  if (typeof navigator === 'undefined' || navigator.locks) return;
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request<T>(_name: string, action: () => Promise<T>): Promise<T> {
        const previous = refreshLockQueue;
        let release!: () => void;
        refreshLockQueue = new Promise<void>((resolve) => {
          release = resolve;
        });
        return previous.then(async () => {
          try {
            return await action();
          } finally {
            release();
          }
        });
      },
    },
  });
}
ensureAuthRefreshLock();
beforeEach(ensureAuthRefreshLock);
