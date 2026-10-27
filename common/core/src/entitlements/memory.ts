import { EntitlementError } from './errors.js';
import {
  assertReferenceMatches,
  assertStoredQuantity,
  assertString,
  assertTimestamp,
  balanceKey,
  buildBalance,
  clone,
  commandKey,
  grantDigest,
  grantIdFor,
  grantKey,
  reservationDigest,
  reservationIdFor,
  reservationIntentDigest,
  validateBalanceKey,
  validateGrantRequest,
  validatePendingOptions,
  validateReservationInput,
  validateReservationRequest,
} from './invariants.js';
import type {
  EntitlementBalance,
  EntitlementBalanceKey,
  EntitlementGrant,
  EntitlementGrantRequest,
  EntitlementPendingOptions,
  EntitlementReservation,
  EntitlementReservationInput,
  EntitlementReservationRequest,
  EntitlementStore,
  EntitlementStoreCapabilities,
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
  grants: Map<string, EntitlementGrant>;
  balances: Map<string, EntitlementBalance>;
  reservations: Map<string, EntitlementReservation>;
  commands: Map<string, string>;
}

export interface MemoryEntitlementStoreOptions {
  readonly now?: () => number;
}

function copyState(state: MemoryState): MemoryState {
  return {
    grants: new Map(
      [...state.grants].map(([key, value]) => [key, clone(value)]),
    ),
    balances: new Map(
      [...state.balances].map(([key, value]) => [key, clone(value)]),
    ),
    reservations: new Map(
      [...state.reservations].map(([key, value]) => [key, clone(value)]),
    ),
    commands: new Map(state.commands),
  };
}

function balanceFromState(
  state: MemoryState,
  key: EntitlementBalanceKey,
): EntitlementBalance {
  return state.balances.get(balanceKey(key)) ?? buildBalance(key, 0, 0, 0, 0);
}

function setBalance(
  state: MemoryState,
  key: EntitlementBalanceKey,
  value: EntitlementBalance,
): void {
  state.balances.set(balanceKey(key), clone(value));
}

function reservationMatches(
  request: EntitlementReservationRequest,
  reservation: EntitlementReservation,
): boolean {
  return (
    reservationDigest(request) ===
    reservationDigest({
      namespace: reservation.namespace,
      sessionId: reservation.sessionId,
      commandId: reservation.commandId,
      principalId: reservation.principalId,
      asset: reservation.asset,
      quantity: reservation.quantity,
      intent: reservation.intent,
    })
  );
}

function requireReservation(
  state: MemoryState,
  reservationId: string,
): EntitlementReservation {
  const reservation = state.reservations.get(reservationId);
  if (!reservation)
    throw new EntitlementError(
      'RESERVATION_NOT_FOUND',
      `Reservation ${reservationId} does not exist`,
      false,
    );
  return reservation;
}

/** Clone-isolated in-process entitlement ledger with serialized atomic operations. */
export class MemoryEntitlementStore implements EntitlementStore {
  readonly capabilities: EntitlementStoreCapabilities = {
    durable: false,
    serializableTransactions: true,
    boundedReads: true,
  };

  private state: MemoryState = {
    grants: new Map(),
    balances: new Map(),
    reservations: new Map(),
    commands: new Map(),
  };
  private readonly lock = new Mutex();
  private readonly now: () => number;

  constructor(options: MemoryEntitlementStoreOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  async grant(request: EntitlementGrantRequest): Promise<EntitlementGrant> {
    validateGrantRequest(request);
    return this.lock.run(async () => {
      const key = grantKey(request);
      const digest = grantDigest(request);
      const existing = this.state.grants.get(key);
      if (existing) {
        if (existing.digest !== digest)
          throw new EntitlementError(
            'IDEMPOTENCY_CONFLICT',
            `Grant ${key} has a different source payload`,
            false,
          );
        return clone(existing);
      }
      const createdAt = request.createdAt ?? this.now();
      assertTimestamp(createdAt, 'createdAt');
      const draft = copyState(this.state);
      const record: EntitlementGrant = {
        namespace: request.namespace,
        sourceRecordId: request.sourceRecordId,
        principalId: request.principalId,
        asset: request.asset,
        quantity: request.quantity,
        ...(request.metadata !== undefined
          ? { metadata: clone(request.metadata) }
          : {}),
        grantId: grantIdFor(request),
        digest,
        createdAt,
      };
      const current = balanceFromState(draft, request);
      setBalance(
        draft,
        request,
        buildBalance(
          request,
          current.granted + request.quantity,
          current.consumed,
          current.reserved,
          current.revision + 1,
        ),
      );
      draft.grants.set(key, clone(record));
      this.state = draft;
      return clone(record);
    });
  }

  async getGrant(
    key: Pick<
      EntitlementGrantRequest,
      'namespace' | 'sourceRecordId' | 'principalId' | 'asset'
    >,
  ): Promise<EntitlementGrant | null> {
    validateGrantRequest({ ...key, quantity: 1 });
    const found = this.state.grants.get(grantKey(key));
    return found ? clone(found) : null;
  }

  async getBalance(key: EntitlementBalanceKey): Promise<EntitlementBalance> {
    validateBalanceKey(key);
    return clone(balanceFromState(this.state, key));
  }

  async reserve(
    request: EntitlementReservationRequest,
  ): Promise<EntitlementReservation> {
    validateReservationRequest(request);
    return this.lock.run(async () => {
      const id = request.reservationId ?? reservationIdFor(request);
      const existing = this.state.reservations.get(id);
      if (existing) {
        if (!reservationMatches(request, existing))
          throw new EntitlementError(
            'IDEMPOTENCY_CONFLICT',
            `Reservation ${id} has a different request`,
            false,
          );
        return clone(existing);
      }
      const existingCommand = this.state.commands.get(commandKey(request));
      if (existingCommand)
        throw new EntitlementError(
          'IDEMPOTENCY_CONFLICT',
          `Command ${request.namespace}/${request.sessionId}/${request.commandId} already has a reservation`,
          false,
        );
      const createdAt = request.createdAt ?? this.now();
      assertTimestamp(createdAt, 'createdAt');
      const draft = copyState(this.state);
      const current = balanceFromState(draft, request);
      if (current.available < request.quantity)
        throw new EntitlementError(
          'INSUFFICIENT_BALANCE',
          `Insufficient ${request.namespace}/${request.asset} balance for ${request.principalId}`,
          false,
        );
      const reservation: EntitlementReservation = {
        namespace: request.namespace,
        sessionId: request.sessionId,
        commandId: request.commandId,
        principalId: request.principalId,
        asset: request.asset,
        quantity: request.quantity,
        reservationId: id,
        intent: clone(request.intent),
        intentDigest: reservationIntentDigest(request.intent),
        status: 'reserved',
        createdAt,
        updatedAt: createdAt,
      };
      draft.reservations.set(id, clone(reservation));
      draft.commands.set(commandKey(request), id);
      setBalance(
        draft,
        request,
        buildBalance(
          request,
          current.granted,
          current.consumed,
          current.reserved + request.quantity,
          current.revision + 1,
        ),
      );
      this.state = draft;
      return clone(reservation);
    });
  }

  async getReservation(
    reservationId: string,
  ): Promise<EntitlementReservation | null> {
    const input = validateReservationInput(reservationId);
    const found = this.state.reservations.get(input.reservationId);
    return found ? clone(found) : null;
  }

  async getReservationsForCommand(
    sessionId: string,
    commandId: string,
  ): Promise<readonly EntitlementReservation[]> {
    assertString(sessionId, 'sessionId');
    assertString(commandId, 'commandId');
    return [...this.state.reservations.values()]
      .filter(
        (reservation) =>
          reservation.sessionId === sessionId &&
          reservation.commandId === commandId,
      )
      .map(clone);
  }

  async confirm(
    reference: EntitlementReservationInput,
  ): Promise<EntitlementReservation> {
    return this.transition(reference, 'confirmed');
  }

  async release(
    reference: EntitlementReservationInput,
  ): Promise<EntitlementReservation> {
    return this.transition(reference, 'released');
  }

  private async transition(
    input: EntitlementReservationInput,
    target: 'confirmed' | 'released',
  ): Promise<EntitlementReservation> {
    const reference = validateReservationInput(input);
    return this.lock.run(async () => {
      const existing = requireReservation(this.state, reference.reservationId);
      assertReferenceMatches(reference, existing);
      if (existing.status === target) return clone(existing);
      if (existing.status !== 'reserved')
        throw new EntitlementError(
          'RESERVATION_TERMINAL',
          `Reservation ${existing.reservationId} is already ${existing.status}`,
          false,
        );
      const updatedAt = this.now();
      assertTimestamp(updatedAt, 'updatedAt');
      const draft = copyState(this.state);
      const balance = balanceFromState(draft, existing);
      assertStoredQuantity(balance.reserved, 'reserved');
      if (balance.reserved < existing.quantity)
        throw new EntitlementError(
          'DATABASE_ERROR',
          `Reservation ${existing.reservationId} is not represented in its balance`,
          false,
        );
      const next = buildBalance(
        existing,
        balance.granted,
        target === 'confirmed'
          ? balance.consumed + existing.quantity
          : balance.consumed,
        balance.reserved - existing.quantity,
        balance.revision + 1,
      );
      setBalance(draft, existing, next);
      const reservation: EntitlementReservation = {
        ...existing,
        status: target,
        updatedAt,
      };
      draft.reservations.set(existing.reservationId, clone(reservation));
      this.state = draft;
      return clone(reservation);
    });
  }

  async listPending(
    options: EntitlementPendingOptions,
  ): Promise<readonly EntitlementReservation[]> {
    validatePendingOptions(options);
    return [...this.state.reservations.values()]
      .filter(
        (reservation) =>
          reservation.status === 'reserved' &&
          (options.namespace === undefined ||
            reservation.namespace === options.namespace) &&
          (options.principalId === undefined ||
            reservation.principalId === options.principalId) &&
          (options.asset === undefined ||
            reservation.asset === options.asset) &&
          (options.gameId === undefined ||
            reservation.intent.route.gameId === options.gameId) &&
          (options.backendBindingId === undefined ||
            reservation.intent.route.backendBindingId ===
              options.backendBindingId) &&
          (options.storageBindingId === undefined ||
            reservation.intent.route.storageBindingId ===
              options.storageBindingId),
      )
      .sort(
        (left, right) =>
          left.createdAt - right.createdAt ||
          left.reservationId.localeCompare(right.reservationId),
      )
      .slice(0, options.limit)
      .map(clone);
  }

  async close(): Promise<void> {
    // The memory driver owns no external resources.
  }
}
