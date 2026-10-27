import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { platformApi } from '@/api/platformApi.js';
import { PlatformSessionResult } from '@/components/PlatformSessionResult.js';

const mocks = vi.hoisted(() => ({
  getSessionResult: vi.fn(),
}));

vi.mock('@/api/platformApi.js', () => ({
  platformApi: mocks,
}));

function renderResult(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <PlatformSessionResult sessionId='session-1' />
    </QueryClientProvider>,
  );
}

describe('PlatformSessionResult', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionResult.mockResolvedValue({
      status: 'completed',
      sourceRevision: 42,
      result: {
        kind: 'competitive',
        rankGroups: [
          {
            teams: [{ participantIds: ['player-1'], score: 17 }],
          },
        ],
      },
      settlement: { processingState: 'settled', attempts: 1 },
      completion: {
        status: 'completed',
        participants: [
          {
            principalId: 'player-1',
            seatId: 'seat-1',
            publicProfile: { displayName: 'Ada' },
          },
        ],
      },
      replayRef: null,
    });
  });

  it('renders the platform result without a game client or remote registry', async () => {
    renderResult();

    expect(
      await screen.findByTestId('platform-session-result'),
    ).toBeInTheDocument();
    expect(screen.getByText('Session result')).toBeInTheDocument();
    expect(await screen.findByText('Ada')).toBeInTheDocument();
    expect(screen.getByText('17')).toBeInTheDocument();
    expect(screen.getByText('Settlement: settled')).toBeInTheDocument();
    await waitFor(() =>
      expect(mocks.getSessionResult).toHaveBeenCalledWith('session-1'),
    );
    expect(platformApi.getSessionResult).toBe(mocks.getSessionResult);
  });
});
