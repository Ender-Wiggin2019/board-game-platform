import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../../src/i18n.js';
import { PlatformNotificationEffects } from '../../src/providers/PlatformNotificationEffects.js';
import {
  PlatformNotificationOwnershipProvider,
  usePlatformNotificationOwnership,
} from '../../src/providers/PlatformNotificationOwnership.js';
import { useAuthStore } from '../../src/stores/authStore.js';

type NotificationHandler = (event: unknown) => void;

const mocks = vi.hoisted(() => ({
  handlers: new Set<NotificationHandler>(),
  toast: vi.fn(),
}));

vi.mock('../../src/api/platformSocket.js', () => ({
  platformSocket: {
    onPlatformNotification: (handler: NotificationHandler) => {
      mocks.handlers.add(handler);
      return () => mocks.handlers.delete(handler);
    },
  },
}));

vi.mock('../../src/components/ui/toast.js', () => ({
  toast: mocks.toast,
}));

vi.mock('../../src/hooks/usePlatformBrowserNotifications.js', () => ({
  usePlatformBrowserNotifications: () => undefined,
}));

vi.mock('../../src/hooks/usePlatformPushSubscriptionRefresh.js', () => ({
  usePlatformPushSubscriptionRefresh: () => undefined,
}));

function AchievementOwner({ gameId }: { gameId: string }): null {
  const { registerNotificationOwner } = usePlatformNotificationOwnership();
  useEffect(
    () =>
      registerNotificationOwner(gameId, 'achievement', (content) => {
        const badgeIds = content.achievementBadgeIds;
        return (
          content.gameId === gameId &&
          Array.isArray(badgeIds) &&
          badgeIds.includes('career.first-step.bronze')
        );
      }),
    [gameId, registerNotificationOwner],
  );
  return null;
}

function renderEffects(ownerGameId?: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <PlatformNotificationOwnershipProvider>
          {ownerGameId ? <AchievementOwner gameId={ownerGameId} /> : null}
          <PlatformNotificationEffects />
        </PlatformNotificationOwnershipProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
  return { queryClient, ...view };
}

beforeEach(() => {
  mocks.handlers.clear();
  mocks.toast.mockReset();
  useAuthStore.getState().login('account-token', {
    id: 'account-1',
    name: 'Ada',
    email: 'ada@example.test',
    role: 'player',
  });
});

afterEach(() => {
  act(() => useAuthStore.getState().logout());
});

describe('PlatformNotificationEffects', () => {
  it('keeps achievement messages visible when the SETI renderer is not mounted', async () => {
    renderEffects();
    await waitFor(() => expect(mocks.handlers.size).toBe(1));

    await act(async () => {
      for (const handler of mocks.handlers) {
        handler({
          kind: 'message',
          message: {
            severity: 'success',
            content: {
              kind: 'plain',
              title: { kind: 'literal', text: 'Achievement unlocked' },
              body: { kind: 'literal', text: 'A new badge is ready.' },
              achievementBadgeIds: ['career.first-step.bronze'],
            },
          },
        });
      }
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith({
        title: 'Achievement unlocked',
        description: 'A new badge is ready.',
        variant: 'success',
      }),
    );
  });

  it('suppresses only the owned game achievement toast while the renderer is mounted', async () => {
    const view = renderEffects('seti');
    await waitFor(() => expect(mocks.handlers.size).toBe(1));

    await act(async () => {
      for (const handler of mocks.handlers) {
        handler({
          kind: 'message',
          message: {
            severity: 'success',
            content: {
              kind: 'plain',
              title: { kind: 'literal', text: 'SETI achievement' },
              body: { kind: 'literal', text: 'Rich renderer owns this.' },
              gameId: 'seti',
              achievementBadgeIds: ['career.first-step.bronze'],
            },
          },
        });
        handler({
          kind: 'message',
          message: {
            severity: 'success',
            content: {
              kind: 'plain',
              title: { kind: 'literal', text: 'Unscoped achievement' },
              body: { kind: 'literal', text: 'The SETI shape has no game id.' },
              achievementBadgeIds: ['career.first-step.bronze'],
            },
          },
        });
        handler({
          kind: 'message',
          message: {
            severity: 'success',
            content: {
              kind: 'plain',
              title: { kind: 'literal', text: 'Unknown achievement' },
              body: { kind: 'literal', text: 'Unknown ids stay generic.' },
              achievementBadgeIds: ['other-game.badge'],
            },
          },
        });
        handler({
          kind: 'message',
          message: {
            severity: 'success',
            content: {
              kind: 'plain',
              title: { kind: 'literal', text: 'Other achievement' },
              body: { kind: 'literal', text: 'Generic fallback remains.' },
              gameId: 'brass',
              achievementBadgeIds: ['other-game.badge'],
            },
          },
        });
      }
      await Promise.resolve();
    });
    expect(mocks.toast).toHaveBeenCalledTimes(3);
    expect(mocks.toast).toHaveBeenCalledWith({
      title: 'Other achievement',
      description: 'Generic fallback remains.',
      variant: 'success',
    });
    expect(mocks.toast).toHaveBeenCalledWith({
      title: 'Unknown achievement',
      description: 'Unknown ids stay generic.',
      variant: 'success',
    });
    expect(mocks.toast).toHaveBeenCalledWith({
      title: 'Unscoped achievement',
      description: 'The SETI shape has no game id.',
      variant: 'success',
    });

    view.rerender(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={view.queryClient}>
          <PlatformNotificationOwnershipProvider>
            <PlatformNotificationEffects />
          </PlatformNotificationOwnershipProvider>
        </QueryClientProvider>
      </I18nextProvider>,
    );
    await act(async () => {
      for (const handler of mocks.handlers) {
        handler({
          kind: 'message',
          message: {
            severity: 'success',
            content: {
              kind: 'plain',
              title: { kind: 'literal', text: 'SETI fallback' },
              body: { kind: 'literal', text: 'Renderer is gone.' },
              gameId: 'seti',
              achievementBadgeIds: ['career.first-step.bronze'],
            },
          },
        });
      }
      await Promise.resolve();
    });
    expect(mocks.toast).toHaveBeenCalledTimes(4);
    expect(mocks.toast).toHaveBeenLastCalledWith({
      title: 'SETI fallback',
      description: 'Renderer is gone.',
      variant: 'success',
    });
  });

  it('leaves shell refreshes to the shell badge provider', async () => {
    const { queryClient } = renderEffects();
    await waitFor(() => expect(mocks.handlers.size).toBe(1));
    const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');

    await act(async () => {
      for (const handler of mocks.handlers) {
        handler({ kind: 'shell' });
        handler({
          kind: 'game',
          gameId: 'seti',
          type: 'achievement-awarded',
          payload: {},
        });
      }
      await Promise.resolve();
    });

    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it('ignores a message delivered by the previous auth session', async () => {
    renderEffects('seti');
    await waitFor(() => expect(mocks.handlers.size).toBe(1));
    const previousHandler = [...mocks.handlers][0];
    act(() => {
      useAuthStore.getState().login('next-account-token', {
        id: 'account-2',
        name: 'Grace',
        email: 'grace@example.test',
        role: 'player',
      });
    });

    await act(async () => {
      previousHandler?.({
        kind: 'message',
        message: {
          severity: 'success',
          content: {
            kind: 'plain',
            title: { kind: 'literal', text: 'Stale achievement' },
            body: { kind: 'literal', text: 'Old account notification.' },
            gameId: 'seti',
            achievementBadgeIds: ['career.first-step.bronze'],
          },
        },
      });
      await Promise.resolve();
    });

    expect(mocks.toast).not.toHaveBeenCalled();
  });
});
