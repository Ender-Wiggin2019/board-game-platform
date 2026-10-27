import { generateKeyPairSync } from 'node:crypto';
import {
  type AuthorizationVersionAdvanceInput,
  type BackendPort,
  contractError,
  type MatchAdmission,
  type SessionRoute,
} from '@board-game/contracts';
import type {
  PlatformIdentityReference,
  SessionGateway,
} from '@board-game/core';
import { HttpPlayerTransport } from '@board-game/host';
import {
  AuthorizationTransportError,
  issuePlayerCredential,
  MemoryAuthorizationVersionStore,
  PlayerCredentialError,
  verifyPlayerCredential,
} from '@board-game/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PlatformPlayerConnections,
  type PlatformPlayerIdentityPort,
} from '@/platform/PlatformPlayerConnections.js';

const route: SessionRoute = {
  gameId: 'player-game',
  modeId: 'ranked',
  sessionId: 'player-session-1',
  releaseId: 'player-release-1',
  backendBindingId: 'player-backend-1',
  storageBindingId: 'player-storage-1',
  ownershipEpoch: 'player-owner-1',
};

const admission: MatchAdmission = {
  id: 'player-admission-1',
  route,
  participants: [
    { principalId: 'player-1', seatId: 'seat-1' },
    { principalId: 'player-2', seatId: 'seat-2' },
  ],
  visibility: 'private',
  rating: null,
  validityPolicyVersion: 'validity-1',
  createdAt: 1,
};

const reference: PlatformIdentityReference = {
  principalId: 'player-1',
  authSessionId: 'auth-session-1',
};

const identity: PlatformPlayerIdentityPort = {
  resolve: vi.fn(async () => ({
    principalId: 'player-1',
    authEpoch: 'epoch-1',
    active: true,
  })),
  authorize: vi.fn(async () => true),
  accessScopes: vi.fn(async (_identity, _admission, operation) =>
    operation === 'command'
      ? ['session:command']
      : ['session:view', 'session:spectate'],
  ),
};

const { privateKey, publicKey } = generateKeyPairSync('ed25519');

function sessions(): Pick<SessionGateway, 'descriptor'> {
  return {
    descriptor: vi.fn(async () => ({
      authority: 'platform' as const,
      route,
      status: 'active' as const,
    })),
  };
}

function backend(): BackendPort {
  return {
    submitCommand: vi.fn(async () => ({
      receipt: {
        commandId: 'command-1',
        sessionId: route.sessionId,
        status: 'accepted' as const,
        persistedRevision: 1,
        persistedAt: 1,
        resultRetention: 'ephemeral-result' as const,
      },
    })),
  } as unknown as BackendPort;
}

function commandRequest(inputRoute: SessionRoute = route) {
  return {
    protocolVersion: 1,
    route: inputRoute,
    commandId: 'command-1',
    precondition: { kind: 'revision' as const, expectedRevision: 0 },
    command: { type: 'move' },
  };
}

const running: HttpPlayerTransport[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((transport) => transport.close()));
  vi.mocked(identity.resolve).mockResolvedValue({
    principalId: 'player-1',
    authEpoch: 'epoch-1',
    active: true,
  });
});

describe('PlatformPlayerConnections', () => {
  it('reports a failed revocation sync as pending, bounds the old token by expiry, and permits an idempotent retry', async () => {
    const platformStore = new MemoryAuthorizationVersionStore({
      now: () => 10,
    });
    const gameStore = new MemoryAuthorizationVersionStore({ now: () => 10 });
    const revoke = vi.fn(
      async (input: Parameters<typeof gameStore.revoke>[0]) =>
        gameStore.revoke(input),
    );
    const service = new PlatformPlayerConnections({
      platformId: 'platform-1',
      audience: 'player-game-service',
      sessions: sessions(),
      admission: { getAdmission: async () => admission },
      identity,
      authorizationStore: platformStore,
      resolveAuthorizationSync: async () => ({
        advance: (input) => gameStore.advance(input),
        revoke,
      }),
      resolvePlayerEndpoint: async () => 'https://game.example/player',
      privateKey,
      ttlMs: 10_000,
      now: () => 10,
    });
    const connection = await service.connect(reference, route.sessionId);
    revoke.mockRejectedValueOnce(
      new AuthorizationTransportError('NETWORK', 'offline', true),
    );
    await expect(
      service.revokePrincipal({ route, principalId: reference.principalId }),
    ).rejects.toMatchObject({
      envelope: {
        code: 'NOT_READY',
        messageKey: 'platform.player.revocation_pending',
        retryable: true,
      },
    });
    const verify = (now: number) =>
      verifyPlayerCredential({
        token: connection.token,
        publicKey,
        expectedPlatformId: 'platform-1',
        expectedAudience: 'player-game-service',
        expectedRoute: route,
        authorizationStore: gameStore,
        now,
      });
    await expect(verify(11)).resolves.toMatchObject({
      principalId: 'player-1',
    });
    await expect(verify(connection.expiresAt)).rejects.toMatchObject({
      code: 'CREDENTIAL_EXPIRED',
    });
    await expect(
      service.revokePrincipal({ route, principalId: reference.principalId }),
    ).resolves.toMatchObject({ authorizationRevision: 1, revokedAt: 10 });
    expect(revoke.mock.calls[1]).toEqual(revoke.mock.calls[0]);
    await expect(verify(11)).rejects.toMatchObject({
      code: 'AUTHORIZATION_REVOKED',
    });
  });

  it('pins the descriptor route and rejects a forged seat before issuing', async () => {
    const store = new MemoryAuthorizationVersionStore({ now: () => 10 });
    const gameStore = new MemoryAuthorizationVersionStore({ now: () => 10 });
    const sync = {
      advance: async (input: AuthorizationVersionAdvanceInput) =>
        gameStore.advance(input),
      revoke: async (input: Parameters<typeof gameStore.revoke>[0]) =>
        gameStore.revoke(input),
    };
    const service = new PlatformPlayerConnections({
      platformId: 'platform-1',
      audience: 'player-game-service',
      sessions: sessions(),
      admission: { getAdmission: async () => admission },
      identity,
      authorizationStore: store,
      resolveAuthorizationSync: async () => sync,
      resolvePlayerEndpoint: async () => 'https://game.example/player',
      privateKey,
      now: () => 10,
    });

    const first = await service.connect(reference, route.sessionId);
    expect(first.playerEndpoint).toBe('https://game.example/player');
    expect(first.route).toEqual(route);
    expect(first.client).toEqual({
      endpoint: first.playerEndpoint,
      route,
    });
    await expect(
      service.connect({ ...reference, seatId: 'seat-2' }, route.sessionId),
    ).rejects.toMatchObject({ envelope: { code: 'FORBIDDEN' } });
    expect(
      await store.get({
        platformId: 'platform-1',
        sessionId: route.sessionId,
        principalId: 'player-1',
      }),
    ).toMatchObject({ authorizationRevision: 1, seatId: 'seat-1' });
    await service.revokePrincipal({ route, principalId: 'player-1' });
    expect(
      await gameStore.get({
        platformId: 'platform-1',
        sessionId: route.sessionId,
        principalId: 'player-1',
      }),
    ).toMatchObject({ authorizationRevision: 1, revokedAt: 10 });
  });

  it('reuses a revision for renewal and increments only after authorization changes', async () => {
    const store = new MemoryAuthorizationVersionStore({ now: () => 10 });
    const service = new PlatformPlayerConnections({
      platformId: 'platform-1',
      audience: 'player-game-service',
      sessions: sessions(),
      admission: { getAdmission: async () => admission },
      identity,
      authorizationStore: store,
      resolveAuthorizationSync: async () => ({
        advance: async (input: AuthorizationVersionAdvanceInput) =>
          store.advance(input),
        revoke: async (input: Parameters<typeof store.revoke>[0]) =>
          store.revoke(input),
      }),
      resolvePlayerEndpoint: async () => 'https://game.example/player',
      privateKey,
      now: () => 10,
    });
    await service.connect(reference, route.sessionId);
    await service.connect(reference, route.sessionId);
    expect(
      await store.get({
        platformId: 'platform-1',
        sessionId: route.sessionId,
        principalId: 'player-1',
      }),
    ).toMatchObject({ authorizationRevision: 1 });
    vi.mocked(identity.resolve).mockResolvedValue({
      principalId: 'player-1',
      authEpoch: 'epoch-2',
      active: true,
    });
    await service.connect(reference, route.sessionId);
    expect(
      await store.get({
        platformId: 'platform-1',
        sessionId: route.sessionId,
        principalId: 'player-1',
      }),
    ).toMatchObject({ authorizationRevision: 2, authEpoch: 'epoch-2' });
  });

  it('keeps a valid command working while the platform is offline, then rejects it after an auth update', async () => {
    const platformStore = new MemoryAuthorizationVersionStore({
      now: () => 10,
    });
    const gameStore = new MemoryAuthorizationVersionStore({ now: () => 10 });
    const sync = {
      advance: async (input: AuthorizationVersionAdvanceInput) =>
        gameStore.advance(input),
      revoke: async (input: Parameters<typeof gameStore.revoke>[0]) =>
        gameStore.revoke(input),
    };
    let address: string | undefined;
    let platformOnline = true;
    const service = new PlatformPlayerConnections({
      platformId: 'platform-1',
      audience: 'player-game-service',
      sessions: sessions(),
      admission: { getAdmission: async () => admission },
      identity,
      authorizationStore: platformStore,
      resolveAuthorizationSync: async () => {
        if (!platformOnline) throw new Error('platform offline');
        return sync;
      },
      resolvePlayerEndpoint: async () => address ?? '',
      privateKey,
      now: () => 1_000,
    });
    const gameBackend = backend();
    const gameTransport = new HttpPlayerTransport({
      backend: gameBackend,
      allowedOrigins: [],
      authorize: async (token, _operation, request) => {
        try {
          return await verifyPlayerCredential({
            token,
            publicKey,
            expectedPlatformId: 'platform-1',
            expectedAudience: 'player-game-service',
            expectedRoute: request.route as SessionRoute,
            authorizationStore: gameStore,
            now: 1_000,
          });
        } catch (error) {
          if (error instanceof PlayerCredentialError) {
            throw contractError(
              error.code === 'CREDENTIAL_EXPIRED'
                ? 'UNAUTHENTICATED'
                : 'FORBIDDEN',
              'test.player.credential_denied',
            );
          }
          throw error;
        }
      },
    });
    const gameAddress = await gameTransport.listen();
    running.push(gameTransport);
    address = `http://127.0.0.1:${gameAddress.port}`;
    const connection = await service.connect(reference, route.sessionId);
    platformOnline = false;

    const post = (token: string, request: unknown) =>
      fetch(`${connection.playerEndpoint}/v1/submitCommand`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ protocolVersion: 1, request }),
      });
    await expect(
      post(connection.token, commandRequest()).then(
        (response) => response.status,
      ),
    ).resolves.toBe(200);

    const wrongRoute = { ...route, sessionId: 'other-session' };
    await expect(
      post(connection.token, commandRequest(wrongRoute)).then(
        (response) => response.status,
      ),
    ).resolves.toBe(403);

    const expired = issuePlayerCredential({
      privateKey,
      platformId: 'platform-1',
      audience: 'player-game-service',
      route,
      principalId: 'player-1',
      seatId: 'seat-1',
      scopes: ['session:view', 'session:command'],
      authEpoch: 'epoch-1',
      authorizationRevision: 1,
      issuedAt: 1,
      expiresAt: 2,
    });
    await expect(
      post(expired, commandRequest()).then((response) => response.status),
    ).resolves.toBe(401);

    vi.mocked(identity.resolve).mockResolvedValue({
      principalId: 'player-1',
      authEpoch: 'epoch-2',
      active: true,
    });
    platformOnline = true;
    await service.connect(reference, route.sessionId);
    platformOnline = false;
    await expect(
      post(connection.token, commandRequest()).then(
        (response) => response.status,
      ),
    ).resolves.toBe(403);
    expect(gameBackend.submitCommand).toHaveBeenCalledTimes(1);
  });
});
