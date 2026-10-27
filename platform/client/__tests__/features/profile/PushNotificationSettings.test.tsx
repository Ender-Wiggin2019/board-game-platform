import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PushNotificationSettings } from '@/features/profile/PushNotificationSettings';

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  sendTest: vi.fn(),
  enablePushNotifications: vi.fn(),
  disablePushNotifications: vi.fn(),
  currentUser: {
    id: 'user-1',
    role: 'player',
    preferences: { pushNotificationsEnabled: false },
  },
  availability: {
    usable: true,
    webPushUsable: true,
    isIos: false,
    isStandalone: false,
    permission: 'default',
  } as {
    usable: boolean;
    webPushUsable: boolean;
    blocker?:
      | 'needs-install'
      | 'insecure-context'
      | 'service-worker-unavailable'
      | 'push-api-unavailable'
      | 'notifications-api-unavailable'
      | 'denied'
      | 'server-unconfigured';
    isIos: boolean;
    isStandalone: boolean;
    permission: string;
  },
}));

vi.mock('@/api/pushApi', () => ({
  pushApi: {
    getConfig: () => mocks.getConfig(),
    enable: vi.fn(),
    sendTest: () => mocks.sendTest(),
  },
}));

vi.mock('@/hooks/useAuth.js', () => ({
  useCurrentUser: () => ({
    data: mocks.currentUser,
  }),
}));

vi.mock('@/lib/pushNotifications', () => ({
  disablePushNotifications: () => mocks.disablePushNotifications(),
  enablePushNotifications: (publicKey: string) =>
    mocks.enablePushNotifications(publicKey),
  getPushAvailability: () => mocks.availability,
}));

function renderSettings(): void {
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <PushNotificationSettings />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.getConfig.mockReset();
  mocks.sendTest.mockReset();
  mocks.enablePushNotifications.mockReset();
  mocks.disablePushNotifications.mockReset();
  mocks.enablePushNotifications.mockResolvedValue({ ok: true });
  mocks.disablePushNotifications.mockResolvedValue(undefined);
  mocks.currentUser.preferences.pushNotificationsEnabled = false;
  mocks.availability.usable = true;
  mocks.availability.webPushUsable = true;
  delete mocks.availability.blocker;
});

describe('PushNotificationSettings config state', () => {
  it('shows a loading state before configuration resolves', () => {
    mocks.getConfig.mockReturnValue(new Promise(() => undefined));

    renderSettings();

    expect(screen.getByText('Loading push settings…')).toBeInTheDocument();
    expect(
      screen.getByRole('switch', { name: 'Turn notifications' }),
    ).toBeDisabled();
  });

  it('reports a request failure instead of claiming the server is unconfigured', async () => {
    mocks.getConfig.mockRejectedValue(
      Object.assign(new Error('forbidden'), { status: 403 }),
    );

    renderSettings();

    expect(
      await screen.findByText('Could not load push settings.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        'Push notifications are not configured on the server.',
      ),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(
      screen.getByRole('switch', { name: 'Turn notifications' }),
    ).toBeDisabled();
    expect(screen.getByTestId('push-notification-reason')).toHaveTextContent(
      'Diagnostic code: config-request-failed',
    );
    expect(mocks.getConfig).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'needs-install',
      'On iPhone or iPad, open the Share menu and choose "Add to Home Screen", then open Board Game Utopia from that icon to enable notifications.',
    ],
    [
      'insecure-context',
      'Push notifications require a secure HTTPS connection.',
    ],
    [
      'service-worker-unavailable',
      'This browser or browsing mode does not provide Service Workers.',
    ],
    [
      'notifications-api-unavailable',
      'This browser or browsing mode does not provide the Notifications API.',
    ],
    [
      'denied',
      'Notifications are blocked for this site. Re-allow them in your browser or system settings first.',
    ],
  ] as const)(
    'keeps the setting visible and explains the %s blocker',
    async (blocker, reason) => {
      mocks.availability.usable = false;
      mocks.availability.blocker = blocker;
      mocks.getConfig.mockResolvedValue({
        configured: true,
        publicKey: 'QQ',
        deviceCount: 0,
      });

      renderSettings();

      await screen.findByText(reason);
      expect(
        screen.getByRole('switch', { name: 'Turn notifications' }),
      ).toBeDisabled();
      expect(screen.getByTestId('push-notification-reason')).toHaveTextContent(
        reason,
      );
      expect(screen.getByTestId('push-notification-reason')).toHaveTextContent(
        `Diagnostic code: ${blocker}`,
      );
    },
  );

  it('does not show a blocker reason when this device can enable push', async () => {
    mocks.getConfig.mockResolvedValue({
      configured: true,
      publicKey: 'QQ',
      deviceCount: 0,
    });

    renderSettings();

    await waitFor(() =>
      expect(
        screen.getByRole('switch', { name: 'Turn notifications' }),
      ).toBeEnabled(),
    );
    expect(
      screen.queryByTestId('push-notification-reason'),
    ).not.toBeInTheDocument();
  });

  it('shows the online-only delivery hint after the account opt-in is saved', async () => {
    mocks.getConfig.mockResolvedValue({
      configured: true,
      publicKey: 'QQ',
      deviceCount: 0,
    });
    mocks.enablePushNotifications.mockResolvedValue({
      ok: true,
      mode: 'online-only',
      reason: 'subscription-service-unavailable',
    });

    renderSettings();
    const toggle = await screen.findByRole('switch', {
      name: 'Turn notifications',
    });
    await waitFor(() => expect(toggle).toBeEnabled());
    fireEvent.click(toggle);

    expect(await screen.findByTestId('push-online-only')).toHaveTextContent(
      'Notifications work while this page stays online; push after closing the page is currently unavailable.',
    );
    expect(screen.getByTestId('push-notification-reason')).toHaveTextContent(
      'Diagnostic code: subscription-service-unavailable',
    );
  });

  it('keeps the switch off when the account opt-in cannot be saved', async () => {
    mocks.getConfig.mockResolvedValue({
      configured: true,
      publicKey: 'QQ',
      deviceCount: 0,
    });
    mocks.enablePushNotifications.mockResolvedValue({
      ok: false,
      reason: 'server-enable-unavailable',
    });

    renderSettings();
    const toggle = await screen.findByRole('switch', {
      name: 'Turn notifications',
    });
    await waitFor(() => expect(toggle).toBeEnabled());
    fireEvent.click(toggle);

    await screen.findByText(
      'The server could not save the notification setting. Check the network and try again.',
    );
    expect(toggle).not.toBeChecked();
  });

  it.each([
    [
      'permission-dismissed',
      'Notification permission was not granted. Allow notifications in the browser prompt, then try again.',
    ],
    [
      'invalid-push-endpoint',
      'This browser returned an invalid push-service address, which is a browser compatibility problem. Update the browser or use Chrome for now.',
    ],
    [
      'subscription-service-unavailable',
      'The browser could not reach its push service. Check the network, update the browser, then try again.',
    ],
    [
      'server-registration-rejected',
      'The server rejected the subscription generated by this browser. Update the browser and try again.',
    ],
  ] as const)(
    'shows the actionable %s runtime failure and its diagnostic code',
    async (failure, message) => {
      mocks.getConfig.mockResolvedValue({
        configured: true,
        publicKey: 'QQ',
        deviceCount: 0,
      });
      mocks.enablePushNotifications.mockResolvedValue({
        ok: false,
        reason: failure,
      });

      renderSettings();
      const toggle = await screen.findByRole('switch', {
        name: 'Turn notifications',
      });
      await waitFor(() => expect(toggle).toBeEnabled());
      fireEvent.click(toggle);

      await waitFor(() =>
        expect(
          screen.getByTestId('push-notification-reason'),
        ).toHaveTextContent(message),
      );
      expect(screen.getByTestId('push-notification-reason')).toHaveTextContent(
        `Diagnostic code: ${failure}`,
      );
    },
  );

  it('still allows an account-wide opt-out in an unsupported browser', async () => {
    mocks.currentUser.preferences.pushNotificationsEnabled = true;
    mocks.availability.usable = true;
    mocks.availability.webPushUsable = false;
    mocks.getConfig.mockResolvedValue({
      configured: true,
      publicKey: 'QQ',
      deviceCount: 2,
    });

    renderSettings();
    await screen.findByText(
      'Notifications work while this page stays online; push after closing the page is currently unavailable.',
    );
    const toggle = screen.getByRole('switch', {
      name: 'Turn notifications',
    });
    expect(toggle).toBeEnabled();
    expect(screen.getByTestId('push-online-only')).toBeInTheDocument();
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(mocks.disablePushNotifications).toHaveBeenCalledTimes(1),
    );
  });

  it('keeps test feedback visible alongside a device blocker', async () => {
    mocks.currentUser.preferences.pushNotificationsEnabled = true;
    mocks.availability.usable = true;
    mocks.availability.webPushUsable = false;
    mocks.getConfig.mockResolvedValue({
      configured: true,
      publicKey: 'QQ',
      deviceCount: 2,
    });
    mocks.sendTest.mockResolvedValue(2);

    renderSettings();
    await screen.findByText(
      'Notifications work while this page stays online; push after closing the page is currently unavailable.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));

    expect(await screen.findByText('Sent to 2 devices.')).toBeInTheDocument();
  });
});
