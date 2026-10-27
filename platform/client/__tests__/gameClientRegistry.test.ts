import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameClientRegistration } from '../src/GameClientRegistration.js';
import { createGameClientRegistry } from '../src/gameClientRegistry.js';

const { registerGameResources } = vi.hoisted(() => ({
  registerGameResources: vi.fn(),
}));

vi.mock('../src/i18n.js', () => ({ registerGameResources }));

function registration(
  gameId: string,
  locales?: GameClientRegistration['locales'],
): GameClientRegistration {
  return {
    gameId,
    metadata: { nameKey: `${gameId}.name` },
    ...(locales ? { locales } : {}),
    setup: {
      default: () => ({}),
      getPlayerCount: (_setup, fallback) => fallback,
      updatePlayerCount: (setup) => setup,
    },
    entry: {
      loadLive: async () => ({ default: () => null }),
    },
  };
}

describe('game client registry', () => {
  beforeEach(() => {
    registerGameResources.mockClear();
  });

  it('keeps registrations in insertion order and resolves by game id', () => {
    const seti = registration('seti');
    const brass = registration('brass');
    const registry = createGameClientRegistry([seti, brass]);

    expect(registry.get('seti')).toBe(seti);
    expect(registry.get(undefined)).toBeUndefined();
    expect(registry.list()).toEqual([seti, brass]);
  });

  it('rejects duplicate game ids at creation and registration time', () => {
    const seti = registration('seti');

    expect(() =>
      createGameClientRegistry([seti, registration('seti')]),
    ).toThrow('Duplicate game client registration: seti');

    const registry = createGameClientRegistry([seti]);
    expect(() => registry.register(registration('seti'))).toThrow(
      'Duplicate game client registration: seti',
    );
  });

  it('registers game-owned locale catalogs with the platform i18n backend', () => {
    const locales = {
      en: { platform: { games: { sample: { name: 'Sample' } } } },
    } as const;

    createGameClientRegistry([registration('sample', locales)]);

    expect(registerGameResources).toHaveBeenCalledWith('sample', locales);
  });

  it('registers locale catalogs for games added after creation', () => {
    const locales = {
      en: { platform: { games: { sample: { name: 'Sample' } } } },
    } as const;
    const registry = createGameClientRegistry();

    registry.register(registration('sample', locales));

    expect(registerGameResources).toHaveBeenCalledWith('sample', locales);
  });

  it('rejects game pages that collide with shared sections or escape their path', () => {
    const load = async () => ({ default: () => null });
    for (const id of ['lobby', 'achievements', '../admin', 'a/b']) {
      expect(() =>
        createGameClientRegistry([
          { ...registration('sample'), pages: [{ id, labelKey: id, load }] },
        ]),
      ).toThrow('Invalid or duplicate game page');
    }
    expect(() =>
      createGameClientRegistry([
        {
          ...registration('sample'),
          administration: [
            { id: 'skins', labelKey: 'Skins', load },
            { id: 'skins', labelKey: 'Duplicate', load },
          ],
        },
      ]),
    ).toThrow('Invalid or duplicate game administration page');
  });
});
