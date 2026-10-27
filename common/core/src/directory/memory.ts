import { participantAccountId } from '@board-game/contracts';
import { DirectoryError } from './errors.js';
import {
  assertRecordMatchesAdmission,
  assertSessionId,
  assertSourceMatches,
  clone,
  decodeCursor,
  encodeCursor,
  validateAdmission,
  validateEnvelope,
  validateListOptions,
} from './invariants.js';
import { applyProjection, type StoredDirectoryFact } from './projection.js';
import type {
  SessionDirectoryAdmissionLookup,
  SessionDirectoryCapabilities,
  SessionDirectoryEnvelope,
  SessionDirectoryListOptions,
  SessionDirectoryOptions,
  SessionDirectoryPage,
  SessionDirectoryRecord,
  SessionDirectoryStore,
} from './types.js';

class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async run<Result>(callback: () => Promise<Result>): Promise<Result> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  }
}

interface MemoryState {
  readonly records: Map<string, SessionDirectoryRecord>;
  readonly facts: Map<string, StoredDirectoryFact>;
}

function copyState(state: MemoryState): MemoryState {
  return {
    records: new Map(
      [...state.records].map(([key, value]) => [key, clone(value)]),
    ),
    facts: new Map([...state.facts].map(([key, value]) => [key, clone(value)])),
  };
}

function factKey(
  fact: Pick<StoredDirectoryFact, 'sessionId' | 'aggregateSequence' | 'kind'>,
): string {
  return JSON.stringify([fact.sessionId, fact.aggregateSequence, fact.kind]);
}

function admissionLookup(
  value: SessionDirectoryOptions['admission'],
): SessionDirectoryAdmissionLookup {
  if (!value || typeof value.getAdmission !== 'function')
    throw new DirectoryError(
      'INVALID_ARGUMENT',
      'admission lookup is required',
      false,
    );
  return value;
}

function page(
  values: readonly SessionDirectoryRecord[],
  options: SessionDirectoryListOptions,
): SessionDirectoryPage {
  validateListOptions(options);
  const limit = options.limit ?? 100;
  const cursor = options.cursor ? decodeCursor(options.cursor) : undefined;
  const filtered = values
    .filter(
      (record) =>
        options.gameId === undefined || record.route.gameId === options.gameId,
    )
    .filter(
      (record) =>
        options.status === undefined || record.status === options.status,
    )
    .sort(
      (left, right) =>
        right.updatedAt - left.updatedAt ||
        right.sessionId.localeCompare(left.sessionId),
    )
    .filter((record) =>
      cursor
        ? record.updatedAt < cursor.updatedAt ||
          (record.updatedAt === cursor.updatedAt &&
            record.sessionId.localeCompare(cursor.sessionId) < 0)
        : true,
    )
    .slice(0, limit)
    .map(clone);
  return {
    items: filtered,
    ...(filtered.length === limit
      ? {
          nextCursor: encodeCursor({
            updatedAt: filtered[filtered.length - 1].updatedAt,
            sessionId: filtered[filtered.length - 1].sessionId,
          }),
        }
      : {}),
  };
}

/** Clone-isolated in-memory directory projection with atomic apply operations. */
export class MemorySessionDirectory implements SessionDirectoryStore {
  readonly capabilities: SessionDirectoryCapabilities = {
    durable: false,
    serializableTransactions: true,
    boundedReads: true,
  };

  private state: MemoryState = { records: new Map(), facts: new Map() };
  private readonly lock = new Mutex();
  private readonly admission: SessionDirectoryAdmissionLookup;
  private readonly retentionResolver: SessionDirectoryOptions['retentionResolver'];
  private readonly now: () => number;

  constructor(options: SessionDirectoryOptions) {
    if (!options || typeof options !== 'object')
      throw new DirectoryError(
        'INVALID_ARGUMENT',
        'directory options are required',
        false,
      );
    this.admission = admissionLookup(options.admission);
    if (typeof options.retentionResolver !== 'function')
      throw new DirectoryError(
        'INVALID_ARGUMENT',
        'retentionResolver is required',
        false,
      );
    this.retentionResolver = options.retentionResolver;
    this.now = options.now ?? Date.now;
  }

  async applyFact(
    envelope: SessionDirectoryEnvelope,
  ): Promise<SessionDirectoryRecord> {
    validateEnvelope(envelope);
    const admission = await this.admission.getAdmission(envelope.sessionId);
    if (!admission)
      throw new DirectoryError(
        'ADMISSION_NOT_FOUND',
        `no frozen admission exists for ${envelope.sessionId}`,
        false,
      );
    validateAdmission(admission, envelope.sessionId);
    assertSourceMatches(envelope, admission.route);
    const retention = await this.retentionResolver(clone(admission));
    return this.lock.run(async () => {
      const current = this.state.records.get(envelope.sessionId) ?? null;
      if (current) assertRecordMatchesAdmission(current, admission);
      const currentFacts = [...this.state.facts.values()].filter(
        (fact) => fact.sessionId === envelope.sessionId,
      );
      const projection = applyProjection({
        envelope,
        admission: clone(admission),
        retention: normalizeRetentionValue(retention),
        now: this.now(),
        current: current ? clone(current) : null,
        currentFacts: currentFacts.map(clone),
      });
      if (!projection.applied) return clone(projection.record);
      const draft = copyState(this.state);
      draft.records.set(envelope.sessionId, clone(projection.record));
      draft.facts.set(factKey(projection.fact), clone(projection.fact));
      this.state = draft;
      return clone(projection.record);
    });
  }

  async getSession(sessionId: string): Promise<SessionDirectoryRecord | null> {
    assertSessionId(sessionId);
    const found = this.state.records.get(sessionId);
    return found ? clone(found) : null;
  }

  async listForPrincipal(
    principalId: string,
    options: SessionDirectoryListOptions = {},
  ): Promise<SessionDirectoryPage> {
    assertSessionId(principalId);
    validateListOptions(options);
    const values = [...this.state.records.values()].filter(
      (record) =>
        record.visibility === 'public' ||
        record.participants.some(
          (participant) => participantAccountId(participant) === principalId,
        ),
    );
    return page(values, options);
  }

  async listPublic(
    gameId: string,
    options: Omit<SessionDirectoryListOptions, 'gameId'> = {},
  ): Promise<SessionDirectoryPage> {
    assertSessionId(gameId);
    validateListOptions(options);
    return page(
      [...this.state.records.values()].filter(
        (record) =>
          record.visibility === 'public' && record.route.gameId === gameId,
      ),
      options,
    );
  }

  async close(): Promise<void> {
    // The memory driver owns no external resources.
  }
}

function normalizeRetentionValue(
  value: Awaited<ReturnType<SessionDirectoryOptions['retentionResolver']>>,
): { readonly retainSummary: boolean; readonly retainResult: boolean } {
  if (typeof value === 'string') {
    if (value === 'summary-and-replay')
      return { retainSummary: true, retainResult: true };
    if (value === 'progress-only')
      return { retainSummary: true, retainResult: false };
    if (value === 'ephemeral-result')
      return { retainSummary: false, retainResult: false };
  } else if (
    value &&
    typeof value === 'object' &&
    typeof value.retainSummary === 'boolean' &&
    typeof value.retainResult === 'boolean'
  )
    return value;
  throw new DirectoryError(
    'INVALID_ARGUMENT',
    'retention policy is invalid',
    false,
  );
}
