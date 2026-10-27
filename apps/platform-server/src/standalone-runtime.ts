import { randomUUID } from 'node:crypto';
import type { BackendPort, SessionRoute } from '@board-game/contracts';
import type {
  FactDelivery,
  FactDeliveryAck,
  TrustedSourceIdentity,
} from '@board-game/core';
import {
  HttpFactIngressServer,
  type HttpFactIngressServerAddress,
  PostgresAdmissionStore,
  type TrustedFactIngestorLike,
} from '@board-game/core';
import type {
  PlatformApplicationRuntime,
  RemotePolicyResolution,
  RemoteReadinessProbeInput,
  RemoteRuntimeOptions,
} from '@board-platform/server/platform/PlatformApplicationRuntime.js';
import { PlatformIdentity } from '@board-platform/server/platform/PlatformIdentity.js';
import { PostgresReleaseRegistryStore } from '@board-platform/server/platform/releases/store.js';
import type {
  BindingReadinessEvidence,
  ReleaseBindingRecord,
  ReleaseRecord,
  ReleaseRegistryStore,
} from '@board-platform/server/platform/releases/types.js';
import {
  assertRemoteSettlementPolicyBundle,
  type RemoteSettlementPolicyBundle,
} from '@board-platform/server/platform/remote-settlement.js';
import type {
  BeforeApplicationShutdown,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { StandalonePlatformConfig } from './config.js';

export const STANDALONE_FACT_INGRESS = Symbol('STANDALONE_FACT_INGRESS');

export interface StandaloneFactIngress extends TrustedFactIngestorLike {}

export interface StandalonePlatformDependencies {
  readonly resolveServiceCredential?: (
    reference: string,
    binding: ReleaseBindingRecord,
  ) => string | Promise<string>;
  readonly probeReadiness?: (
    input: RemoteReadinessProbeInput,
  ) => Promise<BindingReadinessEvidence>;
  readonly factIngress?: StandaloneFactIngress;
  /** A composed player authority may be installed by a host application. */
  readonly playerConnections?: import('@board-platform/server/platform/PlatformPlayerConnections.js').PlatformPlayerConnections;
}

export interface StandalonePlatformResources {
  readonly pool: Pool;
  readonly db: NodePgDatabase;
  readonly admission: PostgresAdmissionStore;
  readonly releaseRegistry: ReleaseRegistryStore;
}

export function createStandaloneResources(
  config: StandalonePlatformConfig,
): StandalonePlatformResources {
  const pool = new Pool({ connectionString: config.databaseUrl });
  return {
    pool,
    db: drizzle(pool),
    admission: new PostgresAdmissionStore({ pool }),
    releaseRegistry: new PostgresReleaseRegistryStore(pool),
  };
}

export class StandaloneResourceShutdown implements OnApplicationShutdown {
  constructor(private readonly resources: StandalonePlatformResources) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.resources.releaseRegistry.close)
      await this.resources.releaseRegistry.close();
    else await this.resources.pool.end();
  }
}

export function resolveEnvironmentSecret(reference: string): string {
  if (!reference.startsWith('env:'))
    throw new Error(
      `Secret reference ${reference} requires an injected secret resolver; standalone env resolver only accepts env: references`,
    );
  const name = reference.slice('env:'.length);
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Secret environment variable ${name} is missing`);
  return value;
}

export type StandaloneFactIngressErrorCode =
  | 'BINDING_PLATFORM_MISMATCH'
  | 'CREDENTIAL_CONFLICT'
  | 'CREDENTIAL_INVALID'
  | 'CREDENTIAL_RESOLUTION_FAILED'
  | 'LISTENER_FAILED'
  | 'REFRESH_FAILED';

export interface StandaloneFactIngressStatus {
  readonly listeningAddress?: HttpFactIngressServerAddress;
  readonly lastSuccess: number | null;
  readonly lastError: {
    readonly code: StandaloneFactIngressErrorCode;
    readonly at: number;
  } | null;
}

/** Owns the standalone platform's authenticated fact listener lifecycle. */
export class StandaloneFactIngressLifecycle
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private address: HttpFactIngressServerAddress | undefined;
  private server: HttpFactIngressServer | undefined;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private refreshInFlight: Promise<void> | undefined;
  private shuttingDown = false;
  private lastSuccess: number | null = null;
  private lastError: StandaloneFactIngressStatus['lastError'] = null;

  constructor(
    runtime: PlatformApplicationRuntime,
    config: StandalonePlatformConfig,
    resolveCredential?: StandalonePlatformDependencies['resolveServiceCredential'],
  ) {
    this.runtime = runtime;
    this.config = config;
    this.resolveCredential = resolveCredential;
  }

  private readonly runtime: PlatformApplicationRuntime;
  private readonly config: StandalonePlatformConfig;
  private readonly resolveCredential?: StandalonePlatformDependencies['resolveServiceCredential'];

  private credentialReferences() {
    if (this.config.factIngressCredentials)
      return this.config.factIngressCredentials;
    if (this.config.factIngressToken && this.config.factIngressSource)
      return [
        {
          tokenRef: `env:PLATFORM_FACT_INGRESS_TOKEN`,
          source: this.config.factIngressSource,
        },
      ];
    return [];
  }

  private async registryCredentials(): Promise<
    readonly {
      readonly token: string;
      readonly platformId: string;
      readonly source: TrustedSourceIdentity;
    }[]
  > {
    const registry = this.runtime.releaseRegistry;
    if (!registry) return [];
    const bindings = await registry.listBindings(this.config.platformId);
    const credentials: {
      token: string;
      platformId: string;
      source: TrustedSourceIdentity;
    }[] = [];
    for (const binding of bindings) {
      if (binding.platformId !== this.config.platformId)
        throw new Error('fact ingress binding platform does not match config');
      // A staged binding has not passed the remote readiness gate. Retained
      // bindings are still needed for late facts from pinned sessions.
      if (binding.status === 'staged' || binding.status === 'retired') continue;
      const token = await (this.resolveCredential?.(
        binding.serviceCredentialRef,
        binding,
      ) ?? resolveEnvironmentSecret(binding.serviceCredentialRef));
      credentials.push({
        token,
        platformId: this.config.platformId,
        source: {
          gameId: binding.gameId,
          releaseId: binding.releaseId,
          backendBindingId: binding.backendBindingId,
          ownershipEpoch: binding.ownershipEpoch,
        },
      });
    }
    return credentials;
  }

  private static sourceKey(source: TrustedSourceIdentity): string {
    return JSON.stringify([
      source.gameId,
      source.releaseId,
      source.backendBindingId,
      source.ownershipEpoch,
    ]);
  }

  private async refreshCredentials(): Promise<void> {
    if (this.shuttingDown) return;
    const staticCredentials = this.credentialReferences().map((entry) => ({
      token: resolveEnvironmentSecret(entry.tokenRef),
      platformId: this.config.platformId,
      source: entry.source,
    }));
    const credentialsByToken = new Map<
      string,
      (typeof staticCredentials)[number]
    >();
    for (const credential of [
      ...staticCredentials,
      ...(await this.registryCredentials()),
    ]) {
      const existing = credentialsByToken.get(credential.token);
      if (
        existing &&
        StandaloneFactIngressLifecycle.sourceKey(existing.source) !==
          StandaloneFactIngressLifecycle.sourceKey(credential.source)
      )
        throw new Error('fact ingress token is mapped to multiple sources');
      credentialsByToken.set(credential.token, credential);
    }
    const credentials = [...credentialsByToken.values()];
    if (credentials.length === 0) {
      if (this.server) {
        await this.server.close();
        this.server = undefined;
        this.address = undefined;
      }
      return;
    }
    if (!this.server) {
      this.server = new HttpFactIngressServer({
        receiver: this.runtime.factReceiver,
        credentials,
        ...(this.config.factIngressHost
          ? { host: this.config.factIngressHost }
          : {}),
        ...(this.config.factIngressPort
          ? { port: this.config.factIngressPort }
          : {}),
      });
      this.address = await this.server.listen();
      return;
    }
    this.server.updateCredentials(credentials);
  }

  private noteError(error: unknown): void {
    const message = error instanceof Error ? error.message : '';
    const normalized = message.toLowerCase();
    let code: StandaloneFactIngressErrorCode = 'REFRESH_FAILED';
    if (message.includes('binding platform'))
      code = 'BINDING_PLATFORM_MISMATCH';
    else if (message.includes('mapped to multiple sources'))
      code = 'CREDENTIAL_CONFLICT';
    else if (
      normalized.includes('secret') ||
      normalized.includes('resolver') ||
      normalized.includes('requires an injected')
    )
      code = 'CREDENTIAL_RESOLUTION_FAILED';
    else if (message.includes('credential.token')) code = 'CREDENTIAL_INVALID';
    else if (message.includes('HTTP server') || message.includes('listen'))
      code = 'LISTENER_FAILED';
    this.lastError = { code, at: Date.now() };
  }

  private noteSuccess(): void {
    this.lastSuccess = Date.now();
    this.lastError = null;
  }

  private scheduleRefresh(): Promise<void> {
    if (this.shuttingDown) return Promise.resolve();
    if (this.refreshInFlight) return this.refreshInFlight;
    const pending = this.refreshCredentials().finally(() => {
      if (this.refreshInFlight === pending) this.refreshInFlight = undefined;
    });
    this.refreshInFlight = pending;
    return pending;
  }

  async onApplicationBootstrap(): Promise<void> {
    this.shuttingDown = false;
    try {
      await this.scheduleRefresh();
      this.noteSuccess();
    } catch (error) {
      this.noteError(error);
      throw new Error('platform fact ingress refresh failed');
    }
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(() => {
      void this.scheduleRefresh()
        .then(() => this.noteSuccess())
        .catch((error: unknown) => this.noteError(error));
    }, 5_000);
    this.refreshTimer.unref();
  }

  /** Refreshes registry-backed source credentials without restarting the app. */
  async refreshNow(): Promise<void> {
    try {
      await this.scheduleRefresh();
      this.noteSuccess();
    } catch (error) {
      this.noteError(error);
      throw new Error('platform fact ingress refresh failed');
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    await this.refreshInFlight;
    await this.server?.close();
    this.server = undefined;
    this.address = undefined;
  }

  get listeningAddress(): HttpFactIngressServerAddress | undefined {
    return this.address;
  }

  get status(): StandaloneFactIngressStatus {
    return {
      ...(this.address ? { listeningAddress: this.address } : {}),
      lastSuccess: this.lastSuccess,
      lastError: this.lastError,
    };
  }
}

function remotePolicy(
  resources: StandalonePlatformResources,
  release: ReleaseRecord,
): RemotePolicyResolution {
  const policyBundle = release.policyBundle;
  if (policyBundle !== undefined)
    assertRemoteSettlementPolicyBundle(policyBundle);
  if (
    release.manifest.modes.some((mode) => mode.platformRating) &&
    policyBundle === undefined
  )
    throw new Error(
      `Release ${release.gameId}/${release.releaseId} requires an approved JSON settlement policy bundle`,
    );
  const bundle = policyBundle as RemoteSettlementPolicyBundle | undefined;
  const setupSchema = release.service.setupSchema.schema;
  const playerCountField =
    setupSchema.type === 'object' &&
    setupSchema.properties &&
    Object.hasOwn(setupSchema.properties, 'playerCount')
      ? 'playerCount'
      : undefined;
  return {
    identity: new PlatformIdentity(
      resources.db,
      resources.admission,
      release.gameId,
      {},
      () => resources.db,
    ),
    policy: {
      rating: bundle
        ? {
            poolId: bundle.rating.poolId,
            policyVersion: bundle.rating.policyVersion,
            progressionPolicyVersion: bundle.rating.progressionPolicyVersion,
            seasonId: null,
          }
        : null,
      validityPolicyVersion: 'platform-independent-v1',
    },
    publicModes: release.approvedModes,
    ...(playerCountField ? { playerCountField } : {}),
    ...(release.service.roomCapacity
      ? { roomCapacity: release.service.roomCapacity }
      : {}),
  };
}

export function createStandaloneRemoteRuntime(
  config: StandalonePlatformConfig,
  resources: StandalonePlatformResources,
  dependencies: StandalonePlatformDependencies = {},
): RemoteRuntimeOptions {
  return {
    resolvePolicy: (release) => remotePolicy(resources, release),
    resolveCredential: async (_release, binding) => ({
      serviceToken: await (dependencies.resolveServiceCredential?.(
        binding.serviceCredentialRef,
        binding,
      ) ?? resolveEnvironmentSecret(binding.serviceCredentialRef)),
      allowInsecureLocalhost: config.allowInsecureLocalhost,
    }),
    probeReadiness: async (input) => {
      if (dependencies.probeReadiness)
        return dependencies.probeReadiness(input);
      const description = await input.backend.describe({ protocolVersion: 1 });
      if (
        !description.storageBindingIds.includes(input.binding.storageBindingId)
      )
        throw new Error('remote backend storage binding is not ready');
      return {
        probeId: randomUUID(),
        checkedAt: Date.now(),
        protocol: {
          major: description.protocolMajor,
          minor: description.protocolMinor,
          serviceDigest: input.release.serviceDigest,
          service: input.release.service,
        },
        storage: {
          bindingId: input.binding.storageBindingId,
          schemaVersion: String(input.release.manifest.versions.stateSchema),
        },
      };
    },
  };
}

export interface StandaloneReadinessSnapshot {
  readonly restoredBindings: number;
  readonly completed: boolean;
}

export class StandaloneReadiness {
  private snapshot: StandaloneReadinessSnapshot = {
    restoredBindings: 0,
    completed: false,
  };

  markRestored(restoredBindings: number): void {
    this.snapshot = { restoredBindings, completed: true };
  }

  get current(): StandaloneReadinessSnapshot {
    return this.snapshot;
  }
}

export async function restoreStandaloneRuntime(
  runtime: PlatformApplicationRuntime,
  readiness: StandaloneReadiness,
): Promise<void> {
  const installed = await runtime.restoreRemoteGames();
  readiness.markRestored(installed.length);
}

export function assertFactSource(
  source: TrustedSourceIdentity,
  route: SessionRoute,
): boolean {
  return (
    source.gameId === route.gameId &&
    source.releaseId === route.releaseId &&
    source.backendBindingId === route.backendBindingId &&
    source.ownershipEpoch === route.ownershipEpoch
  );
}

export type StandaloneFactDelivery = FactDelivery;
export type StandaloneFactAck = FactDeliveryAck;
export type StandaloneBackend = BackendPort;
