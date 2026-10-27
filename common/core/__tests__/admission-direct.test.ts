import { randomUUID } from 'node:crypto';
import type { AccessContext } from '@board-game/contracts';
import { GameHost, GameRegistry } from '@board-game/host';
import { MemoryStorageDriver } from '@board-game/storage';
import {
  sequentialTurnFixture,
  soloProgressPuzzleFixture,
} from '@board-game/testing/fixtures';
import { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdmissionCoordinator } from '../src/admission/AdmissionCoordinator.js';
import { MemoryAdmissionStore } from '../src/admission/memory.js';
import { PostgresAdmissionStore } from '../src/admission/postgres.js';
import type {
  AdmissionStore,
  DirectSessionInput,
  ReleaseBinding,
} from '../src/admission/types.js';

const access: AccessContext = {
  principalId: 'platform',
  authEpoch: 'direct-test',
  scopes: ['session:create', 'session:control'],
};
const databaseUrl = process.env.BGP_TEST_DATABASE_URL;
const cleanups: Array<() => Promise<void>> = [];

const directReplayFixture = {
  ...soloProgressPuzzleFixture,
  gameId: 'fixture-solo-replay',
  releaseId: 'fixture-solo-replay-v1',
  modes: soloProgressPuzzleFixture.modes.map((mode, index) =>
    index === 0 ? { ...mode, history: 'summary-and-replay' as const } : mode,
  ) as typeof soloProgressPuzzleFixture.modes,
};

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function input(
  modeId: 'solo-progress' | 'solo-result' = 'solo-progress',
  requestId = 'direct-request-1',
): DirectSessionInput {
  return {
    gameId: soloProgressPuzzleFixture.gameId,
    modeId,
    releaseId: soloProgressPuzzleFixture.releaseId,
    setup: { levelId: 'level-1' },
    requestId,
  };
}

function replayInput(requestId = 'direct-replay-request'): DirectSessionInput {
  return {
    gameId: directReplayFixture.gameId,
    modeId: 'solo-progress',
    releaseId: directReplayFixture.releaseId,
    setup: { levelId: 'level-1' },
    requestId,
  };
}

function setup(store: AdmissionStore) {
  const gameStore = new MemoryStorageDriver();
  const backend = new GameHost({
    registry: new GameRegistry()
      .register(soloProgressPuzzleFixture)
      .register(directReplayFixture)
      .register(sequentialTurnFixture),
    storage: gameStore,
    backendBindingId: 'direct-backend',
    storageBindingId: 'direct-storage',
    authorize: async () => undefined,
    now: () => 100,
  });
  let id = 0;
  const binding = (
    gameId: string,
    modeId: string,
    releaseId: string,
  ): ReleaseBinding => {
    const module =
      gameId === soloProgressPuzzleFixture.gameId
        ? soloProgressPuzzleFixture
        : gameId === directReplayFixture.gameId
          ? directReplayFixture
          : sequentialTurnFixture;
    const mode = module.modes.find((candidate) => candidate.id === modeId);
    if (!mode || module.releaseId !== releaseId)
      throw new Error(`unknown fixture mode ${gameId}/${modeId}`);
    return {
      gameId,
      releaseId,
      mode,
      backendBindingId: 'direct-backend',
      storageBindingId: 'direct-storage',
      ownershipEpoch: 'direct-owner',
      backend,
      validateSetup: () => undefined,
    };
  };
  const makeCoordinator = () =>
    new AdmissionCoordinator({
      store,
      now: () => 100,
      newId: () => `id-${++id}`,
      resolveRelease: binding,
      resolveBackend: () => backend,
      authorize: async () => true,
      freezePolicy: async () => ({
        rating: null,
        validityPolicyVersion: 'direct-v1',
      }),
      accessForStart: async (operation) => ({
        ...access,
        principalId: operation.initiatedBy,
      }),
    });
  return {
    backend,
    gameStore,
    coordinator: makeCoordinator(),
    makeCoordinator,
  };
}

describe.each(['memory', ...(databaseUrl ? ['postgres'] : [])])(
  'direct admission (%s)',
  (driver) => {
    let store: AdmissionStore;
    beforeEach(async () => {
      if (driver === 'memory') {
        store = new MemoryAdmissionStore();
        return;
      }
      const schema = `direct_test_${randomUUID().replaceAll('-', '')}`;
      const pool = new Pool({ connectionString: databaseUrl });
      const postgres = new PostgresAdmissionStore({ pool, schema });
      await postgres.migrate();
      await postgres.validateSchema();
      store = postgres;
      cleanups.push(async () => {
        await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
        await pool.end();
      });
    });

    it('freezes a platform preset seed through Host creation and retry without changing setup', async () => {
      const fixture = setup(store);
      const request = { ...input(), seed: 'same-board-for-every-player' };
      const original = fixture.backend.createSession.bind(fixture.backend);
      const create = vi.spyOn(fixture.backend, 'createSession');
      create.mockImplementationOnce(async (value) => {
        await original(value);
        throw new Error('lost reply');
      });
      await expect(
        fixture.coordinator.createDirectSession('alice', request),
      ).rejects.toThrow('lost reply');
      const started = await fixture
        .makeCoordinator()
        .createDirectSession('alice', request);
      expect((await store.getStart(started.roomId))?.seed).toBe(request.seed);
      expect(create.mock.calls.map(([value]) => value.seed)).toEqual([
        request.seed,
        request.seed,
      ]);
      expect(create.mock.calls[0]?.[0].setup).toEqual(input().setup);
      await expect(
        fixture.coordinator.createDirectSession('alice', {
          ...request,
          seed: 'changed',
        }),
      ).rejects.toMatchObject({ envelope: { code: 'IDEMPOTENCY_CONFLICT' } });
    });

    it('is durable and idempotent without creating a second session', async () => {
      const fixture = setup(store);
      const started = await fixture.coordinator.createDirectSession(
        'alice',
        input(),
      );
      const duplicate = await fixture.coordinator.createDirectSession(
        'alice',
        input(),
      );

      expect(duplicate).toEqual(started);
      expect(await store.getRoom(started.roomId)).toMatchObject({
        status: 'started',
        visibility: 'private',
        members: [
          {
            principalId: 'alice',
            seatId: expect.stringMatching(/^direct-seat:/),
          },
        ],
      });
      expect(await store.getAdmission(started.sessionId)).toMatchObject({
        participants: [{ principalId: 'alice' }],
        rating: null,
      });
      expect(
        (await fixture.gameStore.readOutboxBatch({ limit: 10 })).map(
          (record) => record.kind,
        ),
      ).toEqual(['SessionCreated', 'SessionActivated']);
      await expect(
        fixture.coordinator.createDirectSession('alice', {
          ...input(),
          setup: { levelId: 'different-level' },
        }),
      ).rejects.toMatchObject({
        envelope: { code: 'IDEMPOTENCY_CONFLICT' },
      });
    });

    it('recovers a lost create acknowledgement with the same session', async () => {
      const fixture = setup(store);
      const originalCreate = fixture.backend.createSession.bind(
        fixture.backend,
      );
      vi.spyOn(fixture.backend, 'createSession').mockImplementationOnce(
        async (request) => {
          await originalCreate(request);
          throw new Error('create reply lost');
        },
      );
      await expect(
        fixture.coordinator.createDirectSession('alice', input()),
      ).rejects.toThrow('create reply lost');
      const pending = await store.listPending(10);
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({ state: 'creating' });
      if (!pending[0]) throw new Error('missing pending direct start');

      const recovered = await fixture
        .makeCoordinator()
        .createDirectSession('alice', input());
      expect(recovered).toMatchObject({
        state: 'active',
        roomId: pending[0].roomId,
        sessionId: pending[0].sessionId,
        startId: pending[0].startId,
      });
      expect(
        (await fixture.gameStore.readOutboxBatch({ limit: 10 })).map(
          (record) => record.kind,
        ),
      ).toEqual(['SessionCreated', 'SessionActivated']);
    });

    it('preserves a direct mode declared with summary-and-replay history', async () => {
      const fixture = setup(store);
      const started = await fixture.coordinator.createDirectSession(
        'alice',
        replayInput(),
      );
      const response = await fixture.backend.submitCommand({
        protocolVersion: 1,
        accessContext: {
          principalId: 'alice',
          authEpoch: 'direct-player',
          scopes: ['session:command', 'session:view'],
        },
        route: started.route,
        commandId: 'replay-answer-1',
        precondition: { kind: 'revision', expectedRevision: 1 },
        command: { type: 'answer', answer: 'wrong-answer' },
      });
      expect(response.receipt.resultRetention).toBe('replayable');
    });

    it('rejects multiplayer room modes before persisting a synthetic room', async () => {
      const fixture = setup(store);
      await expect(
        fixture.coordinator.createDirectSession('alice', {
          gameId: sequentialTurnFixture.gameId,
          modeId: sequentialTurnFixture.modes[0]?.id ?? 'sequential',
          releaseId: sequentialTurnFixture.releaseId,
          setup: { target: 2 },
          requestId: 'invalid-multiplayer',
        }),
      ).rejects.toMatchObject({ envelope: { code: 'INVALID_REQUEST' } });
      expect(await store.listPending(10)).toEqual([]);
    });
  },
);
