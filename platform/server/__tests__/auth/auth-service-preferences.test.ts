import { ERole } from '@board-platform/contracts/auth/roles';
import { describe, expect, it, vi } from 'vitest';
import { AccountExtensionsRegistry } from '@/auth/account-extensions.js';
import { AuthService } from '@/auth/auth.service.js';
import { AccountPreferencesRepository } from '@/persistence/repository/AccountPreferencesRepository.js';
import { UserRepository } from '@/persistence/repository/UserRepository.js';

const USER = {
  id: 'user-1',
  name: 'Pilot',
  email: 'pilot@example.com',
  emailVerifiedAt: null,
  role: ERole.PLAYER,
  createdAt: new Date(),
  sessionVersion: 1,
  accountStatus: 'active',
} as never;

describe('platform AuthService preference delegation', () => {
  it('persists generic account fields without invoking a game adapter', async () => {
    const registry = new AccountExtensionsRegistry();
    const service = new AuthService({} as never, {} as never, registry);
    const findById = vi
      .spyOn(UserRepository.prototype, 'findById')
      .mockResolvedValue(USER);
    const upsert = vi
      .spyOn(AccountPreferencesRepository.prototype, 'upsert')
      .mockResolvedValue({ language: 'en' });

    await expect(
      service.updatePreferences('user-1', {
        language: 'en',
        pushNotificationsEnabled: true,
      }),
    ).resolves.toMatchObject({ id: 'user-1', name: 'Pilot' });
    expect(findById).toHaveBeenCalledWith('user-1');
    expect(upsert).toHaveBeenCalledWith('user-1', {
      language: 'en',
      pushNotificationsEnabled: true,
    });
  });

  it('splits generic and game fields while returning the game projection', async () => {
    const updatePreferences = vi.fn().mockResolvedValue(undefined);
    const registry = new AccountExtensionsRegistry();
    registry.register('seti', {
      preferenceKeys: ['preferredPlayerColor'],
      updatePreferences,
      extendProfile: () => ({
        preferences: { preferredPlayerColor: 'green' },
      }),
    });
    const service = new AuthService({} as never, {} as never, registry);
    vi.spyOn(UserRepository.prototype, 'findById').mockResolvedValue(USER);
    const upsert = vi
      .spyOn(AccountPreferencesRepository.prototype, 'upsert')
      .mockResolvedValue({ language: 'en' });

    await expect(
      service.updatePreferences('user-1', {
        language: 'en',
        preferredPlayerColor: 'green',
      }),
    ).resolves.toMatchObject({
      preferences: { preferredPlayerColor: 'green' },
    });
    expect(updatePreferences).toHaveBeenCalledWith({
      userId: 'user-1',
      patch: { preferredPlayerColor: 'green' },
    });
    expect(upsert).toHaveBeenCalledWith('user-1', { language: 'en' });
  });
});
