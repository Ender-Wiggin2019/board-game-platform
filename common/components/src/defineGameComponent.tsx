import type {
  ApplyViewDelta,
  ClientSessionTransport,
  GameEntryRuntime,
  GameViewer,
} from '@board-game/client';
import type {
  JsonValue,
  PlayerViewEnvelope,
  ProjectedEvent,
  SessionRoute,
  SessionStatus,
} from '@board-game/contracts';
import {
  type ComponentType,
  createElement,
  type ReactNode,
  useMemo,
} from 'react';
import type {
  GameEndEntryProps,
  GameLiveEntryProps,
  GameReplayEntryProps,
} from './GameClientRegistration.js';
import {
  deriveGameFrameModel,
  GameFrame,
  type GameFrameModel,
} from './GameFrame.js';
import type { GameSeatHandoffLabels } from './GameSeatHandoff.js';
import { GameSeatHandoff } from './GameSeatHandoff.js';
import {
  type GameSessionContextValue,
  GameSessionProvider,
  useGameSession,
} from './GameSessionProvider.js';

export type GameComponentMode = 'live' | 'replay' | 'end';

export type GameComponentEntryProps<Mode extends GameComponentMode> =
  Mode extends 'live'
    ? GameLiveEntryProps
    : Mode extends 'replay'
      ? GameReplayEntryProps
      : GameEndEntryProps;

export interface GameEntryContext<Mode extends GameComponentMode> {
  readonly mode: Mode;
  readonly route: SessionRoute;
  readonly runtime: GameEntryRuntime;
  readonly status: SessionStatus;
  readonly spectate: boolean;
  readonly controlledPlayerId?: string;
  readonly readOnly: boolean;
  readonly seatHandoffLabels?: Partial<GameSeatHandoffLabels>;
}

export interface GameSessionProjectContext<
  View extends JsonValue = JsonValue,
  Mode extends GameComponentMode = GameComponentMode,
> {
  readonly snapshot: PlayerViewEnvelope<View> | null;
  readonly events: readonly ProjectedEvent[];
  readonly route: SessionRoute;
  readonly viewer: GameViewer;
  readonly entry: GameEntryContext<Mode>;
}

export interface GameFrameProjectionContext<
  Mode extends GameComponentMode,
  Model,
  Command extends JsonValue,
  Query extends JsonValue,
  Answer extends JsonValue,
  View extends JsonValue,
> {
  readonly entry: GameEntryContext<Mode>;
  readonly model: Model | undefined;
  readonly session: GameSessionContextValue<Command, Query, Answer, View>;
}

export interface GameFrameProjection<Model> {
  readonly sessionStatus: SessionStatus;
  readonly readOnly?: boolean;
  readonly players: GameFrameModel['players'];
  readonly model?: Model;
}

export interface GameFramePresentationProps<
  Model,
  Command extends JsonValue = JsonValue,
  Query extends JsonValue = JsonValue,
  Answer extends JsonValue = JsonValue,
  View extends JsonValue = JsonValue,
> extends GameFramePresentationPropsBase {
  readonly entry: GameEntryContext<GameComponentMode>;
  readonly session: GameSessionContextValue<Command, Query, Answer, View>;
  readonly model: Model | undefined;
}

interface GameFramePresentationPropsBase {
  readonly slot: 'loading' | 'error' | 'reconnecting' | 'action' | 'history';
  readonly state?: GameFrameModel['state'];
  readonly history?: GameFrameModel['history'];
}

export interface GameSessionComponentConfig<
  Command extends JsonValue,
  Query extends JsonValue,
  Answer extends JsonValue,
  View extends JsonValue,
> {
  readonly createTransport?: (context: {
    readonly route: SessionRoute;
    readonly runtime: GameEntryRuntime;
  }) => ClientSessionTransport<Command, Query, Answer, View>;
  readonly applyDelta?: ApplyViewDelta<View>;
  readonly identityKey?: (context: {
    readonly entry: GameEntryContext<GameComponentMode>;
    readonly runtime: GameEntryRuntime;
  }) => string | null | undefined;
  readonly loadOnMount?: boolean;
}

export interface GameComponentConfig<
  Mode extends GameComponentMode,
  Command extends JsonValue,
  Query extends JsonValue,
  Answer extends JsonValue,
  View extends JsonValue,
  Model,
> {
  readonly mode: Mode;
  /** Omit for a route that renders directly from the injected runtime. */
  readonly session?: GameSessionComponentConfig<Command, Query, Answer, View>;
  readonly project?: (
    context: GameSessionProjectContext<View, Mode>,
  ) => Model | undefined;
  readonly frame?: {
    readonly project: (
      context: GameFrameProjectionContext<
        Mode,
        Model,
        Command,
        Query,
        Answer,
        View
      >,
    ) => GameFrameProjection<Model>;
    readonly Presentation: ComponentType<
      GameFramePresentationProps<Model, Command, Query, Answer, View>
    >;
  };
  readonly providers?: ComponentType<{
    readonly children: ReactNode;
    readonly entry: GameEntryContext<Mode>;
    readonly session: GameSessionContextValue<
      Command,
      Query,
      Answer,
      View
    > | null;
  }>;
  readonly render: (context: {
    readonly entry: GameEntryContext<Mode>;
    readonly runtime: GameEntryRuntime;
    readonly session: GameSessionContextValue<
      Command,
      Query,
      Answer,
      View
    > | null;
    readonly model: Model | undefined;
    readonly frame: GameFrameModel | null;
  }) => ReactNode;
}

function getEntryContext<Mode extends GameComponentMode>(
  mode: Mode,
  props: GameComponentEntryProps<Mode>,
): GameEntryContext<Mode> {
  const liveProps = props as GameLiveEntryProps;
  return {
    mode,
    route: props.route,
    runtime: props.runtime,
    status: mode === 'live' ? liveProps.status : 'completed',
    spectate: mode === 'live' ? liveProps.spectate : true,
    ...(mode === 'live'
      ? { controlledPlayerId: liveProps.controlledPlayerId }
      : {}),
    readOnly: mode !== 'live' || liveProps.spectate === true,
    seatHandoffLabels: props.seatHandoffLabels,
  };
}

const SESSION_ROUTE_KEYS: readonly (keyof SessionRoute)[] = [
  'gameId',
  'modeId',
  'sessionId',
  'releaseId',
  'backendBindingId',
  'storageBindingId',
  'ownershipEpoch',
];

function sessionRouteKey(route: SessionRoute): string {
  return SESSION_ROUTE_KEYS.map(
    (key) => `${String(key)}:${String(route[key])}`,
  ).join('|');
}

function FramePresentation<
  Model,
  Command extends JsonValue,
  Query extends JsonValue,
  Answer extends JsonValue,
  View extends JsonValue,
>({
  Presentation,
  slot,
  state,
  history,
  entry,
  session,
  model,
}: {
  readonly Presentation: ComponentType<
    GameFramePresentationProps<Model, Command, Query, Answer, View>
  >;
  readonly slot: GameFramePresentationPropsBase['slot'];
  readonly state?: GameFrameModel['state'];
  readonly history?: GameFrameModel['history'];
  readonly entry: GameEntryContext<GameComponentMode>;
  readonly session: GameSessionContextValue<Command, Query, Answer, View>;
  readonly model: Model | undefined;
}): React.JSX.Element {
  return (
    <Presentation
      slot={slot}
      state={state}
      history={history}
      entry={entry}
      session={session}
      model={model}
    />
  );
}

export function defineGameComponent<
  Mode extends GameComponentMode,
  Command extends JsonValue = JsonValue,
  Query extends JsonValue = JsonValue,
  Answer extends JsonValue = JsonValue,
  View extends JsonValue = JsonValue,
  Model = View,
>(
  config: GameComponentConfig<Mode, Command, Query, Answer, View, Model>,
): ComponentType<GameComponentEntryProps<Mode>> {
  function SessionlessEntry(
    props: GameComponentEntryProps<Mode>,
  ): React.JSX.Element {
    const entry = getEntryContext(config.mode, props);
    const content = config.render({
      entry,
      runtime: props.runtime,
      session: null,
      model: undefined,
      frame: null,
    });
    const Providers = config.providers;
    return Providers ? (
      <Providers entry={entry} session={null}>
        {content}
      </Providers>
    ) : (
      <>{content}</>
    );
  }

  function SessionEntry(
    props: GameComponentEntryProps<Mode>,
  ): React.JSX.Element {
    const entry = getEntryContext(config.mode, props);
    const sessionConfig = config.session;
    const routeKey = sessionRouteKey(entry.route);
    const customCreateTransport = sessionConfig?.createTransport;
    const hostCreateTransport = entry.runtime.session.createTransport;
    const selectedSeatId = entry.runtime.session.selectedSeatId;
    const transport = useMemo(() => {
      if (customCreateTransport) {
        return customCreateTransport({
          route: entry.route,
          runtime: entry.runtime,
        });
      }
      return hostCreateTransport<Command, Query, Answer, View>(
        entry.route,
        selectedSeatId,
      );
    }, [customCreateTransport, hostCreateTransport, routeKey, selectedSeatId]);
    const identityKey = sessionConfig?.identityKey?.({
      entry,
      runtime: entry.runtime,
    });
    const scopedIdentityKey = `${identityKey ?? entry.runtime.viewer.identityKey ?? ''}:seat:${selectedSeatId ?? ''}`;
    return (
      <GameSessionProvider
        route={entry.route}
        transport={transport}
        identityKey={scopedIdentityKey}
        signals={entry.runtime.session.signals}
        applyDelta={sessionConfig?.applyDelta}
        loadOnMount={sessionConfig?.loadOnMount}
      >
        <BoundSessionEntry config={config} entry={entry} />
      </GameSessionProvider>
    );
  }

  function BoundSessionEntry({
    config: boundConfig,
    entry,
  }: {
    readonly config: GameComponentConfig<
      Mode,
      Command,
      Query,
      Answer,
      View,
      Model
    >;
    readonly entry: GameEntryContext<Mode>;
  }): React.JSX.Element {
    const session = useGameSession<Command, Query, Answer, View>();
    const controlledSeats = session.state.snapshot?.controlledSeats;
    const selectedSeatId = entry.runtime.session.selectedSeatId;
    const effectiveSeatId =
      selectedSeatId ??
      (controlledSeats?.length === 1 ? controlledSeats[0]?.seatId : undefined);
    const selectedParticipant = controlledSeats?.find(
      (participant) => participant.seatId === effectiveSeatId,
    );
    const effectiveEntry = useMemo<GameEntryContext<Mode>>(() => {
      const accountPrincipalId =
        entry.runtime.viewer.accountPrincipalId ??
        entry.runtime.viewer.principalId;
      return {
        ...entry,
        runtime: {
          ...entry.runtime,
          viewer: {
            ...entry.runtime.viewer,
            accountPrincipalId,
            principalId:
              selectedParticipant?.principalId ??
              entry.runtime.viewer.principalId,
            seatId: effectiveSeatId,
          },
        },
      };
    }, [entry, effectiveSeatId, selectedParticipant]);
    const model = useMemo(
      () =>
        boundConfig.project?.({
          snapshot: session.state.snapshot,
          events: session.events.events,
          route: session.route,
          viewer: effectiveEntry.runtime.viewer,
          entry: effectiveEntry,
        }),
      [
        boundConfig,
        effectiveEntry,
        session.events.events,
        session.route,
        session.state.snapshot,
      ],
    );
    const projection = boundConfig.frame?.project({
      entry: effectiveEntry,
      model,
      session,
    });
    const frameModel = projection
      ? deriveGameFrameModel({
          state: session.state,
          events: session.events,
          readEvents: session.readEvents,
          sessionStatus: projection.sessionStatus,
          readOnly: projection.readOnly ?? entry.readOnly,
          players: projection.players,
        })
      : null;
    const content = boundConfig.render({
      entry: effectiveEntry,
      runtime: effectiveEntry.runtime,
      session,
      model: projection?.model ?? model,
      frame: frameModel,
    });
    const Providers = boundConfig.providers;
    const frameConfig = boundConfig.frame;
    const framed =
      frameModel && frameConfig ? (
        <GameFrame
          model={frameModel}
          presentation={{
            loading: (
              <FramePresentation
                Presentation={frameConfig.Presentation}
                slot='loading'
                entry={effectiveEntry}
                session={session}
                model={model}
              />
            ),
            error: (
              <FramePresentation
                Presentation={frameConfig.Presentation}
                slot='error'
                entry={effectiveEntry}
                session={session}
                model={model}
              />
            ),
            reconnecting: (
              <FramePresentation
                Presentation={frameConfig.Presentation}
                slot='reconnecting'
                entry={effectiveEntry}
                session={session}
                model={model}
              />
            ),
            actionStatus: (state) => (
              <FramePresentation
                Presentation={frameConfig.Presentation}
                slot='action'
                state={state}
                entry={effectiveEntry}
                session={session}
                model={model}
              />
            ),
            historyControls: (history) => (
              <FramePresentation
                Presentation={frameConfig.Presentation}
                slot='history'
                history={history}
                entry={effectiveEntry}
                session={session}
                model={model}
              />
            ),
          }}
        >
          {content}
        </GameFrame>
      ) : (
        <>{content}</>
      );
    const handedOff = (
      <GameSeatHandoff
        controlledSeats={controlledSeats}
        selectedSeatId={selectedSeatId}
        loading={
          selectedSeatId !== undefined && session.state.snapshot === null
        }
        submissionUnknown={session.state.pendingSubmission?.phase === 'unknown'}
        onSelectSeat={entry.runtime.session.selectSeat}
        labels={entry.seatHandoffLabels}
      >
        {framed}
      </GameSeatHandoff>
    );
    return Providers ? (
      <Providers entry={effectiveEntry} session={session}>
        {handedOff}
      </Providers>
    ) : (
      handedOff
    );
  }

  // Mode is a generic conditional type here. React's JSX overload cannot
  // prove that the distributed props union matches the component's mode, but
  // both functions are created from the same config and receive that exact
  // props shape at runtime.
  type AnyGameComponentEntryProps = GameComponentEntryProps<GameComponentMode>;
  const SessionEntryComponent =
    SessionEntry as unknown as ComponentType<AnyGameComponentEntryProps>;
  const SessionlessEntryComponent =
    SessionlessEntry as unknown as ComponentType<AnyGameComponentEntryProps>;
  const DefinedComponent = (props: GameComponentEntryProps<Mode>) =>
    config.session
      ? createElement(SessionEntryComponent, props)
      : createElement(SessionlessEntryComponent, props);
  DefinedComponent.displayName = `GameComponent(${config.mode})`;
  return DefinedComponent;
}
