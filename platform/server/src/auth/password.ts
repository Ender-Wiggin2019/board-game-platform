import {
  AccountRuleError,
  validatePassword,
  validatePasswordConfirmation,
} from '@board-platform/contracts/auth/accountRules';
import { BadRequestException } from '@nestjs/common';
import argon2 from 'argon2';

/** OWASP's Argon2id baseline expressed in argon2's KiB option. */
export const ACCOUNT_ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19 * 1024,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
  saltLength: 16,
} as const;

/**
 * Validate a production account password and return its NFC form.
 * Passwords are not trimmed: leading and trailing spaces are significant.
 */
export function validateAccountPassword(
  password: string,
  identity?: { username?: string; email?: string },
): string {
  return accountRuleBoundary(() => validatePassword(password, identity));
}

/** Convert shared account validation failures to the HTTP 4xx boundary. */
export function accountRuleBoundary<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof AccountRuleError) {
      throw new BadRequestException({
        code: error.code,
        message: error.message,
      });
    }
    throw error;
  }
}

export async function accountRuleBoundaryAsync<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AccountRuleError) {
      throw new BadRequestException({
        code: error.code,
        message: error.message,
      });
    }
    throw error;
  }
}

export function validateAccountPasswordConfirmation(
  password: string,
  passwordConfirm: string,
): string {
  return accountRuleBoundary(() =>
    validatePasswordConfirmation(password, passwordConfirm),
  );
}

/** Hash a new production account password with Argon2id. */
export function hashPassword(
  password: string,
  identity?: { username?: string; email?: string },
): Promise<string> {
  const normalized = validateAccountPassword(password, identity);
  return argon2.hash(normalized, ACCOUNT_ARGON2_OPTIONS);
}

/**
 * Hash a non-account secret with the same Argon2id primitive.
 *
 * Room passwords are game-room access secrets, not production account
 * credentials, so they intentionally do not inherit the account password
 * length policy.
 */
export function hashRoomPassword(password: string): Promise<string> {
  return argon2.hash(password, ACCOUNT_ARGON2_OPTIONS);
}

/** Alias used at call sites where distinguishing account hashes is helpful. */
export const hashAccountPassword = hashPassword;

/** Legacy credentials are verified only by the isolated account-migration flow. */
export async function verifyAccountPassword(
  password: string,
  passwordHash: string,
): Promise<boolean> {
  if (!isArgon2idHash(passwordHash)) return false;
  try {
    return await argon2.verify(passwordHash, password.normalize('NFC'));
  } catch {
    return false;
  }
}

/** Verify the current room-secret format; old game rooms are not imported. */
export async function verifyRoomPassword(
  password: string,
  passwordHash: string,
): Promise<boolean> {
  if (!isArgon2idHash(passwordHash)) return false;
  try {
    return await argon2.verify(passwordHash, password);
  } catch {
    return false;
  }
}

/** True only for the hash format used by new production account passwords. */
function isArgon2idHash(passwordHash: string): boolean {
  return passwordHash.startsWith('$argon2id$');
}
