import { Injectable } from '@nestjs/common';
import { v20201002 } from 'tencentcloud-sdk-nodejs-ses/tencentcloud/services/ses/v20201002/index.js';
import type {
  GetSendEmailStatusRequest,
  SendEmailRequest,
} from 'tencentcloud-sdk-nodejs-ses/tencentcloud/services/ses/v20201002/ses_models.js';
import {
  type IMailAcceptedResult,
  type IMailDeliveryStatus,
  type IMailTemplateInput,
  isMailTemplateKey,
  type MailProvider,
  MailProviderError,
  normalizeRecipient,
  sanitizeTemplateVariables,
  type TMailTemplateKey,
} from './mail-provider.js';

const SES_ENDPOINT = 'ses.tencentcloudapi.com';
const TEMPLATE_ENV_NAMES: Record<TMailTemplateKey, string> = {
  reset_password: 'SETI_SES_TEMPLATE_RESET_PASSWORD',
  email_change_verify: 'SETI_SES_TEMPLATE_EMAIL_CHANGE_VERIFY',
  turn_reminder: 'SETI_SES_TEMPLATE_TURN_REMINDER',
};

export interface ITencentSesConfig {
  region: string;
  secretId: string;
  secretKey: string;
  fromEmailAddress: string;
  templateIds: Readonly<Record<TMailTemplateKey, number>>;
}

interface ITencentSesClient {
  SendEmail(request: SendEmailRequest): Promise<{
    MessageId?: string;
    RequestId?: string;
  }>;
  GetSendEmailStatus(request: GetSendEmailStatusRequest): Promise<{
    EmailStatusList?: Array<{
      MessageId?: string;
      ToEmailAddress?: string;
      SendStatus?: number;
      DeliverStatus?: number;
      DeliverMessage?: string;
      UserComplained?: boolean;
      UserComplainted?: boolean;
    }>;
    RequestId?: string;
  }>;
}

export function loadTencentSesConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ITencentSesConfig | undefined {
  const secretId = optional(env.SETI_SES_SECRET_ID);
  const secretKey = optional(env.SETI_SES_SECRET_KEY);
  const fromEmailAddress = optional(env.SETI_SES_FROM_EMAIL);
  const region = optional(env.SETI_SES_REGION) ?? 'ap-guangzhou';
  if (!secretId && !secretKey && !fromEmailAddress) return undefined;
  if (!secretId || !secretKey || !fromEmailAddress) {
    throw new Error(
      'SES configuration requires SETI_SES_SECRET_ID, SETI_SES_SECRET_KEY, and SETI_SES_FROM_EMAIL',
    );
  }

  const templateIds = {} as Record<TMailTemplateKey, number>;
  for (const templateKey of [
    'reset_password',
    'email_change_verify',
    'turn_reminder',
  ] as const) {
    const raw = optional(env[TEMPLATE_ENV_NAMES[templateKey]]);
    if (!raw || !/^\d+$/.test(raw) || Number(raw) <= 0) {
      throw new Error(
        `${TEMPLATE_ENV_NAMES[templateKey]} must be a positive template id`,
      );
    }
    templateIds[templateKey] = Number(raw);
  }

  return { region, secretId, secretKey, fromEmailAddress, templateIds };
}

@Injectable()
export class TencentSesProvider implements MailProvider {
  public readonly provider = 'tencent-ses' as const;
  private readonly config: ITencentSesConfig | undefined;
  private readonly client: ITencentSesClient | undefined;

  public constructor(
    config: ITencentSesConfig | undefined = loadTencentSesConfig(),
    client?: ITencentSesClient,
  ) {
    this.config = config;
    this.client =
      client ??
      (config
        ? (new v20201002.Client({
            credential: {
              secretId: config.secretId,
              secretKey: config.secretKey,
            },
            region: config.region,
            profile: {
              signMethod: 'TC3-HMAC-SHA256',
              httpProfile: {
                protocol: 'https://',
                endpoint: SES_ENDPOINT,
                reqTimeout: 15,
              },
            },
          }) as unknown as ITencentSesClient)
        : undefined);
  }

  public isConfigured(): boolean {
    return this.config !== undefined && this.client !== undefined;
  }

  public async sendTemplate(
    input: IMailTemplateInput,
  ): Promise<IMailAcceptedResult> {
    if (!this.config || !this.client) {
      throw new MailProviderError(
        'ses_not_configured',
        'Tencent SES is not configured',
        'configuration',
      );
    }
    if (!isMailTemplateKey(input.templateKey)) {
      throw new MailProviderError(
        'invalid_template_key',
        'Mail template key is invalid',
        'permanent',
      );
    }

    const recipient = normalizeRecipient(input.recipient);
    const variables = sanitizeTemplateVariables(input.variables);
    const templateData = JSON.stringify(variables);
    if (Buffer.byteLength(templateData, 'utf8') > 800) {
      throw new MailProviderError(
        'template_data_too_large',
        'Mail template data is too large',
        'permanent',
      );
    }

    const request: SendEmailRequest = {
      FromEmailAddress: this.config.fromEmailAddress,
      Subject: '',
      // Each request intentionally has one destination. Tencent's API
      // displays every destination address in a group mail.
      Destination: [recipient],
      Template: {
        TemplateID: this.config.templateIds[input.templateKey],
        TemplateData: templateData,
      },
      TriggerType:
        input.channel === 'turn_reminder' || input.kind === 'notification'
          ? 0
          : 1,
      SmtpMessageId: `seti-${input.internalJobId}`,
    };

    try {
      const response = await this.client.SendEmail(request);
      if (!response.MessageId || !response.RequestId) {
        throw new MailProviderError(
          'ses_missing_acceptance_ids',
          'Tencent SES returned no acceptance identifiers',
          'unknown',
        );
      }
      return {
        provider: 'tencent-ses',
        status: 'accepted',
        messageId: response.MessageId,
        requestId: response.RequestId,
      };
    } catch (error) {
      if (error instanceof MailProviderError) throw error;
      throw classifyTencentError(error);
    }
  }

  public async getSendEmailStatus(input: {
    messageId: string;
    recipient?: string;
    requestDate?: Date;
  }): Promise<IMailDeliveryStatus | null> {
    if (!this.config || !this.client) {
      throw new MailProviderError(
        'ses_not_configured',
        'Tencent SES is not configured',
        'configuration',
      );
    }
    const request: GetSendEmailStatusRequest = {
      MessageId: input.messageId,
      RequestDate: formatUtcDate(input.requestDate ?? new Date()),
      Offset: 0,
      Limit: 100,
      ...(input.recipient
        ? { ToEmailAddress: normalizeRecipient(input.recipient) }
        : {}),
    };

    try {
      const response = await this.client.GetSendEmailStatus(request);
      const status = response.EmailStatusList?.find(
        (entry) => entry.MessageId === input.messageId,
      );
      if (!status) return null;
      const complained =
        status.UserComplained === true || status.UserComplainted === true;
      const deliveryStatus = complained
        ? 'complained'
        : status.DeliverStatus === 1
          ? 'delivered'
          : status.DeliverStatus === 2 || status.DeliverStatus === 3
            ? 'bounced'
            : 'unknown';
      return {
        messageId: status.MessageId ?? input.messageId,
        recipient: status.ToEmailAddress ?? input.recipient ?? '',
        deliveryStatus,
        ...(status.DeliverMessage ? { detail: status.DeliverMessage } : {}),
      };
    } catch (error) {
      throw classifyTencentError(error);
    }
  }
}

function classifyTencentError(error: unknown): MailProviderError {
  const value = error as {
    code?: unknown;
    message?: unknown;
    statusCode?: unknown;
  };
  const code = typeof value.code === 'string' ? value.code : 'ses_error';
  const message =
    typeof value.message === 'string'
      ? value.message
      : 'Tencent SES request failed';
  const normalized = `${code} ${message}`.toLowerCase();

  if (
    /blacklist|black.?listed|complaint|unsubscribe|3020|1007|1013/.test(
      normalized,
    )
  ) {
    return new MailProviderError(
      'recipient_suppressed',
      'Recipient is suppressed by SES',
      'suppressed',
    );
  }
  if (
    /template|domain|identity|permission|invalidparameter|3007|3009|3010|3014|3024/.test(
      normalized,
    )
  ) {
    return new MailProviderError(
      'ses_configuration',
      'Tencent SES rejected the mail configuration',
      'configuration',
    );
  }
  if (
    /timeout|timed out|econnreset|eai_again|network|throttl|rate.?limit|request.?limit|limit.?exceed|too many|5\d\d|1001|1002|1003|1004|1005|1006|1009|1010|3008|3030|3033/.test(
      normalized,
    )
  ) {
    return new MailProviderError(
      'ses_temporary_failure',
      'Tencent SES temporarily failed',
      'retryable',
    );
  }
  if (typeof value.statusCode === 'number' && value.statusCode >= 500) {
    return new MailProviderError(
      'ses_temporary_failure',
      'Tencent SES temporarily failed',
      'retryable',
    );
  }
  return new MailProviderError(
    'ses_unknown_failure',
    'Tencent SES outcome is unknown',
    'unknown',
  );
}

function formatUtcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function optional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}
