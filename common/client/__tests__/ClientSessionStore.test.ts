import type {
  GetEventsResponse,
  PlayerViewEnvelope,
  QueryOptionsResponse,
  ResumeResult,
  SafeCommandReceipt,
  SessionRoute,
  SubmitCommandResponse,
} from '@board-game/contracts';
import { describe, expect, it, vi } from 'vitest';
import type {
  ClientGetPlayerViewRequest,
  ClientQueryOptionsRequest,
  ClientSessionTransport,
  ClientSubmitCommandRequest,
} from '../src/ClientSessionStore.js';
import {
  type ClientCommandIntent,
  ClientSessionStore,
} from '../src/ClientSessionStore.js';

type Command = { readonly action: string; readonly value: number };
type Query = { readonly filter: string };
type Answer = { readonly options: readonly string[] };
type View = { readonly score: number; readonly marker: string };

const route: SessionRoute = {
  gameId: 'seti',
  modeId: 'room',
  sessionId: 'session-1',
  releaseId: 'release-1',
  backendBindingId: 'backend-1',
  storageBindingId: 'storage-1',
  ownershipEpoch: 'ownership-1',
};

function snapshot(
  revision: number,
  payload: View,
  audienceKey = 'audience-a',
  viewEpoch = 'epoch-a',
): PlayerViewEnvelope<View> {
  return {
    gameId: route.gameId,
    sessionId: route.sessionId,
    releaseId: route.releaseId,
    viewSchemaVersion: 1,
    audienceKey,
    viewEpoch,
    baseRevision: revision,
    revision,
    streamCursor: `${audienceKey}:${revision}`,
    kind: 'snapshot',
    payload,
  };
}

function delta(
  baseRevision: number,
  revision: number,
  payload: View,
  audienceKey = 'audience-a',
  viewEpoch = 'epoch-a',
): PlayerViewEnvelope<View> {
  return {
    ...snapshot(revision, payload, audienceKey, viewEpoch),
    baseRevision,
    kind: 'patch',
  };
}

function receipt(
  commandId: string,
  status: SafeCommandReceipt['status'],
): SafeCommandReceipt {
  return {
    commandId,
    sessionId: route.sessionId,
    status,
    resultRetention: 'replayable',
    ...(status === 'accepted' ? { persistedRevision: 2 } : {}),
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function transport(
  overrides: Partial<ClientSessionTransport<Command, Query, Answer, View>> = {},
): ClientSessionTransport<Command, Query, Answer, View> {
  return {
    getPlayerView: vi.fn(async (_request: ClientGetPlayerViewRequest) =>
      snapshot(1, { score: 1, marker: 'initial' }),
    ),
    getEvents: vi.fn(
      async (): Promise<GetEventsResponse> => ({
        gameId: route.gameId,
        sessionId: route.sessionId,
        releaseId: route.releaseId,
        audienceKey: 'audience-a',
        viewEpoch: 'epoch-a',
        nextSequence: 0,
        hasMore: false,
        events: [],
        resetRequired: false,
      }),
    ),
    resume: vi.fn(
      async () =>
        ({
          kind: 'snapshot',
          view: snapshot(1, { score: 1, marker: 'initial' }),
        }) satisfies ResumeResult<View>,
    ),
    submitCommand: vi.fn(
      async (_request: ClientSubmitCommandRequest<Command>) =>
        ({
          receipt: receipt('command-1', 'rejected'),
        }) satisfies SubmitCommandResponse<View>,
    ),
    queryOptions: vi.fn(
      async (_request: ClientQueryOptionsRequest<Query>) =>
        ({
          route,
          revision: 1,
          answer: { options: ['default'] },
        }) satisfies QueryOptionsResponse<Answer>,
    ),
    ...overrides,
  };
}

function commandIntent(commandId = 'command-1'): ClientCommandIntent<Command> {
  return {
    commandId,
    command: { action: 'select', value: 4 },
    precondition: { kind: 'revision', expectedRevision: 1 },
  };
}

describe('ClientSessionStore', () => {
  it('keeps one authoritative snapshot and omits access context from browser requests', async () => {
    const clientTransport = transport();
    const store = new ClientSessionStore({ route, transport: clientTransport });
    const observed: string[] = [];
    const unsubscribe = store.subscribe((state) => {
      observed.push(state.status);
    });

    await store.load();

    expect(store.getState().status).toBe('ready');
    expect(store.getState().snapshot?.payload).toEqual({
      score: 1,
      marker: 'initial',
    });
    expect(clientTransport.getPlayerView).toHaveBeenCalledWith({
      protocolVersion: 1,
      route,
    });
    expect(
      vi.mocked(clientTransport.getPlayerView).mock.calls[0]?.[0],
    ).not.toHaveProperty('accessContext');
    expect(observed).toEqual(['loading', 'loading', 'ready']);
    unsubscribe();
  });

  it('uses the snapshot action precondition for a normal game command', async () => {
    const clientTransport = transport({
      getPlayerView: vi.fn(async () => ({
        ...snapshot(1, { score: 1, marker: 'initial' }),
        actionPrecondition: {
          kind: 'prompt' as const,
          promptId: 'prompt-1',
          participantInputRevision: 3,
        },
      })),
      submitCommand: vi.fn(async (request) => ({
        receipt: receipt(request.commandId, 'accepted'),
      })),
    });
    const store = new ClientSessionStore({ route, transport: clientTransport });
    await store.load();
    await store.submitCommand(commandIntent());

    expect(clientTransport.submitCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        precondition: {
          kind: 'prompt',
          promptId: 'prompt-1',
          participantInputRevision: 3,
        },
      }),
    );
  });

  it('keeps an explicit action precondition for management commands', async () => {
    const clientTransport = transport({
      getPlayerView: vi.fn(async () => ({
        ...snapshot(1, { score: 1, marker: 'initial' }),
        actionPrecondition: {
          kind: 'prompt' as const,
          promptId: 'prompt-1',
          participantInputRevision: 3,
        },
      })),
      submitCommand: vi.fn(async (request) => ({
        receipt: receipt(request.commandId, 'accepted'),
      })),
    });
    const store = new ClientSessionStore({ route, transport: clientTransport });
    await store.load();
    await store.submitAction(
      'command-1',
      { action: 'management', value: 0 },
      { kind: 'revision', expectedRevision: 9 },
    );

    expect(clientTransport.submitCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        precondition: { kind: 'revision', expectedRevision: 9 },
      }),
    );
  });

  it('fences a response that arrives after disposal', async () => {
    const response = deferred<PlayerViewEnvelope<View>>();
    const clientTransport = transport({
      getPlayerView: vi.fn(() => response.promise),
    });
    const store = new ClientSessionStore({ route, transport: clientTransport });
    const listener = vi.fn();
    store.subscribe(listener);
    const load = store.load();
    store.dispose();
    response.resolve(snapshot(1, { score: 4, marker: 'late' }));
    await load;

    expect(store.getState().status).toBe('closed');
    expect(store.getState().snapshot).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('clears private state and ignores an old response after identity changes', async () => {
    const response = deferred<PlayerViewEnvelope<View>>();
    const clientTransport = transport({
      getPlayerView: vi.fn(() => response.promise),
    });
    const store = new ClientSessionStore({
      route,
      transport: clientTransport,
      identityKey: 'identity-a',
    });
    const load = store.load();
    store.setIdentity('identity-b');
    response.resolve(snapshot(1, { score: 99, marker: 'private-a' }));
    await load;

    expect(store.getState().identityKey).toBe('identity-b');
    expect(store.getState().snapshot).toBeNull();
    expect(store.getState().pendingSubmission).toBeNull();
    expect(store.getState().query).toBeNull();
  });

  it('returns to ready after a resume at the unchanged cursor', async () => {
    const current = snapshot(1, { score: 1, marker: 'current' });
    const clientTransport = transport({
      getPlayerView: vi.fn(async () => current),
      resume: vi.fn(async () => ({
        kind: 'delta' as const,
        view: { ...current, kind: 'patch' as const },
      })),
    });
    const store = new ClientSessionStore({ route, transport: clientTransport });
    await store.load();
    await store.resume();
    expect(store.getState().status).toBe('ready');
    expect(store.getState().snapshot?.payload).toEqual(current.payload);
    expect(clientTransport.getPlayerView).toHaveBeenCalledTimes(1);
  });

  it('resyncs when audience or view epoch changes', async () => {
    const audienceB = snapshot(2, { score: 2, marker: 'audience-b' }, 'b', 'b');
    const clientTransport = transport({
      getPlayerView: vi
        .fn()
        .mockResolvedValueOnce(snapshot(1, { score: 1, marker: 'a' }))
        .mockResolvedValueOnce(audienceB),
      resume: vi.fn(
        async () =>
          ({
            kind: 'snapshot',
            view: audienceB,
          }) satisfies ResumeResult<View>,
      ),
    });
    const store = new ClientSessionStore({ route, transport: clientTransport });

    await store.load();
    await store.resume();

    expect(clientTransport.getPlayerView).toHaveBeenCalledTimes(2);
    expect(store.getState().status).toBe('ready');
    expect(store.getState().snapshot?.audienceKey).toBe('b');
    expect(store.getState().snapshot?.payload).toEqual({
      score: 2,
      marker: 'audience-b',
    });
  });

  it('resyncs on a revision gap and never applies a gap delta', async () => {
    const applyDelta = vi.fn((current: View, incoming: View) => ({
      score: current.score + incoming.score,
      marker: 'patched',
    }));
    const recovered = snapshot(3, { score: 3, marker: 'recovered' });
    const clientTransport = transport({
      getPlayerView: vi
        .fn()
        .mockResolvedValueOnce(snapshot(1, { score: 1, marker: 'a' }))
        .mockResolvedValueOnce(recovered),
      resume: vi.fn(
        async () =>
          ({
            kind: 'delta',
            view: delta(2, 3, { score: 2, marker: 'gap' }),
          }) satisfies ResumeResult<View>,
      ),
    });
    const store = new ClientSessionStore({
      route,
      transport: clientTransport,
      applyDelta,
    });

    await store.load();
    await store.resume();

    expect(applyDelta).not.toHaveBeenCalled();
    expect(store.getState().status).toBe('ready');
    expect(store.getState().snapshot?.revision).toBe(3);
    expect(store.getState().snapshot?.payload.marker).toBe('recovered');
  });

  it('applies a contiguous delta through the game-owned hook', async () => {
    const applyDelta = vi.fn((current: View, incoming: View) => ({
      score: current.score + incoming.score,
      marker: incoming.marker,
    }));
    const clientTransport = transport({
      getPlayerView: vi.fn(async () => snapshot(1, { score: 3, marker: 'a' })),
      resume: vi.fn(
        async () =>
          ({
            kind: 'delta',
            view: delta(1, 2, { score: 2, marker: 'b' }),
          }) satisfies ResumeResult<View>,
      ),
    });
    const store = new ClientSessionStore({
      route,
      transport: clientTransport,
      applyDelta,
    });

    await store.load();
    await store.resume();

    expect(applyDelta).toHaveBeenCalledTimes(1);
    expect(store.getState().snapshot?.revision).toBe(2);
    expect(store.getState().snapshot?.payload).toEqual({
      score: 5,
      marker: 'b',
    });
  });

  it('retains the exact intent after an unknown outcome and retries the same command id', async () => {
    const clientTransport = transport({
      submitCommand: vi
        .fn()
        .mockRejectedValueOnce({ code: 'NETWORK' })
        .mockResolvedValueOnce({
          receipt: receipt('command-1', 'accepted'),
          view: snapshot(2, { score: 5, marker: 'accepted' }),
        } satisfies SubmitCommandResponse<View>),
    });
    const store = new ClientSessionStore({ route, transport: clientTransport });
    await store.load();
    const intent = commandIntent();

    await expect(store.submitCommand(intent)).rejects.toMatchObject({
      clientError: { code: 'NETWORK' },
    });
    expect(store.getState().pendingSubmission?.phase).toBe('unknown');
    expect(store.getState().pendingSubmission?.intent).toEqual(intent);
    await expect(
      store.submitCommand(commandIntent('command-2')),
    ).rejects.toMatchObject({
      clientError: { code: 'SUBMISSION_IN_FLIGHT' },
    });

    await store.retryPending();

    const firstRequest = vi.mocked(clientTransport.submitCommand).mock
      .calls[0]?.[0];
    const retryRequest = vi.mocked(clientTransport.submitCommand).mock
      .calls[1]?.[0];
    expect(retryRequest).toEqual(firstRequest);
    expect(retryRequest).not.toHaveProperty('accessContext');
    expect(store.getState().pendingSubmission).toBeNull();
    expect(store.getState().lastSubmission?.outcome).toBe('accepted');
    expect(store.getState().snapshot?.payload).toEqual({
      score: 5,
      marker: 'accepted',
    });
  });

  it('rejects a receipt with an invalid embedded error envelope', async () => {
    const clientTransport = transport({
      submitCommand: vi.fn(
        async () =>
          ({
            receipt: {
              ...receipt('command-1', 'unknown'),
              error: { code: 'NOT_A_PLATFORM_ERROR' },
            },
          }) as unknown as SubmitCommandResponse<View>,
      ),
    });
    const store = new ClientSessionStore({ route, transport: clientTransport });
    await store.load();

    await expect(store.submitCommand(commandIntent())).rejects.toMatchObject({
      clientError: { code: 'INVALID_RESPONSE' },
    });
    expect(store.getState().pendingSubmission).toBeNull();
    expect(store.getState().lastSubmission?.outcome).toBe('error');
  });

  it('rejects private fields in an embedded error envelope', async () => {
    const clientTransport = transport({
      submitCommand: vi.fn(
        async () =>
          ({
            receipt: {
              ...receipt('command-1', 'unknown'),
              error: {
                code: 'CONFLICT',
                messageKey: 'platform.error.conflict',
                retryable: true,
                encodedState: { private: true },
              },
            },
          }) as unknown as SubmitCommandResponse<View>,
      ),
    });
    const store = new ClientSessionStore({ route, transport: clientTransport });
    await store.load();

    await expect(store.submitCommand(commandIntent())).rejects.toMatchObject({
      clientError: { code: 'INVALID_RESPONSE' },
    });
    expect(store.getState().pendingSubmission).toBeNull();
    expect(store.getState().lastSubmission?.outcome).toBe('error');
  });

  it('rejects a receipt that carries a private command payload', async () => {
    const clientTransport = transport({
      submitCommand: vi.fn(
        async () =>
          ({
            receipt: {
              ...receipt('command-1', 'accepted'),
              payload: { private: true },
            },
          }) as unknown as SubmitCommandResponse<View>,
      ),
    });
    const store = new ClientSessionStore({ route, transport: clientTransport });
    await store.load();

    await expect(store.submitCommand(commandIntent())).rejects.toMatchObject({
      clientError: { code: 'INVALID_RESPONSE' },
    });
    expect(store.getState().pendingSubmission).toBeNull();
    expect(store.getState().lastSubmission?.outcome).toBe('error');
  });

  it('does not mutate the rule snapshot optimistically for a rejected command', async () => {
    const clientTransport = transport({
      submitCommand: vi.fn(
        async () =>
          ({
            receipt: receipt('command-1', 'rejected'),
          }) satisfies SubmitCommandResponse<View>,
      ),
    });
    const store = new ClientSessionStore({ route, transport: clientTransport });
    await store.load();
    const before = store.getState().snapshot;

    await store.submitCommand(commandIntent());

    expect(store.getState().status).toBe('ready');
    expect(store.getState().snapshot).toEqual(before);
    expect(store.getState().pendingSubmission).toBeNull();
    expect(store.getState().lastSubmission?.outcome).toBe('rejected');
  });

  it('ignores a stale query response by operation and revision', async () => {
    const first = deferred<QueryOptionsResponse<Answer>>();
    const second = deferred<QueryOptionsResponse<Answer>>();
    const clientTransport = transport({
      queryOptions: vi
        .fn()
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => second.promise),
    });
    const store = new ClientSessionStore({ route, transport: clientTransport });
    await store.load();
    const firstQuery = store.queryOptions({ filter: 'first' });
    const secondQuery = store.queryOptions({ filter: 'second' });
    second.resolve({ route, revision: 1, answer: { options: ['second'] } });
    await secondQuery;
    first.resolve({ route, revision: 1, answer: { options: ['first'] } });
    await firstQuery;

    expect(store.getState().query).toEqual({
      revision: 1,
      answer: { options: ['second'] },
    });
    expect(vi.mocked(clientTransport.queryOptions).mock.calls[0]?.[0]).toEqual({
      protocolVersion: 1,
      route,
      revision: 1,
      query: { filter: 'first' },
    });
  });

  it('stops notifying listeners after unsubscribe and disposal', async () => {
    const clientTransport = transport();
    const store = new ClientSessionStore({ route, transport: clientTransport });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    unsubscribe();
    await store.load();
    expect(listener).toHaveBeenCalledTimes(1);
    store.dispose();
    expect(listener).toHaveBeenCalledTimes(1);
  });
  it('clears private view, query and command data when access is revoked and fences a late view', async () => {
    const late = deferred<ResumeResult<View>>();
    const api = transport({ resume: vi.fn(() => late.promise) });
    const store = new ClientSessionStore({ route, transport: api });
    await store.load();
    await store.queryOptions({ filter: 'private' });
    const refreshing = store.resume();
    expect(store.invalidateAccess({ code: 'FORBIDDEN' })).toBe(true);
    late.resolve({
      kind: 'snapshot',
      view: snapshot(2, { score: 2, marker: 'late-private' }),
    });
    await refreshing;
    expect(store.getState()).toMatchObject({
      status: 'error',
      snapshot: null,
      query: null,
      pendingSubmission: null,
    });
    expect(JSON.stringify(store.getState())).not.toContain('late-private');
    expect(store.invalidateAccess({ code: 'NETWORK' })).toBe(false);
  });

  it.each([false, true])(
    'acknowledges a resolved action error after refresh (resync=%s)',
    async (resync) => {
      const api = transport({
        resume: vi.fn(async () =>
          resync
            ? {
                kind: 'resync-required' as const,
                reason: 'base-mismatch' as const,
                view: snapshot(1, { score: 1, marker: 'initial' }),
              }
            : {
                kind: 'snapshot' as const,
                view: snapshot(1, { score: 1, marker: 'initial' }),
              },
        ),
      });
      const store = new ClientSessionStore({ route, transport: api });
      await store.load();
      await store.submitCommand(commandIntent());
      expect(store.getState().lastSubmission?.outcome).toBe('rejected');
      await store.resume();
      expect(store.getState().lastSubmission).toBeNull();
    },
  );
});
