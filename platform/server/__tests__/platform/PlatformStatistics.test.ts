import { describe, expect, it } from 'vitest';
import {
  type GameCapabilityRegistration,
  GameCapabilityRegistry,
  GameCapabilityService,
} from '@/platform/capabilities/index.js';

const registration: GameCapabilityRegistration = {
  metadata: {
    gameId: 'chronologic',
    name: 'Chronologic',
    description: 'A registered game',
    themeId: 'chronologic',
  },
  releaseId: 'chronologic-v1',
  capabilities: ['profile'],
  policyVersions: [],
  assets: [],
  profile: { read: async () => ({}) },
  statistics: { read: async () => ({ games: 12, completions: 8 }) },
};

describe('registered game statistics', () => {
  it('reads bounded operator statistics from the exact pinned release', async () => {
    const registry = new GameCapabilityRegistry().register(registration);
    const service = new GameCapabilityService({ registry });
    await expect(
      service.getStatistics('chronologic', 'chronologic-v1'),
    ).resolves.toEqual({ games: 12, completions: 8 });
    await expect(
      service.getStatistics('chronologic', 'missing'),
    ).rejects.toMatchObject({ envelope: { code: 'NOT_FOUND' } });
  });

  it('rejects statistics reads when the game did not register one', async () => {
    const registry = new GameCapabilityRegistry().register({
      ...registration,
      metadata: { ...registration.metadata, gameId: 'brass' },
      releaseId: 'brass-v1',
      statistics: undefined,
    });
    const service = new GameCapabilityService({ registry });
    await expect(
      service.getStatistics('brass', 'brass-v1'),
    ).rejects.toMatchObject({ envelope: { code: 'NOT_READY' } });
  });
});
