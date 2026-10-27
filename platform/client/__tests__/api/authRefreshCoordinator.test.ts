import { afterEach, describe, expect, it, vi } from 'vitest';
import { withAuthRefreshLock } from '@/api/authRefreshCoordinator.js';

const originalLocks =
  typeof navigator === 'undefined'
    ? undefined
    : (navigator as Navigator & { locks?: unknown }).locks;
const originalIndexedDbDescriptor =
  typeof globalThis === 'undefined'
    ? undefined
    : Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');

afterEach(() => {
  if (typeof navigator !== 'undefined') {
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: originalLocks,
    });
  }
  if (typeof globalThis !== 'undefined') {
    if (originalIndexedDbDescriptor) {
      Object.defineProperty(
        globalThis,
        'indexedDB',
        originalIndexedDbDescriptor,
      );
    } else {
      Reflect.deleteProperty(globalThis, 'indexedDB');
    }
  }
});

describe('auth refresh coordination', () => {
  it('serializes refresh callbacks with the browser lock manager', async () => {
    let active = 0;
    let peak = 0;
    let releaseFirst!: () => void;
    let queue = Promise.resolve();
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: async <T>(_name: string, action: () => Promise<T>) => {
          const previous = queue;
          let resolveQueue!: () => void;
          queue = new Promise<void>((resolve) => {
            resolveQueue = resolve;
          });
          await previous;
          active += 1;
          peak = Math.max(peak, active);
          try {
            return await action();
          } finally {
            active -= 1;
            resolveQueue();
          }
        },
      },
    });

    const first = withAuthRefreshLock(
      () =>
        new Promise<string>((resolve) => {
          releaseFirst = () => resolve('first');
        }),
    );
    await vi.waitFor(() => expect(active).toBe(1));
    const second = withAuthRefreshLock(async () => 'second');
    expect(active).toBe(1);
    releaseFirst();
    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
    expect(peak).toBe(1);
  });

  it('fails closed when the browser has no cross-tab lock primitive', async () => {
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: undefined,
    });
    const action = vi.fn(async () => 'should not run');

    await expect(withAuthRefreshLock(action)).rejects.toThrow(
      'Auth refresh coordination unavailable',
    );
    expect(action).not.toHaveBeenCalled();
  });
});
