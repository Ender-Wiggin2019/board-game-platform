import { describe, expect, it, vi } from 'vitest';
import {
  MailProviderError,
  type TMailTemplateKey,
} from '@/mail/mail-provider.js';
import {
  type ITencentSesConfig,
  loadTencentSesConfig,
  TencentSesProvider,
} from '@/mail/tencent-ses.provider.js';

const config: ITencentSesConfig = {
  region: 'ap-guangzhou',
  secretId: 'secret-id',
  secretKey: 'secret-key',
  fromEmailAddress: 'noreply@notify.example.com',
  templateIds: Object.fromEntries(
    ['reset_password', 'email_change_verify', 'turn_reminder'].map(
      (key, index) => [key, index + 1],
    ),
  ) as Record<TMailTemplateKey, number>,
};

describe('TencentSesProvider', () => {
  it('requires only the three enabled email templates', () => {
    expect(
      loadTencentSesConfig({
        SETI_SES_SECRET_ID: 'secret-id',
        SETI_SES_SECRET_KEY: 'secret-key',
        SETI_SES_FROM_EMAIL: 'noreply@notify.example.com',
        SETI_SES_TEMPLATE_RESET_PASSWORD: '1',
        SETI_SES_TEMPLATE_EMAIL_CHANGE_VERIFY: '2',
        SETI_SES_TEMPLATE_TURN_REMINDER: '3',
      }),
    ).toMatchObject({
      templateIds: {
        reset_password: 1,
        email_change_verify: 2,
        turn_reminder: 3,
      },
    });
  });

  it('rejects the removed Tencent credential aliases', () => {
    expect(() =>
      loadTencentSesConfig({
        TENCENTCLOUD_SECRET_ID: 'legacy-id',
        TENCENTCLOUD_SECRET_KEY: 'legacy-key',
        SETI_SES_FROM_EMAIL: 'noreply@notify.example.com',
        SETI_SES_TEMPLATE_RESET_PASSWORD: '1',
        SETI_SES_TEMPLATE_EMAIL_CHANGE_VERIFY: '2',
        SETI_SES_TEMPLATE_TURN_REMINDER: '3',
      }),
    ).toThrow(/SETI_SES_SECRET_ID/);
  });

  it('sends one recipient through the official template API shape', async () => {
    const sendEmail = vi.fn().mockResolvedValue({
      MessageId: 'message-1',
      RequestId: 'request-1',
    });
    const provider = new TencentSesProvider(config, {
      SendEmail: sendEmail,
      GetSendEmailStatus: vi.fn(),
    });

    await expect(
      provider.sendTemplate({
        recipient: 'User@Example.com',
        templateKey: 'email_change_verify',
        variables: { code: '123456' },
        internalJobId: 'job-1',
      }),
    ).resolves.toMatchObject({
      provider: 'tencent-ses',
      status: 'accepted',
      messageId: 'message-1',
      requestId: 'request-1',
    });
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        Destination: ['user@example.com'],
        Template: { TemplateID: 2, TemplateData: '{"code":"123456"}' },
        SmtpMessageId: 'seti-job-1',
      }),
    );
  });

  it('preserves the turn channel as a notification trigger', async () => {
    const sendEmail = vi.fn().mockResolvedValue({
      MessageId: 'message-turn',
      RequestId: 'request-turn',
    });
    const provider = new TencentSesProvider(config, {
      SendEmail: sendEmail,
      GetSendEmailStatus: vi.fn(),
    });

    await provider.sendTemplate({
      recipient: 'user@example.com',
      templateKey: 'turn_reminder',
      variables: {},
      internalJobId: 'job-turn',
      channel: 'turn_reminder',
    });

    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ TriggerType: 0 }),
    );
  });

  it('classifies provider throttling and blacklisting without leaking details', async () => {
    const throttled = new TencentSesProvider(config, {
      SendEmail: vi.fn().mockRejectedValue({
        code: 'RequestLimitExceeded',
        message: 'secret key should never be persisted',
      }),
      GetSendEmailStatus: vi.fn(),
    });
    await expect(
      throttled.sendTemplate({
        recipient: 'user@example.com',
        templateKey: 'email_change_verify',
        variables: {},
        internalJobId: 'job-2',
      }),
    ).rejects.toMatchObject({
      code: 'ses_temporary_failure',
      disposition: 'retryable',
    } satisfies Partial<MailProviderError>);

    const blacklisted = new TencentSesProvider(config, {
      SendEmail: vi.fn().mockRejectedValue({ code: 'BlackList', message: 'x' }),
      GetSendEmailStatus: vi.fn(),
    });
    await expect(
      blacklisted.sendTemplate({
        recipient: 'user@example.com',
        templateKey: 'email_change_verify',
        variables: {},
        internalJobId: 'job-3',
      }),
    ).rejects.toMatchObject({
      code: 'recipient_suppressed',
      disposition: 'suppressed',
    });
  });

  it('maps Tencent delivery status and supports status reconciliation', async () => {
    const getStatus = vi.fn().mockResolvedValue({
      RequestId: 'request-2',
      EmailStatusList: [
        {
          MessageId: 'message-1',
          ToEmailAddress: 'user@example.com',
          SendStatus: 0,
          DeliverStatus: 1,
        },
      ],
    });
    const provider = new TencentSesProvider(config, {
      SendEmail: vi.fn(),
      GetSendEmailStatus: getStatus,
    });
    await expect(
      provider.getSendEmailStatus({
        messageId: 'message-1',
        recipient: 'user@example.com',
        requestDate: new Date('2026-09-23T12:00:00Z'),
      }),
    ).resolves.toEqual({
      messageId: 'message-1',
      recipient: 'user@example.com',
      deliveryStatus: 'delivered',
    });
    expect(getStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        MessageId: 'message-1',
        RequestDate: '2026-09-23',
        ToEmailAddress: 'user@example.com',
      }),
    );
  });
});
