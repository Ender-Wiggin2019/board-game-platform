import type {
  GameServiceDescription,
  MatchAdmission,
  ModeDefinition,
  SessionRoute,
} from '@board-game/contracts';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type PlatformAccountProjection,
  PlatformAccountProjectionController,
  PlatformAccountProjectionService,
} from '@/platform/PlatformAccountProjection.js';
import type {
  PlatformApplicationOptions,
  RemoteRuntimeOptions,
} from '@/platform/PlatformApplicationRuntime.js';
import { PlatformApplicationRuntime } from '@/platform/PlatformApplicationRuntime.js';
import type {
  ReleaseBindingRecord,
  ReleaseRecord,
} from '@/platform/releases/types.js';

const serviceToken = 'platform-account-projection-service-token-0123456789';
const route: SessionRoute = {
  gameId: 'seti',
  modeId: 'regular-multiplayer',
  sessionId: 'session-account-projection',
  releaseId: 'seti-v1',
  backendBindingId: 'seti-v1-binding',
  storageBindingId: 'seti-v1-storage',
  ownershipEpoch: 'seti-v1-owner',
};
const mode: ModeDefinition = {
  id: route.modeId,
  entry: 'room',
  minPlayers: 2,
  maxPlayers: 4,
  history: 'summary-and-replay',
  platformRating: true,
  concurrency: 'revision',
};

function release(): ReleaseRecord {
  return {
    platformId: 'platform-test',
    gameId: route.gameId,
    releaseId: route.releaseId,
    manifest: {} as ReleaseRecord['manifest'],
    service: { modes: [mode] } as unknown as GameServiceDescription,
    manifestDigest: 'manifest-digest',
    serviceDigest: 'service-digest',
    approvedFeatures: [],
    approvedModes: [route.modeId],
    createdAt: 1,
  };
}

function binding(): ReleaseBindingRecord {
  return {
    platformId: 'platform-test',
    backendBindingId: route.backendBindingId,
    gameId: route.gameId,
    releaseId: route.releaseId,
    storageBindingId: route.storageBindingId,
    ownershipEpoch: route.ownershipEpoch,
    deployment: 'external',
    controlEndpoint: 'https://seti.example/control',
    playerEndpoint: 'https://seti.example/player',
    clientArtifactBaseUrl: 'https://seti.example/client/',
    serviceCredentialRef: 'env:SETI_SERVICE_TOKEN',
    status: 'ready',
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

function harness() {
  let accountStatus = 'active';
  let sessionVersion = 3;
  let permissionVersion = 4;
  const admission: MatchAdmission = {
    id: 'admission-account-projection',
    route,
    participants: [
      { principalId: 'principal-1', seatId: 'seat-1' },
      { principalId: 'principal-2', seatId: 'seat-2' },
    ],
    visibility: 'private',
    rating: null,
    validityPolicyVersion: 'test',
    createdAt: 1,
  };
  const remoteRuntime: RemoteRuntimeOptions = {
    resolvePolicy: () => {
      throw new Error('not used');
    },
    resolveCredential: () => ({ serviceToken }),
    probeReadiness: async () => {
      throw new Error('not used');
    },
  };
  const runtime = {
    options: {
      platformId: 'platform-test',
      remoteRuntime,
    } as PlatformApplicationOptions,
    releaseRegistry: {
      getRelease: vi.fn(async () => release()),
      getBinding: vi.fn(async () => binding()),
    },
    admissionStore: {
      getAdmission: vi.fn(async () => admission),
    },
    accountIdentity: () => ({
      account: vi.fn(async () => ({
        id: 'principal-1',
        accountStatus,
        sessionVersion,
        permissionVersion,
        role: 'player',
        navigatorGrantedAt: null,
        navigatorExpiresAt: null,
        updatedAt: '2026-10-27T12:00:00.000Z',
      })),
    }),
  } as unknown as PlatformApplicationRuntime;
  return {
    runtime,
    setAccountStatus: (value: string) => {
      accountStatus = value;
    },
    setVersions: (values: {
      readonly sessionVersion?: number;
      readonly permissionVersion?: number;
    }) => {
      if (values.sessionVersion !== undefined)
        sessionVersion = values.sessionVersion;
      if (values.permissionVersion !== undefined)
        permissionVersion = values.permissionVersion;
    },
  };
}

describe('platform account projection HTTP boundary', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it('authenticates the approved binding and returns only the route-scoped projection', async () => {
    const fixture = harness();
    const moduleRef = await Test.createTestingModule({
      controllers: [PlatformAccountProjectionController],
      providers: [
        {
          provide: PlatformApplicationRuntime,
          useValue: fixture.runtime,
        },
        PlatformAccountProjectionService,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    if (!address || typeof address === 'string') throw new Error('address');
    const response = await fetch(
      `http://127.0.0.1:${address.port}/platform/runtime/account-projection`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${serviceToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ route, principalId: 'principal-1' }),
      },
    );
    expect(response.status).toBe(201);
    const projection = (await response.json()) as PlatformAccountProjection;
    expect(projection).toMatchObject({
      schemaVersion: 1,
      gameId: route.gameId,
      releaseId: route.releaseId,
      backendBindingId: route.backendBindingId,
      storageBindingId: route.storageBindingId,
      ownershipEpoch: route.ownershipEpoch,
      principalId: 'principal-1',
      status: 'active',
      role: 'player',
      authRevision: 7,
    });
    expect(Object.keys(projection).sort()).toEqual([
      'authRevision',
      'backendBindingId',
      'expiresAt',
      'gameId',
      'ownershipEpoch',
      'principalId',
      'releaseId',
      'role',
      'schemaVersion',
      'sourceDigest',
      'status',
      'storageBindingId',
    ]);
  });

  it('rejects a wrong service token and maps account suspension without exporting account data', async () => {
    const fixture = harness();
    fixture.setAccountStatus('suspended');
    const moduleRef = await Test.createTestingModule({
      controllers: [PlatformAccountProjectionController],
      providers: [
        {
          provide: PlatformApplicationRuntime,
          useValue: fixture.runtime,
        },
        PlatformAccountProjectionService,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    if (!address || typeof address === 'string') throw new Error('address');
    const url = `http://127.0.0.1:${address.port}/platform/runtime/account-projection`;
    const wrong = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: 'Bearer wrong-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ route, principalId: 'principal-1' }),
    });
    expect(wrong.status).toBe(401);
    const suspended = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${serviceToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ route, principalId: 'principal-1' }),
    });
    expect(suspended.status).toBe(201);
    expect(await suspended.json()).toMatchObject({
      status: 'suspended',
      role: 'player',
    });
  });

  it('advances the projection revision for role and status changes in the same timestamp', async () => {
    const fixture = harness();
    const moduleRef = await Test.createTestingModule({
      providers: [
        {
          provide: PlatformApplicationRuntime,
          useValue: fixture.runtime,
        },
        PlatformAccountProjectionService,
      ],
    }).compile();
    const service = moduleRef.get(PlatformAccountProjectionService);
    const headers = { authorization: `Bearer ${serviceToken}` };
    const first = await service.read(headers, {
      route,
      principalId: 'principal-1',
    });
    fixture.setVersions({ permissionVersion: 5 });
    const roleChanged = await service.read(headers, {
      route,
      principalId: 'principal-1',
    });
    fixture.setVersions({ sessionVersion: 4 });
    fixture.setAccountStatus('suspended');
    const statusChanged = await service.read(headers, {
      route,
      principalId: 'principal-1',
    });
    expect(roleChanged.authRevision).toBeGreaterThan(first.authRevision);
    expect(statusChanged.authRevision).toBeGreaterThan(
      roleChanged.authRevision,
    );
    expect(statusChanged.expiresAt).toBeGreaterThan(first.expiresAt - 1_000);
  });
});
