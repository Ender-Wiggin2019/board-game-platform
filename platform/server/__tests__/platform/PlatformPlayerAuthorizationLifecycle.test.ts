import { describe, expect, it, vi } from 'vitest';
import { AccountExtensionsRegistry } from '@/auth/account-extensions.js';
import {
  PlatformPlayerAuthorizationLifecycle,
  PlatformPlayerAuthorizationLifecycleError,
} from '@/platform/PlatformPlayerAuthorizationLifecycle.js';

describe('PlatformPlayerAuthorizationLifecycle', () => {
  it('connects all account security hooks to account-wide revocation', async () => {
    const revokeAccount = vi.fn(async () => ({
      principalId: 'account-1',
      revoked: [],
      failures: [],
    }));
    const lifecycle = new PlatformPlayerAuthorizationLifecycle({
      revokeAccount,
    } as never);
    const registry = new AccountExtensionsRegistry();
    registry.register('platform-player-authorization', lifecycle.extensions());
    const extensions = registry.get();

    await extensions.onSessionRevoked?.({ userId: 'account-1' });
    await extensions.onLogoutAll?.({ userId: 'account-1' });
    await extensions.onEmailChanged?.({
      userId: 'account-1',
      email: 'account@example.test',
      emailKey: 'account@example.test',
    });
    await extensions.onPasswordChanged?.({ userId: 'account-1' });
    await extensions.onPasswordReset?.({ userId: 'account-1' });
    await extensions.onAuthorizationChanged?.({ userId: 'account-1' });

    expect(revokeAccount).toHaveBeenCalledTimes(6);
    expect(revokeAccount).toHaveBeenNthCalledWith(1, 'account-1');
  });

  it('reports remote failures after the underlying account operation attempted every page item', async () => {
    const report = {
      principalId: 'account-1',
      revoked: [],
      failures: [
        { sessionId: 'session-1', code: 'NOT_READY', retryable: true },
      ],
    };
    const revokeAccount = vi.fn(async () => report);
    const lifecycle = new PlatformPlayerAuthorizationLifecycle({
      revokeAccount,
    } as never);
    const registry = new AccountExtensionsRegistry();
    registry.register('platform-player-authorization', lifecycle.extensions());
    const extensions = registry.get();

    await expect(
      extensions.onPasswordChanged?.({ userId: 'account-1' }),
    ).rejects.toMatchObject({
      report,
      name: 'PlatformPlayerAuthorizationLifecycleError',
    });
    expect(revokeAccount).toHaveBeenCalledOnce();
    expect(new PlatformPlayerAuthorizationLifecycleError(report).message).toBe(
      'platform.player.authorization_revocation_incomplete',
    );
  });
});
