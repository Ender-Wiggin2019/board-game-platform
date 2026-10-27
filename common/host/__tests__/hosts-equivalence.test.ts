import { randomUUID } from 'node:crypto';
import {
  type AccessContext,
  type CommandPrecondition,
  type CreateSessionRequest,
  type JsonValue,
  type SessionRoute,
  type SubmitCommandRequest,
} from '@board-game/contracts';
import {
  MemoryStorageDriver,
  PostgresStorageDriver,
  type StorageDriver,
} from '@board-game/storage';
import {
  createSoloProgressSolutionCommand,
  sequentialTurnFixture,
  simultaneousHiddenFixture,
  soloProgressFixture,
} from '@board-game/testing/fixtures';
import { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeModule } from '../src/GameRegistry.js';
import {
  EmbeddedBackendAdapter,
  GameHost,
  GameRegistry,
  HttpHostTransport,
  RemoteBackendAdapter,
} from '../src/index.js';

type StorageKind = 'memory' | 'postgres';
type FixtureModule =
  | typeof sequentialTurnFixture
  | typeof simultaneousHiddenFixture
  | typeof soloProgressFixture;

const databaseUrl = process.env.BGP_TEST_DATABASE_URL;
const serviceToken = 'real-game-host-equivalence-service-token-123456';
const scopes = [
  'session:create',
  'session:command',
  'session:view',
  'session:control',
];
const alice: AccessContext = {
  principalId: 'alice',
  scopes,
  authEpoch: 'auth-1',
};
const bob: AccessContext = {
  principalId: 'bob',
  scopes,
  authEpoch: 'auth-1',
};

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function registry(module: FixtureModule): GameRegistry {
  return new GameRegistry().register(module as unknown as RuntimeModule);
}

async function storage(
  kind: StorageKind,
  label: string,
): Promise<StorageDriver> {
  if (kind === 'memory') return new MemoryStorageDriver();
  const schema = `he_${label}_${randomUUID().replaceAll('-', '')}`;
  const pool = new Pool({ connectionString: databaseUrl });
  const store = new PostgresStorageDriver({ pool, schema });
  cleanups.push(async () => {
    try {
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await pool.end();
    }
  });
  await store.migrate();
  return store;
}

function routeFor(
  module: FixtureModule,
  modeId: string,
  sessionId: string,
): SessionRoute {
  return {
    gameId: module.gameId,
    modeId,
    sessionId,
    releaseId: module.releaseId,
    backendBindingId: 'equivalence-backend',
    storageBindingId: 'equivalence-storage',
    ownershipEpoch: 'owner-1',
  };
}

function createRequest(
  route: SessionRoute,
  participants: readonly { principalId: string; seatId: string }[],
  setup: JsonValue,
): CreateSessionRequest {
  return {
    protocolVersion: 1,
    accessContext: alice,
    route,
    startId: `start-${route.sessionId}`,
    startGeneration: 0,
    setup,
    participants,
    seed: `seed-${route.sessionId}`,
  };
}

function commandRequest(
  route: SessionRoute,
  accessContext: AccessContext,
  commandId: string,
  command: JsonValue,
  precondition: CommandPrecondition,
): SubmitCommandRequest {
  return {
    protocolVersion: 1,
    accessContext,
    route,
    commandId,
    precondition,
    command,
  };
}

function viewRequest(route: SessionRoute, accessContext: AccessContext) {
  return { protocolVersion: 1 as const, accessContext, route };
}

async function hostPair(
  module: FixtureModule,
  kind: StorageKind,
): Promise<{
  local: EmbeddedBackendAdapter;
  remote: RemoteBackendAdapter;
}> {
  const localHost = new GameHost({
    registry: registry(module),
    storage: await storage(kind, 'local'),
    backendBindingId: 'equivalence-backend',
    storageBindingId: 'equivalence-storage',
    authorize: async () => undefined,
    now: () => 100,
  });
  const remoteHost = new GameHost({
    registry: registry(module),
    storage: await storage(kind, 'remote'),
    backendBindingId: 'equivalence-backend',
    storageBindingId: 'equivalence-storage',
    authorize: async () => undefined,
    now: () => 100,
  });
  const transport = new HttpHostTransport({
    backend: remoteHost,
    serviceToken,
    allowedGameIds: [module.gameId],
    allowedScopes: scopes,
    tokenExpiresAt: Date.now() + 60_000,
  });
  const address = await transport.listen();
  cleanups.push(() => transport.close());
  return {
    local: new EmbeddedBackendAdapter(localHost),
    remote: new RemoteBackendAdapter({
      baseUrl: `http://127.0.0.1:${address.port}`,
      serviceToken,
      allowInsecureLocalhost: true,
    }),
  };
}

async function createAndActivate(
  pair: Awaited<ReturnType<typeof hostPair>>,
  request: CreateSessionRequest,
): Promise<void> {
  const localCreated = await pair.local.createSession(request);
  const remoteCreated = await pair.remote.createSession(request);
  expect(remoteCreated).toEqual(localCreated);
  const activation = {
    protocolVersion: 1 as const,
    accessContext: alice,
    route: request.route,
    startId: request.startId,
  };
  const localActivated = await pair.local.activateSession(activation);
  const remoteActivated = await pair.remote.activateSession(activation);
  expect(remoteActivated).toEqual(localActivated);
}

async function compareCommand(
  pair: Awaited<ReturnType<typeof hostPair>>,
  request: SubmitCommandRequest,
) {
  const local = await pair.local.submitCommand(request);
  const remote = await pair.remote.submitCommand(request);
  expect(remote).toEqual(local);
  return local;
}

const storageKinds: StorageKind[] = [
  'memory',
  ...(databaseUrl ? (['postgres'] as const) : []),
];

describe.each(storageKinds)(
  'real GameHost local/remote equivalence (%s)',
  (kind) => {
    it('keeps create, activate, command, retry, and view behavior equivalent', async () => {
      const pair = await hostPair(sequentialTurnFixture, kind);
      const route = routeFor(
        sequentialTurnFixture,
        'sequential',
        'equiv-sequential',
      );
      const request = createRequest(
        route,
        [
          { principalId: alice.principalId, seatId: 'seat-1' },
          { principalId: bob.principalId, seatId: 'seat-2' },
        ],
        { target: 2 },
      );
      await createAndActivate(pair, request);
      const command = commandRequest(
        route,
        alice,
        'command-sequential-1',
        { type: 'claim' },
        { kind: 'revision', expectedRevision: 1 },
      );
      const accepted = await compareCommand(pair, command);
      expect(accepted.receipt).toMatchObject({
        status: 'accepted',
        persistedRevision: 2,
      });
      const localRetry = await pair.local.submitCommand(command);
      const remoteRetry = await pair.remote.submitCommand(command);
      expect(remoteRetry).toEqual(localRetry);
      expect(localRetry.receipt.status).toBe('duplicate');
      const localView = await pair.local.getPlayerView(
        viewRequest(route, alice),
      );
      const remoteView = await pair.remote.getPlayerView(
        viewRequest(route, alice),
      );
      expect(remoteView).toEqual(localView);
      expect(localView.payload).toMatchObject({
        status: 'active',
        scores: { 'seat-1': 1 },
      });
    });

    it('keeps private simultaneous choices private and reveals them identically', async () => {
      const pair = await hostPair(simultaneousHiddenFixture, kind);
      const route = routeFor(
        simultaneousHiddenFixture,
        'simultaneous',
        'equiv-private',
      );
      const request = createRequest(
        route,
        [
          { principalId: alice.principalId, seatId: 'seat-1' },
          { principalId: bob.principalId, seatId: 'seat-2' },
        ],
        {},
      );
      await createAndActivate(pair, request);
      const prompt = {
        kind: 'prompt' as const,
        promptId: 'prompt-1',
        participantInputRevision: 0,
      };
      await compareCommand(
        pair,
        commandRequest(
          route,
          alice,
          'command-private-alice',
          { type: 'submit', choice: 'red' },
          prompt,
        ),
      );
      const firstEventRequest = {
        protocolVersion: 1 as const,
        accessContext: bob,
        route,
        afterSequence: 0,
        limit: 10,
      };
      const localBobEvents = await pair.local.getEvents(firstEventRequest);
      const remoteBobEvents = await pair.remote.getEvents(firstEventRequest);
      expect(remoteBobEvents).toEqual(localBobEvents);
      expect(localBobEvents.events[0]?.payload).toEqual({
        type: 'choice-submitted',
        seatId: 'seat-1',
        inputRevision: 1,
      });
      expect(JSON.stringify(localBobEvents)).not.toContain('"choice":"red"');
      const localBobView = await pair.local.getPlayerView(
        viewRequest(route, bob),
      );
      const remoteBobView = await pair.remote.getPlayerView(
        viewRequest(route, bob),
      );
      expect(remoteBobView).toEqual(localBobView);
      expect(JSON.stringify(localBobView.payload)).not.toContain('red');
      await compareCommand(
        pair,
        commandRequest(
          route,
          bob,
          'command-private-bob',
          { type: 'submit', choice: 'blue' },
          prompt,
        ),
      );
      const localRevealedEvents = await pair.local.getEvents({
        ...firstEventRequest,
        afterSequence: 1,
      });
      const remoteRevealedEvents = await pair.remote.getEvents({
        ...firstEventRequest,
        afterSequence: 1,
      });
      expect(remoteRevealedEvents).toEqual(localRevealedEvents);
      expect(localRevealedEvents.events.map((event) => event.sequence)).toEqual(
        [2, 3],
      );
      const localAliceView = await pair.local.getPlayerView(
        viewRequest(route, alice),
      );
      const remoteAliceView = await pair.remote.getPlayerView(
        viewRequest(route, alice),
      );
      expect(remoteAliceView).toEqual(localAliceView);
      expect(localAliceView.payload).toMatchObject({
        phase: 'revealed',
        revealedChoices: { 'seat-1': 'red', 'seat-2': 'blue' },
      });
    });

    it('keeps ephemeral solo completion terminal and retry-safe across both adapters', async () => {
      const pair = await hostPair(soloProgressFixture, kind);
      const route = routeFor(
        soloProgressFixture,
        'solo-progress',
        'equiv-solo',
      );
      const request = createRequest(
        route,
        [{ principalId: alice.principalId, seatId: 'seat-1' }],
        {},
      );
      await createAndActivate(pair, request);
      const command = commandRequest(
        route,
        alice,
        'command-solo-answer',
        createSoloProgressSolutionCommand(),
        { kind: 'revision', expectedRevision: 1 },
      );
      const completed = await compareCommand(pair, command);
      expect(completed.receipt).toMatchObject({
        status: 'accepted',
        persistedRevision: 2,
      });
      expect(completed.view?.payload).toMatchObject({
        completed: true,
        progress: 1,
      });
      const localSummary = await pair.local.getSessionSummary(
        viewRequest(route, alice),
      );
      const remoteSummary = await pair.remote.getSessionSummary(
        viewRequest(route, alice),
      );
      expect(remoteSummary).toEqual(localSummary);
      expect(localSummary.status).toBe('completed');
      await expect(
        pair.local.getPlayerView(viewRequest(route, alice)),
      ).rejects.toMatchObject({ envelope: { code: 'SESSION_CLOSED' } });
      await expect(
        pair.remote.getPlayerView(viewRequest(route, alice)),
      ).rejects.toMatchObject({ envelope: { code: 'SESSION_CLOSED' } });
      const localRetry = await pair.local.submitCommand(command);
      const remoteRetry = await pair.remote.submitCommand(command);
      expect(remoteRetry).toEqual(localRetry);
      expect(localRetry.receipt.status).toBe('duplicate');
    });
  },
);
