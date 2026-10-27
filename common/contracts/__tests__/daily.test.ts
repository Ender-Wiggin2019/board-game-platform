import { describe, expect, it } from 'vitest';
import {
  assertDailyChallengeServiceRequest,
  assertDailyChallengeServiceResponse,
  assertGameServiceDailyChallengeDescription,
} from '../src/index.js';

const settingsSchema = {
  name: 'daily.settings',
  version: 1,
  schema: {
    type: 'object' as const,
    properties: {
      preset: { type: 'string' as const },
    },
    required: ['preset'],
    additionalProperties: false,
  },
};

const description = {
  modeId: 'daily',
  playerCount: 2,
  settingsSchema,
  defaultSettings: { preset: 'standard' },
  operations: [
    'validateSettings',
    'publicSettings',
    'prepare',
    'validateSetup',
    'participants',
    'score',
  ] as const,
};

const route = {
  gameId: 'fixture',
  modeId: 'daily',
  sessionId: 'daily-session',
  releaseId: 'fixture-v1',
  backendBindingId: 'backend-1',
  storageBindingId: 'storage-1',
  ownershipEpoch: 'epoch-1',
};

describe('daily service contract', () => {
  it('accepts descriptors with omitted optional timezone and validity policy', () => {
    expect(() =>
      assertGameServiceDailyChallengeDescription(description),
    ).not.toThrow();
  });

  it('rejects duplicate operations and validates participant request context', () => {
    expect(() =>
      assertGameServiceDailyChallengeDescription({
        ...description,
        operations: ['prepare', 'prepare'],
      }),
    ).toThrow();
    expect(() =>
      assertDailyChallengeServiceRequest({
        protocolVersion: 1,
        operation: 'participants',
        route,
        context: {
          principalId: 'player-1',
          attemptId: 'attempt-1',
          sessionId: route.sessionId,
          challengeDate: '2026-10-26',
          setup: { playerCount: 2 },
          settings: { preset: 'standard' },
        },
      }),
    ).not.toThrow();
  });

  it('accepts a bounded date-specific prepare presentation', () => {
    expect(() =>
      assertDailyChallengeServiceResponse({
        operation: 'prepare',
        seed: 'daily:2026-10-27',
        setup: { scenario: 'daily' },
        publicSettings: {
          rivalDifficulty: 5,
          organizationIds: ['cosmos-strategy-group'],
        },
      }),
    ).not.toThrow();
  });

  it('rejects an invalid or unexpected prepare presentation', () => {
    expect(() =>
      assertDailyChallengeServiceResponse({
        operation: 'prepare',
        seed: 'daily:2026-10-27',
        setup: {},
        publicSettings: undefined,
      }),
    ).toThrow();
    expect(() =>
      assertDailyChallengeServiceResponse({
        operation: 'prepare',
        seed: 'daily:2026-10-27',
        setup: {},
        publicSettings: { candidatePool: ['hidden-id'] },
        unexpected: true,
      }),
    ).toThrow();
  });
});
