import type {
  CompetitiveResult,
  JsonValue,
  MatchAdmission,
  Participant,
  SessionRoute,
} from '@board-game/contracts';
import type { AdmissionStore } from '../admission/types.js';

export interface RatingPolicyInput {
  readonly previous: Readonly<Record<string, JsonValue>>;
  /** Participant ids in the result's best-first order. Ties retain input order. */
  readonly ranking: readonly string[];
  readonly result: CompetitiveResult;
  readonly participants: readonly Participant[];
  readonly admission: MatchAdmission;
}

export interface RatingUpdate {
  readonly participantId: string;
  readonly after: JsonValue;
  /** Optional policy assertion checked against the persisted state. */
  readonly before?: JsonValue;
  /** Optional policy-owned comparable score used by bounded leaderboard reads. */
  readonly rankingScore?: number;
}

export interface RatingPolicy {
  readonly policyVersion: string;
  readonly progressionPolicyVersion: string;
  readonly initialState: (
    participant: Participant,
    admission: MatchAdmission,
  ) => JsonValue;
  readonly calculate: (input: RatingPolicyInput) => readonly RatingUpdate[];
}

export interface RatingPolicyRegistry {
  get(
    policyVersion: string,
    progressionPolicyVersion: string,
  ): RatingPolicy | null;
}

export interface RatingState {
  readonly poolId: string;
  readonly participantId: string;
  readonly policyVersion: string;
  readonly progressionPolicyVersion: string;
  readonly initial: JsonValue;
  readonly value: JsonValue;
  /** Policy projection; missing states are not ranked by listByRanking. */
  readonly rankingScore?: number;
  readonly updatedSequence: number;
}

/** One bounded, deterministic page of participant rating state. */
export interface RatingStatePage {
  readonly items: readonly RatingState[];
  /** Opaque participant-id cursor; null means this is the final page. */
  readonly nextCursor: string | null;
}

/** Input to an atomic settlement; the store assigns the pool sequence. */
export type RatingStateInput = Omit<RatingState, 'updatedSequence'>;

export interface RatingParticipantSettlement {
  readonly participantId: string;
  readonly initial: JsonValue;
  readonly before: JsonValue;
  readonly after: JsonValue;
}

export interface RatingSettlementRecord {
  readonly poolId: string;
  readonly sessionId: string;
  readonly resultRevision: number;
  readonly digest: string;
  readonly occurredAt: number;
  readonly sequence: number;
  readonly policyVersion: string;
  readonly progressionPolicyVersion: string;
  readonly seasonId: string | null;
  readonly route: SessionRoute;
  readonly result: CompetitiveResult;
  readonly participants: readonly RatingParticipantSettlement[];
}

export interface RatingSettlementDraft
  extends Omit<RatingSettlementRecord, 'sequence'> {}

export interface RatingSettlementTransaction {
  getSettlement(
    sessionId: string,
    resultRevision: number,
  ): Promise<RatingSettlementRecord | null>;
  getState(participantId: string): Promise<RatingState | null>;
  commitSettlement(
    draft: RatingSettlementDraft,
    states: readonly RatingStateInput[],
  ): Promise<RatingSettlementRecord>;
}

export interface RatingStoreCapabilities {
  readonly durable: boolean;
  readonly serializableTransactions: boolean;
  readonly boundedReads: boolean;
}

export interface RatingStore {
  readonly capabilities: RatingStoreCapabilities;
  transaction<Result>(
    poolId: string,
    work: (tx: RatingSettlementTransaction) => Promise<Result>,
  ): Promise<Result>;
  getSettlement(
    sessionId: string,
    resultRevision: number,
  ): Promise<RatingSettlementRecord | null>;
  getRating(poolId: string, participantId: string): Promise<RatingState | null>;
  /**
   * Read participant states without loading an unbounded pool. The core store
   * orders by participant id; game policies own any score/rank ordering.
   */
  list(
    poolId: string,
    limit: number,
    cursor?: string,
  ): Promise<RatingStatePage>;
  /** Read policy-projected states in descending score order. */
  listByRanking(
    poolId: string,
    limit: number,
    cursor?: string,
  ): Promise<RatingStatePage>;
  /** Return the 1-based policy-projected rank for one participant. */
  getRankedPosition(
    poolId: string,
    participantId: string,
  ): Promise<number | null>;
  close(): Promise<void>;
}

export interface RatingSettlementRequest {
  readonly sessionId: string;
  readonly resultRevision: number;
  readonly result: unknown;
  readonly occurredAt: number;
}

export interface RatingSettlementServiceOptions {
  readonly store: RatingStore;
  readonly admissions: Pick<AdmissionStore, 'getAdmission'>;
  readonly policies: RatingPolicyRegistry;
  readonly maxStateBytes?: number;
}

export interface RatingSettlementRunner {
  settle(request: RatingSettlementRequest): Promise<RatingSettlementRecord>;
}
