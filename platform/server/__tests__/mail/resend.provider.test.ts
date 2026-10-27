import { describe, expect, it, vi } from 'vitest';
import type { IMailTemplateInput } from '@/mail/mail-provider.js';
import {
  createResendSmtpTransport,
  type IResendConfig,
  type IResendSmtpTransport,
  loadResendConfig,
  ResendProvider,
} from '@/mail/resend.provider.js';

const { createTransportMock } = vi.hoisted(() => ({
  createTransportMock: vi.fn(),
}));

vi.mock('nodemailer', () => ({
  default: { createTransport: createTransportMock },
}));

const config: IResendConfig = {
  apiKey: 're_send_test',
  statusApiKey: 're_status_test',
  fromEmailAddress: 'noreply@mail.ender-wiggin.com',
  publicOrigin: 'https://game.ender-wiggin.com:8443',
  transport: 'api',
};

function input(
  overrides: Partial<IMailTemplateInput> = {},
): IMailTemplateInput {
  return {
    recipient: 'User@Example.com',
    templateKey: 'email_change_verify',
    variables: { code: '123456' },
    internalJobId: 'job-1',
    ...overrides,
  };
}

describe('ResendProvider', () => {
  it('defaults to the HTTP API and accepts the bounded Resend SMTP settings', () => {
    expect(
      loadResendConfig({
        SETI_RESEND_API_KEY: 're_send_test',
        SETI_RESEND_FROM_EMAIL: 'noreply@mail.ender-wiggin.com',
      }),
    ).toMatchObject({ transport: 'api' });
    expect(
      loadResendConfig({
        SETI_RESEND_API_KEY: 're_send_test',
        SETI_RESEND_FROM_EMAIL: 'noreply@mail.ender-wiggin.com',
        SETI_RESEND_TRANSPORT: 'smtp',
      }),
    ).toMatchObject({ transport: 'smtp' });
  });

  it('rejects SMTP status reconciliation before any API key is used for status calls', () => {
    expect(() =>
      loadResendConfig({
        SETI_RESEND_API_KEY: 're_send_test',
        SETI_RESEND_FROM_EMAIL: 'noreply@mail.ender-wiggin.com',
        SETI_RESEND_TRANSPORT: 'smtp',
        SETI_MAIL_STATUS_RECONCILER_ENABLED: 'true',
      }),
    ).toThrow('does not support status reconciliation');
  });

  it('creates the official TLS SMTP transport with bounded timeouts', () => {
    const smtp = { sendMail: vi.fn() };
    createTransportMock.mockReturnValueOnce(smtp);

    expect(createResendSmtpTransport('re_secret_test')).toBe(smtp);
    expect(createTransportMock).toHaveBeenCalledWith({
      host: 'smtp.resend.com',
      port: 465,
      secure: true,
      auth: { user: 'resend', pass: 're_secret_test' },
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    });
  });

  it('requires a separate status credential when reconciliation is enabled', () => {
    expect(() =>
      loadResendConfig({
        SETI_RESEND_API_KEY: 're_send_test',
        SETI_RESEND_FROM_EMAIL: 'noreply@mail.ender-wiggin.com',
        SETI_MAIL_STATUS_RECONCILER_ENABLED: 'true',
      }),
    ).toThrow('SETI_RESEND_STATUS_API_KEY');
  });

  it('sends one recipient with a stable idempotency key and safe template content', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ id: 'email-1' }), {
          status: 200,
          headers: { 'x-request-id': 'request-1' },
        }),
      ),
    );
    const provider = new ResendProvider(config, fetchMock);
    const job = input({
      templateKey: 'turn_reminder',
      variables: {
        gameName: '<SETI & friends>',
        actionUrl: 'https://game.ender-wiggin.com:8443/game/1',
        unsubscribeUrl:
          'https://game.ender-wiggin.com:8443/mail/unsubscribe?token=x',
      },
    });

    await expect(provider.sendTemplate(job)).resolves.toEqual({
      provider: 'resend',
      status: 'accepted',
      messageId: 'email-1',
      requestId: 'request-1',
    });
    const [endpoint, request] = fetchMock.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(endpoint).toBe('https://api.resend.com/emails');
    expect(request.method).toBe('POST');
    const payload = JSON.parse(request.body as string);
    expect(payload.to).toEqual(['user@example.com']);
    expect(payload.from).toBe(
      'Board Game Utopia <noreply@mail.ender-wiggin.com>',
    );
    expect(payload.html).toContain('&lt;SETI &amp; friends&gt;');
    expect(payload.html).not.toContain('<SETI & friends>');
    expect(payload.html).toContain(
      '<a href="https://game.ender-wiggin.com:8443/game/1">',
    );
    expect(payload.text).toContain('退订回合提醒');
    const firstKey = (request.headers as Record<string, string>)[
      'Idempotency-Key'
    ];
    await provider.sendTemplate(job);
    expect(
      (fetchMock.mock.calls[1][1].headers as Record<string, string>)[
        'Idempotency-Key'
      ],
    ).toBe(firstKey);
  });

  const englishMails: Array<{
    templateKey: IMailTemplateInput['templateKey'];
    variables: Readonly<Record<string, string>>;
    subject: string;
    text: string;
  }> = [
    {
      templateKey: 'email_change_verify',
      variables: { code: '123456' },
      subject: 'Board Game Utopia new email verification code',
      text: 'You are changing the email address for your Board Game Utopia account.',
    },
    {
      templateKey: 'reset_password',
      variables: { token: 'id.secret+part' },
      subject: 'Reset your Board Game Utopia account password',
      text: 'Use the following link to reset your password;',
    },
    {
      templateKey: 'turn_reminder',
      variables: {
        gameName: 'SETI',
        actionUrl: 'https://game.ender-wiggin.com:8443/game/1',
      },
      subject: 'Board Game Utopia: Your turn',
      text: 'You have a game waiting for your action: SETI',
    },
  ];

  it.each(englishMails)(
    'renders $templateKey in the account language',
    async (mail) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ id: 'email-en' }), { status: 200 }),
        );
      await new ResendProvider(config, fetchMock).sendTemplate(
        input({ ...mail, language: 'en' }),
      );

      const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(payload.subject).toBe(mail.subject);
      expect(payload.text).toContain(mail.text);
      expect(payload.text).not.toMatch(/[你请验证码轮到重置]/u);
    },
  );

  it('uses the configured origin for password recovery links', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: 'email-2' }), { status: 200 }),
      );
    await new ResendProvider(config, fetchMock).sendTemplate(
      input({
        templateKey: 'reset_password',
        variables: { token: 'id.secret+part' },
      }),
    );
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.text).toContain(
      'https://game.ender-wiggin.com:8443/auth/password/reset?token=id.secret%2Bpart',
    );
    expect(payload.html).toContain(
      '<a href="https://game.ender-wiggin.com:8443/auth/password/reset?token=id.secret%2Bpart">',
    );
  });

  it('rejects cross-origin action links before sending', async () => {
    const fetchMock = vi.fn();
    const provider = new ResendProvider(config, fetchMock);
    await expect(
      provider.sendTemplate(
        input({
          templateKey: 'turn_reminder',
          variables: {
            gameName: 'SETI',
            actionUrl: 'https://other.example.com/game/1',
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: 'invalid_template_url',
      disposition: 'permanent',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps provider events and keeps the status credential separate', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'email-3',
          to: ['user@example.com'],
          last_event: 'complained',
        }),
        { status: 200 },
      ),
    );
    const provider = new ResendProvider(config, fetchMock);
    await expect(
      provider.getSendEmailStatus({ messageId: 'email-3' }),
    ).resolves.toEqual({
      messageId: 'email-3',
      recipient: 'user@example.com',
      deliveryStatus: 'complained',
      detail: 'complained',
    });
    expect(fetchMock.mock.calls[0][1].headers).toEqual({
      Authorization: 'Bearer re_status_test',
    });
  });

  it('classifies throttling, permission errors, and uncertain sends safely', async () => {
    const throttled = new ResendProvider(
      config,
      vi.fn().mockResolvedValue(new Response('{}', { status: 429 })),
    );
    await expect(throttled.sendTemplate(input())).rejects.toMatchObject({
      code: 'resend_temporary_failure',
      disposition: 'retryable',
    });

    const denied = new ResendProvider(
      config,
      vi.fn().mockResolvedValue(new Response('{}', { status: 403 })),
    );
    await expect(denied.sendTemplate(input())).rejects.toMatchObject({
      code: 'resend_permission_denied',
      disposition: 'configuration',
    });

    const uncertain = new ResendProvider(
      config,
      vi.fn().mockRejectedValue(new Error('secret transport detail')),
    );
    await expect(uncertain.sendTemplate(input())).rejects.toMatchObject({
      code: 'resend_send_unknown',
      disposition: 'unknown',
    });
  });

  it('sends the same rendered template through SMTP and returns an audit message id', async () => {
    const sendMail = vi.fn().mockResolvedValue({
      messageId: '<smtp-message-1@example.invalid>',
      accepted: ['user@example.com'],
      rejected: [],
    });
    const smtp: IResendSmtpTransport = { sendMail };
    const provider = new ResendProvider(
      { ...config, transport: 'smtp' },
      fetch,
      smtp,
    );

    await expect(
      provider.sendTemplate(
        input({
          templateKey: 'turn_reminder',
          variables: {
            gameName: '<SETI & friends>',
            actionUrl: 'https://game.ender-wiggin.com:8443/game/1',
          },
        }),
      ),
    ).resolves.toEqual({
      provider: 'resend',
      status: 'accepted',
      messageId: '<smtp-message-1@example.invalid>',
      requestId: null,
    });
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'Board Game Utopia <noreply@mail.ender-wiggin.com>',
        to: 'user@example.com',
        subject: 'Board Game Utopia：轮到你行动',
        text: expect.stringContaining('SETI & friends'),
        html: expect.stringContaining('&lt;SETI &amp; friends&gt;'),
        messageId: expect.stringMatching(
          /^<seti-[a-f0-9]{64}@smtp\.resend\.local>$/,
        ),
      }),
    );
  });

  it('persists SMTP transport failures as unknown without exposing the API key', async () => {
    const apiKey = 're_secret_should_not_escape';
    const sendMail = vi
      .fn()
      .mockRejectedValue(new Error(`socket closed for ${apiKey}`));
    const provider = new ResendProvider(
      { ...config, apiKey, transport: 'smtp' },
      fetch,
      { sendMail },
    );

    const error = await provider.sendTemplate(input()).catch((value) => value);
    expect(error).toMatchObject({
      code: 'resend_smtp_send_unknown',
      disposition: 'unknown',
      message: 'Resend SMTP send outcome is unknown',
    });
    expect(error.message).not.toContain(apiKey);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it('does not mark SMTP as accepted when Nodemailer reports no accepted recipient', async () => {
    const sendMail = vi.fn().mockResolvedValue({
      messageId: '<smtp-message-2@example.invalid>',
      accepted: [],
      rejected: [],
    });
    const provider = new ResendProvider(
      { ...config, transport: 'smtp' },
      fetch,
      { sendMail },
    );

    await expect(provider.sendTemplate(input())).rejects.toMatchObject({
      code: 'resend_smtp_acceptance_unknown',
      disposition: 'unknown',
    });
  });

  it('records an explicit SMTP recipient rejection as terminal', async () => {
    const sendMail = vi.fn().mockResolvedValue({
      messageId: '<smtp-message-3@example.invalid>',
      accepted: [],
      rejected: ['user@example.com'],
    });
    const provider = new ResendProvider(
      { ...config, transport: 'smtp' },
      fetch,
      { sendMail },
    );

    await expect(provider.sendTemplate(input())).rejects.toMatchObject({
      code: 'resend_smtp_recipient_rejected',
      disposition: 'permanent',
    });
  });

  it('does not treat an SMTP MIME message id as a Resend API status id', async () => {
    const fetchMock = vi.fn();
    const provider = new ResendProvider(
      { ...config, transport: 'smtp' },
      fetchMock,
      { sendMail: vi.fn() },
    );

    await expect(
      provider.getSendEmailStatus({ messageId: '<smtp-message-1>' }),
    ).rejects.toMatchObject({
      code: 'resend_smtp_status_unsupported',
      disposition: 'configuration',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
