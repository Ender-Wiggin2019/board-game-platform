export interface IAccountMigrationOnboarding {
  required: boolean;
  linked: boolean;
  skipped: boolean;
}

/**
 * Historical source bundles may still carry this machine token. It is accepted
 * only at the migration boundary and canonicalized to navigator before any
 * new projection or presentation is produced.
 */
export const LEGACY_NAVIGATOR_SOURCE_ROLE = '\u0076\u0069\u0070' as const;

export type TAccountImportSourceRole =
  | 'guest'
  | 'player'
  | 'navigator'
  | 'tester'
  | 'admin'
  | 'superadmin';

export type TAccountImportSourceRoleInput =
  | TAccountImportSourceRole
  | typeof LEGACY_NAVIGATOR_SOURCE_ROLE;

export function isAccountImportSourceRole(
  value: unknown,
): value is TAccountImportSourceRole {
  return (
    value === 'guest' ||
    value === 'player' ||
    value === 'navigator' ||
    value === 'tester' ||
    value === 'admin' ||
    value === 'superadmin'
  );
}

export function isAccountImportSourceRoleInput(
  value: unknown,
): value is TAccountImportSourceRoleInput {
  return (
    value === LEGACY_NAVIGATOR_SOURCE_ROLE || isAccountImportSourceRole(value)
  );
}

/** Convert approved historical input to the current source-role vocabulary. */
export function canonicalizeAccountImportSourceRole(
  value: unknown,
): TAccountImportSourceRole | undefined {
  if (value === LEGACY_NAVIGATOR_SOURCE_ROLE) return 'navigator';
  return isAccountImportSourceRole(value) ? value : undefined;
}
