import { performance } from 'node:perf_hooks';
import type {
  AccessContext,
  CreateSessionRequest,
  PlayerViewEnvelope,
  SessionRoute,
} from '@board-game/contracts';
import {
  EmbeddedBackendAdapter,
  GameHost,
  GameRegistry,
  HttpHostTransport,
  RemoteBackendAdapter,
  type RuntimeModule,
} from '@board-game/host';
import { MemoryStorageDriver } from '@board-game/storage';
import { platformFixtureModules } from '@board-game/testing/fixtures';

export const PERFORMANCE_BUDGETS = {
  /** A local Host lifecycle plus one view should stay interactive on CI. */
  p95Ms: 250,
  /** Public view payload budget for the representative fixtures. */
  payloadBytes: 128 * 1024,
  /** Persisted codec state budget before a release needs a larger profile. */
  encodedStateBytes: 512 * 1024,
} as const;

export type PerformanceEnvironment = 'embedded' | 'remote';

export interface PerformanceReport {
  readonly fixture: string;
  readonly environment: PerformanceEnvironment;
  readonly count: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly payloadBytes: number;
  readonly encodedBytes: number;
  readonly budget: typeof PERFORMANCE_BUDGETS;
  readonly passed: boolean;
}

export interface PerformanceRunOptions {
  readonly sampleCount?: number;
  readonly environments?: readonly PerformanceEnvironment[];
}

export interface PerformanceRunResult {
  readonly runtime: {
    readonly node: string;
    readonly platform: string;
    readonly arch: string;
  };
  readonly reports: readonly PerformanceReport[];
  readonly passed: boolean;
}

const access: AccessContext = {
  principalId: 'performance-player-1',
  authEpoch: 'performance-epoch-1',
  scopes: ['session:create', 'session:view', 'session:command'],
};

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function percentile(values: readonly number[], fraction: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.min(
    ordered.length - 1,
    Math.max(0, Math.ceil(ordered.length * fraction) - 1),
  );
  return ordered[index] ?? 0;
}

function fixtureRoute(module: RuntimeModule, sessionId: string): SessionRoute {
  const mode = module.modes[0];
  if (!mode) throw new Error(`Fixture ${module.gameId} has no mode`);
  return {
    gameId: module.gameId,
    modeId: mode.id,
    sessionId,
    releaseId: module.releaseId,
    backendBindingId: 'performance-backend',
    storageBindingId: 'performance-storage',
    ownershipEpoch: 'performance-owner-1',
  };
}

function createRequest(
  module: RuntimeModule,
  sessionId: string,
): CreateSessionRequest {
  const mode = module.modes[0];
  if (!mode) throw new Error(`Fixture ${module.gameId} has no mode`);
  const participants = Array.from({ length: mode.minPlayers }, (_, index) => ({
    principalId: `performance-player-${index + 1}`,
    seatId: `seat-${index + 1}`,
  }));
  return {
    protocolVersion: 1,
    accessContext: access,
    route: fixtureRoute(module, sessionId),
    startId: `performance-start-${sessionId}`,
    startGeneration: 0,
    setup: {},
    participants,
    seed: `performance-seed-${sessionId}`,
  };
}

async function measureFixture(
  module: RuntimeModule,
  environment: PerformanceEnvironment,
  sampleCount: number,
): Promise<PerformanceReport> {
  const storage = new MemoryStorageDriver();
  const host = new GameHost({
    registry: new GameRegistry().register(module),
    storage,
    backendBindingId: 'performance-backend',
    storageBindingId: 'performance-storage',
    authorize: async () => undefined,
    now: () => 1_700_000_000_000,
  });
  let transport: HttpHostTransport | undefined;
  let backend: EmbeddedBackendAdapter | RemoteBackendAdapter;
  if (environment === 'embedded') {
    backend = new EmbeddedBackendAdapter(host);
  } else {
    const serviceToken = 'platform-performance-service-token-0123456789';
    transport = new HttpHostTransport({
      backend: host,
      serviceToken,
      allowedGameIds: [module.gameId],
      allowedScopes: ['session:create', 'session:view', 'session:command'],
      tokenExpiresAt: Date.now() + 60_000,
      port: 0,
    });
    const address = await transport.listen();
    backend = new RemoteBackendAdapter({
      baseUrl: `http://127.0.0.1:${address.port}`,
      serviceToken,
      allowInsecureLocalhost: true,
    });
  }

  const durations: number[] = [];
  let payloadBytes = 0;
  let encodedBytes = 0;
  try {
    for (let index = 0; index < sampleCount; index += 1) {
      const sessionId = `performance-${module.gameId}-${environment}-${index}`;
      const request = createRequest(module, sessionId);
      const started = performance.now();
      await backend.createSession(request);
      await backend.activateSession({
        protocolVersion: 1,
        accessContext: access,
        route: request.route,
        startId: request.startId,
      });
      const view: PlayerViewEnvelope = await backend.getPlayerView({
        protocolVersion: 1,
        accessContext: access,
        route: request.route,
      });
      durations.push(performance.now() - started);
      payloadBytes = Math.max(payloadBytes, jsonBytes(view));
      const head = await storage.getHead(sessionId);
      if (!head) throw new Error(`Performance head missing for ${sessionId}`);
      encodedBytes = Math.max(encodedBytes, jsonBytes(head.encodedState));
    }
  } finally {
    await transport?.close();
  }
  const report = {
    fixture: module.gameId,
    environment,
    count: durations.length,
    medianMs: Number(percentile(durations, 0.5).toFixed(3)),
    p95Ms: Number(percentile(durations, 0.95).toFixed(3)),
    payloadBytes,
    encodedBytes,
    budget: PERFORMANCE_BUDGETS,
  } satisfies Omit<PerformanceReport, 'passed'>;
  return {
    ...report,
    passed:
      report.p95Ms <= report.budget.p95Ms &&
      report.payloadBytes <= report.budget.payloadBytes &&
      report.encodedBytes <= report.budget.encodedStateBytes,
  };
}

/** Measures all four platform fixtures through embedded and remote Host paths. */
export async function runPerformanceVerification(
  options: PerformanceRunOptions = {},
): Promise<PerformanceRunResult> {
  const sampleCount = options.sampleCount ?? 11;
  if (
    !Number.isSafeInteger(sampleCount) ||
    sampleCount < 3 ||
    sampleCount > 100
  )
    throw new Error(
      'Performance sample count must be an integer from 3 to 100',
    );
  const environments = options.environments ?? ['embedded', 'remote'];
  if (
    environments.length === 0 ||
    environments.some(
      (environment) => environment !== 'embedded' && environment !== 'remote',
    )
  )
    throw new Error('Performance environments must be embedded or remote');
  const reports: PerformanceReport[] = [];
  for (const module of platformFixtureModules) {
    const runtimeModule = module as unknown as RuntimeModule;
    for (const environment of environments)
      reports.push(
        await measureFixture(runtimeModule, environment, sampleCount),
      );
  }
  return {
    runtime: {
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    },
    reports,
    passed: reports.every((report) => report.passed),
  };
}
