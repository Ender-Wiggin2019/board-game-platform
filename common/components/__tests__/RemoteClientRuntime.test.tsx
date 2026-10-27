import {
  ClientReleaseStyles,
  installSharedClientRuntime,
  RemoteClientModuleLoader,
} from '@board-game/client';
import {
  type ClientReleaseLocator,
  REACT_CLIENT_RUNTIME_ABI,
} from '@board-game/contracts';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const digest = `sha256:${'a'.repeat(64)}`;
function locator(releaseId = 'v1'): ClientReleaseLocator {
  return {
    schemaVersion: 1,
    gameId: 'counter',
    releaseId,
    clientDigest: digest,
    publicAssetsDigest: digest,
    baseUrl: `https://game.example/counter/${releaseId}/${digest.slice(7)}/`,
    runtime: {
      abiVersion: REACT_CLIENT_RUNTIME_ABI,
      format: 'esm',
      entry: 'entry.js',
      exportName: 'gameClientRelease',
      styles: ['styles/game.css'],
      shared: [{ specifier: 'react', version: '18.3.1' }],
    },
  };
}
const modules = { react: { version: '18.3.1', module: React } };
const runtime = installSharedClientRuntime(REACT_CLIENT_RUNTIME_ABI, modules);

afterEach(() => {
  document.head
    .querySelectorAll('link[data-game-release]')
    .forEach((link) => link.remove());
});

describe('remote client release lifecycle', () => {
  it('shares the exact React object, rejects a second instance, and loads old/new releases once each', async () => {
    expect(runtime.modules.react.module).toBe(React);
    expect(installSharedClientRuntime(REACT_CLIENT_RUNTIME_ABI, modules)).toBe(
      runtime,
    );
    expect(() =>
      installSharedClientRuntime(REACT_CLIENT_RUNTIME_ABI, {
        react: { version: '18.3.1', module: { ...React } },
      }),
    ).toThrow();
    const importModule = vi.fn(async (url: string) => ({
      gameClientRelease: {
        gameId: 'counter',
        releaseId: url.includes('/v2/') ? 'v2' : 'v1',
        abiVersion: REACT_CLIENT_RUNTIME_ABI,
        definition: { gameId: 'counter' },
      },
    }));
    const loader = new RemoteClientModuleLoader({ runtime, importModule });
    await Promise.all([
      loader.load(locator()),
      loader.load(locator()),
      loader.load(locator('v2')),
    ]);
    expect(importModule).toHaveBeenCalledTimes(2);
    expect(runtime.assetUrl('counter', 'v1', 'assets/token.webp')).toContain(
      '/counter/v1/',
    );
    expect(runtime.assetUrl('counter', 'v2', 'assets/token.webp')).toContain(
      '/counter/v2/',
    );
    expect(() =>
      loader.load({
        ...locator(),
        runtime: {
          ...locator().runtime,
          shared: [{ specifier: 'react', version: '19.0.0' }],
        },
      }),
    ).toThrow();
  });

  it('rejects a module with the wrong release instead of accepting current code', async () => {
    const loader = new RemoteClientModuleLoader({
      runtime,
      importModule: async () => ({
        gameClientRelease: {
          gameId: 'counter',
          releaseId: 'latest',
          abiVersion: REACT_CLIENT_RUNTIME_ABI,
          definition: { gameId: 'counter' },
        },
      }),
    });
    await expect(loader.load(locator())).rejects.toThrow(
      'client.release.identity_mismatch',
    );
  });

  it('loads shell-owned shared chunks before evaluating the remote and retries a failed preload', async () => {
    const order: string[] = [];
    let attempts = 0;
    const loader = new RemoteClientModuleLoader({
      runtime,
      loadSharedModules: async () => {
        order.push('shared');
        if (++attempts === 1) throw new Error('chunk unavailable');
      },
      importModule: async () => {
        order.push('remote');
        return {
          gameClientRelease: {
            gameId: 'counter',
            releaseId: 'lazy-v1',
            abiVersion: REACT_CLIENT_RUNTIME_ABI,
            definition: { gameId: 'counter' },
          },
        };
      },
    });
    await expect(loader.load(locator('lazy-v1'))).rejects.toThrow(
      'chunk unavailable',
    );
    expect(order).toEqual(['shared']);
    await loader.load(locator('lazy-v1'));
    expect(order).toEqual(['shared', 'shared', 'remote']);
  });

  it('retains one stylesheet for overlapping mounts and removes it after the last unmount', async () => {
    const styles = new ClientReleaseStyles(document);
    const first = styles.acquire(locator());
    const second = styles.acquire(locator());
    const link = document.head.querySelector(
      'link[data-game-release]',
    ) as HTMLLinkElement;
    expect(
      document.head.querySelectorAll('link[data-game-release]'),
    ).toHaveLength(1);
    expect(link.href).toBe(`${locator().baseUrl}styles/game.css`);
    link.dispatchEvent(new Event('load'));
    const [release1, release2] = await Promise.all([first, second]);
    release1();
    release1();
    expect(link.isConnected).toBe(true);
    release2();
    expect(link.isConnected).toBe(false);
  });

  it('cleans all links when any CSS resource fails', async () => {
    const styles = new ClientReleaseStyles(document);
    const pending = styles.acquire({
      ...locator(),
      runtime: {
        ...locator().runtime,
        styles: ['styles/a.css', 'styles/b.css'],
      },
    });
    document.head.querySelector('link')?.dispatchEvent(new Event('error'));
    await expect(pending).rejects.toThrow('client.styles.unavailable');
    expect(
      document.head.querySelectorAll('link[data-game-release]'),
    ).toHaveLength(0);
  });
});
