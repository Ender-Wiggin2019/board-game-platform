import type {
  AccessContext,
  BackendPort,
  CommandPrecondition,
  GetEventsResponse,
  JsonValue,
  MatchAdmission,
  OperationStatus,
  PlayerViewEnvelope,
  QueryOptionsResponse,
  ResumeResult,
  SessionRoute,
  SessionStatus,
  SessionSummary,
  SubmitCommandResponse,
} from '@board-game/contracts';
import type { AdmissionStore, StartOperation } from '../admission/types.js';

export interface PlatformIdentityReference {
  readonly principalId: string;
  /** Auth/session identity used to resolve the current principal epoch. */
  readonly authSessionId: string;
  /** Untrusted selection; SessionGateway checks it against frozen seat ownership. */
  readonly seatId?: string;
}

export interface ResolvedIdentity {
  readonly principalId: string;
  readonly authEpoch: string;
  readonly active: boolean;
}

export type SessionGatewayOperation =
  | 'command'
  | 'view'
  | 'resume'
  | 'query'
  | 'events'
  | 'status'
  | 'summary';

export type SessionAccessOperation =
  | 'command'
  | 'view'
  | 'query'
  | 'events'
  | 'status';

export type MaybePromise<T> = T | Promise<T>;

export type CreatedAccess =
  | readonly string[]
  | Pick<AccessContext, 'principalId' | 'authEpoch' | 'scopes'>;

export interface SessionGatewayOptions {
  /** Explicit game-owned scopes; reserved session:* privileges remain forbidden. */
  readonly gameScopes?: Readonly<Record<string, readonly string[]>>;
  readonly admission: Pick<AdmissionStore, 'getStartBySession'>;
  /** Receives only a trusted server-side reference, never browser credentials. */
  readonly resolveIdentity: (
    reference: PlatformIdentityReference,
  ) => MaybePromise<ResolvedIdentity>;
  /** Rechecks current membership, grants, revocation and audience policy. */
  readonly authorize: (
    identity: ResolvedIdentity,
    admission: MatchAdmission,
    operation: SessionGatewayOperation,
  ) => MaybePromise<boolean>;
  /** Returns server-derived scopes; AccessContext is assembled by the gateway. */
  readonly createAccess: (
    identity: ResolvedIdentity,
    admission: MatchAdmission,
    operation: SessionAccessOperation,
  ) => MaybePromise<CreatedAccess>;
  /** Must resolve the exact frozen route; the gateway never falls back. */
  readonly resolveBackend: (route: SessionRoute) => BackendPort;
}

export interface CommandInput<Command extends JsonValue = JsonValue> {
  readonly commandId: string;
  readonly precondition: CommandPrecondition;
  readonly command: Command;
}

export interface QueryInput<Query extends JsonValue = JsonValue> {
  readonly revision: number;
  readonly query: Query;
}

export interface EventsInput {
  readonly afterSequence: number;
  readonly limit: number;
  readonly viewEpoch?: string;
}

export interface ResumeInput {
  readonly viewerEpoch?: string;
  readonly streamCursor?: string;
}

export interface StatusInput {
  readonly startId?: string;
  readonly commandId?: string;
}

/** Public routing metadata contains no backend URL or private identity fields. */
export interface PublicRouteDescriptor {
  readonly authority: 'platform';
  readonly route: SessionRoute;
  readonly roomId?: string;
  readonly status: SessionStatus | StartOperation['state'];
}

export type SessionGatewayResponse<T extends object> = T & {
  readonly descriptor: PublicRouteDescriptor;
};

export type CommandResponse = SessionGatewayResponse<SubmitCommandResponse>;
export type ViewResponse = SessionGatewayResponse<PlayerViewEnvelope>;
export type ResumeResponse = SessionGatewayResponse<ResumeResult>;
export type QueryResponse = SessionGatewayResponse<QueryOptionsResponse>;
export type EventsResponse = SessionGatewayResponse<GetEventsResponse>;
export type StatusResponse = SessionGatewayResponse<OperationStatus>;
export type SummaryResponse = SessionGatewayResponse<SessionSummary>;
