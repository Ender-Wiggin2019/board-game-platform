import { describe, expect, it } from 'vitest';
import {
  EErrorCategory,
  EErrorCode,
  EErrorDisplay,
  EErrorResponsibility,
  EErrorSeverity,
  normalizeErrorPayload,
} from '../src/index.js';

describe('shared error protocol', () => {
  it('keeps the HTTP auth and server classifications stable', () => {
    expect(
      normalizeErrorPayload({
        code: EErrorCode.UNAUTHORIZED,
        message: 'Authentication required',
      }),
    ).toEqual({
      code: EErrorCode.UNAUTHORIZED,
      message: 'Authentication required',
      category: EErrorCategory.AUTH,
      display: EErrorDisplay.BLOCKING,
      responsibility: EErrorResponsibility.AUTHORIZATION,
      retryable: false,
      severity: EErrorSeverity.BLOCKING,
    });
    expect(
      normalizeErrorPayload({
        code: EErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Internal server error',
      }).retryable,
    ).toBe(true);
  });

  it('retains game adapter codes without importing a game package', () => {
    expect(
      normalizeErrorPayload({
        code: EErrorCode.INVALID_ACTION,
        message: 'Action rejected',
      }).category,
    ).toBe(EErrorCategory.BUSINESS);
  });
});
