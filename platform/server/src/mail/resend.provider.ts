import { createHash } from 'node:crypto';
import { normalizeUserLanguage } from '@board-platform/contracts/types/protocol/userLanguage';
import { Injectable } from '@nestjs/common';
import nodemailer from 'nodemailer';
import { getRuntimeConfig } from '@/config/runtimeConfig.js';
import {
  type IMailAcceptedResult,
  type IMailDeliveryStatus,
  type IMailTemplateInput,
  isMailTemplateKey,
  type MailProvider,
  MailProviderError,
  normalizeRecipient,
  sanitizeTemplateVariables,
} from './mail-provider.js';

const RESEND_API = 'https://api.resend.com';
const RESEND_SMTP_HOST = 'smtp.resend.com';
const RESEND_SMTP_PORT = 465;
const RESEND_SMTP_USER = 'resend';
const RESEND_SMTP_CONNECTION_TIMEOUT_MS = 15_000;
const RESEND_SMTP_GREETING_TIMEOUT_MS = 15_000;
const RESEND_SMTP_SOCKET_TIMEOUT_MS = 30_000;

export type TResendTransport = 'api' | 'smtp';

export interface IResendSmtpMessageInfo {
  messageId?: unknown;
  accepted?: unknown;
  rejected?: unknown;
}

export interface IResendSmtpTransport {
  sendMail(options: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html: string;
    messageId: string;
  }): Promise<IResendSmtpMessageInfo>;
}

export interface IResendConfig {
  apiKey: string;
  statusApiKey: string;
  fromEmailAddress: string;
  publicOrigin: string;
  /** Defaults to the Resend HTTP API for backwards compatibility. */
  transport?: TResendTransport;
}

export function loadResendConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): IResendConfig | undefined {
  const apiKey = env.SETI_RESEND_API_KEY?.trim();
  const fromEmailAddress = env.SETI_RESEND_FROM_EMAIL?.trim();
  if (!apiKey && !fromEmailAddress) return undefined;
  if (!apiKey || !fromEmailAddress) {
    throw new Error(
      'Resend configuration requires SETI_RESEND_API_KEY and SETI_RESEND_FROM_EMAIL',
    );
  }
  const transport = (env.SETI_RESEND_TRANSPORT?.trim().toLowerCase() ||
    'api') as string;
  if (transport !== 'api' && transport !== 'smtp') {
    throw new Error('SETI_RESEND_TRANSPORT must be either api or smtp');
  }
  if (
    transport === 'smtp' &&
    env.SETI_MAIL_STATUS_RECONCILER_ENABLED === 'true'
  ) {
    throw new Error(
      'Resend SMTP transport does not support status reconciliation; disable SETI_MAIL_STATUS_RECONCILER_ENABLED',
    );
  }
  const statusApiKey = env.SETI_RESEND_STATUS_API_KEY?.trim();
  if (env.SETI_MAIL_STATUS_RECONCILER_ENABLED === 'true' && !statusApiKey) {
    throw new Error(
      'Resend status reconciliation requires SETI_RESEND_STATUS_API_KEY',
    );
  }
  const normalizedFrom = normalizeRecipient(fromEmailAddress);
  const publicOrigin = getRuntimeConfig().server.publicOrigin;
  return {
    apiKey,
    statusApiKey: statusApiKey || apiKey,
    fromEmailAddress: normalizedFrom,
    publicOrigin,
    transport: transport as TResendTransport,
  };
}

/**
 * Creates the bounded TLS transport documented by Resend for SMTP submission.
 * The API key is only handed to Nodemailer as the password and is never part
 * of an error or message value.
 */
export function createResendSmtpTransport(
  apiKey: string,
): IResendSmtpTransport {
  return nodemailer.createTransport({
    host: RESEND_SMTP_HOST,
    port: RESEND_SMTP_PORT,
    secure: true,
    auth: {
      user: RESEND_SMTP_USER,
      pass: apiKey,
    },
    connectionTimeout: RESEND_SMTP_CONNECTION_TIMEOUT_MS,
    greetingTimeout: RESEND_SMTP_GREETING_TIMEOUT_MS,
    socketTimeout: RESEND_SMTP_SOCKET_TIMEOUT_MS,
  }) as unknown as IResendSmtpTransport;
}

@Injectable()
export class ResendProvider implements MailProvider {
  public readonly provider = 'resend' as const;
  private readonly smtpTransport: IResendSmtpTransport | undefined;

  public constructor(
    private readonly config: IResendConfig | undefined = loadResendConfig(),
    private readonly fetchImpl: typeof fetch = fetch,
    smtpTransport?: IResendSmtpTransport,
  ) {
    this.smtpTransport =
      this.config?.transport === 'smtp'
        ? (smtpTransport ?? createResendSmtpTransport(this.config.apiKey))
        : undefined;
  }

  public isConfigured(): boolean {
    return (
      this.config !== undefined &&
      (this.config.transport !== 'smtp' || this.smtpTransport !== undefined)
    );
  }

  public async sendTemplate(
    input: IMailTemplateInput,
  ): Promise<IMailAcceptedResult> {
    if (!this.config) throw notConfigured();
    if (!isMailTemplateKey(input.templateKey)) {
      throw new MailProviderError(
        'invalid_template_key',
        'Mail template key is invalid',
        'permanent',
      );
    }
    const recipient = normalizeRecipient(input.recipient);
    const variables = sanitizeTemplateVariables(input.variables);
    const content = renderMail(
      input.templateKey,
      variables,
      this.config.publicOrigin,
      input.language,
    );
    if (this.config.transport === 'smtp') {
      return this.sendSmtpTemplate(input, recipient, content);
    }
    const body = {
      from: `Board Game Utopia <${this.config.fromEmailAddress}>`,
      to: [recipient],
      subject: content.subject,
      html: content.html,
      text: content.text,
    };
    // Resend deduplicates identical requests for 24 hours. A content digest
    // keeps retries stable while allowing a changed turn summary to be sent.
    const digest = createHash('sha256')
      .update(JSON.stringify(body))
      .digest('hex')
      .slice(0, 20);
    try {
      const response = await this.fetchImpl(`${RESEND_API}/emails`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': `seti-${input.internalJobId}-${digest}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw classifyResponse(response.status, 'send');
      const result = (await response.json()) as { id?: unknown };
      if (typeof result.id !== 'string' || !result.id) {
        throw new MailProviderError(
          'resend_missing_email_id',
          'Resend returned no email identifier',
          'unknown',
        );
      }
      return {
        provider: 'resend',
        status: 'accepted',
        messageId: result.id,
        requestId:
          response.headers.get('x-request-id') ??
          response.headers.get('x-resend-request-id'),
      };
    } catch (error) {
      if (error instanceof MailProviderError) throw error;
      throw new MailProviderError(
        'resend_send_unknown',
        'Resend send outcome is unknown',
        'unknown',
        { cause: error },
      );
    }
  }

  public async getSendEmailStatus(input: {
    messageId: string;
    recipient?: string;
    requestDate?: Date;
  }): Promise<IMailDeliveryStatus | null> {
    if (!this.config) throw notConfigured();
    if (this.config.transport === 'smtp') {
      throw new MailProviderError(
        'resend_smtp_status_unsupported',
        'Resend SMTP transport does not support API status reconciliation',
        'configuration',
      );
    }
    try {
      const response = await this.fetchImpl(
        `${RESEND_API}/emails/${encodeURIComponent(input.messageId)}`,
        {
          headers: { Authorization: `Bearer ${this.config.statusApiKey}` },
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (response.status === 404) return null;
      if (!response.ok) throw classifyResponse(response.status, 'status');
      const result = (await response.json()) as {
        id?: unknown;
        to?: unknown;
        last_event?: unknown;
      };
      if (result.id !== input.messageId) {
        throw new MailProviderError(
          'resend_status_mismatch',
          'Resend returned a different email identifier',
          'unknown',
        );
      }
      const event =
        typeof result.last_event === 'string' ? result.last_event : '';
      const deliveryStatus =
        event === 'complained'
          ? 'complained'
          : event === 'bounced' || event === 'suppressed' || event === 'failed'
            ? 'bounced'
            : event === 'delivered' || event === 'opened' || event === 'clicked'
              ? 'delivered'
              : 'unknown';
      const recipient =
        Array.isArray(result.to) && typeof result.to[0] === 'string'
          ? result.to[0]
          : (input.recipient ?? '');
      return {
        messageId: input.messageId,
        recipient,
        deliveryStatus,
        ...(event ? { detail: event } : {}),
      };
    } catch (error) {
      if (error instanceof MailProviderError) throw error;
      throw new MailProviderError(
        'resend_status_temporary_failure',
        'Resend status request failed',
        'retryable',
        { cause: error },
      );
    }
  }

  private async sendSmtpTemplate(
    input: IMailTemplateInput,
    recipient: string,
    content: IRenderedMail,
  ): Promise<IMailAcceptedResult> {
    if (!this.smtpTransport) {
      throw new MailProviderError(
        'resend_smtp_not_configured',
        'Resend SMTP transport is not configured',
        'configuration',
      );
    }
    // This is a MIME Message-ID for SMTP auditability. It is deliberately not
    // used as a Resend API email ID because SMTP does not expose one here.
    const messageId = createSmtpMessageId(input.internalJobId, content);
    try {
      const result = await this.smtpTransport.sendMail({
        from: `Board Game Utopia <${this.config?.fromEmailAddress ?? ''}>`,
        to: recipient,
        subject: content.subject,
        html: content.html,
        text: content.text,
        messageId,
      });
      const accepted = stringList(result.accepted);
      const rejected = stringList(result.rejected);
      const recipientAccepted = accepted?.some((address) =>
        sameRecipient(address, recipient),
      );
      const recipientRejected = rejected?.some((address) =>
        sameRecipient(address, recipient),
      );
      if (recipientRejected && !recipientAccepted) {
        throw new MailProviderError(
          'resend_smtp_recipient_rejected',
          'Resend SMTP rejected the recipient',
          'permanent',
        );
      }
      if (recipientAccepted !== true || recipientRejected === true) {
        throw new MailProviderError(
          'resend_smtp_acceptance_unknown',
          'Resend SMTP did not confirm recipient acceptance',
          'unknown',
        );
      }
      return {
        provider: 'resend',
        status: 'accepted',
        messageId:
          typeof result.messageId === 'string' && result.messageId
            ? result.messageId
            : messageId,
        requestId: null,
      };
    } catch (error) {
      // SMTP can fail after DATA has reached the provider. Retrying such an
      // error could send the same message twice, so every transport exception
      // is persisted as an unknown outcome by the outbox worker.
      if (error instanceof MailProviderError) throw error;
      throw new MailProviderError(
        'resend_smtp_send_unknown',
        'Resend SMTP send outcome is unknown',
        'unknown',
      );
    }
  }
}

function notConfigured(): MailProviderError {
  return new MailProviderError(
    'resend_not_configured',
    'Resend is not configured',
    'configuration',
  );
}

function classifyResponse(
  status: number,
  action: 'send' | 'status',
): MailProviderError {
  if (status === 401 || status === 403) {
    return new MailProviderError(
      'resend_permission_denied',
      `Resend ${action} credentials lack permission`,
      'configuration',
    );
  }
  if (status === 409 || status === 429 || status >= 500) {
    return new MailProviderError(
      'resend_temporary_failure',
      `Resend ${action} temporarily failed`,
      'retryable',
    );
  }
  return new MailProviderError(
    'resend_request_rejected',
    `Resend rejected the ${action} request`,
    status === 400 || status === 422 ? 'configuration' : 'permanent',
  );
}

interface IRenderedMail {
  subject: string;
  text: string;
  html: string;
}

function renderMail(
  key: IMailTemplateInput['templateKey'],
  variables: Record<string, string>,
  origin: string,
  language?: IMailTemplateInput['language'],
): IRenderedMail {
  const required = (name: string): string => {
    const value = variables[name];
    if (!value) {
      throw new MailProviderError(
        'missing_template_variable',
        `Mail template is missing ${name}`,
        'permanent',
      );
    }
    return value;
  };
  const url = (name: string): string => {
    const value = required(name);
    try {
      const parsed = new URL(value);
      if (parsed.origin === origin) return parsed.toString();
    } catch {
      // Report the same safe error for invalid and cross-origin URLs.
    }
    throw new MailProviderError(
      'invalid_template_url',
      'Mail template URL must use PUBLIC_ORIGIN',
      'permanent',
    );
  };
  const english = normalizeUserLanguage(language) === 'en';
  let subject: string;
  let lines: string[];
  switch (key) {
    case 'email_change_verify':
      subject = english
        ? 'Board Game Utopia new email verification code'
        : 'Board Game Utopia 新邮箱验证码';
      lines = english
        ? [
            `You are changing the email address for your Board Game Utopia account. Verification code: ${required('code')}`,
            'This code expires in 10 minutes. If you did not request this, ignore this email.',
          ]
        : [
            `你正在更换 Board Game Utopia 账号邮箱。验证码：${required('code')}`,
            '验证码有效期为 10 分钟。若非本人操作，请忽略本邮件。',
          ];
      break;
    case 'reset_password': {
      const link = new URL('/auth/password/reset', origin);
      link.searchParams.set('token', required('token'));
      subject = english
        ? 'Reset your Board Game Utopia account password'
        : '重置 Board Game Utopia 账号密码';
      lines = english
        ? [
            'Use the following link to reset your password; it is only for this request:',
            link.toString(),
            'If you did not request this, ignore this email.',
          ]
        : [
            '请通过以下链接重置密码；链接仅供本次请求使用：',
            link.toString(),
            '若非本人操作，请忽略本邮件。',
          ];
      break;
    }
    case 'turn_reminder':
      subject = english
        ? 'Board Game Utopia: Your turn'
        : 'Board Game Utopia：轮到你行动';
      lines = english
        ? [
            `You have a game waiting for your action: ${required('gameName')}`,
            url('actionUrl'),
            ...(variables.muteUrl ? [`Mute this game: ${url('muteUrl')}`] : []),
            ...(variables.unsubscribeUrl
              ? [`Unsubscribe from turn reminders: ${url('unsubscribeUrl')}`]
              : []),
          ]
        : [
            `你有待行动的对局：${required('gameName')}`,
            url('actionUrl'),
            ...(variables.muteUrl ? [`关闭本局提醒：${url('muteUrl')}`] : []),
            ...(variables.unsubscribeUrl
              ? [`退订回合提醒：${url('unsubscribeUrl')}`]
              : []),
          ];
      break;
  }
  return {
    subject,
    text: lines.join('\n\n'),
    html: `<div style="font-family:system-ui,sans-serif;line-height:1.6">${lines.map((line) => `<p>${line.startsWith('https://') ? `<a href="${escapeHtml(line)}">${escapeHtml(line)}</a>` : escapeHtml(line)}</p>`).join('')}</div>`,
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character];
  });
}

function createSmtpMessageId(
  internalJobId: string,
  content: IRenderedMail,
): string {
  const digest = createHash('sha256')
    .update(
      `${internalJobId}\0${content.subject}\0${content.text}\0${content.html}`,
    )
    .digest('hex');
  return `<seti-${digest}@smtp.resend.local>`;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function sameRecipient(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}
