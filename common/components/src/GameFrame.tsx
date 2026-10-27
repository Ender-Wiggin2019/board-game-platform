import type {
  ClientSessionState,
  PlatformEventFeedState,
  PlatformEventReadOptions,
} from '@board-game/client';
import {
  type AutomationFailure,
  type CommandPrecondition,
  type GetEventsResponse,
  type JsonValue,
  MAX_EVENT_READ_LIMIT,
  type SessionStatus,
  type TurnView,
} from '@board-game/contracts';
import {
  Component,
  createContext,
  type ReactNode,
  type SyntheticEvent,
  useContext,
} from 'react';

export type GameSlotName =
  | 'frame'
  | 'players'
  | 'board'
  | 'actions'
  | 'history'
  | 'result';

/** Account/seat data must come from an authorized public projection. */
export interface PlatformPlayerSummary {
  readonly principalId: string;
  readonly seatId: string | null;
  readonly displayName: string;
  readonly connection: 'online' | 'away' | 'offline' | 'unknown';
  readonly needsAttention: boolean;
}

export interface GameFrameState {
  readonly key: string;
  readonly phase: 'loading' | 'ready' | 'recovering' | 'closed' | 'error';
  readonly hasView: boolean;
  readonly sessionStatus: SessionStatus;
  readonly submission: 'idle' | 'sending' | 'unknown' | 'conflict' | 'error';
  readonly actionsDisabled: boolean;
  readonly turn: TurnView | null;
  readonly actingSeatId?: string;
  readonly actionPrecondition?: CommandPrecondition;
  readonly automationFailure?: AutomationFailure;
}

export type GameHistoryReader = (
  options?: PlatformEventReadOptions,
) => Promise<GetEventsResponse>;

/** Derived from the existing store, never a second mutable session model. */
export function deriveGameFrameState<
  Command extends JsonValue,
  Answer extends JsonValue,
  View extends JsonValue,
>(
  state: ClientSessionState<Command, Answer, View>,
  sessionStatus: SessionStatus,
  readOnly = false,
): GameFrameState {
  const last = state.lastSubmission;
  const error =
    last?.outcome === 'error' || last?.outcome === 'unknown'
      ? last.error
      : last?.outcome === 'rejected'
        ? last.receipt.error
        : null;
  const submission = state.pendingSubmission
    ? state.pendingSubmission.phase
    : error?.code === 'STALE_REVISION' || error?.code === 'CONFLICT'
      ? 'conflict'
      : error
        ? 'error'
        : 'idle';
  return {
    key: `${state.route.gameId}:${state.route.sessionId}:${state.route.releaseId}:${state.identityKey ?? ''}`,
    phase: state.status,
    hasView: state.snapshot !== null,
    sessionStatus,
    submission,
    actionsDisabled:
      readOnly ||
      sessionStatus !== 'active' ||
      state.status !== 'ready' ||
      state.pendingSubmission !== null ||
      submission === 'conflict' ||
      submission === 'error',
    turn: state.snapshot?.turn ?? null,
    ...(state.snapshot?.actingSeatId === undefined
      ? {}
      : { actingSeatId: state.snapshot.actingSeatId }),
    ...(state.snapshot?.actionPrecondition === undefined
      ? {}
      : { actionPrecondition: state.snapshot.actionPrecondition }),
    ...(state.snapshot?.automationFailure === undefined
      ? {}
      : { automationFailure: state.snapshot.automationFailure }),
  };
}

export interface GameHistoryController {
  readonly permitted: boolean;
  readonly loading: boolean;
  readonly hasMore: boolean;
  readonly error: boolean;
  readonly window: 'latest' | 'history';
  readonly hasEarlier: boolean;
  readonly loadMore: () => void;
  readonly loadEarlier: () => void;
  readonly loadLatest: () => void;
}

/**
 * Derives history controls from the one platform event feed. The builder has
 * no mutable state; reads update the feed owned by PlatformGameProvider.
 */
export function deriveGameHistoryController<
  Command extends JsonValue,
  Answer extends JsonValue,
  View extends JsonValue,
>(
  state: ClientSessionState<Command, Answer, View>,
  events: PlatformEventFeedState,
  readEvents: GameHistoryReader,
): GameHistoryController {
  const read = (options: PlatformEventReadOptions): void => {
    void readEvents(options).catch(() => undefined);
  };
  return {
    permitted: state.snapshot !== null,
    loading: events.loading,
    hasMore: events.hasMore,
    error: events.error !== null,
    window: events.window,
    hasEarlier: (events.oldestSequence ?? 0) > 1,
    loadMore: () =>
      read(
        events.error && events.failedRead
          ? events.failedRead
          : {
              replace: events.window === 'history',
              window: events.window,
            },
      ),
    loadEarlier: () =>
      read({ afterSequence: 0, replace: true, window: 'history' }),
    loadLatest: () =>
      read({
        afterSequence: Math.max(
          0,
          (state.snapshot?.eventSequence ?? 0) - MAX_EVENT_READ_LIMIT,
        ),
        replace: true,
        window: 'latest',
      }),
  };
}

export interface GameFrameModel {
  readonly state: GameFrameState;
  readonly players: readonly PlatformPlayerSummary[];
  readonly history: GameHistoryController;
}

/**
 * Combines the existing session state, bounded event feed and game-owned
 * player projection into the shared frame model. It deliberately does not
 * inspect a game's view or action vocabulary.
 */
export function deriveGameFrameModel<
  Command extends JsonValue,
  Answer extends JsonValue,
  View extends JsonValue,
>({
  state,
  events,
  readEvents,
  sessionStatus,
  readOnly = false,
  players,
}: {
  readonly state: ClientSessionState<Command, Answer, View>;
  readonly events: PlatformEventFeedState;
  readonly readEvents: GameHistoryReader;
  readonly sessionStatus: SessionStatus;
  readonly readOnly?: boolean;
  readonly players: readonly PlatformPlayerSummary[];
}): GameFrameModel {
  return {
    state: deriveGameFrameState(state, sessionStatus, readOnly),
    players,
    history: deriveGameHistoryController(state, events, readEvents),
  };
}

export interface GameFramePresentation {
  readonly loading: ReactNode;
  readonly error: ReactNode;
  readonly reconnecting?: ReactNode;
  /** Render a translated generic notice; the diagnostic messageKey is never shown. */
  readonly automationFailure?: (failure: AutomationFailure) => ReactNode;
  readonly actionStatus?: (state: GameFrameState) => ReactNode;
  readonly historyControls?: (history: GameFrameModel['history']) => ReactNode;
}

interface GameFrameContextValue extends GameFrameModel {
  readonly presentation: GameFramePresentation;
}

const GameFrameContext = createContext<GameFrameContextValue | null>(null);

/**
 * Headless shared lifecycle shell. Games retain their own responsive layout;
 * slots consume this one projected model, including portal-rendered actions.
 */
export function GameFrame({
  model,
  presentation,
  children,
}: {
  readonly model: GameFrameModel;
  readonly presentation: GameFramePresentation;
  readonly children: ReactNode;
}): React.JSX.Element {
  const hasStaleViewError =
    model.state.hasView &&
    (model.state.phase === 'error' || model.state.phase === 'closed') &&
    model.state.submission === 'idle';
  const content =
    hasStaleViewError || !model.state.hasView
      ? model.state.phase === 'error' || model.state.phase === 'closed'
        ? presentation.error
        : presentation.loading
      : children;
  const automationFailure = model.state.automationFailure
    ? (presentation.automationFailure?.(model.state.automationFailure) ?? (
        <p role='status' data-testid='game-automation-failure'>
          Automation is temporarily unavailable for this seat.
        </p>
      ))
    : null;
  return (
    <GameFrameContext.Provider value={{ ...model, presentation }}>
      <FrameErrorBoundary key={model.state.key} fallback={presentation.error}>
        {automationFailure}
        {content}
        {model.state.hasView && model.state.phase === 'recovering'
          ? presentation.reconnecting
          : null}
      </FrameErrorBoundary>
    </GameFrameContext.Provider>
  );
}

class FrameErrorBoundary extends Component<
  { readonly children: ReactNode; readonly fallback: ReactNode },
  { readonly failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function useOptionalGameFrame(): GameFrameContextValue | null {
  return useContext(GameFrameContext);
}

export function usePlatformPlayer(
  principalId: string | null | undefined,
): PlatformPlayerSummary | null {
  const frame = useOptionalGameFrame();
  return (
    frame?.players.find((player) => player.principalId === principalId) ?? null
  );
}

/**
 * Slots are layout-neutral. Actions share a native disabled boundary and
 * history never renders content after authorization is lost. Legacy trees
 * without a GameFrame retain their existing behavior during drain.
 */
export function GameSlot({
  name,
  showHistoryControls = true,
  children,
}: {
  readonly name: GameSlotName;
  readonly showHistoryControls?: boolean;
  readonly children: ReactNode;
}): React.JSX.Element | null {
  const frame = useOptionalGameFrame();
  if (!frame) return <>{children}</>;
  if (name === 'history' && !frame.history.permitted) return null;
  if (name === 'actions') {
    const stopDisabledAction = (event: SyntheticEvent): void => {
      if (!frame.state.actionsDisabled) return;
      event.preventDefault();
      event.stopPropagation();
    };
    return (
      <>
        {frame.presentation.actionStatus?.(frame.state)}
        <fieldset
          data-platform-slot={name}
          data-state={frame.state.submission}
          disabled={frame.state.actionsDisabled}
          aria-busy={frame.state.submission === 'sending'}
          onClickCapture={stopDisabledAction}
          onSubmitCapture={stopDisabledAction}
          style={{ display: 'contents' }}
        >
          {children}
        </fieldset>
      </>
    );
  }
  return (
    <>
      {children}
      {name === 'history' && showHistoryControls
        ? frame.presentation.historyControls?.(frame.history)
        : null}
    </>
  );
}

/** Standard player identity/seat/attention with a game-owned resource area. */
export function PlatformPlayer({
  principalId,
  children,
}: {
  readonly principalId: string;
  readonly children: (player: PlatformPlayerSummary | null) => ReactNode;
}): React.JSX.Element {
  const player = usePlatformPlayer(principalId);
  return <>{children(player)}</>;
}

/** Shared terminal container also works on a separately loaded result route. */
export function GameResult({
  status,
  loading,
  error,
  children,
}: {
  readonly status: 'loading' | 'ready' | 'error';
  readonly loading: ReactNode;
  readonly error: ReactNode;
  readonly children: ReactNode;
}): React.JSX.Element {
  return (
    <GameSlot name='result'>
      {status === 'loading' ? loading : status === 'error' ? error : children}
    </GameSlot>
  );
}
