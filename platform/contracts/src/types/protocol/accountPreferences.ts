import type { TUserLanguage } from './userLanguage.js';

export interface IAccountEmailQuietHours {
  start: string;
  end: string;
  timezone: string;
}

/** Preferences owned by the account service regardless of the installed game. */
export interface IAccountPreferences {
  language?: TUserLanguage;
  showNavigatorIdentity?: boolean;
  pushNotificationsEnabled?: boolean;
  emailTurnRemindersEnabled?: boolean;
  emailQuietHours?: IAccountEmailQuietHours | null;
}

export type TAccountPreferencesPatch = Partial<IAccountPreferences>;

export function isEmailQuietHours(
  value: unknown,
): value is IAccountEmailQuietHours {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) => !['start', 'end', 'timezone'].includes(key),
    )
  ) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const clock = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
  if (
    typeof candidate.start !== 'string' ||
    typeof candidate.end !== 'string' ||
    !clock.test(candidate.start) ||
    !clock.test(candidate.end) ||
    candidate.start === candidate.end ||
    typeof candidate.timezone !== 'string' ||
    candidate.timezone.length < 1 ||
    candidate.timezone.length > 64
  ) {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate.timezone });
    return true;
  } catch {
    return false;
  }
}
