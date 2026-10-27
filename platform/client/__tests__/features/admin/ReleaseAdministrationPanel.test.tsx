import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { platformAdministrationApi } from '@/api/platformAdministrationApi.js';
import { ReleaseAdministrationPanel } from '@/features/admin/ReleaseAdministrationPanel.js';
import i18n from '@/i18n.js';

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

const api = vi.mocked(platformAdministrationApi);

function renderPanel(): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ReleaseAdministrationPanel />
    </QueryClientProvider>,
  );
}

describe('ReleaseAdministrationPanel', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    await i18n.loadNamespaces('platform-admin');
    vi.clearAllMocks();
    api.listReleases.mockResolvedValue([]);
    api.registerRelease.mockResolvedValue({} as never);
    api.getReleaseReconciliation.mockResolvedValue({
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

  it('renders the release registry in both supported admin languages', async () => {
    renderPanel();

    expect(await screen.findByText('Release registry')).toBeInTheDocument();
    await i18n.changeLanguage('zh-CN');
    expect(await screen.findByText('版本注册表')).toBeInTheDocument();
    expect(screen.getAllByText('注册暂存版本').length).toBeGreaterThan(0);
  });

  it('submits parsed release and binding fields', async () => {
    renderPanel();
    await screen.findByText('No releases are registered.');

    fireEvent.change(screen.getByLabelText('Release manifest JSON'), {
      target: { value: '{"gameId":"counter"}' },
    });
    fireEvent.change(screen.getByLabelText('Service description JSON'), {
      target: { value: '{"schemaVersion":1}' },
    });
    fireEvent.change(screen.getByLabelText('Approved features JSON'), {
      target: { value: '["replay"]' },
    });
    fireEvent.change(screen.getByLabelText('Approved modes JSON'), {
      target: { value: '["solo"]' },
    });
    fireEvent.change(screen.getByLabelText('Control endpoint'), {
      target: { value: ' https://backend.example/control ' },
    });
    fireEvent.change(screen.getByLabelText('Player endpoint'), {
      target: { value: 'https://backend.example/player' },
    });
    fireEvent.change(screen.getByLabelText('Client artifact base URL'), {
      target: { value: 'https://cdn.example/counter/v1' },
    });
    fireEvent.change(screen.getByLabelText('Service credential reference'), {
      target: { value: 'secret/counter-v1' },
    });

    fireEvent.click(
      screen.getByRole('button', { name: 'Register staged release' }),
    );

    await waitFor(() =>
      expect(api.registerRelease).toHaveBeenCalledWith({
        manifest: { gameId: 'counter' },
        service: { schemaVersion: 1 },
        approvedFeatures: ['replay'],
        approvedModes: ['solo'],
        binding: {
          deployment: 'external',
          controlEndpoint: 'https://backend.example/control',
          playerEndpoint: 'https://backend.example/player',
          clientArtifactBaseUrl: 'https://cdn.example/counter/v1',
          serviceCredentialRef: 'secret/counter-v1',
        },
      }),
    );
  });

  it('submits optional policy JSON while omitting blank policy fields', async () => {
    renderPanel();
    await screen.findByText('No releases are registered.');

    fireEvent.change(
      screen.getByLabelText('Settlement policy bundle JSON (optional)'),
      {
        target: { value: '{"rating":{"version":"rating-v1"}}' },
      },
    );
    fireEvent.change(
      screen.getByLabelText('Approved policy versions JSON (optional)'),
      {
        target: { value: '[{"kind":"rating","version":"rating-v1"}]' },
      },
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Register staged release' }),
    );

    await waitFor(() =>
      expect(api.registerRelease).toHaveBeenCalledWith(
        expect.objectContaining({
          policyBundle: { rating: { version: 'rating-v1' } },
          approvedPolicyVersions: [{ kind: 'rating', version: 'rating-v1' }],
        }),
      ),
    );
    const input = api.registerRelease.mock.calls[0]?.[0];
    expect(input).not.toHaveProperty('unusedPolicyField');
  });

  it('shows a retryable error when the registry request fails', async () => {
    api.listReleases.mockRejectedValueOnce(new Error('offline'));
    renderPanel();

    expect(
      await screen.findByText('Release registry could not be loaded.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('rejects malformed JSON before sending a registration request', async () => {
    renderPanel();
    await screen.findByText('No releases are registered.');
    fireEvent.change(screen.getByLabelText('Release manifest JSON'), {
      target: { value: '{malformed' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Register staged release' }),
    );

    await waitFor(() => expect(api.registerRelease).not.toHaveBeenCalled());
  });

  it('shows malformed optional policy JSON locally before sending', async () => {
    renderPanel();
    await screen.findByText('No releases are registered.');
    fireEvent.change(
      screen.getByLabelText('Approved policy versions JSON (optional)'),
      { target: { value: '[malformed' } },
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Register staged release' }),
    );

    expect(
      await screen.findByText(
        'Enter valid JSON for Approved policy versions JSON (optional).',
      ),
    ).toBeInTheDocument();
    expect(api.registerRelease).not.toHaveBeenCalled();
  });

  it('distinguishes unconfigured desired state and exposes channel differences', async () => {
    api.getReleaseReconciliation.mockResolvedValueOnce({
      schemaVersion: 1,
      platformId: 'platform-test',
      generatedAt: Date.now(),
      desiredConfigured: false,
      desired: [],
      actual: {
        releases: [],
        bindings: [],
        channels: [
          {
            platformId: 'platform-test',
            gameId: 'counter',
            modeId: 'solo',
            channel: 'stable',
            revision: 2,
            targetBackendBindingId: 'binding-1',
            releaseId: 'counter-v1',
            storageBindingId: 'storage-1',
            ownershipEpoch: 'epoch-1',
            operationId: 'op-1',
            updatedAt: Date.now(),
          },
        ],
      },
      differences: [
        {
          gameId: 'counter',
          modeId: 'solo',
          kind: 'channel-release-mismatch',
          expected: 'counter-v2',
          actual: 'counter-v1',
        },
      ],
      channelHistory: [],
    });
    renderPanel();

    expect(await screen.findByText('Not configured')).toBeInTheDocument();
    expect(screen.getByText('counter / solo / stable')).toBeInTheDocument();
    expect(screen.getByText('Channel release mismatch')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download JSON' })).toBeEnabled();
  });

  it('distinguishes an explicitly configured empty desired list', async () => {
    api.getReleaseReconciliation.mockResolvedValueOnce({
      schemaVersion: 1,
      platformId: 'platform-test',
      generatedAt: Date.now(),
      desiredConfigured: true,
      desired: [],
      actual: { releases: [], bindings: [], channels: [] },
      differences: [],
      channelHistory: [],
    });
    renderPanel();

    expect(
      await screen.findByText('Configured with no desired releases'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('No desired releases are configured.'),
    ).toBeInTheDocument();
  });
});
