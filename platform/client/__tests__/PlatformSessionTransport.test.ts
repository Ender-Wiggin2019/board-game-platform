import type { SessionRoute } from '@board-game/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPlatformReplayTransport,
  createPlatformSessionTransport,
  type PlatformHttpClient,
  probePlatformReplayRoute,
} from '@/PlatformSessionTransport';

const route: SessionRoute = {
  gameId: 'seti',
  modeId: 'room',
  sessionId: 'session/1',
  releaseId: 'release-1',
  backendBindingId: 'host-1',
  storageBindingId: 'store-1',
  ownershipEpoch: 'epoch-1',
};

const view = {
  gameId: route.gameId,
  sessionId: route.sessionId,
  releaseId: route.releaseId,
  viewSchemaVersion: 1,
  audienceKey: 'seat:1',
  viewEpoch: 'epoch-1',
  baseRevision: 3,
  revision: 3,
  streamCursor: 'cursor-3',
  kind: 'snapshot' as const,
  payload: {},
};

describe('platform session transport seat routing', () => {
  const client = {
    get: vi.fn(async () => ({ data: view })),
    post: vi.fn(async () => ({
      data: {
        receipt: {
          commandId: 'command-1',
          sessionId: route.sessionId,
          status: 'accepted' as const,
          resultRetention: 'replayable' as const,
        },
      },
    })),
  } as unknown as PlatformHttpClient;

  beforeEach(() => vi.clearAllMocks());

  it('appends the selected seat to every gateway operation', async () => {
    const transport = createPlatformSessionTransport(client, route, 'seat/1');

    await transport.getPlayerView({ protocolVersion: 1, route });
    await transport.getEvents({
      protocolVersion: 1,
      route,
      afterSequence: 0,
      limit: 10,
    });

    expect(client.get).toHaveBeenCalledWith(
      '/platform/sessions/session%2F1/view?seatId=seat%2F1',
    );
    expect(client.post).toHaveBeenCalledWith(
      '/platform/sessions/session%2F1/events?seatId=seat%2F1',
      { afterSequence: 0, limit: 10 },
    );
  });

  it('keeps route probing account-scoped', async () => {
    const transport = createPlatformSessionTransport(client, route);
    await transport.getPlayerView({ protocolVersion: 1, route });
    expect(client.get).toHaveBeenCalledWith(
      '/platform/sessions/session%2F1/view',
    );
  });

  it('uses the replay prefix and never sends replay commands', async () => {
    const transport = createPlatformReplayTransport(client);

    await transport.getPlayerView({ protocolVersion: 1, route });
    await transport.getEvents({
      protocolVersion: 1,
      route,
      afterSequence: 0,
      limit: 10,
    });
    await transport.resume({ protocolVersion: 1, route });
    await transport.queryOptions({
      protocolVersion: 1,
      route,
      revision: 3,
      query: { type: 'manifest' },
    });
    await transport.getStatus({ protocolVersion: 1, route });

    await expect(
      transport.submitCommand({
        protocolVersion: 1,
        route,
        commandId: 'command-1',
        precondition: { kind: 'revision', expectedRevision: 3 },
        command: { type: 'not-allowed' },
      }),
    ).rejects.toMatchObject({
      envelope: { code: 'FORBIDDEN' },
    });

    expect(client.get).toHaveBeenCalledWith(
      '/platform/sessions/session%2F1/replay/view',
    );
    expect(client.post).toHaveBeenCalledWith(
      '/platform/sessions/session%2F1/replay/events',
      { afterSequence: 0, limit: 10 },
    );
    expect(client.post).toHaveBeenCalledWith(
      '/platform/sessions/session%2F1/replay/resume',
      {},
    );
    expect(client.post).toHaveBeenCalledWith(
      '/platform/sessions/session%2F1/replay/query',
      { revision: 3, query: { type: 'manifest' } },
    );
    expect(client.post).toHaveBeenCalledWith(
      '/platform/sessions/session%2F1/replay/status',
      {},
    );
    expect(client.post).not.toHaveBeenCalledWith(
      '/platform/sessions/session%2F1/replay/commands',
      expect.anything(),
    );
  });

  it('probes replay routes independently and preserves exact legacy fallback', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({
        data: { authority: 'platform', route, status: 'completed' },
      })
      .mockRejectedValueOnce({
        response: {
          data: {
            code: 'NOT_FOUND',
            messageKey: 'platform.gateway.session.notFound',
          },
        },
      });
    const replayClient = {
      get: get as unknown as PlatformHttpClient['get'],
      post: vi.fn() as unknown as PlatformHttpClient['post'],
    } satisfies PlatformHttpClient;

    await expect(
      probePlatformReplayRoute(route.sessionId, replayClient),
    ).resolves.toEqual({
      kind: 'platform',
      descriptor: { authority: 'platform', route, status: 'completed' },
    });
    expect(get).toHaveBeenLastCalledWith(
      '/platform/sessions/session%2F1/replay/route',
    );
    await expect(
      probePlatformReplayRoute(route.sessionId, replayClient),
    ).resolves.toEqual({ kind: 'legacy' });
    expect(get).not.toHaveBeenCalledWith(
      '/platform/sessions/session%2F1/route',
    );
  });

  it('does not fallback a forbidden replay probe to a live route', async () => {
    const get = vi.fn().mockRejectedValue({
      response: {
        data: {
          code: 'FORBIDDEN',
          messageKey: 'platform.gateway.session.forbidden',
        },
      },
    });
    const replayClient = {
      get: get as unknown as PlatformHttpClient['get'],
      post: vi.fn() as unknown as PlatformHttpClient['post'],
    } satisfies PlatformHttpClient;

    await expect(
      probePlatformReplayRoute(route.sessionId, replayClient),
    ).rejects.toMatchObject({
      response: {
        data: {
          code: 'FORBIDDEN',
          messageKey: 'platform.gateway.session.forbidden',
        },
      },
    });
    expect(get).toHaveBeenCalledWith(
      '/platform/sessions/session%2F1/replay/route',
    );
    expect(get).not.toHaveBeenCalledWith(
      '/platform/sessions/session%2F1/route',
    );
  });
});
