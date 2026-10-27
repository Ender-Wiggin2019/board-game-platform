import type { CreateSessionRequest } from '@board-game/contracts';
import { MemoryStorageDriver } from '@board-game/storage';
import { sequentialTurnFixture } from '@board-game/testing/fixtures';
import { describe, expect, it } from 'vitest';
import { GameHost, GameRegistry } from '../src/index.js';

const create: CreateSessionRequest = {
  protocolVersion: 1,
  accessContext: {
    principalId: 'alice',
    scopes: ['session:create', 'session:command'],
    authEpoch: '1',
  },
  route: {
    gameId: sequentialTurnFixture.gameId,
    releaseId: sequentialTurnFixture.releaseId,
    modeId: 'sequential',
    sessionId: 'result-session',
    backendBindingId: 'test',
    storageBindingId: 'test',
    ownershipEpoch: '1',
  },
  startId: 'start-result',
  startGeneration: 1,
  seed: 'fixed',
  setup: { target: 1 },
  participants: [
    { principalId: 'alice', seatId: 'a' },
    { principalId: 'bob', seatId: 'b' },
  ],
};

describe('Host authoritative results', () => {
  it('atomically records complete standings and does not resettle a retried command', async () => {
    const storage = new MemoryStorageDriver();
    const host = new GameHost({
      registry: new GameRegistry().register(sequentialTurnFixture),
      storage,
      backendBindingId: 'test',
      storageBindingId: 'test',
      authorize: async () => undefined,
      now: () => 100,
    });
    await host.createSession(create);
    await host.activateSession(create);
    const command = {
      protocolVersion: 1 as const,
      accessContext: create.accessContext,
      route: create.route,
      commandId: 'finish',
      precondition: { kind: 'revision' as const, expectedRevision: 1 },
      command: { type: 'claim' },
    };
    await host.submitCommand(command);
    await host.submitCommand(command);
    const completed = (await storage.readOutboxBatch({ limit: 20 })).filter(
      (item) => item.kind === 'SessionCompleted',
    );
    expect(completed).toHaveLength(1);
    expect(completed[0].payload).toMatchObject({
      resultRevision: 1,
      endedAt: 102,
      result: {
        kind: 'competitive',
        rankGroups: [
          { teams: [{ participantIds: ['alice'] }] },
          { teams: [{ participantIds: ['bob'] }] },
        ],
      },
    });
  });

  it('rolls back a completion with missing participants before state, receipt or outbox commits', async () => {
    const storage = new MemoryStorageDriver();
    const host = new GameHost({
      registry: new GameRegistry().register({
        ...sequentialTurnFixture,
        result: () => ({
          kind: 'competitive',
          rankGroups: [{ teams: [{ participantIds: ['alice'] }] }],
        }),
      }),
      storage,
      backendBindingId: 'test',
      storageBindingId: 'test',
      authorize: async () => undefined,
    });
    await host.createSession(create);
    await host.activateSession(create);
    await expect(
      host.submitCommand({
        protocolVersion: 1,
        accessContext: create.accessContext,
        route: create.route,
        commandId: 'finish',
        precondition: { kind: 'revision', expectedRevision: 1 },
        command: { type: 'claim' },
      }),
    ).rejects.toMatchObject({ envelope: { code: 'INVALID_REQUEST' } });
    expect((await storage.getHead(create.route.sessionId))?.revision).toBe(1);
    expect(
      await storage.getReceipt(create.route.sessionId, 'finish'),
    ).toBeNull();
    expect(
      (await storage.readOutboxBatch({ limit: 20 })).some(
        (item) => item.kind === 'SessionCompleted',
      ),
    ).toBe(false);
  });
});
