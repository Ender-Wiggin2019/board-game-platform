import type { ClientSessionTransport } from '@board-game/client';
import type {
  GetEventsResponse,
  JsonObject,
  PlayerViewEnvelope,
  QueryOptionsResponse,
  ResumeResult,
  SessionRoute,
  SubmitCommandResponse,
} from '@board-game/contracts';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GameSessionProvider,
  useGameSession,
} from '../src/GameSessionProvider.js';

afterEach(cleanup);

const routeOne: SessionRoute = {
  gameId: 'seti',
  modeId: 'casual-multiplayer',
  sessionId: 'session-1',
  releaseId: 'release-1',
  backendBindingId: 'host-1',
  storageBindingId: 'storage-1',
  ownershipEpoch: 'owner-1',
};

const routeTwo: SessionRoute = {
  ...routeOne,
  sessionId: 'session-2',
};

type FixtureView = JsonObject & { readonly marker: string };

function viewFor(route: SessionRoute): PlayerViewEnvelope<FixtureView> {
  const revision = route.sessionId === 'session-1' ? 7 : 9;
  return {
    gameId: route.gameId,
    sessionId: route.sessionId,
    releaseId: route.releaseId,
    revision,
    eventSequence: 1,
    audienceKey: `player:${route.sessionId}`,
    viewEpoch: `epoch:${route.sessionId}`,
    viewSchemaVersion: 1,
    streamCursor: `cursor:${route.sessionId}`,
    baseRevision: revision,
    kind: 'snapshot',
    payload: { marker: route.sessionId },
  };
}

function createTransport() {
  const transport: ClientSessionTransport<
    JsonObject,
    JsonObject,
    JsonObject,
    FixtureView
  > = {
    getPlayerView: vi.fn(async ({ route }) => viewFor(route)),
    getEvents: vi.fn(
      async ({ route }): Promise<GetEventsResponse> => ({
        gameId: route.gameId,
        sessionId: route.sessionId,
        releaseId: route.releaseId,
        audienceKey: `player:${route.sessionId}`,
        viewEpoch: `epoch:${route.sessionId}`,
        nextSequence: 1,
        hasMore: false,
        resetRequired: false,
        events: [
          {
            sequence: 1,
            eventId: `event:${route.sessionId}`,
            payload: { marker: route.sessionId },
          },
        ],
      }),
    ),
    resume: vi.fn(
      async ({ route }): Promise<ResumeResult<FixtureView>> => ({
        kind: 'snapshot',
        view: viewFor(route),
      }),
    ),
    submitCommand: vi.fn(
      async ({
        route,
        commandId,
      }): Promise<SubmitCommandResponse<FixtureView>> => ({
        receipt: {
          commandId,
          sessionId: route.sessionId,
          status: 'accepted',
          resultRetention: 'replayable',
          persistedRevision: viewFor(route).revision,
        },
        view: viewFor(route),
      }),
    ),
    queryOptions: vi.fn(
      async ({
        route,
        revision,
      }): Promise<QueryOptionsResponse<JsonObject>> => ({
        route,
        revision,
        answer: {},
      }),
    ),
  };
  return transport;
}

function Probe({
  observations,
}: {
  observations: Observation[];
}): React.JSX.Element {
  const session = useGameSession<
    JsonObject,
    JsonObject,
    JsonObject,
    FixtureView
  >();
  const snapshot = session.state.snapshot;
  observations.push({
    route: session.state.route.sessionId,
    status: session.state.status,
    marker: snapshot?.payload.marker ?? null,
    eventCount: session.events.events.length,
  });
  return (
    <>
      <output data-testid='session-status'>{session.state.status}</output>
      <output data-testid='session-marker'>
        {snapshot?.payload.marker ?? ''}
      </output>
      <button
        type='button'
        onClick={() => {
          if (!snapshot) return;
          void session.submitCommand({
            commandId: 'fixture-command',
            command: { type: 'fixture' },
            precondition: {
              kind: 'revision',
              expectedRevision: snapshot.revision,
            },
          });
        }}
      >
        submit
      </button>
    </>
  );
}

interface Observation {
  readonly route: string;
  readonly status: string;
  readonly marker: string | null;
  readonly eventCount: number;
}

function renderProvider(
  route: SessionRoute,
  identityKey: string,
  transport: ReturnType<typeof createTransport>,
  observations: Observation[],
) {
  return render(
    <GameSessionProvider
      route={route}
      transport={transport}
      identityKey={identityKey}
    >
      <Probe observations={observations} />
    </GameSessionProvider>,
  );
}

describe('GameSessionProvider resource isolation', () => {
  it('does not render or submit the previous route snapshot on a route switch', async () => {
    const transport = createTransport();
    const observations: Observation[] = [];
    const rendered = renderProvider(
      routeOne,
      'account:one',
      transport,
      observations,
    );

    await waitFor(() =>
      expect(screen.getByTestId('session-marker').textContent).toBe(
        'session-1',
      ),
    );
    await waitFor(() => expect(observations.at(-1)?.eventCount).toBe(1));

    const beforeSwitch = observations.length;
    rendered.rerender(
      <GameSessionProvider
        route={routeTwo}
        transport={transport}
        identityKey='account:two'
      >
        <Probe observations={observations} />
      </GameSessionProvider>,
    );

    expect(observations.slice(beforeSwitch)[0]).toEqual({
      route: 'session-2',
      status: 'loading',
      marker: null,
      eventCount: 0,
    });
    act(() => {
      screen.getByRole('button', { name: 'submit' }).click();
    });
    expect(transport.submitCommand).not.toHaveBeenCalled();

    await waitFor(() =>
      expect(screen.getByTestId('session-marker').textContent).toBe(
        'session-2',
      ),
    );
    act(() => {
      screen.getByRole('button', { name: 'submit' }).click();
    });
    await waitFor(() => expect(transport.submitCommand).toHaveBeenCalledOnce());
    expect(transport.submitCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        route: routeTwo,
        precondition: { kind: 'revision', expectedRevision: 9 },
      }),
    );
  });

  it('resets the first render and event feed when only the account identity changes', async () => {
    const transport = createTransport();
    const observations: Observation[] = [];
    const rendered = renderProvider(
      routeOne,
      'account:one',
      transport,
      observations,
    );

    await waitFor(() =>
      expect(screen.getByTestId('session-marker').textContent).toBe(
        'session-1',
      ),
    );
    const beforeSwitch = observations.length;

    rendered.rerender(
      <GameSessionProvider
        route={routeOne}
        transport={transport}
        identityKey='account:two'
      >
        <Probe observations={observations} />
      </GameSessionProvider>,
    );

    expect(observations.slice(beforeSwitch)[0]).toEqual({
      route: 'session-1',
      status: 'loading',
      marker: null,
      eventCount: 0,
    });
  });
});
