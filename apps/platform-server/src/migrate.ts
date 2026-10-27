import { fileURLToPath } from 'node:url';
import { authorizationVersionMigrationStatements } from '@board-game/server';
import { applyStandaloneEnvironment, loadStandaloneConfig } from './config.js';

/**
 * Database changes are an explicit deployment operation. Startup only checks
 * readiness and never runs migrations implicitly.
 */
async function main(): Promise<void> {
  const config = await loadStandaloneConfig();
  applyStandaloneEnvironment(config);
  const { runDatabaseMigrations } = await import(
    '@board-platform/server/persistence/database-migrations.js'
  );
  const { assertPlatformSchemaReady, migratePlatform } = await import(
    '@board-platform/server/platform/schema.js'
  );
  const { PostgresCompletionRecordStore, PostgresReleaseRegistryStore } =
    await import('@board-platform/server');
  const migrationFolder = fileURLToPath(
    new URL('../drizzle/', import.meta.url),
  );
  await runDatabaseMigrations({
    migrationsFolder: migrationFolder,
    afterMigrate: async (migrationPool) => {
      await migratePlatform(migrationPool, { embeddedGames: false });
      for (const statement of authorizationVersionMigrationStatements())
        await migrationPool.query(statement);
      await new PostgresCompletionRecordStore({
        pool: migrationPool,
        platformId: config.platformId,
      }).migrate();
      await new PostgresReleaseRegistryStore(migrationPool).migrate();
      await assertPlatformSchemaReady(migrationPool, { embeddedGames: false });
    },
  });
  // biome-ignore lint/suspicious/noConsole: migration commands must report their target.
  console.log(
    `[platform-server:db:migrate] Ready: ${config.platformId} (${config.databaseUrl.replace(/:\/\/.*@/u, '://***@')})`,
  );
}

void main().catch((error: unknown) => {
  // biome-ignore lint/suspicious/noConsole: migration failures must be visible to operators.
  console.error(
    '[platform-server:db:migrate] Failed:',
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});
