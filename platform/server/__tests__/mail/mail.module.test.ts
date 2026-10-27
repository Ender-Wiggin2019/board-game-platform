import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { MailModule } from '@/mail/mail.module.js';
import { MailBudgetService } from '@/mail/mail-budget.service.js';
import { MailOutboxService } from '@/mail/mail-outbox.service.js';
import {
  DRIZZLE_DB,
  DRIZZLE_POOL,
  DrizzleModule,
} from '@/persistence/drizzle.module.js';

describe('MailModule', () => {
  it('assembles the module without registering the worker-owned budget service', async () => {
    const db = {};
    const moduleRef = await Test.createTestingModule({
      imports: [DrizzleModule, MailModule],
    })
      .overrideProvider(DRIZZLE_POOL)
      .useValue({ end: async () => undefined })
      .overrideProvider(DRIZZLE_DB)
      .useValue(db)
      .compile();

    expect(moduleRef.get(MailOutboxService)).toBeInstanceOf(MailOutboxService);
    expect(() => moduleRef.get(MailBudgetService)).toThrow();
    await moduleRef.close();
  });
});
