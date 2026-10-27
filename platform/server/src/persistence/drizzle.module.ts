import {
  Global,
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { createReadyPool } from './schemaReadiness.js';

export const DRIZZLE_DB = Symbol('DRIZZLE_DB');
export const DRIZZLE_POOL = Symbol('DRIZZLE_POOL');

/** Runs after gateway drain and transport shutdown, while remaining queries finish. */
@Injectable()
export class DatabaseShutdown implements OnApplicationShutdown {
  public constructor(@Inject(DRIZZLE_POOL) private readonly pool: Pool) {}

  public async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

@Global()
@Module({
  providers: [
    DatabaseShutdown,
    {
      provide: DRIZZLE_POOL,
      useFactory: createReadyPool,
    },
    {
      provide: DRIZZLE_DB,
      inject: [DRIZZLE_POOL],
      useFactory: (pool: Pool): NodePgDatabase => drizzle(pool),
    },
  ],
  exports: [DRIZZLE_DB, DRIZZLE_POOL],
})
export class DrizzleModule {}
