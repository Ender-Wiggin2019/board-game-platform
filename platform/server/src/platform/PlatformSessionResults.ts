import {
  canonicalStableStringify,
  contractError,
  isPlatformError,
  type JsonValue,
  type PlatformCompletionRecord,
} from '@board-game/contracts';
import type {
  PlatformIdentityReference,
  QueryInput,
  SessionDirectoryStore,
  SessionGateway,
} from '@board-game/core';
import { BackendTransportError } from '@board-game/host';
import type {
  GameReplayQueries,
  GameResultPresenter,
} from '@board-game/server';
import type { CompletionRecordStore } from './CompletionRecordStore.js';

export type { GameResultPresenter };

function key(gameId: string, releaseId: string): string {
  return JSON.stringify([gameId, releaseId]);
}

export interface PlatformSessionResultsOptions {
  /** Platform authority used for remotely registered releases. */
  readonly completionStore?: CompletionRecordStore;
  readonly platformId?: string;
  /** Additional public replay grants are isolated from ordinary session access. */
  readonly replaySessions?: SessionGateway;
}

/** Results and replay queries always pass the shared authenticated session gateway. */
export class PlatformSessionResults {
  private readonly releases = new Set<string>();
  private readonly remoteReleases = new Set<string>();
  private readonly presenters = new Map<string, GameResultPresenter>();
  private readonly replayQueries = new Map<string, GameReplayQueries>();
  private readonly settlements = new Map<
    string,
    (sessionId: string, principalId: string) => Promise<JsonValue | null>
  >();
  constructor(
    private readonly sessions: SessionGateway,
    private readonly directory: SessionDirectoryStore,
    private readonly options: PlatformSessionResultsOptions = {},
  ) {
    if (this.options.completionStore && !this.options.platformId)
      throw contractError(
        'INVALID_REQUEST',
        'platform.results.platform_id_required',
      );
  }

  private get replaySessions(): SessionGateway {
    return this.options.replaySessions ?? this.sessions;
  }

  registerRelease(gameId: string, releaseId: string): void {
    this.releases.add(key(gameId, releaseId));
  }

  /** Registers a release whose standard result is platform-owned and durable. */
  registerRemoteRelease(gameId: string, releaseId: string): void {
    this.registerRelease(gameId, releaseId);
    this.remoteReleases.add(key(gameId, releaseId));
  }

  unregisterRelease(gameId: string, releaseId: string): void {
    const releaseKey = key(gameId, releaseId);
    this.releases.delete(releaseKey);
    this.remoteReleases.delete(releaseKey);
    this.presenters.delete(releaseKey);
    this.replayQueries.delete(releaseKey);
    this.settlements.delete(releaseKey);
  }

  register(
    gameId: string,
    releaseId: string,
    presenter: GameResultPresenter,
  ): void {
    const releaseKey = key(gameId, releaseId);
    this.registerRelease(gameId, releaseId);
    if (this.presenters.has(releaseKey))
      throw contractError('CONFLICT', 'platform.results.already_registered');
    this.presenters.set(releaseKey, presenter);
  }

  registerReplayQueries(
    gameId: string,
    releaseId: string,
    queries: GameReplayQueries,
  ): void {
    const releaseKey = key(gameId, releaseId);
    this.registerRelease(gameId, releaseId);
    if (this.replayQueries.has(releaseKey))
      throw contractError(
        'CONFLICT',
        'platform.results.replay_queries_already_registered',
      );
    this.replayQueries.set(releaseKey, queries);
  }

  registerSettlement(
    gameId: string,
    releaseId: string,
    read: (sessionId: string, principalId: string) => Promise<JsonValue | null>,
  ): void {
    const releaseKey = key(gameId, releaseId);
    this.registerRelease(gameId, releaseId);
    if (this.settlements.has(releaseKey))
      throw contractError('CONFLICT', 'platform.settlement.already_registered');
    this.settlements.set(releaseKey, read);
  }

  private async context(
    reference: PlatformIdentityReference,
    sessionId: string,
    replay = false,
  ) {
    const descriptor = await (replay
      ? this.replaySessions
      : this.sessions
    ).descriptor(reference, sessionId);
    const releaseKey = key(descriptor.route.gameId, descriptor.route.releaseId);
    if (!this.releases.has(releaseKey))
      throw contractError(
        'NOT_READY',
        'platform.results.release_unavailable',
        true,
      );
    return {
      descriptor,
      presenter: this.presenters.get(releaseKey),
    };
  }

  private async completed(
    reference: PlatformIdentityReference,
    sessionId: string,
    replay = false,
  ) {
    const summary = await (replay
      ? this.replaySessions
      : this.sessions
    ).summary(reference, sessionId);
    if (summary.status !== 'completed')
      throw contractError('CONFLICT', 'platform.session.not_completed');
    return summary;
  }

  private async storedCompletion(
    sessionId: string,
    descriptor: Awaited<ReturnType<SessionGateway['descriptor']>>,
  ): Promise<PlatformCompletionRecord | null> {
    const releaseKey = key(descriptor.route.gameId, descriptor.route.releaseId);
    if (!this.remoteReleases.has(releaseKey)) return null;
    const store = this.options.completionStore;
    const platformId = this.options.platformId;
    if (!store || !platformId)
      throw contractError(
        'NOT_READY',
        'platform.results.completion_store_unavailable',
        true,
      );
    const record = await store.get(platformId, sessionId);
    if (!record)
      throw contractError(
        'NOT_READY',
        'platform.results.completion_pending',
        true,
      );
    if (
      canonicalStableStringify(record.route) !==
      canonicalStableStringify(descriptor.route)
    )
      throw contractError('CONFLICT', 'platform.results.route_mismatch');
    return record;
  }

  private publicSettlement(record: PlatformCompletionRecord): unknown {
    return {
      status: record.status,
      processingState: record.processingState,
      attempts: record.attempts,
      resultRevision: record.resultRevision,
      sourceRevision: record.sourceRevision,
      ...(record.nextAttemptAt === undefined
        ? {}
        : { nextAttemptAt: record.nextAttemptAt }),
    };
  }

  private publicCompletion(record: PlatformCompletionRecord): unknown {
    return {
      route: record.route,
      status: record.status,
      sourceRevision: record.sourceRevision,
      result: record.result ?? null,
      endRecord: record.result ?? null,
      settlement: this.publicSettlement(record),
      replayRef: record.replayRef ?? null,
      completion: {
        platformId: record.platformId,
        admissionId: record.admissionId,
        route: record.route,
        sessionId: record.sessionId,
        status: record.status,
        resultSchemaVersion: record.resultSchemaVersion,
        resultRevision: record.resultRevision,
        sourceRevision: record.sourceRevision,
        digest: record.digest,
        participants: record.participants,
        validityPolicyVersion: record.validityPolicyVersion,
        rating: record.rating,
        endedAt: record.endedAt,
        result: record.result ?? null,
        replayRef: record.replayRef ?? null,
      },
    };
  }

  private async remoteReplay(
    reference: PlatformIdentityReference,
    sessionId: string,
    descriptor: Awaited<ReturnType<SessionGateway['descriptor']>>,
    kind: 'manifest' | 'frames',
    from = 0,
    limit = 10,
  ): Promise<unknown> {
    const record = await this.storedCompletion(sessionId, descriptor);
    if (!record || record.status !== 'completed')
      throw contractError('CONFLICT', 'platform.session.not_completed');
    const replay = record.replayRef;
    const queries = this.replayQueries.get(
      key(record.route.gameId, record.route.releaseId),
    );
    if (!replay || !queries)
      throw contractError('NOT_READY', 'platform.replay.unavailable');
    if (
      replay.platformId !== record.platformId ||
      replay.gameId !== record.route.gameId ||
      replay.sessionId !== record.sessionId ||
      replay.releaseId !== record.route.releaseId ||
      replay.storageBindingId !== record.route.storageBindingId
    )
      throw contractError('CONFLICT', 'platform.replay.route_mismatch');
    // Runtime replay v1 routes by session; replayId remains a game-owned opaque reference.
    if (replay.formatVersion !== 1)
      throw contractError('NOT_READY', 'platform.replay.format_unavailable');
    try {
      const response = await this.replaySessions.query(
        reference,
        replay.sessionId,
        {
          revision: record.sourceRevision,
          query:
            kind === 'manifest'
              ? queries.manifest(200)
              : queries.frames(from, limit),
        },
      );
      return {
        route: record.route,
        sourceRevision: record.sourceRevision,
        replayRef: replay,
        ...(kind === 'manifest'
          ? { manifest: response.answer }
          : { chunk: response.answer }),
      };
    } catch (error) {
      if (error instanceof BackendTransportError)
        throw contractError('NOT_READY', 'platform.replay.unavailable', true);
      if (
        isPlatformError(error) &&
        ['NOT_READY', 'NOT_FOUND', 'SESSION_CLOSED'].includes(
          error.envelope.code,
        )
      )
        throw contractError(
          'NOT_READY',
          'platform.replay.unavailable',
          error.envelope.retryable,
        );
      throw error;
    }
  }

  async getCompletion(
    reference: PlatformIdentityReference,
    sessionId: string,
  ): Promise<unknown> {
    const { descriptor, presenter } = await this.context(reference, sessionId);
    if (
      this.remoteReleases.has(
        key(descriptor.route.gameId, descriptor.route.releaseId),
      )
    )
      return this.publicCompletion(
        (await this.storedCompletion(
          sessionId,
          descriptor,
        )) as PlatformCompletionRecord,
      );
    if (presenter) return presenter.getCompletion(reference, sessionId);
    const summary = await this.completed(reference, sessionId);
    const view = await this.sessions.view(reference, sessionId);
    const record = await this.directory.getSession(sessionId);
    return {
      route: summary.descriptor.route,
      status: 'completed',
      sourceRevision: summary.sourceRevision,
      summary,
      view,
      endRecord: view.payload,
      result: record?.result ?? null,
      settlement: await this.getSettlement(reference, sessionId),
    };
  }

  async getEndRecord(
    reference: PlatformIdentityReference,
    sessionId: string,
  ): Promise<unknown> {
    const { descriptor, presenter } = await this.context(reference, sessionId);
    if (
      this.remoteReleases.has(
        key(descriptor.route.gameId, descriptor.route.releaseId),
      )
    )
      return (
        (await this.storedCompletion(sessionId, descriptor))?.result ?? null
      );
    if (presenter) return presenter.getEndRecord(reference, sessionId);
    await this.completed(reference, sessionId);
    return (await this.sessions.view(reference, sessionId)).payload;
  }

  async getSettlement(
    reference: PlatformIdentityReference,
    sessionId: string,
  ): Promise<unknown> {
    const { descriptor, presenter } = await this.context(reference, sessionId);
    if (
      this.remoteReleases.has(
        key(descriptor.route.gameId, descriptor.route.releaseId),
      )
    )
      return this.publicSettlement(
        (await this.storedCompletion(
          sessionId,
          descriptor,
        )) as PlatformCompletionRecord,
      );
    if (presenter) return presenter.getSettlement(reference, sessionId);
    return (
      this.settlements.get(
        key(descriptor.route.gameId, descriptor.route.releaseId),
      )?.(sessionId, reference.principalId) ?? null
    );
  }

  async getReplayManifest(
    reference: PlatformIdentityReference,
    sessionId: string,
  ): Promise<unknown> {
    const { descriptor, presenter } = await this.context(
      reference,
      sessionId,
      true,
    );
    if (presenter) return presenter.getReplayManifest(reference, sessionId);
    if (
      this.remoteReleases.has(
        key(descriptor.route.gameId, descriptor.route.releaseId),
      )
    )
      return this.remoteReplay(reference, sessionId, descriptor, 'manifest');
    const summary = await this.completed(reference, sessionId, true);
    const query =
      this.replayQueries
        .get(key(descriptor.route.gameId, descriptor.route.releaseId))
        ?.manifest(200) ??
      ({ type: 'replayManifest', eventLimit: 200 } as const);
    const response = await this.replaySessions.query(reference, sessionId, {
      revision: summary.sourceRevision,
      query,
    });
    return {
      route: summary.descriptor.route,
      sourceRevision: summary.sourceRevision,
      manifest: response.answer,
    };
  }

  async getReplayFrames(
    reference: PlatformIdentityReference,
    sessionId: string,
    from = 0,
    limit = 10,
  ): Promise<unknown> {
    if (
      !Number.isSafeInteger(from) ||
      from < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw contractError('INVALID_REQUEST', 'platform.request.replay_range');
    const { descriptor, presenter } = await this.context(
      reference,
      sessionId,
      true,
    );
    if (presenter)
      return presenter.getReplayFrames(reference, sessionId, from, limit);
    if (
      this.remoteReleases.has(
        key(descriptor.route.gameId, descriptor.route.releaseId),
      )
    )
      return this.remoteReplay(
        reference,
        sessionId,
        descriptor,
        'frames',
        from,
        limit,
      );
    const summary = await this.completed(reference, sessionId, true);
    const query =
      this.replayQueries
        .get(key(descriptor.route.gameId, descriptor.route.releaseId))
        ?.frames(from, limit) ??
      ({ type: 'replayFrames', from, limit } as const);
    const response = await this.replaySessions.query(reference, sessionId, {
      revision: summary.sourceRevision,
      query,
    });
    return {
      route: summary.descriptor.route,
      sourceRevision: summary.sourceRevision,
      chunk: response.answer,
    };
  }

  /** Native replay renderers may ask only the installed release's replay queries. */
  async queryReplay(
    reference: PlatformIdentityReference,
    sessionId: string,
    input: QueryInput,
  ) {
    const { descriptor } = await this.context(reference, sessionId, true);
    const queries = this.replayQueries.get(
      key(descriptor.route.gameId, descriptor.route.releaseId),
    );
    if (!queries || !input || typeof input !== 'object')
      throw contractError('FORBIDDEN', 'platform.replay.query_denied');
    const query = input.query;
    if (!query || typeof query !== 'object' || Array.isArray(query))
      throw contractError('FORBIDDEN', 'platform.replay.query_denied');
    const data = query as Record<string, JsonValue>;
    const eventLimit = data.eventLimit;
    const from = data.from;
    const limit = data.limit;
    const manifest =
      typeof eventLimit === 'number' &&
      Number.isSafeInteger(eventLimit) &&
      eventLimit >= 1 &&
      eventLimit <= 200
        ? queries.manifest(eventLimit)
        : queries.manifest(200);
    const frames =
      typeof from === 'number' &&
      Number.isSafeInteger(from) &&
      from >= 0 &&
      typeof limit === 'number' &&
      Number.isSafeInteger(limit) &&
      limit >= 1 &&
      limit <= 100
        ? queries.frames(from, limit)
        : null;
    const serialized = canonicalStableStringify(query);
    if (
      serialized !== canonicalStableStringify(manifest) &&
      (frames === null || serialized !== canonicalStableStringify(frames))
    )
      throw contractError('FORBIDDEN', 'platform.replay.query_denied');
    const record = await this.storedCompletion(sessionId, descriptor);
    if (record) {
      const replay = record.replayRef;
      if (record.status !== 'completed')
        throw contractError('CONFLICT', 'platform.session.not_completed');
      if (!replay)
        throw contractError('NOT_READY', 'platform.replay.unavailable');
      if (
        replay.platformId !== record.platformId ||
        replay.gameId !== record.route.gameId ||
        replay.sessionId !== sessionId ||
        replay.releaseId !== record.route.releaseId ||
        replay.storageBindingId !== record.route.storageBindingId
      )
        throw contractError('CONFLICT', 'platform.replay.route_mismatch');
      if (replay.formatVersion !== 1)
        throw contractError('NOT_READY', 'platform.replay.format_unavailable');
      if (input.revision !== record.sourceRevision)
        throw contractError('STALE_REVISION', 'platform.replay.revision');
    } else await this.completed(reference, sessionId, true);
    return this.replaySessions.query(reference, sessionId, input);
  }
}
