import { describe, expect, it } from 'vitest';
import {
  assertPlatformFeature,
  DEFAULT_PLATFORM_CONFIGURATION,
  normalizePlatformConfiguration,
} from '@/platform/platform-configuration.js';

describe('platform public configuration', () => {
  it('normalizes optional installation values without exposing deployment data', () => {
    expect(
      normalizePlatformConfiguration({
        brand: { name: 'Orbit Table' },
        features: { chat: false, rankings: true },
      }),
    ).toEqual({
      brand: { name: 'Orbit Table' },
      features: { chat: false, rankings: true },
    });
    expect(DEFAULT_PLATFORM_CONFIGURATION).toEqual({
      brand: { name: 'Board Game Utopia' },
      features: { chat: true, rankings: true },
    });
  });

  it('rejects disabled public features while leaving rating settlement unrelated', () => {
    const configuration = normalizePlatformConfiguration({
      features: { rankings: false },
    });
    try {
      assertPlatformFeature(configuration, 'rankings');
      throw new Error('expected rankings to be disabled');
    } catch (error) {
      expect(error).toMatchObject({
        envelope: {
          code: 'NOT_FOUND',
          messageKey: 'platform.feature.rankings.disabled',
        },
      });
    }
    expect(() => assertPlatformFeature(configuration, 'chat')).not.toThrow();
  });
});
