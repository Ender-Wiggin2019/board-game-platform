import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RequestRecoveryStatus } from '@/components/RequestRecoveryStatus';

describe('RequestRecoveryStatus', () => {
  it('keeps the error dialog through a real retry, then shows the loaded page', async () => {
    let attempts = 0;
    let completeRetry!: (value: string) => void;
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    function Page(): React.JSX.Element {
      const query = useQuery({
        queryKey: ['recovery-status'],
        queryFn: async () => {
          if (++attempts === 1)
            throw Object.assign(new Error('unavailable'), { status: 503 });
          return new Promise<string>((resolve) => {
            completeRetry = resolve;
          });
        },
      });
      return query.data ? (
        <main>{query.data}</main>
      ) : (
        <RequestRecoveryStatus
          error={query.error}
          isRetrying={query.isFetching}
          onRetry={() => query.refetch()}
          retryTestId='retry'
        />
      );
    }
    render(
      <QueryClientProvider client={client}>
        <Page />
      </QueryClientProvider>,
    );
    await screen.findByRole('dialog');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('retry'));
    await waitFor(() => expect(attempts).toBe(2));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByTestId('retry')).toBeDisabled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await act(async () => {
      completeRetry('Loaded page');
    });
    expect(await screen.findByText('Loaded page')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('resets retained errors when the requested account or resource changes', () => {
    const view = render(
      <RequestRecoveryStatus
        key='first'
        error={{ status: 503 }}
        isRetrying={false}
        onRetry={() => undefined}
      />,
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    view.rerender(
      <RequestRecoveryStatus
        key='second'
        error={null}
        isRetrying
        onRetry={() => undefined}
      />,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});
