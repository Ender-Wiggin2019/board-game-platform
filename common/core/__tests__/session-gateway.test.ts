import type {
  BackendPort,
  MatchAdmission,
  SessionRoute,
} from '@board-game/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { StartOperation } from '../src/admission/types.js';
import { SessionGateway } from '../src/sessions/SessionGateway.js';
import type {
  PlatformIdentityReference,
  ResolvedIdentity,
  SessionGatewayOperation,
  SessionGatewayOptions,
} from '../src/sessions/types.js';

const route: SessionRoute = {
  gameId: 'seti',
  modeId: 'ranked',
  sessionId: 'session-1',
  releaseId: 'release-1',
  backendBindingId: 'backend-1',
  storageBindingId: 'storage-1',
  ownershipEpoch: 'epoch-1',
};

const admission: MatchAdmission = {
  id: 'admission-1',
  route,
  participants: [
    { principalId: 'alice', seatId: 'seat-1' },
    { principalId: 'bob', seatId: 'seat-2' },
  ],
  visibility: 'private',
  rating: null,
  validityPolicyVersion: 'policy-1',
  createdAt: 1,
};

const activeStart: StartOperation = {
  requestId: 'request-1',
  requestDigest: 'digest-1',
  initiatedBy: 'alice',
  startGeneration: 1,
  setup: {},
  seed: 'seed-1',
  startId: 'start-1',
  sessionId: route.sessionId,
  roomId: 'room-1',
  state: 'active' as const,
  route,
  admission,
};

const identity: PlatformIdentityReference = {
  principalId: 'alice',
  authSessionId: 'auth-session-1',
};

function view(): Record<string, unknown> {
  return {
    gameId: route.gameId,
    sessionId: route.sessionId,
    releaseId: route.releaseId,
    viewSchemaVersion: 1,
    audienceKey: 'audience-1',
    viewEpoch: 'auth-1',
    baseRevision: 0,
    revision: 0,
    streamCursor: 'cursor-1',
    kind: 'snapshot',
    payload: { ready: true },
  };
}

function backendWith(overrides: Partial<BackendPort> = {}): BackendPort {
  const base: BackendPort = {
    describe: async () => ({
      protocolMajor: 1,
      protocolMinor: 0,
      features: [],
      gameIds: [route.gameId],
      releaseIds: [route.releaseId],
      modes: [],
      storageBindingIds: [route.storageBindingId],
    }),
    ready: async () => ({
      ready: true,
      description: {
        protocolMajor: 1,
        protocolMinor: 0,
        features: [],
        gameIds: [route.gameId],
        releaseIds: [route.releaseId],
        modes: [],
        storageBindingIds: [route.storageBindingId],
      },
    }),
    createSession: async () => {
      throw new Error('unexpected create');
    },
    activateSession: async () => {
      throw new Error('unexpected activate');
    },
    getStatus: async () => ({
      kind: 'start' as const,
      sessionId: route.sessionId,
      startId: activeStart.startId,
      status: 'active' as const,
    }),
    submitCommand: async (request) => ({
      receipt: {
        commandId: request.commandId,
        sessionId: route.sessionId,
        status: 'accepted' as const,
        resultRetention: 'replayable' as const,
        persistedRevision: 1,
        persistedAt: 1,
      },
    }),
    submitSystemCommand: async (request) => ({
      receipt: {
        commandId: request.commandId,
        sessionId: route.sessionId,
        status: 'accepted' as const,
        resultRetention: 'replayable' as const,
        persistedRevision: 1,
        persistedAt: 1,
      },
    }),
    queryOptions: async (request) => ({
      route: request.route,
      revision: request.revision,
      answer: { ok: true },
    }),
    getPlayerView: async () => view() as never,
    getEvents: async () => ({
      gameId: route.gameId,
      sessionId: route.sessionId,
      releaseId: route.releaseId,
      audienceKey: 'audience-1',
      viewEpoch: 'auth-1',
      nextSequence: 0,
      hasMore: false,
      events: [],
      resetRequired: false,
    }),
    resume: async () => ({ kind: 'snapshot' as const, view: view() as never }),
    getSessionSummary: async () => ({
      route,
      status: 'active' as const,
      sourceRevision: 0,
      updatedAt: 1,
      summary: { ok: true },
    }),
    controlSession: async () => {
      throw new Error('unexpected control');
    },
  };
  return { ...base, ...overrides };
}

function options(
  start = activeStart,
  overrides: Partial<SessionGatewayOptions> = {},
): SessionGatewayOptions {
  const backend = backendWith();
  return {
    admission: {
      getStartBySession: vi.fn(async (sessionId: string) =>
        sessionId === route.sessionId ? structuredClone(start) : null,
      ),
    },
    resolveIdentity: vi.fn(async (reference) => ({
      principalId: reference.principalId,
      authEpoch: 'auth-1',
      active: true,
    })),
    authorize: vi.fn(async () => true),
    createAccess: vi.fn(
      async (
        resolved: ResolvedIdentity,
        frozen: MatchAdmission,
        operation: SessionGatewayOperation,
      ) => {
        const participant = frozen.participants.some(
          (candidate) => candidate.principalId === resolved.principalId,
        );
        if (!participant) return ['session:view', 'session:spectate'];
        return operation === 'command' ? ['session:command'] : ['session:view'];
      },
    ),
    resolveBackend: vi.fn(() => backend),
    ...overrides,
  };
}

async function expectCode(work: Promise<unknown>, code: string): Promise<void> {
  await expect(work).rejects.toMatchObject({
    envelope: { code },
  });
}

describe('SessionGateway', () => {
  it('uses the persisted route and constructs a minimal server access context', async () => {
    const backend = backendWith();
    const submitCommand = vi.fn(backend.submitCommand);
    const spiedBackend = { ...backend, submitCommand };
    const resolveBackend = vi.fn(() => spiedBackend);
    const gateway = new SessionGateway(
      options(activeStart, {
        resolveBackend,
      }),
    );
    const response = await gateway.command(identity, route.sessionId, {
      commandId: 'command-1',
      precondition: { kind: 'revision', expectedRevision: 0 },
      command: { action: 'observe' },
    });
    expect(response.descriptor).toEqual({
      authority: 'platform',
      roomId: activeStart.roomId,
      route,
      status: 'active',
    });
    expect(resolveBackend).toHaveBeenCalledWith(route);
    const request = submitCommand.mock.calls[0]?.[0];
    expect(request?.route).toEqual(route);
    expect(request?.accessContext).toEqual({
      principalId: 'alice',
      authEpoch: 'auth-1',
      scopes: ['session:command'],
      seatId: 'seat-1',
    });
    expect(request?.accessContext).not.toHaveProperty('email');
    expect(request?.accessContext).not.toHaveProperty('roles');
  });

  it('passes explicitly registered game scopes without allowing platform privilege escalation', async () => {
    const backend = backendWith();
    const getPlayerView = vi.fn(backend.getPlayerView);
    const gateway = new SessionGateway(
      options(activeStart, {
        gameScopes: { seti: ['seti:stats:advanced'] },
        createAccess: () => ['session:view', 'seti:stats:advanced'],
        resolveBackend: () => ({ ...backend, getPlayerView }),
      }),
    );
    await gateway.view(identity, route.sessionId);
    expect(getPlayerView.mock.calls[0]?.[0].accessContext.scopes).toEqual([
      'session:view',
      'seti:stats:advanced',
    ]);
    for (const scope of [
      'seti:unregistered',
      'another-game:stats:advanced',
      'session:admin',
      'session:control',
    ]) {
      const denied = new SessionGateway(
        options(activeStart, {
          gameScopes: {
            seti: [
              'seti:stats:advanced',
              'another-game:stats:advanced',
              'session:admin',
              'session:control',
            ],
          },
          createAccess: () => ['session:view', scope],
        }),
      );
      await expectCode(denied.view(identity, route.sessionId), 'FORBIDDEN');
    }
    const unregistered = new SessionGateway(
      options(activeStart, {
        createAccess: () => ['session:view', 'seti:stats:advanced'],
      }),
    );
    await expectCode(unregistered.view(identity, route.sessionId), 'FORBIDDEN');
  });

  it('rejects spoofed route and access fields in browser command input', async () => {
    const gateway = new SessionGateway(options());
    await expectCode(
      gateway.command(identity, route.sessionId, {
        commandId: 'command-1',
        precondition: { kind: 'revision', expectedRevision: 0 },
        command: { action: 'observe' },
        route: { ...route, gameId: 'spoofed' },
        accessContext: { principalId: 'mallory', authEpoch: 'bad', scopes: [] },
      } as never),
      'INVALID_REQUEST',
    );
  });

  it('rejects browser commands addressed to a bot principal', async () => {
    const botPrincipalId = 'bot:session-1:1';
    const humanParticipant = admission.participants[0];
    if (!humanParticipant) throw new Error('human participant missing');
    const botStart: StartOperation = {
      ...activeStart,
      admission: {
        ...admission,
        participants: [
          humanParticipant,
          {
            principalId: botPrincipalId,
            seatId: 'seat-2',
            controller: 'bot',
          },
        ],
      },
    };
    const submitCommand = vi.fn(backendWith().submitCommand);
    const gateway = new SessionGateway(
      options(botStart, {
        resolveBackend: () => ({ ...backendWith(), submitCommand }),
      }),
    );
    await expectCode(
      gateway.command(
        { principalId: botPrincipalId, authSessionId: 'auth-bot' },
        route.sessionId,
        {
          commandId: 'bot-command',
          precondition: { kind: 'revision', expectedRevision: 0 },
          command: { action: 'observe' },
        },
      ),
      'FORBIDDEN',
    );
    expect(submitCommand).not.toHaveBeenCalled();
  });

  it('rechecks revoked identity and blocks a private spectator without policy', async () => {
    const revoked = new SessionGateway(
      options(activeStart, {
        resolveIdentity: async (reference) => ({
          principalId: reference.principalId,
          authEpoch: 'auth-1',
          active: false,
        }),
      }),
    );
    await expectCode(
      revoked.view(
        { principalId: 'alice', authSessionId: 'auth-session-1' },
        route.sessionId,
      ),
      'UNAUTHENTICATED',
    );

    const privateSpectator = new SessionGateway(
      options(activeStart, {
        authorize: async () => false,
      }),
    );
    await expectCode(
      privateSpectator.view(
        { principalId: 'spectator', authSessionId: 'auth-session-2' },
        route.sessionId,
      ),
      'FORBIDDEN',
    );
  });

  it('allows spectators only when authorization and session:spectate are both present', async () => {
    const authorize = vi.fn(async () => true);
    const gateway = new SessionGateway(
      options(activeStart, {
        authorize,
        createAccess: async () => ['session:view', 'session:spectate'],
      }),
    );
    const result = await gateway.view(
      { principalId: 'spectator', authSessionId: 'auth-session-2' },
      route.sessionId,
    );
    expect(result.descriptor.authority).toBe('platform');
    expect(authorize).toHaveBeenCalledWith(
      { principalId: 'spectator', authEpoch: 'auth-1', active: true },
      admission,
      'view',
    );
    await expectCode(
      gateway.command(
        { principalId: 'spectator', authSessionId: 'auth-session-2' },
        route.sessionId,
        {
          commandId: 'command-spectator',
          precondition: { kind: 'revision', expectedRevision: 0 },
          command: { action: 'observe' },
        },
      ),
      'FORBIDDEN',
    );
  });

  it('returns pending status without invoking a backend and rejects pending commands', async () => {
    const pending = { ...activeStart, state: 'creating' as const };
    const resolveBackend = vi.fn(() => backendWith());
    const gateway = new SessionGateway(options(pending, { resolveBackend }));
    const status = await gateway.status(identity, route.sessionId);
    expect(status.status).toBe('pending');
    expect(status.descriptor.status).toBe('creating');
    expect(resolveBackend).not.toHaveBeenCalled();
    await expectCode(
      gateway.command(identity, route.sessionId, {
        commandId: 'command-pending',
        precondition: { kind: 'revision', expectedRevision: 0 },
        command: { action: 'observe' },
      }),
      'NOT_READY',
    );
  });

  it('rejects a backend response pinned to a different route', async () => {
    const backend = backendWith({
      getPlayerView: async () => ({ ...view(), gameId: 'other-game' }) as never,
    });
    const gateway = new SessionGateway(
      options(activeStart, { resolveBackend: () => backend }),
    );
    await expectCode(gateway.view(identity, route.sessionId), 'OWNERSHIP_LOST');
  });

  it('keeps completed underlying host status in the public descriptor', async () => {
    const backend = backendWith({
      getSessionSummary: async () => ({
        route,
        status: 'completed' as const,
        sourceRevision: 3,
        updatedAt: 3,
        summary: { result: 'done' },
      }),
    });
    const gateway = new SessionGateway(
      options(activeStart, { resolveBackend: () => backend }),
    );
    const response = await gateway.summary(identity, route.sessionId);
    expect(response.status).toBe('completed');
    expect(response.descriptor.status).toBe('completed');
  });

  it('keeps auth session identity separate from the canonical game session', async () => {
    const resolveIdentity = vi.fn(async (reference) => ({
      principalId: reference.principalId,
      authEpoch: 'auth-1',
      active: true,
    }));
    const gateway = new SessionGateway(
      options(activeStart, { resolveIdentity }),
    );
    await gateway.view(
      { principalId: 'alice', authSessionId: 'auth-session-99' },
      route.sessionId,
    );
    expect(resolveIdentity).toHaveBeenCalledWith({
      principalId: 'alice',
      authSessionId: 'auth-session-99',
    });
  });

  it('probes a descriptor through admission without resolving a backend', async () => {
    const resolveBackend = vi.fn(() => backendWith());
    const gateway = new SessionGateway(
      options(activeStart, { resolveBackend }),
    );
    await expect(
      gateway.descriptor(
        { principalId: 'alice', authSessionId: 'auth-session-1' },
        route.sessionId,
      ),
    ).resolves.toEqual({
      authority: 'platform',
      roomId: activeStart.roomId,
      route,
      status: 'active',
    });
    expect(resolveBackend).not.toHaveBeenCalled();
  });

  it('returns not found for descriptor probes without an admission', async () => {
    const resolveBackend = vi.fn(() => backendWith());
    const gateway = new SessionGateway(
      options(activeStart, {
        resolveBackend,
        admission: {
          getStartBySession: vi.fn(async () => null),
        },
      }),
    );
    await expectCode(
      gateway.descriptor(
        { principalId: 'alice', authSessionId: 'auth-session-1' },
        route.sessionId,
      ),
      'NOT_FOUND',
    );
    expect(resolveBackend).not.toHaveBeenCalled();
  });
});
