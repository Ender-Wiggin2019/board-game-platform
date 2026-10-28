import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from '@tanstack/react-router';
import { createInstance } from 'i18next';
import { type ComponentType, type ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { GameClientProviders } from './GameClientProviders.js';
import type { GameClientRegistration } from './GameClientRegistration.js';
import platformI18n, { i18nReady } from './i18n.js';

/**
 * Build the isolated provider stack used by a local development game entry.
 *
 * Development clients need the game presentation contexts, data cache, router
 * hooks and release-owned translations without booting the authenticated
 * platform application or mutating its singleton i18n instance.
 */
export async function createDevelopmentGameProviders(
  registration: GameClientRegistration,
): Promise<ComponentType<{ readonly children: ReactNode }>> {
  await i18nReady;
  const translation = createInstance();
  await translation.init({
    lng: platformI18n.language || 'en',
    fallbackLng: platformI18n.options.fallbackLng ?? 'en',
    resources: structuredClone(platformI18n.services.resourceStore?.data ?? {}),
    defaultNS: platformI18n.options.defaultNS,
    fallbackNS: platformI18n.options.fallbackNS,
    initImmediate: false,
    interpolation: { escapeValue: false },
  });
  for (const [language, namespaces] of Object.entries(
    registration.locales ?? {},
  ))
    for (const [namespace, resource] of Object.entries(namespaces))
      translation.addResourceBundle(
        language,
        namespace,
        structuredClone(resource),
        true,
        true,
      );

  const queryClient = new QueryClient();
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });

  return function DevelopmentGameProviders({
    children,
  }: {
    readonly children: ReactNode;
  }): React.JSX.Element {
    return (
      <QueryClientProvider client={queryClient}>
        <RouterContextProvider router={router}>
          <I18nextProvider i18n={translation}>
            <GameClientProviders registration={registration}>
              {children}
            </GameClientProviders>
          </I18nextProvider>
        </RouterContextProvider>
      </QueryClientProvider>
    );
  };
}
