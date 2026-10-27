export const SUPPORTED_USER_LANGUAGES = ['zh-CN', 'en'] as const;

export type TUserLanguage = (typeof SUPPORTED_USER_LANGUAGES)[number];

export const DEFAULT_USER_LANGUAGE: TUserLanguage = 'zh-CN';

export function isUserLanguage(value: unknown): value is TUserLanguage {
  return SUPPORTED_USER_LANGUAGES.includes(value as TUserLanguage);
}

export function normalizeUserLanguage(value: unknown): TUserLanguage {
  if (typeof value !== 'string') return DEFAULT_USER_LANGUAGE;
  const normalized = value.toLowerCase();
  if (/^en(?:-[a-z0-9]+)*$/.test(normalized)) return 'en';
  return DEFAULT_USER_LANGUAGE;
}
