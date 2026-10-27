import { generateKeyPairSync, sign } from 'node:crypto';
import {
  canonicalStableStringify,
  type SessionRoute,
} from '@board-game/contracts';
import { describe, expect, it } from 'vitest';
import {
  HttpAuthorizationVersionClient,
  HttpAuthorizationVersionServer,
  issuePlayerCredential,
  MemoryAuthorizationVersionStore,
  PlayerCredentialError,
  verifyPlayerCredential,
} from '../src/index.js';

const route: SessionRoute = {
  gameId: 'credential-game',
  modeId: 'ranked',
  sessionId: 'credential-session',
  releaseId: 'credential-release',
  backendBindingId: 'credential-backend',
  storageBindingId: 'credential-storage',
  ownershipEpoch: 'credential-epoch',
};

const platformId = 'credential-platform';
const audience = 'https://game.example/player';
const principalId = 'player-1';
const now = 1_700_000_000_000;
const { privateKey, publicKey } = generateKeyPairSync('ed25519');

function authorization(
  revision = 1,
  overrides: Partial<{
    readonly route: SessionRoute;
    readonly seatId: string;
    readonly scopes: readonly string[];
    readonly authEpoch: string;
  }> = {},
) {
  return {
    authenticatedPlatformId: platformId,
    platformId,
    sessionId: route.sessionId,
    principalId,
    route: overrides.route ?? route,
    seatId: overrides.seatId ?? 'seat-1',
    scopes: overrides.scopes ?? [
      'session:view',
      'session:command',
      'game:chat',
    ],
    authEpoch: overrides.authEpoch ?? `epoch-${revision}`,
    authorizationRevision: revision,
  } as const;
}

function issue(
  options: Partial<Parameters<typeof issuePlayerCredential>[0]> = {},
): string {
  return issuePlayerCredential({
    privateKey,
    platformId,
    audience,
    route,
    principalId,
    seatId: 'seat-1',
    scopes: ['session:view', 'session:command', 'game:chat'],
    authEpoch: 'epoch-1',
    authorizationRevision: 1,
    now,
    approvedGameScopes: ['game:chat'],
    ...options,
  });
}

async function verify(
  store: MemoryAuthorizationVersionStore,
  token: string,
  options: Partial<Parameters<typeof verifyPlayerCredential>[0]> = {},
) {
  return verifyPlayerCredential({
    token,
    publicKey,
    expectedPlatformId: platformId,
    expectedAudience: audience,
    expectedRoute: route,
    authorizationStore: store,
    now,
    approvedGameScopes: ['game:chat'],
    ...options,
  });
}

describe('player credentials', () => {
  it('issues fixed Ed25519 credentials and returns only a server AccessContext', async () => {
    const store = new MemoryAuthorizationVersionStore();
    await store.advance(authorization());
    const context = await verify(store, issue());
    expect(context).toEqual({
      principalId,
      seatId: 'seat-1',
      scopes: ['game:chat', 'session:command', 'session:view'],
      authEpoch: 'epoch-1',
    });
  });

  it.each([
    'session:admin',
    'session:system',
    'session:create',
    'session:control',
    'session:history:retire',
  ])('rejects internal scope %s', (scope) => {
    expect(() =>
      issuePlayerCredential({
        privateKey,
        platformId,
        audience,
        route,
        principalId,
        scopes: [scope],
        authEpoch: 'epoch-1',
        authorizationRevision: 1,
        now,
      }),
    ).toThrowError(PlayerCredentialError);
  });

  it('requires explicit approval for game scopes and caps credential TTL', () => {
    expect(() =>
      issuePlayerCredential({
        privateKey,
        platformId,
        audience,
        route,
        principalId,
        scopes: ['game:chat'],
        authEpoch: 'epoch-1',
        authorizationRevision: 1,
        now,
      }),
    ).toThrow('not approved');
    expect(() =>
      issuePlayerCredential({
        privateKey,
        platformId,
        audience,
        route,
        principalId,
        scopes: ['session:view'],
        authEpoch: 'epoch-1',
        authorizationRevision: 1,
        ttlMs: 5 * 60 * 1_000 + 1,
        now,
      }),
    ).toThrow('5 minute');
  });

  it('accepts only Ed25519 keys and keeps private keys out of verification', async () => {
    const { privateKey: rsaPrivateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2_048,
    });
    expect(() => issue({ privateKey: rsaPrivateKey })).toThrow(
      'Ed25519 private key',
    );
    const store = new MemoryAuthorizationVersionStore();
    await store.advance(authorization());
    await expect(
      verifyPlayerCredential({
        token: issue(),
        publicKey: privateKey,
        expectedPlatformId: platformId,
        expectedAudience: audience,
        expectedRoute: route,
        authorizationStore: store,
        now,
        approvedGameScopes: ['game:chat'],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_KEY' });
  });

  it('rejects tampering, wrong issuer/audience/route/seat, future and expired tokens', async () => {
    const store = new MemoryAuthorizationVersionStore();
    await store.advance(authorization());
    const token = issue();
    const [payloadPart, signaturePart] = token.split('.');
    const tamperedPayload = `${payloadPart[0] === 'A' ? 'B' : 'A'}${payloadPart.slice(1)}`;
    const tampered = `${tamperedPayload}.${signaturePart}`;
    await expect(verify(store, tampered)).rejects.toMatchObject({
      code: 'SIGNATURE_INVALID',
    });
    await expect(
      verify(store, issue({ platformId: 'other-platform' })),
    ).rejects.toMatchObject({ code: 'ISSUER_MISMATCH' });
    await expect(
      verify(store, issue({ audience: 'other-game' })),
    ).rejects.toMatchObject({ code: 'AUDIENCE_MISMATCH' });
    await expect(
      verify(store, token, {
        expectedRoute: { ...route, releaseId: 'other-release' },
      }),
    ).rejects.toMatchObject({ code: 'ROUTE_MISMATCH' });
    await expect(
      verify(store, issue({ seatId: 'seat-2' })),
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_MISMATCH' });
    await expect(
      verify(store, issue({ issuedAt: now + 1, now: now + 1 })),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_FUTURE' });
    await expect(
      verify(store, issue({ expiresAt: now + 1 }), { now: now + 1 }),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_EXPIRED' });
  });

  it('rejects unknown payload fields and unsupported versions even with a valid signature', async () => {
    const store = new MemoryAuthorizationVersionStore();
    await store.advance(authorization());
    const claims = {
      version: 1,
      issuer: platformId,
      audience,
      route,
      principalId,
      seatId: 'seat-1',
      scopes: ['session:view'],
      authEpoch: 'epoch-1',
      authorizationRevision: 1,
      issuedAt: now,
      expiresAt: now + 1_000,
      forged: true,
    };
    const payload = Buffer.from(canonicalStableStringify(claims));
    const signed = `${payload.toString('base64url')}.${sign(null, payload, privateKey).toString('base64url')}`;
    await expect(verify(store, signed)).rejects.toMatchObject({
      code: 'INVALID_TOKEN',
    });
    const { forged: omittedForged, ...knownClaims } = claims;
    void omittedForged;
    const versionPayload = Buffer.from(
      canonicalStableStringify({ ...knownClaims, version: 2 }),
    );
    const versionToken = `${versionPayload.toString('base64url')}.${sign(null, versionPayload, privateKey).toString('base64url')}`;
    await expect(verify(store, versionToken)).rejects.toMatchObject({
      code: 'INVALID_TOKEN',
    });
  });

  it('makes authorization revisions idempotent, monotonic and revocable', async () => {
    const store = new MemoryAuthorizationVersionStore();
    const first = await store.advance(authorization());
    expect(await store.advance(authorization())).toEqual(first);
    await expect(
      store.advance(authorization(1, { authEpoch: 'different' })),
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_CONFLICT' });
    await store.advance(authorization(2));
    await expect(store.advance(authorization(1))).rejects.toMatchObject({
      code: 'AUTHORIZATION_STALE',
    });
    const oldToken = issue();
    await expect(verify(store, oldToken)).rejects.toMatchObject({
      code: 'AUTHORIZATION_MISMATCH',
    });
    const currentToken = issue({
      authorizationRevision: 2,
      authEpoch: 'epoch-2',
    });
    await verify(store, currentToken);
    await store.revoke({
      authenticatedPlatformId: platformId,
      platformId,
      sessionId: route.sessionId,
      principalId,
      authorizationRevision: 2,
    });
    await expect(verify(store, currentToken)).rejects.toMatchObject({
      code: 'AUTHORIZATION_REVOKED',
    });
  });

  it('synchronizes authorization revisions over the authenticated internal HTTP channel', async () => {
    const serviceToken = 'authorization-service-token-long-enough-for-tests';
    const gameStore = new MemoryAuthorizationVersionStore({ now: () => now });
    const server = new HttpAuthorizationVersionServer({
      store: gameStore,
      credentials: [{ token: serviceToken, platformId }],
      host: '127.0.0.1',
      port: 0,
      authorizeRoute: (candidate) =>
        candidate.gameId === route.gameId &&
        candidate.releaseId === route.releaseId,
    });
    const address = await server.listen();
    try {
      const client = new HttpAuthorizationVersionClient({
        baseUrl: `http://127.0.0.1:${address.port}`,
        token: serviceToken,
        platformId,
        allowInsecureLocalhost: true,
      });
      const record = await client.advance(authorization());
      expect(record).toMatchObject({
        platformId,
        authorizationRevision: 1,
      });
      await expect(
        verify(
          gameStore,
          issue({
            now,
          }),
        ),
      ).resolves.toBeDefined();
      const rejected = await fetch(
        `http://127.0.0.1:${address.port}/internal/v1/authorization/advance`,
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer wrong-authorization-token-long-enough',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ protocolVersion: 1, authorization: {} }),
        },
      );
      expect(rejected.status).toBe(401);
      const malformed = await fetch(
        `http://127.0.0.1:${address.port}/internal/v1/authorization/advance`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${serviceToken}`,
            'content-type': 'application/json',
          },
          body: '{',
        },
      );
      expect(malformed.status).toBe(400);
    } finally {
      await server.close();
    }
  });
});
