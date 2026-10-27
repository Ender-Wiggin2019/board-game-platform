import { randomUUID } from 'node:crypto';
import {
  directoryMigrationStatements,
  PostgresAdmissionStore,
} from '@board-game/core';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GameCapabilityRegistry } from '@/platform/capabilities/index.js';
import { NativeShellSummaryReader } from '@/platform/NativeShellSummary.js';

const databaseUrl = process.env.BGP_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)(
  'NativeShellSummaryReader PostgreSQL paging',
  () => {
    const principalId = `native-pg-player-${randomUUID()}`;
    const gameId = `native-pg-game-${randomUUID()}`;
    const currentReleaseId = `${gameId}-current`;
    const retainedReleaseId = `${gameId}-retained`;
    const roomIds = Array.from(
      { length: 65 },
      (_, index) => `${gameId}-room-${index.toString().padStart(3, '0')}`,
    );
    let pool: Pool;

    beforeAll(async () => {
      pool = new Pool({ connectionString: databaseUrl });
      for (const statement of directoryMigrationStatements())
        await pool.query(statement);
      for (const statement of directoryMigrationStatements())
        await pool.query(statement);
      const admission = new PostgresAdmissionStore({ pool });
      await admission.migrate();
      await admission.migrate();

      const participants = JSON.stringify([
        { principalId, seatId: `${gameId}-seat` },
      ]);
      for (let index = 0; index < 65; index += 1) {
        const releaseId =
          index % 2 === 0 ? currentReleaseId : retainedReleaseId;
        await pool.query(
          `INSERT INTO "board_platform_directory"."sessions" (
           session_id, admission_id, game_id, mode_id, release_id,
           backend_binding_id, storage_binding_id, ownership_epoch,
           visibility, participants, status, latest_aggregate_sequence,
           summary, result, created_at, updated_at
         ) VALUES ($1, $2, $3, 'room', $4, 'backend', 'storage', 'epoch',
           'private', $5::jsonb, 'active', 0, $6::jsonb, NULL, 1, $7)`,
          [
            `${gameId}-session-${index.toString().padStart(3, '0')}`,
            `${gameId}-admission-${index}`,
            gameId,
            releaseId,
            participants,
            JSON.stringify({ actionRequired: principalId }),
            100 - index,
          ],
        );
        const room = {
          id: roomIds[index],
          ownerId: principalId,
          gameId,
          modeId: 'room',
          releaseId,
          visibility: 'private',
          setup: { playerCount: 1 },
          members: [{ principalId, seatId: `${gameId}-seat`, ready: false }],
          revision: 1,
          startGeneration: 0,
          status: 'open',
        };
        await pool.query(
          `INSERT INTO "board_platform_admission"."rooms" (id, room)
         VALUES ($1, $2::jsonb)`,
          [room.id, JSON.stringify(room)],
        );
      }
    });

    afterAll(async () => {
      await pool.query(
        'DELETE FROM "board_platform_directory"."sessions" WHERE game_id = $1',
        [gameId],
      );
      await pool.query(
        'DELETE FROM "board_platform_admission"."rooms" WHERE id = ANY($1::text[])',
        [roomIds],
      );
      await pool.end();
    });

    it('pages both participant-owned projections and resolves retained releases exactly', async () => {
      const registry = new GameCapabilityRegistry();
      for (const releaseId of [currentReleaseId, retainedReleaseId])
        registry.register({
          metadata: {
            gameId,
            name: 'Native PostgreSQL fixture',
            description: 'Native PostgreSQL fixture',
            themeId: gameId,
          },
          releaseId,
          capabilities: ['profile'],
          policyVersions: [],
          assets: [],
          profile: { read: async () => ({}) },
          sessionAttention: {
            interpret: (summary, context) =>
              Boolean(
                summary &&
                  typeof summary === 'object' &&
                  !Array.isArray(summary) &&
                  (summary as { actionRequired?: unknown }).actionRequired ===
                    context.principalId,
              ),
            roomCapacity: () => 1,
          },
        });

      let queryCount = 0;
      const query = (text: string, values?: readonly unknown[]) => {
        queryCount += 1;
        return pool.query(text, values as unknown[] | undefined);
      };
      const reader = new NativeShellSummaryReader(
        { query } as unknown as ConstructorParameters<
          typeof NativeShellSummaryReader
        >[0],
        registry,
      );

      await expect(reader.read(principalId)).resolves.toEqual(
        new Map([[gameId, { actionRequired: 65, waitingReady: 65 }]]),
      );
      expect(queryCount).toBe(2);
    });

    it('installs the participant lookup indexes idempotently', async () => {
      const result = await pool.query<{ indexname: string }>(
        `SELECT indexname
           FROM pg_indexes
          WHERE (schemaname, tablename, indexname) IN (
            ('board_platform_directory', 'sessions', 'sessions_active_participants_idx'),
            ('board_platform_admission', 'rooms', 'rooms_open_members_idx'),
            ('board_platform_admission', 'room_grants', 'room_grants_pending_principal_idx')
          )
          ORDER BY indexname`,
      );
      expect(result.rows.map(({ indexname }) => indexname)).toEqual([
        'room_grants_pending_principal_idx',
        'rooms_open_members_idx',
        'sessions_active_participants_idx',
      ]);
    });
  },
);
