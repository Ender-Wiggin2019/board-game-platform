import {
  type GameHttpClient,
  RemoteClientModuleLoader,
} from '@board-game/client';
import type {
  ClientReleaseLocator,
  GameServiceDescription,
  SessionRoute,
} from '@board-game/contracts';
import { contractError } from '@board-game/contracts';
import {
  createPlatformClientLocatorResolver,
  createRemoteGameClientRegistry,
  PlatformApp,
  PlatformConfigurationProvider,
} from '@board-platform/client';
import { loadPlatformConfiguration } from '@board-platform/client/api/platformConfigurationApi.js';
import { ErrorBoundary } from '@board-platform/client/components/ErrorBoundary.js';
import { i18nReady } from '@board-platform/client/i18n.js';
import { showBootstrapFailure } from '@board-platform/client/lib/bootstrapFailure.js';
import { createBrowserPlatformRuntime } from '@board-platform/client/runtime.js';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { loadSharedModules, sharedRuntime } from './sharedRuntime';

type ReleaseCatalogBinding = {
  readonly backendBindingId: string;
};

type ReleaseCatalogItem = {
  readonly gameId: string;
  readonly releaseId: string;
  readonly bindings: readonly ReleaseCatalogBinding[];
};

async function resolveServiceDescription(
  http: GameHttpClient,
  locator: ClientReleaseLocator,
  route?: SessionRoute,
): Promise<GameServiceDescription> {
  let backendBindingId = route?.backendBindingId;
  if (!backendBindingId) {
    const { data } = await http.get<readonly ReleaseCatalogItem[]>(
      '/platform/releases/catalog',
    );
    backendBindingId = data.find(
      (entry) =>
        entry.gameId === locator.gameId &&
        entry.releaseId === locator.releaseId,
    )?.bindings[0]?.backendBindingId;
  }
  if (!backendBindingId) {
    throw contractError('NOT_READY', 'client.release.unavailable');
  }
  const { data } = await http.get<GameServiceDescription>(
    `/platform/releases/${encodeURIComponent(locator.gameId)}/${encodeURIComponent(locator.releaseId)}/bindings/${encodeURIComponent(backendBindingId)}/service-description`,
  );
  return data;
}

export async function startApp(): Promise<void> {
  await i18nReady;
  const configuration = await loadPlatformConfiguration();
  const runtime = createBrowserPlatformRuntime({ directSessions: true });
  const registry = createRemoteGameClientRegistry({
    loader: new RemoteClientModuleLoader({
      runtime: sharedRuntime,
      loadSharedModules,
      allowInsecureLocalhost: import.meta.env.DEV,
    }),
    resolveLocator: createPlatformClientLocatorResolver(runtime.http),
    resolveServiceDescription: (locator, route) =>
      resolveServiceDescription(runtime.http, locator, route),
  });
  createRoot(document.getElementById('root') as HTMLElement).render(
    <StrictMode>
      <PlatformConfigurationProvider value={configuration}>
        <ErrorBoundary
          onFatalError={(error, info) =>
            showBootstrapFailure(error, {
              source: 'react',
              componentStack: info.componentStack ?? undefined,
            })
          }
        >
          <PlatformApp registry={registry} runtime={runtime} />
        </ErrorBoundary>
      </PlatformConfigurationProvider>
    </StrictMode>,
  );
}
