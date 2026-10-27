import {
  contractError,
  type GameServiceDescription,
  type JsonValue,
  type MatchAdmission,
  type PlatformRoom,
  type SessionRoute,
} from '@board-game/contracts';
import {
  MemoryAdmissionStore,
  MemoryInboxStore,
  MemorySessionDirectory,
  type PlatformIdentityReference,
  type ResolvedIdentity,
  type StartOperation,
} from '@board-game/core';
import {
  GameHost,
  GameRegistry,
  HttpHostTransport,
  RemoteBackendAdapter,
  type SystemTickResult,
} from '@board-game/host';
import { defineGame, type GameModule } from '@board-game/sdk';
import { MemoryStorageDriver } from '@board-game/storage';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { MemoryCompletionRecordStore } from '@/platform/CompletionRecordStore.js';
import {
  GameAccessService,
  MemoryGameAccessStore,
} from '@/platform/game-access/index.js';
import { PlatformApplicationRuntime } from '@/platform/PlatformApplicationRuntime.js';
import type { PlatformIdentity } from '@/platform/PlatformIdentity.js';

type State = { owner: string; count: number };
function gameModule(gameId: string, includeRoom = false) {
  const objectSchema = {
    schema: { type: 'object' as const, additionalProperties: true as const },
    version: 1,
  };
  const module: GameModule<
    State,
    JsonValue,
    JsonValue,
    JsonValue,
    JsonValue,
    JsonValue,
    JsonValue
  > = {
    gameId,
    releaseId: `${gameId}-v1`,
    stateSchemaVersion: 1,
    viewSchemaVersion: 1,
    modes: [
      {
        id: 'solo',
        entry: 'direct-solo',
        minPlayers: 1,
        maxPlayers: 1,
        history: 'summary-and-replay',
        platformRating: false,
        concurrency: 'revision',
      },
      ...(includeRoom
        ? [
            {
              id: 'room',
              entry: 'room' as const,
              minPlayers: 1,
              maxPlayers: 2,
              history: 'summary-and-replay' as const,
              platformRating: false,
              concurrency: 'revision' as const,
            },
          ]
        : []),
    ],
    schemas: {
      setup: { ...objectSchema, name: 'test.setup' },
      command: { ...objectSchema, name: 'test.command' },
      result: { ...objectSchema, name: 'test.result' },
    },
    rules: {
      create: (_setup, context) => ({
        owner: context.participants[0]?.principalId,
        count: 0,
      }),
      execute: (state) => ({
        ok: true,
        state: { ...state, count: state.count + 1 },
        events: [{ advanced: true }],
      }),
      project: (state) => ({ count: state.count }),
      projectEvent: (event) => event,
      encode: (state) => ({ ...state }),
      decode: (saved) => saved as State,
    },
    summarize: (state) => ({ count: state.count }),
    turn: (state, { participants }) =>
      state.count >= 1
        ? null
        : {
            id: `count:${state.count}`,
            mode: 'sequential',
            activeSeatIds: participants.slice(0, 1).map((seat) => seat.seatId),
          },
    completion: (state) => ({ finished: state.count >= 1 }),
    result: (state) => ({
      kind: 'solo',
      participantIds: [state.owner],
      outcome: 'completed',
    }),
    collectFacts: () => [],
  };
  return defineGame(module);
}
function identity(gameId: string) {
  return {
    resolve: async (reference: PlatformIdentityReference) => ({
      principalId: reference.principalId,
      authEpoch: 'active',
      active: true,
    }),
    authorize: async (principal: ResolvedIdentity, admission: MatchAdmission) =>
      admission.route.gameId === gameId &&
      admission.participants.some(
        (member) => member.principalId === principal.principalId,
      ),
    authorizeRoom: async (
      principalId: string,
      room: PlatformRoom,
      action: string,
      access?: { grants: readonly { principalId: string; state: string }[] },
    ) =>
      room.gameId === gameId &&
      (action !== 'read-invitation' && action !== 'decline'
        ? true
        : access?.grants.some(
            (grant) =>
              grant.principalId === principalId && grant.state === 'pending',
          ) === true),
    authorizeRoomInvite: async () => true,
    publicNames: async (ids: readonly string[]) =>
      new Map(ids.map((id) => [id, id])),
    freezeParticipants: async (room: PlatformRoom) =>
      room.members.map((member) => ({
        principalId: member.principalId,
        seatId: member.seatId,
      })),
    accessScopes: async () => ['session:view', 'session:command'],
    startAccess: async (operation: StartOperation) => ({
      principalId: operation.initiatedBy,
      authEpoch: 'active',
      scopes: ['session:create', 'session:control'],
    }),
    authorizeHost: async (
      _access: unknown,
      _operation: unknown,
      route: SessionRoute,
    ) => {
      if (route.gameId !== gameId)
        throw contractError('FORBIDDEN', 'test.cross_game');
    },
  } as unknown as PlatformIdentity;
}
function runtime(
  gameIds: readonly string[] = ['alpha', 'beta'],
  accessGameId?: string,
  roomGameIds: readonly string[] = [],
) {
  const admissionStore = new MemoryAdmissionStore();
  const gameAccess = accessGameId
    ? new GameAccessService(new MemoryGameAccessStore())
    : undefined;
  const platform = new PlatformApplicationRuntime({
    platformId: 'test-platform',
    completionStore: new MemoryCompletionRecordStore({
      platformId: 'test-platform',
      admission: admissionStore,
    }),
    db: {} as NodePgDatabase,
    pool: {} as Pool,
    storage: new MemoryStorageDriver(),
    admissionStore,
    inbox: new MemoryInboxStore(),
    directory: new MemorySessionDirectory({
      admission: admissionStore,
      retentionResolver: () => 'summary-and-replay',
    }),
    ...(gameAccess ? { gameAccess } : {}),
  });
  vi.spyOn(platform.identity, 'resolve').mockImplementation(
    async (reference) => ({
      principalId: reference.principalId,
      authEpoch: 'active',
      active: true,
    }),
  );
  vi.spyOn(platform.identity, 'resolveCurrent').mockImplementation(
    async (reference) => ({
      account: {
        id: reference.principalId,
        accountStatus: 'active',
        sessionVersion: 1,
        permissionVersion: 1,
        role: 'player',
        navigatorGrantedAt: null,
        navigatorExpiresAt: null,
      },
      identity: {
        principalId: reference.principalId,
        authEpoch: 'active',
        active: true,
      },
    }),
  );
  for (const gameId of gameIds)
    platform.registerGame({
      module: gameModule(gameId, roomGameIds.includes(gameId)),
      metadata: {
        gameId,
        name: gameId,
        description: `${gameId} game`,
        themeId: gameId,
      },
      identity: identity(gameId),
      backendBindingId: `${gameId}-host`,
      storageBindingId: 'shared-storage',
      ownershipEpoch: '1',
      capacity: (room) => (room.modeId === 'room' ? 2 : 1),
      freezePolicy: async () => ({
        rating: null,
        validityPolicyVersion: `${gameId}-policy-v1`,
      }),
      ...(gameId === 'alpha'
        ? {
            createBotProfile: () => ({
              displayName: 'Alpha Bot',
              gameProfile: { kind: 'runtime-test-bot' },
            }),
          }
        : {}),
      ...(gameId === accessGameId
        ? {
            access: {
              gameId,
              releaseId: `${gameId}-v1`,
              entitlements: [{ entitlement: 'beta-access' }],
              requiredEntitlement: 'beta-access',
            },
          }
        : {}),
    });
  return platform;
}
const reference = { principalId: 'one-account', authSessionId: 'session' };
async function start(platform: PlatformApplicationRuntime, gameId: string) {
  return platform.admission.createDirectSession(reference.principalId, {
    gameId,
    releaseId: `${gameId}-v1`,
    modeId: 'solo',
    setup: {},
    requestId: `${gameId}-request`,
  });
}

describe('registered platform application', () => {
  it('keeps a public replay grant out of live session and command authorization', async () => {
    const platform = runtime(['alpha']);
    const started = await start(platform, 'alpha');
    const viewer = {
      principalId: 'spectator',
      authSessionId: 'spectator-auth',
    };
    vi.spyOn(platform.game('alpha').identity, 'accessScopes').mockResolvedValue(
      ['session:view', 'session:spectate'],
    );
    const grant = vi.fn().mockResolvedValue(true);
    platform.setPublicReplayAuthorization(grant);
    await expect(
      platform.sessions.descriptor(viewer, started.sessionId),
    ).rejects.toMatchObject({ envelope: { code: 'FORBIDDEN' } });
    await expect(
      platform.replaySessions.descriptor(viewer, started.sessionId),
    ).resolves.toMatchObject({ route: started.route });
    await expect(
      platform.replaySessions.command(viewer, started.sessionId, {
        commandId: 'forbidden-replay-command',
        precondition: { kind: 'revision', expectedRevision: 0 },
        command: {},
      }),
    ).rejects.toMatchObject({ envelope: { code: 'FORBIDDEN' } });
    expect(grant).toHaveBeenCalledWith(started.route, 'spectator');
  });
  it('runs a remote HTTP lifecycle without installing game code or storage in the platform', async () => {
    const platform = runtime([]);
    const module = gameModule('alpha');
    const storage = new MemoryStorageDriver();
    const registry = new GameRegistry();
    registry.register(module);
    const access = identity('alpha');
    const host = new GameHost({
      registry,
      storage,
      backendBindingId: 'alpha-remote',
      storageBindingId: 'alpha-storage',
      authorize: access.authorizeHost,
    });
    const description: GameServiceDescription = {
      schemaVersion: 1,
      platformId: 'test-platform',
      gameId: 'alpha',
      releaseId: 'alpha-v1',
      backendBindingId: 'alpha-remote',
      storageBindingId: 'alpha-storage',
      ownershipEpoch: '1',
      metadata: {
        gameId: 'alpha',
        name: 'Alpha',
        description: 'Test game',
        themeId: 'alpha',
      },
      modes: module.modes,
      setupSchema: module.schemas.setup,
    };
    const describeHost = host.describe.bind(host);
    vi.spyOn(host, 'describe').mockImplementation(async (request) => {
      const original = await describeHost(request);
      return {
        ...original,
        features: [...original.features, 'runtime-description-v1'],
        service: description,
      };
    });
    const transport = new HttpHostTransport({
      backend: host,
      serviceToken: 'test-service-token-at-least-32-characters',
      tokenExpiresAt: Date.now() + 60_000,
      allowedGameIds: ['alpha'],
      allowedScopes: [
        'session:create',
        'session:control',
        'session:view',
        'session:command',
      ],
    });
    const address = await transport.listen();
    try {
      const backend = new RemoteBackendAdapter({
        baseUrl: `http://127.0.0.1:${address.port}`,
        serviceToken: 'test-service-token-at-least-32-characters',
        allowInsecureLocalhost: true,
      });
      const registration = {
        description,
        backend,
        identity: access,
        policy: { rating: null, validityPolicyVersion: 'test-v1' },
      };
      await expect(
        platform.registerRemoteGame({
          ...registration,
          description: { ...description, platformId: 'other-platform' },
        }),
      ).rejects.toMatchObject({ envelope: { code: 'FORBIDDEN' } });
      await expect(
        platform.registerRemoteGame({
          ...registration,
          description: { ...description, releaseId: 'alpha-v2' },
        }),
      ).rejects.toMatchObject({ envelope: { code: 'NOT_READY' } });
      expect(platform.catalog()).toEqual([]);
      const installed = await platform.registerRemoteGame(registration);
      expect(installed.host).toBeUndefined();
      expect(() => platform.localGame('alpha')).toThrow();
      expect(() =>
        platform.registry.resolve({
          gameId: 'alpha',
          releaseId: 'alpha-v1',
          modeId: 'solo',
        }),
      ).toThrow();
      expect(platform.catalog()).toHaveLength(1);
      await expect(
        platform.registerRemoteGame(registration),
      ).rejects.toMatchObject({ envelope: { code: 'CONFLICT' } });
      const session = await start(platform, 'alpha');
      const view = await platform.views.view(reference, session.sessionId);
      expect(view.payload).toEqual({ count: 0 });
      const input = {
        commandId: 'remote-command',
        precondition: {
          kind: 'revision' as const,
          expectedRevision: view.revision,
        },
        command: {},
      };
      await platform.sessions.command(reference, session.sessionId, input);
      const duplicate = await platform.sessions.command(
        reference,
        session.sessionId,
        input,
      );
      expect(duplicate.receipt.status).toBe('duplicate');
      expect(
        (await platform.sessions.summary(reference, session.sessionId)).status,
      ).toBe('completed');
      expect((await storage.getHead(session.sessionId))?.status).toBe(
        'completed',
      );
      expect(await platform.storage.getHead(session.sessionId)).toBeNull();
      await expect(
        platform.views.view(
          { ...reference, principalId: 'stranger' },
          session.sessionId,
        ),
      ).rejects.toMatchObject({ envelope: { code: 'FORBIDDEN' } });
      const recovery = await platform.recoverOnce();
      expect(recovery.timers).toEqual([]);
      await platform.drain();
      expect((await backend.ready({ protocolVersion: 1 })).ready).toBe(true);
    } finally {
      await transport.close();
      await host.drain();
      await storage.close();
    }
  });

  it('keeps account authority available without any installed game', async () => {
    const platform = runtime([]);
    expect(platform.catalog()).toEqual([]);
    expect(platform.accountIdentity()).toBe(platform.identity);
    await expect(
      platform.accountIdentity().resolve(reference),
    ).resolves.toMatchObject({
      principalId: reference.principalId,
      active: true,
    });
  });

  it('shares account and directory while pinning game hosts, modes, and codecs independently', async () => {
    const platform = runtime();
    const alpha = await start(platform, 'alpha');
    const beta = await start(platform, 'beta');
    expect(alpha.route.backendBindingId).toBe('alpha-host');
    expect(beta.route.backendBindingId).toBe('beta-host');
    expect(platform.catalog().map((entry) => entry.metadata.themeId)).toEqual([
      'alpha',
      'beta',
    ]);
    expect(() =>
      platform.resolveBackend({ ...alpha.route, gameId: 'beta' }),
    ).toThrow();
    const view = await platform.views.view(reference, beta.sessionId);
    expect(view.descriptor.route.gameId).toBe('beta');
    expect(view.payload).toEqual({ count: 0 });
    await expect(
      platform.views.view(
        { ...reference, principalId: 'stranger' },
        beta.sessionId,
      ),
    ).rejects.toMatchObject({ envelope: { code: 'FORBIDDEN' } });
    await platform.recoverOnce();
    expect((await platform.listSessions(reference, 'mine')).items).toHaveLength(
      2,
    );
    expect(
      (
        await platform.listSessions(reference, 'mine', { gameId: 'beta' })
      ).items.map((session) => session.route.gameId),
    ).toEqual(['beta']);
  });

  it('passes registered bot profiles to room management and disables unsupported games', async () => {
    const platform = runtime(['alpha', 'beta'], undefined, ['alpha', 'beta']);
    const publicNames = vi
      .spyOn(platform.identity, 'publicNames')
      .mockResolvedValue(new Map());
    const changed: string[][] = [];
    platform.onAccountChanged((principalIds) => {
      changed.push([...principalIds]);
    });

    const alpha = await platform.rooms.createRoom('owner', {
      gameId: 'alpha',
      modeId: 'room',
      releaseId: 'alpha-v1',
      visibility: 'private',
      setup: {},
    });
    expect(alpha.metadata.botsAllowed).toBe(true);
    await expect(
      platform.rooms.addBot('intruder', alpha.id, alpha.revision),
    ).rejects.toMatchObject({
      envelope: {
        code: 'FORBIDDEN',
        messageKey: 'platform.room.owner_required',
      },
    });
    const alphaWithBot = await platform.rooms.addBot(
      'owner',
      alpha.id,
      alpha.revision,
    );
    expect(alphaWithBot.members).toContainEqual(
      expect.objectContaining({
        controller: 'bot',
        ready: true,
        publicProfile: {
          displayName: 'Alpha Bot',
          gameProfile: { kind: 'runtime-test-bot' },
        },
      }),
    );
    const botPrincipalId = alphaWithBot.members.find(
      (member) => member.controller === 'bot',
    )?.principalId;
    if (!botPrincipalId) throw new Error('bot member missing');
    expect(botPrincipalId).toMatch(/^bot:/u);
    expect(changed.flat()).not.toContain(botPrincipalId);
    expect(
      publicNames.mock.calls.every(
        ([principalIds]) =>
          !(principalIds as readonly string[]).includes(botPrincipalId),
      ),
    ).toBe(true);

    const beta = await platform.rooms.createRoom('owner', {
      gameId: 'beta',
      modeId: 'room',
      releaseId: 'beta-v1',
      visibility: 'private',
      setup: {},
    });
    expect(beta.metadata.botsAllowed).toBe(false);
    await expect(
      platform.rooms.addBot('owner', beta.id, beta.revision),
    ).rejects.toMatchObject({
      envelope: { code: 'CONFLICT', messageKey: 'platform.room.unavailable' },
    });
  });

  it('batch loads admission metadata for a session page', async () => {
    const platform = runtime(['alpha']);
    const first = await start(platform, 'alpha');
    const second = await platform.admission.createDirectSession(
      reference.principalId,
      {
        gameId: 'alpha',
        releaseId: 'alpha-v1',
        modeId: 'solo',
        setup: {},
        requestId: 'alpha-request-2',
      },
    );
    await platform.recoverOnce();
    const getAdmissions = vi.spyOn(platform.admissionStore, 'getAdmissions');
    const getAdmission = vi.spyOn(platform.admissionStore, 'getAdmission');

    const page = await platform.listSessions(reference, 'mine');

    const sessionIds = page.items.map((session) => session.sessionId);
    expect(new Set(sessionIds)).toEqual(
      new Set([second.sessionId, first.sessionId]),
    );
    expect(getAdmissions).toHaveBeenCalledTimes(1);
    expect(getAdmissions).toHaveBeenCalledWith(sessionIds);
    expect(getAdmission).not.toHaveBeenCalled();
  });

  it('gates only opted-in game admission and keeps a revoked code grant usable', async () => {
    const platform = runtime(['alpha', 'beta'], 'alpha');
    const access = platform.gameAccess;
    expect(access).toBeDefined();
    if (!access) throw new Error('game access service missing');
    expect(access.catalog()).toContainEqual({
      gameId: 'beta',
      releaseId: 'beta-v1',
      entitlements: [
        {
          entitlement: 'play',
          label: 'Play',
          description: 'Access to this game through the platform.',
        },
      ],
    });
    await expect(start(platform, 'alpha')).rejects.toMatchObject({
      envelope: { code: 'FORBIDDEN' },
    });
    const issued = await access.createCode({
      actorId: 'admin-1',
      gameId: 'alpha',
      entitlement: 'beta-access',
    });
    await access.redeem('alpha', reference.principalId, issued.code);
    const alpha = await start(platform, 'alpha');
    await access.revokeCode('alpha', issued.summary.codeId);
    await expect(
      platform.views.view(reference, alpha.sessionId),
    ).resolves.toBeDefined();
    await expect(start(platform, 'beta')).resolves.toBeDefined();
  });

  it('keeps pending invitation metadata and decline available after entitlement revocation', async () => {
    const platform = runtime(['alpha'], 'alpha');
    const changed: string[][] = [];
    platform.onAccountChanged((principalIds) => {
      changed.push([...principalIds]);
    });
    vi.spyOn(platform.identity, 'publicNames').mockResolvedValue(new Map());
    const room: PlatformRoom = {
      id: 'alpha-room-invitation',
      ownerId: 'owner',
      gameId: 'alpha',
      modeId: 'solo',
      releaseId: 'alpha-v1',
      visibility: 'private',
      setup: {},
      members: [{ principalId: 'owner', seatId: 'owner-seat', ready: false }],
      revision: 0,
      startGeneration: 0,
      status: 'open',
    };
    await platform.admissionStore.createRoomWithAccess(room, {}, [
      {
        grantId: 'alpha-invitation',
        roomId: room.id,
        principalId: 'guest',
        state: 'pending',
      },
    ]);

    await expect(platform.rooms.listInvitations('guest')).resolves.toEqual({
      items: [
        {
          grantId: 'alpha-invitation',
          roomId: room.id,
          gameId: 'alpha',
          modeId: 'solo',
          releaseId: 'alpha-v1',
          ownerId: 'owner',
        },
      ],
    });
    await expect(
      platform.rooms.getRoom('guest', room.id),
    ).rejects.toMatchObject({ envelope: { code: 'FORBIDDEN' } });
    await expect(
      platform.rooms.joinRoom('guest', room.id, room.revision),
    ).rejects.toMatchObject({ envelope: { code: 'FORBIDDEN' } });
    expect(changed).toHaveLength(0);
    await expect(
      platform.rooms.declineInvitation('guest', room.id, 'alpha-invitation'),
    ).resolves.toMatchObject({ id: room.id, revision: 1 });
    expect(changed).toEqual(
      expect.arrayContaining([expect.arrayContaining(['owner', 'guest'])]),
    );
    await expect(platform.rooms.listInvitations('guest')).resolves.toEqual({
      items: [],
    });
  });

  it('rolls back a failed release registration so a corrected retry preserves other games', () => {
    const platform = runtime(['beta']);
    const base = {
      module: gameModule('alpha'),
      metadata: {
        gameId: 'alpha',
        name: 'alpha',
        description: 'alpha game',
        themeId: 'alpha',
      },
      identity: identity('alpha'),
      backendBindingId: 'alpha-host',
      storageBindingId: 'shared-storage',
      ownershipEpoch: '1',
      capacity: () => 1,
      freezePolicy: async () => ({
        rating: null,
        validityPolicyVersion: 'alpha-policy-v1',
      }),
    };
    expect(() =>
      platform.registerGame({
        ...base,
        access: {
          gameId: 'alpha',
          releaseId: 'alpha-v1',
          entitlements: [{ entitlement: 'beta-access' }],
          requiredEntitlement: 'beta-access',
        },
      }),
    ).toThrow();

    const installed = platform.registerGame(base);
    expect(installed.gameId).toBe('alpha');
    expect(platform.game('beta').releaseId).toBe('beta-v1');
    expect(platform.catalog().map(({ gameId }) => gameId)).toEqual([
      'beta',
      'alpha',
    ]);
  });

  it('delivers each trusted completion only to its registered game consumer and survives repeated recovery', async () => {
    const platform = runtime();
    const alphaConsumer = vi.fn(async () => undefined);
    const betaConsumer = vi.fn(async () => undefined);
    platform.registerFactConsumer('alpha:completion', alphaConsumer, 'alpha');
    platform.registerFactConsumer('beta:completion', betaConsumer, 'beta');
    const beta = await start(platform, 'beta');
    const view = await platform.views.view(reference, beta.sessionId);
    const command = {
      commandId: 'advance-1',
      precondition: {
        kind: 'revision' as const,
        expectedRevision: view.revision,
      },
      command: {},
    };
    const first = await platform.views.command(
      reference,
      beta.sessionId,
      command,
    );
    expect(first.receipt.status).toBe('accepted');
    expect(
      (await platform.views.command(reference, beta.sessionId, command)).receipt
        .status,
    ).toBe('duplicate');
    const recovered = await platform.recoverOnce();
    expect(recovered.delivery.failed).toBe(0);
    expect(recovered.consumers.every((report) => report.failed === 0)).toBe(
      true,
    );
    expect(alphaConsumer).not.toHaveBeenCalled();
    expect(
      betaConsumer.mock.calls.some(
        (call) =>
          (call as unknown as [{ kind: string }])[0]?.kind ===
          'SessionCompleted',
      ),
    ).toBe(true);
    const count = betaConsumer.mock.calls.length;
    await platform.recoverOnce();
    expect(betaConsumer).toHaveBeenCalledTimes(count);
  });

  it('notifies participants for directory facts from every registered game', async () => {
    const platform = runtime();
    const changed: string[][] = [];
    platform.onAccountChanged((principalIds) => {
      changed.push([...principalIds]);
    });

    const beta = await start(platform, 'beta');
    const view = await platform.views.view(reference, beta.sessionId);
    await platform.views.command(reference, beta.sessionId, {
      commandId: 'advance-beta',
      precondition: {
        kind: 'revision' as const,
        expectedRevision: view.revision,
      },
      command: {},
    });

    const recovered = await platform.recoverOnce();

    expect(recovered.delivery.failed).toBe(0);
    expect(recovered.consumers.every((report) => report.failed === 0)).toBe(
      true,
    );
    expect(changed.length).toBeGreaterThan(0);
    expect(changed).toEqual(
      expect.arrayContaining([expect.arrayContaining(['one-account'])]),
    );
  });

  it('keeps GameFact on the session revision path without shell account lookup', async () => {
    const platform = runtime(['beta']);
    const beta = await start(platform, 'beta');
    const changed: string[][] = [];
    const revisions: Array<[string, number]> = [];
    platform.onAccountChanged((principalIds) => {
      changed.push([...principalIds]);
    });
    platform.onSessionChanged((sessionId, revision) => {
      revisions.push([sessionId, revision]);
    });

    await platform.inbox.accept({
      producerId: `game:beta:session:${beta.sessionId}`,
      eventId: 'game-fact-shell-free',
      sessionId: beta.sessionId,
      kind: 'GameFact',
      schemaVersion: 1,
      sourceRelease: beta.route.releaseId,
      aggregateSequence: 7,
      payload: { fact: true },
    });
    const getAdmission = vi.spyOn(platform.admissionStore, 'getAdmission');

    await expect(
      platform.consumers.runOnce('platform:session-directory:v1', {
        limit: 100,
      }),
    ).resolves.toMatchObject({ processed: 1, failed: 0 });

    expect(getAdmission).not.toHaveBeenCalled();
    expect(changed).toEqual([]);
    expect(revisions).toEqual([[beta.sessionId, 7]]);
  });

  it('executes registered game recovery hooks in the shared recovery loop', async () => {
    const platform = runtime(['alpha']);
    const recover = vi.fn(async () => undefined);
    platform.registerRecoveryHook('alpha:test-recovery', recover);

    const report = await platform.recoverOnce();

    expect(recover).toHaveBeenCalledOnce();
    expect(report.maintenance).toContainEqual({
      name: 'alpha:test-recovery',
      failed: false,
    });
  });

  it('keeps recovery and Outbox delivery moving while a single tracked AI scan is pending', async () => {
    const platform = runtime();
    let completeAi: (results: readonly SystemTickResult[]) => void = () =>
      undefined;
    const ai = new Promise<readonly SystemTickResult[]>((resolve) => {
      completeAi = resolve;
    });
    const alphaTicks = vi
      .spyOn(platform.localGame('alpha').host, 'tickSystemCommands')
      .mockImplementation(async (_access, _limit, options) =>
        options?.kind === 'automation' ? ai : [],
      );
    const completion = vi.fn(async () => undefined);
    platform.registerFactConsumer('beta:ai-isolation', completion, 'beta');
    const beta = await start(platform, 'beta');
    const view = await platform.views.view(reference, beta.sessionId);
    await platform.views.command(reference, beta.sessionId, {
      commandId: 'while-ai-is-pending',
      precondition: { kind: 'revision', expectedRevision: view.revision },
      command: {},
    });

    const firstScan = platform.recoverAutomationOnce();
    const sameScan = platform.recoverAutomationOnce();
    expect(sameScan).toBe(firstScan);
    const recovered = await platform.recoverOnce();
    expect(recovered.delivery.failed).toBe(0);
    expect(completion).toHaveBeenCalled();
    expect(alphaTicks.mock.calls.map((call) => call[2]?.kind)).toEqual([
      'automation',
      'system',
    ]);

    const hostDrain = vi.spyOn(platform.localGame('alpha').host, 'drain');
    const draining = platform.drain();
    await Promise.resolve();
    expect(hostDrain).not.toHaveBeenCalled();
    completeAi([]);
    await firstScan;
    await draining;
    expect(hostDrain).toHaveBeenCalledOnce();
    await expect(platform.recoverAutomationOnce()).resolves.toEqual([]);
  });

  it('selects a registered game presenter without applying it to another game', async () => {
    const platform = runtime();
    const presenter = {
      view: vi.fn(platform.sessions.view.bind(platform.sessions)),
      resume: platform.sessions.resume.bind(platform.sessions),
      command: platform.sessions.command.bind(platform.sessions),
    };
    platform.views.register('alpha', 'alpha-v1', presenter);
    const alpha = await start(platform, 'alpha');
    const beta = await start(platform, 'beta');
    await platform.views.view(reference, alpha.sessionId);
    await platform.views.view(reference, beta.sessionId);
    expect(presenter.view).toHaveBeenCalledTimes(1);
    expect(() =>
      platform.views.register('alpha', 'alpha-v1', presenter),
    ).toThrow();
  });

  it('fails closed when a current release view or result adapter is unavailable', async () => {
    const platform = runtime();
    const alpha = await start(platform, 'alpha');
    platform.views.unregister('alpha', 'alpha-v1');
    platform.results.unregisterRelease('alpha', 'alpha-v1');

    await expect(
      platform.views.view(reference, alpha.sessionId),
    ).rejects.toMatchObject({
      envelope: expect.objectContaining({ code: 'NOT_READY' }),
    });
    await expect(
      platform.results.getSettlement(reference, alpha.sessionId),
    ).rejects.toMatchObject({
      envelope: expect.objectContaining({ code: 'NOT_READY' }),
    });
  });

  it('closes all runtime registration surfaces when installation is aborted', async () => {
    const platform = runtime();
    const alpha = await start(platform, 'alpha');
    const installed = platform.game('alpha');

    platform.abortGameRegistration(installed);

    expect(platform.catalog().map(({ gameId }) => gameId)).toEqual(['beta']);
    expect(() => platform.game('alpha')).toThrow();
    await expect(
      platform.views.view(reference, alpha.sessionId),
    ).rejects.toThrow();
  });
});
