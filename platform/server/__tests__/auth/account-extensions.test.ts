import { ERole } from '@board-platform/contracts/auth/roles';
import { describe, expect, it, vi } from 'vitest';
import {
  AccountExtensionsRegistry,
  type IAccountExtensions,
} from '@/auth/account-extensions.js';

describe('AccountExtensionsRegistry', () => {
  it('composes validators and lifecycle callbacks across game ids', async () => {
    const validateSeti = vi.fn();
    const validateBrass = vi.fn();
    const onPasswordReset = vi.fn();
    const registry = new AccountExtensionsRegistry();

    registry.register('seti', {
      validateAccountName: validateSeti,
      onPasswordReset,
    });
    registry.register('brass', { validateAccountName: validateBrass });

    registry.get().validateAccountName?.({ name: 'Pilot', nameKey: 'pilot' });
    await registry.get().onPasswordReset?.({ userId: 'user-1' });

    expect(validateSeti).toHaveBeenCalledOnce();
    expect(validateBrass).toHaveBeenCalledOnce();
    expect(onPasswordReset).toHaveBeenCalledWith({ userId: 'user-1' });
    expect(registry.getForGame('seti')).toBeDefined();
    expect(registry.getForGame('unknown')).toBeUndefined();
  });

  it('rejects duplicate game ids and profile field collisions', async () => {
    const registry = new AccountExtensionsRegistry();
    const extension: IAccountExtensions = {
      extendProfile: () => ({ id: 'game-owned-id' }),
    };
    registry.register('seti', extension);

    expect(() => registry.register('seti', {})).toThrow(
      'Account extensions already registered for seti',
    );
    await expect(
      registry.get().extendProfile?.({
        user: {} as never,
        role: ERole.PLAYER,
        profile: {
          id: 'user-1',
          name: 'Pilot',
          email: 'pilot@example.com',
          role: ERole.PLAYER,
          baseRole: ERole.PLAYER,
          navigator: { active: false, source: null, expiresAt: null },
          createdAt: new Date(),
        },
      }),
    ).rejects.toThrow('Account profile extension field collision: seti.id');
  });

  it('dispatches claimed game preferences and reports fields with no owner', async () => {
    const updatePreferences = vi.fn().mockResolvedValue(undefined);
    const registry = new AccountExtensionsRegistry();
    registry.register('seti', {
      preferenceKeys: ['preferredPlayerColor'],
      updatePreferences,
    });

    await expect(
      registry.updatePreferences('user-1', {
        preferredPlayerColor: 'green',
      }),
    ).resolves.toEqual([]);
    expect(updatePreferences).toHaveBeenCalledWith({
      userId: 'user-1',
      patch: { preferredPlayerColor: 'green' },
    });

    await expect(
      registry.updatePreferences('user-1', { unsupported: true }),
    ).resolves.toEqual(['unsupported']);
    expect(updatePreferences).toHaveBeenCalledOnce();
  });
});
