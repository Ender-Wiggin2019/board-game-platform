import { randomUUID } from 'node:crypto';
import { directoryMigrationStatements } from '@board-game/core';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { GameCapabilityRegistration } from '@/platform/capabilities/index.js';
import type { PlatformApplicationRuntime } from '@/platform/PlatformApplicationRuntime.js';
import { PlatformGameServices } from '@/platform/PlatformGameServices.js';

const databaseUrl = process.env.BGP_TEST_DATABASE_URL;
const postgresSuite = databaseUrl ? describe : describe.skip;

postgresSuite('default platform game statistics', () => {
  const gameId = `statistics-${randomUUID()}`;
  const releaseId = `${gameId}-release`;
  let pool: Pool;
  let services: PlatformGameServices;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    for (const statement of directoryMigrationStatements())
      await pool.query(statement);

    const rows = [
      ['active', 'session-active'],
      ['completed', 'session-completed'],
      ['completed', 'session-completed-2'],
      ['paused', 'session-paused'],
      ['cancelled', 'session-cancelled'],
      ['active', 'session-other-release'],
    ] as const;
    for (const [status, suffix] of rows)
      await pool.query(
        `INSERT INTO "board_platform_directory"."sessions" (
          session_id, admission_id, game_id, mode_id, release_id,
          backend_binding_id, storage_binding_id, ownership_epoch,
          visibility, participants, status, latest_aggregate_sequence,
          summary, result, created_at, updated_at
        ) VALUES ($1, $2, $3, 'regular', $4, 'backend', 'storage', 'epoch',
          'private', '[]'::jsonb, $5, 0, '{}'::jsonb, NULL, 1, 1)`,
        [
          `${gameId}-${suffix}`,
          `admission-${gameId}-${suffix}`,
          gameId,
          suffix === 'session-other-release'
            ? `${gameId}-other-release`
            : releaseId,
          status,
        ],
      );

    const platform = {
      options: { db: {} as NodePgDatabase, pool },
      admissionStore: { getAdmission: vi.fn() },
      game: vi.fn(() => ({ releaseId, metadata: metadata(gameId) })),
      releaseGame: vi.fn(() => ({ releaseId, metadata: metadata(gameId) })),
      registerRecoveryHook: vi.fn(),
    } as unknown as PlatformApplicationRuntime;
    services = new PlatformGameServices(platform);
    services.register(registration(gameId, releaseId));
  });

  afterAll(async () => {
    await pool.query(
      'DELETE FROM "board_platform_directory"."sessions" WHERE game_id = $1',
      [gameId],
    );
    await pool.end();
  });

  it('counts only the registered game release in SQL', async () => {
    await expect(
      services.capabilities.getStatistics(gameId, releaseId),
    ).resolves.toEqual({
      gameId,
      releaseId,
      totalSessions: 5,
      activeSessions: 1,
      pausedSessions: 1,
      suspendedSessions: 0,
      completedSessions: 2,
      cancelledSessions: 1,
    });
  });
});

function metadata(gameId: string) {
  return {
    gameId,
    name: 'Statistics fixture',
    description: 'Statistics fixture',
    themeId: gameId,
  } as const;
}

function registration(
  gameId: string,
  releaseId: string,
): GameCapabilityRegistration {
  return {
    metadata: metadata(gameId),
    releaseId,
    capabilities: ['profile'],
    policyVersions: [],
    assets: [],
    profile: { read: async () => ({}) },
  };
}
