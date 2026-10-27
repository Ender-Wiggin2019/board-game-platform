import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type PostgresAuthorizationPool,
  PostgresAuthorizationVersionStore,
} from '../src/index.js';

const databaseUrl = process.env.BGP_TEST_DATABASE_URL;
const postgresSuite = databaseUrl ? describe : describe.skip;
const loadCommonJs = createRequire(import.meta.url);

type PgPool = PostgresAuthorizationPool & {
  end(): Promise<void>;
};

type PgModule = {
  Pool: new (options: { readonly connectionString: string }) => PgPool;
};

const route = {
  gameId: 'credential-pg-game',
  modeId: 'ranked',
  sessionId: 'credential-pg-session',
  releaseId: 'credential-pg-release',
  backendBindingId: 'credential-pg-backend',
  storageBindingId: 'credential-pg-storage',
  ownershipEpoch: 'credential-pg-epoch',
} as const;

const key = {
  platformId: 'credential-pg-platform',
  sessionId: route.sessionId,
  principalId: 'credential-pg-player',
} as const;

const advance = {
  ...key,
  authenticatedPlatformId: key.platformId,
  route,
  seatId: 'seat-1',
  scopes: ['session:view', 'session:command', 'game:chat'],
  authEpoch: 'epoch-1',
  authorizationRevision: 1,
} as const;

postgresSuite('PostgresAuthorizationVersionStore', () => {
  const schema = `credential_${process.pid}_${randomUUID()
    .replaceAll('-', '')
    .slice(0, 12)}`;
  let pool: PgPool;
  let store: PostgresAuthorizationVersionStore;

  beforeAll(async () => {
    const { Pool } = loadCommonJs('pg') as PgModule;
    pool = new Pool({ connectionString: databaseUrl as string });
    store = new PostgresAuthorizationVersionStore({ pool, schema });
    await store.migrate();
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  it('reads durable authorization after a store restart and preserves revocation', async () => {
    const created = await store.advance(advance);
    const restarted = new PostgresAuthorizationVersionStore({ pool, schema });
    expect(await restarted.get(key)).toEqual(created);
    expect(await restarted.advance(advance)).toEqual(created);

    const revoked = await restarted.revoke({
      ...key,
      authenticatedPlatformId: key.platformId,
      authorizationRevision: 1,
    });
    const afterRevokeRestart = new PostgresAuthorizationVersionStore({
      pool,
      schema,
    });
    expect(await afterRevokeRestart.get(key)).toEqual(revoked);
    expect(revoked.revokedAt).toEqual(expect.any(Number));
  });
});
