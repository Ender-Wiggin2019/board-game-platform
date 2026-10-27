import type {
  ClientSessionTransport,
  GameEntryRuntime,
} from '@board-game/client';
import type {
  GetEventsResponse,
  JsonObject,
  PlayerViewEnvelope,
  QueryOptionsResponse,
  ResumeResult,
  SessionRoute,
  SubmitCommandResponse,
} from '@board-game/contracts';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { defineGameComponent } from '../src/defineGameComponent.js';

type TestCommand = JsonObject & { readonly type: 'test' };
type TestQuery = JsonObject & { readonly type: 'test' };
type TestView = JsonObject & {
  readonly playerId: string;
  readonly players: readonly JsonObject[];
};

const route: SessionRoute = {
  gameId: 'test-game',
  modeId: 'test',
  sessionId: 'session-1',
  releaseId: 'release-1',
  backendBindingId: 'host-1',
  storageBindingId: 'storage-1',
  ownershipEpoch: '1',
};

const snapshot: PlayerViewEnvelope<TestView> = {
  gameId: route.gameId,
  sessionId: route.sessionId,
  releaseId: route.releaseId,
  revision: 1,
  eventSequence: 0,
  audienceKey: 'player:test',
  viewEpoch: 'epoch-1',
  viewSchemaVersion: 1,
  streamCursor: 'cursor-0',
  baseRevision: 1,
  kind: 'snapshot',
  payload: {
    playerId: 'p1',
    players: [],
  },
};

function createTransport(): ClientSessionTransport<
  TestCommand,
  TestQuery,
  JsonObject,
  TestView
> {
  return {
    getPlayerView: vi.fn(async () => snapshot),
    getEvents: vi.fn(
      async (): Promise<GetEventsResponse> => ({
        gameId: route.gameId,
        sessionId: route.sessionId,
        releaseId: route.releaseId,
        audienceKey: snapshot.audienceKey,
        viewEpoch: snapshot.viewEpoch,
        events: [],
        nextSequence: 0,
        hasMore: false,
        resetRequired: false,
      }),
    ),
    resume: vi.fn(
      async (): Promise<ResumeResult<TestView>> => ({
        kind: 'snapshot',
        view: snapshot,
      }),
    ),
    submitCommand: vi.fn(
      () => new Promise<SubmitCommandResponse<TestView>>(() => undefined),
    ),
    queryOptions: vi.fn(
      async (): Promise<QueryOptionsResponse<JsonObject>> => ({
        route,
        answer: {},
        revision: 1,
      }),
    ),
  };
}

function createRuntime(
  transport: ClientSessionTransport<
    TestCommand,
    TestQuery,
    JsonObject,
    TestView
  >,
): GameEntryRuntime {
  const signals = {
    subscribeRevision: () => () => undefined,
    setForeground: () => undefined,
  };
  return {
    http: { get: vi.fn(), post: vi.fn() },
    signals,
    session: {
      signals,
      createTransport: ((_route: SessionRoute) =>
        transport) as GameEntryRuntime['session']['createTransport'],
    },
    viewer: { principalId: 'p1', identityKey: 'account:p1' },
    navigation: {
      platformHref: '/platform',
      replayHref: () => '/replay',
    },
  };
}

const TestGame = defineGameComponent<
  'live',
  TestCommand,
  TestQuery,
  JsonObject,
  TestView,
  TestView
>({
  mode: 'live',
  session: { loadOnMount: true },
  project: ({ snapshot: current, entry }) =>
    current
      ? {
          ...current.payload,
          playerId: entry.controlledPlayerId ?? current.payload.playerId,
        }
      : undefined,
  frame: {
    project: ({ model }) => ({
      sessionStatus: 'active',
      players: [],
      model,
    }),
    Presentation: () => null,
  },
  render: ({ model, session }) => (
    <div data-testid='game-state'>
      <span data-testid='viewer'>{model?.playerId}</span>
      <span data-testid='pending'>
        {session?.state.pendingSubmission?.phase ?? 'none'}
      </span>
      <button
        type='button'
        onClick={() =>
          void session?.submitCommand({
            commandId: 'command-1',
            command: { type: 'test' },
            precondition: { kind: 'revision', expectedRevision: 1 },
          })
        }
      >
        submit
      </button>
    </div>
  ),
});

describe('defineGameComponent', () => {
  it('pins an equal route while preserving pending state and reprojects a controlled viewer', async () => {
    const transport = createTransport();
    const runtime = createRuntime(transport);
    const props = {
      route,
      runtime,
      status: 'active' as const,
      spectate: false,
    };
    const view = render(
      <TestGame {...props} controlledPlayerId='p1'></TestGame>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('viewer').textContent).toBe('p1'),
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'submit' }));
      await Promise.resolve();
    });
    expect(screen.getByTestId('pending').textContent).toBe('sending');

    view.rerender(
      <TestGame
        {...props}
        route={{ ...route }}
        controlledPlayerId='p2'
      ></TestGame>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('viewer').textContent).toBe('p2'),
    );
    expect(screen.getByTestId('pending').textContent).toBe('sending');
    expect(transport.getPlayerView).toHaveBeenCalledOnce();
  });
});
