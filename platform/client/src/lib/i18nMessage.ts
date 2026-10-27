import type { TMessageText } from '@board-platform/contracts';
import type { TFunction } from 'i18next';

export function resolvePlatformMessageText(
  t: TFunction<'common'>,
  raw: unknown,
): string {
  if (typeof raw !== 'string') {
    if (isRecord(raw) && raw.kind === 'literal' && typeof raw.text === 'string')
      return raw.text;
    if (
      isRecord(raw) &&
      raw.kind === 'i18n' &&
      typeof raw.key === 'string' &&
      typeof raw.fallback === 'string'
    ) {
      return t(raw.key, {
        ...(isRecord(raw.values) ? raw.values : {}),
        defaultValue: raw.fallback,
        ns: 'common',
      }) as unknown as string;
    }
    return '';
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && typeof parsed.key === 'string') {
      const { key, ...params } = parsed;
      return t(key, {
        ...params,
        defaultValue: raw,
        ns: 'common',
      }) as unknown as string;
    }
  } catch {
    // A literal string is the normal fallback for legacy messages.
  }

  const translated = t(raw, {
    defaultValue: raw,
    ns: 'common',
  }) as unknown as string;
  return translated === raw ? raw : translated;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export type { TMessageText };
