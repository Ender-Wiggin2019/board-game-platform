import { ECapability } from '@board-platform/contracts/auth/permissions';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { platformAdministrationApi } from '@/api/platformAdministrationApi.js';
import i18n from '@/i18n.js';
import { PlatformAdministrationPage } from '@/pages/admin/PlatformAdministrationPage.js';

const allowed = new Set<ECapability>();

vi.mock('@/hooks/usePermissions.js', () => ({
  usePermissions: () => ({
    can: (capability: ECapability) => allowed.has(capability),
  }),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/api/platformAdministrationApi.js', () => ({
  platformAdministrationApi: {
    listReleases: vi.fn(),
    registerRelease: vi.fn(),
    readyBinding: vi.fn(),
    activateBinding: vi.fn(),
    drainBinding: vi.fn(),
    disableBinding: vi.fn(),
    retainBinding: vi.fn(),
    switchChannel: vi.fn(),
    getReleaseReconciliation: vi.fn(),
  },
}));

describe('PlatformAdministrationPage release permissions', () => {
  beforeEach(async () => {
    allowed.clear();
    await i18n.changeLanguage('en');
    await i18n.loadNamespaces('platform-admin');
    vi.mocked(platformAdministrationApi.listReleases).mockResolvedValue([]);
    vi.mocked(
      platformAdministrationApi.getReleaseReconciliation,
    ).mockResolvedValue({
      schemaVersion: 1,
      platformId: 'platform-test',
      generatedAt: Date.now(),
      desiredConfigured: false,
      desired: [],
      actual: { releases: [], bindings: [], channels: [] },
      differences: [],
      channelHistory: [],
    });
  });

  it('does not expose release administration without game modify permission', () => {
    render(<PlatformAdministrationPage />);

    expect(
      screen.getByText(
        'You do not have permission to use platform administration.',
      ),
    ).toBeInTheDocument();
  });

  it('exposes release administration to platform game managers', () => {
    allowed.add(ECapability.ADMIN_ACCESS);
    allowed.add(ECapability.GAME_MODIFY_ANY);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <PlatformAdministrationPage />
      </QueryClientProvider>,
    );

    expect(
      screen.getByRole('button', { name: 'Releases' }),
    ).toBeInTheDocument();
  });
});
