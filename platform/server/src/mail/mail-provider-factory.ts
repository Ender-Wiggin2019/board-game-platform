import type { MailProvider } from './mail-provider.js';
import { ResendProvider } from './resend.provider.js';
import { TencentSesProvider } from './tencent-ses.provider.js';

export function createMailProvider(): MailProvider {
  const name = process.env.MAIL_PROVIDER?.trim().toLowerCase() || 'tencent-ses';
  if (name === 'resend') return new ResendProvider();
  if (name === 'tencent-ses') return new TencentSesProvider();
  throw new Error(`Unsupported MAIL_PROVIDER: ${name}`);
}
