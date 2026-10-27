import type { SessionRoute } from '@board-game/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createPlayerSessionTransport } from '../src/PlayerSessionTransport.js';

const route: SessionRoute = {
  gameId: 'counter',
  modeId: 'solo',
  sessionId: 'session',
  releaseId: 'v1',
  backendBindingId: 'backend-v1',
  storageBindingId: 'storage',
  ownershipEpoch: '1',
};
const request = { protocolVersion: 1 as const, route };
const connection = {
  route,
  playerEndpoint: 'https://game.example/play',
  token: 'short-token',
  expiresAt: 2_000,
};
const success = () =>
  new Response(
    JSON.stringify({ protocolVersion: 1, response: { value: 'safe' } }),
    { status: 200 },
  );

describe('direct player session transport', () => {
  it('keeps valid credentials usable without calling an unavailable platform', async () => {
    let now = 1_000;
    const connect = vi.fn(async () => connection);
    const fetchImpl = vi.fn(async () => success());
    const transport = createPlayerSessionTransport({
      route,
      connect,
      fetchImpl,
      now: () => now,
    });
    await transport.getPlayerView(request);
    connect.mockRejectedValue(new Error('platform offline'));
    await transport.getPlayerView(request);
    expect(connect).toHaveBeenCalledTimes(1);
    const [url, options] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://game.example/play/v1/getPlayerView');
    expect(options.credentials).toBe('omit');
    expect(JSON.parse(options.body as string)).toEqual({
      protocolVersion: 1,
      request,
    });
    expect(options.headers).toMatchObject({
      authorization: 'Bearer short-token',
    });
    now = 2_001;
    await expect(transport.getPlayerView(request)).rejects.toThrow(
      'platform offline',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('never retries or changes a command after an unknown network outcome', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('lost ACK');
    });
    const transport = createPlayerSessionTransport({
      route,
      connect: async () => connection,
      fetchImpl,
      now: () => 1_000,
    });
    const input = {
      ...request,
      commandId: 'original-id',
      precondition: { kind: 'revision' as const, expectedRevision: 3 },
      command: { type: 'increment' },
    };
    await expect(transport.submitCommand(input)).rejects.toMatchObject({
      outcome: 'unknown',
      code: 'NETWORK',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(transport.submitCommand(input)).rejects.toMatchObject({
      outcome: 'unknown',
    });
    expect(
      (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body,
    ).toBe(
      (fetchImpl.mock.calls[1] as unknown as [string, RequestInit])[1].body,
    );
  });

  it('rejects a changed route or a platform response pointing at another release', async () => {
    const fetchImpl = vi.fn(async () => success());
    const transport = createPlayerSessionTransport({
      route,
      connect: async () => ({
        ...connection,
        route: { ...route, releaseId: 'v2' },
      }),
      fetchImpl,
      now: () => 1_000,
    });
    await expect(transport.getPlayerView(request)).rejects.toMatchObject({
      envelope: { code: 'FORBIDDEN' },
    });
    await expect(
      transport.getPlayerView({
        ...request,
        route: { ...route, backendBindingId: 'other' },
      }),
    ).rejects.toMatchObject({ envelope: { code: 'FORBIDDEN' } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('renews after an authentication rejection without automatically resubmitting', async () => {
    const connect = vi.fn(async () => connection);
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            protocolVersion: 1,
            error: {
              code: 'UNAUTHENTICATED',
              messageKey: 'expired',
              retryable: false,
            },
          }),
          { status: 401 },
        ),
    );
    const transport = createPlayerSessionTransport({
      route,
      connect,
      fetchImpl,
      now: () => 1_000,
    });
    await expect(transport.getPlayerView(request)).rejects.toMatchObject({
      envelope: { code: 'UNAUTHENTICATED' },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(transport.getPlayerView(request)).rejects.toMatchObject({
      envelope: { code: 'UNAUTHENTICATED' },
    });
    expect(connect).toHaveBeenCalledTimes(2);
  });
});
