import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { platformPerformanceApi } from '@/api/platformPerformanceApi.js';
import { PlatformPerformancePage } from '@/pages/admin/PlatformPerformancePage.js';

vi.mock('@/api/platformPerformanceApi.js', () => ({
  platformPerformanceApi: { getSnapshot: vi.fn() },
}));
vi.mock('@/hooks/usePermissions.js', () => ({
  usePermissions: () => ({ can: () => true }),
}));

const api = vi.mocked(platformPerformanceApi);

function renderPage(): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <PlatformPerformancePage />
    </QueryClientProvider>,
  );
}

const snapshot = {
  capturedAt: '2026-10-26T12:00:00.000Z',
  uptimeSeconds: 3661,
  sampleWindowMs: 10_000,
  cpuPercent: 125.5,
  memoryBytes: {
    rss: 64 * 1024 * 1024,
    heapUsed: 16 * 1024 * 1024,
    heapTotal: 32 * 1024 * 1024,
    external: 4 * 1024 * 1024,
    arrayBuffers: 1 * 1024 * 1024,
  },
  eventLoopLagMs: { mean: 1.2, p95: 3.4, max: 7.8 },
};

beforeEach(() => vi.clearAllMocks());

describe('PlatformPerformancePage', () => {
  it('renders process metrics and the initial sampling state', async () => {
    api.getSnapshot.mockResolvedValueOnce({
      ...snapshot,
      cpuPercent: null,
      eventLoopLagMs: null,
    });
    renderPage();

    expect(await screen.findByText('Platform performance')).toBeInTheDocument();
    expect(await screen.findByText('64.0 MiB')).toBeInTheDocument();
    expect(screen.getAllByText('Sampling…').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Uptime')).toBeInTheDocument();
  });

  it('offers retry after a failed snapshot request', async () => {
    api.getSnapshot.mockRejectedValueOnce(new Error('Offline'));
    renderPage();

    const retry = await screen.findByRole('button', { name: 'Retry' });
    api.getSnapshot.mockResolvedValueOnce(snapshot);
    fireEvent.click(retry);

    await waitFor(() => expect(screen.getByText('125.5%')).toBeInTheDocument());
    expect(api.getSnapshot).toHaveBeenCalledTimes(2);
  });
});
