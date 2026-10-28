import { createServer, type Server } from 'node:http';
import {
  type AccessContext,
  type BackendPort,
  contractError,
  type DeveloperConsoleCatalogRequest,
  type DeveloperConsoleCatalogResponse,
  type GetStatusRequest,
  type ReadyResponse,
  type SessionRoute,
  type SubmitDeveloperCommandRequest,
  type SubmitSystemCommandRequest,
} from '@board-game/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EmbeddedBackendAdapter,
  HttpHostTransport,
  type HttpHostTransportOptions,
  HttpPlayerTransport,
  RemoteBackendAdapter,
} from '../src/transport.js';

const serviceToken = 'service-token-that-is-long-enough-for-transport-tests';
const route: SessionRoute = {
  gameId: 'seti',
  modeId: 'solo',
  sessionId: 'session-1',
  releaseId: 'release-1',
  backendBindingId: 'backend-1',
  storageBindingId: 'storage-1',
  ownershipEpoch: 'owner-1',
};
const accessContext: AccessContext = {
  principalId: 'principal-1',
  scopes: ['session:view'],
  authEpoch: 'auth-1',
};
const readyResponse: ReadyResponse = {
  ready: true,
  description: {
    protocolMajor: 1,
    protocolMinor: 0,
    features: ['transport-test'],
    gameIds: ['seti'],
    releaseIds: ['release-1'],
    modes: [],
    storageBindingIds: ['storage-1'],
  },
};
const statusRequest: GetStatusRequest = {
  protocolVersion: 1,
  accessContext,
  route,
};
const statusResponse = {
  kind: 'start' as const,
  status: 'active' as const,
  sessionId: route.sessionId,
};

const runningTransports: (HttpHostTransport | HttpPlayerTransport)[] = [];

function backendWith(overrides: Partial<BackendPort> = {}): BackendPort {
  const backend = {
    describe: vi.fn(async () => readyResponse.description),
    ready: vi.fn(async () => readyResponse),
    createSession: vi.fn(async () => ({
      sessionId: route.sessionId,
      startId: 'start-1',
      status: 'active' as const,
      route,
      creationReceiptId: 'receipt-1',
    })),
    activateSession: vi.fn(async () => ({
      sessionId: route.sessionId,
      startId: 'start-1',
      status: 'active' as const,
      activatedAt: 1,
    })),
    getStatus: vi.fn(async () => statusResponse),
    submitCommand: vi.fn(async () => ({
      receipt: {
        commandId: 'command-1',
        sessionId: route.sessionId,
        status: 'accepted' as const,
        persistedRevision: 1,
        persistedAt: 1,
        resultRetention: 'ephemeral-result' as const,
        error: undefined,
      },
    })),
    queryOptions: vi.fn(async () => ({ route, revision: 1, answer: null })),
    getPlayerView: vi.fn(async () => ({
      gameId: route.gameId,
      sessionId: route.sessionId,
      releaseId: route.releaseId,
      viewSchemaVersion: 1,
      viewEpoch: 'view-1',
      sourceRevision: 1,
      audienceKey: 'audience-1',
      audience: { audience: 'player', epoch: 'view-1' },
      payload: null,
    })),
    getEvents: vi.fn(async () => ({
      gameId: route.gameId,
      sessionId: route.sessionId,
      releaseId: route.releaseId,
      audienceKey: 'audience-1',
      viewEpoch: 'auth-1',
      nextSequence: 1,
      hasMore: false,
      events: [
        { sequence: 1, eventId: 'event-1', payload: { kind: 'public' } },
      ],
      resetRequired: false,
    })),
    resume: vi.fn(async () => ({
      kind: 'up-to-date' as const,
      sourceRevision: 1,
      view: null,
    })),
    getSessionSummary: vi.fn(async () => ({
      route,
      status: 'active' as const,
      sourceRevision: 1,
      updatedAt: 1,
      summary: null,
    })),
    controlSession: vi.fn(async () => ({
      route,
      status: 'active' as const,
      receipt: {
        commandId: 'command-1',
        sessionId: route.sessionId,
        status: 'accepted' as const,
        persistedRevision: 1,
        persistedAt: 1,
        resultRetention: 'ephemeral-result' as const,
        error: undefined,
      },
    })),
  } as unknown as BackendPort;
  Object.assign(backend, overrides);
  return backend;
}

async function startTransport(
  backend: BackendPort,
  overrides: Partial<
    Omit<
      HttpHostTransportOptions,
      | 'backend'
      | 'serviceToken'
      | 'allowedGameIds'
      | 'allowedScopes'
      | 'tokenExpiresAt'
    >
  > &
    Pick<
      Partial<HttpHostTransportOptions>,
      'now' | 'tokenExpiresAt' | 'allowedGameIds' | 'allowedScopes'
    > = {},
): Promise<{ transport: HttpHostTransport; baseUrl: string }> {
  const transport = new HttpHostTransport({
    backend,
    serviceToken,
    allowedGameIds: ['seti'],
    allowedScopes: ['session:view'],
    tokenExpiresAt: Date.now() + 60_000,
    ...overrides,
  });
  const address = await transport.listen();
  runningTransports.push(transport);
  return { transport, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function postJson(
  baseUrl: string,
  operation: string,
  request: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown; text: string; headers: Headers }> {
  const response = await fetch(`${baseUrl}/v1/${operation}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${serviceToken}`,
      'content-type': 'application/json',
      ...headers,
    },
    body: typeof request === 'string' ? request : JSON.stringify(request),
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: response.status, body, text, headers: response.headers };
}

afterEach(async () => {
  await Promise.all(
    runningTransports.splice(0).map((transport) => transport.close()),
  );
});

describe('EmbeddedBackendAdapter and RemoteBackendAdapter', () => {
  it('forwards release-pinned statistics only through the service transport', async () => {
    const statistics = vi.fn(async () => ({
      operation: 'personalSummary',
      audience: 'self' as const,
      payload: { total: 3 },
    }));
    const backend = backendWith({ statistics });
    const { baseUrl } = await startTransport(backend, {
      allowedScopes: ['statistics:read'],
    });
    const remote = new RemoteBackendAdapter({
      baseUrl,
      serviceToken,
      allowInsecureLocalhost: true,
    });
    const statisticsRequest = {
      protocolVersion: 1 as const,
      route: {
        gameId: route.gameId,
        releaseId: route.releaseId,
        backendBindingId: route.backendBindingId,
        storageBindingId: route.storageBindingId,
        ownershipEpoch: route.ownershipEpoch,
      },
      operation: 'personalSummary',
      audience: 'self' as const,
      accessContext: {
        principalId: 'principal-1',
        scopes: ['statistics:read'],
        authEpoch: 'auth-1',
      },
      query: { range: '30d' },
    };
    await expect(remote.statistics(statisticsRequest)).resolves.toEqual({
      operation: 'personalSummary',
      audience: 'self',
      payload: { total: 3 },
    });
    expect(statistics).toHaveBeenCalledWith(statisticsRequest);
    const denied = await postJson(baseUrl, 'statistics', {
      protocolVersion: 1,
      request: {
        ...statisticsRequest,
        accessContext: { ...statisticsRequest.accessContext, scopes: [] },
      },
    });
    expect(denied.status).toBe(403);
    expect(statistics).toHaveBeenCalledTimes(1);
  });

  it('routes authenticated system commands only through the internal service operation', async () => {
    const submitSystemCommand = vi.fn(
      async (request: SubmitSystemCommandRequest) => ({
        receipt: {
          commandId: request.commandId,
          sessionId: request.route.sessionId,
          status: 'accepted' as const,
          resultRetention: 'replayable' as const,
          persistedRevision: request.expectedRevision + 1,
          persistedAt: 2,
        },
      }),
    );
    const backend = backendWith({ submitSystemCommand });
    const systemRequest: SubmitSystemCommandRequest = {
      protocolVersion: 1,
      accessContext: {
        principalId: 'scheduler',
        scopes: ['session:system'],
        authEpoch: 'service-1',
      },
      route,
      commandId: 'system-command-1',
      expectedRevision: 3,
      command: { type: 'timeout' },
      deadlineId: 'deadline-1',
    };
    const { baseUrl } = await startTransport(backend, {
      allowedScopes: ['session:system'],
    });
    const remote = new RemoteBackendAdapter({
      baseUrl,
      serviceToken,
      allowInsecureLocalhost: true,
    });
    await expect(
      remote.submitSystemCommand(systemRequest),
    ).resolves.toMatchObject({
      receipt: { commandId: 'system-command-1', status: 'accepted' },
    });
    expect(submitSystemCommand).toHaveBeenCalledWith(systemRequest);

    const denied = await postJson(baseUrl, 'submitSystemCommand', {
      protocolVersion: 1,
      request: {
        ...systemRequest,
        accessContext: {
          ...systemRequest.accessContext,
          scopes: ['session:view'],
        },
      },
    });
    expect(denied.status).toBe(403);
    expect(submitSystemCommand).toHaveBeenCalledTimes(1);
  });

  it('routes developer catalog and mutation operations with both operator scopes', async () => {
    const getDeveloperConsole = vi.fn(
      async (request: DeveloperConsoleCatalogRequest) =>
        ({
          catalog: [],
          enabled: true,
          revision: request.route.sessionId === route.sessionId ? 3 : 0,
        }) satisfies DeveloperConsoleCatalogResponse,
    );
    const submitDeveloperCommand = vi.fn(
      async (request: SubmitDeveloperCommandRequest) => ({
        receipt: {
          commandId: request.commandId,
          sessionId: request.route.sessionId,
          status: 'accepted' as const,
          resultRetention: 'replayable' as const,
          persistedRevision: request.expectedRevision + 1,
          persistedAt: 2,
        },
        revision: request.expectedRevision + 1,
      }),
    );
    const backend = backendWith({
      getDeveloperConsole,
      submitDeveloperCommand,
    });
    const accessContext: AccessContext = {
      principalId: 'operator',
      scopes: ['session:admin', 'session:developer'],
      authEpoch: 'operator-1',
    };
    const catalogRequest: DeveloperConsoleCatalogRequest = {
      protocolVersion: 1,
      accessContext,
      route,
    };
    const commandRequest: SubmitDeveloperCommandRequest = {
      protocolVersion: 1,
      accessContext,
      route,
      commandId: 'developer-command-1',
      expectedRevision: 3,
      command: { name: 'set-money', input: { playerId: 'p1', amount: 10 } },
    };
    const { baseUrl } = await startTransport(backend, {
      allowedScopes: ['session:admin', 'session:developer'],
    });
    const remote = new RemoteBackendAdapter({
      baseUrl,
      serviceToken,
      allowInsecureLocalhost: true,
    });

    await expect(remote.getDeveloperConsole(catalogRequest)).resolves.toEqual({
      catalog: [],
      enabled: true,
      revision: 3,
    });
    await expect(
      remote.submitDeveloperCommand(commandRequest),
    ).resolves.toMatchObject({
      receipt: { commandId: 'developer-command-1', status: 'accepted' },
      revision: 4,
    });
    expect(getDeveloperConsole).toHaveBeenCalledWith(catalogRequest);
    expect(submitDeveloperCommand).toHaveBeenCalledWith(commandRequest);

    const denied = await postJson(baseUrl, 'getDeveloperConsole', {
      protocolVersion: 1,
      request: {
        ...catalogRequest,
        accessContext: { ...accessContext, scopes: ['session:admin'] },
      },
    });
    expect(denied.status).toBe(403);
    expect(getDeveloperConsole).toHaveBeenCalledTimes(1);
    expect(submitDeveloperCommand).toHaveBeenCalledTimes(1);
  });

  it('uses the same validated clone boundary for embedded and HTTP-backed calls', async () => {
    const readyMock = vi.fn(
      async (_request: { readonly protocolVersion: 1 }) => readyResponse,
    );
    const backend = backendWith({ ready: readyMock });
    const embedded = new EmbeddedBackendAdapter(backend);
    const embeddedResult = await embedded.ready({ protocolVersion: 1 });
    expect(embeddedResult).toEqual(readyResponse);
    expect(readyMock).toHaveBeenCalledWith({ protocolVersion: 1 });
    expect(readyMock.mock.calls[0]?.[0]).not.toBe(readyResponse);

    const { baseUrl } = await startTransport(backend);
    const remote = new RemoteBackendAdapter({
      baseUrl,
      serviceToken,
      allowInsecureLocalhost: true,
    });
    const remoteResult = await remote.ready({ protocolVersion: 1 });
    expect(remoteResult).toEqual(embeddedResult);
    (remoteResult.description.features as string[]).push('caller-only');
    expect(readyResponse.description.features).toEqual(['transport-test']);
  });

  it('normalizes bounded event reads across embedded and HTTP-backed calls', async () => {
    const backend = backendWith();
    const request = {
      protocolVersion: 1 as const,
      accessContext,
      route,
      afterSequence: 0,
      limit: 10,
      viewEpoch: 'auth-1',
    };
    const embedded = new EmbeddedBackendAdapter(backend);
    const embeddedResult = await embedded.getEvents(request);
    const { baseUrl } = await startTransport(backend);
    const remote = new RemoteBackendAdapter({
      baseUrl,
      serviceToken,
      allowInsecureLocalhost: true,
    });
    const remoteResult = await remote.getEvents(request);
    expect(remoteResult).toEqual(embeddedResult);
    expect(backend.getEvents).toHaveBeenCalledWith(request);
  });

  it('passes trusted access context through for Host authorization and rejects service scope or route violations', async () => {
    const observed: GetStatusRequest[] = [];
    const backend = backendWith({
      getStatus: vi.fn(async (request) => {
        observed.push(request);
        if (request.accessContext.authEpoch !== 'auth-1')
          throw contractError('UNAUTHENTICATED', 'test.authEpoch.stale');
        return statusResponse;
      }),
    });
    const { baseUrl } = await startTransport(backend);
    const success = await postJson(baseUrl, 'getStatus', {
      protocolVersion: 1,
      request: statusRequest,
    });
    expect(success.status).toBe(200);
    expect(observed[0]?.accessContext).toEqual(accessContext);

    const scopeDenied = await postJson(baseUrl, 'getStatus', {
      protocolVersion: 1,
      request: {
        ...statusRequest,
        accessContext: { ...accessContext, scopes: ['session:admin'] },
      },
    });
    expect(scopeDenied.status).toBe(403);
    expect(
      (scopeDenied.body as { error?: { code?: string } }).error?.code,
    ).toBe('FORBIDDEN');

    const routeDenied = await postJson(baseUrl, 'getStatus', {
      protocolVersion: 1,
      request: { ...statusRequest, route: { ...route, gameId: 'other-game' } },
    });
    expect(routeDenied.status).toBe(403);
    expect(backend.getStatus).toHaveBeenCalledTimes(1);
  });

  it('enforces bearer auth, token expiry, content type, route whitelist, and protocol envelopes', async () => {
    let now = 1_000;
    const backend = backendWith();
    const { baseUrl } = await startTransport(backend, {
      now: () => now,
      tokenExpiresAt: 2_000,
    });

    const missingAuth = await postJson(
      baseUrl,
      'ready',
      { protocolVersion: 1 },
      { authorization: '' },
    );
    expect(missingAuth.status).toBe(401);
    const wrongAuth = await postJson(
      baseUrl,
      'ready',
      { protocolVersion: 1 },
      { authorization: `Bearer ${'x'.repeat(48)}` },
    );
    expect(wrongAuth.status).toBe(401);
    const badContentType = await postJson(
      baseUrl,
      'ready',
      { protocolVersion: 1 },
      { 'content-type': 'text/plain' },
    );
    expect(badContentType.status).toBe(400);
    const unsupportedVersion = await postJson(baseUrl, 'ready', {
      protocolVersion: 2,
      request: { protocolVersion: 1 },
    });
    expect(unsupportedVersion.status).toBe(400);
    const invalidEventLimit = await postJson(baseUrl, 'getEvents', {
      protocolVersion: 1,
      request: {
        ...statusRequest,
        afterSequence: 0,
        limit: 201,
      },
    });
    expect(invalidEventLimit.status).toBe(400);
    const malformed = await postJson(baseUrl, 'ready', '{malformed');
    expect(malformed.status).toBe(400);
    const unknownRoute = await fetch(`${baseUrl}/v1/nope`, { method: 'POST' });
    expect(unknownRoute.status).toBe(404);
    const wrongMethod = await fetch(`${baseUrl}/v1/ready`);
    expect(wrongMethod.status).toBe(404);

    now = 2_000;
    const expired = await postJson(baseUrl, 'ready', {
      protocolVersion: 1,
      request: { protocolVersion: 1 },
    });
    expect(expired.status).toBe(401);
  });

  it('bounds request and response bytes and sanitizes backend exceptions', async () => {
    const requestLimit = await startTransport(backendWith(), {
      maxRequestBytes: 80,
    });
    const oversizedRequest = await postJson(
      requestLimit.baseUrl,
      'ready',
      'x'.repeat(200),
    );
    expect(oversizedRequest.status).toBe(413);
    await requestLimit.transport.close();
    runningTransports.splice(
      runningTransports.indexOf(requestLimit.transport),
      1,
    );

    const failing = backendWith({
      ready: vi.fn(async () => {
        throw new Error('database password: secret');
      }),
    });
    const failureServer = await startTransport(failing);
    const failure = await postJson(failureServer.baseUrl, 'ready', {
      protocolVersion: 1,
      request: { protocolVersion: 1 },
    });
    expect(failure.status).toBe(500);
    expect(failure.text).not.toContain('database password');
    expect((failure.body as { error?: { code?: string } }).error?.code).toBe(
      'INTERNAL',
    );
    await failureServer.transport.close();
    runningTransports.splice(
      runningTransports.indexOf(failureServer.transport),
      1,
    );

    const huge = backendWith({
      ready: vi.fn(async () => ({
        ...readyResponse,
        description: {
          ...readyResponse.description,
          features: ['x'.repeat(2_000)],
        },
      })),
    });
    const responseServer = await startTransport(huge, {
      maxResponseBytes: 256,
    });
    const oversizedResponse = await postJson(responseServer.baseUrl, 'ready', {
      protocolVersion: 1,
      request: { protocolVersion: 1 },
    });
    expect(oversizedResponse.status).toBe(413);
    expect(
      (oversizedResponse.body as { error?: { code?: string } }).error?.code,
    ).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('RemoteBackendAdapter transport outcomes', () => {
  it('requires HTTPS except for explicitly enabled loopback HTTP', () => {
    expect(
      () =>
        new RemoteBackendAdapter({
          baseUrl: 'http://example.com',
          serviceToken,
        }),
    ).toThrow();
    expect(
      () =>
        new RemoteBackendAdapter({
          baseUrl: 'http://127.0.0.1:1234',
          serviceToken,
        }),
    ).toThrow();
    expect(
      () =>
        new RemoteBackendAdapter({
          baseUrl: 'http://127.0.0.1:1234',
          serviceToken,
          allowInsecureLocalhost: true,
        }),
    ).not.toThrow();
  });

  it('does not retry after an ambiguous ACK loss', async () => {
    let calls = 0;
    const server: Server = createServer((request) => {
      calls += 1;
      request.resume();
      request.once('end', () => request.socket.destroy());
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('server did not bind');
    const remote = new RemoteBackendAdapter({
      baseUrl: `http://127.0.0.1:${address.port}`,
      serviceToken,
      allowInsecureLocalhost: true,
    });
    await expect(remote.ready({ protocolVersion: 1 })).rejects.toMatchObject({
      code: 'NETWORK',
      outcome: 'unknown',
    });
    expect(calls).toBe(1);
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('reports timeout as unknown outcome without fallback', async () => {
    const fetchImpl = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    );
    const remote = new RemoteBackendAdapter({
      baseUrl: 'http://127.0.0.1:1234',
      serviceToken,
      allowInsecureLocalhost: true,
      timeoutMs: 5,
      fetchImpl,
    });
    await expect(remote.ready({ protocolVersion: 1 })).rejects.toMatchObject({
      code: 'TIMEOUT',
      outcome: 'unknown',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('HttpPlayerTransport', () => {
  async function playerEndpoint(
    options: {
      backend?: BackendPort;
      scopes?: readonly string[];
      allowedOrigins?: readonly string[];
    } = {},
  ) {
    const backend = options.backend ?? backendWith();
    const authorize = vi.fn(async (token: string) => {
      if (token !== 'short-player-credential')
        throw contractError('UNAUTHENTICATED', 'test.invalid_credential');
      return {
        ...accessContext,
        scopes: options.scopes ?? accessContext.scopes,
      };
    });
    const transport = new HttpPlayerTransport({
      backend,
      authorize,
      allowedOrigins: options.allowedOrigins,
    });
    const address = await transport.listen();
    runningTransports.push(transport);
    const url = `http://127.0.0.1:${address.port}`;
    const post = (
      operation: string,
      request: unknown,
      headers: Record<string, string> = {},
    ) =>
      postJson(
        url,
        operation,
        { protocolVersion: 1, request },
        {
          authorization: 'Bearer short-player-credential',
          ...headers,
        },
      );
    return { url, post, backend, authorize };
  }

  it('derives identity from the credential and rejects caller-supplied access', async () => {
    const endpoint = await playerEndpoint();
    const input = { protocolVersion: 1, route };
    const accepted = await endpoint.post('getPlayerView', input);
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get('cache-control')).toBe('no-store');
    expect(endpoint.backend.getPlayerView).toHaveBeenCalledWith({
      ...input,
      accessContext,
    });
    expect(endpoint.authorize).toHaveBeenCalledWith(
      'short-player-credential',
      'getPlayerView',
      input,
    );
    const forged = await endpoint.post('getPlayerView', {
      ...input,
      accessContext: { ...accessContext, principalId: 'admin' },
    });
    expect(forged.status).toBe(403);
    expect(endpoint.backend.getPlayerView).toHaveBeenCalledTimes(1);
    const service = await endpoint.post('getPlayerView', input, {
      authorization: `Bearer ${serviceToken}`,
    });
    expect(service.status).toBe(401);
  });

  it('refuses lifecycle/system operations and service scopes before invoking the backend', async () => {
    const endpoint = await playerEndpoint();
    for (const operation of [
      'createSession',
      'activateSession',
      'submitSystemCommand',
      'retireSessionHistory',
      'ready',
      'describe',
      'dailyChallenge',
      'statistics',
    ]) {
      expect(
        (await endpoint.post(operation, { protocolVersion: 1, route })).status,
      ).toBe(403);
    }
    expect(endpoint.authorize).not.toHaveBeenCalled();
    const privileged = await playerEndpoint({
      scopes: ['session:view', 'session:system'],
    });
    expect(
      (await privileged.post('getPlayerView', { protocolVersion: 1, route }))
        .status,
    ).toBe(403);
    expect(privileged.backend.getPlayerView).not.toHaveBeenCalled();
  });

  it('permits receipt status for one command but never admission status', async () => {
    const endpoint = await playerEndpoint();
    expect(
      (
        await endpoint.post('getStatus', {
          protocolVersion: 1,
          route,
          commandId: 'command-1',
        })
      ).status,
    ).toBe(200);
    expect(
      (await endpoint.post('getStatus', { protocolVersion: 1, route })).status,
    ).toBe(400);
    expect(
      (
        await endpoint.post('getStatus', {
          protocolVersion: 1,
          route,
          commandId: 'command-1',
          startId: 'start-1',
        })
      ).status,
    ).toBe(403);
    expect(endpoint.backend.getStatus).toHaveBeenCalledTimes(1);
  });

  it('allows only configured cross-origin players, including preflight', async () => {
    const endpoint = await playerEndpoint({
      allowedOrigins: ['https://platform.example'],
    });
    const input = { protocolVersion: 1, route };
    const denied = await endpoint.post('getPlayerView', input, {
      origin: 'https://untrusted.example',
    });
    expect(denied.status).toBe(403);
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
    expect(endpoint.authorize).not.toHaveBeenCalled();
    const allowed = await endpoint.post('getPlayerView', input, {
      origin: 'https://platform.example',
    });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('access-control-allow-origin')).toBe(
      'https://platform.example',
    );
    const preflight = await fetch(`${endpoint.url}/v1/submitCommand`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://platform.example',
        'access-control-request-method': 'POST',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-headers')).toContain(
      'authorization',
    );
  });
});
