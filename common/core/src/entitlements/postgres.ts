import {
  canonicalStableStringify,
  type JsonValue,
} from '@board-game/contracts';
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { EntitlementError } from './errors.js';
import {
  assertReferenceMatches,
  assertStoredQuantity,
  assertStoredTimestamp,
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
import {
  assertEntitlementSchemaName,
  DEFAULT_ENTITLEMENT_SCHEMA,
  entitlementMigrationStatements,
  entitlementTableName,
} from './migration.js';
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

type Row = Record<string, unknown>;

export interface PostgresEntitlementStoreOptions {
  readonly connectionString?: string;
  readonly pool?: Pool;
  readonly poolConfig?: PoolConfig;
  /** Must be a validated identifier; SQL never changes search_path. */
  readonly schema?: string;
  readonly now?: () => number;
}

function asEntitlementError(error: unknown): EntitlementError {
  if (error instanceof EntitlementError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  if (code === '42P01' || code === '3F000')
    return new EntitlementError(
      'MIGRATION_REQUIRED',
      'entitlement schema has not been migrated',
      false,
    );
  if (code === '40001' || code === '40P01')
    return new EntitlementError(
      'DATABASE_ERROR',
      'entitlement transaction was aborted',
      true,
    );
  if (code === '23505')
    return new EntitlementError(
      'IDEMPOTENCY_CONFLICT',
      'entitlement operation conflicts with an existing record',
      false,
    );
  return new EntitlementError(
    'DATABASE_ERROR',
    error instanceof Error ? error.message : String(error),
  );
}

function rowString(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value.length === 0)
    throw new EntitlementError(
      'DATABASE_ERROR',
      `entitlement row has invalid ${key}`,
      false,
    );
  return value;
}

function rowNumber(row: Row, key: string): number {
  const value = Number(row[key]);
  if (!Number.isFinite(value))
    throw new EntitlementError(
      'DATABASE_ERROR',
      `entitlement row has invalid ${key}`,
      false,
    );
  return value;
}

function rowJson(row: Row, key: string): JsonValue {
  const value = row[key];
  try {
    canonicalStableStringify(value);
  } catch {
    throw new EntitlementError(
      'DATABASE_ERROR',
      `entitlement row has invalid ${key}`,
      false,
    );
  }
  return clone(value as JsonValue);
}

function optionalRowJson(row: Row, key: string): JsonValue | undefined {
  if (row[key] === null || row[key] === undefined) return undefined;
  return rowJson(row, key);
}

function rowToGrant(row: Row): EntitlementGrant {
  const quantity = rowNumber(row, 'quantity');
  assertStoredQuantity(quantity, 'quantity');
  if (quantity < 1)
    throw new EntitlementError(
      'DATABASE_ERROR',
      'entitlement grant quantity is invalid',
      false,
    );
  const createdAt = rowNumber(row, 'created_at');
  assertStoredTimestamp(createdAt, 'created_at');
  return {
    namespace: rowString(row, 'namespace'),
    sourceRecordId: rowString(row, 'source_record_id'),
    principalId: rowString(row, 'principal_id'),
    asset: rowString(row, 'asset'),
    quantity,
    ...(optionalRowJson(row, 'metadata') !== undefined
      ? { metadata: optionalRowJson(row, 'metadata') }
      : {}),
    grantId: rowString(row, 'grant_id'),
    digest: rowString(row, 'digest'),
    createdAt,
  };
}

function rowToBalance(row: Row): EntitlementBalance {
  const granted = rowNumber(row, 'granted');
  const consumed = rowNumber(row, 'consumed');
  const reserved = rowNumber(row, 'reserved');
  const revision = rowNumber(row, 'revision');
  return buildBalance(
    {
      namespace: rowString(row, 'namespace'),
      principalId: rowString(row, 'principal_id'),
      asset: rowString(row, 'asset'),
    },
    granted,
    consumed,
    reserved,
    revision,
  );
}

function rowToReservation(row: Row): EntitlementReservation {
  const quantity = rowNumber(row, 'quantity');
  assertStoredQuantity(quantity, 'quantity');
  if (quantity < 1)
    throw new EntitlementError(
      'DATABASE_ERROR',
      'entitlement reservation quantity is invalid',
      false,
    );
  const createdAt = rowNumber(row, 'created_at');
  const updatedAt = rowNumber(row, 'updated_at');
  assertStoredTimestamp(createdAt, 'created_at');
  assertStoredTimestamp(updatedAt, 'updated_at');
  const status = rowString(row, 'status');
  if (status !== 'reserved' && status !== 'confirmed' && status !== 'released')
    throw new EntitlementError(
      'DATABASE_ERROR',
      'entitlement reservation status is invalid',
      false,
    );
  const rawIntent = rowJson(row, 'intent');
  let intent: EntitlementReservation['intent'];
  try {
    intent = rawIntent as unknown as EntitlementReservation['intent'];
    validateReservationRequest({
      namespace: rowString(row, 'namespace'),
      sessionId: rowString(row, 'session_id'),
      commandId: rowString(row, 'command_id'),
      principalId: rowString(row, 'principal_id'),
      asset: rowString(row, 'asset'),
      quantity,
      intent,
    });
  } catch {
    throw new EntitlementError(
      'DATABASE_ERROR',
      'entitlement reservation intent is invalid',
      false,
    );
  }
  const intentDigest = rowString(row, 'intent_digest');
  if (intentDigest !== reservationIntentDigest(intent))
    throw new EntitlementError(
      'DATABASE_ERROR',
      'entitlement reservation intent digest is invalid',
      false,
    );
  return {
    reservationId: rowString(row, 'reservation_id'),
    namespace: rowString(row, 'namespace'),
    sessionId: rowString(row, 'session_id'),
    commandId: rowString(row, 'command_id'),
    principalId: rowString(row, 'principal_id'),
    asset: rowString(row, 'asset'),
    quantity,
    status,
    intent,
    intentDigest,
    createdAt,
    updatedAt,
  };
}

function assertExistingGrantMatches(
  request: EntitlementGrantRequest,
  existing: EntitlementGrant,
): void {
  if (existing.digest !== grantDigest(request))
    throw new EntitlementError(
      'IDEMPOTENCY_CONFLICT',
      `Grant ${grantKey(request)} has a different source payload`,
      false,
    );
}

function assertExistingReservationMatches(
  request: EntitlementReservationRequest,
  existing: EntitlementReservation,
): void {
  if (
    existing.reservationId !==
      (request.reservationId ?? existing.reservationId) ||
    reservationDigest(request) !==
      reservationDigest({
        namespace: existing.namespace,
        sessionId: existing.sessionId,
        commandId: existing.commandId,
        principalId: existing.principalId,
        asset: existing.asset,
        quantity: existing.quantity,
        intent: existing.intent,
      })
  )
    throw new EntitlementError(
      'IDEMPOTENCY_CONFLICT',
      `Reservation ${existing.reservationId} has a different request`,
      false,
    );
}

function reservationFromRow(row: Row): EntitlementReservation {
  return rowToReservation(row);
}

/** Durable entitlement ledger backed by explicit migrations and advisory locks. */
export class PostgresEntitlementStore implements EntitlementStore {
  readonly capabilities: EntitlementStoreCapabilities = {
    durable: true,
    serializableTransactions: true,
    boundedReads: true,
  };

  readonly schema: string;
  private readonly pool: Pool;
  private readonly ownsPool: boolean;
  private readonly now: () => number;

  constructor(options: PostgresEntitlementStoreOptions | string = {}) {
    const normalized =
      typeof options === 'string' ? { connectionString: options } : options;
    this.schema = normalized.schema ?? DEFAULT_ENTITLEMENT_SCHEMA;
    assertEntitlementSchemaName(this.schema);
    this.now = normalized.now ?? Date.now;
    if (normalized.pool) {
      this.pool = normalized.pool;
      this.ownsPool = false;
    } else {
      this.pool = new Pool({
        ...normalized.poolConfig,
        connectionString:
          normalized.connectionString ??
          normalized.poolConfig?.connectionString,
      });
      this.ownsPool = true;
    }
  }

  async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const statement of entitlementMigrationStatements(this.schema))
        await client.query(statement);
      await this.upgradeReservationIntentColumns(client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw asEntitlementError(error);
    } finally {
      client.release();
    }
  }

  async grant(request: EntitlementGrantRequest): Promise<EntitlementGrant> {
    validateGrantRequest(request);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.lock(client, `grant:${grantKey(request)}`);
      const grants = entitlementTableName(this.schema, 'grants');
      const existingResult = await client.query(
        `SELECT * FROM ${grants}
          WHERE namespace = $1 AND source_record_id = $2
            AND principal_id = $3 AND asset = $4`,
        [
          request.namespace,
          request.sourceRecordId,
          request.principalId,
          request.asset,
        ],
      );
      if (existingResult.rows[0]) {
        const existing = rowToGrant(existingResult.rows[0] as Row);
        assertExistingGrantMatches(request, existing);
        await client.query('COMMIT');
        return clone(existing);
      }
      const createdAt = request.createdAt ?? this.now();
      assertTimestamp(createdAt, 'createdAt');
      await this.lock(client, `balance:${balanceKey(request)}`);
      const balances = entitlementTableName(this.schema, 'balances');
      const balanceResult = await client.query(
        `SELECT * FROM ${balances}
          WHERE namespace = $1 AND principal_id = $2 AND asset = $3
          FOR UPDATE`,
        [request.namespace, request.principalId, request.asset],
      );
      const current = balanceResult.rows[0]
        ? rowToBalance(balanceResult.rows[0] as Row)
        : buildBalance(request, 0, 0, 0, 0);
      const next = buildBalance(
        request,
        current.granted + request.quantity,
        current.consumed,
        current.reserved,
        current.revision + 1,
      );
      if (balanceResult.rows[0]) {
        await client.query(
          `UPDATE ${balances}
              SET granted = $4, consumed = $5, reserved = $6, revision = $7
            WHERE namespace = $1 AND principal_id = $2 AND asset = $3`,
          [
            request.namespace,
            request.principalId,
            request.asset,
            next.granted,
            next.consumed,
            next.reserved,
            next.revision,
          ],
        );
      } else {
        await client.query(
          `INSERT INTO ${balances}
            (namespace, principal_id, asset, granted, consumed, reserved, revision)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            request.namespace,
            request.principalId,
            request.asset,
            next.granted,
            next.consumed,
            next.reserved,
            next.revision,
          ],
        );
      }
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
        digest: grantDigest(request),
        createdAt,
      };
      await client.query(
        `INSERT INTO ${grants}
          (namespace, source_record_id, principal_id, asset, quantity, metadata, digest, grant_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`,
        [
          record.namespace,
          record.sourceRecordId,
          record.principalId,
          record.asset,
          record.quantity,
          record.metadata === undefined
            ? null
            : JSON.stringify(record.metadata),
          record.digest,
          record.grantId,
          record.createdAt,
        ],
      );
      await client.query('COMMIT');
      return clone(record);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw asEntitlementError(error);
    } finally {
      client.release();
    }
  }

  async getGrant(
    key: Pick<
      EntitlementGrantRequest,
      'namespace' | 'sourceRecordId' | 'principalId' | 'asset'
    >,
  ): Promise<EntitlementGrant | null> {
    validateGrantRequest({ ...key, quantity: 1 });
    try {
      const result = await this.pool.query(
        `SELECT * FROM ${entitlementTableName(this.schema, 'grants')}
          WHERE namespace = $1 AND source_record_id = $2
            AND principal_id = $3 AND asset = $4`,
        [key.namespace, key.sourceRecordId, key.principalId, key.asset],
      );
      return result.rows[0] ? clone(rowToGrant(result.rows[0] as Row)) : null;
    } catch (error) {
      throw asEntitlementError(error);
    }
  }

  async getBalance(key: EntitlementBalanceKey): Promise<EntitlementBalance> {
    validateBalanceKey(key);
    try {
      const result = await this.pool.query(
        `SELECT * FROM ${entitlementTableName(this.schema, 'balances')}
          WHERE namespace = $1 AND principal_id = $2 AND asset = $3`,
        [key.namespace, key.principalId, key.asset],
      );
      return result.rows[0]
        ? clone(rowToBalance(result.rows[0] as Row))
        : buildBalance(key, 0, 0, 0, 0);
    } catch (error) {
      throw asEntitlementError(error);
    }
  }

  async reserve(
    request: EntitlementReservationRequest,
  ): Promise<EntitlementReservation> {
    validateReservationRequest(request);
    const id = request.reservationId ?? reservationIdFor(request);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.lock(client, `reservation:${id}`);
      await this.lock(client, `command:${commandKey(request)}`);
      const reservations = entitlementTableName(this.schema, 'reservations');
      const existingResult = await client.query(
        `SELECT * FROM ${reservations}
          WHERE reservation_id = $1
          FOR UPDATE`,
        [id],
      );
      if (existingResult.rows[0]) {
        const existing = rowToReservation(existingResult.rows[0] as Row);
        assertExistingReservationMatches(request, existing);
        await client.query('COMMIT');
        return clone(existing);
      }
      const commandResult = await client.query(
        `SELECT * FROM ${reservations}
          WHERE namespace = $1 AND session_id = $2 AND command_id = $3
          FOR UPDATE`,
        [request.namespace, request.sessionId, request.commandId],
      );
      if (commandResult.rows[0])
        throw new EntitlementError(
          'IDEMPOTENCY_CONFLICT',
          `Command ${request.namespace}/${request.sessionId}/${request.commandId} already has a reservation`,
          false,
        );
      await this.lock(client, `balance:${balanceKey(request)}`);
      const balances = entitlementTableName(this.schema, 'balances');
      const balanceResult = await client.query(
        `SELECT * FROM ${balances}
          WHERE namespace = $1 AND principal_id = $2 AND asset = $3
          FOR UPDATE`,
        [request.namespace, request.principalId, request.asset],
      );
      const current = balanceResult.rows[0]
        ? rowToBalance(balanceResult.rows[0] as Row)
        : buildBalance(request, 0, 0, 0, 0);
      if (current.available < request.quantity)
        throw new EntitlementError(
          'INSUFFICIENT_BALANCE',
          `Insufficient ${request.namespace}/${request.asset} balance for ${request.principalId}`,
          false,
        );
      const createdAt = request.createdAt ?? this.now();
      assertTimestamp(createdAt, 'createdAt');
      const next = buildBalance(
        request,
        current.granted,
        current.consumed,
        current.reserved + request.quantity,
        current.revision + 1,
      );
      if (!balanceResult.rows[0])
        throw new EntitlementError(
          'DATABASE_ERROR',
          'entitlement balance disappeared before reservation',
          false,
        );
      await client.query(
        `UPDATE ${balances}
            SET granted = $4, consumed = $5, reserved = $6, revision = $7
          WHERE namespace = $1 AND principal_id = $2 AND asset = $3`,
        [
          request.namespace,
          request.principalId,
          request.asset,
          next.granted,
          next.consumed,
          next.reserved,
          next.revision,
        ],
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
      await client.query(
        `INSERT INTO ${reservations}
          (reservation_id, namespace, session_id, command_id, principal_id, asset, quantity, intent, intent_digest, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, 'reserved', $10, $10)`,
        [
          reservation.reservationId,
          reservation.namespace,
          reservation.sessionId,
          reservation.commandId,
          reservation.principalId,
          reservation.asset,
          reservation.quantity,
          JSON.stringify(reservation.intent),
          reservation.intentDigest,
          reservation.createdAt,
        ],
      );
      await client.query('COMMIT');
      return clone(reservation);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw asEntitlementError(error);
    } finally {
      client.release();
    }
  }

  async getReservation(
    reservationId: string,
  ): Promise<EntitlementReservation | null> {
    const input = validateReservationInput(reservationId);
    try {
      const result = await this.pool.query(
        `SELECT * FROM ${entitlementTableName(this.schema, 'reservations')}
          WHERE reservation_id = $1`,
        [input.reservationId],
      );
      return result.rows[0]
        ? clone(reservationFromRow(result.rows[0] as Row))
        : null;
    } catch (error) {
      throw asEntitlementError(error);
    }
  }

  async getReservationsForCommand(
    sessionId: string,
    commandId: string,
  ): Promise<readonly EntitlementReservation[]> {
    assertString(sessionId, 'sessionId');
    assertString(commandId, 'commandId');
    try {
      const result = await this.pool.query(
        `SELECT * FROM ${entitlementTableName(this.schema, 'reservations')}
          WHERE session_id = $1 AND command_id = $2
          ORDER BY reservation_id`,
        [sessionId, commandId],
      );
      return result.rows.map((row) => clone(reservationFromRow(row as Row)));
    } catch (error) {
      throw asEntitlementError(error);
    }
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
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.lock(client, `reservation:${reference.reservationId}`);
      const reservations = entitlementTableName(this.schema, 'reservations');
      const result = await client.query(
        `SELECT * FROM ${reservations} WHERE reservation_id = $1 FOR UPDATE`,
        [reference.reservationId],
      );
      if (!result.rows[0])
        throw new EntitlementError(
          'RESERVATION_NOT_FOUND',
          `Reservation ${reference.reservationId} does not exist`,
          false,
        );
      const existing = rowToReservation(result.rows[0] as Row);
      assertReferenceMatches(reference, existing);
      if (existing.status === target) {
        await client.query('COMMIT');
        return clone(existing);
      }
      if (existing.status !== 'reserved')
        throw new EntitlementError(
          'RESERVATION_TERMINAL',
          `Reservation ${existing.reservationId} is already ${existing.status}`,
          false,
        );
      await this.lock(client, `balance:${balanceKey(existing)}`);
      const balances = entitlementTableName(this.schema, 'balances');
      const balanceResult = await client.query(
        `SELECT * FROM ${balances}
          WHERE namespace = $1 AND principal_id = $2 AND asset = $3
          FOR UPDATE`,
        [existing.namespace, existing.principalId, existing.asset],
      );
      if (!balanceResult.rows[0])
        throw new EntitlementError(
          'DATABASE_ERROR',
          'entitlement balance disappeared before transition',
          false,
        );
      const current = rowToBalance(balanceResult.rows[0] as Row);
      if (current.reserved < existing.quantity)
        throw new EntitlementError(
          'DATABASE_ERROR',
          `Reservation ${existing.reservationId} is not represented in its balance`,
          false,
        );
      const updatedAt = this.now();
      assertTimestamp(updatedAt, 'updatedAt');
      const next = buildBalance(
        existing,
        current.granted,
        target === 'confirmed'
          ? current.consumed + existing.quantity
          : current.consumed,
        current.reserved - existing.quantity,
        current.revision + 1,
      );
      await client.query(
        `UPDATE ${balances}
            SET granted = $4, consumed = $5, reserved = $6, revision = $7
          WHERE namespace = $1 AND principal_id = $2 AND asset = $3`,
        [
          existing.namespace,
          existing.principalId,
          existing.asset,
          next.granted,
          next.consumed,
          next.reserved,
          next.revision,
        ],
      );
      await client.query(
        `UPDATE ${reservations}
            SET status = $2, updated_at = $3
          WHERE reservation_id = $1`,
        [existing.reservationId, target, updatedAt],
      );
      const reservation: EntitlementReservation = {
        ...existing,
        status: target,
        updatedAt,
      };
      await client.query('COMMIT');
      return clone(reservation);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw asEntitlementError(error);
    } finally {
      client.release();
    }
  }

  async listPending(
    options: EntitlementPendingOptions,
  ): Promise<readonly EntitlementReservation[]> {
    validatePendingOptions(options);
    const params: unknown[] = ['reserved'];
    const predicates = ['status = $1'];
    if (options.namespace !== undefined) {
      params.push(options.namespace);
      predicates.push(`namespace = $${params.length}`);
    }
    if (options.principalId !== undefined) {
      params.push(options.principalId);
      predicates.push(`principal_id = $${params.length}`);
    }
    if (options.asset !== undefined) {
      params.push(options.asset);
      predicates.push(`asset = $${params.length}`);
    }
    if (options.gameId !== undefined) {
      params.push(options.gameId);
      predicates.push(`intent->'route'->>'gameId' = $${params.length}`);
    }
    if (options.backendBindingId !== undefined) {
      params.push(options.backendBindingId);
      predicates.push(
        `intent->'route'->>'backendBindingId' = $${params.length}`,
      );
    }
    if (options.storageBindingId !== undefined) {
      params.push(options.storageBindingId);
      predicates.push(
        `intent->'route'->>'storageBindingId' = $${params.length}`,
      );
    }
    params.push(options.limit);
    try {
      const result = await this.pool.query(
        `SELECT * FROM ${entitlementTableName(this.schema, 'reservations')}
          WHERE ${predicates.join(' AND ')}
          ORDER BY created_at, reservation_id
          LIMIT $${params.length}`,
        params,
      );
      return result.rows.map((row) => clone(rowToReservation(row as Row)));
    } catch (error) {
      throw asEntitlementError(error);
    }
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }

  /**
   * The reservation intent was added after the first ledger schema. Empty
   * legacy tables can be upgraded in place. A non-empty legacy table is
   * deliberately left untouched: its rows have no trusted command digest or
   * route, so an operator must review and migrate them explicitly before this
   * store can reconcile or release them.
   */
  private async upgradeReservationIntentColumns(
    client: PoolClient,
  ): Promise<void> {
    const reservations = entitlementTableName(this.schema, 'reservations');
    const columns = await client.query(
      `SELECT column_name, is_nullable
         FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'reservations'`,
      [this.schema],
    );
    const byName = new Map<string, string>(
      columns.rows.map((row) => [
        String(row.column_name),
        String(row.is_nullable),
      ]),
    );
    const missing = ['intent', 'intent_digest'].filter(
      (column) => !byName.has(column),
    );
    const nullable = ['intent', 'intent_digest'].filter(
      (column) => byName.get(column) === 'YES',
    );
    if (missing.length > 0 || nullable.length > 0) {
      const countResult = await client.query(
        `SELECT COUNT(*)::bigint AS count FROM ${reservations}`,
      );
      const rowCount = Number(countResult.rows[0]?.count ?? 0);
      if (!Number.isSafeInteger(rowCount) || rowCount < 0)
        throw new EntitlementError(
          'DATABASE_ERROR',
          'entitlement reservation count is invalid',
          false,
        );
      if (rowCount > 0)
        throw new EntitlementError(
          'MIGRATION_REQUIRED',
          'legacy entitlement reservations require explicit review before intent upgrade',
          false,
        );
      for (const column of missing) {
        if (column === 'intent')
          await client.query(
            `ALTER TABLE ${reservations} ADD COLUMN intent jsonb`,
          );
        else
          await client.query(
            `ALTER TABLE ${reservations} ADD COLUMN intent_digest text`,
          );
      }
      await client.query(
        `ALTER TABLE ${reservations}
           ALTER COLUMN intent SET NOT NULL,
           ALTER COLUMN intent_digest SET NOT NULL`,
      );
    }
  }

  private async lock(client: PoolClient, key: string): Promise<void> {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [key],
    );
  }
}
