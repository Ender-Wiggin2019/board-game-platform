import { createHash } from 'node:crypto';
import {
  assertGameServiceDescription,
  assertJsonPayloadSize,
  assertReleaseManifest,
  canonicalStableStringify,
  type GamePolicyKind,
  type GamePolicyVersion,
  type GameServiceDescription,
  type JsonValue,
  type ReleaseManifest,
} from '@board-game/contracts';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import {
  type BindingReadinessEvidence,
  type BindingRetirementEvidence,
  type ChangeBindingStateInput,
  type ChannelRecord,
  type CompareAndSwapChannelInput,
  type RegisterBindingInput,
  type RegisterReleaseInput,
  type ReleaseBindingRecord,
  type ReleaseBindingStatus,
  type ReleaseDeploymentKind,
  type ReleaseRecord,
  ReleaseRegistryError,
  type ReleaseRegistryStore,
  type RetireBindingInput,
  type UpdateBindingEndpointsInput,
} from './types.js';

export const DEFAULT_RELEASE_REGISTRY_SCHEMA = 'board_platform_releases';
const MAX_ID_LENGTH = 256;
const MAX_ENDPOINT_LENGTH = 2_048;
const MAX_SCHEMA_VERSION_LENGTH = 128;
const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_POLICY_BUNDLE_BYTES = 512 * 1024;
const MAX_EVIDENCE_BYTES = 256 * 1024;

interface ChannelOperation {
  readonly digest: string;
  readonly result: ChannelRecord;
}

interface MemoryState {
  readonly releases: Map<string, ReleaseRecord>;
  readonly bindings: Map<string, ReleaseBindingRecord>;
  readonly channels: Map<string, ChannelRecord>;
  readonly channelOperations: Map<string, ChannelOperation>;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function jsonKey(...values: readonly string[]): string {
  return JSON.stringify(values);
}

function releaseKey(
  platformId: string,
  gameId: string,
  releaseId: string,
): string {
  return jsonKey(platformId, gameId, releaseId);
}

function bindingKey(platformId: string, backendBindingId: string): string {
  return jsonKey(platformId, backendBindingId);
}

function channelKey(
  platformId: string,
  gameId: string,
  modeId: string,
  channel: string,
): string {
  return jsonKey(platformId, gameId, modeId, channel);
}

function operationKey(platformId: string, operationId: string): string {
  return jsonKey(platformId, operationId);
}

function historyLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new ReleaseRegistryError(
      'INVALID_ARGUMENT',
      'channel history limit must be between 1 and 100',
    );
  return limit;
}

function now(input: number | undefined): number {
  const value = input ?? Date.now();
  if (!Number.isFinite(value) || value < 0)
    throw new ReleaseRegistryError(
      'INVALID_ARGUMENT',
      'timestamp must be a finite non-negative number',
    );
  return value;
}

function stringValue(
  value: unknown,
  field: string,
  max = MAX_ID_LENGTH,
): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > max
  )
    throw new ReleaseRegistryError(
      'INVALID_ARGUMENT',
      `${field} must be a non-empty string of at most ${max} characters`,
    );
  return value;
}

function safeInteger(value: unknown, field: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum)
    throw new ReleaseRegistryError(
      'INVALID_ARGUMENT',
      `${field} must be a safe integer >= ${minimum}`,
    );
  return value as number;
}

function enumValue<T extends string>(
  value: unknown,
  field: string,
  values: readonly T[],
): T {
  if (typeof value !== 'string' || !values.includes(value as T))
    throw new ReleaseRegistryError(
      'INVALID_ARGUMENT',
      `${field} has an unsupported value`,
    );
  return value as T;
}

function assertObjectKeys(
  value: unknown,
  field: string,
  keys: readonly string[],
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ReleaseRegistryError(
      'INVALID_ARGUMENT',
      `${field} must be an object`,
    );
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key)))
    throw new ReleaseRegistryError(
      'INVALID_ARGUMENT',
      `${field} contains an unsupported field`,
    );
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256')
    .update(canonicalStableStringify(value))
    .digest('hex')}`;
}

function assertEndpoints(input: {
  readonly controlEndpoint: unknown;
  readonly playerEndpoint: unknown;
  readonly authorizationEndpoint?: unknown;
  readonly clientArtifactBaseUrl: unknown;
  readonly serviceCredentialRef: unknown;
}): void {
  stringValue(input.controlEndpoint, 'controlEndpoint', MAX_ENDPOINT_LENGTH);
  stringValue(input.playerEndpoint, 'playerEndpoint', MAX_ENDPOINT_LENGTH);
  if (input.authorizationEndpoint !== undefined)
    stringValue(
      input.authorizationEndpoint,
      'authorizationEndpoint',
      MAX_ENDPOINT_LENGTH,
    );
  stringValue(
    input.clientArtifactBaseUrl,
    'clientArtifactBaseUrl',
    MAX_ENDPOINT_LENGTH,
  );
  stringValue(
    input.serviceCredentialRef,
    'serviceCredentialRef',
    MAX_ENDPOINT_LENGTH,
  );
}

function endpointSnapshot(input: {
  readonly controlEndpoint: string;
  readonly playerEndpoint: string;
  readonly authorizationEndpoint?: string;
  readonly clientArtifactBaseUrl: string;
  readonly serviceCredentialRef: string;
}) {
  return {
    controlEndpoint: input.controlEndpoint,
    playerEndpoint: input.playerEndpoint,
    ...(input.authorizationEndpoint === undefined
      ? {}
      : { authorizationEndpoint: input.authorizationEndpoint }),
    clientArtifactBaseUrl: input.clientArtifactBaseUrl,
    serviceCredentialRef: input.serviceCredentialRef,
  } as const;
}

function assertManifestAndService(
  input: Pick<RegisterReleaseInput, 'platformId' | 'manifest' | 'service'>,
): void {
  stringValue(input.platformId, 'platformId');
  assertReleaseManifest(input.manifest);
  assertJsonPayloadSize(input.manifest, MAX_MANIFEST_BYTES);
  assertGameServiceDescription(input.service);
  if (
    input.service.platformId !== input.platformId ||
    input.service.gameId !== input.manifest.gameId ||
    input.service.releaseId !== input.manifest.releaseId
  )
    throw new ReleaseRegistryError(
      'CONFLICT',
      'service identity must match the release manifest and platform namespace',
    );
  if (
    canonicalStableStringify(input.service.modes) !==
    canonicalStableStringify(input.manifest.modes)
  )
    throw new ReleaseRegistryError(
      'CONFLICT',
      'service modes must match the release manifest',
    );
}

function assertApprovedList(
  values: readonly string[],
  field: string,
  allowed: readonly string[],
): void {
  if (!Array.isArray(values) || values.length > 256)
    throw new ReleaseRegistryError(
      'INVALID_ARGUMENT',
      `${field} must be an array with at most 256 entries`,
    );
  const seen = new Set<string>();
  for (const value of values) {
    stringValue(value, `${field}[]`);
    if (seen.has(value) || !allowed.includes(value))
      throw new ReleaseRegistryError(
        'INVALID_ARGUMENT',
        `${field} contains a duplicate or undeclared value`,
      );
    seen.add(value);
  }
}

function assertApprovedPolicyVersions(
  values: readonly GamePolicyVersion[] | undefined,
): void {
  if (values === undefined) return;
  if (!Array.isArray(values) || values.length > 64)
    throw new ReleaseRegistryError(
      'INVALID_ARGUMENT',
      'approvedPolicyVersions must be an array with at most 64 entries',
    );
  const kinds = new Set<GamePolicyKind>([
    'rating',
    'progression',
    'reward',
    'achievement',
  ]);
  const seen = new Set<string>();
  for (const value of values) {
    assertObjectKeys(value, 'approvedPolicyVersions[]', ['kind', 'version']);
    if (
      typeof value.kind !== 'string' ||
      !kinds.has(value.kind as GamePolicyKind) ||
      typeof value.version !== 'string' ||
      value.version.trim().length === 0 ||
      value.version.length > 128
    )
      throw new ReleaseRegistryError(
        'INVALID_ARGUMENT',
        'approvedPolicyVersions contains an invalid entry',
      );
    const key = `${value.kind}:${value.version}`;
    if (seen.has(key))
      throw new ReleaseRegistryError(
        'INVALID_ARGUMENT',
        'approvedPolicyVersions contains a duplicate entry',
      );
    seen.add(key);
  }
}

function assertReadinessEvidence(evidence: BindingReadinessEvidence): void {
  assertObjectKeys(evidence, 'readiness', [
    'probeId',
    'checkedAt',
    'protocol',
    'storage',
  ]);
  stringValue(evidence.probeId, 'readiness.probeId');
  now(evidence.checkedAt);
  assertObjectKeys(evidence.protocol, 'readiness.protocol', [
    'major',
    'minor',
    'serviceDigest',
    'service',
  ]);
  safeInteger(evidence.protocol.major, 'readiness.protocol.major', 1);
  safeInteger(evidence.protocol.minor, 'readiness.protocol.minor');
  stringValue(
    evidence.protocol.serviceDigest,
    'readiness.protocol.serviceDigest',
  );
  assertGameServiceDescription(evidence.protocol.service);
  assertObjectKeys(evidence.storage, 'readiness.storage', [
    'bindingId',
    'schemaVersion',
  ]);
  stringValue(evidence.storage.bindingId, 'readiness.storage.bindingId');
  stringValue(
    evidence.storage.schemaVersion,
    'readiness.storage.schemaVersion',
    MAX_SCHEMA_VERSION_LENGTH,
  );
  assertJsonPayloadSize(evidence, MAX_EVIDENCE_BYTES);
}

function assertRetirementEvidence(evidence: BindingRetirementEvidence): void {
  assertObjectKeys(evidence, 'retirement', ['checkedAt', 'usage', 'replay']);
  now(evidence.checkedAt);
  assertObjectKeys(evidence.usage, 'retirement.usage', [
    'activeSessions',
    'pendingFacts',
    'settlementBacklog',
  ]);
  for (const [field, value] of Object.entries(evidence.usage))
    safeInteger(value, `retirement.usage.${field}`);
  if (
    evidence.usage.activeSessions !== 0 ||
    evidence.usage.pendingFacts !== 0 ||
    evidence.usage.settlementBacklog !== 0
  )
    throw new ReleaseRegistryError(
      'RETIRE_BLOCKED',
      'binding cannot retire while durable work remains',
    );
  if (evidence.replay.status === 'replacement-ready') {
    // The runtime has no replacement replay adapter yet.  Keep accepting the
    // historical evidence shape at the type boundary, but do not retire a
    // binding while its replay would rely on an unimplemented route.
    throw new ReleaseRegistryError(
      'RETIRE_BLOCKED',
      'replacement replay routing is unavailable; retain the binding until replay expires',
    );
  } else {
    assertObjectKeys(evidence.replay, 'retirement.replay', [
      'status',
      'originalClient',
    ]);
    if (
      evidence.replay.status !== 'expired' ||
      evidence.replay.originalClient !== 'expired'
    ) {
      throw new ReleaseRegistryError(
        'RETIRE_BLOCKED',
        'replay retention must have a replacement probe or explicit expiry',
      );
    }
  }
  assertJsonPayloadSize(evidence, MAX_EVIDENCE_BYTES);
}

function assertBindingInput(input: RegisterBindingInput): void {
  stringValue(input.platformId, 'platformId');
  stringValue(input.gameId, 'gameId');
  stringValue(input.releaseId, 'releaseId');
  stringValue(input.backendBindingId, 'backendBindingId');
  stringValue(input.storageBindingId, 'storageBindingId');
  stringValue(input.ownershipEpoch, 'ownershipEpoch');
  enumValue(input.deployment, 'deployment', ['managed', 'external']);
  assertEndpoints(input);
}

function assertStatusTransition(
  status: ReleaseBindingStatus,
  target: ReleaseBindingStatus,
): void {
  const allowed: Readonly<
    Record<ReleaseBindingStatus, readonly ReleaseBindingStatus[]>
  > = {
    staged: ['ready'],
    ready: ['staged', 'draining'],
    draining: ['retained', 'retired'],
    retained: ['retired'],
    retired: [],
  };
  if (!allowed[status].includes(target))
    throw new ReleaseRegistryError(
      'INVALID_STATE',
      `cannot transition binding from ${status} to ${target}`,
    );
}

function validateReadinessAgainstBinding(
  release: ReleaseRecord,
  binding: ReleaseBindingRecord,
  evidence: BindingReadinessEvidence,
): void {
  assertReadinessEvidence(evidence);
  if (
    evidence.storage.bindingId !== binding.storageBindingId ||
    evidence.protocol.serviceDigest !== release.serviceDigest ||
    canonicalStableStringify(evidence.protocol.service) !==
      canonicalStableStringify(release.service) ||
    evidence.protocol.service.backendBindingId !== binding.backendBindingId ||
    evidence.protocol.service.storageBindingId !== binding.storageBindingId ||
    evidence.protocol.service.ownershipEpoch !== binding.ownershipEpoch ||
    evidence.protocol.major !== release.manifest.integration.protocolMajor
  )
    throw new ReleaseRegistryError(
      'CONFLICT',
      'readiness evidence does not match the immutable release and binding identity',
    );
}

function validateRetirementReplacement(
  evidence: BindingRetirementEvidence,
  replacement: ReleaseBindingRecord | null,
  retiredBindingId: string,
  retiredGameId?: string,
): void {
  assertRetirementEvidence(evidence);
  if (evidence.replay.status !== 'replacement-ready') return;
  if (
    replacement === null ||
    replacement.backendBindingId === retiredBindingId ||
    replacement.status !== 'ready' ||
    (retiredGameId !== undefined && replacement.gameId !== retiredGameId)
  )
    throw new ReleaseRegistryError(
      'RETIRE_BLOCKED',
      'replay replacement binding must be a different ready binding',
    );
}

function bindingIdentityEqual(
  a: ReleaseBindingRecord,
  b: ReleaseBindingRecord,
): boolean {
  return (
    a.platformId === b.platformId &&
    a.backendBindingId === b.backendBindingId &&
    a.gameId === b.gameId &&
    a.releaseId === b.releaseId &&
    a.storageBindingId === b.storageBindingId &&
    a.ownershipEpoch === b.ownershipEpoch &&
    a.deployment === b.deployment &&
    a.controlEndpoint === b.controlEndpoint &&
    a.playerEndpoint === b.playerEndpoint &&
    a.authorizationEndpoint === b.authorizationEndpoint &&
    a.clientArtifactBaseUrl === b.clientArtifactBaseUrl &&
    a.serviceCredentialRef === b.serviceCredentialRef
  );
}

function releaseEqual(a: ReleaseRecord, b: ReleaseRecord): boolean {
  return (
    a.platformId === b.platformId &&
    a.gameId === b.gameId &&
    a.releaseId === b.releaseId &&
    a.manifestDigest === b.manifestDigest &&
    a.serviceDigest === b.serviceDigest &&
    canonicalStableStringify(a.manifest) ===
      canonicalStableStringify(b.manifest) &&
    canonicalStableStringify(a.service) ===
      canonicalStableStringify(b.service) &&
    canonicalStableStringify(a.approvedFeatures) ===
      canonicalStableStringify(b.approvedFeatures) &&
    canonicalStableStringify(a.approvedModes) ===
      canonicalStableStringify(b.approvedModes) &&
    canonicalStableStringify(a.policyBundle ?? null) ===
      canonicalStableStringify(b.policyBundle ?? null) &&
    (a.policyBundleDigest ?? null) === (b.policyBundleDigest ?? null) &&
    canonicalStableStringify(a.approvedPolicyVersions ?? null) ===
      canonicalStableStringify(b.approvedPolicyVersions ?? null)
  );
}

function channelInputDigest(input: CompareAndSwapChannelInput): string {
  return digest({
    platformId: input.platformId,
    gameId: input.gameId,
    modeId: input.modeId,
    channel: input.channel,
    expectedRevision: input.expectedRevision,
    targetBackendBindingId: input.targetBackendBindingId,
  });
}

function validateChannelInput(input: CompareAndSwapChannelInput): void {
  stringValue(input.platformId, 'platformId');
  stringValue(input.gameId, 'gameId');
  stringValue(input.modeId, 'modeId');
  stringValue(input.channel, 'channel');
  safeInteger(input.expectedRevision, 'expectedRevision');
  stringValue(input.targetBackendBindingId, 'targetBackendBindingId');
  stringValue(input.operationId, 'operationId');
}

function releaseRecordFromInput(input: RegisterReleaseInput): ReleaseRecord {
  assertManifestAndService(input);
  assertApprovedList(
    input.approvedFeatures,
    'approvedFeatures',
    input.manifest.capabilities.features,
  );
  assertApprovedList(
    input.approvedModes,
    'approvedModes',
    input.manifest.modes.map((mode) => mode.id),
  );
  if (input.policyBundle !== undefined) {
    assertJsonPayloadSize(input.policyBundle, MAX_POLICY_BUNDLE_BYTES);
    if (
      !input.policyBundle ||
      typeof input.policyBundle !== 'object' ||
      Array.isArray(input.policyBundle)
    )
      throw new ReleaseRegistryError(
        'INVALID_ARGUMENT',
        'policyBundle must be a JSON object',
      );
  }
  assertApprovedPolicyVersions(input.approvedPolicyVersions);
  const createdAt = now(input.now);
  return {
    platformId: input.platformId,
    gameId: input.manifest.gameId,
    releaseId: input.manifest.releaseId,
    manifest: copy(input.manifest),
    service: copy(input.service),
    manifestDigest: digest(input.manifest),
    serviceDigest: digest(input.service),
    approvedFeatures: [...input.approvedFeatures],
    approvedModes: [...input.approvedModes],
    ...(input.policyBundle === undefined
      ? {}
      : {
          policyBundle: copy(input.policyBundle) as JsonValue,
          policyBundleDigest: digest(input.policyBundle),
        }),
    ...(input.approvedPolicyVersions === undefined
      ? {}
      : { approvedPolicyVersions: copy(input.approvedPolicyVersions) }),
    createdAt,
  };
}

function assertReleaseIdentityForBinding(
  release: ReleaseRecord,
  input: RegisterBindingInput,
): void {
  if (
    release.gameId !== input.gameId ||
    release.releaseId !== input.releaseId ||
    release.service.backendBindingId !== input.backendBindingId ||
    release.service.storageBindingId !== input.storageBindingId ||
    release.service.ownershipEpoch !== input.ownershipEpoch
  )
    throw new ReleaseRegistryError(
      'CONFLICT',
      'binding identity must match the registered service description',
    );
}

function buildBinding(
  input: RegisterBindingInput,
  createdAt: number,
): ReleaseBindingRecord {
  return {
    platformId: input.platformId,
    backendBindingId: input.backendBindingId,
    gameId: input.gameId,
    releaseId: input.releaseId,
    storageBindingId: input.storageBindingId,
    ownershipEpoch: input.ownershipEpoch,
    deployment: input.deployment,
    ...endpointSnapshot(input),
    status: 'staged',
    revision: 0,
    createdAt,
    updatedAt: createdAt,
  };
}

function requireBinding(
  state: MemoryState,
  platformId: string,
  backendBindingId: string,
): ReleaseBindingRecord {
  const binding = state.bindings.get(bindingKey(platformId, backendBindingId));
  if (!binding)
    throw new ReleaseRegistryError('NOT_FOUND', 'binding not found');
  return binding;
}

function requireRelease(
  state: MemoryState,
  platformId: string,
  gameId: string,
  releaseId: string,
): ReleaseRecord {
  const release = state.releases.get(releaseKey(platformId, gameId, releaseId));
  if (!release)
    throw new ReleaseRegistryError('NOT_FOUND', 'release not found');
  return release;
}

function requireChannelBinding(
  state: MemoryState,
  input: CompareAndSwapChannelInput,
): { readonly binding: ReleaseBindingRecord; readonly release: ReleaseRecord } {
  const binding = requireBinding(
    state,
    input.platformId,
    input.targetBackendBindingId,
  );
  if (binding.gameId !== input.gameId)
    throw new ReleaseRegistryError(
      'CONFLICT',
      'binding game does not match channel',
    );
  const release = requireRelease(
    state,
    input.platformId,
    binding.gameId,
    binding.releaseId,
  );
  if (!release.approvedModes.includes(input.modeId))
    throw new ReleaseRegistryError(
      'CONFLICT',
      'mode is not approved for this release',
    );
  if (binding.status !== 'ready')
    throw new ReleaseRegistryError(
      'NOT_READY',
      'channel target binding is not ready',
    );
  return { binding, release };
}

function activeChannelForBinding(
  state: MemoryState,
  platformId: string,
  backendBindingId: string,
): ChannelRecord | undefined {
  for (const channel of state.channels.values())
    if (
      channel.platformId === platformId &&
      channel.targetBackendBindingId === backendBindingId
    )
      return channel;
  return undefined;
}

/** In-memory implementation used by tests and small single-process deployments. */
export class MemoryReleaseRegistryStore implements ReleaseRegistryStore {
  private readonly state: MemoryState = {
    releases: new Map(),
    bindings: new Map(),
    channels: new Map(),
    channelOperations: new Map(),
  };

  private lock: Promise<void> = Promise.resolve();

  private async exclusive<T>(work: () => T | Promise<T>): Promise<T> {
    const previous = this.lock;
    let unlock!: () => void;
    this.lock = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      unlock();
    }
  }

  async registerRelease(input: RegisterReleaseInput): Promise<ReleaseRecord> {
    const candidate = releaseRecordFromInput(input);
    return this.exclusive(() => {
      const key = releaseKey(
        candidate.platformId,
        candidate.gameId,
        candidate.releaseId,
      );
      const existing = this.state.releases.get(key);
      if (existing) {
        if (!releaseEqual(existing, candidate))
          throw new ReleaseRegistryError(
            'CONFLICT',
            'release identity is immutable',
          );
        return copy(existing);
      }
      this.state.releases.set(key, candidate);
      return copy(candidate);
    });
  }

  async getRelease(
    platformId: string,
    gameId: string,
    releaseId: string,
  ): Promise<ReleaseRecord | null> {
    stringValue(platformId, 'platformId');
    stringValue(gameId, 'gameId');
    stringValue(releaseId, 'releaseId');
    const result = this.state.releases.get(
      releaseKey(platformId, gameId, releaseId),
    );
    return result ? copy(result) : null;
  }

  async listReleases(
    platformId: string,
    gameId?: string,
  ): Promise<readonly ReleaseRecord[]> {
    stringValue(platformId, 'platformId');
    if (gameId !== undefined) stringValue(gameId, 'gameId');
    return [...this.state.releases.values()]
      .filter(
        (release) =>
          release.platformId === platformId &&
          (gameId === undefined || release.gameId === gameId),
      )
      .sort((a, b) =>
        `${a.gameId}:${a.releaseId}`.localeCompare(
          `${b.gameId}:${b.releaseId}`,
        ),
      )
      .map(copy);
  }

  async registerBinding(
    input: RegisterBindingInput,
  ): Promise<ReleaseBindingRecord> {
    assertBindingInput(input);
    const candidateTime = now(input.now);
    return this.exclusive(() => {
      const release = requireRelease(
        this.state,
        input.platformId,
        input.gameId,
        input.releaseId,
      );
      assertReleaseIdentityForBinding(release, input);
      const key = bindingKey(input.platformId, input.backendBindingId);
      const existing = this.state.bindings.get(key);
      const candidate = buildBinding(input, candidateTime);
      if (existing) {
        if (!bindingIdentityEqual(existing, candidate))
          throw new ReleaseRegistryError(
            'CONFLICT',
            'binding identity is immutable',
          );
        return copy(existing);
      }
      this.state.bindings.set(key, candidate);
      return copy(candidate);
    });
  }

  async getBinding(
    platformId: string,
    backendBindingId: string,
  ): Promise<ReleaseBindingRecord | null> {
    stringValue(platformId, 'platformId');
    stringValue(backendBindingId, 'backendBindingId');
    const binding = this.state.bindings.get(
      bindingKey(platformId, backendBindingId),
    );
    return binding ? copy(binding) : null;
  }

  async listBindings(
    platformId: string,
    gameId?: string,
  ): Promise<readonly ReleaseBindingRecord[]> {
    stringValue(platformId, 'platformId');
    if (gameId !== undefined) stringValue(gameId, 'gameId');
    return [...this.state.bindings.values()]
      .filter(
        (binding) =>
          binding.platformId === platformId &&
          (!gameId || binding.gameId === gameId),
      )
      .sort((a, b) => a.backendBindingId.localeCompare(b.backendBindingId))
      .map(copy);
  }

  async updateBindingEndpoints(
    input: UpdateBindingEndpointsInput,
  ): Promise<ReleaseBindingRecord> {
    stringValue(input.platformId, 'platformId');
    stringValue(input.backendBindingId, 'backendBindingId');
    safeInteger(input.expectedRevision, 'expectedRevision');
    assertEndpoints(input);
    const updatedAt = now(input.now);
    return this.exclusive(() => {
      const binding = requireBinding(
        this.state,
        input.platformId,
        input.backendBindingId,
      );
      if (binding.revision !== input.expectedRevision)
        throw new ReleaseRegistryError(
          'REVISION_CONFLICT',
          'binding revision is stale',
        );
      if (
        activeChannelForBinding(
          this.state,
          input.platformId,
          input.backendBindingId,
        )
      )
        throw new ReleaseRegistryError(
          'ACTIVE_CHANNEL',
          'active channel must move before physical endpoints change',
        );
      if (binding.status !== 'staged' && binding.status !== 'ready')
        throw new ReleaseRegistryError(
          'INVALID_STATE',
          'only staged or ready bindings may update endpoints',
        );
      const { readiness: _readiness, ...withoutReadiness } = binding;
      const next: ReleaseBindingRecord = {
        ...withoutReadiness,
        ...endpointSnapshot(input),
        status: 'staged',
        revision: binding.revision + 1,
        updatedAt,
      };
      this.state.bindings.set(
        bindingKey(input.platformId, input.backendBindingId),
        next,
      );
      return copy(next);
    });
  }

  async recordBindingReadiness(input: {
    readonly platformId: string;
    readonly backendBindingId: string;
    readonly evidence: BindingReadinessEvidence;
    readonly expectedRevision?: number;
    readonly now?: number;
  }): Promise<ReleaseBindingRecord> {
    stringValue(input.platformId, 'platformId');
    stringValue(input.backendBindingId, 'backendBindingId');
    const updatedAt = now(input.now);
    return this.exclusive(() => {
      const binding = requireBinding(
        this.state,
        input.platformId,
        input.backendBindingId,
      );
      if (
        input.expectedRevision !== undefined &&
        binding.revision !== input.expectedRevision
      )
        throw new ReleaseRegistryError(
          'REVISION_CONFLICT',
          'binding revision changed while readiness was probed',
        );
      const release = requireRelease(
        this.state,
        input.platformId,
        binding.gameId,
        binding.releaseId,
      );
      validateReadinessAgainstBinding(release, binding, input.evidence);
      if (binding.status !== 'staged' && binding.status !== 'ready')
        throw new ReleaseRegistryError(
          'INVALID_STATE',
          'binding is not eligible for readiness',
        );
      if (binding.status === 'ready') {
        if (
          canonicalStableStringify(binding.readiness) !==
          canonicalStableStringify(input.evidence)
        )
          throw new ReleaseRegistryError(
            'CONFLICT',
            'ready binding already has different readiness evidence',
          );
        return copy(binding);
      }
      const next: ReleaseBindingRecord = {
        ...binding,
        status: 'ready',
        revision: binding.revision + 1,
        readiness: copy(input.evidence),
        updatedAt,
      };
      this.state.bindings.set(
        bindingKey(input.platformId, input.backendBindingId),
        next,
      );
      return copy(next);
    });
  }

  async drainBinding(
    input: ChangeBindingStateInput,
  ): Promise<ReleaseBindingRecord> {
    return this.changeState(input, 'draining');
  }

  async retainBinding(
    input: ChangeBindingStateInput,
  ): Promise<ReleaseBindingRecord> {
    return this.changeState(input, 'retained');
  }

  private async changeState(
    input: ChangeBindingStateInput,
    target: 'draining' | 'retained',
  ): Promise<ReleaseBindingRecord> {
    stringValue(input.platformId, 'platformId');
    stringValue(input.backendBindingId, 'backendBindingId');
    const updatedAt = now(input.now);
    return this.exclusive(() => {
      const binding = requireBinding(
        this.state,
        input.platformId,
        input.backendBindingId,
      );
      if (
        target === 'draining' &&
        activeChannelForBinding(
          this.state,
          input.platformId,
          input.backendBindingId,
        )
      )
        throw new ReleaseRegistryError(
          'ACTIVE_CHANNEL',
          'binding is still active for new admissions',
        );
      if (binding.status === target) return copy(binding);
      assertStatusTransition(binding.status, target);
      const next: ReleaseBindingRecord = {
        ...binding,
        status: target,
        revision: binding.revision + 1,
        updatedAt,
      };
      this.state.bindings.set(
        bindingKey(input.platformId, input.backendBindingId),
        next,
      );
      return copy(next);
    });
  }

  async retireBinding(
    input: RetireBindingInput,
  ): Promise<ReleaseBindingRecord> {
    stringValue(input.platformId, 'platformId');
    stringValue(input.backendBindingId, 'backendBindingId');
    const updatedAt = now(input.now);
    return this.exclusive(() => {
      const binding = requireBinding(
        this.state,
        input.platformId,
        input.backendBindingId,
      );
      if (binding.status === 'retired') return copy(binding);
      if (
        activeChannelForBinding(
          this.state,
          input.platformId,
          input.backendBindingId,
        )
      )
        throw new ReleaseRegistryError(
          'ACTIVE_CHANNEL',
          'binding is still active for new admissions',
        );
      const replacement =
        input.evidence.replay.status === 'replacement-ready'
          ? (this.state.bindings.get(
              bindingKey(
                input.platformId,
                input.evidence.replay.replacementBindingId,
              ),
            ) ?? null)
          : null;
      validateRetirementReplacement(
        input.evidence,
        replacement,
        input.backendBindingId,
        binding.gameId,
      );
      assertStatusTransition(binding.status, 'retired');
      const next: ReleaseBindingRecord = {
        ...binding,
        status: 'retired',
        revision: binding.revision + 1,
        retirement: copy(input.evidence),
        updatedAt,
      };
      this.state.bindings.set(
        bindingKey(input.platformId, input.backendBindingId),
        next,
      );
      return copy(next);
    });
  }

  async listChannels(platformId: string): Promise<readonly ChannelRecord[]> {
    stringValue(platformId, 'platformId');
    return [...this.state.channels.values()]
      .filter((channel) => channel.platformId === platformId)
      .sort((a, b) =>
        jsonKey(a.gameId, a.modeId, a.channel).localeCompare(
          jsonKey(b.gameId, b.modeId, b.channel),
        ),
      )
      .map(copy);
  }

  async listChannelHistory(
    platformId: string,
    limit = 100,
  ): Promise<readonly ChannelRecord[]> {
    stringValue(platformId, 'platformId');
    historyLimit(limit);
    return [...this.state.channelOperations.values()]
      .map((operation) => operation.result)
      .filter((channel) => channel.platformId === platformId)
      .sort(
        (a, b) =>
          b.updatedAt - a.updatedAt ||
          b.operationId.localeCompare(a.operationId),
      )
      .slice(0, limit)
      .map(copy);
  }

  async getChannel(
    platformId: string,
    gameId: string,
    modeId: string,
    channel: string,
  ): Promise<ChannelRecord | null> {
    stringValue(platformId, 'platformId');
    stringValue(gameId, 'gameId');
    stringValue(modeId, 'modeId');
    stringValue(channel, 'channel');
    const result = this.state.channels.get(
      channelKey(platformId, gameId, modeId, channel),
    );
    return result ? copy(result) : null;
  }

  async compareAndSwapChannel(
    input: CompareAndSwapChannelInput,
  ): Promise<ChannelRecord> {
    validateChannelInput(input);
    return this.exclusive(() => {
      const opKey = operationKey(input.platformId, input.operationId);
      const operation = this.state.channelOperations.get(opKey);
      const inputDigest = channelInputDigest(input);
      if (operation) {
        if (operation.digest !== inputDigest)
          throw new ReleaseRegistryError(
            'CONFLICT',
            'operationId was already used for another channel operation',
          );
        return copy(operation.result);
      }
      const { binding } = requireChannelBinding(this.state, input);
      const key = channelKey(
        input.platformId,
        input.gameId,
        input.modeId,
        input.channel,
      );
      const current = this.state.channels.get(key);
      const currentRevision = current?.revision ?? 0;
      if (input.expectedRevision !== currentRevision)
        throw new ReleaseRegistryError(
          'REVISION_CONFLICT',
          'channel revision is stale',
        );
      const result: ChannelRecord = {
        platformId: input.platformId,
        gameId: input.gameId,
        modeId: input.modeId,
        channel: input.channel,
        revision: currentRevision + 1,
        targetBackendBindingId: binding.backendBindingId,
        releaseId: binding.releaseId,
        storageBindingId: binding.storageBindingId,
        ownershipEpoch: binding.ownershipEpoch,
        operationId: input.operationId,
        updatedAt: now(input.now),
      };
      this.state.channels.set(key, result);
      this.state.channelOperations.set(opKey, { digest: inputDigest, result });
      return copy(result);
    });
  }
}

export function releaseRegistryMigrationStatements(
  schema = DEFAULT_RELEASE_REGISTRY_SCHEMA,
): readonly string[] {
  assertSchemaName(schema);
  const releases = tableName(schema, 'releases');
  const bindings = tableName(schema, 'bindings');
  const channels = tableName(schema, 'channels');
  const operations = tableName(schema, 'channel_operations');
  return [
    `CREATE SCHEMA IF NOT EXISTS "${schema}"`,
    `CREATE TABLE IF NOT EXISTS ${releases} (
      platform_id text NOT NULL,
      game_id text NOT NULL,
      release_id text NOT NULL,
      manifest jsonb NOT NULL,
      service jsonb NOT NULL,
      manifest_digest text NOT NULL,
      service_digest text NOT NULL,
      approved_features jsonb NOT NULL,
      approved_modes jsonb NOT NULL,
      policy_bundle jsonb,
      policy_bundle_digest text,
      approved_policy_versions jsonb,
      created_at double precision NOT NULL,
      PRIMARY KEY (platform_id, game_id, release_id)
    )`,
    `ALTER TABLE ${releases}
       ADD COLUMN IF NOT EXISTS policy_bundle jsonb`,
    `ALTER TABLE ${releases}
       ADD COLUMN IF NOT EXISTS policy_bundle_digest text`,
    `ALTER TABLE ${releases}
       ADD COLUMN IF NOT EXISTS approved_policy_versions jsonb`,
    `CREATE TABLE IF NOT EXISTS ${bindings} (
      platform_id text NOT NULL,
      backend_binding_id text NOT NULL,
      game_id text NOT NULL,
      release_id text NOT NULL,
      storage_binding_id text NOT NULL,
      ownership_epoch text NOT NULL,
      deployment text NOT NULL CHECK (deployment IN ('managed', 'external')),
      control_endpoint text NOT NULL,
      player_endpoint text NOT NULL,
      authorization_endpoint text,
      client_artifact_base_url text NOT NULL,
      service_credential_ref text NOT NULL,
      status text NOT NULL CHECK (status IN ('staged', 'ready', 'draining', 'retained', 'retired')),
      revision integer NOT NULL CHECK (revision >= 0),
      readiness jsonb,
      retirement jsonb,
      created_at double precision NOT NULL,
      updated_at double precision NOT NULL,
      PRIMARY KEY (platform_id, backend_binding_id),
      FOREIGN KEY (platform_id, game_id, release_id)
        REFERENCES ${releases} (platform_id, game_id, release_id)
    )`,
    `ALTER TABLE ${bindings}
       ADD COLUMN IF NOT EXISTS authorization_endpoint text`,
    `CREATE INDEX IF NOT EXISTS "${schema}_bindings_game_idx"
      ON ${bindings} (platform_id, game_id, backend_binding_id)`,
    `CREATE TABLE IF NOT EXISTS ${channels} (
      platform_id text NOT NULL,
      game_id text NOT NULL,
      mode_id text NOT NULL,
      channel text NOT NULL,
      revision integer NOT NULL CHECK (revision >= 1),
      target_backend_binding_id text NOT NULL,
      release_id text NOT NULL,
      storage_binding_id text NOT NULL,
      ownership_epoch text NOT NULL,
      operation_id text NOT NULL,
      updated_at double precision NOT NULL,
      PRIMARY KEY (platform_id, game_id, mode_id, channel),
      FOREIGN KEY (platform_id, target_backend_binding_id)
        REFERENCES ${bindings} (platform_id, backend_binding_id)
    )`,
    `CREATE TABLE IF NOT EXISTS ${operations} (
      platform_id text NOT NULL,
      operation_id text NOT NULL,
      request_digest text NOT NULL,
      result jsonb NOT NULL,
      created_at double precision NOT NULL,
      PRIMARY KEY (platform_id, operation_id)
    )`,
  ];
}

function assertSchemaName(schema: string): void {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(schema))
    throw new ReleaseRegistryError(
      'INVALID_ARGUMENT',
      'schema must be a lower-case SQL identifier',
    );
}

function tableName(schema: string, table: string): string {
  assertSchemaName(schema);
  return `"${schema}"."${table}"`;
}

function pgError(error: unknown): ReleaseRegistryError {
  if (error instanceof ReleaseRegistryError) return error;
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code)
      : undefined;
  if (code === '42P01' || code === '3F000')
    return new ReleaseRegistryError(
      'MIGRATION_REQUIRED',
      'release registry migration is required',
    );
  if (code === '23505')
    return new ReleaseRegistryError(
      'CONFLICT',
      'release registry uniqueness conflict',
    );
  if (code === '40001' || code === '40P01')
    return new ReleaseRegistryError(
      'DATABASE_ERROR',
      'release registry transaction serialization failed',
      undefined,
      true,
    );
  return new ReleaseRegistryError(
    'DATABASE_ERROR',
    'release registry database operation failed',
    undefined,
    true,
  );
}

function queryValue(row: QueryResultRow, field: string): unknown {
  return row[field];
}

function rowRelease(row: QueryResultRow): ReleaseRecord {
  return {
    platformId: String(queryValue(row, 'platform_id')),
    gameId: String(queryValue(row, 'game_id')),
    releaseId: String(queryValue(row, 'release_id')),
    manifest: copy(queryValue(row, 'manifest') as ReleaseManifest),
    service: copy(queryValue(row, 'service') as GameServiceDescription),
    manifestDigest: String(queryValue(row, 'manifest_digest')),
    serviceDigest: String(queryValue(row, 'service_digest')),
    approvedFeatures: copy(queryValue(row, 'approved_features') as string[]),
    approvedModes: copy(queryValue(row, 'approved_modes') as string[]),
    ...(queryValue(row, 'policy_bundle') === null ||
    queryValue(row, 'policy_bundle') === undefined
      ? {}
      : {
          policyBundle: copy(queryValue(row, 'policy_bundle') as JsonValue),
        }),
    ...(queryValue(row, 'policy_bundle_digest') === null ||
    queryValue(row, 'policy_bundle_digest') === undefined
      ? {}
      : {
          policyBundleDigest: String(queryValue(row, 'policy_bundle_digest')),
        }),
    ...(queryValue(row, 'approved_policy_versions') === null ||
    queryValue(row, 'approved_policy_versions') === undefined
      ? {}
      : {
          approvedPolicyVersions: copy(
            queryValue(row, 'approved_policy_versions') as GamePolicyVersion[],
          ),
        }),
    createdAt: Number(queryValue(row, 'created_at')),
  };
}

function rowBinding(row: QueryResultRow): ReleaseBindingRecord {
  const readiness = queryValue(row, 'readiness');
  const retirement = queryValue(row, 'retirement');
  return {
    platformId: String(queryValue(row, 'platform_id')),
    backendBindingId: String(queryValue(row, 'backend_binding_id')),
    gameId: String(queryValue(row, 'game_id')),
    releaseId: String(queryValue(row, 'release_id')),
    storageBindingId: String(queryValue(row, 'storage_binding_id')),
    ownershipEpoch: String(queryValue(row, 'ownership_epoch')),
    deployment: String(queryValue(row, 'deployment')) as ReleaseDeploymentKind,
    controlEndpoint: String(queryValue(row, 'control_endpoint')),
    playerEndpoint: String(queryValue(row, 'player_endpoint')),
    ...(queryValue(row, 'authorization_endpoint') === null ||
    queryValue(row, 'authorization_endpoint') === undefined
      ? {}
      : {
          authorizationEndpoint: String(
            queryValue(row, 'authorization_endpoint'),
          ),
        }),
    clientArtifactBaseUrl: String(queryValue(row, 'client_artifact_base_url')),
    serviceCredentialRef: String(queryValue(row, 'service_credential_ref')),
    status: String(queryValue(row, 'status')) as ReleaseBindingStatus,
    revision: Number(queryValue(row, 'revision')),
    ...(readiness === null || readiness === undefined
      ? {}
      : { readiness: copy(readiness as BindingReadinessEvidence) }),
    ...(retirement === null || retirement === undefined
      ? {}
      : { retirement: copy(retirement as BindingRetirementEvidence) }),
    createdAt: Number(queryValue(row, 'created_at')),
    updatedAt: Number(queryValue(row, 'updated_at')),
  };
}

function rowChannel(row: QueryResultRow): ChannelRecord {
  return {
    platformId: String(queryValue(row, 'platform_id')),
    gameId: String(queryValue(row, 'game_id')),
    modeId: String(queryValue(row, 'mode_id')),
    channel: String(queryValue(row, 'channel')),
    revision: Number(queryValue(row, 'revision')),
    targetBackendBindingId: String(
      queryValue(row, 'target_backend_binding_id'),
    ),
    releaseId: String(queryValue(row, 'release_id')),
    storageBindingId: String(queryValue(row, 'storage_binding_id')),
    ownershipEpoch: String(queryValue(row, 'ownership_epoch')),
    operationId: String(queryValue(row, 'operation_id')),
    updatedAt: Number(queryValue(row, 'updated_at')),
  };
}

function jsonParameter(value: unknown): string {
  return JSON.stringify(value);
}

/** PostgreSQL implementation. Every state change is transactionally serialized. */
export class PostgresReleaseRegistryStore implements ReleaseRegistryStore {
  private readonly schema: string;
  private readonly releases: string;
  private readonly bindings: string;
  private readonly channels: string;
  private readonly operations: string;

  private readonly pool: Pool;

  constructor(pool: Pool, options?: { readonly schema?: string });
  constructor(options: { readonly pool: Pool; readonly schema?: string });
  constructor(
    poolOrOptions: Pool | { readonly pool: Pool; readonly schema?: string },
    options: { readonly schema?: string } = {},
  ) {
    this.pool = 'pool' in poolOrOptions ? poolOrOptions.pool : poolOrOptions;
    const schema =
      'pool' in poolOrOptions ? poolOrOptions.schema : options.schema;
    this.schema = schema ?? DEFAULT_RELEASE_REGISTRY_SCHEMA;
    this.releases = tableName(this.schema, 'releases');
    this.bindings = tableName(this.schema, 'bindings');
    this.channels = tableName(this.schema, 'channels');
    this.operations = tableName(this.schema, 'channel_operations');
  }

  async migrate(): Promise<void> {
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`board-platform-releases:migrations:${this.schema}`],
      );
      for (const statement of releaseRegistryMigrationStatements(this.schema))
        await client.query(statement);
      await client.query('COMMIT');
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => undefined);
      throw pgError(error);
    } finally {
      client?.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async transaction<T>(
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => undefined);
      throw pgError(error);
    } finally {
      client?.release();
    }
  }

  async registerRelease(input: RegisterReleaseInput): Promise<ReleaseRecord> {
    const candidate = releaseRecordFromInput(input);
    try {
      return await this.transaction(async (client) => {
        const existing = await client.query(
          `SELECT * FROM ${this.releases}
            WHERE platform_id = $1 AND game_id = $2 AND release_id = $3
            FOR UPDATE`,
          [candidate.platformId, candidate.gameId, candidate.releaseId],
        );
        if (existing.rowCount) {
          const record = rowRelease(existing.rows[0]);
          if (!releaseEqual(record, candidate))
            throw new ReleaseRegistryError(
              'CONFLICT',
              'release identity is immutable',
            );
          return record;
        }
        const result = await client.query(
          `INSERT INTO ${this.releases}
            (platform_id, game_id, release_id, manifest, service, manifest_digest,
             service_digest, approved_features, approved_modes, policy_bundle,
             policy_bundle_digest, approved_policy_versions, created_at)
           VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8::jsonb, $9::jsonb,
             $10::jsonb, $11, $12::jsonb, $13)
           ON CONFLICT (platform_id, game_id, release_id) DO NOTHING
           RETURNING *`,
          [
            candidate.platformId,
            candidate.gameId,
            candidate.releaseId,
            jsonParameter(candidate.manifest),
            jsonParameter(candidate.service),
            candidate.manifestDigest,
            candidate.serviceDigest,
            jsonParameter(candidate.approvedFeatures),
            jsonParameter(candidate.approvedModes),
            candidate.policyBundle === undefined
              ? null
              : jsonParameter(candidate.policyBundle),
            candidate.policyBundleDigest ?? null,
            candidate.approvedPolicyVersions === undefined
              ? null
              : jsonParameter(candidate.approvedPolicyVersions),
            candidate.createdAt,
          ],
        );
        if (result.rowCount) return rowRelease(result.rows[0]);
        const concurrent = await client.query(
          `SELECT * FROM ${this.releases}
            WHERE platform_id = $1 AND game_id = $2 AND release_id = $3
            FOR UPDATE`,
          [candidate.platformId, candidate.gameId, candidate.releaseId],
        );
        if (!concurrent.rowCount)
          throw new ReleaseRegistryError(
            'DATABASE_ERROR',
            'release insert did not return a durable row',
          );
        const record = rowRelease(concurrent.rows[0]);
        if (!releaseEqual(record, candidate))
          throw new ReleaseRegistryError(
            'CONFLICT',
            'release identity is immutable',
          );
        return record;
      });
    } catch (error) {
      throw pgError(error);
    }
  }

  async getRelease(
    platformId: string,
    gameId: string,
    releaseId: string,
  ): Promise<ReleaseRecord | null> {
    stringValue(platformId, 'platformId');
    stringValue(gameId, 'gameId');
    stringValue(releaseId, 'releaseId');
    try {
      const result = await this.pool.query(
        `SELECT * FROM ${this.releases}
          WHERE platform_id = $1 AND game_id = $2 AND release_id = $3`,
        [platformId, gameId, releaseId],
      );
      return result.rowCount ? rowRelease(result.rows[0]) : null;
    } catch (error) {
      throw pgError(error);
    }
  }

  async listReleases(
    platformId: string,
    gameId?: string,
  ): Promise<readonly ReleaseRecord[]> {
    stringValue(platformId, 'platformId');
    if (gameId !== undefined) stringValue(gameId, 'gameId');
    try {
      const result = await this.pool.query(
        `SELECT * FROM ${this.releases}
          WHERE platform_id = $1 AND ($2::text IS NULL OR game_id = $2)
          ORDER BY game_id, release_id`,
        [platformId, gameId ?? null],
      );
      return result.rows.map(rowRelease);
    } catch (error) {
      throw pgError(error);
    }
  }

  async registerBinding(
    input: RegisterBindingInput,
  ): Promise<ReleaseBindingRecord> {
    assertBindingInput(input);
    const createdAt = now(input.now);
    try {
      return await this.transaction(async (client) => {
        const releaseResult = await client.query(
          `SELECT * FROM ${this.releases}
            WHERE platform_id = $1 AND game_id = $2 AND release_id = $3
            FOR UPDATE`,
          [input.platformId, input.gameId, input.releaseId],
        );
        if (!releaseResult.rowCount)
          throw new ReleaseRegistryError('NOT_FOUND', 'release not found');
        const release = rowRelease(releaseResult.rows[0]);
        assertReleaseIdentityForBinding(release, input);
        const existing = await client.query(
          `SELECT * FROM ${this.bindings}
            WHERE platform_id = $1 AND backend_binding_id = $2
            FOR UPDATE`,
          [input.platformId, input.backendBindingId],
        );
        if (existing.rowCount) {
          const record = rowBinding(existing.rows[0]);
          const candidate = buildBinding(input, record.createdAt);
          if (!bindingIdentityEqual(record, candidate))
            throw new ReleaseRegistryError(
              'CONFLICT',
              'binding identity is immutable',
            );
          return record;
        }
        const result = await client.query(
          `INSERT INTO ${this.bindings}
            (platform_id, backend_binding_id, game_id, release_id, storage_binding_id,
             ownership_epoch, deployment, control_endpoint, player_endpoint,
             authorization_endpoint, client_artifact_base_url, service_credential_ref,
             status, revision, readiness, retirement, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'staged', 0, NULL, NULL, $13, $13)
           ON CONFLICT (platform_id, backend_binding_id) DO NOTHING
           RETURNING *`,
          [
            input.platformId,
            input.backendBindingId,
            input.gameId,
            input.releaseId,
            input.storageBindingId,
            input.ownershipEpoch,
            input.deployment,
            input.controlEndpoint,
            input.playerEndpoint,
            input.authorizationEndpoint ?? null,
            input.clientArtifactBaseUrl,
            input.serviceCredentialRef,
            createdAt,
          ],
        );
        if (result.rowCount) return rowBinding(result.rows[0]);
        const concurrent = await client.query(
          `SELECT * FROM ${this.bindings}
            WHERE platform_id = $1 AND backend_binding_id = $2
            FOR UPDATE`,
          [input.platformId, input.backendBindingId],
        );
        if (!concurrent.rowCount)
          throw new ReleaseRegistryError(
            'DATABASE_ERROR',
            'binding insert did not return a durable row',
          );
        const record = rowBinding(concurrent.rows[0]);
        const candidate = buildBinding(input, record.createdAt);
        if (!bindingIdentityEqual(record, candidate))
          throw new ReleaseRegistryError(
            'CONFLICT',
            'binding identity is immutable',
          );
        return record;
      });
    } catch (error) {
      throw pgError(error);
    }
  }

  async getBinding(
    platformId: string,
    backendBindingId: string,
  ): Promise<ReleaseBindingRecord | null> {
    stringValue(platformId, 'platformId');
    stringValue(backendBindingId, 'backendBindingId');
    try {
      const result = await this.pool.query(
        `SELECT * FROM ${this.bindings}
          WHERE platform_id = $1 AND backend_binding_id = $2`,
        [platformId, backendBindingId],
      );
      return result.rowCount ? rowBinding(result.rows[0]) : null;
    } catch (error) {
      throw pgError(error);
    }
  }

  async listBindings(
    platformId: string,
    gameId?: string,
  ): Promise<readonly ReleaseBindingRecord[]> {
    stringValue(platformId, 'platformId');
    if (gameId !== undefined) stringValue(gameId, 'gameId');
    try {
      const result = await this.pool.query(
        `SELECT * FROM ${this.bindings}
          WHERE platform_id = $1 AND ($2::text IS NULL OR game_id = $2)
          ORDER BY backend_binding_id`,
        [platformId, gameId ?? null],
      );
      return result.rows.map(rowBinding);
    } catch (error) {
      throw pgError(error);
    }
  }

  async updateBindingEndpoints(
    input: UpdateBindingEndpointsInput,
  ): Promise<ReleaseBindingRecord> {
    stringValue(input.platformId, 'platformId');
    stringValue(input.backendBindingId, 'backendBindingId');
    safeInteger(input.expectedRevision, 'expectedRevision');
    assertEndpoints(input);
    const updatedAt = now(input.now);
    try {
      return await this.transaction(async (client) => {
        const result = await client.query(
          `SELECT * FROM ${this.bindings}
            WHERE platform_id = $1 AND backend_binding_id = $2 FOR UPDATE`,
          [input.platformId, input.backendBindingId],
        );
        if (!result.rowCount)
          throw new ReleaseRegistryError('NOT_FOUND', 'binding not found');
        const binding = rowBinding(result.rows[0]);
        if (binding.revision !== input.expectedRevision)
          throw new ReleaseRegistryError(
            'REVISION_CONFLICT',
            'binding revision is stale',
          );
        const active = await client.query(
          `SELECT 1 FROM ${this.channels}
            WHERE platform_id = $1 AND target_backend_binding_id = $2 LIMIT 1`,
          [input.platformId, input.backendBindingId],
        );
        if (active.rowCount)
          throw new ReleaseRegistryError(
            'ACTIVE_CHANNEL',
            'active channel must move before physical endpoints change',
          );
        if (binding.status !== 'staged' && binding.status !== 'ready')
          throw new ReleaseRegistryError(
            'INVALID_STATE',
            'only staged or ready bindings may update endpoints',
          );
        const updated = await client.query(
          `UPDATE ${this.bindings}
              SET control_endpoint = $3, player_endpoint = $4,
                  authorization_endpoint = $5, client_artifact_base_url = $6,
                  service_credential_ref = $7,
                  status = 'staged', revision = revision + 1,
                  readiness = NULL, updated_at = $8
            WHERE platform_id = $1 AND backend_binding_id = $2
            RETURNING *`,
          [
            input.platformId,
            input.backendBindingId,
            input.controlEndpoint,
            input.playerEndpoint,
            input.authorizationEndpoint ??
              binding.authorizationEndpoint ??
              null,
            input.clientArtifactBaseUrl,
            input.serviceCredentialRef,
            updatedAt,
          ],
        );
        return rowBinding(updated.rows[0]);
      });
    } catch (error) {
      throw pgError(error);
    }
  }

  async recordBindingReadiness(input: {
    readonly platformId: string;
    readonly backendBindingId: string;
    readonly evidence: BindingReadinessEvidence;
    readonly expectedRevision?: number;
    readonly now?: number;
  }): Promise<ReleaseBindingRecord> {
    stringValue(input.platformId, 'platformId');
    stringValue(input.backendBindingId, 'backendBindingId');
    const updatedAt = now(input.now);
    try {
      return await this.transaction(async (client) => {
        const result = await client.query(
          `SELECT * FROM ${this.bindings}
            WHERE platform_id = $1 AND backend_binding_id = $2 FOR UPDATE`,
          [input.platformId, input.backendBindingId],
        );
        if (!result.rowCount)
          throw new ReleaseRegistryError('NOT_FOUND', 'binding not found');
        const binding = rowBinding(result.rows[0]);
        if (
          input.expectedRevision !== undefined &&
          binding.revision !== input.expectedRevision
        )
          throw new ReleaseRegistryError(
            'REVISION_CONFLICT',
            'binding revision changed while readiness was probed',
          );
        const releaseResult = await client.query(
          `SELECT * FROM ${this.releases}
            WHERE platform_id = $1 AND game_id = $2 AND release_id = $3`,
          [input.platformId, binding.gameId, binding.releaseId],
        );
        if (!releaseResult.rowCount)
          throw new ReleaseRegistryError('NOT_FOUND', 'release not found');
        const release = rowRelease(releaseResult.rows[0]);
        validateReadinessAgainstBinding(release, binding, input.evidence);
        if (binding.status !== 'staged' && binding.status !== 'ready')
          throw new ReleaseRegistryError(
            'INVALID_STATE',
            'binding is not eligible for readiness',
          );
        if (binding.status === 'ready') {
          if (
            canonicalStableStringify(binding.readiness) !==
            canonicalStableStringify(input.evidence)
          )
            throw new ReleaseRegistryError(
              'CONFLICT',
              'ready binding already has different readiness evidence',
            );
          return binding;
        }
        const updated = await client.query(
          `UPDATE ${this.bindings}
              SET status = 'ready', revision = revision + 1,
                  readiness = $3::jsonb, updated_at = $4
            WHERE platform_id = $1 AND backend_binding_id = $2
            RETURNING *`,
          [
            input.platformId,
            input.backendBindingId,
            jsonParameter(input.evidence),
            updatedAt,
          ],
        );
        return rowBinding(updated.rows[0]);
      });
    } catch (error) {
      throw pgError(error);
    }
  }

  async drainBinding(
    input: ChangeBindingStateInput,
  ): Promise<ReleaseBindingRecord> {
    return this.changeBindingState(input, 'draining');
  }

  async retainBinding(
    input: ChangeBindingStateInput,
  ): Promise<ReleaseBindingRecord> {
    return this.changeBindingState(input, 'retained');
  }

  private async changeBindingState(
    input: ChangeBindingStateInput,
    target: 'draining' | 'retained',
  ): Promise<ReleaseBindingRecord> {
    stringValue(input.platformId, 'platformId');
    stringValue(input.backendBindingId, 'backendBindingId');
    const updatedAt = now(input.now);
    try {
      return await this.transaction(async (client) => {
        const result = await client.query(
          `SELECT * FROM ${this.bindings}
            WHERE platform_id = $1 AND backend_binding_id = $2 FOR UPDATE`,
          [input.platformId, input.backendBindingId],
        );
        if (!result.rowCount)
          throw new ReleaseRegistryError('NOT_FOUND', 'binding not found');
        const binding = rowBinding(result.rows[0]);
        if (target === 'draining') {
          const active = await client.query(
            `SELECT 1 FROM ${this.channels}
              WHERE platform_id = $1 AND target_backend_binding_id = $2 LIMIT 1`,
            [input.platformId, input.backendBindingId],
          );
          if (active.rowCount)
            throw new ReleaseRegistryError(
              'ACTIVE_CHANNEL',
              'binding is still active for new admissions',
            );
        }
        if (binding.status === target) return binding;
        assertStatusTransition(binding.status, target);
        const updated = await client.query(
          `UPDATE ${this.bindings}
              SET status = $3, revision = revision + 1, updated_at = $4
            WHERE platform_id = $1 AND backend_binding_id = $2
            RETURNING *`,
          [input.platformId, input.backendBindingId, target, updatedAt],
        );
        return rowBinding(updated.rows[0]);
      });
    } catch (error) {
      throw pgError(error);
    }
  }

  async retireBinding(
    input: RetireBindingInput,
  ): Promise<ReleaseBindingRecord> {
    stringValue(input.platformId, 'platformId');
    stringValue(input.backendBindingId, 'backendBindingId');
    const updatedAt = now(input.now);
    try {
      return await this.transaction(async (client) => {
        const result = await client.query(
          `SELECT * FROM ${this.bindings}
            WHERE platform_id = $1 AND backend_binding_id = $2 FOR UPDATE`,
          [input.platformId, input.backendBindingId],
        );
        if (!result.rowCount)
          throw new ReleaseRegistryError('NOT_FOUND', 'binding not found');
        const binding = rowBinding(result.rows[0]);
        if (binding.status === 'retired') return binding;
        const active = await client.query(
          `SELECT 1 FROM ${this.channels}
            WHERE platform_id = $1 AND target_backend_binding_id = $2 LIMIT 1`,
          [input.platformId, input.backendBindingId],
        );
        if (active.rowCount)
          throw new ReleaseRegistryError(
            'ACTIVE_CHANNEL',
            'binding is still active for new admissions',
          );
        let replacement: ReleaseBindingRecord | null = null;
        if (input.evidence.replay.status === 'replacement-ready') {
          const replacementResult = await client.query(
            `SELECT * FROM ${this.bindings}
              WHERE platform_id = $1 AND backend_binding_id = $2`,
            [input.platformId, input.evidence.replay.replacementBindingId],
          );
          replacement = replacementResult.rowCount
            ? rowBinding(replacementResult.rows[0])
            : null;
        }
        validateRetirementReplacement(
          input.evidence,
          replacement,
          input.backendBindingId,
          binding.gameId,
        );
        assertStatusTransition(binding.status, 'retired');
        const updated = await client.query(
          `UPDATE ${this.bindings}
              SET status = 'retired', revision = revision + 1,
                  retirement = $3::jsonb, updated_at = $4
            WHERE platform_id = $1 AND backend_binding_id = $2
            RETURNING *`,
          [
            input.platformId,
            input.backendBindingId,
            jsonParameter(input.evidence),
            updatedAt,
          ],
        );
        return rowBinding(updated.rows[0]);
      });
    } catch (error) {
      throw pgError(error);
    }
  }

  async listChannels(platformId: string): Promise<readonly ChannelRecord[]> {
    stringValue(platformId, 'platformId');
    try {
      const result = await this.pool.query(
        `SELECT * FROM ${this.channels}
          WHERE platform_id = $1 ORDER BY game_id, mode_id, channel`,
        [platformId],
      );
      return result.rows.map(rowChannel);
    } catch (error) {
      throw pgError(error);
    }
  }

  async listChannelHistory(
    platformId: string,
    limit = 100,
  ): Promise<readonly ChannelRecord[]> {
    stringValue(platformId, 'platformId');
    historyLimit(limit);
    try {
      const result = await this.pool.query(
        `SELECT result FROM ${this.operations}
          WHERE platform_id = $1 ORDER BY created_at DESC, operation_id DESC LIMIT $2`,
        [platformId, limit],
      );
      return result.rows.map((row) => copy(row.result as ChannelRecord));
    } catch (error) {
      throw pgError(error);
    }
  }

  async getChannel(
    platformId: string,
    gameId: string,
    modeId: string,
    channel: string,
  ): Promise<ChannelRecord | null> {
    stringValue(platformId, 'platformId');
    stringValue(gameId, 'gameId');
    stringValue(modeId, 'modeId');
    stringValue(channel, 'channel');
    try {
      const result = await this.pool.query(
        `SELECT * FROM ${this.channels}
          WHERE platform_id = $1 AND game_id = $2 AND mode_id = $3 AND channel = $4`,
        [platformId, gameId, modeId, channel],
      );
      return result.rowCount ? rowChannel(result.rows[0]) : null;
    } catch (error) {
      throw pgError(error);
    }
  }

  async compareAndSwapChannel(
    input: CompareAndSwapChannelInput,
  ): Promise<ChannelRecord> {
    validateChannelInput(input);
    try {
      return await this.transaction(async (client) => {
        const inputDigest = channelInputDigest(input);
        const operationResult = await client.query(
          `SELECT request_digest, result FROM ${this.operations}
            WHERE platform_id = $1 AND operation_id = $2 FOR UPDATE`,
          [input.platformId, input.operationId],
        );
        if (operationResult.rowCount) {
          const existingDigest = String(operationResult.rows[0].request_digest);
          if (existingDigest !== inputDigest)
            throw new ReleaseRegistryError(
              'CONFLICT',
              'operationId was already used for another channel operation',
            );
          return copy(operationResult.rows[0].result as ChannelRecord);
        }
        const bindingResult = await client.query(
          `SELECT * FROM ${this.bindings}
            WHERE platform_id = $1 AND backend_binding_id = $2 FOR UPDATE`,
          [input.platformId, input.targetBackendBindingId],
        );
        if (!bindingResult.rowCount)
          throw new ReleaseRegistryError('NOT_FOUND', 'binding not found');
        const confirmedOperation = await client.query(
          `SELECT request_digest, result FROM ${this.operations}
            WHERE platform_id = $1 AND operation_id = $2 FOR UPDATE`,
          [input.platformId, input.operationId],
        );
        if (confirmedOperation.rowCount) {
          const existingDigest = String(
            confirmedOperation.rows[0].request_digest,
          );
          if (existingDigest !== inputDigest)
            throw new ReleaseRegistryError(
              'CONFLICT',
              'operationId was already used for another channel operation',
            );
          return copy(confirmedOperation.rows[0].result as ChannelRecord);
        }
        const binding = rowBinding(bindingResult.rows[0]);
        if (binding.gameId !== input.gameId)
          throw new ReleaseRegistryError(
            'CONFLICT',
            'binding game does not match channel',
          );
        const releaseResult = await client.query(
          `SELECT * FROM ${this.releases}
            WHERE platform_id = $1 AND game_id = $2 AND release_id = $3`,
          [input.platformId, binding.gameId, binding.releaseId],
        );
        if (!releaseResult.rowCount)
          throw new ReleaseRegistryError('NOT_FOUND', 'release not found');
        const release = rowRelease(releaseResult.rows[0]);
        if (!release.approvedModes.includes(input.modeId))
          throw new ReleaseRegistryError(
            'CONFLICT',
            'mode is not approved for this release',
          );
        if (binding.status !== 'ready')
          throw new ReleaseRegistryError(
            'NOT_READY',
            'channel target binding is not ready',
          );
        const currentResult = await client.query(
          `SELECT * FROM ${this.channels}
            WHERE platform_id = $1 AND game_id = $2 AND mode_id = $3 AND channel = $4 FOR UPDATE`,
          [input.platformId, input.gameId, input.modeId, input.channel],
        );
        const current = currentResult.rowCount
          ? rowChannel(currentResult.rows[0])
          : null;
        const currentRevision = current?.revision ?? 0;
        if (input.expectedRevision !== currentRevision)
          throw new ReleaseRegistryError(
            'REVISION_CONFLICT',
            'channel revision is stale',
          );
        const updatedAt = now(input.now);
        const result: ChannelRecord = {
          platformId: input.platformId,
          gameId: input.gameId,
          modeId: input.modeId,
          channel: input.channel,
          revision: currentRevision + 1,
          targetBackendBindingId: binding.backendBindingId,
          releaseId: binding.releaseId,
          storageBindingId: binding.storageBindingId,
          ownershipEpoch: binding.ownershipEpoch,
          operationId: input.operationId,
          updatedAt,
        };
        await client.query(
          `INSERT INTO ${this.channels}
            (platform_id, game_id, mode_id, channel, revision, target_backend_binding_id,
             release_id, storage_binding_id, ownership_epoch, operation_id, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (platform_id, game_id, mode_id, channel)
           DO UPDATE SET revision = EXCLUDED.revision,
             target_backend_binding_id = EXCLUDED.target_backend_binding_id,
             release_id = EXCLUDED.release_id,
             storage_binding_id = EXCLUDED.storage_binding_id,
             ownership_epoch = EXCLUDED.ownership_epoch,
             operation_id = EXCLUDED.operation_id,
             updated_at = EXCLUDED.updated_at`,
          [
            input.platformId,
            input.gameId,
            input.modeId,
            input.channel,
            result.revision,
            result.targetBackendBindingId,
            result.releaseId,
            result.storageBindingId,
            result.ownershipEpoch,
            result.operationId,
            result.updatedAt,
          ],
        );
        await client.query(
          `INSERT INTO ${this.operations}
            (platform_id, operation_id, request_digest, result, created_at)
           VALUES ($1, $2, $3, $4::jsonb, $5)`,
          [
            input.platformId,
            input.operationId,
            inputDigest,
            jsonParameter(result),
            updatedAt,
          ],
        );
        return result;
      });
    } catch (error) {
      throw pgError(error);
    }
  }
}
