import type {
  GameSessionControlsView,
  GetEventsResponse,
  JsonObject,
  JsonValue,
  PlayerViewEnvelope,
  QueryOptionsResponse,
  ResumeResult,
  SessionRoute,
  SubmitCommandResponse,
} from '@board-game/contracts';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlatformRoomSessionPanel } from '@/pages/platform/PlatformRoomSessionPanel.js';

const mocks = vi.hoisted(() => {
  const signals = {
    subscribeRevision: vi.fn(() => () => undefined),
    setForeground: vi.fn(),
    isConnected: true,
  };
  return {
    requestId: vi.fn(() => 'command-1'),
    signals,
    transport: {
      getPlayerView: vi.fn(),
      getEvents: vi.fn(),
      resume: vi.fn(),
      submitCommand: vi.fn(),
      queryOptions: vi.fn(),
    },
  };
});

vi.mock('@/api/platformApi', () => ({
  createPlatformRequestId: mocks.requestId,
}));
vi.mock('@/runtime', () => ({
  createBrowserPlatformRuntime: () => ({
    http: { get: vi.fn(), post: vi.fn() },
    signals: mocks.signals,
    session: {
      signals: mocks.signals,
      createTransport: () => mocks.transport,
    },
    viewer: { principalId: 'viewer', identityKey: 'account:viewer' },
    navigation: { platformHref: '/platform', replayHref: () => '/replay' },
  }),
}));

const route: SessionRoute = {
  gameId: 'test-game',
  modeId: 'room',
  sessionId: 'session-1',
  releaseId: 'release-1',
  backendBindingId: 'backend-1',
  storageBindingId: 'storage-1',
  ownershipEpoch: 'epoch-1',
};

type RoomView = JsonObject & {
  readonly sessionControls: GameSessionControlsView;
};

const controlsView: GameSessionControlsView = {
  participants: [
    {
      principalId: 'viewer',
      displayName: 'Viewer',
      controller: 'human',
      active: true,
    },
    {
      principalId: 'other-player',
      displayName: 'Other player',
      controller: 'human',
      active: true,
    },
  ],
  timeout: null,
  abandon: null,
  serverNowMs: 1_000,
  viewerId: 'viewer',
  status: 'active',
  confirmationDelayMs: 0,
  availableModes: [],
};

function snapshot(
  view: GameSessionControlsView = controlsView,
): PlayerViewEnvelope<RoomView> {
  return {
    gameId: route.gameId,
    sessionId: route.sessionId,
    releaseId: route.releaseId,
    viewSchemaVersion: 1,
    audienceKey: 'player:viewer',
    viewEpoch: 'view-epoch-1',
    baseRevision: 1,
    revision: 1,
    eventSequence: 0,
    streamCursor: 'cursor-0',
    kind: 'snapshot',
    payload: { sessionControls: view },
  };
}

function events(): GetEventsResponse {
  return {
    gameId: route.gameId,
    sessionId: route.sessionId,
    releaseId: route.releaseId,
    audienceKey: 'player:viewer',
    viewEpoch: 'view-epoch-1',
    events: [],
    nextSequence: 0,
    hasMore: false,
    resetRequired: false,
  };
}

function response(
  status: 'accepted' | 'unknown' | 'rejected' | 'duplicate',
  commandId = 'command-1',
): SubmitCommandResponse<RoomView> {
  return {
    receipt: {
      commandId,
      sessionId: route.sessionId,
      status,
      resultRetention: 'replayable',
      persistedRevision: 1,
    },
  };
}

function createResumeResult(): ResumeResult<RoomView> {
  return { kind: 'snapshot', view: snapshot() };
}

function configureTransport(): void {
  mocks.transport.getPlayerView.mockResolvedValue(snapshot());
  mocks.transport.getEvents.mockResolvedValue(events());
  mocks.transport.resume.mockResolvedValue(createResumeResult());
  mocks.transport.submitCommand.mockResolvedValue(response('accepted'));
  mocks.transport.queryOptions.mockResolvedValue({
    route,
    revision: 1,
    answer: null,
  } satisfies QueryOptionsResponse<JsonValue>);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  configureTransport();
});

describe('PlatformRoomSessionPanel', () => {
  it('offers abandon controls without a current-turn player requirement', async () => {
    render(<PlatformRoomSessionPanel route={route} />);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Propose abandon' }),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Confirm abandon' }),
    );

    await waitFor(() =>
      expect(mocks.transport.submitCommand).toHaveBeenCalledOnce(),
    );
    expect(mocks.transport.submitCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: { type: 'sessionControl', action: 'abandonAgree' },
        precondition: { kind: 'revision', expectedRevision: 1 },
      }),
    );
  });

  it('disables repeated commands while the first command is sending', async () => {
    let resolveSubmission: (value: SubmitCommandResponse<RoomView>) => void =
      () => undefined;
    mocks.transport.submitCommand.mockImplementationOnce(
      () =>
        new Promise<SubmitCommandResponse<RoomView>>((resolve) => {
          resolveSubmission = resolve;
        }),
    );
    render(<PlatformRoomSessionPanel route={route} />);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Propose abandon' }),
    );
    const confirm = await screen.findByRole('button', {
      name: 'Confirm abandon',
    });
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(mocks.transport.submitCommand).toHaveBeenCalledOnce(),
    );
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(mocks.transport.submitCommand).toHaveBeenCalledOnce();

    resolveSubmission(response('accepted'));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Propose abandon' }),
      ).not.toBeDisabled(),
    );
  });

  it('retries an unknown outcome with the same command intent', async () => {
    mocks.transport.submitCommand
      .mockResolvedValueOnce(response('unknown'))
      .mockResolvedValueOnce(response('accepted'));
    render(<PlatformRoomSessionPanel route={route} />);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Propose abandon' }),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Confirm abandon' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The command outcome is unknown.',
    );

    const firstRequest = mocks.transport.submitCommand.mock.calls[0]?.[0];
    fireEvent.click(screen.getByRole('button', { name: 'Retry command' }));
    await waitFor(() =>
      expect(mocks.transport.submitCommand).toHaveBeenCalledTimes(2),
    );
    const retryRequest = mocks.transport.submitCommand.mock.calls[1]?.[0];
    expect(retryRequest).toEqual(
      expect.objectContaining({
        commandId: firstRequest?.commandId,
        command: firstRequest?.command,
        precondition: firstRequest?.precondition,
      }),
    );
  });

  it('resumes the authoritative view after a conflict', async () => {
    mocks.transport.submitCommand.mockRejectedValueOnce({
      code: 'CONFLICT',
      messageKey: 'platform.session.conflict',
      retryable: true,
    });
    render(<PlatformRoomSessionPanel route={route} />);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Propose abandon' }),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Confirm abandon' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The session changed. Refresh before trying again.',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Refresh session' }));
    await waitFor(() => expect(mocks.transport.resume).toHaveBeenCalledOnce());
    expect(
      await screen.findByRole('button', { name: 'Propose abandon' }),
    ).toBeInTheDocument();
  });

  it('shows ended state and hides actions when the session is closed', async () => {
    mocks.transport.getPlayerView.mockRejectedValueOnce({
      code: 'SESSION_CLOSED',
      messageKey: 'platform.session.closed',
      retryable: false,
    });
    render(<PlatformRoomSessionPanel route={route} />);

    expect(await screen.findByText('This game has ended.')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Propose abandon' }),
    ).not.toBeInTheDocument();
  });
});
