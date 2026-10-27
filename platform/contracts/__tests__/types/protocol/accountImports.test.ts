import { describe, expect, it } from 'vitest';
import {
  canonicalizeAccountImportSourceRole,
  isAccountImportSourceRole,
  isAccountImportSourceRoleInput,
  LEGACY_NAVIGATOR_SOURCE_ROLE,
} from '../../../src/types/protocol/accountImports.js';

describe('account migration role contracts', () => {
  it('accepts current roles and the legacy migration token', () => {
    expect(isAccountImportSourceRole('player')).toBe(true);
    expect(isAccountImportSourceRole('operator')).toBe(false);
    expect(isAccountImportSourceRoleInput(LEGACY_NAVIGATOR_SOURCE_ROLE)).toBe(
      true,
    );
    expect(
      canonicalizeAccountImportSourceRole(LEGACY_NAVIGATOR_SOURCE_ROLE),
    ).toBe('navigator');
  });
});
