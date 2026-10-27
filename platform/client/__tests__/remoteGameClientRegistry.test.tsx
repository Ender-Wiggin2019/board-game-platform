import type {
  GameEntryRuntime,
  RemoteClientModuleLoader,
} from '@board-game/client';
import {
  type ClientReleaseLocator,
  type GameServiceDescription,
  IFRAME_CLIENT_RUNTIME_ABI,
  type JsonValue,
  REACT_CLIENT_RUNTIME_ABI,
  type SessionRoute,
} from '@board-game/contracts';
import { act, cleanup, render, screen } from '@testing-library/react';
import { useTranslation } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import platformI18n from '../src/i18n';
import {
  createIsolatedGameClient,
  createRemoteGameClientRegistry,
} from '../src/remoteGameClientRegistry';

const digest = `sha256:${'a'.repeat(64)}`;
const locator: ClientReleaseLocator = {
  schemaVersion: 1,
  gameId: 'counter',
  releaseId: 'counter-v1',
  clientDigest: digest,
  publicAssetsDigest: digest,
  baseUrl: `https://game.example/counter/counter-v1/${digest.slice(7)}/`,
  runtime: {
    abiVersion: IFRAME_CLIENT_RUNTIME_ABI,
    format: 'iframe',
    entry: 'entry.html',
    exportName: 'iframeEntry',
    styles: [],
    shared: [],
  },
};
const route: SessionRoute = {
  gameId: 'counter',
  modeId: 'room',
  sessionId: 'session-1',
  releaseId: 'counter-v1',
  backendBindingId: 'backend-1',
  storageBindingId: 'storage-1',
  ownershipEpoch: 'epoch-1',
};
const description: GameServiceDescription = {
  schemaVersion: 1,
  platformId: 'platform-1',
  gameId: 'counter',
  releaseId: 'counter-v1',
  backendBindingId: 'backend-1',
  storageBindingId: 'storage-1',
  ownershipEpoch: 'epoch-1',
  metadata: {
    gameId: 'counter',
    name: 'Counter',
    description: 'A counter fixture.',
    themeId: 'counter-theme',
  },
  modes: [
    {
      id: 'room',
      entry: 'room',
      minPlayers: 2,
      maxPlayers: 4,
      history: 'summary-and-replay',
      platformRating: false,
      concurrency: 'revision',
    },
  ],
  setupSchema: {
    name: 'counter.setup',
    version: 1,
    schema: {
      type: 'object',
      properties: {
        playerCount: { type: 'integer', minimum: 2, maximum: 4 },
      },
      required: ['playerCount'],
      additionalProperties: false,
    },
  },
  replay: { manifestQuery: { type: 'manifest' }, framesQueryType: 'frames' },
};

const runtime = {
  http: { get: vi.fn(), post: vi.fn() },
  session: {
    signals: {
      subscribeRevision: () => () => undefined,
      setForeground: () => undefined,
    },
    createTransport: () => ({}) as never,
  },
  signals: {
    subscribeRevision: () => () => undefined,
    setForeground: () => undefined,
  },
  viewer: { identityKey: null },
  navigation: {
    platformHref: '/games/counter/lobby',
    replayHref: () => '/games/counter/replay/session-1',
  },
} satisfies GameEntryRuntime;

afterEach(cleanup);

describe('remote release translations', () => {
  it('retains platform fallback namespaces and follows language changes without leaking release resources', async () => {
    platformI18n.removeResourceBundle('zh-CN', 'platform-common');
    function Controls() {
      const { t } = useTranslation('common');
      return (
        <>
          <span>{t('releaseCaption')}</span>
          <button type='button'>{t('client.common.undo')}</button>
        </>
      );
    }
    const registry = createRemoteGameClientRegistry({
      loader: {
        load: async () => ({
          definition: {
            gameId: 'counter',
            metadata: { nameKey: 'counter.name' },
            setup: {
              default: () => ({}),
              getPlayerCount: (_setup: JsonValue, fallback: number) => fallback,
              updatePlayerCount: (setup: JsonValue) => setup,
            },
            entry: { loadLive: async () => ({ default: Controls }) },
            locales: {
              en: { common: { releaseCaption: 'Counter controls' } },
              'zh-CN': { common: { releaseCaption: '计数器操作' } },
            },
          },
        }),
      } as unknown as RemoteClientModuleLoader,
      resolveLocator: async () => ({
        ...locator,
        runtime: {
          ...locator.runtime,
          abiVersion: REACT_CLIENT_RUNTIME_ABI,
          format: 'esm',
          entry: 'client.js',
          exportName: 'gameClient',
        },
      }),
    });
    const registration = await registry.resolve?.(
      'counter',
      'counter-v1',
      route,
    );
    const Providers = registration?.providers;
    if (!Providers) throw new Error('release providers missing');
    render(
      <Providers>
        <Controls />
      </Providers>,
    );
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeVisible();
    expect(screen.getByText('Counter controls')).toBeVisible();
    await act(async () => {
      await platformI18n.reloadResources(['zh-CN'], ['platform-common']);
      await platformI18n.changeLanguage('zh-CN');
    });
    expect(await screen.findByRole('button', { name: '撤销' })).toBeVisible();
    expect(screen.getByText('计数器操作')).toBeVisible();
    expect(platformI18n.exists('releaseCaption', { ns: 'common' })).toBe(false);
  });
});

describe('isolated game client registry', () => {
  it('builds setup and iframe entries from validated JSON only', async () => {
    const factory = createIsolatedGameClient({
      resolveServiceDescription: async () => description,
      error: <p>Unavailable</p>,
    });
    const registration = await factory(locator, route);
    expect(registration.metadata.nameKey).toBe('remote.counter.name');
    expect(registration.capabilities).toMatchObject({
      room: true,
      replay: true,
      spectate: true,
    });
    expect(registration.setup.default('room')).toEqual({ playerCount: 2 });
    expect(
      registration.setup.getPlayerCount(
        registration.setup.updatePlayerCount(
          registration.setup.default('room'),
          4,
        ),
        2,
      ),
    ).toBe(4);
    const live = await registration.entry.loadLive();
    render(
      <live.default
        route={route}
        runtime={runtime}
        status='active'
        spectate={false}
      />,
    );
    const frame = screen.getByTitle('counter live') as HTMLIFrameElement;
    expect(frame.src).toBe(
      `${locator.baseUrl}${locator.runtime.entry}?parentOrigin=${encodeURIComponent(window.location.origin)}`,
    );
    expect(frame.getAttribute('sandbox')).toBe(
      'allow-scripts allow-same-origin',
    );
  });

  it('rejects a service description that is not pinned to the route', async () => {
    const factory = createIsolatedGameClient({
      resolveServiceDescription: async () => ({
        ...description,
        backendBindingId: 'other-backend',
      }),
    });
    await expect(factory(locator, route)).rejects.toThrow(
      'client.release.identity_mismatch',
    );
  });

  it('keeps exact session resolution separate and uses the default factory', async () => {
    const resolveLocator = vi.fn(async () => locator);
    const resolveServiceDescription = vi.fn(async () => description);
    const registry = createRemoteGameClientRegistry({
      loader: {} as RemoteClientModuleLoader,
      resolveLocator,
      resolveServiceDescription,
    });
    const resolve = registry.resolve;
    if (!resolve) throw new Error('registry resolver missing');
    await resolve(route.gameId, route.releaseId, route);
    await resolve(route.gameId, route.releaseId, route);
    await resolve(route.gameId, route.releaseId, {
      ...route,
      sessionId: 'session-2',
    });
    expect(resolveLocator).toHaveBeenCalledTimes(2);
    expect(resolveServiceDescription).toHaveBeenCalledTimes(2);
  });
});
