import { describe, expect, it } from 'vitest';
import { PublicConfigurationController } from '../src/public-configuration.controller.js';

describe('public platform configuration endpoint', () => {
  it('returns only the public brand and supported feature flags', () => {
    const controller = new PublicConfigurationController({
      brand: { name: 'Orbit Table' },
      features: { chat: false, rankings: true },
    });
    expect(controller.get()).toEqual({
      brand: { name: 'Orbit Table' },
      features: { chat: false, rankings: true },
    });
    expect(controller.get()).not.toHaveProperty('platformId');
    expect(controller.get()).not.toHaveProperty('databaseUrl');
  });
});
