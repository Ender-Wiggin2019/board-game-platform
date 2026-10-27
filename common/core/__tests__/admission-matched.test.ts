import type { AccessContext } from '@board-game/contracts';
import { GameHost, GameRegistry } from '@board-game/host';
import { MemoryStorageDriver } from '@board-game/storage';
import { sequentialTurnFixture } from '@board-game/testing/fixtures';
import { describe, expect, it, vi } from 'vitest';
import { AdmissionCoordinator } from '../src/admission/AdmissionCoordinator.js';
import { MemoryAdmissionStore } from '../src/admission/memory.js';
import type {
  MatchedSessionInput,
  ReleaseBinding,
} from '../src/admission/types.js';

const access: AccessContext = {
  principalId: 'platform',
  authEpoch: 'matched-test',
  scopes: ['session:create', 'session:control'],
};

function setup(
  rated = true,
  entry: 'room' | 'direct-solo' = 'room',
  directCapacity: readonly [number, number] = [1, 1],
) {
  const originalMode = sequentialTurnFixture.modes[0];
  if (!originalMode) throw new Error('sequential fixture mode missing');
  const mode =
    entry === 'direct-solo'
      ? {
          ...originalMode,
          id: 'direct-solo',
          entry,
          minPlayers: directCapacity[0],
          maxPlayers: directCapacity[1],
          platformRating: false,
        }
      : { ...originalMode, platformRating: rated };
  const store = new MemoryAdmissionStore();
  const gameStore = new MemoryStorageDriver();
  const backend = new GameHost({
    registry: new GameRegistry().register({
      ...sequentialTurnFixture,
      modes: [mode],
    }),
    storage: gameStore,
    backendBindingId: 'matched-backend',
    storageBindingId: 'matched-storage',
    authorize: async () => undefined,
    now: () => 100,
    automationPolicies: [
      {
        id: 'fixture-ai',
        kind: 'ai',
        label: 'AI',
        timeoutMs: 1000,
        decide: () => ({ type: 'claim' }),
      },
    ],
  });
  let id = 0;
  const binding: ReleaseBinding = {
    gameId: sequentialTurnFixture.gameId,
    releaseId: sequentialTurnFixture.releaseId,
    mode,
    backendBindingId: 'matched-backend',
    storageBindingId: 'matched-storage',
    ownershipEpoch: 'matched-owner',
    backend,
    validateSetup: () => undefined,
  };
  const coordinator = new AdmissionCoordinator({
    store,
    now: () => 100,
    newId: () => `generated-${++id}`,
    resolveRelease: () => binding,
    resolveBackend: () => backend,
    authorize: async () => true,
    freezePolicy: async () => ({
      rating: {
        poolId: 'fixture-pool',
        policyVersion: 'fixture-skill-v1',
        progressionPolicyVersion: 'fixture-progress-v1',
        seasonId: null,
      },
      validityPolicyVersion: 'fixture-v1',
    }),
    accessForStart: async (operation) => ({
      ...access,
      principalId: operation.initiatedBy,
    }),
  });
  const input: MatchedSessionInput = {
    roomId: 'arena:request-1',
    sessionId: 'arena-session-1',
    requestId: 'request-1',
    gameId: sequentialTurnFixture.gameId,
    modeId: mode.id,
    releaseId: sequentialTurnFixture.releaseId,
    setup: { target: 2 },
    seed: 'arena-seed-1',
    participants: [
      { principalId: 'alice', seatId: 'seat-a' },
      { principalId: 'bob', seatId: 'seat-b' },
    ],
    policy: {
      rating: {
        poolId: 'fixture-pool',
        policyVersion: 'fixture-skill-v1',
        progressionPolicyVersion: 'fixture-progress-v1',
        seasonId: null,
      },
      validityPolicyVersion: 'fixture-v1',
    },
  };
  return {
    store,
    gameStore,
    backend,
    coordinator,
    input: rated
      ? input
      : { ...input, policy: { ...input.policy, rating: null } },
  };
}

describe('trusted matched admission', () => {
  it('accepts one trusted human direct-solo match and is idempotent', async () => {
    const fixture = setup(false, 'direct-solo');
    const input: MatchedSessionInput = {
      ...fixture.input,
      participants: [{ principalId: 'alice', seatId: 'seat-a' }],
      policy: { ...fixture.input.policy, rating: null },
    };
    const started = await fixture.coordinator.createMatchedSession(input);
    expect(started.state).toBe('active');
    expect(await fixture.coordinator.createMatchedSession(input)).toEqual(
      started,
    );
    expect(await fixture.store.getAdmission(started.sessionId)).toMatchObject({
      participants: input.participants,
      rating: null,
    });
  });

  it('rejects unsafe direct-solo matched reservations', async () => {
    const direct = setup(false, 'direct-solo');
    const singleHuman = {
      ...direct.input,
      participants: [{ principalId: 'alice', seatId: 'seat-a' }],
      policy: { ...direct.input.policy, rating: null },
    } satisfies MatchedSessionInput;
    await expect(
      direct.coordinator.createMatchedSession({
        ...singleHuman,
        participants: [
          ...singleHuman.participants,
          { principalId: 'bob', seatId: 'seat-b' },
        ],
      }),
    ).rejects.toMatchObject({
      envelope: {
        code: 'INVALID_REQUEST',
        messageKey: 'platform.match.mode.invalid',
      },
    });
    await expect(
      direct.coordinator.createMatchedSession({
        ...singleHuman,
        participants: [
          {
            principalId: 'ai-1',
            seatId: 'seat-ai',
            controller: 'ai',
            controllerId: 'fixture-ai',
          },
        ],
      }),
    ).rejects.toMatchObject({
      envelope: {
        code: 'INVALID_REQUEST',
        messageKey: 'platform.match.controller',
      },
    });
    const rated = setup(true, 'direct-solo');
    await expect(
      rated.coordinator.createMatchedSession({
        ...rated.input,
        participants: [{ principalId: 'alice', seatId: 'seat-a' }],
      }),
    ).rejects.toMatchObject({
      envelope: {
        code: 'INVALID_REQUEST',
        messageKey: 'platform.match.mode.invalid',
      },
    });

    const invalidCapacity = setup(false, 'direct-solo', [1, 2]);
    await expect(
      invalidCapacity.coordinator.createMatchedSession({
        ...invalidCapacity.input,
        participants: [{ principalId: 'alice', seatId: 'seat-a' }],
        policy: { ...invalidCapacity.input.policy, rating: null },
      }),
    ).rejects.toMatchObject({
      envelope: {
        code: 'INVALID_REQUEST',
        messageKey: 'platform.match.mode.invalid',
      },
    });
  });

  it('starts a frozen non-rated human/AI challenge through the same Host lifecycle', async () => {
    const fixture = setup(false);
    const input: MatchedSessionInput = {
      ...fixture.input,
      seed: 'daily-2026-10-26',
      participants: [
        fixture.input.participants[0],
        {
          principalId: 'ai-1',
          seatId: 'seat-b',
          controller: 'ai',
          controllerId: 'fixture-ai',
        },
      ],
    };
    const started = await fixture.coordinator.createMatchedSession(input);
    expect(started.state).toBe('active');
    expect(await fixture.gameStore.getHead(started.sessionId)).toMatchObject({
      status: 'active',
      participants: input.participants,
    });
    expect(await fixture.store.getStart(started.roomId)).toMatchObject({
      seed: input.seed,
    });
    expect(await fixture.store.getAdmission(started.sessionId)).toMatchObject({
      rating: null,
      participants: input.participants,
    });
    expect(await fixture.coordinator.createMatchedSession(input)).toEqual(
      started,
    );
  });

  it('continues to reject AI ranked participants and mismatched rating policies', async () => {
    const fixture = setup();
    await expect(
      fixture.coordinator.createMatchedSession({
        ...fixture.input,
        participants: [
          fixture.input.participants[0],
          {
            principalId: 'ai-1',
            seatId: 'seat-b',
            controller: 'ai',
            controllerId: 'fixture-ai',
          },
        ],
      }),
    ).rejects.toMatchObject({
      envelope: {
        code: 'INVALID_REQUEST',
        messageKey: 'platform.match.controller',
      },
    });
    await expect(
      fixture.coordinator.createMatchedSession({
        ...fixture.input,
        policy: { ...fixture.input.policy, rating: null },
      }),
    ).rejects.toMatchObject({
      envelope: {
        code: 'INVALID_REQUEST',
        messageKey: 'platform.match.mode.invalid',
      },
    });
    expect(await fixture.store.getRoom(fixture.input.roomId)).toBeNull();
  });
  it('creates one private coordinator start and is idempotent', async () => {
    const fixture = setup();
    const started = await fixture.coordinator.createMatchedSession(
      fixture.input,
    );
    const duplicate = await fixture.coordinator.createMatchedSession(
      fixture.input,
    );

    expect(started).toEqual(duplicate);
    expect(await fixture.store.getRoom(started.roomId)).toMatchObject({
      status: 'started',
      visibility: 'private',
    });
    expect(await fixture.store.getAdmission(started.sessionId)).toMatchObject({
      route: started.route,
      participants: fixture.input.participants,
      rating: fixture.input.policy.rating,
    });
    expect(
      (await fixture.gameStore.readOutboxBatch({ limit: 10 })).map(
        (record) => record.kind,
      ),
    ).toEqual(['SessionCreated', 'SessionActivated']);
  });

  it('retries the same request after a lost Host create reply', async () => {
    const fixture = setup();
    const original = fixture.backend.createSession.bind(fixture.backend);
    vi.spyOn(fixture.backend, 'createSession').mockImplementationOnce(
      async (request) => {
        await original(request);
        throw new Error('create reply lost');
      },
    );
    await expect(
      fixture.coordinator.createMatchedSession(fixture.input),
    ).rejects.toThrow('create reply lost');

    const recovered = await fixture.coordinator.createMatchedSession(
      fixture.input,
    );
    expect(recovered).toMatchObject({
      state: 'active',
      roomId: fixture.input.roomId,
      sessionId: fixture.input.sessionId,
    });
    expect(
      (await fixture.gameStore.readOutboxBatch({ limit: 10 })).map(
        (record) => record.kind,
      ),
    ).toEqual(['SessionCreated', 'SessionActivated']);
  });

  it('rejects a changed trusted reservation without a second session', async () => {
    const fixture = setup();
    await fixture.coordinator.createMatchedSession(fixture.input);
    await expect(
      fixture.coordinator.createMatchedSession({
        ...fixture.input,
        setup: { target: 3 },
      }),
    ).rejects.toMatchObject({ envelope: { code: 'IDEMPOTENCY_CONFLICT' } });
    expect(
      (await fixture.gameStore.readOutboxBatch({ limit: 10 })).filter(
        (record) => record.kind === 'SessionCreated',
      ),
    ).toHaveLength(1);
  });
});
