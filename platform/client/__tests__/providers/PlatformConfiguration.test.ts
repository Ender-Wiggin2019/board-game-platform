import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PLATFORM_CONFIGURATION,
  parsePlatformConfiguration,
} from '@/providers/PlatformConfiguration.js';

describe('platform public configuration', () => {
  it('parses the runtime brand and feature gates', () => {
    expect(
      parsePlatformConfiguration({
        brand: { name: 'Orbit Table' },
        features: { chat: false, rankings: true },
        platformId: 'must-not-be-consumed',
      }),
    ).toEqual({
      brand: { name: 'Orbit Table' },
      features: { chat: false, rankings: true },
    });
  });

  it('falls back to the legacy defaults for malformed or missing values', () => {
    expect(parsePlatformConfiguration(null)).toEqual(
      DEFAULT_PLATFORM_CONFIGURATION,
    );
    expect(parsePlatformConfiguration({ brand: { name: ' ' } })).toEqual(
      DEFAULT_PLATFORM_CONFIGURATION,
    );
  });
});
