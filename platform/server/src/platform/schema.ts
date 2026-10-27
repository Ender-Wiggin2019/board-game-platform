import {
  directoryMigrationStatements,
  PostgresAdmissionStore,
  PostgresAwardStore,
  PostgresEntitlementStore,
  PostgresInboxStore,
  PostgresRatingStore,
} from '@board-game/core';
import { PostgresStorageDriver } from '@board-game/storage';
import type { Pool } from 'pg';
import { PostgresCompletionRecordStore } from './CompletionRecordStore.js';
import { gameAchievementMigrationStatements } from './capabilities/achievements.js';
import { dailyChallengeMigrationStatements } from './daily-challenge/store.js';
import { PostgresPlatformFeedbackStore } from './feedback/store.js';
import { PostgresGameAccessStore } from './game-access/store.js';
import { PlatformRoomChat } from './PlatformRoomChat.js';
import { PlatformSessionChat } from './PlatformSessionChat.js';
import { PlatformSessionNotes } from './PlatformSessionNotes.js';
import {
  DEFAULT_RELEASE_REGISTRY_SCHEMA,
  PostgresReleaseRegistryStore,
} from './releases/store.js';

/** Deployment-only DDL shared by every game; runtime construction never migrates. */
export async function migratePlatform(
  pool: Pool,
  options: { readonly embeddedGames?: boolean } = {},
): Promise<void> {
  if (options.embeddedGames !== false)
    await new PostgresStorageDriver({ pool }).migrate();
  await new PostgresAdmissionStore({ pool }).migrate();
  await new PostgresInboxStore({ pool }).migrate();
  await new PostgresCompletionRecordStore({ pool }).migrate();
  await new PostgresRatingStore({ pool }).migrate();
  await new PostgresEntitlementStore({ pool }).migrate();
  await new PostgresAwardStore({ pool }).migrate();
  for (const statement of gameAchievementMigrationStatements())
    await pool.query(statement);
  for (const statement of directoryMigrationStatements())
    await pool.query(statement);
  await new PostgresGameAccessStore(pool).migrate();
  await new PostgresPlatformFeedbackStore(pool).migrate();
  for (const statement of dailyChallengeMigrationStatements())
    await pool.query(statement);
  await PlatformSessionNotes.migrate(pool);
  await PlatformSessionChat.migrate(pool);
  await PlatformRoomChat.migrate(pool);
  await new PostgresReleaseRegistryStore(pool, {
    schema: DEFAULT_RELEASE_REGISTRY_SCHEMA,
  }).migrate();
}

export async function assertPlatformSchemaReady(
  pool: Pool,
  options: { readonly embeddedGames?: boolean } = {},
): Promise<void> {
  const required = [
    ...(options.embeddedGames === false
      ? []
      : [
          'board_platform_storage.session_heads',
          'board_platform_storage.command_receipts',
          'board_platform_storage.outbox',
          'board_platform_storage.domain_events',
        ]),
    'board_platform_admission.rooms',
    'board_platform_admission.starts',
    'board_platform_admission.room_security',
    'board_platform_admission.room_grants',
    'board_platform_admission.room_create_receipts',
    'board_platform_inbox.facts',
    'board_platform_inbox.consumer_receipts',
    'board_platform_completion.records',
    'board_platform_completion.historical_baselines',
    'board_platform_completion.conflicts',
    'board_platform_ratings.ratings',
    'public.platform_game_achievement_progress',
    'public.platform_game_achievement_sources',
    'board_platform_ratings.settlements',
    'board_platform_entitlements.balances',
    'board_platform_entitlements.reservations',
    'board_platform_awards.awards',
    'board_platform_awards.rewards',
    'board_platform_directory.sessions',
    'board_platform_directory.facts',
    'board_platform_social.session_notes',
    'board_platform_social.session_chat_streams',
    'board_platform_social.session_chat_messages',
    'board_platform_social.session_chat_sender_streams',
    'board_platform_social.session_chat_read_cursors',
    'board_platform_social.room_chat_streams',
    'board_platform_social.room_chat_messages',
    'board_platform_social.room_chat_sender_streams',
    'board_platform_social.room_chat_read_cursors',
    'board_platform_game_access.codes',
    'board_platform_game_access.grants',
    'board_platform_feedback.reports',
    'board_platform_daily.challenge_settings',
    'board_platform_daily.challenge_snapshots',
    'board_platform_daily.challenge_attempts',
    `${DEFAULT_RELEASE_REGISTRY_SCHEMA}.releases`,
    `${DEFAULT_RELEASE_REGISTRY_SCHEMA}.bindings`,
    `${DEFAULT_RELEASE_REGISTRY_SCHEMA}.channels`,
    `${DEFAULT_RELEASE_REGISTRY_SCHEMA}.channel_operations`,
  ];
  const result = await pool.query<{ relation: string; present: boolean }>(
    'SELECT relation, to_regclass(relation) IS NOT NULL AS present FROM unnest($1::text[]) AS relation',
    [required],
  );
  const requiredColumns = [
    ['board_platform_ratings', 'ratings', 'ranking_score'],
    ['board_platform_inbox', 'consumer_receipts', 'next_attempt_at'],
    ['board_platform_awards', 'rewards', 'next_attempt_at'],
    ['board_platform_entitlements', 'reservations', 'intent'],
    ...(options.embeddedGames === false
      ? []
      : [
          ['board_platform_storage', 'outbox', 'next_attempt_at'],
          ['board_platform_storage', 'session_heads', 'deadline_id'],
          ['board_platform_storage', 'session_heads', 'deadline_due_at'],
        ]),
  ];
  const columns = await pool.query<{ present: boolean }>(
    `SELECT EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = expected.schema AND c.table_name = expected."table"
        AND c.column_name = expected."column"
    ) AS present FROM jsonb_to_recordset($1::jsonb) AS expected(schema text, "table" text, "column" text)`,
    [
      JSON.stringify(
        requiredColumns.map(([schema, table, column]) => ({
          schema,
          table,
          column,
        })),
      ),
    ],
  );
  if (
    columns.rows.length !== requiredColumns.length ||
    columns.rows.some((row) => !row.present) ||
    result.rows.length !== required.length ||
    result.rows.some((row) => !row.present)
  )
    throw new Error(
      'Platform schema is not ready. Run the database migration command before starting the server.',
    );
}
