import { EErrorCode } from '@board-game/contracts';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RequestRecoveryDialog } from '@/components/RequestRecoveryDialog';
import i18n from '@/i18n';

function recoveryText(key: string, options?: Record<string, unknown>): string {
  return i18n.t(key, { ns: 'platform-common', ...options });
}

describe('RequestRecoveryDialog', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('keeps the underlying page and uses return to page when retry is unavailable', () => {
    const onDismiss = vi.fn();
    render(
      <>
        <main data-testid='underlying-page'>Mission page</main>
        <RequestRecoveryDialog error={{ status: 500 }} onDismiss={onDismiss} />
      </>,
    );

    expect(screen.getByTestId('underlying-page')).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', {
        name: recoveryText('client.requestRecovery.return_to_page'),
      }),
    );
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('prevents duplicate retries and dismissal while the request is pending', async () => {
    let finishRetry!: () => void;
    const onRetry = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRetry = resolve;
        }),
    );
    const onDismiss = vi.fn();
    render(
      <RequestRecoveryDialog
        error={{ status: 500 }}
        onRetry={onRetry}
        onDismiss={onDismiss}
        retryTestId='request-retry'
      />,
    );

    const retryButton = screen.getByTestId('request-retry');
    fireEvent.click(retryButton);
    fireEvent.click(retryButton);
    expect(onRetry).toHaveBeenCalledOnce();
    expect(retryButton).toBeDisabled();
    fireEvent.click(screen.getByTestId('dialog-overlay'));
    expect(onDismiss).not.toHaveBeenCalled();

    act(() => finishRetry());
    await waitFor(() => expect(retryButton).toBeEnabled());
  });

  it('allows the caller to close after a successful retry while preserving the page', async () => {
    function Harness(): React.JSX.Element {
      const [error, setError] = useState<unknown>({ status: 500 });
      return (
        <>
          <main data-testid='underlying-page'>Mission page</main>
          {error ? (
            <RequestRecoveryDialog
              error={error}
              onRetry={async () => setError(undefined)}
              onDismiss={() => setError(undefined)}
            />
          ) : null}
        </>
      );
    }

    render(<Harness />);
    fireEvent.click(
      screen.getByRole('button', {
        name: recoveryText('client.common.retry'),
      }),
    );

    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId('underlying-page')).toBeInTheDocument();
  });

  it('keeps the dialog open and presents the new failure after retry rejects', async () => {
    const onRetry = vi.fn(async () => {
      throw { status: 429 };
    });
    render(
      <RequestRecoveryDialog
        error={{ status: 500 }}
        onRetry={onRetry}
        onDismiss={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole('button', {
        name: recoveryText('client.common.retry'),
      }),
    );

    await waitFor(() =>
      expect(
        screen.getByRole('heading', {
          name: recoveryText('client.requestRecovery.rateLimited.title'),
        }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it.each([
    ['signin', { status: 401 }],
    ['rateLimited', { status: 429 }],
    ['service', { status: 500 }],
    ['connection', { code: EErrorCode.CONNECTION_ERROR }],
  ] as const)(
    'uses the %s copy for the matching failure semantics',
    (kind, error) => {
      render(<RequestRecoveryDialog error={error} onDismiss={vi.fn()} />);

      expect(
        screen.getByRole('heading', {
          name: recoveryText(`client.requestRecovery.${kind}.title`),
        }),
      ).toBeInTheDocument();
    },
  );

  it('disables retry during a cooldown and shows the remaining seconds', () => {
    vi.useFakeTimers();
    const now = new Date('2026-10-03T12:00:00.000Z');
    vi.setSystemTime(now);
    render(
      <RequestRecoveryDialog
        error={{ status: 500 }}
        onRetry={vi.fn()}
        retryAt={now.getTime() + 2_500}
      />,
    );

    const retryButton = screen.getByRole('button', {
      name: recoveryText('client.common.retry'),
    });
    expect(retryButton).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(
      recoveryText('client.requestRecovery.retry_countdown', {
        seconds: 3,
      }),
    );

    act(() => vi.advanceTimersByTime(3_000));
    expect(retryButton).toBeEnabled();
  });

  it('respects a retry delay carried by the error itself', async () => {
    vi.useFakeTimers();
    const onRetry = vi.fn();
    render(
      <RequestRecoveryDialog
        error={{ status: 429, retryAfterSeconds: 2 }}
        onRetry={onRetry}
      />,
    );
    const button = screen.getByRole('button', {
      name: recoveryText('client.common.retry'),
    });
    fireEvent.click(button);
    expect(onRetry).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(2_000));
    expect(button).toBeEnabled();
    await act(async () => {
      fireEvent.click(button);
    });
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('re-enables a network retry when the browser comes back online', async () => {
    const previousOnline = navigator.onLine;
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      value: false,
    });
    const onRetry = vi.fn();

    try {
      render(
        <RequestRecoveryDialog
          error={new Error('Network Error')}
          onRetry={onRetry}
        />,
      );

      const retryButton = screen.getByRole('button', {
        name: recoveryText('client.common.retry'),
      });
      expect(retryButton).toBeDisabled();

      act(() => {
        Object.defineProperty(navigator, 'onLine', {
          configurable: true,
          value: true,
        });
        window.dispatchEvent(new Event('online'));
      });

      expect(retryButton).toBeEnabled();
      await act(async () => {
        fireEvent.click(retryButton);
        await Promise.resolve();
      });
      expect(onRetry).toHaveBeenCalledOnce();
    } finally {
      Object.defineProperty(navigator, 'onLine', {
        configurable: true,
        value: previousOnline,
      });
    }
  });
});
