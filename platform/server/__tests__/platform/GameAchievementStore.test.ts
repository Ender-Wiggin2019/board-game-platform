import { describe, expect, it } from 'vitest';
import {
  gameAchievementMigrationStatements,
  MemoryGameAchievementStore,
} from '@/platform/capabilities/achievements.js';

const definitions = [
  {
    achievementId: 'games-played',
    title: 'Games Played',
    description: 'Complete two games.',
    tier: 'starter',
    target: 2,
  },
] as const;

describe('MemoryGameAchievementStore', () => {
  it('accumulates durable progress and ignores a repeated source record', async () => {
    const store = new MemoryGameAchievementStore();
    const source = (sourceRecordId: string) => ({
      gameId: 'brass-pittsburgh',
      definitionVersion: 'brass-achievements-v1',
      sourceRecordId,
      occurredAt: 100,
      sources: [
        {
          principalId: 'player-a',
          facts: [{ achievementId: 'games-played', amount: 1 }],
        },
      ],
      definitions,
    });

    await store.consume(source('session-1'));
    await store.consume(source('session-1'));
    await store.consume(source('session-2'));

    await expect(
      store.read({
        gameId: 'brass-pittsburgh',
        principalId: 'player-a',
        definitionVersion: 'brass-achievements-v1',
        definitions,
      }),
    ).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          achievementId: 'games-played',
          progress: 2,
          target: 2,
          unlocked: true,
          unlockedAt: 100,
        }),
      ],
    });
  });
});

describe('game achievement migration', () => {
  it('creates source idempotency and progress tables with a bounded lookup index', () => {
    const statements = gameAchievementMigrationStatements().join('\n');
    expect(statements).toContain('platform_game_achievement_sources');
    expect(statements).toContain(
      'PRIMARY KEY (game_id, definition_version, principal_id, source_record_id)',
    );
    expect(statements).toContain('platform_game_achievement_progress');
    expect(statements).toContain(
      'platform_game_achievement_progress_leaderboard_idx',
    );
  });
});
