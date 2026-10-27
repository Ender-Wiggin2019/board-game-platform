import type { TUserLanguage } from '@board-platform/contracts/types/protocol/userLanguage';
import i18n from '../i18n.js';
import { normalizeLanguage } from './normalizers.js';

let desiredLanguage: TUserLanguage | null = null;
let applying: Promise<void> | null = null;

export function getInterfaceLanguage(): TUserLanguage {
  return (
    desiredLanguage ?? normalizeLanguage(i18n.resolvedLanguage ?? i18n.language)
  );
}

/**
 * Applies the most recently requested interface language. i18next applies
 * overlapping language loads in the order they finish, so every caller goes
 * through this queue and the latest request wins over an older, slower load.
 * The returned promise settles once no request is left to apply.
 */
export function requestInterfaceLanguage(
  language: TUserLanguage,
): Promise<void> {
  desiredLanguage = language;
  applying ??= (async () => {
    try {
      while (desiredLanguage !== null) {
        const target: TUserLanguage = desiredLanguage;
        await i18n.changeLanguage(target);
        if (target === desiredLanguage) desiredLanguage = null;
      }
    } finally {
      applying = null;
    }
  })();
  return applying;
}
