import { describe, expect, it, vi } from 'vitest';
import { MailSuppressionService } from '@/mail/mail-suppression.service.js';

const USER_ID = '7c303e2b-590a-4a09-8647-0d0bf2a1cc24';
const GAME_ID = '3c0df260-a493-4bb1-9b9d-ea30a82cd076';

function createTransactionalDb() {
  const execute = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn().mockResolvedValue(undefined);
  const transactionInsert = vi.fn().mockReturnValue({ values });
  const transaction = vi.fn(async (callback: (tx: unknown) => Promise<void>) =>
    callback({ execute, insert: transactionInsert }),
  );
  return {
    db: { transaction } as never,
    execute,
    transaction,
    transactionInsert,
  };
}

describe('MailSuppressionService', () => {
  it('writes game mute and audit rows inside the database transaction', async () => {
    const fixture = createTransactionalDb();
    const service = new MailSuppressionService(fixture.db);

    await service.muteGame(USER_ID, GAME_ID);

    expect(fixture.transaction).toHaveBeenCalledTimes(1);
    expect(fixture.execute).toHaveBeenCalledTimes(1);
    expect(fixture.transactionInsert).toHaveBeenCalledTimes(1);
  });

  it('writes game unmute and audit rows inside the database transaction', async () => {
    const fixture = createTransactionalDb();
    const service = new MailSuppressionService(fixture.db);

    await service.unmuteGame(USER_ID, GAME_ID);

    expect(fixture.transaction).toHaveBeenCalledTimes(1);
    expect(fixture.execute).toHaveBeenCalledTimes(1);
    expect(fixture.transactionInsert).toHaveBeenCalledTimes(1);
  });
});
