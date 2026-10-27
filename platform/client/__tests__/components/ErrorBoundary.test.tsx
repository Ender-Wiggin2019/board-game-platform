import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '@/components/ErrorBoundary';

const { captureCrash } = vi.hoisted(() => {
  const snapshot = { status: 'failed' as const };
  const incident = {
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
    submit: vi.fn(async () => undefined),
  };
  return { captureCrash: vi.fn(() => incident) };
});

vi.mock('@/lib/crashReporter', () => ({ captureCrash }));

function CrashComponent(): never {
  throw new Error('Crash in test');
}

describe('ErrorBoundary', () => {
  it('renders fallback when child throws', () => {
    const consoleSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const onFatalError = vi.fn();

    render(
      <ErrorBoundary onFatalError={onFatalError}>
        <CrashComponent />
      </ErrorBoundary>,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong');
    expect(onFatalError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ componentStack: expect.any(String) }),
    );
    expect(captureCrash).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        source: 'react',
        componentStack: expect.any(String),
      }),
    );
    consoleSpy.mockRestore();
  });
});
