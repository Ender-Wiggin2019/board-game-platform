/**
 * Shared account identity rules.
 *
 * The platform owns only names that are reserved by the account service
 * itself. A game may add its own reserved names by passing a set to
 * normalizeAccountName; this keeps game identifiers out of the platform
 * package while retaining the old validation seam for adapters.
 */

export const ACCOUNT_NAME_MIN_CODE_POINTS = 2;
export const ACCOUNT_NAME_MAX_CODE_POINTS = 20;
export const ACCOUNT_PASSWORD_MIN_CODE_POINTS = 6;
export const ACCOUNT_PASSWORD_MAX_CODE_POINTS = 128;
export const ACCOUNT_EMAIL_MAX_LENGTH = 254;

/** Names which could be mistaken for an operator, service, or system account. */
export const RESERVED_ACCOUNT_NAME_KEYS = new Set([
  'admin',
  'administrator',
  'contact',
  'help',
  'moderator',
  'root',
  'support',
  'system',
  'official',
  '客服',
  '管理员',
  '系统',
]);

export type TAccountRuleCode =
  | 'INVALID_NAME'
  | 'NAME_LENGTH'
  | 'NAME_CHARACTERS'
  | 'NAME_RESERVED'
  | 'INVALID_EMAIL'
  | 'EMAIL_TOO_LONG'
  | 'PASSWORD_LENGTH'
  | 'PASSWORD_CONFIRM_MISMATCH';

export class AccountRuleError extends Error {
  public constructor(
    public readonly code: TAccountRuleCode,
    message: string,
  ) {
    super(message);
    this.name = 'AccountRuleError';
  }
}

export interface INormalizedAccountName {
  /** NFKC-normalised and trimmed display name. */
  name: string;
  /** Lower-cased ASCII letters from name; all other characters are kept. */
  nameKey: string;
}

export interface INormalizedEmail {
  /** Trimmed address kept for display and delivery. */
  email: string;
  /** Product comparison key (trim().toLowerCase()). */
  emailKey: string;
}

/**
 * Apply the product's username normalisation order without validating it.
 * Validation is intentionally separate so callers can report the right code.
 */
export function normalizeUsername(value: string): string {
  if (typeof value !== 'string') {
    throw new AccountRuleError('INVALID_NAME', 'Username must be a string');
  }
  return value.normalize('NFKC').trim();
}

/** Build the unique username key after NFKC and trimming. */
export function usernameKey(value: string): string {
  return normalizeUsername(value).replace(/[A-Z]/g, (letter) =>
    letter.toLowerCase(),
  );
}

/**
 * Validate and return both persisted username fields.
 *
 * The optional set is an adapter extension for a game's own reserved names;
 * callers that do not provide it use the platform defaults above.
 */
export function normalizeAccountName(
  value: string,
  reservedNameKeys: ReadonlySet<string> = RESERVED_ACCOUNT_NAME_KEYS,
): INormalizedAccountName {
  const name = normalizeUsername(value);
  const codePoints = Array.from(name);
  if (
    codePoints.length < ACCOUNT_NAME_MIN_CODE_POINTS ||
    codePoints.length > ACCOUNT_NAME_MAX_CODE_POINTS
  ) {
    throw new AccountRuleError(
      'NAME_LENGTH',
      `Username must contain ${ACCOUNT_NAME_MIN_CODE_POINTS} to ${ACCOUNT_NAME_MAX_CODE_POINTS} Unicode code points`,
    );
  }

  // Cc/Cf catches controls, zero-width characters, bidi overrides, and the
  // other invisible format characters that must never enter an account key.
  if (/\p{Cc}|\p{Cf}|\p{Zl}|\p{Zp}/u.test(name)) {
    throw new AccountRuleError(
      'NAME_CHARACTERS',
      'Username cannot contain control, invisible, or line-separator characters',
    );
  }
  if (!/^[\p{Script=Han}A-Za-z\p{Nd}_-]+$/u.test(name)) {
    throw new AccountRuleError(
      'NAME_CHARACTERS',
      'Username may contain Chinese characters, letters, numbers, underscore, and hyphen',
    );
  }

  const nameKey = usernameKey(name);
  if (reservedNameKeys.has(nameKey)) {
    throw new AccountRuleError('NAME_RESERVED', 'This username is reserved');
  }
  return { name, nameKey };
}

/** Alias that reads naturally at call sites which already say username. */
export const normalizeUsernameWithKey = normalizeAccountName;

/** Return the product's email comparison key after trim and lowercase. */
export function normalizeEmail(value: string): string {
  return normalizeEmailAddress(value).emailKey;
}

/** Validate a conventional ASCII-local-part address and a DNS-style domain. */
export function normalizeEmailAddress(value: string): INormalizedEmail {
  if (typeof value !== 'string') {
    throw new AccountRuleError('INVALID_EMAIL', 'Email must be a string');
  }
  const email = value.trim();
  if (email.length === 0 || email.length > ACCOUNT_EMAIL_MAX_LENGTH) {
    throw new AccountRuleError(
      email.length > ACCOUNT_EMAIL_MAX_LENGTH
        ? 'EMAIL_TOO_LONG'
        : 'INVALID_EMAIL',
      'Email address has an invalid length',
    );
  }

  const at = email.lastIndexOf('@');
  const localPart = at > 0 ? email.slice(0, at) : '';
  const domainPart = at > 0 ? email.slice(at + 1) : '';
  // SMTPUTF8 local parts are deliberately out of scope for this first
  // production release. Keep + tags and dots exactly as supplied.
  if (
    !localPart ||
    localPart.length > 64 ||
    !/^[\x21-\x7e]+$/.test(localPart) ||
    /[\s"(),:;<>@[\]\\]/.test(localPart) ||
    localPart.startsWith('.') ||
    localPart.endsWith('.') ||
    localPart.includes('..') ||
    !domainPart ||
    domainPart.length > 253 ||
    !/^[\p{L}\p{N}.-]+$/u.test(domainPart) ||
    domainPart.startsWith('.') ||
    domainPart.endsWith('.') ||
    domainPart.includes('..') ||
    domainPart
      .split('.')
      .some(
        (label) =>
          label.length === 0 ||
          label.length > 63 ||
          label.startsWith('-') ||
          label.endsWith('-'),
      )
  ) {
    throw new AccountRuleError(
      'INVALID_EMAIL',
      'Email address has an invalid format',
    );
  }

  let asciiDomain: string;
  try {
    // URL.hostname applies IDNA conversion while keeping this shared module
    // free from a Node-only domainToASCII import.
    asciiDomain = new URL(`https://${domainPart}`).hostname;
  } catch {
    throw new AccountRuleError('INVALID_EMAIL', 'Email domain is invalid');
  }
  if (!asciiDomain || asciiDomain.endsWith('.') || asciiDomain.includes('..')) {
    throw new AccountRuleError('INVALID_EMAIL', 'Email domain is invalid');
  }
  const emailKey = `${localPart}@${asciiDomain}`.toLowerCase();
  return { email, emailKey };
}

/** NFC-normalise a password without trimming or changing case. */
export function normalizePassword(value: string): string {
  if (typeof value !== 'string') {
    throw new AccountRuleError('PASSWORD_LENGTH', 'Password must be a string');
  }
  return value.normalize('NFC');
}

export interface IPasswordIdentityContext {
  username?: string;
  email?: string;
}

/** Validate and return the exact NFC form that must be hashed and compared. */
export function validatePassword(
  value: string,
  _context: IPasswordIdentityContext = {},
): string {
  const password = normalizePassword(value);
  const codePointLength = Array.from(password).length;
  if (
    codePointLength < ACCOUNT_PASSWORD_MIN_CODE_POINTS ||
    codePointLength > ACCOUNT_PASSWORD_MAX_CODE_POINTS
  ) {
    throw new AccountRuleError(
      'PASSWORD_LENGTH',
      `Password must contain ${ACCOUNT_PASSWORD_MIN_CODE_POINTS} to ${ACCOUNT_PASSWORD_MAX_CODE_POINTS} Unicode code points`,
    );
  }
  return password;
}

export function validatePasswordConfirmation(
  password: string,
  passwordConfirm: string,
): string {
  const normalizedPassword = normalizePassword(password);
  const normalizedConfirmation = normalizePassword(passwordConfirm);
  if (normalizedPassword !== normalizedConfirmation) {
    throw new AccountRuleError(
      'PASSWORD_CONFIRM_MISMATCH',
      'Password confirmation does not match',
    );
  }
  return normalizedPassword;
}
