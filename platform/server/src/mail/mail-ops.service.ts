import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DRIZZLE_DB } from '@/persistence/drizzle.module.js';
import { mailChannelForKind } from './mail-policy.js';

export interface IMailOpsStatus {
  generatedAt: string;
  byStatus: Record<string, number>;
  byDeliveryStatus: Record<string, number>;
  byKind: Record<string, number>;
  byChannel: Record<string, number>;
  recent: IMailOpsJob[];
}

export interface IMailOpsJob {
  id: string;
  dedupeKey: string;
  recipientHint: string;
  kind: string;
  status: string;
  deliveryStatus: string;
  attemptCount: number;
  providerMessageId: string | null;
  providerSentAt: Date | null;
  lastErrorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IMailOpsSuppression {
  recipientHint: string;
  category: string;
  reason: string;
  source: string;
  expiresAt: Date | null;
  createdAt: Date;
}

@Injectable()
export class MailOpsService {
  public constructor(@Inject(DRIZZLE_DB) private readonly db: NodePgDatabase) {}

  public async getStatus(limit = 50): Promise<IMailOpsStatus> {
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const [statusRows, deliveryRows, kindRows, recentRows] = await Promise.all([
      this.db.execute(sql`
          SELECT status, count(*)::integer AS count
          FROM mail_outbox
          GROUP BY status
        `),
      this.db.execute(sql`
          SELECT delivery_status AS "deliveryStatus", count(*)::integer AS count
          FROM mail_outbox
          GROUP BY delivery_status
        `),
      this.db.execute(sql`
          SELECT kind, count(*)::integer AS count
          FROM mail_outbox
          GROUP BY kind
        `),
      this.db.execute(sql`
          SELECT
            id,
            dedupe_key AS "dedupeKey",
            recipient,
            kind,
            status,
            delivery_status AS "deliveryStatus",
            attempt_count AS "attemptCount",
            provider_message_id AS "providerMessageId",
            provider_sent_at AS "providerSentAt",
            last_error_code AS "lastErrorCode",
            created_at AS "createdAt",
            updated_at AS "updatedAt"
          FROM mail_outbox
          ORDER BY updated_at DESC, id DESC
          LIMIT ${boundedLimit}
        `),
    ]);

    const byKind = countMap(kindRows.rows, 'kind');
    return {
      generatedAt: new Date().toISOString(),
      byStatus: countMap(statusRows.rows),
      byDeliveryStatus: countMap(deliveryRows.rows, 'deliveryStatus'),
      byKind,
      byChannel: channelCountMap(byKind),
      recent: recentRows.rows.map((row) => {
        const value = row as Record<string, unknown>;
        return {
          id: String(value.id),
          dedupeKey: String(value.dedupeKey),
          recipientHint: maskRecipient(String(value.recipient)),
          kind: String(value.kind),
          status: String(value.status),
          deliveryStatus: String(value.deliveryStatus),
          attemptCount: Number(value.attemptCount),
          providerMessageId: nullableString(value.providerMessageId),
          providerSentAt: nullableDate(value.providerSentAt),
          lastErrorCode: nullableString(value.lastErrorCode),
          createdAt: requiredDate(value.createdAt),
          updatedAt: requiredDate(value.updatedAt),
        };
      }),
    };
  }

  public async listSuppressions(limit = 100): Promise<IMailOpsSuppression[]> {
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const result = await this.db.execute(sql`
      SELECT
        recipient,
        category,
        reason,
        source,
        expires_at AS "expiresAt",
        created_at AS "createdAt"
      FROM mail_suppressions
      ORDER BY created_at DESC, id DESC
      LIMIT ${boundedLimit}
    `);
    return result.rows.map((row) => {
      const value = row as Record<string, unknown>;
      return {
        recipientHint: maskRecipient(String(value.recipient)),
        category: String(value.category),
        reason: String(value.reason),
        source: String(value.source),
        expiresAt: nullableDate(value.expiresAt),
        createdAt: requiredDate(value.createdAt),
      };
    });
  }
}

function channelCountMap(
  byKind: Readonly<Record<string, number>>,
): Record<string, number> {
  const output: Record<string, number> = {};
  for (const [kind, count] of Object.entries(byKind)) {
    let channel = 'unknown';
    try {
      channel = mailChannelForKind(kind);
    } catch {
      // Keep operations readable if a newer schema kind appears before this
      // process has been upgraded.
    }
    output[channel] = (output[channel] ?? 0) + count;
  }
  return output;
}

function countMap(
  rows: readonly unknown[],
  key = 'status',
): Record<string, number> {
  const output: Record<string, number> = {};
  for (const row of rows) {
    const value = row as Record<string, unknown>;
    const name = String(value[key]);
    output[name] = Number(value.count);
  }
  return output;
}

function maskRecipient(recipient: string): string {
  const at = recipient.indexOf('@');
  if (at <= 0 || at === recipient.length - 1) return '[redacted]';
  const local = recipient.slice(0, at);
  const domain = recipient.slice(at + 1);
  return `${local.slice(0, Math.min(2, local.length))}***@${domain}`;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function nullableDate(value: unknown): Date | null {
  return value instanceof Date ? value : value ? new Date(String(value)) : null;
}

function requiredDate(value: unknown): Date {
  const date = nullableDate(value);
  if (!date) throw new Error('Mail ops query returned an invalid timestamp');
  return date;
}
