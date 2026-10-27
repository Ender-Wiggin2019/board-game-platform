import {
  isUserLanguage,
  type TUserLanguage,
} from '@board-platform/contracts/types/protocol/userLanguage';

/**
 * The language a signed-out visitor last chose on this device. The app starts
 * in it; once an account is signed in, the account language still decides.
 */
const DEVICE_LANGUAGE_KEY = 'seti-ui-language';

export function readDeviceLanguage(): TUserLanguage | null {
  try {
    const stored = window.localStorage.getItem(DEVICE_LANGUAGE_KEY);
    return isUserLanguage(stored) ? stored : null;
  } catch {
    return null;
  }
}

export function rememberDeviceLanguage(language: string): void {
  if (!isUserLanguage(language)) return;
  try {
    window.localStorage.setItem(DEVICE_LANGUAGE_KEY, language);
  } catch {
    // Without storage the switch still applies to the current page session.
  }
}
