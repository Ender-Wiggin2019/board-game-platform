import {
  type BackendPort,
  contractError,
  type MatchAdmission,
  type SessionRoute,
} from '@board-game/contracts';
import type {
  AdmissionStore,
  PlatformIdentityReference,
  ResolvedIdentity,
  StartOperation,
} from '@board-game/core';
import { SessionGateway } from '@board-game/core';
import type { ArgumentsHost } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { PlatformApplicationRuntime } from '@/platform/PlatformApplicationRuntime.js';
import { PlatformErrorFilter } from '@/platform/PlatformErrorFilter.js';
import type { PlatformGameServices } from '@/platform/PlatformGameServices.js';
import { PlatformController } from '@/platform/platform.controller.js';

const request = (principalId = 'token-principal') =>
  ({ user: { sub: principalId, sid: 'auth-session-1' } }) as never;

function fakeRuntime(overrides: Record<string, unknown> = {}) {
  const identity = {
    resolve: vi.fn(
      async (
        _reference: PlatformIdentityReference,
      ): Promise<ResolvedIdentity> => ({
        principalId: 'account-principal',
        authEpoch: '["auth-session-1",1,1]',
        active: true,
      }),
    ),
  };
  const admission = {
    listRooms: vi.fn(async () => ({ rooms: [] })),
    listInvitations: vi.fn(async () => ({ items: [] })),
    createRoom: vi.fn(async () => ({ id: 'room-1' })),
    createDirectSession: vi.fn(async () => ({ sessionId: 'session-1' })),
    getRoom: vi.fn(async () => ({ id: 'room-1', status: 'open' })),
    acceptInvitation: vi.fn(async () => ({ id: 'room-1', status: 'open' })),
    declineInvitation: vi.fn(async () => ({ id: 'room-1', status: 'open' })),
    addBot: vi.fn(async () => ({ id: 'room-1', status: 'open' })),
    addControlledSeat: vi.fn(async () => ({ id: 'room-1', status: 'open' })),
    autoStartRoom: vi.fn(async () => undefined),
  };
  const sessions = {
    descriptor: vi.fn(async () => ({ authority: 'platform' })),
    view: vi.fn(),
    resume: vi.fn(),
    command: vi.fn(),
    query: vi.fn(),
    events: vi.fn(),
    status: vi.fn(),
    summary: vi.fn(),
  };
  const chat = {
    loadSnapshot: vi.fn(),
    send: vi.fn(),
    markRead: vi.fn(),
  };
  const runtime = {
    options: { defaultGameId: 'seti' },
    identity,
    admission,
    rooms: admission,
    sessions,
    views: sessions,
    chat,
    roomChat: chat,
    publicModeId: (_gameId: string, modeId: string) => modeId,
    ...overrides,
  } as unknown as PlatformApplicationRuntime;
  return { runtime, identity, admission, sessions, chat };
}

const route: SessionRoute = {
  gameId: 'seti',
  modeId: 'casual-multiplayer',
  sessionId: 'session-1',
  releaseId: 'seti-test-v1',
  backendBindingId: 'embedded:test',
  storageBindingId: 'storage:test',
  ownershipEpoch: 'epoch-1',
};

const admission: MatchAdmission = {
  id: 'admission-1',
  route,
  participants: [{ principalId: 'account-principal', seatId: 'seat-1' }],
  visibility: 'private',
  rating: null,
  validityPolicyVersion: 'seti-v1',
  createdAt: 1,
};

const start: StartOperation = {
  startId: 'start-1',
  sessionId: route.sessionId,
  roomId: 'room-1',
  state: 'active',
  route,
  requestId: 'request-1',
  requestDigest: 'digest-1',
  initiatedBy: 'account-principal',
  startGeneration: 1,
  setup: {},
  seed: 'seed-1',
  admission,
};

function gatewayRuntime(options: {
  readonly authorize?: () => Promise<boolean>;
  readonly backend?: BackendPort;
}) {
  const backend =
    options.backend ??
    ({
      queryOptions: vi.fn(async (input) => ({
        route: input.route,
        revision: input.revision,
        answer: null,
      })),
    } as unknown as BackendPort);
  const admissionStore: Pick<AdmissionStore, 'getStartBySession'> = {
    getStartBySession: vi.fn(async (sessionId) =>
      sessionId === route.sessionId ? structuredClone(start) : null,
    ),
  };
  const sessions = new SessionGateway({
    admission: admissionStore,
    resolveIdentity: async () => ({
      principalId: 'account-principal',
      authEpoch: '["auth-session-1",1,1]',
      active: true,
    }),
    authorize: options.authorize ?? (async () => true),
    createAccess: async () => ['session:view'],
    resolveBackend: () => backend,
  });
  return { ...fakeRuntime({ sessions, views: sessions }), backend };
}

describe('PlatformController HTTP boundary', () => {
  it('rejects chat reads and writes when chat is disabled', async () => {
    const fixture = fakeRuntime();
    const controller = new PlatformController(
      fixture.runtime,
      undefined,
      undefined,
      {
        brand: { name: 'Orbit Table' },
        features: { chat: false, rankings: true },
      },
    );
    await expect(
      Promise.resolve().then(() => controller.chat(request(), 'session-1')),
    ).rejects.toMatchObject({
      envelope: {
        code: 'NOT_FOUND',
        messageKey: 'platform.feature.chat.disabled',
      },
    });
    await expect(
      Promise.resolve().then(() =>
        controller.sendChat(request(), 'session-1', {
          requestId: 'request-1',
          body: 'hello',
        }),
      ),
    ).rejects.toMatchObject({
      envelope: {
        code: 'NOT_FOUND',
        messageKey: 'platform.feature.chat.disabled',
      },
    });
    expect(fixture.chat.loadSnapshot).not.toHaveBeenCalled();
    expect(fixture.chat.send).not.toHaveBeenCalled();
  });

  it('accepts controller choices without accepting synthetic identity authority', async () => {
    const fixture = fakeRuntime();
    const controller = new PlatformController(fixture.runtime);
    await controller.addControlledSeat(request(), 'room-1', {
      expectedRevision: 2,
      controller: {
        kind: 'ai',
        controllerId: 'game.standard',
        options: { level: 2 },
      },
    });
    expect(fixture.admission.addControlledSeat).toHaveBeenCalledWith(
      'account-principal',
      'room-1',
      2,
      { kind: 'ai', controllerId: 'game.standard', options: { level: 2 } },
    );
    for (const choice of [
      { kind: 'hotseat', controlledBy: 'attacker' },
      { kind: 'ai', controllerId: 'game.standard', principalId: 'attacker' },
      { kind: 'hotseat', options: {} },
      { kind: 'human' },
    ])
      await expect(
        controller.addControlledSeat(request(), 'room-1', {
          expectedRevision: 2,
          controller: choice,
        }),
      ).rejects.toMatchObject({ envelope: { code: 'INVALID_REQUEST' } });
    expect(fixture.admission.addControlledSeat).toHaveBeenCalledTimes(1);
    expect(fixture.admission.autoStartRoom).not.toHaveBeenCalled();
  });

  it('forwards seat selection for gateway authorization and rejects malformed selectors', async () => {
    const fixture = fakeRuntime();
    const controller = new PlatformController(fixture.runtime);
    const selected = {
      user: { sub: 'token-principal', sid: 'auth-session-1' },
      query: { seatId: 'seat-2' },
    } as never;
    await controller.view(selected, 'session-1');
    expect(fixture.sessions.view).toHaveBeenCalledWith(
      {
        principalId: 'token-principal',
        authSessionId: 'auth-session-1',
        seatId: 'seat-2',
      },
      'session-1',
    );
    expect(() =>
      controller.view(
        {
          user: { sub: 'a', sid: 'b' },
          query: { seatId: ['seat-1', 'seat-2'] },
        } as never,
        'session-1',
      ),
    ).toThrow();
  });

  it('reads shell counts only for the identity resolved from the authenticated request', async () => {
    const fixture = fakeRuntime();
    const summary = {
      notifications: {
        friendRequests: { incoming: 1 },
        gameInvitations: { pending: 2 },
        messages: { unread: 3 },
      },
      games: { actionRequired: 4, waitingReady: 5 },
      byGame: [],
    };
    const readShellSummary = vi.fn(async () => summary);
    const controller = new PlatformController(fixture.runtime, {
      readShellSummary,
    } as unknown as PlatformGameServices);

    await expect(controller.shellSummary(request())).resolves.toBe(summary);
    expect(fixture.identity.resolve).toHaveBeenCalledWith({
      principalId: 'token-principal',
      authSessionId: 'auth-session-1',
    });
    expect(readShellSummary).toHaveBeenCalledWith('account-principal');

    fixture.identity.resolve.mockRejectedValueOnce(
      contractError('UNAUTHENTICATED', 'platform.identity.inactive'),
    );
    await expect(controller.shellSummary(request())).rejects.toMatchObject({
      envelope: { code: 'UNAUTHENTICATED' },
    });
    expect(readShellSummary).toHaveBeenCalledTimes(1);
  });

  it('reports shell service unavailability instead of a fabricated empty snapshot', async () => {
    const { runtime } = fakeRuntime();
    const controller = new PlatformController(runtime);
    await expect(controller.shellSummary(request())).rejects.toMatchObject({
      envelope: { code: 'NOT_READY' },
    });
  });

  it('forwards the optional room status filter and rejects unknown values', async () => {
    const fixture = fakeRuntime();
    const controller = new PlatformController(fixture.runtime);

    await controller.rooms(request(), {
      gameId: 'brass-pittsburgh',
      status: 'open',
      limit: '10',
      cursor: 'room-1',
    });

    expect(fixture.admission.listRooms).toHaveBeenCalledWith(
      'account-principal',
      {
        gameId: 'brass-pittsburgh',
        status: 'open',
        limit: 10,
        cursor: 'room-1',
      },
    );
    await expect(
      controller.rooms(request(), { status: 'unknown' }),
    ).rejects.toMatchObject({
      envelope: {
        code: 'INVALID_REQUEST',
        messageKey: 'platform.room.status',
      },
    });
  });

  it('lists incoming invitations for the trusted identity and uses exact grant routes', async () => {
    const fixture = fakeRuntime();
    const controller = new PlatformController(fixture.runtime);

    await controller.invitations(request('browser-claim'), {
      limit: '10',
      cursor: 'room-0',
    });
    expect(fixture.admission.listInvitations).toHaveBeenCalledWith(
      'account-principal',
      { limit: 10, cursor: 'room-0' },
    );

    await controller.acceptRoomInvitation(
      request('browser-claim'),
      'room-1',
      'grant-1',
      { color: 'purple' },
    );
    expect(fixture.admission.acceptInvitation).toHaveBeenCalledWith(
      'account-principal',
      'room-1',
      'grant-1',
      { color: 'purple' },
    );
    expect(fixture.admission.autoStartRoom).toHaveBeenCalledWith('room-1');
    expect(fixture.admission.getRoom).toHaveBeenCalledWith(
      'account-principal',
      'room-1',
    );

    await controller.declineRoomInvitation(
      request('browser-claim'),
      'room-1',
      'grant-1',
      {},
    );
    expect(fixture.admission.declineInvitation).toHaveBeenCalledWith(
      'account-principal',
      'room-1',
      'grant-1',
    );
  });

  it('adds a bot with the trusted caller and expected room revision', async () => {
    const fixture = fakeRuntime();
    const controller = new PlatformController(fixture.runtime);

    await controller.addBot(request('browser-claim'), 'room-1', {
      expectedRevision: 3,
    });

    expect(fixture.admission.addBot).toHaveBeenCalledWith(
      'account-principal',
      'room-1',
      3,
    );
    expect(fixture.admission.autoStartRoom).toHaveBeenCalledWith('room-1');
    expect(fixture.admission.getRoom).toHaveBeenCalledWith(
      'account-principal',
      'room-1',
    );
  });

  it('rejects bot requests with browser supplied fields', async () => {
    const fixture = fakeRuntime();
    const controller = new PlatformController(fixture.runtime);

    await expect(
      controller.addBot(request(), 'room-1', {
        expectedRevision: 3,
        principalId: 'attacker',
      }),
    ).rejects.toMatchObject({ envelope: { code: 'INVALID_REQUEST' } });
    expect(fixture.identity.resolve).not.toHaveBeenCalled();
    expect(fixture.admission.addBot).not.toHaveBeenCalled();
  });

  it('requires the authenticated request identity before creating a room', async () => {
    const fixture = fakeRuntime();
    const controller = new PlatformController(fixture.runtime);

    await expect(
      controller.createRoom({} as never, {
        modeId: 'casual-multiplayer',
        releaseId: 'seti-test-v1',
        visibility: 'private',
        setup: {},
      }),
    ).rejects.toMatchObject({
      envelope: {
        code: 'UNAUTHENTICATED',
        messageKey: 'platform.identity.required',
      },
    });
    expect(fixture.identity.resolve).not.toHaveBeenCalled();
  });

  it('uses trusted identity and the compatibility game for existing room and solo requests', async () => {
    const fixture = fakeRuntime();
    const controller = new PlatformController(fixture.runtime);
    const roomBody = {
      modeId: 'casual-multiplayer',
      releaseId: 'seti-test-v1',
      requestId: 'room-request-1',
      visibility: 'private',
      setup: { options: { playerCount: 2 } },
      seed: 'room-preset',
      color: 'purple',
    };
    await controller.createRoom(request('browser-claim'), roomBody);
    expect(fixture.admission.createRoom).toHaveBeenCalledWith(
      'account-principal',
      {
        gameId: 'seti',
        modeId: roomBody.modeId,
        releaseId: roomBody.releaseId,
        requestId: roomBody.requestId,
        visibility: roomBody.visibility,
        setup: roomBody.setup,
        seed: roomBody.seed,
        color: roomBody.color,
      },
    );

    const soloBody = {
      modeId: 'direct-solo',
      releaseId: 'seti-test-v1',
      requestId: 'solo-request-1',
      setup: {},
      seed: 'solo-preset',
    };
    await controller.solo(request('browser-claim'), soloBody);
    expect(fixture.admission.createDirectSession).toHaveBeenCalledWith(
      'account-principal',
      {
        gameId: 'seti',
        modeId: soloBody.modeId,
        releaseId: soloBody.releaseId,
        requestId: soloBody.requestId,
        setup: soloBody.setup,
        seed: soloBody.seed,
      },
    );
  });

  it('requires a durable channel when the release registry is configured', async () => {
    const fixture = fakeRuntime({
      releaseRegistry: {},
      channelForNewAdmission: vi.fn(async () => ({
        gameId: 'seti',
        modeId: 'direct-solo',
        channel: 'stable',
        releaseId: 'seti-v2',
      })),
      createDirectSessionFromChannel: vi.fn(async () => ({
        sessionId: 'session-v2',
      })),
    });
    const controller = new PlatformController(fixture.runtime);
    await expect(
      controller.solo(request(), {
        modeId: 'direct-solo',
        releaseId: 'browser-selected',
        requestId: 'request-1',
        setup: {},
      }),
    ).rejects.toMatchObject({ envelope: { code: 'INVALID_REQUEST' } });
    await controller.solo(request(), {
      modeId: 'direct-solo',
      channel: 'stable',
      requestId: 'request-2',
      setup: {},
    });
    expect(fixture.runtime.createDirectSessionFromChannel).toHaveBeenCalledWith(
      'account-principal',
      expect.objectContaining({ gameId: 'seti', channel: 'stable' }),
    );
    await expect(
      controller.createRoom(request(), {
        modeId: 'direct-solo',
        releaseId: 'browser-selected',
        visibility: 'private',
        setup: {},
      }),
    ).rejects.toMatchObject({ envelope: { code: 'INVALID_REQUEST' } });
  });

  it('rejects browser supplied identity, route, and credential-shaped fields', async () => {
    const fixture = fakeRuntime();
    const controller = new PlatformController(fixture.runtime);
    const invalidBodies = [
      {
        modeId: 'casual-multiplayer',
        releaseId: 'seti-test-v1',
        visibility: 'private',
        setup: {},
        principalId: 'attacker',
      },
      {
        modeId: 'casual-multiplayer',
        releaseId: 'seti-test-v1',
        visibility: 'private',
        setup: {},
        backendBindingId: 'untrusted-host',
      },
      {
        modeId: 'casual-multiplayer',
        releaseId: 'seti-test-v1',
        visibility: 'private',
        setup: {},
        route,
      },
      {
        modeId: 'casual-multiplayer',
        releaseId: 'seti-test-v1',
        visibility: 'private',
        setup: {},
        authToken: 'secret',
      },
    ];
    for (const body of invalidBodies)
      await expect(
        controller.createRoom(request(), body),
      ).rejects.toMatchObject({ envelope: { code: 'INVALID_REQUEST' } });
    expect(fixture.identity.resolve).not.toHaveBeenCalled();
    expect(fixture.admission.createRoom).not.toHaveBeenCalled();
  });

  it('forwards a selected game to registration validation without accepting host bindings', async () => {
    const fixture = fakeRuntime({
      publicModeId: vi.fn((gameId: string, modeId: string) => {
        if (gameId !== 'brass')
          throw contractError('NOT_FOUND', 'platform.game.unavailable');
        return modeId;
      }),
    });
    const controller = new PlatformController(fixture.runtime);
    await controller.solo(request(), {
      gameId: 'brass',
      modeId: 'automa',
      releaseId: 'brass-v1',
      requestId: 'brass-start',
      setup: {},
    });
    expect(fixture.admission.createDirectSession).toHaveBeenCalledWith(
      'account-principal',
      expect.objectContaining({ gameId: 'brass', releaseId: 'brass-v1' }),
    );
    await expect(
      controller.solo(request(), {
        gameId: 'unknown',
        modeId: 'automa',
        releaseId: 'brass-v1',
        requestId: 'another',
        setup: {},
      }),
    ).rejects.toMatchObject({ envelope: { code: 'NOT_FOUND' } });
  });

  it('pins a session query to the persisted route and rejects a browser route override', async () => {
    const fixture = gatewayRuntime({});
    const controller = new PlatformController(fixture.runtime);
    const pinnedRoute = { ...route };
    const routeOverride = { ...route, backendBindingId: 'attacker-backend' };

    await expect(
      controller.query(request('account-principal'), route.sessionId, {
        revision: 0,
        query: null,
        route: routeOverride,
      } as never),
    ).rejects.toMatchObject({
      envelope: {
        code: 'INVALID_REQUEST',
        messageKey: 'platform.gateway.query.fields',
      },
    });
    expect(
      (fixture.backend.queryOptions as ReturnType<typeof vi.fn>).mock,
    ).toBeDefined();
    expect(fixture.backend.queryOptions).not.toHaveBeenCalled();

    await controller.query(request('account-principal'), route.sessionId, {
      revision: 0,
      query: null,
    });
    const [backendRequest] = (
      fixture.backend.queryOptions as ReturnType<typeof vi.fn>
    ).mock.calls[0] as [{ route: SessionRoute }];
    expect(backendRequest.route).toEqual(pinnedRoute);
  });

  it('runs authorization before game query execution for a denied viewer', async () => {
    const authorize = vi.fn(async () => false);
    const fixture = gatewayRuntime({ authorize });
    const controller = new PlatformController(fixture.runtime);

    await expect(
      controller.query(request('account-principal'), route.sessionId, {
        revision: 0,
        query: null,
      }),
    ).rejects.toMatchObject({ envelope: { code: 'FORBIDDEN' } });
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({ principalId: 'account-principal' }),
      expect.objectContaining({ route }),
      'query',
    );
    expect(fixture.backend.queryOptions).not.toHaveBeenCalled();
  });

  it('exposes the platform-owned result projection through the stable result route', async () => {
    const getCompletion = vi.fn(async () => ({
      status: 'completed',
      result: { kind: 'solo', outcome: 'won' },
    }));
    const fixture = fakeRuntime({ results: { getCompletion } });
    const controller = new PlatformController(fixture.runtime);

    await expect(
      controller.result(request(), route.sessionId),
    ).resolves.toEqual({
      status: 'completed',
      result: { kind: 'solo', outcome: 'won' },
    });
    expect(getCompletion).toHaveBeenCalledWith(
      {
        principalId: 'token-principal',
        authSessionId: 'auth-session-1',
      },
      route.sessionId,
    );
  });
});

describe('PlatformErrorFilter', () => {
  it('returns only the stable contract envelope and disables caching', () => {
    const json = vi.fn();
    const response = {
      setHeader: vi.fn(),
      status: vi.fn(() => ({ json })),
    };
    const host = {
      switchToHttp: () => ({ getResponse: () => response }),
    } as unknown as ArgumentsHost;

    new PlatformErrorFilter().catch(
      contractError('FORBIDDEN', 'platform.session.denied'),
      host,
    );

    expect(response.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'no-store',
    );
    expect(response.status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({
      code: 'FORBIDDEN',
      messageKey: 'platform.session.denied',
      retryable: false,
    });
  });

  it('does not convert unrelated exceptions into a platform response', () => {
    const response = {
      setHeader: vi.fn(),
      status: vi.fn(() => ({ json: vi.fn() })),
    };
    const host = {
      switchToHttp: () => ({ getResponse: () => response }),
    } as unknown as ArgumentsHost;
    const error = new Error('private database detail');

    expect(() => new PlatformErrorFilter().catch(error, host)).toThrow(error);
    expect(response.status).not.toHaveBeenCalled();
  });
});
