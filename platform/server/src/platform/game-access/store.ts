import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

const DEFAULT_GAME_ACCESS_SCHEMA = 'board_platform_game_access';

function assertSchemaName(schema: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(schema))
    throw new Error('GAME_ACCESS_SCHEMA_INVALID');
}

function tableName(schema: string, table: 'codes' | 'grants'): string {
  return `"${schema}"."${table}"`;
}

export interface GameAccessCodeRecord {
  readonly codeId: string;
  readonly gameId: string;
  readonly entitlement: string;
  readonly codeHash: string;
  readonly sourceRecordId: string;
  readonly maxUses?: number;
  readonly usedCount: number;
  readonly expiresAt?: Date;
  readonly revokedAt?: Date;
  readonly createdBy: string;
  readonly createdAt: Date;
}

export interface GameAccessGrantRecord {
  readonly grantId: string;
  readonly gameId: string;
  readonly entitlement: string;
  readonly codeId: string;
  readonly principalId: string;
  readonly sourceRecordId: string;
  readonly redeemedAt: Date;
}

export interface CreateGameAccessCodeRecord {
  readonly codeId?: string;
  readonly gameId: string;
  readonly entitlement: string;
  readonly codeHash: string;
  readonly sourceRecordId?: string;
  readonly maxUses?: number;
  readonly expiresAt?: Date;
  readonly createdBy: string;
  readonly createdAt?: Date;
}

export interface RedeemGameAccessCodeInput {
  readonly codeHash: string;
  readonly gameId: string;
  readonly principalId: string;
  readonly sourceRecordId: string;
  readonly grantId?: string;
  readonly redeemedAt?: Date;
}

export type GameAccessStoreErrorCode =
  | 'CODE_NOT_FOUND'
  | 'CODE_REVOKED'
  | 'CODE_EXPIRED'
  | 'CODE_EXHAUSTED';

export class GameAccessStoreError extends Error {
  constructor(readonly code: GameAccessStoreErrorCode) {
    super(code);
    this.name = 'GameAccessStoreError';
  }
}

export interface GameAccessStore {
  createCode(input: CreateGameAccessCodeRecord): Promise<GameAccessCodeRecord>;
  listCodes(gameId: string): Promise<readonly GameAccessCodeRecord[]>;
  revokeCode(
    gameId: string,
    codeId: string,
    revokedAt: Date,
  ): Promise<GameAccessCodeRecord>;
  redeemCode(input: RedeemGameAccessCodeInput): Promise<GameAccessGrantRecord>;
  listGrants(
    gameId: string,
    principalId: string,
  ): Promise<readonly GameAccessGrantRecord[]>;
  hasEntitlement(
    gameId: string,
    principalId: string,
    entitlement: string,
  ): Promise<boolean>;
}

export function hashGameAccessCode(code: string): string {
  return createHash('sha256')
    .update(normalizeGameAccessCode(code))
    .digest('hex');
}

export function normalizeGameAccessCode(code: string): string {
  return code.trim().toUpperCase();
}

function cloneCode(record: GameAccessCodeRecord): GameAccessCodeRecord {
  return {
    ...record,
    ...(record.expiresAt ? { expiresAt: new Date(record.expiresAt) } : {}),
    ...(record.revokedAt ? { revokedAt: new Date(record.revokedAt) } : {}),
    createdAt: new Date(record.createdAt),
  };
}

function cloneGrant(record: GameAccessGrantRecord): GameAccessGrantRecord {
  return { ...record, redeemedAt: new Date(record.redeemedAt) };
}

function isExpired(record: GameAccessCodeRecord, now: Date): boolean {
  return record.expiresAt !== undefined && record.expiresAt <= now;
}

/** Clone-isolated store used by unit tests and local adapters. */
export class MemoryGameAccessStore implements GameAccessStore {
  private readonly codes = new Map<string, GameAccessCodeRecord>();
  private readonly grants = new Map<string, GameAccessGrantRecord>();

  async createCode(
    input: CreateGameAccessCodeRecord,
  ): Promise<GameAccessCodeRecord> {
    const codeId = input.codeId ?? randomUUID();
    const record: GameAccessCodeRecord = {
      codeId,
      gameId: input.gameId,
      entitlement: input.entitlement,
      codeHash: input.codeHash,
      sourceRecordId:
        input.sourceRecordId ?? `game-access:code:${input.gameId}:${codeId}`,
      ...(input.maxUses === undefined ? {} : { maxUses: input.maxUses }),
      usedCount: 0,
      ...(input.expiresAt ? { expiresAt: new Date(input.expiresAt) } : {}),
      createdBy: input.createdBy,
      createdAt: new Date(input.createdAt ?? Date.now()),
    };
    if (
      [...this.codes.values()].some(
        (candidate) => candidate.codeHash === record.codeHash,
      )
    )
      throw new Error('GAME_ACCESS_CODE_DUPLICATE');
    this.codes.set(codeId, record);
    return cloneCode(record);
  }

  async listCodes(gameId: string): Promise<readonly GameAccessCodeRecord[]> {
    return [...this.codes.values()]
      .filter((record) => record.gameId === gameId)
      .map(cloneCode);
  }

  async revokeCode(
    gameId: string,
    codeId: string,
    revokedAt: Date,
  ): Promise<GameAccessCodeRecord> {
    const record = this.codes.get(codeId);
    if (!record || record.gameId !== gameId)
      throw new GameAccessStoreError('CODE_NOT_FOUND');
    const updated = { ...record, revokedAt: new Date(revokedAt) };
    this.codes.set(codeId, updated);
    return cloneCode(updated);
  }

  async redeemCode(
    input: RedeemGameAccessCodeInput,
  ): Promise<GameAccessGrantRecord> {
    const record = [...this.codes.values()].find(
      (candidate) =>
        candidate.gameId === input.gameId &&
        candidate.codeHash === input.codeHash,
    );
    if (!record) throw new GameAccessStoreError('CODE_NOT_FOUND');
    const grantKey = `${record.codeId}:${input.principalId}`;
    const existing = this.grants.get(grantKey);
    if (existing) return cloneGrant(existing);
    const now = input.redeemedAt ?? new Date();
    if (record.revokedAt) throw new GameAccessStoreError('CODE_REVOKED');
    if (isExpired(record, now)) throw new GameAccessStoreError('CODE_EXPIRED');
    if (record.maxUses !== undefined && record.usedCount >= record.maxUses)
      throw new GameAccessStoreError('CODE_EXHAUSTED');
    const grant: GameAccessGrantRecord = {
      grantId: input.grantId ?? randomUUID(),
      gameId: record.gameId,
      entitlement: record.entitlement,
      codeId: record.codeId,
      principalId: input.principalId,
      sourceRecordId: input.sourceRecordId,
      redeemedAt: new Date(now),
    };
    this.grants.set(grantKey, grant);
    this.codes.set(record.codeId, {
      ...record,
      usedCount: record.usedCount + 1,
    });
    return cloneGrant(grant);
  }

  async listGrants(
    gameId: string,
    principalId: string,
  ): Promise<readonly GameAccessGrantRecord[]> {
    return [...this.grants.values()]
      .filter(
        (grant) => grant.gameId === gameId && grant.principalId === principalId,
      )
      .map(cloneGrant);
  }

  async hasEntitlement(
    gameId: string,
    principalId: string,
    entitlement: string,
  ): Promise<boolean> {
    return [...this.grants.values()].some(
      (grant) =>
        grant.gameId === gameId &&
        grant.principalId === principalId &&
        grant.entitlement === entitlement,
    );
  }
}

export function gameAccessMigrationStatements(
  schema = DEFAULT_GAME_ACCESS_SCHEMA,
): readonly string[] {
  assertSchemaName(schema);
  return [
    `CREATE SCHEMA IF NOT EXISTS "${schema}"`,
    `CREATE TABLE IF NOT EXISTS ${tableName(schema, 'codes')} (
      code_id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      entitlement TEXT NOT NULL,
      code_hash TEXT NOT NULL UNIQUE,
      source_record_id TEXT NOT NULL UNIQUE,
      max_uses INTEGER,
      used_count INTEGER NOT NULL DEFAULT 0,
      expires_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      CHECK (max_uses IS NULL OR max_uses > 0),
      CHECK (used_count >= 0),
      CHECK (max_uses IS NULL OR used_count <= max_uses)
    )`,
    `CREATE INDEX IF NOT EXISTS "codes_game_idx"
      ON ${tableName(schema, 'codes')} (game_id, created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS ${tableName(schema, 'grants')} (
      grant_id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      entitlement TEXT NOT NULL,
      code_id TEXT NOT NULL REFERENCES ${tableName(schema, 'codes')}(code_id),
      principal_id TEXT NOT NULL,
      source_record_id TEXT NOT NULL UNIQUE,
      redeemed_at TIMESTAMPTZ NOT NULL,
      UNIQUE (code_id, principal_id)
    )`,
    `CREATE INDEX IF NOT EXISTS "grants_principal_idx"
      ON ${tableName(schema, 'grants')} (game_id, principal_id, entitlement)`,
  ];
}

function codeFromRow(row: Record<string, unknown>): GameAccessCodeRecord {
  return {
    codeId: String(row.code_id),
    gameId: String(row.game_id),
    entitlement: String(row.entitlement),
    codeHash: String(row.code_hash),
    sourceRecordId: String(row.source_record_id),
    ...(row.max_uses === null ? {} : { maxUses: Number(row.max_uses) }),
    usedCount: Number(row.used_count),
    ...(row.expires_at ? { expiresAt: new Date(String(row.expires_at)) } : {}),
    ...(row.revoked_at ? { revokedAt: new Date(String(row.revoked_at)) } : {}),
    createdBy: String(row.created_by),
    createdAt: new Date(String(row.created_at)),
  };
}

function grantFromRow(row: Record<string, unknown>): GameAccessGrantRecord {
  return {
    grantId: String(row.grant_id),
    gameId: String(row.game_id),
    entitlement: String(row.entitlement),
    codeId: String(row.code_id),
    principalId: String(row.principal_id),
    sourceRecordId: String(row.source_record_id),
    redeemedAt: new Date(String(row.redeemed_at)),
  };
}

/** PostgreSQL store with row locking around usage and per-code redemption. */
export interface PostgresGameAccessStoreOptions {
  readonly pool: Pool;
  readonly schema?: string;
}

export class PostgresGameAccessStore implements GameAccessStore {
  readonly schema: string;

  private readonly pool: Pool;

  constructor(options: PostgresGameAccessStoreOptions | Pool) {
    this.pool = 'query' in options ? options : options.pool;
    this.schema =
      'query' in options
        ? DEFAULT_GAME_ACCESS_SCHEMA
        : (options.schema ?? DEFAULT_GAME_ACCESS_SCHEMA);
    assertSchemaName(this.schema);
  }

  async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const statement of gameAccessMigrationStatements(this.schema))
        await client.query(statement);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async createCode(
    input: CreateGameAccessCodeRecord,
  ): Promise<GameAccessCodeRecord> {
    const codeId = input.codeId ?? randomUUID();
    const sourceRecordId =
      input.sourceRecordId ?? `game-access:code:${input.gameId}:${codeId}`;
    const createdAt = input.createdAt ?? new Date();
    const result = await this.pool.query(
      `INSERT INTO ${tableName(this.schema, 'codes')}
        (code_id, game_id, entitlement, code_hash, source_record_id,
         max_uses, expires_at, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        codeId,
        input.gameId,
        input.entitlement,
        input.codeHash,
        sourceRecordId,
        input.maxUses ?? null,
        input.expiresAt ?? null,
        input.createdBy,
        createdAt,
      ],
    );
    return codeFromRow(result.rows[0]);
  }

  async listCodes(gameId: string): Promise<readonly GameAccessCodeRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM ${tableName(this.schema, 'codes')}
       WHERE game_id = $1 ORDER BY created_at DESC, code_id DESC`,
      [gameId],
    );
    return result.rows.map(codeFromRow);
  }

  async revokeCode(
    gameId: string,
    codeId: string,
    revokedAt: Date,
  ): Promise<GameAccessCodeRecord> {
    const result = await this.pool.query(
      `UPDATE ${tableName(this.schema, 'codes')}
       SET revoked_at = COALESCE(revoked_at, $3)
       WHERE game_id = $1 AND code_id = $2
       RETURNING *`,
      [gameId, codeId, revokedAt],
    );
    if (result.rows.length === 0)
      throw new GameAccessStoreError('CODE_NOT_FOUND');
    return codeFromRow(result.rows[0]);
  }

  async redeemCode(
    input: RedeemGameAccessCodeInput,
  ): Promise<GameAccessGrantRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const codeResult = await client.query(
        `SELECT * FROM ${tableName(this.schema, 'codes')}
         WHERE game_id = $1 AND code_hash = $2 FOR UPDATE`,
        [input.gameId, input.codeHash],
      );
      if (codeResult.rows.length === 0)
        throw new GameAccessStoreError('CODE_NOT_FOUND');
      const code = codeFromRow(codeResult.rows[0]);
      const existingResult = await client.query(
        `SELECT * FROM ${tableName(this.schema, 'grants')}
         WHERE code_id = $1 AND principal_id = $2`,
        [code.codeId, input.principalId],
      );
      if (existingResult.rows.length > 0) {
        await client.query('COMMIT');
        return grantFromRow(existingResult.rows[0]);
      }
      const now = input.redeemedAt ?? new Date();
      if (code.revokedAt) throw new GameAccessStoreError('CODE_REVOKED');
      if (isExpired(code, now)) throw new GameAccessStoreError('CODE_EXPIRED');
      if (code.maxUses !== undefined && code.usedCount >= code.maxUses)
        throw new GameAccessStoreError('CODE_EXHAUSTED');
      const grantId = input.grantId ?? randomUUID();
      const insertResult = await client.query(
        `INSERT INTO ${tableName(this.schema, 'grants')}
          (grant_id, game_id, entitlement, code_id, principal_id,
           source_record_id, redeemed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING *`,
        [
          grantId,
          code.gameId,
          code.entitlement,
          code.codeId,
          input.principalId,
          input.sourceRecordId,
          now,
        ],
      );
      await client.query(
        `UPDATE ${tableName(this.schema, 'codes')}
         SET used_count = used_count + 1 WHERE code_id = $1`,
        [code.codeId],
      );
      await client.query('COMMIT');
      return grantFromRow(insertResult.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async listGrants(
    gameId: string,
    principalId: string,
  ): Promise<readonly GameAccessGrantRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM ${tableName(this.schema, 'grants')}
       WHERE game_id = $1 AND principal_id = $2
       ORDER BY redeemed_at DESC, grant_id DESC`,
      [gameId, principalId],
    );
    return result.rows.map(grantFromRow);
  }

  async hasEntitlement(
    gameId: string,
    principalId: string,
    entitlement: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT EXISTS (
         SELECT 1 FROM ${tableName(this.schema, 'grants')}
         WHERE game_id = $1 AND principal_id = $2 AND entitlement = $3
       ) AS present`,
      [gameId, principalId, entitlement],
    );
    return result.rows[0]?.present === true;
  }
}

/** Small deterministic adapter useful to tests that need a code value. */
export function generateGameAccessCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(16);
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join('');
}
