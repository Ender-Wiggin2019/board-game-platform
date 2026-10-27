import type {
  GamePolicyVersion,
  GameServiceDescription,
  JsonValue,
  ReleaseManifest,
} from '@board-game/contracts';

export type ReleaseBindingStatus =
  | 'staged'
  | 'ready'
  | 'draining'
  | 'retained'
  | 'retired';

export type ReleaseDeploymentKind = 'managed' | 'external';

/** Secret-free projection of the operator's desired installation file. */
export interface DesiredGameInstallation {
  readonly gameId: string;
  readonly releaseId: string;
  readonly enabled: boolean;
  readonly deployment: ReleaseDeploymentKind;
}

export interface ReleaseEndpointRefs {
  readonly controlEndpoint: string;
  readonly playerEndpoint: string;
  /** Optional internal authorization-sync listener; falls back to controlEndpoint. */
  readonly authorizationEndpoint?: string;
  readonly clientArtifactBaseUrl: string;
  readonly serviceCredentialRef: string;
}

export interface ReleaseRecord {
  readonly platformId: string;
  readonly gameId: string;
  readonly releaseId: string;
  readonly manifest: ReleaseManifest;
  readonly service: GameServiceDescription;
  readonly manifestDigest: string;
  readonly serviceDigest: string;
  /** Platform approval is explicit; manifest declarations are not approval. */
  readonly approvedFeatures: readonly string[];
  readonly approvedModes: readonly string[];
  /** Optional JSON-only settlement policy retained with this exact release. */
  readonly policyBundle?: JsonValue;
  readonly policyBundleDigest?: string;
  /** Platform approval is explicit; policy declarations are not approval. */
  readonly approvedPolicyVersions?: readonly GamePolicyVersion[];
  readonly createdAt: number;
}

export interface BindingReadinessEvidence {
  readonly probeId: string;
  readonly checkedAt: number;
  readonly protocol: {
    readonly major: number;
    readonly minor: number;
    readonly serviceDigest: string;
    readonly service: GameServiceDescription;
  };
  readonly storage: {
    readonly bindingId: string;
    readonly schemaVersion: string;
  };
}

export interface BindingRetirementEvidence {
  readonly checkedAt: number;
  readonly usage: {
    readonly activeSessions: number;
    readonly pendingFacts: number;
    readonly settlementBacklog: number;
  };
  readonly replay:
    | {
        readonly status: 'replacement-ready';
        readonly replacementBindingId: string;
        readonly originalClient: 'passed';
      }
    | {
        readonly status: 'expired';
        readonly originalClient: 'expired';
      };
}

export interface ReleaseBindingRecord {
  readonly platformId: string;
  readonly backendBindingId: string;
  readonly gameId: string;
  readonly releaseId: string;
  readonly storageBindingId: string;
  readonly ownershipEpoch: string;
  readonly deployment: ReleaseDeploymentKind;
  readonly controlEndpoint: string;
  readonly playerEndpoint: string;
  readonly authorizationEndpoint?: string;
  readonly clientArtifactBaseUrl: string;
  readonly serviceCredentialRef: string;
  readonly status: ReleaseBindingStatus;
  readonly revision: number;
  readonly readiness?: BindingReadinessEvidence;
  readonly retirement?: BindingRetirementEvidence;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ChannelRecord {
  readonly platformId: string;
  readonly gameId: string;
  readonly modeId: string;
  readonly channel: string;
  readonly revision: number;
  readonly targetBackendBindingId: string;
  readonly releaseId: string;
  readonly storageBindingId: string;
  readonly ownershipEpoch: string;
  readonly operationId: string;
  readonly updatedAt: number;
}

export interface RegisterReleaseInput {
  readonly platformId: string;
  readonly manifest: ReleaseManifest;
  readonly service: GameServiceDescription;
  readonly approvedFeatures: readonly string[];
  readonly approvedModes: readonly string[];
  readonly policyBundle?: JsonValue;
  readonly approvedPolicyVersions?: readonly GamePolicyVersion[];
  readonly now?: number;
}

export interface RegisterBindingInput extends ReleaseEndpointRefs {
  readonly platformId: string;
  readonly gameId: string;
  readonly releaseId: string;
  readonly backendBindingId: string;
  readonly storageBindingId: string;
  readonly ownershipEpoch: string;
  readonly deployment: ReleaseDeploymentKind;
  readonly now?: number;
}

export interface UpdateBindingEndpointsInput extends ReleaseEndpointRefs {
  readonly platformId: string;
  readonly backendBindingId: string;
  readonly expectedRevision: number;
  readonly now?: number;
}

export interface RecordBindingReadinessInput {
  readonly platformId: string;
  readonly backendBindingId: string;
  readonly evidence: BindingReadinessEvidence;
  /** Revision observed by the external probe; prevents stale endpoint probes. */
  readonly expectedRevision?: number;
  readonly now?: number;
}

export interface ChangeBindingStateInput {
  readonly platformId: string;
  readonly backendBindingId: string;
  readonly now?: number;
}

export interface RetireBindingInput extends ChangeBindingStateInput {
  readonly evidence: BindingRetirementEvidence;
}

export interface CompareAndSwapChannelInput {
  readonly platformId: string;
  readonly gameId: string;
  readonly modeId: string;
  readonly channel: string;
  readonly expectedRevision: number;
  readonly targetBackendBindingId: string;
  readonly operationId: string;
  readonly now?: number;
}

export interface BindingProbeRequest {
  readonly platformId: string;
  readonly release: ReleaseRecord;
  readonly binding: ReleaseBindingRecord;
}

export interface BindingProbeClient {
  probe(input: BindingProbeRequest): Promise<BindingReadinessEvidence>;
}

export interface BindingRetirementProbeRequest {
  readonly platformId: string;
  readonly release: ReleaseRecord;
  readonly binding: ReleaseBindingRecord;
}

export interface BindingRetirementProbe {
  probe(
    input: BindingRetirementProbeRequest,
  ): Promise<BindingRetirementEvidence>;
}

export type ReleaseRegistryErrorCode =
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'REVISION_CONFLICT'
  | 'NOT_READY'
  | 'ACTIVE_CHANNEL'
  | 'INVALID_STATE'
  | 'RETIRE_BLOCKED'
  | 'MIGRATION_REQUIRED'
  | 'DATABASE_ERROR';

export class ReleaseRegistryError extends Error {
  readonly name = 'ReleaseRegistryError';

  constructor(
    readonly code: ReleaseRegistryErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
    readonly retryable = code === 'DATABASE_ERROR',
  ) {
    super(message);
  }
}

export interface ReleaseRegistryStore {
  registerRelease(input: RegisterReleaseInput): Promise<ReleaseRecord>;
  listReleases(
    platformId: string,
    gameId?: string,
  ): Promise<readonly ReleaseRecord[]>;
  getRelease(
    platformId: string,
    gameId: string,
    releaseId: string,
  ): Promise<ReleaseRecord | null>;
  registerBinding(input: RegisterBindingInput): Promise<ReleaseBindingRecord>;
  getBinding(
    platformId: string,
    backendBindingId: string,
  ): Promise<ReleaseBindingRecord | null>;
  listBindings(
    platformId: string,
    gameId?: string,
  ): Promise<readonly ReleaseBindingRecord[]>;
  updateBindingEndpoints(
    input: UpdateBindingEndpointsInput,
  ): Promise<ReleaseBindingRecord>;
  recordBindingReadiness(
    input: RecordBindingReadinessInput,
  ): Promise<ReleaseBindingRecord>;
  drainBinding(input: ChangeBindingStateInput): Promise<ReleaseBindingRecord>;
  retainBinding(input: ChangeBindingStateInput): Promise<ReleaseBindingRecord>;
  retireBinding(input: RetireBindingInput): Promise<ReleaseBindingRecord>;
  listChannels(platformId: string): Promise<readonly ChannelRecord[]>;
  /** Most recent successful switches, including rollbacks; retries occur once. */
  listChannelHistory(
    platformId: string,
    limit?: number,
  ): Promise<readonly ChannelRecord[]>;
  getChannel(
    platformId: string,
    gameId: string,
    modeId: string,
    channel: string,
  ): Promise<ChannelRecord | null>;
  compareAndSwapChannel(
    input: CompareAndSwapChannelInput,
  ): Promise<ChannelRecord>;
  migrate?(): Promise<void>;
  close?(): Promise<void>;
}

/** Short aliases used by callers that describe bindings without the record prefix. */
export type BindingRecord = ReleaseBindingRecord;
export type DeploymentBindingRecord = ReleaseBindingRecord;
