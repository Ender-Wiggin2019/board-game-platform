import type { TUserLanguage } from '@board-platform/contracts/types/protocol/userLanguage';
import type { TMailChannel } from './mail-policy.js';

export const MAIL_TEMPLATE_KEYS = [
  'reset_password',
  'email_change_verify',
  'turn_reminder',
] as const;
export type TMailTemplateKey = (typeof MAIL_TEMPLATE_KEYS)[number];

export interface IMailTemplateInput {
  recipient: string;
  templateKey: TMailTemplateKey;
  variables: Readonly<Record<string, string>>;
  internalJobId: string;
  /** Account language for providers that render mail content server-side. */
  language?: TUserLanguage;
  /** Optional lane metadata for providers that expose transactional classes. */
  channel?: TMailChannel;
  kind?: 'transactional' | 'notification';
}

export interface IMailAcceptedResult {
  provider: 'tencent-ses' | 'resend';
  status: 'accepted';
  messageId: string;
  requestId: string | null;
}

export type TMailProviderDisposition =
  | 'retryable'
  | 'unknown'
  | 'permanent'
  | 'suppressed'
  | 'configuration';

/** Errors retain a safe code for persistence without exposing provider secrets. */
export class MailProviderError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly disposition: TMailProviderDisposition,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'MailProviderError';
  }
}

export interface IMailDeliveryStatus {
  messageId: string;
  recipient: string;
  deliveryStatus: 'unknown' | 'delivered' | 'bounced' | 'complained';
  detail?: string;
}

export interface MailProvider {
  readonly provider: 'tencent-ses' | 'resend';
  isConfigured(): boolean;
  sendTemplate(input: IMailTemplateInput): Promise<IMailAcceptedResult>;
  getSendEmailStatus(input: {
    messageId: string;
    recipient?: string;
    requestDate?: Date;
  }): Promise<IMailDeliveryStatus | null>;
}

export function normalizeRecipient(recipient: string): string {
  const normalized = recipient.trim().toLowerCase();
  if (!/^[^\s@\r\n]+@[^\s@\r\n]+\.[^\s@\r\n]+$/.test(normalized)) {
    throw new MailProviderError(
      'invalid_recipient',
      'Mail recipient is invalid',
      'permanent',
    );
  }
  return normalized;
}

export function sanitizeTemplateVariables(
  variables: Readonly<Record<string, string>>,
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(variables)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) {
      throw new MailProviderError(
        'invalid_template_variable',
        'Mail template variable name is invalid',
        'permanent',
      );
    }
    if (typeof value !== 'string' || value.length > 512) {
      throw new MailProviderError(
        'invalid_template_variable',
        'Mail template variable value is invalid',
        'permanent',
      );
    }
    if (/[\r\n]/.test(value)) {
      throw new MailProviderError(
        'invalid_template_variable',
        'Mail template variable contains a line break',
        'permanent',
      );
    }
    sanitized[key] = value;
  }
  return sanitized;
}

export function sanitizeGameName(name: string | null | undefined): string {
  if (!name) return '';
  return [...name.replace(/[\r\n]/g, ' ').trim()].slice(0, 50).join('');
}

export function isMailTemplateKey(value: string): value is TMailTemplateKey {
  return (MAIL_TEMPLATE_KEYS as readonly string[]).includes(value);
}
