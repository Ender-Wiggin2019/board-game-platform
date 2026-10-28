import { generateKeyPairSync } from 'node:crypto';
import {
  type AccessContext,
  type GameServiceDescription,
  type JsonObject,
  type SessionRoute,
} from '@board-game/contracts';
import { type InboxStore, MemoryInboxStore } from '@board-game/core';
import { type GameHostOptions, RemoteBackendAdapter } from '@board-game/host';
import { MemoryStorageDriver, type StorageDriver } from '@board-game/storage';
import { sequentialTurnFixture } from '@board-game/testing/fixtures';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createGameServerRunner,
  defineCommandService,
  defineGameServer,
  GAME_SERVICE_COMMAND_TYPE,
  type GameServerDefinition,
  type GameServerRunner,
  issuePlayerCredential,
} from '../src/index.js';
import { MemoryAuthorizationVersionStore } from '../src/player-credentials.js';

const serviceToken = 'runner-service-token-that-is-long-enough-for-tests';
const access: AccessContext = {
  principalId: 'p1',
  authEpoch: 'epoch-1',
  scopes: ['session:create', 'session:command', 'session:view'],
};

const serviceInputSchema = {
  name: 'runner.service-input',
  version: 1,
  schema: {
    type: 'object' as const,
    properties: {
      action: { type: 'string' as const, enum: ['claim'] },
    },
    required: ['action'],
    additionalProperties: false,
  },
};

const replayQuerySchema = {
  name: 'runner.replay-query',
  version: 1,
  schema: {
    type: 'object' as const,
    additionalProperties: true as const,
  },
};

const statisticsQuerySchema = {
  name: 'runner.statistics-query',
  version: 1,
  schema: {
    type: 'object' as const,
    properties: {
      range: { type: 'string' as const },
    },
    additionalProperties: false,
  },
};

const statisticsPayloadSchema = {
  name: 'runner.statistics-payload',
  version: 1,
  schema: {
    type: 'object' as const,
    properties: {
      total: { type: 'integer' as const, minimum: 0 },
    },
    required: ['total'],
    additionalProperties: false,
  },
};

const description: GameServiceDescription = {
  schemaVersion: 1,
  platformId: 'runner-test-platform',
  gameId: sequentialTurnFixture.gameId,
  releaseId: sequentialTurnFixture.releaseId,
  backendBindingId: 'runner-backend',
  storageBindingId: 'runner-storage',
  ownershipEpoch: 'runner-owner-1',
  metadata: {
    gameId: sequentialTurnFixture.gameId,
    name: 'Runner fixture',
    description: 'A game process runner fixture.',
    themeId: 'runner-fixture',
  },
  modes: sequentialTurnFixture.modes,
  setupSchema: sequentialTurnFixture.schemas.setup,
  replay: {
    manifestQuery: { type: 'runner-replay-manifest', eventLimit: 200 },
    framesQueryType: 'runner-replay-frames',
  },
  commands: [
    {
      key: 'claim',
      operation: 'command',
      inputSchema: serviceInputSchema,
    },
  ],
  statistics: {
    protocolVersion: 1,
    operations: [
      {
        key: 'personalSummary',
        audience: 'self',
        requestSchema: statisticsQuerySchema,
        responseSchema: statisticsPayloadSchema,
      },
    ],
  },
};

type RunnerDefinition = GameServerDefinition<
  Parameters<typeof sequentialTurnFixture.rules.create>[0] extends never
    ? never
    : ReturnType<typeof sequentialTurnFixture.rules.create>,
  Parameters<typeof sequentialTurnFixture.rules.create>[0],
  Parameters<typeof sequentialTurnFixture.rules.execute>[1],
  ReturnType<typeof sequentialTurnFixture.rules.project>,
  ReturnType<typeof sequentialTurnFixture.rules.projectEvent>,
  null,
  null,
  JsonObject,
  { readonly gameId: string; readonly releaseId: string },
  unknown
>;

const claimService = defineCommandService<
  JsonObject,
  { readonly type: 'claim' }
>({
  key: 'claim',
  operation: 'command',
  parse: (input) => input as JsonObject,
  toCommand: () => ({ type: 'claim' }),
});

const recovery = vi.fn(async () => undefined);

function definition(services: Record<string, unknown> = {}): RunnerDefinition {
  const statisticsDescription = description.statistics;
  if (!statisticsDescription) throw new Error('statistics fixture is missing');
  return defineGameServer({
    manifest: {
      gameId: sequentialTurnFixture.gameId,
      releaseId: sequentialTurnFixture.releaseId,
    },
    module: {
      ...sequentialTurnFixture,
      turn: () => null,
      schemas: { ...sequentialTurnFixture.schemas, query: replayQuerySchema },
      rules: {
        ...sequentialTurnFixture.rules,
        query: (_state: unknown, query: JsonObject): JsonObject => {
          if (query.type === 'runner-replay-manifest')
            return {
              type: 'runner-replay-manifest-answer',
              eventLimit:
                typeof query.eventLimit === 'number' ? query.eventLimit : 200,
            };
          if (query.type === 'runner-replay-frames')
            return {
              type: 'runner-replay-frames-answer',
              from: typeof query.from === 'number' ? query.from : 0,
              limit: typeof query.limit === 'number' ? query.limit : 1,
              frames: [],
            };
          return { type: 'runner-replay-unknown-answer' };
        },
      },
    } as unknown as RunnerDefinition['module'],
    services: {
      commands: [claimService],
      replay: {
        queries: {
          manifest: (eventLimit) => ({
            type: 'runner-replay-manifest',
            eventLimit,
          }),
          frames: (from, limit) => ({
            type: 'runner-replay-frames',
            from,
            limit,
          }),
        },
      },
      recovery: [{ key: 'runner:recovery:v1', recover: recovery }],
      statistics: {
        description: statisticsDescription,
        query: async () => ({
          operation: 'personalSummary',
          audience: 'self',
          payload: { total: 3 },
        }),
      },
      ...services,
    },
  }) as unknown as RunnerDefinition;
}

function systemAccess(route: SessionRoute): Promise<AccessContext> {
  return Promise.resolve({
    principalId: 'runner:system',
    authEpoch: `system:${route.ownershipEpoch}`,
    scopes: ['session:system'],
  });
}

function authorize(): GameHostOptions['authorize'] {
  return async () => undefined;
}

function runnerOptions(
  storage: StorageDriver,
  options: {
    readonly factReceiver?: NonNullable<
      Parameters<typeof createGameServerRunner>[0]
    >['factReceiver'];
    readonly inbox?: InboxStore;
    readonly mode?: 'development' | 'production';
    readonly now?: () => number;
    readonly services?: Record<string, unknown>;
  } = {},
) {
  return {
    definition: definition(options.services),
    storage,
    description,
    authorize: authorize(),
    systemAccess,
    mode: options.mode ?? 'development',
    ...(options.inbox ? { inbox: options.inbox } : {}),
    ...(options.factReceiver ? { factReceiver: options.factReceiver } : {}),
    ...(options.now ? { now: options.now } : {}),
    transport: {
      serviceToken,
      allowedScopes: ['*'],
      tokenExpiresAt: Date.now() + 60_000,
      host: '127.0.0.1',
      port: 0,
    },
  };
}

function createRequest(sessionId: string): {
  readonly protocolVersion: 1;
  readonly accessContext: AccessContext;
  readonly route: SessionRoute;
  readonly startId: string;
  readonly startGeneration: number;
  readonly setup: { readonly target: 1 };
  readonly participants: readonly {
    readonly principalId: string;
    readonly seatId: string;
  }[];
  readonly seed: string;
} {
  return {
    protocolVersion: 1,
    accessContext: access,
    route: {
      gameId: description.gameId,
      modeId: 'sequential',
      sessionId,
      releaseId: description.releaseId,
      backendBindingId: description.backendBindingId,
      storageBindingId: description.storageBindingId,
      ownershipEpoch: description.ownershipEpoch,
    },
    startId: `start-${sessionId}`,
    startGeneration: 1,
    setup: { target: 1 },
    participants: [
      { principalId: 'p1', seatId: 'seat-1' },
      { principalId: 'p2', seatId: 'seat-2' },
    ],
    seed: `seed-${sessionId}`,
  };
}

function remote(address: { readonly port: number }) {
  return new RemoteBackendAdapter({
    baseUrl: `http://127.0.0.1:${address.port}`,
    serviceToken,
    allowInsecureLocalhost: true,
  });
}

const runners: GameServerRunner[] = [];
beforeEach(() => {
  recovery.mockClear();
});
afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.close()));
});

describe('independent game server runner', () => {
  it('starts player and authorization transports independently of the service transport', async () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const authorizationStore = new MemoryAuthorizationVersionStore({
      now: () => 1_000,
    });
    const runner = createGameServerRunner({
      ...runnerOptions(new MemoryStorageDriver()),
      transport: undefined,
      playerTransport: {
        publicKey,
        platformId: description.platformId,
        audience: 'runner-player-service',
        authorizationStore,
        host: '127.0.0.1',
        port: 0,
      },
      authorizationTransport: {
        credentials: [
          {
            token: 'runner-authorization-service-token-long-enough',
            platformId: description.platformId,
          },
        ],
        host: '127.0.0.1',
        port: 0,
      },
    });
    runners.push(runner);
    await expect(runner.start()).resolves.toBeUndefined();
    expect(runner.transportAddress).toBeUndefined();
    expect(runner.playerTransportAddress?.port).toBeGreaterThan(0);
    expect(runner.authorizationTransportAddress?.port).toBeGreaterThan(0);
  });

  it('uses the same view credential for getPlayerView and resume', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const authorizationStore = new MemoryAuthorizationVersionStore({
      now: () => 1_000,
    });
    const runner = createGameServerRunner({
      ...runnerOptions(new MemoryStorageDriver(), { now: () => 1_000 }),
      transport: undefined,
      playerTransport: {
        publicKey,
        platformId: description.platformId,
        audience: 'runner-player-service',
        authorizationStore,
        host: '127.0.0.1',
        port: 0,
      },
    });
    runners.push(runner);
    await runner.start();
    const address = runner.playerTransportAddress;
    if (!address) throw new Error('Runner player transport did not start');

    const request = createRequest('runner-player-resume');
    await runner.backend.createSession(request);
    await runner.backend.activateSession({
      protocolVersion: 1,
      accessContext: access,
      route: request.route,
      startId: request.startId,
    });
    await authorizationStore.advance({
      platformId: description.platformId,
      sessionId: request.route.sessionId,
      principalId: 'p1',
      authenticatedPlatformId: description.platformId,
      route: request.route,
      seatId: 'seat-1',
      scopes: ['session:view'],
      authEpoch: 'player-epoch-1',
      authorizationRevision: 1,
    });
    const token = issuePlayerCredential({
      privateKey,
      platformId: description.platformId,
      audience: 'runner-player-service',
      route: request.route,
      principalId: 'p1',
      seatId: 'seat-1',
      scopes: ['session:view'],
      authEpoch: 'player-epoch-1',
      authorizationRevision: 1,
      now: 1_000,
      issuedAt: 1_000,
      expiresAt: 61_000,
    });
    const endpoint = `http://127.0.0.1:${address.port}`;
    const playerRequest = async (
      operation: 'getPlayerView' | 'resume' | 'submitCommand',
      body: unknown,
    ) => {
      const response = await fetch(`${endpoint}/v1/${operation}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ protocolVersion: 1, request: body }),
      });
      const payload = (await response.json()) as {
        readonly protocolVersion: number;
        readonly response?: JsonObject;
        readonly error?: JsonObject;
      };
      return { response, payload };
    };

    const viewRequest = {
      protocolVersion: 1,
      route: request.route,
    } as const;
    const view = await playerRequest('getPlayerView', viewRequest);
    expect(view.response.status).toBe(200);
    expect(view.payload.response).toMatchObject({
      viewEpoch: 'player-epoch-1',
    });
    const viewEnvelope = view.payload.response as {
      readonly viewEpoch: string;
      readonly streamCursor: string;
    };
    const resumed = await playerRequest('resume', {
      ...viewRequest,
      viewerEpoch: viewEnvelope.viewEpoch,
      streamCursor: viewEnvelope.streamCursor,
    });
    expect(resumed.response.status).toBe(200);
    expect(resumed.payload.response).toMatchObject({ kind: 'snapshot' });

    const commandWithViewCredential = await playerRequest('submitCommand', {
      ...viewRequest,
      commandId: 'view-credential-command',
      precondition: { kind: 'revision', expectedRevision: 0 },
      command: { type: 'claim' },
    });
    expect(commandWithViewCredential.response.status).toBe(403);
    expect(commandWithViewCredential.payload.error).toMatchObject({
      code: 'FORBIDDEN',
      messageKey: 'server.runner.player.scope_denied',
    });
  });

  it('rejects ephemeral storage and platform-owned service hooks', () => {
    expect(() =>
      createGameServerRunner({
        ...runnerOptions(new MemoryStorageDriver(), { mode: 'production' }),
      }),
    ).toThrow('server.runner.storage.durable_required');

    expect(() =>
      createGameServerRunner({
        ...runnerOptions(new MemoryStorageDriver(), {
          services: { platform: () => undefined },
        }),
      }),
    ).toThrow('server.runner.platform_unsupported');

    const development = runnerOptions(new MemoryStorageDriver());
    expect(() =>
      createGameServerRunner({
        ...development,
        transport: { ...development.transport, host: '0.0.0.0' },
      }),
    ).toThrow('server.runner.development_transport_loopback');
  });

  it('serves release-pinned statistics and rejects route, scope, and schema drift', async () => {
    const runner = createGameServerRunner(
      runnerOptions(new MemoryStorageDriver()),
    );
    runners.push(runner);
    const route = {
      gameId: description.gameId,
      releaseId: description.releaseId,
      backendBindingId: description.backendBindingId,
      storageBindingId: description.storageBindingId,
      ownershipEpoch: description.ownershipEpoch,
    };
    const request = {
      protocolVersion: 1 as const,
      route,
      operation: 'personalSummary',
      audience: 'self' as const,
      accessContext: {
        principalId: 'p1',
        authEpoch: 'epoch-1',
        scopes: ['statistics:read'],
      },
      query: { range: '30d' },
    };
    if (!runner.backend.statistics)
      throw new Error('statistics backend operation missing');
    await expect(runner.backend.statistics(request)).resolves.toEqual({
      operation: 'personalSummary',
      audience: 'self',
      payload: { total: 3 },
    });
    await expect(
      runner.backend.statistics({
        ...request,
        route: { ...route, ownershipEpoch: 'other-owner' },
      }),
    ).rejects.toMatchObject({
      envelope: { code: 'FORBIDDEN' },
    });
    await expect(
      runner.backend.statistics({
        ...request,
        accessContext: { ...request.accessContext, scopes: [] },
      }),
    ).rejects.toMatchObject({
      envelope: { code: 'FORBIDDEN' },
    });
    await expect(
      runner.backend.statistics({
        ...request,
        query: { unexpected: true },
      }),
    ).rejects.toMatchObject({
      envelope: { code: 'SCHEMA_VALIDATION_FAILED' },
    });
  });

  it('serves two HTTP game processes with isolated storage and mapped commands/replay', async () => {
    const storageA = new MemoryStorageDriver();
    const storageB = new MemoryStorageDriver();
    const runnerA = createGameServerRunner(runnerOptions(storageA));
    const runnerB = createGameServerRunner(runnerOptions(storageB));
    runners.push(runnerA, runnerB);
    const addressA = await runnerA.start();
    const addressB = await runnerB.start();
    if (!addressA || !addressB)
      throw new Error('Runner transport did not start');
    expect(runnerA.transportAddress?.port).toBe(addressA.port);
    expect(runnerB.transportAddress?.port).toBe(addressB.port);

    const backendA = remote(addressA);
    const backendB = remote(addressB);
    await expect(backendA.ready({ protocolVersion: 1 })).resolves.toMatchObject(
      {
        ready: true,
        description: { service: description },
      },
    );
    const requestA = createRequest('runner-http-a');
    const requestB = createRequest('runner-http-b');
    await backendA.createSession(requestA);
    await backendB.createSession(requestB);
    await backendA.activateSession({
      protocolVersion: 1,
      accessContext: access,
      route: requestA.route,
      startId: requestA.startId,
    });
    await backendB.activateSession({
      protocolVersion: 1,
      accessContext: access,
      route: requestB.route,
      startId: requestB.startId,
    });

    const command = {
      protocolVersion: 1 as const,
      accessContext: access,
      route: requestA.route,
      commandId: 'runner-service-command-a',
      precondition: { kind: 'revision' as const, expectedRevision: 1 },
      command: {
        type: GAME_SERVICE_COMMAND_TYPE,
        key: 'claim',
        input: { action: 'claim' },
      },
    };
    await expect(backendA.submitCommand(command)).resolves.toMatchObject({
      receipt: { status: 'accepted' },
    });
    const summary = await backendA.getSessionSummary({
      protocolVersion: 1,
      accessContext: access,
      route: requestA.route,
    });
    expect(summary.status).toBe('completed');
    const completedFact = (await storageA.readOutboxBatch({ limit: 100 })).find(
      (fact) => fact.kind === 'SessionCompleted',
    );
    expect(completedFact?.payload).toMatchObject({
      replayRef: {
        platformId: description.platformId,
        gameId: requestA.route.gameId,
        sessionId: requestA.route.sessionId,
        replayId: requestA.route.sessionId,
        releaseId: requestA.route.releaseId,
        storageBindingId: requestA.route.storageBindingId,
        formatVersion: 1,
      },
    });
    const replayDescription = description.replay;
    if (!replayDescription) throw new Error('Replay description is required');
    const replay = await backendA.queryOptions({
      protocolVersion: 1,
      accessContext: access,
      route: requestA.route,
      revision: summary.sourceRevision,
      query: replayDescription.manifestQuery,
    });
    expect(replay.answer).toEqual({
      type: 'runner-replay-manifest-answer',
      eventLimit: 200,
    });
    const frames = await backendA.queryOptions({
      protocolVersion: 1,
      accessContext: access,
      route: requestA.route,
      revision: summary.sourceRevision,
      query: { type: 'runner-replay-frames', from: 0, limit: 1 },
    });
    expect(frames.answer).toEqual({
      type: 'runner-replay-frames-answer',
      from: 0,
      limit: 1,
      frames: [],
    });

    expect(await storageA.getHead(requestB.route.sessionId)).toBeNull();
    expect(await storageB.getHead(requestA.route.sessionId)).toBeNull();
  });

  it('accepts outgoing facts in the local Inbox before running external consumers', async () => {
    const consume = vi.fn(async () => undefined);
    const inbox = new MemoryInboxStore();
    const storage = new MemoryStorageDriver();
    const runner = createGameServerRunner(
      runnerOptions(storage, {
        inbox,
        services: {
          facts: [{ key: 'runner:fact:v1', consume }],
        },
      }),
    );
    runners.push(runner);

    const request = createRequest('runner-local-facts');
    await runner.backend.createSession(request);
    await runner.backend.activateSession({
      protocolVersion: 1,
      accessContext: access,
      route: request.route,
      startId: request.startId,
    });
    await runner.backend.submitCommand({
      protocolVersion: 1,
      accessContext: access,
      route: request.route,
      commandId: 'runner-local-facts-command',
      precondition: { kind: 'revision', expectedRevision: 1 },
      command: { type: 'claim' },
    });

    const report = await runner.recoverOnce();
    expect(report.outbox).toMatchObject({ delivered: 4, failed: 0 });
    expect(report.facts).toEqual([
      expect.objectContaining({
        consumerKey: 'runner:fact:v1',
        processed: 4,
      }),
    ]);
    expect(consume).toHaveBeenCalledTimes(4);
  });

  it('retries durable outbox facts and runs recovery hooks', async () => {
    let now = 10_000;
    let failOnce = true;
    const deliveries: string[] = [];
    const receiverOrder: string[] = [];
    const inbox = new MemoryInboxStore();
    const accept = inbox.accept.bind(inbox);
    vi.spyOn(inbox, 'accept').mockImplementation(async (fact) => {
      receiverOrder.push('local');
      return accept(fact);
    });
    const receiver = {
      ingest: async (delivery: {
        readonly fact: {
          readonly producerId: string;
          readonly eventId: string;
        };
      }) => {
        receiverOrder.push('remote');
        if (failOnce) {
          failOnce = false;
          throw new Error('temporary receiver failure');
        }
        deliveries.push(delivery.fact.eventId);
        return {
          envelopeKey: delivery.fact.eventId,
          producerId: delivery.fact.producerId,
          eventId: delivery.fact.eventId,
          digest: 'digest',
        };
      },
    };
    const storage = new MemoryStorageDriver();
    const runner = createGameServerRunner(
      runnerOptions(storage, {
        factReceiver: receiver,
        inbox,
        now: () => now,
      }),
    );
    runners.push(runner);
    const address = await runner.start();
    if (!address) throw new Error('Runner transport did not start');
    const backend = remote(address);
    const request = createRequest('runner-outbox');
    await backend.createSession(request);
    await backend.activateSession({
      protocolVersion: 1,
      accessContext: access,
      route: request.route,
      startId: request.startId,
    });
    await backend.submitCommand({
      protocolVersion: 1,
      accessContext: access,
      route: request.route,
      commandId: 'runner-outbox-command',
      precondition: { kind: 'revision', expectedRevision: 1 },
      command: { type: 'claim' },
    });

    const first = await runner.recoverOnce();
    expect(receiverOrder.slice(0, 2)).toEqual(['local', 'remote']);
    expect(first.outbox).toMatchObject({ failed: 1, delivered: 3 });
    expect(first.recovery).toEqual([
      { key: 'runner:recovery:v1', failed: false },
    ]);
    expect(recovery).toHaveBeenCalledTimes(1);

    now += 2_000;
    const second = await runner.recoverOnce();
    expect(second.outbox).toMatchObject({ failed: 0, delivered: 1 });
    expect(deliveries.length).toBe(4);
    expect(recovery).toHaveBeenCalledTimes(2);
    await expect(runner.recoverAutomationOnce()).resolves.toEqual([]);
  });

  it('waits for in-flight recovery before closing the game resources', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const recover = vi.fn(async () => gate);
    const runner = createGameServerRunner(
      runnerOptions(new MemoryStorageDriver(), {
        services: {
          recovery: [{ key: 'runner:close-recovery:v1', recover }],
        },
      }),
    );
    runners.push(runner);

    const recovering = runner.recoverOnce();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(recover).toHaveBeenCalledTimes(1);
    let closed = false;
    const closing = runner.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);

    release();
    await recovering;
    await closing;
    expect(closed).toBe(true);
  });
});
