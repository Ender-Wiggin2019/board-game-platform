import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { describe, expect, it, vi } from 'vitest';
import {
  PlatformMessageService,
  postgresGameMessageWriter,
} from '@/platform/PlatformMessageService.js';

const input = {
  gameId: 'brass-pittsburgh',
  templateId: 'completion',
  principalId: 'player',
  sourceId: 'session-1:1',
  payload: {},
};
describe('game messages in the shared inbox', () => {
  it('namespaces durable message keys by game and preserves retry identity', async () => {
    const write = vi.fn(async () => undefined);
    const service = new PlatformMessageService(write);
    const template = () => ({
      title: { kind: 'literal' as const, text: 'Finished' },
      body: { kind: 'literal' as const, text: 'Your game is complete.' },
    });
    service.registerGame('brass-pittsburgh', { completion: template });
    service.registerGame('seti', { completion: template });
    await service.publish(input);
    await service.publish(input);
    await service.publish({ ...input, gameId: 'seti' });
    expect(write.mock.calls[0]).toEqual(write.mock.calls[1]);
    expect(write.mock.calls[0]).not.toEqual(write.mock.calls[2]);
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({ gameId: 'brass-pittsburgh' }),
        principalId: 'player',
      }),
    );
  });
  it('requires a registered template and rejects unsafe action links', async () => {
    const write = vi.fn(async () => undefined);
    const service = new PlatformMessageService(write);
    await expect(service.publish(input)).rejects.toMatchObject({
      envelope: { code: 'NOT_FOUND' },
    });
    service.registerGame('brass-pittsburgh', {
      completion: () => ({
        title: { kind: 'literal', text: 'Finished' },
        body: { kind: 'literal', text: '' },
        action: { label: 'Open', href: 'javascript:alert(1)' },
      }),
    });
    await expect(service.publish(input)).rejects.toMatchObject({
      envelope: { code: 'INVALID_REQUEST' },
    });
    expect(write).not.toHaveBeenCalled();
  });

  it('notifies the account only after a new durable insert', async () => {
    const onNewInsert = vi.fn();
    const returning = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'message-1' }])
      .mockResolvedValueOnce([]);
    const onConflictDoNothing = vi.fn(() => ({ returning }));
    const values = vi.fn(() => ({ onConflictDoNothing }));
    const db = {
      insert: vi.fn(() => ({ values })),
    } as unknown as NodePgDatabase;
    const write = postgresGameMessageWriter(db, onNewInsert);

    await write({
      content: {
        title: { kind: 'literal', text: 'Finished' },
        body: { kind: 'literal', text: 'Your game is complete.' },
        version: 1,
        kind: 'plain',
        gameId: 'brass-pittsburgh',
      },
      principalId: 'player',
      sourceKey:
        'platform-message:brass-pittsburgh:completion:player:session-1:1',
    });
    await write({
      content: {
        title: { kind: 'literal', text: 'Finished' },
        body: { kind: 'literal', text: 'Your game is complete.' },
        version: 1,
        kind: 'plain',
        gameId: 'brass-pittsburgh',
      },
      principalId: 'player',
      sourceKey:
        'platform-message:brass-pittsburgh:completion:player:session-1:1',
    });

    expect(onNewInsert).toHaveBeenCalledTimes(1);
    expect(onNewInsert).toHaveBeenCalledWith('player');
  });

  it('does not fail the durable write when account invalidation fails', async () => {
    const onNewInsert = vi.fn(async () => {
      throw new Error('shell unavailable');
    });
    const db = {
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          onConflictDoNothing: vi.fn(() => ({
            returning: vi.fn(async () => [{ id: 'message-1' }]),
          })),
        })),
      })),
    } as unknown as NodePgDatabase;
    const write = postgresGameMessageWriter(db, onNewInsert);

    await expect(
      write({
        content: {
          title: { kind: 'literal', text: 'Finished' },
          body: { kind: 'literal', text: 'Your game is complete.' },
          version: 1,
          kind: 'plain',
          gameId: 'brass-pittsburgh',
        },
        principalId: 'player',
        sourceKey:
          'platform-message:brass-pittsburgh:completion:player:session-1:1',
      }),
    ).resolves.toBeUndefined();
    expect(onNewInsert).toHaveBeenCalledWith('player');
  });
});
