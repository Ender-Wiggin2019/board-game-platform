import type { SessionRoute } from '@board-game/contracts';
import {
  assertClientReleaseLocator,
  assertGameServiceDescription,
  assertJsonPayloadSize,
  assertReleaseManifest,
  type ClientReleaseLocator,
  contractError,
  type GamePolicyVersion,
  type GameServiceDescription,
  type JsonValue,
  type ModeDefinition,
  publicReleaseManifest,
  type ReleaseManifest,
} from '@board-game/contracts';
import type { PlatformIdentityReference } from '@board-game/core';
import type { PlatformApplicationRuntime } from './PlatformApplicationRuntime.js';
import {
  type ChannelRecord,
  type CompareAndSwapChannelInput,
  type DesiredGameInstallation,
  type ReleaseBindingRecord,
  type ReleaseRecord,
  ReleaseRegistryError,
  type UpdateBindingEndpointsInput,
} from './releases/types.js';

export interface RegisterStagedReleaseInput {
  readonly manifest: ReleaseManifest;
  readonly service: GameServiceDescription;
  readonly approvedFeatures: readonly string[];
  readonly approvedModes: readonly string[];
  readonly policyBundle?: JsonValue;
  readonly approvedPolicyVersions?: readonly GamePolicyVersion[];
  readonly binding: {
    readonly deployment: 'managed' | 'external';
    readonly controlEndpoint: string;
    readonly playerEndpoint: string;
    readonly authorizationEndpoint?: string;
    readonly clientArtifactBaseUrl: string;
    readonly serviceCredentialRef: string;
  };
}

export interface ReleaseCatalogEntry {
  readonly gameId: string;
  readonly releaseId: string;
  readonly displayVersion: string;
  readonly metadata: GameServiceDescription['metadata'];
  readonly manifest: ReturnType<typeof publicReleaseManifest>;
  readonly bindings: readonly {
    readonly backendBindingId: string;
  }[];
}

export interface PlatformCatalogEntry {
  readonly gameId: string;
  readonly releaseId: string;
  readonly mode: ModeDefinition;
  readonly metadata: GameServiceDescription['metadata'];
}

export interface InstallationDifference {
  readonly gameId: string;
  readonly modeId?: string;
  readonly kind:
    | 'missing-release'
    | 'missing-ready-binding'
    | 'missing-stable-channel'
    | 'channel-release-mismatch'
    | 'deployment-mismatch'
    | 'disabled-active-channel'
    | 'unconfigured-active-channel';
  readonly expected: string | null;
  readonly actual: string | null;
}

export interface ReleaseReconciliation {
  readonly schemaVersion: 1;
  readonly platformId: string;
  readonly generatedAt: number;
  readonly desiredConfigured: boolean;
  readonly desired: readonly DesiredGameInstallation[];
  readonly actual: {
    readonly releases: readonly ReleaseRecord[];
    readonly bindings: readonly ReleaseBindingRecord[];
    readonly channels: readonly ChannelRecord[];
  };
  readonly differences: readonly InstallationDifference[];
  readonly channelHistory: readonly ChannelRecord[];
}

const DEFAULT_ADMISSION_CHANNEL = 'stable';

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function keys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const accepted = new Set(allowed);
  if (Object.keys(value).some((key) => !accepted.has(key)))
    throw contractError('INVALID_REQUEST', 'platform.release.request_invalid');
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256)
    throw contractError('INVALID_REQUEST', 'platform.request.identifier');
  return value;
}

function stringList(value: unknown, field: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > 256 ||
    value.some(
      (item) =>
        typeof item !== 'string' || item.length < 1 || item.length > 256,
    )
  )
    throw contractError('INVALID_REQUEST', `platform.release.${field}`);
  if (new Set(value).size !== value.length)
    throw contractError('INVALID_REQUEST', `platform.release.${field}`);
  return [...value] as string[];
}

function stagedInput(value: unknown): RegisterStagedReleaseInput {
  assertJsonPayloadSize(value, 256 * 1024);
  if (!isObject(value))
    throw contractError('INVALID_REQUEST', 'platform.release.request_invalid');
  keys(value, [
    'manifest',
    'service',
    'approvedFeatures',
    'approvedModes',
    'policyBundle',
    'approvedPolicyVersions',
    'binding',
  ]);
  assertReleaseManifest(value.manifest);
  assertGameServiceDescription(value.service);
  if (
    value.service.modes.some((mode) => mode.platformRating) &&
    (value.policyBundle === undefined ||
      !Array.isArray(value.approvedPolicyVersions) ||
      value.approvedPolicyVersions.length === 0)
  )
    throw contractError(
      'INVALID_REQUEST',
      'platform.release.settlement_policy_approval_required',
    );
  if (value.policyBundle !== undefined) {
    assertJsonPayloadSize(value.policyBundle, 512 * 1024);
    if (!isObject(value.policyBundle))
      throw contractError(
        'INVALID_REQUEST',
        'platform.release.policy_bundle_invalid',
      );
  }
  if (!isObject(value.binding))
    throw contractError('INVALID_REQUEST', 'platform.release.binding_invalid');
  keys(value.binding, [
    'deployment',
    'controlEndpoint',
    'playerEndpoint',
    'authorizationEndpoint',
    'clientArtifactBaseUrl',
    'serviceCredentialRef',
  ]);
  if (
    value.binding.deployment !== 'managed' &&
    value.binding.deployment !== 'external'
  )
    throw contractError(
      'INVALID_REQUEST',
      'platform.release.deployment_invalid',
    );
  const controlEndpoint = identifier(value.binding.controlEndpoint);
  const playerEndpoint = identifier(value.binding.playerEndpoint);
  const authorizationEndpoint =
    value.binding.authorizationEndpoint === undefined
      ? undefined
      : identifier(value.binding.authorizationEndpoint);
  const clientArtifactBaseUrl = identifier(value.binding.clientArtifactBaseUrl);
  const serviceCredentialRef = identifier(value.binding.serviceCredentialRef);
  return {
    manifest: value.manifest,
    service: value.service,
    approvedFeatures: stringList(value.approvedFeatures, 'features_invalid'),
    approvedModes: stringList(value.approvedModes, 'modes_invalid'),
    ...(value.policyBundle === undefined
      ? {}
      : { policyBundle: value.policyBundle as JsonValue }),
    ...(value.approvedPolicyVersions === undefined
      ? {}
      : {
          approvedPolicyVersions:
            value.approvedPolicyVersions as unknown as GamePolicyVersion[],
        }),
    binding: {
      deployment: value.binding.deployment,
      controlEndpoint,
      playerEndpoint,
      ...(authorizationEndpoint === undefined ? {} : { authorizationEndpoint }),
      clientArtifactBaseUrl,
      serviceCredentialRef,
    },
  };
}

function updateBindingEndpointsInput(
  value: unknown,
  platform: string,
  backendBindingId: string,
): UpdateBindingEndpointsInput {
  assertJsonPayloadSize(value, 64 * 1024);
  if (!isObject(value))
    throw contractError('INVALID_REQUEST', 'platform.release.request_invalid');
  keys(value, [
    'expectedRevision',
    'controlEndpoint',
    'playerEndpoint',
    'authorizationEndpoint',
    'clientArtifactBaseUrl',
    'serviceCredentialRef',
  ]);
  if (
    !Number.isSafeInteger(value.expectedRevision) ||
    (value.expectedRevision as number) < 0
  )
    throw contractError('INVALID_REQUEST', 'platform.request.revision');
  const authorizationEndpoint =
    value.authorizationEndpoint === undefined
      ? undefined
      : identifier(value.authorizationEndpoint);
  return {
    platformId: platform,
    backendBindingId: identifier(backendBindingId),
    expectedRevision: value.expectedRevision as number,
    controlEndpoint: identifier(value.controlEndpoint),
    playerEndpoint: identifier(value.playerEndpoint),
    ...(authorizationEndpoint === undefined ? {} : { authorizationEndpoint }),
    clientArtifactBaseUrl: identifier(value.clientArtifactBaseUrl),
    serviceCredentialRef: identifier(value.serviceCredentialRef),
  };
}

function registryError(error: unknown): never {
  if (!(error instanceof ReleaseRegistryError)) throw error;
  const code =
    error.code === 'INVALID_ARGUMENT'
      ? 'INVALID_REQUEST'
      : error.code === 'NOT_FOUND'
        ? 'NOT_FOUND'
        : error.code === 'NOT_READY'
          ? 'NOT_READY'
          : error.code === 'MIGRATION_REQUIRED' ||
              error.code === 'DATABASE_ERROR'
            ? 'INTERNAL'
            : 'CONFLICT';
  throw contractError(
    code,
    `platform.release.${error.code.toLowerCase()}`,
    error.retryable,
  );
}

function registryOf(
  runtime: PlatformApplicationRuntime,
): NonNullable<PlatformApplicationRuntime['releaseRegistry']> {
  if (!runtime.releaseRegistry || !runtime.options.platformId)
    throw contractError('NOT_READY', 'platform.remote.registry_unavailable');
  return runtime.releaseRegistry;
}

function platformId(runtime: PlatformApplicationRuntime): string {
  if (!runtime.options.platformId)
    throw contractError('NOT_READY', 'platform.remote.platform_id_required');
  return runtime.options.platformId;
}

export class PlatformReleaseAdministration {
  constructor(private readonly runtime: PlatformApplicationRuntime) {}

  async registerStaged(value: unknown): Promise<{
    readonly release: ReleaseRecord;
    readonly binding: ReleaseBindingRecord;
  }> {
    const input = stagedInput(value);
    const id = platformId(this.runtime);
    const registry = registryOf(this.runtime);
    try {
      const release = await registry.registerRelease({
        platformId: id,
        manifest: input.manifest,
        service: input.service,
        approvedFeatures: input.approvedFeatures,
        approvedModes: input.approvedModes,
        ...(input.policyBundle === undefined
          ? {}
          : { policyBundle: input.policyBundle }),
        ...(input.approvedPolicyVersions === undefined
          ? {}
          : { approvedPolicyVersions: input.approvedPolicyVersions }),
      });
      const binding = await registry.registerBinding({
        platformId: id,
        gameId: release.gameId,
        releaseId: release.releaseId,
        backendBindingId: release.service.backendBindingId,
        storageBindingId: release.service.storageBindingId,
        ownershipEpoch: release.service.ownershipEpoch,
        ...input.binding,
      });
      return { release, binding };
    } catch (error) {
      registryError(error);
    }
  }

  ready(backendBindingId: string): Promise<ReleaseBindingRecord> {
    return this.runtime
      .readyRemoteBinding(identifier(backendBindingId))
      .catch((error) => registryError(error));
  }

  updateBindingEndpoints(
    backendBindingId: string,
    value: unknown,
  ): Promise<ReleaseBindingRecord> {
    const input = updateBindingEndpointsInput(
      value,
      platformId(this.runtime),
      backendBindingId,
    );
    const registry = registryOf(this.runtime);
    return registry
      .updateBindingEndpoints(input)
      .then((binding) => {
        this.runtime.refreshRemoteBindingMetadata?.(binding);
        return binding;
      })
      .catch((error) => registryError(error));
  }

  switchChannel(value: unknown): Promise<ChannelRecord> {
    assertJsonPayloadSize(value, 64 * 1024);
    if (!isObject(value))
      throw contractError(
        'INVALID_REQUEST',
        'platform.release.request_invalid',
      );
    keys(value, [
      'gameId',
      'modeId',
      'channel',
      'expectedRevision',
      'targetBackendBindingId',
      'operationId',
    ]);
    if (
      !Number.isSafeInteger(value.expectedRevision) ||
      (value.expectedRevision as number) < 0
    )
      throw contractError('INVALID_REQUEST', 'platform.request.revision');
    const input: CompareAndSwapChannelInput = {
      platformId: platformId(this.runtime),
      gameId: identifier(value.gameId),
      modeId: identifier(value.modeId),
      channel: identifier(value.channel),
      expectedRevision: value.expectedRevision as number,
      targetBackendBindingId: identifier(value.targetBackendBindingId),
      operationId: identifier(value.operationId),
    };
    return this.runtime
      .switchRemoteChannel(input)
      .catch((error) => registryError(error));
  }

  drain(backendBindingId: string): Promise<ReleaseBindingRecord> {
    return this.changeBinding('drainBinding', backendBindingId);
  }

  disable(backendBindingId: string): Promise<ReleaseBindingRecord> {
    return this.drain(backendBindingId);
  }

  retain(backendBindingId: string): Promise<ReleaseBindingRecord> {
    return this.changeBinding('retainBinding', backendBindingId);
  }

  private changeBinding(
    operation: 'drainBinding' | 'retainBinding',
    backendBindingId: string,
  ): Promise<ReleaseBindingRecord> {
    const registry = registryOf(this.runtime);
    return registry[operation]({
      platformId: platformId(this.runtime),
      backendBindingId: identifier(backendBindingId),
    })
      .then((binding) => {
        this.runtime.refreshRemoteBindingMetadata?.(binding);
        return binding;
      })
      .catch((error) => registryError(error));
  }

  async adminList(): Promise<
    readonly {
      readonly release: ReleaseRecord;
      readonly bindings: readonly ReleaseBindingRecord[];
    }[]
  > {
    const registry = registryOf(this.runtime);
    const id = platformId(this.runtime);
    try {
      const releases = await registry.listReleases(id);
      const bindings = await registry.listBindings(id);
      return releases.map((release) => ({
        release,
        bindings: bindings.filter(
          (binding) =>
            binding.gameId === release.gameId &&
            binding.releaseId === release.releaseId,
        ),
      }));
    } catch (error) {
      registryError(error);
    }
  }

  /** Observed registry state and file intent; this never mutates either source. */
  async reconciliation(): Promise<ReleaseReconciliation> {
    const registry = registryOf(this.runtime);
    const id = platformId(this.runtime);
    try {
      const [releases, bindings, channels, channelHistory] = await Promise.all([
        registry.listReleases(id),
        registry.listBindings(id),
        registry.listChannels(id),
        registry.listChannelHistory(id),
      ]);
      const configured = this.runtime.options.desiredGameInstallations;
      const desired = structuredClone(configured ?? []);
      const differences: InstallationDifference[] = [];
      const stable = channels.filter(
        (channel) => channel.channel === DEFAULT_ADMISSION_CHANNEL,
      );
      for (const game of desired) {
        const release = releases.find(
          (entry) =>
            entry.gameId === game.gameId && entry.releaseId === game.releaseId,
        );
        if (!release) {
          differences.push({
            gameId: game.gameId,
            kind: 'missing-release',
            expected: game.releaseId,
            actual: null,
          });
        }
        if (!game.enabled) {
          for (const channel of stable.filter(
            (entry) => entry.gameId === game.gameId,
          )) {
            differences.push({
              gameId: game.gameId,
              modeId: channel.modeId,
              kind: 'disabled-active-channel',
              expected: null,
              actual: channel.releaseId,
            });
          }
          continue;
        }
        if (
          !bindings.some(
            (binding) =>
              binding.gameId === game.gameId &&
              binding.releaseId === game.releaseId &&
              binding.deployment === game.deployment &&
              binding.status === 'ready',
          )
        ) {
          differences.push({
            gameId: game.gameId,
            kind: 'missing-ready-binding',
            expected: `${game.releaseId}/${game.deployment}`,
            actual: null,
          });
        }
        for (const modeId of release?.approvedModes ?? []) {
          const channel = stable.find(
            (entry) => entry.gameId === game.gameId && entry.modeId === modeId,
          );
          if (!channel || channel.releaseId !== game.releaseId) {
            differences.push({
              gameId: game.gameId,
              modeId,
              kind: channel
                ? 'channel-release-mismatch'
                : 'missing-stable-channel',
              expected: game.releaseId,
              actual: channel?.releaseId ?? null,
            });
          }
          const binding = bindings.find(
            (entry) =>
              entry.backendBindingId === channel?.targetBackendBindingId,
          );
          if (binding && binding.deployment !== game.deployment) {
            differences.push({
              gameId: game.gameId,
              modeId,
              kind: 'deployment-mismatch',
              expected: game.deployment,
              actual: binding.deployment,
            });
          }
        }
      }
      if (configured !== undefined) {
        for (const channel of stable) {
          if (desired.some((game) => game.gameId === channel.gameId)) continue;
          differences.push({
            gameId: channel.gameId,
            modeId: channel.modeId,
            kind: 'unconfigured-active-channel',
            expected: null,
            actual: channel.releaseId,
          });
        }
      }
      return {
        schemaVersion: 1,
        platformId: id,
        generatedAt: Date.now(),
        desiredConfigured: configured !== undefined,
        desired,
        actual: { releases, bindings, channels },
        differences,
        channelHistory,
      };
    } catch (error) {
      registryError(error);
    }
  }

  async catalog(): Promise<
    | readonly ReleaseCatalogEntry[]
    | ReturnType<PlatformApplicationRuntime['catalog']>
  > {
    if (!this.runtime.releaseRegistry || !this.runtime.options.platformId)
      return this.runtime.catalog();
    const registry = registryOf(this.runtime);
    const id = platformId(this.runtime);
    try {
      const [releases, bindings] = await Promise.all([
        registry.listReleases(id),
        registry.listBindings(id),
      ]);
      const ready = bindings.filter((binding) => binding.status === 'ready');
      const result: ReleaseCatalogEntry[] = [];
      for (const release of releases) {
        const releaseBindings = ready.filter(
          (binding) =>
            binding.gameId === release.gameId &&
            binding.releaseId === release.releaseId,
        );
        if (releaseBindings.length === 0) continue;
        result.push({
          gameId: release.gameId,
          releaseId: release.releaseId,
          displayVersion: release.manifest.displayVersion,
          metadata: release.service.metadata,
          manifest: publicReleaseManifest(release.manifest, {
            approvedFeatures: release.approvedFeatures,
            runtimeFeatures: release.approvedFeatures,
            approvedModes: release.approvedModes,
            runtimeModes: release.service.modes.map((mode) => mode.id),
          }),
          bindings: releaseBindings.map((binding) => ({
            backendBindingId: binding.backendBindingId,
          })),
        });
      }
      return result;
    } catch (error) {
      registryError(error);
    }
  }

  /**
   * Public room/direct-session catalog. Registry-backed releases are listed
   * only when the durable default channel points at a ready binding for that
   * exact mode; a ready binding that is not selected for new admissions is not
   * advertised here.
   */
  async platformCatalog(): Promise<
    | readonly PlatformCatalogEntry[]
    | ReturnType<PlatformApplicationRuntime['catalog']>
  > {
    if (!this.runtime.releaseRegistry || !this.runtime.options.platformId)
      return this.runtime.catalog();
    const registry = registryOf(this.runtime);
    const id = platformId(this.runtime);
    try {
      const releases = await registry.listReleases(id);
      const entries: PlatformCatalogEntry[] = [];
      for (const release of releases) {
        for (const mode of release.service.modes) {
          if (!release.approvedModes.includes(mode.id)) continue;
          const channel = await registry.getChannel(
            id,
            release.gameId,
            mode.id,
            DEFAULT_ADMISSION_CHANNEL,
          );
          if (!channel || channel.releaseId !== release.releaseId) continue;
          const binding = await registry.getBinding(
            id,
            channel.targetBackendBindingId,
          );
          if (
            !binding ||
            binding.status !== 'ready' ||
            binding.gameId !== release.gameId ||
            binding.releaseId !== release.releaseId ||
            binding.storageBindingId !== channel.storageBindingId ||
            binding.ownershipEpoch !== channel.ownershipEpoch
          )
            continue;
          entries.push({
            gameId: release.gameId,
            releaseId: release.releaseId,
            mode: structuredClone(mode),
            metadata: structuredClone(release.service.metadata),
          });
        }
      }
      return entries;
    } catch (error) {
      registryError(error);
    }
  }

  async clientLocator(
    gameId: string,
    releaseId: string,
    backendBindingId: string,
    options: { readonly allowRetained?: boolean } = {},
  ): Promise<ClientReleaseLocator> {
    const registry = registryOf(this.runtime);
    const id = platformId(this.runtime);
    let release: ReleaseRecord | null;
    let binding: ReleaseBindingRecord | null;
    try {
      [release, binding] = await Promise.all([
        registry.getRelease(id, identifier(gameId), identifier(releaseId)),
        registry.getBinding(id, identifier(backendBindingId)),
      ]);
    } catch (error) {
      registryError(error);
    }
    if (!release || !binding)
      throw contractError('NOT_FOUND', 'platform.client.release_unavailable');
    if (
      binding.gameId !== release.gameId ||
      binding.releaseId !== release.releaseId
    )
      throw contractError('CONFLICT', 'platform.client.binding_mismatch');
    if (binding.status === 'retired')
      throw contractError('CONFLICT', 'platform.client.release_retired');
    if (
      binding.status !== 'ready' &&
      !(
        options.allowRetained === true &&
        (binding.status === 'draining' || binding.status === 'retained')
      )
    )
      throw contractError('NOT_READY', 'platform.client.release_unready');
    if (!release.manifest.clientRuntime)
      throw contractError('NOT_READY', 'platform.client.runtime_unavailable');
    const clientDigest = release.manifest.artifacts.client.digest;
    const suffix = `${encodeURIComponent(release.gameId)}/${encodeURIComponent(
      release.releaseId,
    )}/${clientDigest.slice(7)}/`;
    let base: URL;
    try {
      base = new URL(binding.clientArtifactBaseUrl);
    } catch {
      throw contractError('INVALID_REQUEST', 'client.artifact.url_invalid');
    }
    if (!base.pathname.endsWith('/')) base.pathname += '/';
    if (!base.pathname.endsWith(suffix)) base.pathname += suffix;
    const locator: ClientReleaseLocator = {
      schemaVersion: 1,
      gameId: release.gameId,
      releaseId: release.releaseId,
      clientDigest,
      publicAssetsDigest: release.manifest.artifacts.publicAssets.digest,
      baseUrl: base.href,
      runtime: structuredClone(release.manifest.clientRuntime),
    };
    assertClientReleaseLocator(
      locator,
      this.runtime.options.allowInsecureLocalhost === true,
    );
    return locator;
  }

  /**
   * Return the JSON-only service contract for one verified release binding.
   * Credentials and endpoint references stay in the administrative record;
   * this projection is consumed by isolated clients to build their iframe
   * entry without evaluating game code in the platform shell.
   */
  async serviceDescription(
    gameId: string,
    releaseId: string,
    backendBindingId: string,
  ): Promise<GameServiceDescription> {
    const registry = registryOf(this.runtime);
    const id = platformId(this.runtime);
    let release: ReleaseRecord | null;
    let binding: ReleaseBindingRecord | null;
    try {
      [release, binding] = await Promise.all([
        registry.getRelease(id, identifier(gameId), identifier(releaseId)),
        registry.getBinding(id, identifier(backendBindingId)),
      ]);
    } catch (error) {
      registryError(error);
    }
    if (!release || !binding)
      throw contractError('NOT_FOUND', 'platform.client.release_unavailable');
    if (
      binding.gameId !== release.gameId ||
      binding.releaseId !== release.releaseId ||
      binding.storageBindingId !== release.service.storageBindingId ||
      binding.ownershipEpoch !== release.service.ownershipEpoch ||
      binding.backendBindingId !== release.service.backendBindingId
    )
      throw contractError('CONFLICT', 'platform.client.binding_mismatch');
    if (binding.status === 'retired')
      throw contractError('CONFLICT', 'platform.client.release_retired');
    if (
      binding.status !== 'ready' &&
      binding.status !== 'draining' &&
      binding.status !== 'retained'
    )
      throw contractError('NOT_READY', 'platform.client.release_unready');
    assertGameServiceDescription(release.service);
    return structuredClone(release.service);
  }

  async sessionClientLocator(
    reference: PlatformIdentityReference,
    sessionId: string,
  ): Promise<ClientReleaseLocator> {
    // The locator contains only immutable public client artifacts. Replay-only
    // spectators need the same pinned decoder without receiving live access.
    const descriptor = await this.runtime.replaySessions.descriptor(
      reference,
      sessionId,
    );
    const route: SessionRoute = descriptor.route;
    return this.clientLocator(
      route.gameId,
      route.releaseId,
      route.backendBindingId,
      { allowRetained: true },
    );
  }
}
