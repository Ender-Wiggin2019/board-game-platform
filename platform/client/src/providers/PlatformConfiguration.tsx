import { createContext, useContext } from 'react';

export interface PlatformPublicConfiguration {
  readonly brand: { readonly name: string };
  readonly features: {
    readonly chat: boolean;
    readonly rankings: boolean;
  };
}

export const DEFAULT_PLATFORM_CONFIGURATION: PlatformPublicConfiguration = {
  brand: { name: 'Board Game Utopia' },
  features: { chat: true, rankings: true },
};

const PlatformConfigurationContext = createContext<PlatformPublicConfiguration>(
  DEFAULT_PLATFORM_CONFIGURATION,
);

export function PlatformConfigurationProvider({
  value,
  children,
}: {
  readonly value: PlatformPublicConfiguration;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <PlatformConfigurationContext.Provider value={value}>
      {children}
    </PlatformConfigurationContext.Provider>
  );
}

export function usePlatformConfiguration(): PlatformPublicConfiguration {
  return useContext(PlatformConfigurationContext);
}

/** Keep the existing localized name when the installation uses the default brand. */
export function resolvePlatformBrandName(
  configuration: PlatformPublicConfiguration,
  localizedDefault: string,
): string {
  return configuration.brand.name === DEFAULT_PLATFORM_CONFIGURATION.brand.name
    ? localizedDefault
    : configuration.brand.name;
}

export function parsePlatformConfiguration(
  value: unknown,
): PlatformPublicConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return DEFAULT_PLATFORM_CONFIGURATION;
  const candidate = value as Record<string, unknown>;
  const brand =
    candidate.brand && typeof candidate.brand === 'object'
      ? (candidate.brand as Record<string, unknown>)
      : undefined;
  const features =
    candidate.features && typeof candidate.features === 'object'
      ? (candidate.features as Record<string, unknown>)
      : undefined;
  const name = typeof brand?.name === 'string' ? brand.name.trim() : '';
  return {
    brand: {
      name: name || DEFAULT_PLATFORM_CONFIGURATION.brand.name,
    },
    features: {
      chat:
        typeof features?.chat === 'boolean'
          ? features.chat
          : DEFAULT_PLATFORM_CONFIGURATION.features.chat,
      rankings:
        typeof features?.rankings === 'boolean'
          ? features.rankings
          : DEFAULT_PLATFORM_CONFIGURATION.features.rankings,
    },
  };
}
