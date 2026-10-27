import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { accountSecurityAdminApi } from '@/api/accountSecurityAdminApi.js';
import { AccountSecurityPanel } from '@/features/admin/AccountSecurityPanel.js';
import i18n from '@/i18n.js';

vi.mock('@/api/accountSecurityAdminApi.js', () => ({
  accountSecurityAdminApi: { receipts: vi.fn(), events: vi.fn() },
}));

const userId = '11111111-1111-4111-8111-111111111111';

describe('AccountSecurityPanel', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    await i18n.loadNamespaces('platform-admin');
    vi.clearAllMocks();
    vi.mocked(accountSecurityAdminApi.receipts).mockResolvedValue([]);
    vi.mocked(accountSecurityAdminApi.events).mockResolvedValue([]);
  });

  it('filters bounded operational lookups by a validated account ID', async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AccountSecurityPanel />
      </QueryClientProvider>,
    );
    await screen.findByText('No migration receipts found.');
    const input = screen.getByLabelText('Account ID filter');
    fireEvent.change(input, { target: { value: 'invalid' } });
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    expect(screen.getByRole('alert')).toHaveTextContent('valid UUID');
    expect(accountSecurityAdminApi.receipts).not.toHaveBeenCalledWith(
      'invalid',
    );

    fireEvent.change(input, { target: { value: userId } });
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    await waitFor(() =>
      expect(accountSecurityAdminApi.receipts).toHaveBeenCalledWith(userId),
    );
    expect(accountSecurityAdminApi.events).toHaveBeenCalledWith(userId);
  });
});
