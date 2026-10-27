import {
  isUserLanguage,
  SUPPORTED_USER_LANGUAGES,
  type TUserLanguage,
} from '@board-platform/contracts/types/protocol/userLanguage';
import i18next, {
  type BackendModule,
  type ReadCallback,
  type ResourceKey,
} from 'i18next';
import { initReactI18next } from 'react-i18next';
import { DEFAULT_LANGUAGE } from './config/constants.js';
import { readDeviceLanguage } from './lib/deviceLanguage.js';

/** A resource can be provided eagerly or loaded only when its language is used. */
export type TI18nResource =
  | ResourceKey
  | { default: ResourceKey }
  | (() => ResourceKey | Promise<ResourceKey | { default: ResourceKey }>);

export type TGameI18nResources = Partial<
  Record<TUserLanguage, Record<string, TI18nResource>>
>;

const resourceRegistrations = new Map<
  string,
  Map<TUserLanguage, Map<string, () => ResourceKey | Promise<ResourceKey>>>
>();
const pendingReloadLanguages = new Set<TUserLanguage>();
const pendingReloadNamespaces = new Set<string>();
let initialized = false;
let initializationStarted = false;
type I18nInitialization = ReturnType<typeof i18next.init>;
let initializationBasePromise: I18nInitialization | null = null;
let initializationPromise: I18nInitialization | null = null;
let reloadAfterInitializationScheduled = false;

function unwrapResource(
  resource: ResourceKey | { default: ResourceKey },
): ResourceKey {
  return typeof resource === 'object' &&
    resource !== null &&
    'default' in resource
    ? resource.default
    : resource;
}

function toLoader(
  resource: TI18nResource,
): () => ResourceKey | Promise<ResourceKey> {
  if (typeof resource === 'function') {
    return async () => unwrapResource(await resource());
  }
  return () => unwrapResource(resource);
}

async function flushPendingReloads(): Promise<void> {
  const pendingLanguages = [...pendingReloadLanguages];
  const namespaces = [...pendingReloadNamespaces];
  pendingReloadLanguages.clear();
  pendingReloadNamespaces.clear();
  if (pendingLanguages.length === 0 || namespaces.length === 0) return;
  await i18next.reloadResources(
    selectActiveLanguages(pendingLanguages),
    namespaces,
  );
}

function selectActiveLanguages(
  languages: readonly TUserLanguage[],
): readonly TUserLanguage[] {
  const activeLanguages = languages.filter(
    (language) =>
      language === i18next.language || i18next.languages.includes(language),
  );
  return activeLanguages.length > 0 ? activeLanguages : languages;
}

function reloadResources(
  languages: readonly TUserLanguage[],
  namespaces: readonly string[],
): void {
  if (languages.length === 0 || namespaces.length === 0) return;
  if (initialized) {
    void i18next.reloadResources(selectActiveLanguages(languages), namespaces);
    return;
  }
  if (!initializationStarted || !initializationBasePromise) return;
  for (const language of languages) pendingReloadLanguages.add(language);
  for (const namespace of namespaces) pendingReloadNamespaces.add(namespace);
  if (reloadAfterInitializationScheduled) return;
  reloadAfterInitializationScheduled = true;
  void initializationBasePromise
    .then(() => {
      reloadAfterInitializationScheduled = false;
      return flushPendingReloads();
    })
    .catch(() => {
      reloadAfterInitializationScheduled = false;
    });
}

/**
 * Register resources owned by a platform or game adapter. Registration is
 * additive and keyed by namespace, so SETI and BRASS can share the singleton
 * i18next instance without moving their locale files into this package.
 */
export function registerGameResources(
  _gameId: string,
  resources: TGameI18nResources,
): void {
  const gameLoaders =
    resourceRegistrations.get(_gameId) ??
    new Map<
      TUserLanguage,
      Map<string, () => ResourceKey | Promise<ResourceKey>>
    >();
  for (const [language, namespaces] of Object.entries(resources)) {
    if (!isUserLanguage(language) || !namespaces) continue;
    const languageLoaders =
      gameLoaders.get(language) ??
      new Map<string, () => ResourceKey | Promise<ResourceKey>>();
    for (const [namespace, resource] of Object.entries(namespaces)) {
      languageLoaders.set(namespace, toLoader(resource));
    }
    gameLoaders.set(language, languageLoaders);
  }
  resourceRegistrations.set(_gameId, gameLoaders);
  reloadResources(Object.keys(resources).filter(isUserLanguage), [
    ...new Set(
      Object.values(resources).flatMap((value) => Object.keys(value ?? {})),
    ),
  ]);
}

function mergeResources(target: ResourceKey, source: ResourceKey): ResourceKey {
  if (!isRecord(target) || !isRecord(source)) return source;
  const merged: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(source)) {
    const current = merged[key];
    merged[key] =
      isRecord(current) && isRecord(value)
        ? mergeResources(current, value)
        : value;
  }
  return merged as ResourceKey;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const localeBackend: BackendModule = {
  type: 'backend',
  init() {
    // This backend has no runtime options or external client to initialize.
  },
  read(language: string, namespace: string, callback: ReadCallback): void {
    if (!isUserLanguage(language)) {
      callback(new Error(`Unsupported locale language: ${language}`), false);
      return;
    }
    const loaders = [...resourceRegistrations.values()]
      .map((gameResources) => gameResources.get(language)?.get(namespace))
      .filter((loader): loader is () => ResourceKey | Promise<ResourceKey> =>
        Boolean(loader),
      );
    if (loaders.length === 0) {
      callback(
        new Error(`Unsupported locale resource: ${language}/${namespace}`),
        false,
      );
      return;
    }
    void Promise.all(loaders.map((loader) => loader()))
      .then((resources) =>
        resources.reduce<ResourceKey>(
          (merged, resource) => mergeResources(merged, resource),
          {},
        ),
      )
      .then((resource) => callback(null, resource))
      .catch((error: unknown) => {
        callback(
          error instanceof Error ? error : new Error(String(error)),
          false,
        );
      });
  },
};

// Register platform-owned namespaces before i18next starts its first load.
// Game adapters register their own namespaces from their entrypoint.
registerGameResources('platform', {
  en: {
    'platform-common': () => import('./locales/en/common.json'),
    platform: () => import('./pages/platform/locales/en.json'),
    'platform-admin': () => import('./pages/admin/locales/en.json'),
    common: {},
  },
  'zh-CN': {
    'platform-common': () => import('./locales/zh-CN/common.json'),
    platform: () => import('./pages/platform/locales/zh-CN.json'),
    'platform-admin': () => import('./pages/admin/locales/zh-CN.json'),
    common: {},
  },
});

initializationBasePromise = Promise.resolve().then(() => {
  initializationStarted = true;
  return i18next
    .use(localeBackend)
    .use(initReactI18next)
    .init({
      ns: ['platform-common', 'platform', 'platform-admin', 'common'],
      defaultNS: 'platform-common',
      fallbackNS: ['platform-common'],
      lng: readDeviceLanguage() ?? DEFAULT_LANGUAGE,
      fallbackLng: false,
      supportedLngs: [...SUPPORTED_USER_LANGUAGES],
      load: 'currentOnly',
      returnNull: false,
      interpolation: {
        escapeValue: false,
      },
    });
});
initializationPromise = initializationBasePromise.then(async (instance) => {
  initialized = true;
  await flushPendingReloads();
  return instance;
});

export const i18nReady = initializationPromise;

export default i18next;
