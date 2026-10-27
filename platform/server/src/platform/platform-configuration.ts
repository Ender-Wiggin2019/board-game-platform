import { contractError } from '@board-game/contracts';

/**
 * `rankings` controls standard public rating/profile rankings. Daily challenge
 * leaderboards are a separate game capability and are not controlled by this
 * platform switch.
 */
export type PlatformFeature = 'chat' | 'rankings';

export interface PlatformPublicConfiguration {
  readonly brand: { readonly name: string };
  readonly features: {
    readonly chat: boolean;
    readonly rankings: boolean;
  };
}

export interface PlatformPublicConfigurationInput {
  readonly brand?: { readonly name?: string };
  readonly features?: {
    readonly chat?: boolean;
    readonly rankings?: boolean;
  };
}

export const DEFAULT_PLATFORM_CONFIGURATION: PlatformPublicConfiguration = {
  brand: { name: 'Board Game Utopia' },
  features: { chat: true, rankings: true },
};

export const PLATFORM_CONFIGURATION = Symbol('PLATFORM_CONFIGURATION');

export function normalizePlatformConfiguration(
  input: PlatformPublicConfigurationInput = {},
): PlatformPublicConfiguration {
  const name = input.brand?.name?.trim();
  return {
    brand: {
      name: name || DEFAULT_PLATFORM_CONFIGURATION.brand.name,
    },
    features: {
      chat: input.features?.chat ?? true,
      rankings: input.features?.rankings ?? true,
    },
  };
}

export function assertPlatformFeature(
  configuration: PlatformPublicConfiguration | undefined,
  feature: PlatformFeature,
): void {
  if ((configuration ?? DEFAULT_PLATFORM_CONFIGURATION).features[feature])
    return;
  throw contractError('NOT_FOUND', `platform.feature.${feature}.disabled`);
}
