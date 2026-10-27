import { getTableConfig, pgTable, uuid } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { createMailSchema } from '@/persistence/schema/mailOutbox.js';

describe('application mail schema composition', () => {
  it('retains all legacy foreign-key names and cascade behavior when a game is installed', () => {
    const legacyGames = pgTable('legacy_game_records', {
      id: uuid('id').primaryKey(),
    });
    const schema = createMailSchema(legacyGames.id);
    const targets = [
      [schema.gameForegroundPresence, 'game_foreground_presence_game_id_fkey'],
      [schema.mailOutbox, 'mail_outbox_game_id_games_id_fk'],
      [schema.mailTurnMutes, 'mail_turn_mutes_game_id_games_id_fk'],
      [schema.notificationCursors, 'notification_cursors_game_id_games_id_fk'],
    ] as const;
    for (const [table, name] of targets) {
      const constraint = getTableConfig(table).foreignKeys.find(
        (key) => key.getName() === name,
      );
      expect(constraint?.reference().foreignTable).toBe(legacyGames);
      expect(constraint?.onDelete).toBe('cascade');
    }
  });

  it('builds the platform schema without requiring a game table', () => {
    const schema = createMailSchema();
    for (const table of [
      schema.gameForegroundPresence,
      schema.mailOutbox,
      schema.mailTurnMutes,
      schema.notificationCursors,
    ]) {
      expect(
        getTableConfig(table).foreignKeys.every((key) =>
          key.reference().columns.every((column) => column.name !== 'game_id'),
        ),
      ).toBe(true);
    }
  });
});
