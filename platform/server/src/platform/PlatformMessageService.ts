import {
  assertJsonPayloadSize,
  contractError,
  type JsonValue,
} from '@board-game/contracts';
import {
  EMessageSeverity,
  isMessageContent,
  type TMessageContent,
} from '@board-platform/contracts/types/protocol/messages';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { globalMessages } from '@/persistence/schema/messages.js';

type PlainMessage = Extract<TMessageContent, { kind: 'plain' }>;
export type GameMessageTemplate = (
  payload: JsonValue,
) => Omit<PlainMessage, 'version' | 'kind' | 'gameId'>;
export interface GameMessageInput {
  readonly gameId: string;
  readonly templateId: string;
  readonly principalId: string;
  readonly sourceId: string;
  readonly payload: JsonValue;
}
export type GameMessageWriter = (input: {
  readonly content: PlainMessage;
  readonly principalId: string;
  readonly sourceKey: string;
}) => Promise<void>;

/** Game templates deliver through the same durable personal inbox and read state. */
export class PlatformMessageService {
  private readonly templates = new Map<
    string,
    Readonly<Record<string, GameMessageTemplate>>
  >();
  constructor(private readonly write: GameMessageWriter) {}

  /** Message templates are game-scoped and shared by retained releases. */
  hasGame(gameId: string): boolean {
    return this.templates.has(gameId);
  }

  registerGame(
    gameId: string,
    templates: Readonly<Record<string, GameMessageTemplate>>,
  ): void {
    requireId(gameId);
    if (this.templates.has(gameId))
      throw contractError('CONFLICT', 'platform.messages.game_registered');
    for (const [key, template] of Object.entries(templates)) {
      requireId(key);
      if (typeof template !== 'function')
        throw contractError('INVALID_REQUEST', 'platform.messages.template');
    }
    this.templates.set(gameId, Object.freeze({ ...templates }));
  }

  async publish(input: GameMessageInput): Promise<void> {
    requireId(input.gameId);
    requireId(input.templateId);
    requireId(input.principalId);
    requireId(input.sourceId);
    assertJsonPayloadSize(input.payload, 64 * 1024);
    const template = this.templates.get(input.gameId)?.[input.templateId];
    if (!template)
      throw contractError('NOT_FOUND', 'platform.messages.template');
    const content: PlainMessage = {
      ...template(input.payload),
      version: 1,
      kind: 'plain',
      gameId: input.gameId,
    };
    if (!isMessageContent(content))
      throw contractError('INVALID_REQUEST', 'platform.messages.content');
    assertJsonPayloadSize(content, 64 * 1024);
    await this.write({
      content,
      principalId: input.principalId,
      sourceKey: [
        'platform-message',
        input.gameId,
        input.templateId,
        input.principalId,
        input.sourceId,
      ].join(':'),
    });
  }
}

/** The unique source key makes completion retry and recovery safe. */
export function postgresGameMessageWriter(
  db: NodePgDatabase,
  onNewInsert?: (principalId: string) => void | Promise<void>,
): GameMessageWriter {
  return async ({ content, principalId, sourceKey }) => {
    const inserted = await db
      .insert(globalMessages)
      .values({
        content,
        severity: EMessageSeverity.SUCCESS,
        recipientUserId: principalId,
        sourceKey,
      })
      .onConflictDoNothing({
        target: globalMessages.sourceKey,
        where: sql`${globalMessages.sourceKey} IS NOT NULL`,
      })
      .returning({ id: globalMessages.id });
    if (inserted.length === 0 || !onNewInsert) return;
    try {
      await onNewInsert(principalId);
    } catch {
      // Shell invalidation is a best-effort hint after the durable write.
    }
  };
}

function requireId(value: string) {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)
  )
    throw contractError('INVALID_REQUEST', 'platform.messages.identifier');
}
