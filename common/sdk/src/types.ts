import type {
  Actor,
  GameResult,
  GameSchemas,
  JsonValue,
  ModeDefinition,
  Participant,
  TurnState,
  Viewer,
} from '@board-game/contracts';

export type {
  Actor,
  GameSchemas,
  JsonValue,
  ModeDefinition,
  Participant,
  SchemaDescriptor,
  Viewer,
} from '@board-game/contracts';

export interface RuleError {
  readonly code: string;
  readonly messageKey: string;
  readonly details?: JsonValue;
}

export type Transition<S, Event> =
  | {
      readonly ok: true;
      readonly state: S;
      readonly events: readonly Event[];
      /**
       * Optional service-transition roster projection. Host accepts this only
       * for authenticated system commands and preserves each participant's
       * principal, seat, and team identity.
       */
      readonly publicParticipants?: readonly Participant[];
    }
  | { readonly ok: false; readonly error: RuleError };

export interface CreateContext {
  readonly sessionId: string;
  readonly modeId: string;
  readonly seed: string;
  readonly participants: readonly Actor[];
  /** Host clock for persisted initial deadlines; pure/offline callers may use zero. */
  readonly logicalTime?: number;
}

export interface ExecuteContext {
  readonly actor: Actor;
  readonly logicalTime: number;
}

export interface GameRules<
  S,
  Setup extends JsonValue,
  Command extends JsonValue,
  View extends JsonValue,
  Event,
  Query extends JsonValue,
  Answer extends JsonValue,
> {
  readonly create: (setup: Setup, context: CreateContext) => S;
  /** Runs once on initial activation, so clocks exclude admission preparation time. */
  readonly activate?: (
    state: Readonly<S>,
    context: { readonly logicalTime: number },
  ) => S;
  readonly execute: (
    state: Readonly<S>,
    command: Command,
    context: ExecuteContext,
  ) => Transition<S, Event>;
  readonly project: (state: Readonly<S>, viewer: Viewer) => View;
  readonly projectEvent: (event: Event, viewer: Viewer) => JsonValue | null;
  readonly query?: (state: Readonly<S>, query: Query, viewer: Viewer) => Answer;
  readonly encode: (state: Readonly<S>) => JsonValue;
  readonly decode: (saved: JsonValue, schemaVersion: number) => S;
}

export interface InputOpportunity {
  readonly promptId: string;
  readonly participantInputRevision: number;
}

export interface CompletionInfo {
  readonly finished: boolean;
  /** A rule-approved terminal cancellation without a scored result. Mutually exclusive with finished. */
  readonly cancelled?: boolean;
  readonly progress?: JsonValue;
}

/** One server-side consumable required before a command can execute. */
export interface CommandResourceRequirement {
  readonly namespace: string;
  readonly asset: string;
  readonly quantity: number;
}

/** A durable, server-derived deadline for one system command generation. */
export interface SystemSchedule<SystemCommand extends JsonValue = JsonValue> {
  /** Game-owned IDs must not use the platform-reserved `automation:` prefix. */
  readonly deadlineId: string;
  readonly dueAt: number;
  readonly command: SystemCommand;
}

export interface SystemExecuteContext {
  readonly actor: Actor;
  readonly logicalTime: number;
  readonly deadlineId?: string;
  /** Frozen admission roster; system transitions may only update profiles. */
  readonly participants: readonly Participant[];
}

export interface GameModule<
  S,
  Setup extends JsonValue,
  Command extends JsonValue,
  View extends JsonValue,
  Event,
  Query extends JsonValue,
  Answer extends JsonValue,
  SystemCommand extends JsonValue = JsonValue,
> {
  readonly gameId: string;
  readonly releaseId: string;
  readonly stateSchemaVersion: number;
  readonly viewSchemaVersion: number;
  readonly modes: readonly ModeDefinition[];
  readonly schemas: GameSchemas;
  readonly rules: GameRules<S, Setup, Command, View, Event, Query, Answer>;
  /** Current rule opportunities, independent of controller and transport concurrency. */
  readonly turn?: (
    state: Readonly<S>,
    context: { readonly participants: readonly Participant[] },
  ) => TurnState | null;
  /** Optional safe planning projection; must not reveal opponents' private information. */
  readonly projectAutomationView?: (
    state: Readonly<S>,
    viewer: Viewer,
  ) => JsonValue;
  readonly summarize: (state: Readonly<S>) => JsonValue;
  /** Authoritative final order/outcome. Required for modes with platform rating. */
  readonly result?: (state: Readonly<S>) => GameResult;
  readonly collectFacts: (
    before: Readonly<S>,
    transition: Transition<S, Event>,
  ) => readonly JsonValue[];
  /** Optional setup event log for modes that retain private event history. */
  readonly initialEvents?: (state: Readonly<S>) => readonly Event[];
  readonly inputOpportunity?: (
    state: Readonly<S>,
    actor: Actor,
  ) => InputOpportunity | null;
  /** Pure requirement calculation; the Host supplies the authoritative actor. */
  readonly commandResourceRequirement?: (
    state: Readonly<S>,
    command: Command,
    actor: Actor,
  ) => CommandResourceRequirement | null;
  /** Optional authenticated service command hook; never called for player input. */
  readonly executeSystem?: (
    state: Readonly<S>,
    command: SystemCommand,
    context: SystemExecuteContext,
  ) => Transition<S, Event>;
  /** Optional pure deadline derivation. The Host persists only deadlineId/dueAt. */
  readonly systemSchedule?: (
    state: Readonly<S>,
    context: { readonly logicalTime: number },
  ) => SystemSchedule<SystemCommand> | null;
  readonly completion: (state: Readonly<S>) => CompletionInfo;
}
