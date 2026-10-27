import {
  ClientReleaseStyles,
  type GameHttpClient,
  type RemoteClientModuleLoader,
} from '@board-game/client';
import {
  defineGameClient,
  type GameEndEntryProps,
  type GameLiveEntryProps,
  type GameReplayEntryProps,
  IframeGameEntry,
} from '@board-game/components';
import {
  assertClientReleaseLocator,
  assertGameServiceDescription,
  assertMatchesSchema,
  type ClientReleaseLocator,
  contractError,
  type GameServiceDescription,
  IFRAME_CLIENT_RUNTIME_ABI,
  type JsonSchema,
  type JsonValue,
  type SessionRoute,
} from '@board-game/contracts';
import { createInstance } from 'i18next';
import { type ReactNode, useEffect, useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import { PlatformLoadingStatus } from './components/PlatformLoadingStatus.js';
import type { GameClientRegistration } from './GameClientRegistration.js';
import type { GameClientRegistry } from './gameClientRegistry.js';
import platformI18n from './i18n.js';

export interface RemoteGameClientRegistryOptions {
  readonly loader: RemoteClientModuleLoader;
  readonly resolveLocator: (
    gameId: string,
    releaseId: string,
    route?: SessionRoute,
  ) => Promise<ClientReleaseLocator>;
  readonly styles?: ClientReleaseStyles;
  /** Isolated clients provide JSON setup/catalog metadata without evaluating their UI in the shell. */
  readonly isolatedClient?: (
    locator: ClientReleaseLocator,
    route?: SessionRoute,
  ) => Promise<GameClientRegistration>;
  /** Resolve an authenticated, JSON-only service description for iframe releases. */
  readonly resolveServiceDescription?: (
    locator: ClientReleaseLocator,
    route?: SessionRoute,
  ) => Promise<GameServiceDescription>;
  readonly isolatedClientLoading?: ReactNode;
  readonly isolatedClientError?: ReactNode;
  readonly isolatedClientSetupDefaults?: Readonly<Record<string, JsonValue>>;
  readonly allowInsecureLocalhost?: boolean;
}

export interface IsolatedGameClientFactoryOptions {
  /** The caller must obtain this from a verified platform service catalog. */
  readonly resolveServiceDescription: (
    locator: ClientReleaseLocator,
    route?: SessionRoute,
  ) => Promise<GameServiceDescription>;
  readonly loading?: ReactNode;
  readonly error?: ReactNode;
  readonly allowInsecureLocalhost?: boolean;
  /** Optional JSON defaults keyed by mode; useful when a schema has required fields. */
  readonly setupDefaults?: Readonly<Record<string, JsonValue>>;
}

function schemaDefault(schema: JsonSchema): JsonValue {
  switch (schema.type) {
    case 'any':
      return null;
    case 'null':
      return null;
    case 'boolean':
      return false;
    case 'number':
      return schema.minimum ?? 0;
    case 'integer':
      return Math.ceil(schema.minimum ?? 0);
    case 'string': {
      if (schema.enum?.[0] !== undefined) return schema.enum[0];
      const minimum = Math.min(schema.minLength ?? 0, 4096);
      const candidates = [
        'default',
        'seed',
        'standard',
        '0',
        '1',
        'x'.repeat(minimum),
      ];
      const pattern =
        schema.pattern === undefined
          ? undefined
          : new RegExp(schema.pattern, 'u');
      return (
        candidates.find(
          (candidate) =>
            candidate.length >= minimum &&
            (schema.maxLength === undefined ||
              candidate.length <= schema.maxLength) &&
            (pattern === undefined || pattern.test(candidate)),
        ) ?? ''
      );
    }
    case 'array': {
      const item = schema.items ? schemaDefault(schema.items) : null;
      return Array.from(
        { length: Math.min(schema.minItems ?? 0, 4096) },
        () => item,
      );
    }
    case 'object': {
      const properties = schema.properties ?? {};
      const required = new Set(schema.required ?? []);
      return Object.fromEntries(
        Object.entries(properties)
          .filter(([key]) => required.has(key))
          .map(([key, value]) => [key, schemaDefault(value)]),
      );
    }
  }
}

function playerCount(
  setup: JsonValue,
  fallback: number,
  schema: JsonSchema,
): number {
  if (!setup || typeof setup !== 'object' || Array.isArray(setup))
    return fallback;
  const properties = schema.type === 'object' ? (schema.properties ?? {}) : {};
  for (const key of ['playerCount', 'players', 'numPlayers']) {
    const value = (setup as Record<string, unknown>)[key];
    if (
      typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      properties[key]?.type === 'integer'
    )
      return value;
  }
  return fallback;
}

function updatePlayerCount(
  setup: JsonValue,
  count: number,
  schema: JsonSchema,
): JsonValue {
  if (!setup || typeof setup !== 'object' || Array.isArray(setup)) return setup;
  const properties = schema.type === 'object' ? (schema.properties ?? {}) : {};
  for (const key of ['playerCount', 'players', 'numPlayers']) {
    if (properties[key]?.type === 'integer')
      return { ...(setup as Record<string, JsonValue>), [key]: count };
  }
  return setup;
}

/**
 * Creates the shell-side registration for a different-origin iframe release.
 * Only the verified JSON description is interpreted here; game UI remains in
 * the iframe and the bridge exposes the session transport, not host HTTP.
 */
export function createIsolatedGameClient(
  options: IsolatedGameClientFactoryOptions,
): (
  locator: ClientReleaseLocator,
  route?: SessionRoute,
) => Promise<GameClientRegistration> {
  return async (locator, route) => {
    assertClientReleaseLocator(locator, options.allowInsecureLocalhost);
    if (
      locator.runtime.format !== 'iframe' ||
      locator.runtime.abiVersion !== IFRAME_CLIENT_RUNTIME_ABI
    )
      throw contractError('NOT_READY', 'client.iframe.incompatible');
    const description = await options.resolveServiceDescription(locator, route);
    assertGameServiceDescription(description);
    if (
      description.gameId !== locator.gameId ||
      description.releaseId !== locator.releaseId ||
      (route !== undefined &&
        (!description.modes.some((mode) => mode.id === route.modeId) ||
          description.backendBindingId !== route.backendBindingId ||
          description.storageBindingId !== route.storageBindingId ||
          description.ownershipEpoch !== route.ownershipEpoch))
    )
      throw contractError('FORBIDDEN', 'client.release.identity_mismatch');

    const setupByMode = new Map<string, JsonValue>();
    for (const mode of description.modes) {
      const setup = structuredClone(
        options.setupDefaults?.[mode.id] ??
          schemaDefault(description.setupSchema.schema),
      );
      assertMatchesSchema(setup, description.setupSchema);
      setupByMode.set(mode.id, setup);
    }
    const loading = options.loading ?? null;
    const error = options.error ?? (
      <div role='alert'>This isolated game could not be loaded.</div>
    );
    const loadLive = async () => ({
      default: (props: GameLiveEntryProps) => (
        <IframeGameEntry
          locator={locator}
          route={props.route}
          runtime={props.runtime}
          kind={props.spectate ? 'spectate' : 'live'}
          loading={loading}
          error={error}
          allowInsecureLocalhost={options.allowInsecureLocalhost}
        />
      ),
    });
    const loadReplay = description.replay
      ? async () => ({
          default: (props: GameReplayEntryProps) => (
            <IframeGameEntry
              locator={locator}
              route={props.route}
              runtime={props.runtime}
              kind='replay'
              loading={loading}
              error={error}
              allowInsecureLocalhost={options.allowInsecureLocalhost}
            />
          ),
        })
      : undefined;
    const loadEnd = async () => ({
      default: (props: GameEndEntryProps) => (
        <IframeGameEntry
          locator={locator}
          route={props.route}
          runtime={props.runtime}
          kind='end'
          loading={loading}
          error={error}
          allowInsecureLocalhost={options.allowInsecureLocalhost}
        />
      ),
    });
    const room = description.modes.some((mode) => mode.entry === 'room');
    const directSolo = description.modes.some(
      (mode) => mode.entry === 'direct-solo',
    );
    return {
      gameId: locator.gameId,
      releaseId: locator.releaseId,
      metadata: {
        nameKey: `remote.${locator.gameId}.name`,
        descriptionKey: `remote.${locator.gameId}.description`,
        ...(description.metadata.coverUrl
          ? { cover: description.metadata.coverUrl }
          : {}),
      },
      capabilities: {
        room,
        directSolo,
        spectate: true,
        replay: loadReplay !== undefined,
        supportsSeed: true,
      },
      setup: {
        default: (modeId) => {
          const setup = setupByMode.get(modeId);
          if (setup === undefined)
            throw contractError('NOT_FOUND', 'client.setup.mode_unavailable');
          return structuredClone(setup);
        },
        getPlayerCount: (setup, fallback) =>
          playerCount(setup, fallback, description.setupSchema.schema),
        updatePlayerCount: (setup, count) =>
          updatePlayerCount(setup, count, description.setupSchema.schema),
      },
      entry: {
        loadLive,
        ...(loadReplay ? { loadReplay } : {}),
        loadEnd,
      },
    };
  };
}

export function createRemoteGameClientRegistry(
  options: RemoteGameClientRegistryOptions,
): GameClientRegistry {
  const current = new Map<string, GameClientRegistration>();
  const releases = new Map<string, Promise<GameClientRegistration>>();
  const styles = options.styles ?? new ClientReleaseStyles(document);
  const isolatedClient =
    options.isolatedClient ??
    (options.resolveServiceDescription
      ? createIsolatedGameClient({
          resolveServiceDescription: options.resolveServiceDescription,
          loading: options.isolatedClientLoading,
          error: options.isolatedClientError,
          setupDefaults: options.isolatedClientSetupDefaults,
          allowInsecureLocalhost: options.allowInsecureLocalhost,
        })
      : undefined);
  return {
    register(registration) {
      if (current.has(registration.gameId))
        throw new Error(
          `Duplicate game client registration: ${registration.gameId}`,
        );
      current.set(registration.gameId, registration);
    },
    get: (gameId) => (gameId ? current.get(gameId) : undefined),
    list: () => [...current.values()],
    async resolve(gameId, releaseId, route) {
      const key = JSON.stringify([
        gameId,
        releaseId,
        route
          ? {
              backendBindingId: route.backendBindingId,
              ownershipEpoch: route.ownershipEpoch,
              sessionId: route.sessionId,
              storageBindingId: route.storageBindingId,
            }
          : null,
      ]);
      let pending = releases.get(key);
      if (!pending) {
        pending = (async () => {
          const locator = await options.resolveLocator(
            gameId,
            releaseId,
            route,
          );
          if (locator.gameId !== gameId || locator.releaseId !== releaseId)
            throw contractError(
              'FORBIDDEN',
              'client.release.identity_mismatch',
            );
          if (locator.runtime.format === 'iframe') {
            if (!isolatedClient)
              throw contractError(
                'NOT_READY',
                'client.iframe.catalog_unavailable',
              );
            return isolatedClient(locator, route);
          }
          const module =
            await options.loader.load<GameClientRegistration>(locator);
          const definition = defineGameClient(module.definition);
          if (
            definition.createRoutes ||
            definition.legacyRoutes ||
            definition.applicationGlobals
          )
            throw contractError(
              'NOT_READY',
              'client.release.global_extensions_forbidden',
            );
          const translation = createInstance();
          await translation.init({
            lng: platformI18n.language || 'en',
            fallbackLng: platformI18n.options.fallbackLng ?? 'en',
            resources: structuredClone(
              platformI18n.services.resourceStore?.data ?? {},
            ),
            defaultNS: platformI18n.options.defaultNS,
            fallbackNS: platformI18n.options.fallbackNS,
            initImmediate: false,
            interpolation: { escapeValue: false },
          });
          for (const [language, namespaces] of Object.entries(
            definition.locales ?? {},
          ))
            for (const [namespace, resource] of Object.entries(namespaces))
              translation.addResourceBundle(
                language,
                namespace,
                structuredClone(resource),
                true,
                true,
              );
          const OriginalProviders = definition.providers;
          function ReleaseProviders({
            children,
          }: {
            readonly children: ReactNode;
          }) {
            const [state, setState] = useState<{
              ready: boolean;
              error?: unknown;
            }>({ ready: false });
            useEffect(() => {
              let disposed = false;
              let release: (() => void) | undefined;
              void styles
                .acquire(locator)
                .then((cleanup) => {
                  if (disposed) {
                    cleanup();
                    return;
                  }
                  release = cleanup;
                  setState({ ready: true });
                })
                .catch((error) => {
                  if (!disposed) setState({ ready: false, error });
                });
              const syncLanguage = (language: string) => {
                // Platform namespaces can load later; release-owned keys keep priority.
                for (const [namespace, resource] of Object.entries(
                  platformI18n.getDataByLanguage(language) ?? {},
                ))
                  translation.addResourceBundle(
                    language,
                    namespace,
                    structuredClone(resource),
                    true,
                    false,
                  );
                void translation.changeLanguage(language);
              };
              platformI18n.on('languageChanged', syncLanguage);
              syncLanguage(platformI18n.language);
              return () => {
                disposed = true;
                release?.();
                platformI18n.off('languageChanged', syncLanguage);
              };
            }, []);
            if (state.error) throw state.error;
            if (!state.ready) return <PlatformLoadingStatus />;
            return (
              <I18nextProvider i18n={translation}>
                {OriginalProviders ? (
                  <OriginalProviders>{children}</OriginalProviders>
                ) : (
                  children
                )}
              </I18nextProvider>
            );
          }
          return { ...definition, releaseId, providers: ReleaseProviders };
        })().catch((error) => {
          releases.delete(key);
          throw error;
        });
        releases.set(key, pending);
      }
      const registration = await pending;
      if (!route) current.set(gameId, registration);
      return registration;
    },
  };
}

/** Session resolution uses authenticated route pins; workspace resolution uses published JSON bindings. */
export function createPlatformClientLocatorResolver(http: GameHttpClient) {
  return async (
    gameId: string,
    releaseId: string,
    route?: SessionRoute,
  ): Promise<ClientReleaseLocator> => {
    if (route) {
      const { data } = await http.get<ClientReleaseLocator>(
        `/platform/sessions/${encodeURIComponent(route.sessionId)}/client-locator`,
      );
      return data;
    }
    const { data } = await http.get<
      readonly {
        gameId: string;
        releaseId: string;
        bindings: readonly { backendBindingId: string }[];
      }[]
    >('/platform/releases/catalog');
    const release = data.find(
      (item) => item.gameId === gameId && item.releaseId === releaseId,
    );
    const binding = release?.bindings[0];
    if (!binding)
      throw contractError('NOT_READY', 'client.release.unavailable');
    const { data: locator } = await http.get<ClientReleaseLocator>(
      `/platform/releases/${encodeURIComponent(gameId)}/${encodeURIComponent(releaseId)}/bindings/${encodeURIComponent(binding.backendBindingId)}/client-locator`,
    );
    return locator;
  };
}
