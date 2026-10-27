import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlatformAccessPage } from '@/pages/platform/PlatformAccessPage.js';
import { useAuthStore } from '@/stores/authStore.js';

const mocks = vi.hoisted(() => ({
  admin: false,
  api: {
    catalog: vi.fn(),
    grants: vi.fn(),
    redeem: vi.fn(),
    codes: vi.fn(),
    issue: vi.fn(),
    revoke: vi.fn(),
  },
}));
vi.mock('@/api/platformAccessApi.js', () => ({ platformAccessApi: mocks.api }));
vi.mock('@/api/platformGamesApi.js', () => ({
  platformGamesApi: { listGames: async () => [] },
}));
vi.mock('@/hooks/usePermissions.js', () => ({
  usePermissions: () => ({ can: () => mocks.admin }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
function mount() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
          },
        })
      }
    >
      <PlatformAccessPage />
    </QueryClientProvider>,
  );
}
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ authEpoch: 0 });
  mocks.admin = false;
  mocks.api.catalog.mockResolvedValue([
    {
      gameId: 'arnak',
      releaseId: 'v1',
      entitlements: [{ entitlement: 'play', label: 'Play Arnak' }],
    },
  ]);
  mocks.api.grants.mockResolvedValue([]);
  mocks.api.codes.mockResolvedValue([]);
});
describe('game invitation access', () => {
  it('redeems for the selected game and refreshes the user grants', async () => {
    mocks.api.redeem.mockResolvedValue({ grantId: 'g' });
    mount();
    fireEvent.change(await screen.findByLabelText('access.code'), {
      target: { value: 'ARNAK-123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'access.redeem' }));
    await waitFor(() =>
      expect(mocks.api.redeem).toHaveBeenCalledWith('arnak', 'ARNAK-123'),
    );
    expect(await screen.findByText('access.redeemed')).toBeTruthy();
    expect(screen.queryByText('access.manage')).toBeNull();
    expect(mocks.api.codes).not.toHaveBeenCalled();
  });
  it('shows the one-time issued code only after a successful admin request', async () => {
    mocks.admin = true;
    mocks.api.issue.mockResolvedValue({ code: 'ONE-TIME-CODE' });
    mount();
    fireEvent.click(
      await screen.findByRole('button', { name: 'access.issue' }),
    );
    await waitFor(() =>
      expect(mocks.api.issue).toHaveBeenCalledWith('arnak', {
        entitlement: 'play',
        maxUses: 1,
      }),
    );
    expect(await screen.findByText('ONE-TIME-CODE')).toBeTruthy();
  });
  it('hides an issued code immediately when switching games', async () => {
    mocks.admin = true;
    mocks.api.catalog.mockResolvedValue([
      {
        gameId: 'arnak',
        releaseId: 'v1',
        entitlements: [{ entitlement: 'play', label: 'Play Arnak' }],
      },
      {
        gameId: 'seti',
        releaseId: 'v1',
        entitlements: [{ entitlement: 'play', label: 'Play SETI' }],
      },
    ]);
    mocks.api.issue.mockResolvedValue({ code: 'ARNAK-CODE' });
    mount();
    fireEvent.click(
      await screen.findByRole('button', { name: 'access.issue' }),
    );
    expect(await screen.findByText('ARNAK-CODE')).toBeTruthy();

    const gameSelector = screen
      .getAllByRole('combobox')
      .find((element) => (element as HTMLSelectElement).value === 'arnak');
    if (!gameSelector) throw new Error('game selector not found');
    fireEvent.change(gameSelector, {
      target: { value: 'seti' },
    });

    expect(screen.queryByText('ARNAK-CODE')).toBeNull();
  });
  it('does not expose a late issued code after the authenticated account changes', async () => {
    mocks.admin = true;
    let resolve!: (result: { code: string }) => void;
    mocks.api.issue.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    mount();
    fireEvent.click(
      await screen.findByRole('button', { name: 'access.issue' }),
    );
    await waitFor(() => expect(mocks.api.issue).toHaveBeenCalled());
    act(() => useAuthStore.setState({ authEpoch: 1 }));
    await act(async () => resolve({ code: 'PREVIOUS-ACCOUNT-CODE' }));
    expect(screen.queryByText('PREVIOUS-ACCOUNT-CODE')).toBeNull();
  });

  it('falls back to an available game when the catalog removes the selection', async () => {
    mocks.api.catalog.mockResolvedValue([
      { gameId: 'arnak', releaseId: 'v1', entitlements: [] },
      { gameId: 'seti', releaseId: 'v1', entitlements: [] },
    ]);
    mount();
    await screen.findByLabelText('access.code');
    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'seti' },
    });
    expect(screen.getByRole('combobox')).toHaveValue('seti');

    mocks.api.catalog.mockResolvedValue([
      { gameId: 'arnak', releaseId: 'v1', entitlements: [] },
    ]);
    act(() => useAuthStore.setState({ authEpoch: 1 }));

    await waitFor(() =>
      expect(screen.getByRole('combobox')).toHaveValue('arnak'),
    );
  });
});
