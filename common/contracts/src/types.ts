import type {
  DailyChallengeServiceRequest,
  DailyChallengeServiceResponse,
} from './daily.js';
import type {
  DeveloperConsoleCatalogRequest,
  DeveloperConsoleCatalogResponse,
  SubmitDeveloperCommandRequest,
  SubmitDeveloperCommandResponse,
} from './developer-console.js';
import type { ErrorEnvelope } from './errors.js';
import type { JsonValue } from './json.js';
import type { GameServiceDescription } from './runtime.js';
import type { SchemaDescriptor } from './schema.js';
import type {
  GameStatisticsServiceRequest,
  GameStatisticsServiceResponse,
} from './statistics.js';
import type { AutomationFailure, TurnView } from './turns.js';

export type GameId = string;
export type ModeId = string;
export type SessionId = string;
export type ReleaseId = string;
export type BackendBindingId = string;
export type StorageBindingId = string;
export type OwnershipEpoch = string;
export type StartId = string;
export type AdmissionId = string;
export type CommandId = string;
export type ResultRevision = number;
export type StreamCursor = string;
export type ViewEpoch = string;

export type ModeEntry = 'room' | 'direct-solo';
export type HistoryPolicy =
  | 'summary-and-replay'
  | 'progress-only'
  | 'ephemeral-result';
export type SessionStatus =
  | 'suspended'
  | 'active'
  | 'completed'
  | 'cancelled'
  | 'paused';
export type ModeConcurrency = 'revision' | 'prompt';
export type ProtocolVersion = 1;
export type ParticipantController =
  | 'human'
  | 'hotseat'
  | 'ai'
  | 'automa'
  /** Retained releases may still own legacy bot participants. */
  | 'bot';

export interface ProtocolRequest {
  readonly protocolVersion: ProtocolVersion;
}

/** Trusted context injected by the platform server; browser payloads cannot supply it. */
export interface AccessContext {
  readonly principalId: string;
  readonly scopes: readonly string[];
  readonly authEpoch: string;
  /** A selected seat verified against the frozen admission by the gateway. */
  readonly seatId?: string;
}

/** Safe public account data frozen into a session at admission time. */
export interface PublicPlayerProfile {
  readonly displayName?: string;
  readonly appearance?: JsonValue;
  readonly gameProfile?: JsonValue;
}

export interface Actor {
  readonly principalId: string;
  readonly seatId?: string;
  readonly kind: 'player' | 'system';
  /** Missing values are legacy human participants. */
  readonly controller?: ParticipantController;
  readonly controlledBy?: string;
  readonly controllerId?: string;
  readonly controllerOptions?: JsonValue;
  readonly publicProfile?: PublicPlayerProfile;
}

/** A viewer is derived by Host authorization, never accepted from a client payload. */
export interface Viewer {
  readonly principalId?: string;
  readonly seatId?: string;
  readonly audience: string;
  readonly epoch: ViewEpoch;
  /** Server-derived access scopes used by game-specific visibility gates. */
  readonly scopes?: readonly string[];
}

export interface Participant {
  readonly principalId: string;
  readonly seatId: string;
  readonly teamId?: string;
  /** Missing values are legacy human participants. */
  readonly controller?: ParticipantController;
  /** Account controlling a synthetic hotseat participant. */
  readonly controlledBy?: string;
  /** Release-scoped server automation policy, required for AI and automa. */
  readonly controllerId?: string;
  readonly controllerOptions?: JsonValue;
  readonly publicProfile?: PublicPlayerProfile;
}

/** The seven values that pin a session to its game, release, host and storage. */
export interface SessionRoute {
  readonly gameId: GameId;
  readonly modeId: ModeId;
  readonly sessionId: SessionId;
  readonly releaseId: ReleaseId;
  readonly backendBindingId: BackendBindingId;
  readonly storageBindingId: StorageBindingId;
  readonly ownershipEpoch: OwnershipEpoch;
}

export interface ModeDefinition {
  readonly id: ModeId;
  readonly entry: ModeEntry;
  readonly minPlayers: number;
  readonly maxPlayers: number;
  readonly history: HistoryPolicy;
  readonly platformRating: boolean;
  readonly concurrency: ModeConcurrency;
}

export interface ProtocolCapabilities {
  readonly protocolMajor: number;
  readonly protocolMinor: number;
  readonly features: readonly string[];
}

export interface BackendDescription extends ProtocolCapabilities {
  readonly gameIds: readonly GameId[];
  readonly releaseIds: readonly ReleaseId[];
  readonly modes: readonly ModeDefinition[];
  readonly storageBindingIds: readonly StorageBindingId[];
  /** Present when runtime-description-v1 is advertised by an independent service. */
  readonly service?: GameServiceDescription;
}

export type DescribeRequest = ProtocolRequest;
export type ReadyRequest = ProtocolRequest;

export interface ReadyResponse {
  readonly ready: boolean;
  readonly description: BackendDescription;
  readonly reason?: string;
}

export interface CreateSessionRequest<Setup extends JsonValue = JsonValue>
  extends ProtocolRequest {
  readonly accessContext: AccessContext;
  readonly route: SessionRoute;
  readonly startId: StartId;
  readonly startGeneration: number;
  readonly setup: Setup;
  readonly participants: readonly Participant[];
  readonly seed: string;
}

export interface CreateSessionResponse {
  readonly sessionId: SessionId;
  readonly startId: StartId;
  readonly status: SessionStatus;
  readonly route: SessionRoute;
  readonly creationReceiptId: string;
}

export interface ActivateSessionRequest extends ProtocolRequest {
  readonly accessContext: AccessContext;
  readonly route: SessionRoute;
  readonly startId: StartId;
}

export interface ActivateSessionResponse {
  readonly sessionId: SessionId;
  readonly startId: StartId;
  readonly status: 'active';
  readonly activatedAt: number;
}

export interface GetStatusRequest extends ProtocolRequest {
  readonly accessContext: AccessContext;
  readonly route: SessionRoute;
  readonly startId?: StartId;
  readonly commandId?: CommandId;
}

export interface OperationStatus {
  readonly kind: 'start' | 'command' | 'activation';
  readonly status:
    | 'unknown'
    | 'pending'
    | 'accepted'
    | 'rejected'
    | 'active'
    | 'completed'
    | 'cancelled';
  readonly startId?: StartId;
  readonly commandId?: CommandId;
  readonly sessionId?: SessionId;
  readonly error?: ErrorEnvelope;
}

export type CommandPrecondition =
  | { readonly kind: 'revision'; readonly expectedRevision: number }
  | {
      readonly kind: 'prompt';
      readonly promptId: string;
      readonly participantInputRevision: number;
    };

export interface SubmitCommandRequest<Command extends JsonValue = JsonValue>
  extends ProtocolRequest {
  readonly accessContext: AccessContext;
  readonly route: SessionRoute;
  readonly commandId: CommandId;
  readonly precondition: CommandPrecondition;
  readonly command: Command;
}

/**
 * A server-to-host command authenticated with a service scope. This contract
 * is intentionally separate from SubmitCommandRequest so a browser command
 * cannot be upgraded into a system action by changing an actor field.
 */
export interface SubmitSystemCommandRequest<
  SystemCommand extends JsonValue = JsonValue,
> extends ProtocolRequest {
  readonly accessContext: AccessContext;
  readonly route: SessionRoute;
  readonly commandId: CommandId;
  readonly expectedRevision: number;
  readonly command: SystemCommand;
  /** Present for a scheduler-triggered command; absent for an authenticated service action. */
  readonly deadlineId?: string;
}

export interface SubmitSystemCommandResponse {
  readonly receipt: SafeCommandReceipt;
}

export type CommandReceiptStatus =
  | 'accepted'
  | 'rejected'
  | 'duplicate'
  | 'unknown';
export type ResultRetention = 'replayable' | 'ephemeral-result';

/** Safe retry metadata. It intentionally contains no command, result or private view payload. */
export interface SafeCommandReceipt {
  readonly commandId: CommandId;
  readonly sessionId: SessionId;
  readonly status: CommandReceiptStatus;
  readonly persistedRevision?: number;
  readonly persistedAt?: number;
  readonly resultRetention: ResultRetention;
  readonly error?: ErrorEnvelope;
}

export interface SubmitCommandResponse<View extends JsonValue = JsonValue> {
  readonly receipt: SafeCommandReceipt;
  readonly view?: PlayerViewEnvelope<View>;
}

export type ViewPayloadKind = 'snapshot' | 'section-replacement' | 'patch';

export interface PlayerViewEnvelope<View extends JsonValue = JsonValue> {
  readonly gameId: GameId;
  readonly sessionId: SessionId;
  readonly releaseId: ReleaseId;
  readonly viewSchemaVersion: number;
  readonly audienceKey: string;
  readonly viewEpoch: ViewEpoch;
  readonly baseRevision: number;
  readonly revision: number;
  /** Latest committed event sequence, used to bootstrap bounded history reads. */
  readonly eventSequence?: number;
  readonly streamCursor: StreamCursor;
  readonly kind: ViewPayloadKind;
  readonly payload: View;
  readonly turn?: TurnView | null;
  readonly actingSeatId?: string;
  readonly actionPrecondition?: CommandPrecondition;
  /** Safe diagnostic metadata; never contains a command, result, or private view. */
  readonly automationFailure?: AutomationFailure;
  /** Only seats the authenticated account may select; never other private views. */
  readonly controlledSeats?: readonly Participant[];
}

export interface GetPlayerViewRequest extends ProtocolRequest {
  readonly accessContext: AccessContext;
  readonly route: SessionRoute;
}

/** A bounded, viewer-projected read from the session event stream. */
export interface GetEventsRequest extends ProtocolRequest {
  readonly accessContext: AccessContext;
  readonly route: SessionRoute;
  /** Last event sequence already applied by the caller. */
  readonly afterSequence: number;
  /** Maximum number of raw records to scan in this page. */
  readonly limit: number;
  /** Optional audience epoch the caller is continuing from. */
  readonly viewEpoch?: ViewEpoch;
}

export interface ProjectedEvent {
  readonly sequence: number;
  readonly eventId: string;
  readonly payload: JsonValue;
  /** Safe source marker; it never identifies a policy or exposes private input. */
  readonly source?: EventSource;
}

export interface EventSource {
  readonly kind: 'human' | 'ai' | 'automa' | 'system';
  readonly seatId?: string;
  /** Opaque private-trace reference; it carries no state or policy data. */
  readonly traceId?: string;
}

export interface GetEventsResponse {
  readonly gameId: GameId;
  readonly sessionId: SessionId;
  readonly releaseId: ReleaseId;
  readonly audienceKey: string;
  readonly viewEpoch: ViewEpoch;
  /** Cursor through the raw records scanned for this page. */
  readonly nextSequence: number;
  readonly hasMore: boolean;
  readonly events: readonly ProjectedEvent[];
  /** True when the requested audience epoch cannot safely continue. */
  readonly resetRequired: boolean;
}

export interface ResumeRequest extends ProtocolRequest {
  readonly accessContext: AccessContext;
  readonly route: SessionRoute;
  readonly viewerEpoch?: ViewEpoch;
  readonly streamCursor?: StreamCursor;
}

export type ResumeResult<View extends JsonValue = JsonValue> =
  | { readonly kind: 'snapshot'; readonly view: PlayerViewEnvelope<View> }
  | { readonly kind: 'delta'; readonly view: PlayerViewEnvelope<View> }
  | {
      readonly kind: 'resync-required';
      readonly reason: 'cursor-expired' | 'audience-changed' | 'base-mismatch';
      readonly view: PlayerViewEnvelope<View>;
    };

export interface QueryOptionsRequest<Query extends JsonValue = JsonValue>
  extends ProtocolRequest {
  readonly accessContext: AccessContext;
  readonly route: SessionRoute;
  readonly revision: number;
  readonly query: Query;
}

export interface QueryOptionsResponse<Answer extends JsonValue = JsonValue> {
  readonly route: SessionRoute;
  readonly revision: number;
  readonly answer: Answer;
}

export interface SessionSummary {
  readonly route: SessionRoute;
  readonly status: SessionStatus;
  readonly sourceRevision: number;
  /** Latest committed event sequence, for bounded diagnostic/history reads. */
  readonly eventSequence?: number;
  readonly updatedAt: number;
  readonly summary: JsonValue;
  /** Whether the Host still retains state needed for replay, never the state itself. */
  readonly historyAvailable?: boolean;
}

export interface GetSessionSummaryRequest extends ProtocolRequest {
  readonly accessContext: AccessContext;
  readonly route: SessionRoute;
}

/** Internal retention operation, unavailable through public session gateways. */
export interface RetireSessionHistoryRequest extends GetSessionSummaryRequest {
  readonly expectedRevision: number;
}

export type ControlAction = 'pause' | 'resume' | 'cancel';

export interface ControlSessionRequest extends ProtocolRequest {
  readonly accessContext: AccessContext;
  readonly route: SessionRoute;
  readonly commandId: CommandId;
  readonly expectedRevision: number;
  readonly action: ControlAction;
}

export interface ControlSessionResponse {
  readonly route: SessionRoute;
  readonly status: SessionStatus;
  readonly receipt: SafeCommandReceipt;
}

export interface GameSchemas {
  readonly setup: SchemaDescriptor;
  readonly command: SchemaDescriptor;
  readonly systemCommand?: SchemaDescriptor;
  readonly query?: SchemaDescriptor;
  readonly result?: SchemaDescriptor;
}

export interface BackendPort<
  Setup extends JsonValue = JsonValue,
  Command extends JsonValue = JsonValue,
  Query extends JsonValue = JsonValue,
  Answer extends JsonValue = JsonValue,
  View extends JsonValue = JsonValue,
> {
  readonly describe: (request: DescribeRequest) => Promise<BackendDescription>;
  readonly ready: (request: ReadyRequest) => Promise<ReadyResponse>;
  readonly createSession: (
    request: CreateSessionRequest<Setup>,
  ) => Promise<CreateSessionResponse>;
  readonly activateSession: (
    request: ActivateSessionRequest,
  ) => Promise<ActivateSessionResponse>;
  readonly getStatus: (request: GetStatusRequest) => Promise<OperationStatus>;
  readonly submitCommand: (
    request: SubmitCommandRequest<Command>,
  ) => Promise<SubmitCommandResponse<View>>;
  /** Internal service operation; public session gateways must not expose it. */
  readonly submitSystemCommand: (
    request: SubmitSystemCommandRequest,
  ) => Promise<SubmitSystemCommandResponse>;
  /** Optional operator-only developer metadata operation. */
  readonly getDeveloperConsole?: (
    request: DeveloperConsoleCatalogRequest,
  ) => Promise<DeveloperConsoleCatalogResponse>;
  /** Optional operator-only developer mutation operation. */
  readonly submitDeveloperCommand?: (
    request: SubmitDeveloperCommandRequest,
  ) => Promise<SubmitDeveloperCommandResponse>;
  readonly queryOptions: (
    request: QueryOptionsRequest<Query>,
  ) => Promise<QueryOptionsResponse<Answer>>;
  readonly getPlayerView: (
    request: GetPlayerViewRequest,
  ) => Promise<PlayerViewEnvelope<View>>;
  readonly getEvents: (request: GetEventsRequest) => Promise<GetEventsResponse>;
  readonly resume: (request: ResumeRequest) => Promise<ResumeResult<View>>;
  readonly getSessionSummary: (
    request: GetSessionSummaryRequest,
  ) => Promise<SessionSummary>;
  readonly controlSession: (
    request: ControlSessionRequest,
  ) => Promise<ControlSessionResponse>;
  /** Optional authenticated game-owned daily capability RPC. */
  readonly dailyChallenge?: (
    request: DailyChallengeServiceRequest,
  ) => Promise<DailyChallengeServiceResponse>;
  /** Optional authenticated game-owned statistics capability RPC. */
  readonly statistics?: (
    request: GameStatisticsServiceRequest,
  ) => Promise<GameStatisticsServiceResponse>;
  /** Optional for retained older backends; callers fail closed when unsupported. */
  readonly retireSessionHistory?: (
    request: RetireSessionHistoryRequest,
  ) => Promise<SessionSummary>;
}

export function isCommandPrecondition(
  value: unknown,
): value is CommandPrecondition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === 'revision') {
    const keys = Object.keys(candidate).sort();
    return (
      keys.length === 2 &&
      keys[0] === 'expectedRevision' &&
      keys[1] === 'kind' &&
      typeof candidate.expectedRevision === 'number' &&
      Number.isSafeInteger(candidate.expectedRevision) &&
      candidate.expectedRevision >= 0
    );
  }
  return (
    candidate.kind === 'prompt' &&
    Object.keys(candidate).sort().join(',') ===
      'kind,participantInputRevision,promptId' &&
    typeof candidate.promptId === 'string' &&
    candidate.promptId.length > 0 &&
    typeof candidate.participantInputRevision === 'number' &&
    Number.isSafeInteger(candidate.participantInputRevision) &&
    candidate.participantInputRevision >= 0
  );
}
