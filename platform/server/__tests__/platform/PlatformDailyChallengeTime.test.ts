import { describe, expect, it } from 'vitest';
import {
  dailyChallengeCutoffAt,
  dailyChallengeWindow,
} from '@/platform/daily-challenge/time.js';

describe('daily challenge calendar', () => {
  it('refreshes at 23:59 and leaves the preceding challenge open until 03:00', () => {
    const before = dailyChallengeWindow(new Date('2026-10-26T23:58:59.999Z'));
    const after = dailyChallengeWindow(new Date('2026-10-26T23:59:00.000Z'));
    expect(before.challengeDate).toBe('2026-10-26');
    expect(before.nextRefreshAt.toISOString()).toBe('2026-10-26T23:59:00.000Z');
    expect(before.eligibilityCutoffAt.toISOString()).toBe(
      '2026-10-27T03:00:00.000Z',
    );
    expect(after.challengeDate).toBe('2026-10-27');
    expect(after.nextRefreshAt.toISOString()).toBe('2026-10-27T23:59:00.000Z');
  });

  it('uses the configured calendar zone instead of the server process zone', () => {
    const window = dailyChallengeWindow(
      new Date('2026-10-26T15:59:00.000Z'),
      'Asia/Shanghai',
    );
    expect(window.challengeDate).toBe('2026-10-27');
    expect(window.nextRefreshAt.toISOString()).toBe('2026-10-27T15:59:00.000Z');
    expect(window.eligibilityCutoffAt.toISOString()).toBe(
      '2026-10-27T19:00:00.000Z',
    );
  });

  it.each([
    ['2026-03-07', '2026-03-08T07:00:00.000Z'],
    ['2026-10-31', '2026-11-01T08:00:00.000Z'],
  ])('preserves 03:00 across New York DST for %s', (date, expected) => {
    expect(dailyChallengeCutoffAt(date, 'America/New_York').toISOString()).toBe(
      expected,
    );
  });

  it('handles a skipped and repeated 03:00 at the Helsinki DST boundary', () => {
    expect(
      dailyChallengeCutoffAt('2026-03-28', 'Europe/Helsinki').toISOString(),
    ).toBe('2026-03-29T01:00:00.000Z');
    expect(
      dailyChallengeCutoffAt('2026-10-24', 'Europe/Helsinki').toISOString(),
    ).toBe('2026-10-25T00:00:00.000Z');
  });

  it('rejects invalid clocks and zones', () => {
    expect(() => dailyChallengeWindow(new Date(Number.NaN))).toThrow();
    expect(() => dailyChallengeWindow(new Date(), 'invalid-zone')).toThrow();
  });
});
