import {
  normalizeUserLanguage,
  type TUserLanguage,
} from '@board-platform/contracts/types/protocol/userLanguage';

export type TSupportedLanguage = TUserLanguage;

export function normalizeLanguage(
  rawLanguage: string | undefined,
): TSupportedLanguage {
  return normalizeUserLanguage(rawLanguage);
}

export function parseFloatOrDefault(
  raw: string | null,
  fallback: number,
): number {
  if (raw === null) return fallback;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
}
