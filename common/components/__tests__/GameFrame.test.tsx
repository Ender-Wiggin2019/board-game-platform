import type {
  ClientSessionState,
  PlatformEventFeedState,
} from '@board-game/client';
import type { GetEventsResponse } from '@board-game/contracts';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deriveGameFrameModel,
  deriveGameFrameState,
  GameFrame,
  type GameFrameModel,
  GameLayout,
  GameResult,
  GameSlot,
  PlatformPlayer,
} from '../src/index.js';

afterEach(cleanup);

function storeState(): ClientSessionState {
  return {
    route: {
      gameId: 'fixture',
      modeId: 'turns',
      sessionId: 'session',
      releaseId: 'v1',
      backendBindingId: 'host',
      storageBindingId: 'store',
      ownershipEpoch: '1',
    },
    identityKey: 'account:1',
    status: 'ready',
    snapshot: {
      gameId: 'fixture',
      sessionId: 'session',
      releaseId: 'v1',
      revision: 2,
      audienceKey: 'player:1',
      viewEpoch: '1',
      viewSchemaVersion: 1,
      streamCursor: 'cursor',
      baseRevision: 2,
      kind: 'snapshot',
      payload: {},
    },
    pendingSubmission: null,
    lastSubmission: null,
    query: null,
    error: null,
    recoveryReason: null,
  };
}

function model(): GameFrameModel {
  return {
    state: deriveGameFrameState(storeState(), 'active'),
    players: [
      {
        principalId: 'account',
        seatId: 'seat-2',
        displayName: 'Ada',
        connection: 'away',
        needsAttention: true,
      },
    ],
    history: {
      permitted: true,
      loading: false,
      hasMore: true,
      error: false,
      loadMore: vi.fn(),
      window: 'latest',
      hasEarlier: false,
      loadEarlier: vi.fn(),
      loadLatest: vi.fn(),
    },
  };
}

function feedState(
  overrides: Partial<PlatformEventFeedState> = {},
): PlatformEventFeedState {
  return {
    audienceKey: 'player:1',
    viewEpoch: 'epoch-1',
    window: 'latest',
    failedRead: null,
    nextSequence: 12,
    hasMore: true,
    resetRequired: false,
    oldestSequence: 8,
    truncated: false,
    loading: false,
    error: null,
    events: [],
    ...overrides,
  };
}

const presentation = { loading: <p>Loading</p>, error: <p>Unavailable</p> };

describe('shared game lifecycle slots', () => {
  it('keeps optional responsive layouts inside the action and history authority', () => {
    const onAction = vi.fn();
    const frame = model();
    const { rerender } = render(
      <GameFrame model={frame} presentation={presentation}>
        <GameLayout
          board={<p>Board</p>}
          actions={<button onClick={onAction}>Play</button>}
          history={<p>Private history</p>}
        />
      </GameFrame>,
    );
    fireEvent.click(screen.getByText('Play'));
    expect(onAction).toHaveBeenCalledTimes(1);
    rerender(
      <GameFrame
        model={{
          ...frame,
          state: { ...frame.state, actionsDisabled: true },
          history: { ...frame.history, permitted: false },
        }}
        presentation={presentation}
      >
        <GameLayout
          board={<p>Board</p>}
          actions={<button onClick={onAction}>Play</button>}
          history={<p>Private history</p>}
        />
      </GameFrame>,
    );
    fireEvent.click(screen.getByText('Play'));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Private history')).toBeNull();
    expect(screen.getByText('Board')).toBeTruthy();
  });

  it('derives one history controller from the platform feed and reader', () => {
    const readEvents = vi.fn(async () => ({}) as GetEventsResponse);
    const source = storeState();
    const derived = deriveGameFrameModel({
      state: source,
      events: feedState(),
      readEvents,
      sessionStatus: 'active',
      players: [],
    });

    expect(derived.state.actionsDisabled).toBe(false);
    expect(derived.history.permitted).toBe(true);
    expect(derived.history.hasEarlier).toBe(true);
    derived.history.loadMore();
    expect(readEvents).toHaveBeenCalledWith({
      replace: false,
      window: 'latest',
    });

    derived.history.loadEarlier();
    expect(readEvents).toHaveBeenCalledWith({
      afterSequence: 0,
      replace: true,
      window: 'history',
    });
  });

  it('keeps read-only and history error state in the derived model', () => {
    const readEvents = vi.fn(async () => ({}) as GetEventsResponse);
    const derived = deriveGameFrameModel({
      state: storeState(),
      events: feedState({
        window: 'history',
        hasMore: false,
        error: new Error('expired'),
      }),
      readEvents,
      sessionStatus: 'active',
      readOnly: true,
      players: [],
    });

    expect(derived.state.actionsDisabled).toBe(true);
    expect(derived.history.error).toBe(true);
    expect(derived.history.window).toBe('history');
    derived.history.loadLatest();
    expect(readEvents).toHaveBeenCalledWith({
      afterSequence: 0,
      replace: true,
      window: 'latest',
    });
  });

  it('retries the exact failed event read from the shared history controller', () => {
    const readEvents = vi.fn(async () => ({}) as GetEventsResponse);
    const failedRead = {
      afterSequence: 0,
      limit: 200,
      viewEpoch: 'epoch-1',
      replace: true,
      window: 'history' as const,
    };
    const derived = deriveGameFrameModel({
      state: storeState(),
      events: feedState({
        error: new Error('earliest page unavailable'),
        failedRead,
      }),
      readEvents,
      sessionStatus: 'active',
      players: [],
    });

    derived.history.loadMore();
    expect(readEvents).toHaveBeenCalledWith(failedRead);
  });

  it('blocks duplicate actions while their outcome is unknown, then unlocks after a receipt', () => {
    const onAction = vi.fn();
    const ready = model();
    const pending = {
      ...ready,
      state: {
        ...ready.state,
        submission: 'unknown' as const,
        actionsDisabled: true,
      },
    };
    const body = (
      <GameSlot name='actions'>
        <button onClick={onAction}>Act</button>
      </GameSlot>
    );
    const page = render(
      <GameFrame model={pending} presentation={presentation}>
        {body}
      </GameFrame>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Act' }));
    expect(onAction).not.toHaveBeenCalled();
    page.rerender(
      <GameFrame model={ready} presentation={presentation}>
        {body}
      </GameFrame>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Act' }));
    expect(onAction).toHaveBeenCalledOnce();
  });

  it('shows the retryable error surface when a stale view cannot refresh', () => {
    const ready = model();
    const failed = {
      ...ready,
      state: {
        ...ready.state,
        phase: 'error' as const,
        submission: 'idle' as const,
      },
    };
    render(
      <GameFrame model={failed} presentation={presentation}>
        <p>Stale game board</p>
      </GameFrame>,
    );

    expect(screen.queryByText('Stale game board')).toBeNull();
    expect(screen.queryByText('Unavailable')).not.toBeNull();
  });

  it('shows a generic automation failure without exposing its diagnostic key', () => {
    const source = storeState();
    if (!source.snapshot) throw new Error('fixture snapshot is required');
    const frame = {
      ...model(),
      state: deriveGameFrameState(
        {
          ...source,
          snapshot: {
            ...source.snapshot,
            automationFailure: {
              seatId: 'seat-2',
              messageKey: 'automation.internal.stack-trace',
            },
          },
        },
        'active',
      ),
    };
    const page = render(
      <GameFrame model={frame} presentation={presentation}>
        <p>Board</p>
      </GameFrame>,
    );

    expect(screen.getByTestId('game-automation-failure').textContent).toBe(
      'Automation is temporarily unavailable for this seat.',
    );
    expect(screen.queryByText('automation.internal.stack-trace')).toBeNull();

    page.rerender(
      <GameFrame
        model={frame}
        presentation={{
          ...presentation,
          automationFailure: () => (
            <p role='status' data-testid='game-automation-failure'>
              自动化席位暂时无法行动
            </p>
          ),
        }}
      >
        <p>Board</p>
      </GameFrame>,
    );
    expect(screen.getByTestId('game-automation-failure').textContent).toBe(
      '自动化席位暂时无法行动',
    );
    expect(screen.queryByText('automation.internal.stack-trace')).toBeNull();
  });

  it('does not retain projected history in the UI after access is removed', () => {
    const ready = model();
    const body = <GameSlot name='history'>Allowed event</GameSlot>;
    const page = render(
      <GameFrame model={ready} presentation={presentation}>
        {body}
      </GameFrame>,
    );
    expect(screen.queryByText('Allowed event')).not.toBeNull();
    page.rerender(
      <GameFrame
        model={{ ...ready, history: { ...ready.history, permitted: false } }}
        presentation={presentation}
      >
        {body}
      </GameFrame>,
    );
    expect(screen.queryByText('Allowed event')).toBeNull();
  });

  it('keeps history permission gating while allowing compact slots to hide controls', () => {
    const ready = model();
    const historyControls = vi.fn(() => <p>History controls</p>);
    const page = render(
      <GameFrame
        model={ready}
        presentation={{ ...presentation, historyControls }}
      >
        <GameSlot name='history' showHistoryControls={false}>
          Allowed event
        </GameSlot>
      </GameFrame>,
    );
    expect(screen.queryByText('Allowed event')).not.toBeNull();
    expect(screen.queryByText('History controls')).toBeNull();

    page.rerender(
      <GameFrame
        model={ready}
        presentation={{ ...presentation, historyControls }}
      >
        <GameSlot name='history'>Allowed event</GameSlot>
      </GameFrame>,
    );
    expect(screen.queryByText('History controls')).not.toBeNull();

    page.rerender(
      <GameFrame
        model={{ ...ready, history: { ...ready.history, permitted: false } }}
        presentation={{ ...presentation, historyControls }}
      >
        <GameSlot name='history' showHistoryControls={false}>
          Protected event
        </GameSlot>
      </GameFrame>,
    );
    expect(screen.queryByText('Protected event')).toBeNull();
    expect(screen.queryByText('History controls')).toBeNull();
  });

  it('supplies account, frozen seat, attention and connection without interpreting game resources', () => {
    render(
      <GameFrame model={model()} presentation={presentation}>
        <PlatformPlayer principalId='account'>
          {(player) => (
            <p>
              {player?.displayName}:{player?.seatId}:{player?.connection}:
              {String(player?.needsAttention)}
            </p>
          )}
        </PlatformPlayer>
      </GameFrame>,
    );
    expect(screen.queryByText('Ada:seat-2:away:true')).not.toBeNull();
  });

  it('derives conflicts, pause and read-only action boundaries from the same session store', () => {
    const source = storeState();
    expect(deriveGameFrameState(source, 'paused').actionsDisabled).toBe(true);
    expect(deriveGameFrameState(source, 'active', true).actionsDisabled).toBe(
      true,
    );
    const conflict = deriveGameFrameState(
      {
        ...source,
        lastSubmission: {
          outcome: 'rejected',
          commandId: 'c1',
          receipt: {
            commandId: 'c1',
            sessionId: 'session',
            status: 'rejected',
            resultRetention: 'replayable',
            error: {
              code: 'STALE_REVISION',
              messageKey: 'stale',
              retryable: true,
            },
          },
        },
      },
      'active',
    );
    expect(conflict.submission).toBe('conflict');
  });

  it('keeps result loading, failure and ready mutually exclusive', () => {
    const page = render(
      <GameResult status='loading' loading='Loading' error='Unavailable'>
        Final score
      </GameResult>,
    );
    expect(screen.queryByText('Final score')).toBeNull();
    page.rerender(
      <GameResult status='error' loading='Loading' error='Unavailable'>
        Final score
      </GameResult>,
    );
    expect(screen.queryByText('Loading')).toBeNull();
    expect(screen.queryByText('Unavailable')).not.toBeNull();
    page.rerender(
      <GameResult status='ready' loading='Loading' error='Unavailable'>
        Final score
      </GameResult>,
    );
    expect(screen.queryByText('Final score')).not.toBeNull();
  });
});
