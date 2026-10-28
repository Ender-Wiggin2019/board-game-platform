import { generateKeyPairSync } from 'node:crypto';
import type {
  MatchAdmission,
  PlatformRoom,
  SessionRoute,
} from '@board-game/contracts';
import type { AdmissionStore, StartOperation } from '@board-game/core';
import {
  MemoryAuthorizationVersionStore,
  verifyPlayerCredential,
} from '@board-game/server';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findActiveSession } from '@/auth/active-session.js';
import {
  PlatformIdentity,
  type PlatformIdentityAccount,
} from '@/platform/PlatformIdentity.js';
import { PlatformPlayerConnections } from '@/platform/PlatformPlayerConnections.js';

vi.mock('@/auth/active-session.js', () => ({ findActiveSession: vi.fn() }));

const brassRoute: SessionRoute = {
  gameId: 'brass',
  modeId: 'competitive-multiplayer',
  releaseId: 'brass-release-1',
  sessionId: 'brass-session-1',
  backendBindingId: 'embedded-brass',
  storageBindingId: 'brass-storage',
  ownershipEpoch: 'brass-1',
};

const setiRoute: SessionRoute = {
  ...brassRoute,
  gameId: 'seti',
  sessionId: 'seti-session-1',
};

const brassAdmission: MatchAdmission = {
  id: 'brass-admission-1',
  route: brassRoute,
  participants: [
    { principalId: 'alice', seatId: 'brass-seat-1' },
    { principalId: 'bob', seatId: 'brass-seat-2' },
  ],
  rating: null,
  visibility: 'private',
  validityPolicyVersion: 'brass-v1',
  createdAt: 1,
};

const publicPrincipalId = '00000000-0000-4000-8000-000000000001';

function publicAccountFixture(account: PlatformIdentityAccount | undefined) {
  const select = vi.fn(() => ({
    from: () => ({
      where: () => ({
        limit: async () => (account ? [account] : []),
      }),
    }),
  }));
  const db = { select } as unknown as NodePgDatabase;
  const identity = new PlatformIdentity(db, {} as AdmissionStore, 'brass');
  return { identity, select };
}

function setup() {
  const accounts = new Map([
    [
      'alice',
      {
        id: 'alice',
        name: 'Alice',
        accountStatus: 'active',
        sessionVersion: 4,
        permissionVersion: 7,
        role: 'player',
        navigatorGrantedAt: null,
        navigatorExpiresAt: null,
      },
    ],
    [
      'bob',
      {
        id: 'bob',
        name: 'Bob',
        accountStatus: 'active',
        sessionVersion: 2,
        permissionVersion: 3,
        role: 'player',
        navigatorGrantedAt: null,
        navigatorExpiresAt: null,
      },
    ],
    [
      'outsider',
      {
        id: 'outsider',
        name: 'Outsider',
        accountStatus: 'active',
        sessionVersion: 1,
        permissionVersion: 1,
        role: 'player',
        navigatorGrantedAt: null,
        navigatorExpiresAt: null,
      },
    ],
  ]);
  const select = vi.fn((fields: Record<string, unknown>) => {
    if ('sessionVersion' in fields) {
      return {
        from: () => ({
          where: (condition: unknown) => ({
            limit: async () => {
              void condition;
              const account = [...accounts.values()].find(
                (candidate) => candidate.id === 'alice',
              );
              return account ? [account] : [];
            },
          }),
        }),
      };
    }
    return {
      from: () => ({
        where: async () =>
          [...accounts.values()].map(({ id, name }) => ({ id, name })),
      }),
    };
  });
  const execute = vi.fn(async () => ({ rowCount: 1, rows: [{ id: 1 }] }));
  const db = { select, execute } as unknown as NodePgDatabase;
  const getStartBySession = vi.fn(async (sessionId: string) => {
    if (sessionId !== brassRoute.sessionId) return null;
    return {
      state: 'active',
      route: brassRoute,
      admission: brassAdmission,
    } as never;
  });
  const store = {
    getStartBySession,
    getRoom: vi.fn(),
  } as unknown as AdmissionStore;
  const identity = new PlatformIdentity(db, store, 'brass');
  return { accounts, select, execute, getStartBySession, identity, db, store };
}

beforeEach(() => {
  vi.mocked(findActiveSession).mockResolvedValue({
    id: 'auth-alice',
    userId: 'alice',
    csrfHash: 'unused',
  });
});

describe('generic platform identity', () => {
  it('rejects a malformed public principal before querying the account store', async () => {
    const fixture = publicAccountFixture(undefined);
    await expect(
      fixture.identity.resolvePublicAccount('abc'),
    ).rejects.toMatchObject({
      envelope: { code: 'INVALID_REQUEST' },
    });
    expect(fixture.select).not.toHaveBeenCalled();
  });

  it('returns NOT_FOUND for an unknown public principal', async () => {
    const fixture = publicAccountFixture(undefined);
    await expect(
      fixture.identity.resolvePublicAccount(publicPrincipalId),
    ).rejects.toMatchObject({ envelope: { code: 'NOT_FOUND' } });
  });

  it('hides a suspended public principal as NOT_FOUND', async () => {
    const fixture = publicAccountFixture({
      id: publicPrincipalId,
      accountStatus: 'suspended',
      sessionVersion: 1,
      permissionVersion: 1,
      role: 'player',
      navigatorGrantedAt: null,
      navigatorExpiresAt: null,
    });
    await expect(
      fixture.identity.resolvePublicAccount(publicPrincipalId),
    ).rejects.toMatchObject({ envelope: { code: 'NOT_FOUND' } });
  });

  it('admits an authenticated second-game account and rejects another game route', async () => {
    const fixture = setup();
    const resolved = await fixture.identity.resolve({
      principalId: 'alice',
      authSessionId: 'auth-alice',
    });

    await expect(
      fixture.identity.authorize(resolved, brassAdmission, 'command'),
    ).resolves.toBe(true);
    await expect(
      fixture.identity.authorize(
        resolved,
        { ...brassAdmission, route: setiRoute },
        'command',
      ),
    ).resolves.toBe(false);
    await expect(
      fixture.identity.notificationAccess(setiRoute),
    ).rejects.toMatchObject({ envelope: { code: 'FORBIDDEN' } });
  });

  it('keeps the account epoch stable across active login sessions while rechecking each session', async () => {
    const fixture = setup();
    const activeSessions = new Set(['auth-alice', 'auth-mobile']);
    vi.mocked(findActiveSession).mockImplementation(
      async (_db, authSessionId, principalId) =>
        activeSessions.has(authSessionId)
          ? {
              id: authSessionId,
              userId: principalId ?? 'alice',
              csrfHash: 'unused',
            }
          : undefined,
    );

    const desktop = await fixture.identity.resolve({
      principalId: 'alice',
      authSessionId: 'auth-alice',
    });
    const mobile = await fixture.identity.resolve({
      principalId: 'alice',
      authSessionId: 'auth-mobile',
    });

    expect(mobile.authEpoch).toBe(desktop.authEpoch);
    expect(desktop.authSessionId).toBe('auth-alice');
    expect(mobile.authSessionId).toBe('auth-mobile');
    await expect(
      fixture.identity.authorize(desktop, brassAdmission, 'view'),
    ).resolves.toBe(true);

    activeSessions.delete('auth-alice');
    await expect(
      fixture.identity.authorize(desktop, brassAdmission, 'view'),
    ).rejects.toMatchObject({ envelope: { code: 'UNAUTHENTICATED' } });
    await expect(
      fixture.identity.authorize(mobile, brassAdmission, 'view'),
    ).resolves.toBe(true);

    const account = fixture.accounts.get('alice');
    if (!account) throw new Error('account fixture missing');
    account.permissionVersion += 1;
    const current = await fixture.identity.resolve({
      principalId: 'alice',
      authSessionId: 'auth-mobile',
    });
    expect(current.authEpoch).not.toBe(mobile.authEpoch);
    await expect(
      fixture.identity.authorize(mobile, brassAdmission, 'view'),
    ).resolves.toBe(false);
  });

  it('keeps both active login credentials valid through the real player connection and signer', async () => {
    const fixture = setup();
    const activeSessions = new Set(['auth-alice', 'auth-mobile']);
    vi.mocked(findActiveSession).mockImplementation(
      async (_db, authSessionId, principalId) =>
        activeSessions.has(authSessionId)
          ? {
              id: authSessionId,
              userId: principalId ?? 'alice',
              csrfHash: 'unused',
            }
          : undefined,
    );
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const platformStore = new MemoryAuthorizationVersionStore({
      now: () => 10,
    });
    const gameStore = new MemoryAuthorizationVersionStore({ now: () => 10 });
    const service = new PlatformPlayerConnections({
      platformId: 'platform-1',
      audience: 'brass-player-service',
      sessions: {
        descriptor: async (_reference, sessionId) => {
          if (sessionId !== brassRoute.sessionId)
            throw new Error('fixture session not found');
          return {
            authority: 'platform' as const,
            route: brassRoute,
            status: 'active' as const,
          };
        },
      },
      admission: {
        getAdmission: async (sessionId) =>
          sessionId === brassRoute.sessionId ? brassAdmission : null,
      },
      identity: fixture.identity,
      authorizationStore: platformStore,
      resolveAuthorizationSync: async () => ({
        advance: (input) => gameStore.advance(input),
        revoke: (input) => gameStore.revoke(input),
      }),
      resolvePlayerEndpoint: async () => 'http://127.0.0.1:43123/player',
      privateKey,
      now: () => 10,
    });
    const verify = (token: string) =>
      verifyPlayerCredential({
        token,
        publicKey,
        expectedPlatformId: 'platform-1',
        expectedAudience: 'brass-player-service',
        expectedRoute: brassRoute,
        authorizationStore: gameStore,
        now: 10,
      });

    const desktop = await service.connect(
      { principalId: 'alice', authSessionId: 'auth-alice' },
      brassRoute.sessionId,
    );
    const mobile = await service.connect(
      { principalId: 'alice', authSessionId: 'auth-mobile' },
      brassRoute.sessionId,
    );
    const stored = await platformStore.get({
      platformId: 'platform-1',
      sessionId: brassRoute.sessionId,
      principalId: 'alice',
    });
    expect(stored).toMatchObject({
      authorizationRevision: 1,
      authEpoch: JSON.stringify(['alice', 4, 7]),
    });
    await expect(
      gameStore.get({
        platformId: 'platform-1',
        sessionId: brassRoute.sessionId,
        principalId: 'alice',
      }),
    ).resolves.toMatchObject({ authorizationRevision: 1 });
    expect(mobile.expiresAt).toBe(desktop.expiresAt);
    await expect(verify(desktop.token)).resolves.toMatchObject({
      principalId: 'alice',
      seatId: 'brass-seat-1',
    });
    await expect(verify(mobile.token)).resolves.toMatchObject({
      principalId: 'alice',
      seatId: 'brass-seat-1',
    });

    const account = fixture.accounts.get('alice');
    if (!account) throw new Error('account fixture missing');
    account.permissionVersion += 1;
    const refreshed = await service.connect(
      { principalId: 'alice', authSessionId: 'auth-mobile' },
      brassRoute.sessionId,
    );
    await expect(verify(desktop.token)).rejects.toMatchObject({
      code: 'AUTHORIZATION_MISMATCH',
    });
    await expect(verify(mobile.token)).rejects.toMatchObject({
      code: 'AUTHORIZATION_MISMATCH',
    });
    await expect(verify(refreshed.token)).resolves.toMatchObject({
      principalId: 'alice',
    });
    await expect(
      gameStore.get({
        platformId: 'platform-1',
        sessionId: brassRoute.sessionId,
        principalId: 'alice',
      }),
    ).resolves.toMatchObject({ authorizationRevision: 2 });

    activeSessions.delete('auth-alice');
    await expect(
      service.connect(
        { principalId: 'alice', authSessionId: 'auth-alice' },
        brassRoute.sessionId,
      ),
    ).rejects.toMatchObject({ envelope: { code: 'UNAUTHENTICATED' } });
  });

  it('rechecks stable account epochs for host player and admin contexts', async () => {
    const fixture = setup();
    const identity = await fixture.identity.resolve({
      principalId: 'alice',
      authSessionId: 'auth-alice',
    });
    const access = {
      principalId: identity.principalId,
      authEpoch: identity.authEpoch,
      scopes: ['session:view', 'session:command'],
    } as const;

    await expect(
      fixture.identity.authorizeHost(access, 'summary', brassRoute),
    ).resolves.toBeUndefined();
    await expect(
      fixture.identity.authorizeHost(access, 'command', brassRoute),
    ).resolves.toBeUndefined();

    const account = fixture.accounts.get('alice');
    if (!account) throw new Error('account fixture missing');
    account.permissionVersion += 1;
    await expect(
      fixture.identity.authorizeHost(access, 'summary', brassRoute),
    ).rejects.toMatchObject({ envelope: { code: 'FORBIDDEN' } });

    account.permissionVersion -= 1;
    account.accountStatus = 'suspended';
    await expect(
      fixture.identity.authorizeHost(access, 'summary', brassRoute),
    ).rejects.toMatchObject({ envelope: { code: 'UNAUTHENTICATED' } });
  });

  it('accepts a legacy session-first epoch while its login session remains active', async () => {
    const fixture = setup();
    const legacyAccess = {
      principalId: 'alice',
      authEpoch: JSON.stringify(['auth-alice', 4, 7]),
      scopes: ['session:view'],
    } as const;

    await expect(
      fixture.identity.authorizeHost(legacyAccess, 'summary', brassRoute),
    ).resolves.toBeUndefined();
    vi.mocked(findActiveSession).mockResolvedValue(undefined);
    await expect(
      fixture.identity.authorizeHost(legacyAccess, 'summary', brassRoute),
    ).rejects.toMatchObject({ envelope: { code: 'UNAUTHENTICATED' } });
  });

  it('does not let a game host hook bypass stable account checks', async () => {
    const fixture = setup();
    const hook = vi.fn(async () => 'allow' as const);
    const hooked = new PlatformIdentity(fixture.db, fixture.store, 'brass', {
      authorizeHost: hook,
    });
    const identity = await hooked.resolve({
      principalId: 'alice',
      authSessionId: 'auth-alice',
    });
    const access = {
      principalId: identity.principalId,
      authEpoch: identity.authEpoch,
      scopes: ['session:view'],
    } as const;

    await expect(
      hooked.authorizeHost(access, 'summary', brassRoute),
    ).resolves.toBeUndefined();
    const account = fixture.accounts.get('alice');
    if (!account) throw new Error('account fixture missing');
    account.accountStatus = 'suspended';
    await expect(
      hooked.authorizeHost(access, 'summary', brassRoute),
    ).rejects.toMatchObject({ envelope: { code: 'UNAUTHENTICATED' } });
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('keeps admin role checks on stable host contexts', async () => {
    const fixture = setup();
    const account = fixture.accounts.get('alice');
    if (!account) throw new Error('account fixture missing');
    account.role = 'admin';
    const access = await fixture.identity.adminAccess(
      { principalId: 'alice', authSessionId: 'auth-alice' },
      brassRoute,
    );
    await expect(
      fixture.identity.authorizeHost(access, 'control', brassRoute),
    ).resolves.toBeUndefined();
    account.role = 'player';
    await expect(
      fixture.identity.authorizeHost(access, 'control', brassRoute),
    ).rejects.toMatchObject({ envelope: { code: 'FORBIDDEN' } });
  });

  it('accepts only a matching request-scoped identity context', async () => {
    const fixture = setup();
    const resolved = await fixture.identity.resolve({
      principalId: 'alice',
      authSessionId: 'auth-alice',
    });
    const account = fixture.accounts.get('alice');
    if (!account) throw new Error('account fixture missing');
    fixture.select.mockClear();
    vi.mocked(findActiveSession).mockClear();

    await expect(
      fixture.identity.authorize(resolved, brassAdmission, 'view', [], {
        identity: resolved,
        account,
      }),
    ).resolves.toBe(true);
    expect(fixture.select).not.toHaveBeenCalled();
    expect(findActiveSession).not.toHaveBeenCalled();

    await expect(
      fixture.identity.authorize(resolved, brassAdmission, 'view', [], {
        identity: { ...resolved, authEpoch: 'stale' },
        account,
      }),
    ).resolves.toBe(false);
  });

  it('invalidates the account when its auth session is revoked', async () => {
    const fixture = setup();
    const resolved = await fixture.identity.resolve({
      principalId: 'alice',
      authSessionId: 'auth-alice',
    });
    vi.mocked(findActiveSession).mockResolvedValue(undefined);

    await expect(
      fixture.identity.authorize(resolved, brassAdmission, 'view'),
    ).rejects.toMatchObject({ envelope: { code: 'UNAUTHENTICATED' } });
    await expect(
      fixture.identity.resolve({
        principalId: 'alice',
        authSessionId: 'auth-alice',
      }),
    ).rejects.toMatchObject({ envelope: { code: 'UNAUTHENTICATED' } });
  });

  it('keeps private room reads to members or an explicit active grant', async () => {
    const fixture = setup();
    const room: PlatformRoom = {
      id: 'brass-room-1',
      ownerId: 'alice',
      gameId: 'brass',
      modeId: brassRoute.modeId,
      releaseId: brassRoute.releaseId,
      visibility: 'private',
      setup: {},
      members: [{ principalId: 'alice', seatId: 'seat-1', ready: false }],
      revision: 0,
      startGeneration: 0,
      status: 'open',
    };

    await expect(
      fixture.identity.authorizeRoom('outsider', room, 'read'),
    ).resolves.toBe(false);
    await expect(
      fixture.identity.authorizeRoom('outsider', room, 'read', {
        security: {},
        grants: [
          {
            grantId: 'grant-1',
            roomId: room.id,
            principalId: 'outsider',
            state: 'pending',
          },
        ],
      }),
    ).resolves.toBe(true);
    await expect(
      fixture.identity.authorizeRoom('alice', room, 'read'),
    ).resolves.toBe(true);
  });

  it('lets an invitee decline its pending grant without joining the room', async () => {
    const fixture = setup();
    const room: PlatformRoom = {
      id: 'brass-room-decline',
      ownerId: 'alice',
      gameId: 'brass',
      modeId: brassRoute.modeId,
      releaseId: brassRoute.releaseId,
      visibility: 'private',
      setup: {},
      members: [{ principalId: 'alice', seatId: 'seat-1', ready: false }],
      revision: 0,
      startGeneration: 0,
      status: 'open',
    };

    await expect(
      fixture.identity.authorizeRoom('outsider', room, 'decline', {
        security: {},
        grants: [
          {
            grantId: 'grant-decline',
            roomId: room.id,
            principalId: 'outsider',
            state: 'pending',
          },
        ],
      }),
    ).resolves.toBe(true);
    await expect(
      fixture.identity.authorizeRoom('outsider', room, 'read-invitation', {
        security: {},
        grants: [
          {
            grantId: 'grant-decline',
            roomId: room.id,
            principalId: 'outsider',
            state: 'pending',
          },
        ],
      }),
    ).resolves.toBe(true);
    await expect(
      fixture.identity.authorizeRoom('outsider', room, 'decline', {
        security: {},
        grants: [
          {
            grantId: 'grant-decline',
            roomId: room.id,
            principalId: 'outsider',
            state: 'revoked',
          },
        ],
      }),
    ).resolves.toBe(false);
  });

  it('freezes common display names, seats and existing public profile fields', async () => {
    const fixture = setup();
    const room: PlatformRoom = {
      id: 'brass-room-2',
      ownerId: 'alice',
      gameId: 'brass',
      modeId: brassRoute.modeId,
      releaseId: brassRoute.releaseId,
      visibility: 'public',
      setup: {},
      members: [
        {
          principalId: 'alice',
          seatId: 'seat-1',
          ready: false,
          publicProfile: { appearance: { color: 'orange' } },
        },
      ],
      revision: 0,
      startGeneration: 0,
      status: 'open',
    };

    await expect(fixture.identity.freezeParticipants(room)).resolves.toEqual([
      {
        principalId: 'alice',
        seatId: 'seat-1',
        publicProfile: {
          displayName: 'Alice',
          appearance: { color: 'orange' },
        },
      },
    ]);
  });

  it('freezes bot profiles without resolving a bot account', async () => {
    const fixture = setup();
    const bot = {
      principalId: 'bot:brass-room-3:one',
      seatId: 'bot:brass-room-3:seat:one',
      controller: 'bot' as const,
      ready: true,
      publicProfile: {
        displayName: 'Brass Bot',
        gameProfile: { kind: 'brass-bot' },
      },
    };
    const room: PlatformRoom = {
      id: 'brass-room-3',
      ownerId: 'alice',
      gameId: 'brass',
      modeId: brassRoute.modeId,
      releaseId: brassRoute.releaseId,
      visibility: 'private',
      setup: {},
      members: [{ principalId: 'alice', seatId: 'seat-1', ready: false }, bot],
      revision: 1,
      startGeneration: 0,
      status: 'open',
    };

    fixture.select.mockClear();
    await expect(fixture.identity.freezeParticipants(room)).resolves.toEqual([
      {
        principalId: 'alice',
        seatId: 'seat-1',
        publicProfile: { displayName: 'Alice' },
      },
      {
        principalId: bot.principalId,
        seatId: bot.seatId,
        controller: 'bot',
        publicProfile: bot.publicProfile,
      },
    ]);
    expect(fixture.select).toHaveBeenCalledTimes(1);
  });

  it('maps hotseat access to its controlling account and rejects the synthetic browser identity', async () => {
    const fixture = setup();
    const hotseat = {
      principalId: 'hotseat:brass-room:one',
      seatId: 'hotseat:brass-room:seat:one',
      controller: 'hotseat' as const,
      controlledBy: 'alice',
    };
    const admission: MatchAdmission = {
      ...brassAdmission,
      participants: [{ principalId: 'alice', seatId: 'seat-1' }, hotseat],
    };
    const room: PlatformRoom = {
      id: 'brass-hotseat-room',
      ownerId: 'alice',
      gameId: 'brass',
      modeId: brassRoute.modeId,
      releaseId: brassRoute.releaseId,
      visibility: 'private',
      setup: {},
      members: [
        { principalId: 'alice', seatId: 'seat-1', ready: false },
        { ...hotseat, ready: true },
      ],
      revision: 1,
      startGeneration: 0,
      status: 'open',
    };

    const alice = await fixture.identity.resolve({
      principalId: 'alice',
      authSessionId: 'auth-alice',
    });
    await expect(
      fixture.identity.authorize(alice, admission, 'command'),
    ).resolves.toBe(true);
    await expect(
      fixture.identity.authorizeRoom('alice', room, 'read'),
    ).resolves.toBe(true);

    fixture.select.mockClear();
    const syntheticIdentity = {
      principalId: hotseat.principalId,
      authEpoch: 'synthetic-epoch',
      active: true,
    };
    await expect(
      fixture.identity.authorize(syntheticIdentity, admission, 'view'),
    ).resolves.toBe(false);
    await expect(
      fixture.identity.accessScopes(syntheticIdentity, admission, 'view'),
    ).resolves.toEqual([]);
    await expect(
      fixture.identity.authorizeRoom(hotseat.principalId, room, 'read'),
    ).resolves.toBe(false);
    expect(fixture.select).not.toHaveBeenCalled();
  });

  it('rejects a game freeze hook that changes a frozen seat identity', async () => {
    const fixture = setup();
    const identity = new PlatformIdentity(fixture.db, fixture.store, 'brass', {
      freezeParticipants: async () => [
        { principalId: 'attacker', seatId: 'seat-1' },
      ],
    });
    const room: PlatformRoom = {
      id: 'brass-freeze-tamper',
      ownerId: 'alice',
      gameId: 'brass',
      modeId: brassRoute.modeId,
      releaseId: brassRoute.releaseId,
      visibility: 'private',
      setup: {},
      members: [{ principalId: 'alice', seatId: 'seat-1', ready: false }],
      revision: 0,
      startGeneration: 0,
      status: 'open',
    };

    await expect(identity.freezeParticipants(room)).rejects.toMatchObject({
      envelope: { messageKey: 'platform.start.roster' },
    });
  });

  it('denies bot session and private room authority without account queries', async () => {
    const fixture = setup();
    const botPrincipalId = 'bot:brass-room-4:one';
    const bot = {
      principalId: botPrincipalId,
      seatId: 'bot:brass-room-4:seat:one',
      controller: 'bot' as const,
    };
    const botAdmission: MatchAdmission = {
      ...brassAdmission,
      participants: [bot],
    };
    const botIdentity = {
      principalId: botPrincipalId,
      authEpoch: 'bot-epoch',
      active: true,
    };
    const room: PlatformRoom = {
      id: 'brass-room-4',
      ownerId: 'alice',
      gameId: 'brass',
      modeId: brassRoute.modeId,
      releaseId: brassRoute.releaseId,
      visibility: 'private',
      setup: {},
      members: [
        { principalId: 'alice', seatId: 'seat-1', ready: false },
        { ...bot, ready: true },
      ],
      revision: 0,
      startGeneration: 0,
      status: 'open',
    };

    fixture.select.mockClear();
    await expect(
      fixture.identity.authorize(botIdentity, botAdmission, 'command'),
    ).resolves.toBe(false);
    await expect(
      fixture.identity.authorize(botIdentity, botAdmission, 'view'),
    ).resolves.toBe(false);
    await expect(
      fixture.identity.accessScopes(botIdentity, botAdmission, 'command'),
    ).resolves.toEqual([]);
    await expect(
      fixture.identity.authorizeRoom(botPrincipalId, room, 'read'),
    ).resolves.toBe(false);
    expect(fixture.select).not.toHaveBeenCalled();
  });

  it('starts a mixed human and bot roster without checking a bot account', async () => {
    const fixture = setup();
    const botPrincipalId = 'bot:brass-room-5:one';
    const bot = {
      principalId: botPrincipalId,
      seatId: 'bot:brass-room-5:seat:one',
      controller: 'bot' as const,
    };
    const room: PlatformRoom = {
      id: 'brass-room-5',
      ownerId: 'alice',
      gameId: 'brass',
      modeId: brassRoute.modeId,
      releaseId: brassRoute.releaseId,
      visibility: 'private',
      setup: {},
      members: [
        { principalId: 'alice', seatId: 'seat-1', ready: false },
        { ...bot, ready: true },
      ],
      revision: 1,
      startGeneration: 0,
      status: 'open',
    };
    fixture.store.getRoom = vi.fn(async () => room);
    const operation: StartOperation = {
      startId: 'brass-start-5',
      sessionId: brassRoute.sessionId,
      roomId: room.id,
      state: 'active',
      route: brassRoute,
      requestId: 'brass-start-request-5',
      requestDigest: 'brass-start-digest-5',
      initiatedBy: 'alice',
      startGeneration: 1,
      setup: {},
      seed: 'brass-start-seed-5',
      admission: {
        ...brassAdmission,
        participants: [{ principalId: 'alice', seatId: 'seat-1' }, bot],
      },
    };

    fixture.select.mockClear();
    await expect(
      fixture.identity.startAccess(operation),
    ).resolves.toMatchObject({
      principalId: 'platform:session-start',
    });
    expect(fixture.select).toHaveBeenCalledTimes(1);

    fixture.select.mockClear();
    await expect(
      fixture.identity.startAccess({ ...operation, state: 'cancelling' }),
    ).resolves.toMatchObject({ principalId: 'platform:session-start' });
    expect(fixture.select).not.toHaveBeenCalled();
  });

  it('fences service scopes to the pinned game and exact operation', async () => {
    const fixture = setup();
    const access = await fixture.identity.notificationAccess(brassRoute);
    await expect(
      fixture.identity.authorizeHost(access, 'summary', brassRoute),
    ).resolves.toBeUndefined();
    await expect(
      fixture.identity.authorizeHost(access, 'query', brassRoute),
    ).rejects.toMatchObject({ envelope: { code: 'FORBIDDEN' } });
    await expect(
      fixture.identity.authorizeHost(
        { ...access, scopes: [...access.scopes, 'session:admin'] },
        'summary',
        brassRoute,
      ),
    ).rejects.toMatchObject({ envelope: { code: 'FORBIDDEN' } });
    await expect(
      fixture.identity.systemAccess(setiRoute),
    ).rejects.toMatchObject({ envelope: { code: 'FORBIDDEN' } });
  });
});
