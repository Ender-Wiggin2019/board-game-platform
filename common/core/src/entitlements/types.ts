import type { JsonValue, SessionRoute } from '@board-game/contracts';

export type EntitlementReservationStatus =
  | 'reserved'
  | 'confirmed'
  | 'released';

export interface EntitlementGrantRequest {
  readonly namespace: string;
  readonly sourceRecordId: string;
  readonly principalId: string;
  readonly asset: string;
  readonly quantity: number;
  readonly metadata?: JsonValue;
  readonly createdAt?: number;
}

export interface EntitlementGrant extends EntitlementGrantRequest {
  readonly grantId: string;
  readonly digest: string;
  readonly createdAt: number;
}

export interface EntitlementBalanceKey {
  readonly namespace: string;
  readonly principalId: string;
  readonly asset: string;
}

export interface EntitlementBalance extends EntitlementBalanceKey {
  readonly granted: number;
  readonly consumed: number;
  readonly reserved: number;
  readonly available: number;
  readonly revision: number;
}

export interface EntitlementReservationRequest extends EntitlementBalanceKey {
  readonly sessionId: string;
  readonly commandId: string;
  readonly quantity: number;
  /** Immutable command intent required for session-scoped consumables. */
  readonly intent: EntitlementReservationIntent;
  /** Optional caller-generated id; when omitted the store derives one. */
  readonly reservationId?: string;
  readonly createdAt?: number;
}

export interface EntitlementReservationIntent {
  /** Complete frozen route; it contains no command or private game state. */
  readonly route: SessionRoute;
  /** Host input digest binding the reservation to commandId and actor. */
  readonly commandDigest: string;
  /** Digest of the authoritative requirement recomputed in the head transaction. */
  readonly requirementsDigest: string;
}

export interface EntitlementReservation
  extends EntitlementBalanceKey,
    Pick<
      EntitlementReservationRequest,
      'sessionId' | 'commandId' | 'quantity' | 'intent'
    > {
  readonly reservationId: string;
  readonly intentDigest: string;
  readonly status: EntitlementReservationStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface EntitlementReservationReference {
  readonly reservationId: string;
  readonly namespace?: string;
  readonly sessionId?: string;
  readonly commandId?: string;
  readonly principalId?: string;
  readonly asset?: string;
  readonly quantity?: number;
  readonly intentDigest?: string;
}

export type EntitlementReservationInput =
  | string
  | EntitlementReservationReference;

export interface EntitlementPendingOptions {
  readonly limit: number;
  readonly namespace?: string;
  readonly principalId?: string;
  readonly asset?: string;
  /** Optional route filters keep bounded reconciliation pages game-scoped. */
  readonly gameId?: string;
  readonly backendBindingId?: string;
  readonly storageBindingId?: string;
}

export interface EntitlementStoreCapabilities {
  readonly durable: boolean;
  readonly serializableTransactions: boolean;
  readonly boundedReads: boolean;
}

export interface EntitlementStore {
  readonly capabilities: EntitlementStoreCapabilities;
  /** Idempotently adds one source grant to a principal's asset balance. */
  grant(request: EntitlementGrantRequest): Promise<EntitlementGrant>;
  getGrant(
    key: Pick<
      EntitlementGrantRequest,
      'namespace' | 'sourceRecordId' | 'principalId' | 'asset'
    >,
  ): Promise<EntitlementGrant | null>;
  getBalance(key: EntitlementBalanceKey): Promise<EntitlementBalance>;
  /** Reserves available quantity without any automatic expiry. */
  reserve(
    request: EntitlementReservationRequest,
  ): Promise<EntitlementReservation>;
  getReservation(reservationId: string): Promise<EntitlementReservation | null>;
  /** Finds reservations bound to a session command, including terminal rows. */
  getReservationsForCommand(
    sessionId: string,
    commandId: string,
  ): Promise<readonly EntitlementReservation[]>;
  /** Confirm is idempotent for an already-confirmed reservation. */
  confirm(
    reference: EntitlementReservationInput,
  ): Promise<EntitlementReservation>;
  /** Release is idempotent for an already-released reservation. */
  release(
    reference: EntitlementReservationInput,
  ): Promise<EntitlementReservation>;
  /** Bounded replay/reconciliation list of reservations still in-flight. */
  listPending(
    options: EntitlementPendingOptions,
  ): Promise<readonly EntitlementReservation[]>;
  close(): Promise<void>;
}
