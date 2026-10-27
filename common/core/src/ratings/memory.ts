import { RatingError } from './errors.js';
import {
  assertPositiveInteger,
  assertString,
  clone,
  equalJson,
  validateParticipantSettlement,
  validateSettlementDraft,
  validateSettlementRecord,
  validateState,
} from './invariants.js';
import type {
  RatingSettlementRecord,
  RatingSettlementTransaction,
  RatingState,
  RatingStatePage,
  RatingStore,
  RatingStoreCapabilities,
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

interface PoolState {
  sequence: number;
  ratings: Map<string, RatingState>;
}

function key(sessionId: string, resultRevision: number): string {
  return JSON.stringify([sessionId, resultRevision]);
}

function assertPoolId(poolId: string): void {
  assertString(poolId, 'poolId');
}

function rankingCursor(score: number, participantId: string): string {
  return JSON.stringify([score, participantId]);
}

function parseRankingCursor(cursor: string): {
  score: number;
  participantId: string;
} {
  assertString(cursor, 'cursor');
  let value: unknown;
  try {
    value = JSON.parse(cursor);
  } catch {
    throw new RatingError(
      'INVALID_ARGUMENT',
      'rating ranking cursor is invalid',
    );
  }
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== 'number' ||
    !Number.isFinite(value[0]) ||
    typeof value[1] !== 'string' ||
    value[1].length === 0
  )
    throw new RatingError(
      'INVALID_ARGUMENT',
      'rating ranking cursor is invalid',
    );
  return { score: value[0], participantId: value[1] };
}

/** Clone-isolated reference store with transaction rollback and pool serialization. */
export class MemoryRatingStore implements RatingStore {
  readonly capabilities: RatingStoreCapabilities = {
    durable: false,
    serializableTransactions: true,
    boundedReads: true,
  };

  private readonly pools = new Map<string, PoolState>();
  private settlements = new Map<string, RatingSettlementRecord>();
  private readonly lock = new Mutex();

  private pool(poolId: string): PoolState {
    let value = this.pools.get(poolId);
    if (!value) {
      value = { sequence: 0, ratings: new Map() };
      this.pools.set(poolId, value);
    }
    return value;
  }

  async transaction<Result>(
    poolId: string,
    work: (tx: RatingSettlementTransaction) => Promise<Result>,
  ): Promise<Result> {
    assertPoolId(poolId);
    if (typeof work !== 'function')
      throw new RatingError(
        'INVALID_ARGUMENT',
        'transaction callback must be a function',
      );
    return this.lock.run(async () => {
      const current = this.pool(poolId);
      let sequence = current.sequence;
      const ratings = new Map<string, RatingState>();
      for (const [participantId, state] of current.ratings)
        ratings.set(participantId, clone(state));
      const settlements = new Map<string, RatingSettlementRecord>();
      for (const [settlementKey, record] of this.settlements)
        settlements.set(settlementKey, clone(record));
      let open = true;
      const assertOpen = (): void => {
        if (!open)
          throw new RatingError(
            'DATABASE_ERROR',
            'rating transaction is closed',
            false,
          );
      };
      const tx: RatingSettlementTransaction = {
        getSettlement: async (sessionId, resultRevision) => {
          assertOpen();
          assertString(sessionId, 'sessionId');
          assertPositiveInteger(resultRevision, 'resultRevision');
          const record = settlements.get(key(sessionId, resultRevision));
          return record ? clone(record) : null;
        },
        getState: async (participantId) => {
          assertOpen();
          assertString(participantId, 'participantId');
          const state = ratings.get(participantId);
          return state ? clone(state) : null;
        },
        commitSettlement: async (draft, states) => {
          assertOpen();
          validateSettlementDraft(draft);
          assertString(draft.poolId, 'settlement.poolId');
          if (draft.poolId !== poolId)
            throw new RatingError(
              'INVALID_ARGUMENT',
              'settlement pool does not match transaction',
            );
          if (settlements.has(key(draft.sessionId, draft.resultRevision)))
            throw new RatingError(
              'IDEMPOTENCY_CONFLICT',
              'settlement already exists',
              false,
            );
          if (
            !Array.isArray(states) ||
            states.length !== draft.participants.length
          )
            throw new RatingError(
              'INVALID_ARGUMENT',
              'rating state coverage does not match settlement',
            );
          const nextSequence = sequence + 1;
          assertPositiveInteger(nextSequence, 'settlement.sequence');
          for (const participant of draft.participants) {
            validateParticipantSettlement(participant, 64 * 1024);
          }
          const participantIds = new Set<string>();
          for (const state of states) {
            const candidate: RatingState = {
              ...state,
              updatedSequence: nextSequence,
            };
            validateState(candidate, 64 * 1024);
            if (state.poolId !== poolId)
              throw new RatingError(
                'INVALID_ARGUMENT',
                'rating state does not match settlement',
              );
            if (participantIds.has(state.participantId))
              throw new RatingError(
                'INVALID_ARGUMENT',
                'rating state contains duplicate participant',
              );
            participantIds.add(state.participantId);
            const settlementParticipant = draft.participants.find(
              (participant) =>
                participant.participantId === state.participantId,
            );
            if (
              !settlementParticipant ||
              !equalJson(settlementParticipant.initial, state.initial) ||
              !equalJson(settlementParticipant.after, state.value)
            )
              throw new RatingError(
                'INVALID_ARGUMENT',
                'rating state does not match settlement',
              );
          }
          if (participantIds.size !== draft.participants.length)
            throw new RatingError(
              'INVALID_ARGUMENT',
              'rating state coverage is incomplete',
            );
          const record: RatingSettlementRecord = {
            ...clone(draft),
            sequence: nextSequence,
          };
          validateSettlementRecord(record);
          for (const state of states)
            ratings.set(state.participantId, {
              ...clone(state),
              updatedSequence: nextSequence,
            });
          settlements.set(
            key(record.sessionId, record.resultRevision),
            clone(record),
          );
          sequence = nextSequence;
          return clone(record);
        },
      };
      try {
        const result = await work(tx);
        open = false;
        this.pools.set(poolId, {
          sequence,
          ratings: new Map(
            [...ratings].map(([id, state]) => [id, clone(state)]),
          ),
        });
        this.settlements = new Map(
          [...settlements].map(([settlementKey, record]) => [
            settlementKey,
            clone(record),
          ]),
        );
        return clone(result);
      } catch (error) {
        open = false;
        throw error;
      }
    });
  }

  async getSettlement(
    sessionId: string,
    resultRevision: number,
  ): Promise<RatingSettlementRecord | null> {
    assertString(sessionId, 'sessionId');
    assertPositiveInteger(resultRevision, 'resultRevision');
    const value = this.settlements.get(key(sessionId, resultRevision));
    return value ? clone(value) : null;
  }

  async getRating(
    poolId: string,
    participantId: string,
  ): Promise<RatingState | null> {
    assertPoolId(poolId);
    assertString(participantId, 'participantId');
    const value = this.pools.get(poolId)?.ratings.get(participantId);
    return value ? clone(value) : null;
  }

  async list(
    poolId: string,
    limit: number,
    cursor?: string,
  ): Promise<RatingStatePage> {
    assertPoolId(poolId);
    assertPositiveInteger(limit, 'limit');
    if (limit > 100)
      throw new RatingError(
        'INVALID_ARGUMENT',
        'rating list limit must be at most 100',
      );
    if (cursor !== undefined) assertString(cursor, 'cursor');
    const states = [...(this.pools.get(poolId)?.ratings.values() ?? [])]
      .sort((left, right) =>
        left.participantId.localeCompare(right.participantId),
      )
      .filter((state) => cursor === undefined || state.participantId > cursor);
    const page = states.slice(0, limit + 1);
    const hasMore = page.length > limit;
    const items = hasMore ? page.slice(0, limit) : page;
    return {
      items: items.map((state) => clone(state)),
      nextCursor: hasMore ? (items.at(-1)?.participantId ?? null) : null,
    };
  }

  async listByRanking(
    poolId: string,
    limit: number,
    cursor?: string,
  ): Promise<RatingStatePage> {
    assertPoolId(poolId);
    assertPositiveInteger(limit, 'limit');
    if (limit > 100)
      throw new RatingError(
        'INVALID_ARGUMENT',
        'rating list limit must be at most 100',
      );
    const parsed =
      cursor === undefined ? undefined : parseRankingCursor(cursor);
    const states = [...(this.pools.get(poolId)?.ratings.values() ?? [])]
      .filter((state) => state.rankingScore !== undefined)
      .sort(
        (left, right) =>
          (right.rankingScore ?? Number.NEGATIVE_INFINITY) -
            (left.rankingScore ?? Number.NEGATIVE_INFINITY) ||
          left.participantId.localeCompare(right.participantId),
      )
      .filter(
        (state) =>
          parsed === undefined ||
          (state.rankingScore ?? Number.NEGATIVE_INFINITY) < parsed.score ||
          ((state.rankingScore ?? Number.NEGATIVE_INFINITY) === parsed.score &&
            state.participantId > parsed.participantId),
      );
    const page = states.slice(0, limit + 1);
    const hasMore = page.length > limit;
    const items = hasMore ? page.slice(0, limit) : page;
    const last = items.at(-1);
    return {
      items: items.map((state) => clone(state)),
      nextCursor:
        hasMore && last?.rankingScore !== undefined
          ? rankingCursor(last.rankingScore, last.participantId)
          : null,
    };
  }

  async getRankedPosition(
    poolId: string,
    participantId: string,
  ): Promise<number | null> {
    assertPoolId(poolId);
    assertString(participantId, 'participantId');
    const state = this.pools.get(poolId)?.ratings.get(participantId);
    if (!state || state.rankingScore === undefined) return null;
    const score = state.rankingScore;
    const ahead = [...(this.pools.get(poolId)?.ratings.values() ?? [])].filter(
      (candidate) =>
        candidate.rankingScore !== undefined &&
        (candidate.rankingScore > score ||
          (candidate.rankingScore === score &&
            candidate.participantId < participantId)),
    ).length;
    return ahead + 1;
  }

  async close(): Promise<void> {
    // Memory storage owns no external resources.
  }
}
