import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { subscribeQueryRecovery } from '@/lib/queryRecovery';

const RECOVERED_EVENT = 'seti:server-update-recovered';

interface IRecoveryDetail {
  requestKey: string;
  requestSequence: number;
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        gcTime: Infinity,
        retry: false,
      },
    },
  });
}

function requestError(
  requestKey: string,
  requestSequence: number,
): Error & IRecoveryDetail {
  return Object.assign(new Error('Service unavailable'), {
    requestKey,
    requestSequence,
  });
}

function collectRecoveries(): {
  events: IRecoveryDetail[];
  stop: () => void;
} {
  const events: IRecoveryDetail[] = [];
  const listener = (event: Event): void => {
    events.push((event as CustomEvent<IRecoveryDetail>).detail);
  };
  window.addEventListener(RECOVERED_EVENT, listener);
  return {
    events,
    stop: () => window.removeEventListener(RECOVERED_EVENT, listener),
  };
}

describe('subscribeQueryRecovery', () => {
  it('recovers after an intermediate retry failure and a submitted fetch success', async () => {
    const queryClient = createQueryClient();
    const recovery = collectRecoveries();
    const unsubscribe = subscribeQueryRecovery(queryClient);
    let attempts = 0;

    const data = await queryClient.fetchQuery({
      queryKey: ['rooms'],
      retry: 1,
      retryDelay: 0,
      queryFn: async () => {
        attempts += 1;
        if (attempts === 1) throw requestError('get:/api/rooms', 7);
        return ['room-1'];
      },
    });

    expect(data).toEqual(['room-1']);
    expect(recovery.events).toEqual([
      { requestKey: 'get:/api/rooms', requestSequence: 7 },
    ]);

    unsubscribe();
    recovery.stop();
  });

  it('does not recover when a successful HTTP response fails during query parsing', async () => {
    const queryClient = createQueryClient();
    const recovery = collectRecoveries();
    const unsubscribe = subscribeQueryRecovery(queryClient);
    const parseError = new Error('Invalid room payload');

    await expect(
      queryClient.fetchQuery({
        queryKey: ['rooms'],
        queryFn: async () => {
          throw requestError('get:/api/rooms', 9);
        },
      }),
    ).rejects.toMatchObject({ requestSequence: 9 });

    await expect(
      queryClient.fetchQuery({
        queryKey: ['rooms'],
        queryFn: async () => {
          const response = { status: 200, body: '{}' };
          if (response.status === 200) throw parseError;
          return response.body;
        },
      }),
    ).rejects.toBe(parseError);

    expect(recovery.events).toHaveLength(0);
    await queryClient.fetchQuery({
      queryKey: ['rooms'],
      queryFn: async () => ['valid-room'],
    });
    expect(recovery.events).toEqual([
      { requestKey: 'get:/api/rooms', requestSequence: 9 },
    ]);
    unsubscribe();
    recovery.stop();
  });

  it('does not treat manual setQueryData as a recovered request', async () => {
    const queryClient = createQueryClient();
    const recovery = collectRecoveries();
    const unsubscribe = subscribeQueryRecovery(queryClient);
    const queryKey = ['rooms'];

    await expect(
      queryClient.fetchQuery({
        queryKey,
        queryFn: async () => {
          throw requestError('get:/api/rooms', 11);
        },
      }),
    ).rejects.toMatchObject({ requestSequence: 11 });

    queryClient.setQueryData(queryKey, ['optimistic-room']);

    expect(recovery.events).toHaveLength(0);
    unsubscribe();
    recovery.stop();
  });

  it('forgets a failed query when it is removed, so a replacement cannot leak recovery', async () => {
    const queryClient = createQueryClient();
    const recovery = collectRecoveries();
    const unsubscribe = subscribeQueryRecovery(queryClient);
    const queryKey = ['rooms'];

    await expect(
      queryClient.fetchQuery({
        queryKey,
        queryFn: async () => {
          throw requestError('get:/api/rooms', 13);
        },
      }),
    ).rejects.toMatchObject({ requestSequence: 13 });

    const failedQuery = queryClient.getQueryCache().find({ queryKey });
    expect(failedQuery).toBeDefined();
    if (!failedQuery) throw new Error('Expected the failed query to exist');
    queryClient.getQueryCache().remove(failedQuery);

    await queryClient.fetchQuery({
      queryKey,
      queryFn: async () => ['replacement-room'],
    });

    expect(recovery.events).toHaveLength(0);
    unsubscribe();
    recovery.stop();
  });
});
