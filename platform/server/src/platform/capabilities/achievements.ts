import type {
  AchievementCollection,
  AchievementItem,
  JsonValue,
} from '@board-game/contracts';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { GameAchievementSource } from './types.js';

export interface GameAchievementDefinition {
  readonly achievementId: string;
  readonly title: string;
  readonly description: string;
  readonly tier: string;
  readonly target: number;
  /** Optional game-owned metric criterion for a JSON fact source. */
  readonly criterion?: {
    readonly metric: string;
    readonly aggregation: 'sum' | 'max';
    readonly comparator: 'gte' | 'gt';
    readonly subjectId?: string;
  };
  readonly seriesId?: string;
  readonly level?: number;
}

export interface GameAchievementReadRequest {
  readonly gameId: string;
  readonly principalId: string;
  readonly definitionVersion: string;
  readonly definitions: readonly GameAchievementDefinition[];
}

export interface GameAchievementConsumeRequest {
  readonly gameId: string;
  readonly definitionVersion: string;
  readonly sourceRecordId: string;
  readonly occurredAt: number;
  readonly sources: readonly GameAchievementSource[];
  readonly definitions: readonly GameAchievementDefinition[];
}

export interface GameAchievementStore {
  read(request: GameAchievementReadRequest): Promise<AchievementCollection>;
  consume(request: GameAchievementConsumeRequest): Promise<void>;
}

interface Progress {
  progress: number;
  target: number;
  unlockedAt?: number;
  revision: number;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assertId(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new Error(`GAME_ACHIEVEMENT_${field.toUpperCase()}_INVALID`);
}

function assertDefinitions(
  definitions: readonly GameAchievementDefinition[],
): Map<string, GameAchievementDefinition> {
  if (!Array.isArray(definitions) || definitions.length === 0)
    throw new Error('GAME_ACHIEVEMENT_DEFINITIONS_INVALID');
  const byId = new Map<string, GameAchievementDefinition>();
  for (const definition of definitions) {
    assertId(definition.achievementId, 'achievement_id');
    if (
      typeof definition.title !== 'string' ||
      typeof definition.description !== 'string' ||
      typeof definition.tier !== 'string' ||
      !Number.isSafeInteger(definition.target) ||
      definition.target < 1 ||
      byId.has(definition.achievementId)
    )
      throw new Error('GAME_ACHIEVEMENT_DEFINITION_INVALID');
    if (definition.criterion !== undefined) {
      if (
        !definition.criterion ||
        typeof definition.criterion.metric !== 'string' ||
        definition.criterion.metric.length === 0 ||
        !['sum', 'max'].includes(definition.criterion.aggregation) ||
        !['gte', 'gt'].includes(definition.criterion.comparator) ||
        (definition.criterion.subjectId !== undefined &&
          (typeof definition.criterion.subjectId !== 'string' ||
            definition.criterion.subjectId.length === 0))
      )
        throw new Error('GAME_ACHIEVEMENT_DEFINITION_INVALID');
    }
    byId.set(definition.achievementId, definition);
  }
  return byId;
}

type ParsedFact =
  | {
      readonly kind: 'achievement';
      readonly achievementId: string;
      readonly amount: number;
    }
  | {
      readonly kind: 'metric';
      readonly metric: string;
      readonly value: number;
      readonly subjectId?: string;
    };

function fact(value: JsonValue): ParsedFact {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('GAME_ACHIEVEMENT_FACT_INVALID');
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.achievementId === 'string') {
    if (
      candidate.achievementId.length === 0 ||
      typeof candidate.amount !== 'number' ||
      !Number.isSafeInteger(candidate.amount) ||
      candidate.amount < 1
    )
      throw new Error('GAME_ACHIEVEMENT_FACT_INVALID');
    return {
      kind: 'achievement',
      achievementId: candidate.achievementId,
      amount: candidate.amount,
    };
  }
  if (
    typeof candidate.metric !== 'string' ||
    candidate.metric.length === 0 ||
    typeof candidate.value !== 'number' ||
    !Number.isSafeInteger(candidate.value) ||
    candidate.value < 0 ||
    (candidate.subjectId !== undefined &&
      (typeof candidate.subjectId !== 'string' ||
        candidate.subjectId.length === 0))
  )
    throw new Error('GAME_ACHIEVEMENT_FACT_INVALID');
  return {
    kind: 'metric',
    metric: candidate.metric,
    value: candidate.value,
    ...(candidate.subjectId !== undefined
      ? { subjectId: candidate.subjectId }
      : {}),
  };
}

function matchesCriterion(
  definition: GameAchievementDefinition,
  fact: Extract<ParsedFact, { kind: 'metric' }>,
): boolean {
  return (
    definition.criterion?.metric === fact.metric &&
    definition.criterion.subjectId === fact.subjectId
  );
}

function applyMetricFact(
  next: Map<string, Progress>,
  definition: GameAchievementDefinition,
  parsed: Extract<ParsedFact, { kind: 'metric' }>,
  occurredAt: number,
  key = definition.achievementId,
): void {
  if (!definition.criterion || !matchesCriterion(definition, parsed)) return;
  const current = next.get(key) ?? {
    progress: 0,
    target: definition.target,
    revision: 0,
  };
  const progress =
    definition.criterion.aggregation === 'max'
      ? Math.max(current.progress, parsed.value)
      : current.progress + parsed.value;
  const unlocked =
    definition.criterion.comparator === 'gt'
      ? progress > definition.target
      : progress >= definition.target;
  next.set(key, {
    progress,
    target: definition.target,
    revision: current.revision + 1,
    ...(current.unlockedAt !== undefined
      ? { unlockedAt: current.unlockedAt }
      : unlocked
        ? { unlockedAt: occurredAt }
        : {}),
  });
}

function collection(
  request: GameAchievementReadRequest,
  progress: ReadonlyMap<string, Progress>,
): AchievementCollection {
  const definitions = assertDefinitions(request.definitions);
  const items: AchievementItem[] = request.definitions.map((definition) => {
    const current = progress.get(definition.achievementId);
    return {
      achievementId: definition.achievementId,
      title: definition.title,
      description: definition.description,
      tier: definition.tier,
      progress: current?.progress ?? 0,
      target: current?.target ?? definition.target,
      unlocked: current?.unlockedAt !== undefined,
      ...(current?.unlockedAt !== undefined
        ? { unlockedAt: current.unlockedAt }
        : {}),
    };
  });
  // Referencing the map here keeps validation explicit even when a caller
  // supplies an empty progress projection.
  if (definitions.size !== request.definitions.length)
    throw new Error('GAME_ACHIEVEMENT_DEFINITIONS_INVALID');
  return {
    gameId: request.gameId,
    principalId: request.principalId,
    definitionVersion: request.definitionVersion,
    items,
  };
}

/** Clone-isolated store for focused tests and local development. */
export class MemoryGameAchievementStore implements GameAchievementStore {
  private readonly progress = new Map<string, Progress>();
  private readonly sources = new Set<string>();

  async read(
    request: GameAchievementReadRequest,
  ): Promise<AchievementCollection> {
    assertId(request.gameId, 'game_id');
    assertId(request.principalId, 'principal_id');
    assertId(request.definitionVersion, 'definition_version');
    const progress = new Map<string, Progress>();
    for (const definition of request.definitions) {
      const value = this.progress.get(
        progressKey(
          request.gameId,
          request.definitionVersion,
          request.principalId,
          definition.achievementId,
        ),
      );
      if (value) progress.set(definition.achievementId, clone(value));
    }
    return clone(collection(request, progress));
  }

  async consume(request: GameAchievementConsumeRequest): Promise<void> {
    assertConsumeRequest(request);
    const definitions = assertDefinitions(request.definitions);
    for (const source of request.sources) {
      assertId(source.principalId, 'principal_id');
      const sourceKey = `${request.gameId}\u0000${request.definitionVersion}\u0000${source.principalId}\u0000${request.sourceRecordId}`;
      if (this.sources.has(sourceKey)) continue;
      const next = new Map(this.progress);
      for (const raw of source.facts) {
        const parsed = fact(raw);
        if (parsed.kind === 'achievement') {
          const definition = definitions.get(parsed.achievementId);
          if (!definition) throw new Error('GAME_ACHIEVEMENT_FACT_UNKNOWN');
          const key = progressKey(
            request.gameId,
            request.definitionVersion,
            source.principalId,
            parsed.achievementId,
          );
          const current = next.get(key) ?? {
            progress: 0,
            target: definition.target,
            revision: 0,
          };
          next.set(key, {
            progress: current.progress + parsed.amount,
            target: definition.target,
            revision: current.revision + 1,
            ...(current.unlockedAt === undefined &&
            current.progress + parsed.amount >= definition.target
              ? { unlockedAt: request.occurredAt }
              : current.unlockedAt !== undefined
                ? { unlockedAt: current.unlockedAt }
                : {}),
          });
        } else {
          for (const definition of definitions.values())
            if (matchesCriterion(definition, parsed)) {
              const key = progressKey(
                request.gameId,
                request.definitionVersion,
                source.principalId,
                definition.achievementId,
              );
              const scoped = new Map<string, Progress>([
                [
                  key,
                  next.get(key) ?? {
                    progress: 0,
                    target: definition.target,
                    revision: 0,
                  },
                ],
              ]);
              applyMetricFact(
                scoped,
                definition,
                parsed,
                request.occurredAt,
                key,
              );
              const updated = scoped.get(key);
              if (updated) next.set(key, updated);
            }
        }
      }
      for (const [key, value] of next) this.progress.set(key, clone(value));
      this.sources.add(sourceKey);
    }
  }
}

const SOURCE_TABLE = 'platform_game_achievement_sources';
const PROGRESS_TABLE = 'platform_game_achievement_progress';

export function gameAchievementMigrationStatements(): readonly string[] {
  return [
    `CREATE TABLE IF NOT EXISTS "${SOURCE_TABLE}" (
      game_id text NOT NULL,
      definition_version text NOT NULL,
      principal_id text NOT NULL,
      source_record_id text NOT NULL,
      occurred_at double precision NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (game_id, definition_version, principal_id, source_record_id)
    )`,
    `CREATE TABLE IF NOT EXISTS "${PROGRESS_TABLE}" (
      game_id text NOT NULL,
      definition_version text NOT NULL,
      principal_id text NOT NULL,
      achievement_id text NOT NULL,
      progress integer NOT NULL CHECK (progress >= 0),
      target integer NOT NULL CHECK (target > 0),
      unlocked_at double precision,
      revision integer NOT NULL CHECK (revision >= 0),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (game_id, definition_version, principal_id, achievement_id)
    )`,
    `CREATE INDEX IF NOT EXISTS "${PROGRESS_TABLE}_leaderboard_idx" ON "${PROGRESS_TABLE}" (game_id, definition_version, achievement_id, progress DESC, principal_id)`,
  ];
}

function rowsOf(result: unknown): readonly Record<string, unknown>[] {
  const rows = (result as { rows?: unknown[] } | null)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

function progressKey(
  gameId: string,
  definitionVersion: string,
  principalId: string,
  achievementId: string,
): string {
  return `${gameId}\u0000${definitionVersion}\u0000${principalId}\u0000${achievementId}`;
}

function assertConsumeRequest(request: GameAchievementConsumeRequest): void {
  assertId(request.gameId, 'game_id');
  assertId(request.definitionVersion, 'definition_version');
  assertId(request.sourceRecordId, 'source_record_id');
  if (
    !Number.isFinite(request.occurredAt) ||
    request.occurredAt < 0 ||
    !Array.isArray(request.sources)
  )
    throw new Error('GAME_ACHIEVEMENT_CONSUME_REQUEST_INVALID');
  for (const source of request.sources) {
    if (!source || !Array.isArray(source.facts))
      throw new Error('GAME_ACHIEVEMENT_CONSUME_REQUEST_INVALID');
  }
}

export async function migrateGameAchievements(
  db: NodePgDatabase,
): Promise<void> {
  for (const statement of gameAchievementMigrationStatements())
    await db.execute(sql.raw(statement));
}

/** Durable adapter used by game capability factories in the server DB. */
export class PostgresGameAchievementStore implements GameAchievementStore {
  public constructor(private readonly db: NodePgDatabase) {}

  public async migrate(): Promise<void> {
    await migrateGameAchievements(this.db);
  }

  public async read(
    request: GameAchievementReadRequest,
  ): Promise<AchievementCollection> {
    assertId(request.gameId, 'game_id');
    assertId(request.principalId, 'principal_id');
    assertId(request.definitionVersion, 'definition_version');
    const result = await this.db.execute(sql`
      SELECT achievement_id, progress, target, unlocked_at, revision
      FROM ${sql.raw(`"${PROGRESS_TABLE}"`)}
      WHERE game_id = ${request.gameId}
        AND definition_version = ${request.definitionVersion}
        AND principal_id = ${request.principalId}
    `);
    const progress = new Map<string, Progress>();
    for (const row of rowsOf(result)) {
      const achievementId = String(row.achievement_id);
      progress.set(achievementId, {
        progress: Number(row.progress),
        target: Number(row.target),
        revision: Number(row.revision ?? 0),
        ...(row.unlocked_at === null || row.unlocked_at === undefined
          ? {}
          : { unlockedAt: Number(row.unlocked_at) }),
      });
    }
    return collection(request, progress);
  }

  public async consume(request: GameAchievementConsumeRequest): Promise<void> {
    assertConsumeRequest(request);
    const definitions = assertDefinitions(request.definitions);
    await this.db.transaction(async (transaction) => {
      const database = transaction as unknown as NodePgDatabase;
      for (const source of request.sources) {
        assertId(source.principalId, 'principal_id');
        const inserted = await database.execute(sql`
          INSERT INTO ${sql.raw(`"${SOURCE_TABLE}"`)}
            (game_id, definition_version, principal_id, source_record_id, occurred_at)
          VALUES (
            ${request.gameId}, ${request.definitionVersion}, ${source.principalId},
            ${request.sourceRecordId}, ${request.occurredAt}
          )
          ON CONFLICT (game_id, definition_version, principal_id, source_record_id)
          DO NOTHING
          RETURNING source_record_id
        `);
        if (rowsOf(inserted).length === 0) continue;
        for (const raw of source.facts) {
          const parsed = fact(raw);
          if (parsed.kind === 'achievement') {
            const definition = definitions.get(parsed.achievementId);
            if (!definition) throw new Error('GAME_ACHIEVEMENT_FACT_UNKNOWN');
            await database.execute(sql`
              INSERT INTO ${sql.raw(`"${PROGRESS_TABLE}" AS existing`)}
                (game_id, definition_version, principal_id, achievement_id, progress, target, unlocked_at, revision)
              VALUES (
                ${request.gameId}, ${request.definitionVersion}, ${source.principalId},
                ${parsed.achievementId}, ${parsed.amount}, ${definition.target},
                ${parsed.amount >= definition.target ? request.occurredAt : null}, 1
              )
              ON CONFLICT (game_id, definition_version, principal_id, achievement_id)
              DO UPDATE SET
                progress = existing.progress + EXCLUDED.progress,
                target = EXCLUDED.target,
                unlocked_at = CASE
                  WHEN existing.unlocked_at IS NOT NULL
                    THEN existing.unlocked_at
                  WHEN existing.progress + EXCLUDED.progress >= EXCLUDED.target
                    THEN EXCLUDED.unlocked_at
                  ELSE NULL
                END,
                revision = existing.revision + 1,
                updated_at = now()
            `);
            continue;
          }
          for (const definition of definitions.values()) {
            if (!matchesCriterion(definition, parsed)) continue;
            const existingResult = await database.execute(sql`
              SELECT progress, unlocked_at, revision
                FROM ${sql.raw(`"${PROGRESS_TABLE}"`)}
               WHERE game_id = ${request.gameId}
                 AND definition_version = ${request.definitionVersion}
                 AND principal_id = ${source.principalId}
                 AND achievement_id = ${definition.achievementId}
               FOR UPDATE
            `);
            const existing = rowsOf(existingResult)[0];
            const current = Number(existing?.progress ?? 0);
            const progress =
              definition.criterion?.aggregation === 'max'
                ? Math.max(current, parsed.value)
                : current + parsed.value;
            const unlocked =
              definition.criterion?.comparator === 'gt'
                ? progress > definition.target
                : progress >= definition.target;
            const unlockedAt =
              existing?.unlocked_at !== undefined &&
              existing?.unlocked_at !== null
                ? Number(existing.unlocked_at)
                : unlocked
                  ? request.occurredAt
                  : null;
            if (existing) {
              await database.execute(sql`
                UPDATE ${sql.raw(`"${PROGRESS_TABLE}"`)}
                   SET progress = ${progress},
                       target = ${definition.target},
                       unlocked_at = ${unlockedAt},
                       revision = ${Number(existing.revision ?? 0) + 1},
                       updated_at = now()
                 WHERE game_id = ${request.gameId}
                   AND definition_version = ${request.definitionVersion}
                   AND principal_id = ${source.principalId}
                   AND achievement_id = ${definition.achievementId}
              `);
            } else {
              await database.execute(sql`
                INSERT INTO ${sql.raw(`"${PROGRESS_TABLE}"`)}
                  (game_id, definition_version, principal_id, achievement_id, progress, target, unlocked_at, revision)
                VALUES (
                  ${request.gameId}, ${request.definitionVersion}, ${source.principalId},
                  ${definition.achievementId}, ${progress}, ${definition.target},
                  ${unlockedAt}, 1
                )
              `);
            }
          }
        }
      }
    });
  }
}
