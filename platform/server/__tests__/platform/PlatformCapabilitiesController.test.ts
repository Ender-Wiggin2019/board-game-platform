import { contractError } from '@board-game/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { GameCapabilityService } from '@/platform/capabilities/index.js';
import type { PlatformApplicationRuntime } from '@/platform/PlatformApplicationRuntime.js';
import { PlatformCapabilitiesController } from '@/platform/platform-capabilities.controller.js';

function fixture() {
  const missingPrincipal = '00000000-0000-4000-8000-000000000001';
  const suspendedPrincipal = '00000000-0000-4000-8000-000000000002';
  const publicAccount = vi.fn(async (principalId: string) => {
    if (principalId === missingPrincipal || principalId === suspendedPrincipal)
      throw contractError('NOT_FOUND', 'platform.identity.public_account');
    return { id: principalId, accountStatus: 'active' };
  });
  const identity = {
    resolve: async () => ({ principalId: 'account-user' }),
    resolvePublicAccount: publicAccount,
  };
  const platform = {
    accountIdentity: () => identity,
    game: (gameId: string) => ({ gameId, releaseId: `${gameId}-active` }),
  } as unknown as PlatformApplicationRuntime;
  const capabilities = {
    list: vi.fn(() => [
      { metadata: { gameId: 'seti' }, releaseId: 'seti-active' },
      { metadata: { gameId: 'seti' }, releaseId: 'seti-retained' },
    ]),
    getProfile: vi.fn(async (_gameId, _releaseId, principalId) => ({
      principalId,
      displayName: 'Player',
      wallet: { assets: [{ available: 42 }] },
    })),
    getAchievements: vi.fn(async () => ({ items: [] })),
    getWallet: vi.fn(async () => ({ assets: [] })),
    getRankings: vi.fn(async () => ({ entries: [] })),
  };
  return {
    controller: new PlatformCapabilitiesController(
      platform,
      capabilities as unknown as GameCapabilityService,
    ),
    capabilities,
    identity,
    missingPrincipal,
    suspendedPrincipal,
  };
}
const request = { user: { sub: 'token-user', sid: 'session' } } as never;
const publicTarget = '00000000-0000-4000-8000-000000000003';

describe('public game capabilities', () => {
  it('lists only current registered game releases', () => {
    const { controller, capabilities } = fixture();
    expect(controller.catalog()).toEqual([
      { metadata: { gameId: 'seti' }, releaseId: 'seti-active' },
    ]);
    expect(capabilities.list).toHaveBeenCalledOnce();
  });

  it('projects registry-backed remote releases without trusting manifest capabilities', async () => {
    const capabilities = {
      list: vi.fn(() => []),
    };
    const platform = {
      options: { platformId: 'independent-platform' },
      releaseRegistry: {
        listReleases: vi.fn(async () => [
          {
            gameId: 'remote-game',
            releaseId: 'remote-v1',
            service: {
              metadata: {
                gameId: 'remote-game',
                name: 'Remote game',
                description: 'Remote release',
                themeId: 'remote',
              },
            },
          },
        ]),
      },
    } as unknown as PlatformApplicationRuntime;
    const releases = {
      platformCatalog: vi.fn(async () => [
        {
          gameId: 'remote-game',
          releaseId: 'remote-v1',
          mode: {},
          metadata: {},
        },
      ]),
    };
    const controller = new PlatformCapabilitiesController(
      platform,
      capabilities as unknown as GameCapabilityService,
      releases as never,
    );

    await expect(controller.catalog()).resolves.toEqual([
      {
        metadata: {
          gameId: 'remote-game',
          name: 'Remote game',
          description: 'Remote release',
          themeId: 'remote',
        },
        releaseId: 'remote-v1',
        capabilities: [],
        policyVersions: [],
        assets: [],
      },
    ]);
  });

  it('exposes only the selected registry release while retaining embedded entries', async () => {
    const embedded = {
      metadata: { gameId: 'embedded-game', name: 'Embedded game' },
      releaseId: 'embedded-v1',
      capabilities: [],
      policyVersions: [],
      assets: [],
    };
    const remoteV1 = {
      metadata: { gameId: 'remote-game', name: 'Remote v1' },
      releaseId: 'remote-v1',
      capabilities: ['legacy'],
      policyVersions: [],
      assets: [],
    };
    const remoteV2 = {
      metadata: { gameId: 'remote-game', name: 'Remote v2' },
      releaseId: 'remote-v2',
      capabilities: ['current'],
      policyVersions: [],
      assets: [],
    };
    const capabilities = {
      list: vi.fn(() => [embedded, remoteV1, remoteV2]),
    };
    const platform = {
      options: { platformId: 'independent-platform' },
      releaseGame: vi.fn((gameId: string, releaseId: string) => ({
        gameId,
        releaseId,
      })),
      releaseRegistry: {
        listReleases: vi.fn(async () => [
          {
            gameId: 'remote-game',
            releaseId: 'remote-v1',
            service: { metadata: remoteV1.metadata },
          },
          {
            gameId: 'remote-game',
            releaseId: 'remote-v2',
            service: { metadata: remoteV2.metadata },
          },
        ]),
      },
    } as unknown as PlatformApplicationRuntime;
    const releases = {
      platformCatalog: vi.fn(async () => [
        {
          gameId: 'remote-game',
          releaseId: 'remote-v2',
          mode: {},
          metadata: {},
        },
      ]),
    };
    const controller = new PlatformCapabilitiesController(
      platform,
      capabilities as unknown as GameCapabilityService,
      releases as never,
    );

    await expect(controller.catalog()).resolves.toEqual([embedded, remoteV2]);
  });

  it('hides all registry-backed releases when no public channel is selected', async () => {
    const embedded = {
      metadata: { gameId: 'embedded-game', name: 'Embedded game' },
      releaseId: 'embedded-v1',
      capabilities: [],
      policyVersions: [],
      assets: [],
    };
    const remote = {
      metadata: { gameId: 'remote-game', name: 'Remote game' },
      releaseId: 'remote-v1',
      capabilities: [],
      policyVersions: [],
      assets: [],
    };
    const capabilities = {
      list: vi.fn(() => [embedded, remote]),
    };
    const platform = {
      options: { platformId: 'independent-platform' },
      releaseGame: vi.fn((gameId: string, releaseId: string) => ({
        gameId,
        releaseId,
      })),
      releaseRegistry: {
        listReleases: vi.fn(async () => [
          {
            gameId: 'remote-game',
            releaseId: 'remote-v1',
            service: { metadata: remote.metadata },
          },
        ]),
      },
    } as unknown as PlatformApplicationRuntime;
    const releases = {
      platformCatalog: vi.fn(async () => []),
    };
    const controller = new PlatformCapabilitiesController(
      platform,
      capabilities as unknown as GameCapabilityService,
      releases as never,
    );

    await expect(controller.catalog()).resolves.toEqual([embedded]);
  });

  it('uses current identity and a server-selected active release for wallet reads', async () => {
    const { controller, capabilities } = fixture();
    await controller.wallet(request, 'brass-pittsburgh');
    expect(capabilities.getWallet).toHaveBeenCalledWith(
      'brass-pittsburgh',
      'brass-pittsburgh-active',
      'account-user',
    );
    await expect(
      controller.wallet(request, 'brass-pittsburgh', {
        principalId: 'another',
      }),
    ).rejects.toMatchObject({ envelope: { code: 'INVALID_REQUEST' } });
  });
  it('omits private currency balances from another player profile', async () => {
    const { controller } = fixture();
    expect(await controller.profile(request, 'seti')).toHaveProperty('wallet');
    expect(
      await controller.profile(request, 'seti', { principalId: publicTarget }),
    ).not.toHaveProperty('wallet');
  });

  it('resolves a public target before reading profile or achievements', async () => {
    const { controller, capabilities, identity } = fixture();
    await controller.profile(request, 'seti', { principalId: publicTarget });
    await controller.achievements(request, 'seti', {
      principalId: publicTarget,
    });
    expect(identity.resolvePublicAccount).toHaveBeenCalledWith(publicTarget);
    expect(capabilities.getProfile).toHaveBeenCalledWith(
      'seti',
      'seti-active',
      publicTarget,
    );
    expect(capabilities.getAchievements).toHaveBeenCalledWith(
      'seti',
      'seti-active',
      publicTarget,
    );
  });

  it('rejects missing or suspended public targets before capability reads', async () => {
    const { controller, capabilities, missingPrincipal, suspendedPrincipal } =
      fixture();
    await expect(
      controller.profile(request, 'seti', { principalId: missingPrincipal }),
    ).rejects.toMatchObject({ envelope: { code: 'NOT_FOUND' } });
    await expect(
      controller.achievements(request, 'seti', {
        principalId: suspendedPrincipal,
      }),
    ).rejects.toMatchObject({ envelope: { code: 'NOT_FOUND' } });
    expect(capabilities.getProfile).not.toHaveBeenCalled();
    expect(capabilities.getAchievements).not.toHaveBeenCalled();
  });
  it('rejects absent authentication and backend/release overrides', async () => {
    const { controller, capabilities } = fixture();
    await expect(controller.wallet({} as never, 'seti')).rejects.toMatchObject({
      envelope: { code: 'UNAUTHENTICATED' },
    });
    await expect(
      controller.profile(request, 'seti', { releaseId: 'browser-release' }),
    ).rejects.toMatchObject({ envelope: { code: 'INVALID_REQUEST' } });
    expect(capabilities.getProfile).not.toHaveBeenCalled();
  });

  it('reads rankings for the current identity and selected release', async () => {
    const { controller, capabilities } = fixture();
    await controller.rankings(request, 'seti');
    expect(capabilities.getRankings).toHaveBeenCalledWith(
      'seti',
      'seti-active',
      'account-user',
    );
  });

  it('does not read rankings when the platform feature is disabled', async () => {
    const { capabilities } = fixture();
    const platform = {
      accountIdentity: () => ({
        resolve: async () => ({ principalId: 'account-user' }),
      }),
      game: (gameId: string) => ({ gameId, releaseId: `${gameId}-active` }),
    } as unknown as PlatformApplicationRuntime;
    const controller = new PlatformCapabilitiesController(
      platform,
      capabilities as unknown as GameCapabilityService,
      undefined,
      {
        brand: { name: 'Orbit Table' },
        features: { chat: true, rankings: false },
      },
    );
    await expect(controller.rankings(request, 'seti')).rejects.toMatchObject({
      envelope: {
        code: 'NOT_FOUND',
        messageKey: 'platform.feature.rankings.disabled',
      },
    });
    expect(capabilities.getRankings).not.toHaveBeenCalled();
  });
});
