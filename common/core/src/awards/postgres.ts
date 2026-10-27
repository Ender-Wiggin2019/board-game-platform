import {
  canonicalStableStringify,
  type JsonValue,
} from '@board-game/contracts';
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { AwardError } from './errors.js';
import {
  assertStoredTimestamp,
  assertTimestamp,
  awardGrantIdFor,
  awardKey,
  clone,
  definitionDigest,
  rewardRecordIdFor,
  validateAwardKey,
  validateAwardRequest,
  validateImportRequest,
  validatePendingOptions,
  validateRewardId,
} from './invariants.js';
import {
  assertAwardSchemaName,
  awardMigrationStatements,
  awardTableName,
  DEFAULT_AWARD_SCHEMA,
} from './migration.js';
import type {
  AwardGrant,
  AwardGrantRequest,
  AwardImportRequest,
  AwardKey,
  AwardPendingOptions,
  AwardRewardRecord,
  AwardStore,
  AwardStoreCapabilities,
} from './types.js';

type Row = Record<string, unknown>;
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 60_000;

function retryAt(attempts: number, now: number): number {
  const exponent = Math.min(Math.max(attempts - 1, 0), 6);
  return (
    now + Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** exponent)
  );
}

export interface PostgresAwardStoreOptions {
  readonly connectionString?: string;
  readonly pool?: Pool;
  readonly poolConfig?: PoolConfig;
  /** Must be a validated identifier; SQL never changes search_path. */
  readonly schema?: string;
  readonly now?: () => number;
}

function asAwardError(error: unknown): AwardError {
  if (error instanceof AwardError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  if (code === '42P01' || code === '3F000')
    return new AwardError(
      'MIGRATION_REQUIRED',
      'award schema has not been migrated',
      false,
    );
  if (code === '40001' || code === '40P01')
    return new AwardError(
      'DATABASE_ERROR',
      'award transaction was aborted',
      true,
    );
  if (code === '23505')
    return new AwardError(
      'IDEMPOTENCY_CONFLICT',
      'award operation conflicts with an existing record',
      false,
    );
  return new AwardError(
    'DATABASE_ERROR',
    error instanceof Error ? error.message : String(error),
  );
}

function rowString(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value.length === 0)
    throw new AwardError(
      'DATABASE_ERROR',
      `award row has invalid ${key}`,
      false,
    );
  return value;
}

function rowNumber(row: Row, key: string): number {
  const value = Number(row[key]);
  if (!Number.isFinite(value))
    throw new AwardError(
      'DATABASE_ERROR',
      `award row has invalid ${key}`,
      false,
    );
  return value;
}

function rowJson(row: Row, key: string): JsonValue {
  const value = row[key];
  try {
    canonicalStableStringify(value);
  } catch {
    throw new AwardError(
      'DATABASE_ERROR',
      `award row has invalid ${key}`,
      false,
    );
  }
  return clone(value as JsonValue);
}

function optionalRowJson(row: Row, key: string): JsonValue | undefined {
  if (row[key] === null || row[key] === undefined) return undefined;
  return rowJson(row, key);
}

function rowToAward(row: Row): AwardGrant {
  const createdAt = rowNumber(row, 'created_at');
  assertStoredTimestamp(createdAt, 'created_at');
  const award: AwardGrant = {
    namespace: rowString(row, 'namespace'),
    principalId: rowString(row, 'principal_id'),
    awardId: rowString(row, 'award_id'),
    tier: rowString(row, 'tier'),
    definitionVersion: rowString(row, 'definition_version'),
    sourceRecordId: rowString(row, 'source_record_id'),
    rewards: rowJson(row, 'rewards') as unknown as AwardGrant['rewards'],
    awardGrantId: rowString(row, 'award_grant_id'),
    definitionDigest: rowString(row, 'definition_digest'),
    createdAt,
  };
  validateAwardRequest(award);
  if (definitionDigest(award) !== award.definitionDigest)
    throw new AwardError(
      'DATABASE_ERROR',
      'award row definition digest does not match its definition',
      false,
    );
  return award;
}

function rowToReward(row: Row): AwardRewardRecord {
  const quantity = rowNumber(row, 'quantity');
  if (!Number.isSafeInteger(quantity) || quantity < 1)
    throw new AwardError(
      'DATABASE_ERROR',
      'award reward quantity is invalid',
      false,
    );
  const createdAt = rowNumber(row, 'created_at');
  assertStoredTimestamp(createdAt, 'created_at');
  const deliveredAt =
    row.delivered_at === null || row.delivered_at === undefined
      ? undefined
      : rowNumber(row, 'delivered_at');
  if (deliveredAt !== undefined)
    assertStoredTimestamp(deliveredAt, 'delivered_at');
  const status = rowString(row, 'status');
  if (status !== 'pending' && status !== 'delivered')
    throw new AwardError(
      'DATABASE_ERROR',
      'award reward status is invalid',
      false,
    );
  const attempts = rowNumber(row, 'attempts');
  if (!Number.isSafeInteger(attempts) || attempts < 0)
    throw new AwardError(
      'DATABASE_ERROR',
      'award reward attempts are invalid',
      false,
    );
  const nextAttemptAt =
    row.next_attempt_at === null || row.next_attempt_at === undefined
      ? undefined
      : rowNumber(row, 'next_attempt_at');
  if (nextAttemptAt !== undefined)
    assertStoredTimestamp(nextAttemptAt, 'next_attempt_at');
  return {
    rewardId: rowString(row, 'reward_id'),
    instructionId: rowString(row, 'instruction_id'),
    awardGrantId: rowString(row, 'award_grant_id'),
    awardNamespace: rowString(row, 'award_namespace'),
    principalId: rowString(row, 'principal_id'),
    namespace: rowString(row, 'namespace'),
    asset: rowString(row, 'asset'),
    quantity,
    ...(optionalRowJson(row, 'metadata') !== undefined
      ? { metadata: optionalRowJson(row, 'metadata') }
      : {}),
    status,
    attempts,
    ...(nextAttemptAt !== undefined ? { nextAttemptAt } : {}),
    createdAt,
    ...(deliveredAt !== undefined ? { deliveredAt } : {}),
  };
}

/** Durable award ledger with explicit migrations and advisory key locks. */
export class PostgresAwardStore implements AwardStore {
  readonly capabilities: AwardStoreCapabilities = {
    durable: true,
    serializableTransactions: true,
    boundedReads: true,
  };

  readonly schema: string;
  private readonly pool: Pool;
  private readonly ownsPool: boolean;
  private readonly now: () => number;

  constructor(options: PostgresAwardStoreOptions | string = {}) {
    const normalized =
      typeof options === 'string' ? { connectionString: options } : options;
    this.schema = normalized.schema ?? DEFAULT_AWARD_SCHEMA;
    assertAwardSchemaName(this.schema);
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
      for (const statement of awardMigrationStatements(this.schema))
        await client.query(statement);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw asAwardError(error);
    } finally {
      client.release();
    }
  }

  async grantAward(request: AwardGrantRequest): Promise<AwardGrant> {
    validateAwardRequest(request);
    return this.writeAward(request, new Set());
  }

  async importAward(request: AwardImportRequest): Promise<AwardGrant> {
    validateImportRequest(request);
    return this.writeAward(
      request,
      new Set(request.importedRewardAlreadyDelivered ?? []),
    );
  }

  private async writeAward(
    request: AwardGrantRequest,
    deliveredRewardIds: ReadonlySet<string>,
  ): Promise<AwardGrant> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.lock(client, `award:${awardKey(request)}`);
      const awards = awardTableName(this.schema, 'awards');
      const existingResult = await client.query(
        `SELECT * FROM ${awards}
          WHERE namespace = $1 AND principal_id = $2
            AND award_id = $3 AND tier = $4
          FOR UPDATE`,
        [request.namespace, request.principalId, request.awardId, request.tier],
      );
      if (existingResult.rows[0]) {
        const existing = rowToAward(existingResult.rows[0] as Row);
        if (existing.definitionDigest !== definitionDigest(request))
          throw new AwardError(
            'IDEMPOTENCY_CONFLICT',
            `Award ${awardKey(request)} has a different definition`,
            false,
          );
        await client.query('COMMIT');
        return clone(existing);
      }
      const createdAt = request.createdAt ?? this.now();
      assertTimestamp(createdAt, 'createdAt');
      const award: AwardGrant = {
        namespace: request.namespace,
        principalId: request.principalId,
        awardId: request.awardId,
        tier: request.tier,
        definitionVersion: request.definitionVersion,
        sourceRecordId: request.sourceRecordId,
        rewards: clone(request.rewards),
        awardGrantId: awardGrantIdFor(request),
        definitionDigest: definitionDigest(request),
        createdAt,
      };
      await client.query(
        `INSERT INTO ${awards}
          (namespace, principal_id, award_id, tier, definition_version, definition_digest, source_record_id, rewards, award_grant_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)`,
        [
          award.namespace,
          award.principalId,
          award.awardId,
          award.tier,
          award.definitionVersion,
          award.definitionDigest,
          award.sourceRecordId,
          JSON.stringify(award.rewards),
          award.awardGrantId,
          award.createdAt,
        ],
      );
      const rewards = awardTableName(this.schema, 'rewards');
      for (const instruction of award.rewards) {
        const rewardId = rewardRecordIdFor(
          award.awardGrantId,
          instruction.rewardId,
        );
        const delivered = deliveredRewardIds.has(instruction.rewardId);
        await client.query(
          `INSERT INTO ${rewards}
            (reward_id, award_grant_id, instruction_id, award_namespace, principal_id, namespace, asset, quantity, metadata, status, attempts, next_attempt_at, created_at, delivered_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, 0, NULL, $11, $12)`,
          [
            rewardId,
            award.awardGrantId,
            instruction.rewardId,
            award.namespace,
            award.principalId,
            instruction.namespace,
            instruction.asset,
            instruction.quantity,
            instruction.metadata === undefined
              ? null
              : JSON.stringify(instruction.metadata),
            delivered ? 'delivered' : 'pending',
            createdAt,
            delivered ? createdAt : null,
          ],
        );
      }
      await client.query('COMMIT');
      return clone(award);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw asAwardError(error);
    } finally {
      client.release();
    }
  }

  async getAward(key: AwardKey): Promise<AwardGrant | null> {
    validateAwardKey(key);
    try {
      const result = await this.pool.query(
        `SELECT * FROM ${awardTableName(this.schema, 'awards')}
          WHERE namespace = $1 AND principal_id = $2
            AND award_id = $3 AND tier = $4`,
        [key.namespace, key.principalId, key.awardId, key.tier],
      );
      return result.rows[0] ? clone(rowToAward(result.rows[0] as Row)) : null;
    } catch (error) {
      throw asAwardError(error);
    }
  }

  async getReward(rewardId: string): Promise<AwardRewardRecord | null> {
    validateRewardId(rewardId);
    try {
      const result = await this.pool.query(
        `SELECT * FROM ${awardTableName(this.schema, 'rewards')}
          WHERE reward_id = $1`,
        [rewardId],
      );
      return result.rows[0] ? clone(rowToReward(result.rows[0] as Row)) : null;
    } catch (error) {
      throw asAwardError(error);
    }
  }

  async listPendingRewards(
    options: AwardPendingOptions,
  ): Promise<readonly AwardRewardRecord[]> {
    validatePendingOptions(options);
    const now = options.now ?? this.now();
    assertTimestamp(now, 'now');
    const params: unknown[] = ['pending', now];
    const predicates = [
      'status = $1',
      '(next_attempt_at IS NULL OR next_attempt_at <= $2)',
    ];
    if (options.namespace !== undefined) {
      params.push(options.namespace);
      predicates.push(`award_namespace = $${params.length}`);
    }
    if (options.principalId !== undefined) {
      params.push(options.principalId);
      predicates.push(`principal_id = $${params.length}`);
    }
    params.push(options.limit);
    try {
      const result = await this.pool.query(
        `SELECT * FROM ${awardTableName(this.schema, 'rewards')}
          WHERE ${predicates.join(' AND ')}
          ORDER BY created_at, reward_id
          LIMIT $${params.length}`,
        params,
      );
      return result.rows.map((row) => clone(rowToReward(row as Row)));
    } catch (error) {
      throw asAwardError(error);
    }
  }

  async markRewardDelivered(
    rewardId: string,
    deliveredAt = this.now(),
  ): Promise<AwardRewardRecord> {
    validateRewardId(rewardId);
    assertTimestamp(deliveredAt, 'deliveredAt');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.lock(client, `reward:${rewardId}`);
      const rewards = awardTableName(this.schema, 'rewards');
      const result = await client.query(
        `SELECT * FROM ${rewards} WHERE reward_id = $1 FOR UPDATE`,
        [rewardId],
      );
      if (!result.rows[0])
        throw new AwardError(
          'REWARD_NOT_FOUND',
          `Reward ${rewardId} does not exist`,
          false,
        );
      const existing = rowToReward(result.rows[0] as Row);
      if (existing.status === 'delivered') {
        await client.query('COMMIT');
        return clone(existing);
      }
      await client.query(
        `UPDATE ${rewards}
            SET status = 'delivered', attempts = attempts + 1,
                next_attempt_at = NULL, delivered_at = $2
          WHERE reward_id = $1`,
        [rewardId, deliveredAt],
      );
      await client.query('COMMIT');
      const { nextAttemptAt: _nextAttemptAt, ...deliveredBase } = existing;
      return clone({
        ...deliveredBase,
        status: 'delivered',
        attempts: existing.attempts + 1,
        deliveredAt,
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw asAwardError(error);
    } finally {
      client.release();
    }
  }

  async markRewardFailed(rewardId: string): Promise<AwardRewardRecord> {
    validateRewardId(rewardId);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.lock(client, `reward:${rewardId}`);
      const rewards = awardTableName(this.schema, 'rewards');
      const result = await client.query(
        `SELECT * FROM ${rewards} WHERE reward_id = $1 FOR UPDATE`,
        [rewardId],
      );
      if (!result.rows[0])
        throw new AwardError(
          'REWARD_NOT_FOUND',
          `Reward ${rewardId} does not exist`,
          false,
        );
      const existing = rowToReward(result.rows[0] as Row);
      if (existing.status === 'delivered') {
        await client.query('COMMIT');
        return clone(existing);
      }
      const attemptedAt = this.now();
      assertTimestamp(attemptedAt, 'attemptedAt');
      const attempts = existing.attempts + 1;
      const nextAttemptAt = retryAt(attempts, attemptedAt);
      await client.query(
        `UPDATE ${rewards}
            SET attempts = $2, next_attempt_at = $3
          WHERE reward_id = $1`,
        [rewardId, attempts, nextAttemptAt],
      );
      await client.query('COMMIT');
      return clone({ ...existing, attempts, nextAttemptAt });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw asAwardError(error);
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }

  private async lock(client: PoolClient, key: string): Promise<void> {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [key],
    );
  }
}
