import { beforeEach, describe, expect, it, vi } from 'vitest';

const httpMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('@/api/httpClient', () => ({ httpClient: httpMocks }));

import { platformApi } from '@/api/platformApi';

describe('platformApi', () => {
  beforeEach(() => vi.clearAllMocks());

  it('adds a bot with only the expected room revision', async () => {
    const room = { id: 'room/1', status: 'open' };
    httpMocks.post.mockResolvedValueOnce({ data: room });

    await expect(platformApi.addBot('room/1', 7)).resolves.toEqual(room);

    expect(httpMocks.post).toHaveBeenCalledWith(
      '/platform/rooms/room%2F1/bots',
      { expectedRevision: 7 },
      { showServerUpdateDialog: true },
    );
  });

  it('saves a registered room seat controller with the expected revision', async () => {
    const room = { id: 'room/1', status: 'open' };
    httpMocks.post.mockResolvedValueOnce({ data: room });

    await expect(
      platformApi.setRoomController('room/1', 8, {
        kind: 'hotseat',
        displayName: 'Table seat',
      }),
    ).resolves.toEqual(room);

    expect(httpMocks.post).toHaveBeenCalledWith(
      '/platform/rooms/room%2F1/controllers',
      {
        expectedRevision: 8,
        controller: { kind: 'hotseat', displayName: 'Table seat' },
      },
      { showServerUpdateDialog: true },
    );
  });

  it('uses a catalog channel for remote room admissions without sending a release pin', async () => {
    const room = { id: 'room/channel', status: 'open' };
    httpMocks.post.mockResolvedValueOnce({ data: room });

    await expect(
      platformApi.createRoom({
        gameId: 'brass',
        modeId: 'standard',
        channel: 'stable',
        releaseId: 'ignored-release',
        requestId: 'request-channel',
        visibility: 'public',
        setup: {},
      }),
    ).resolves.toEqual(room);

    expect(httpMocks.post).toHaveBeenCalledWith(
      '/platform/rooms',
      {
        gameId: 'brass',
        modeId: 'standard',
        channel: 'stable',
        requestId: 'request-channel',
        visibility: 'public',
        setup: {},
      },
      { showServerUpdateDialog: true },
    );
  });

  it('keeps release pins for legacy room admissions', async () => {
    const room = { id: 'room/legacy', status: 'open' };
    httpMocks.post.mockResolvedValueOnce({ data: room });

    await platformApi.createRoom({
      gameId: 'seti',
      modeId: 'standard',
      releaseId: 'seti-native-v1',
      requestId: 'request-release',
      visibility: 'public',
      setup: {},
    });

    expect(httpMocks.post).toHaveBeenCalledWith(
      '/platform/rooms',
      expect.objectContaining({ releaseId: 'seti-native-v1' }),
      { showServerUpdateDialog: true },
    );
  });

  it('reads the platform-owned terminal result through the stable result endpoint', async () => {
    const result = {
      status: 'completed',
      result: { kind: 'solo', outcome: 'won' },
    };
    httpMocks.get.mockResolvedValueOnce({ data: result });

    await expect(platformApi.getSessionResult('session/1')).resolves.toEqual(
      result,
    );

    expect(httpMocks.get).toHaveBeenCalledWith(
      '/platform/sessions/session%2F1/result',
      { showServerUpdateDialog: true },
    );
  });
});
