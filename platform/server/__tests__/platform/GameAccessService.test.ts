import { describe, expect, it } from 'vitest';
import {
  GameAccessRegistry,
  GameAccessService,
} from '@/platform/game-access/service.js';
import {
  gameAccessMigrationStatements,
  MemoryGameAccessStore,
} from '@/platform/game-access/store.js';

const registration = {
  gameId: 'fixture-game',
  releaseId: 'fixture-v1',
  entitlements: [
    {
      entitlement: 'beta-access',
      label: 'Beta access',
    },
  ],
  requiredEntitlement: 'beta-access',
} as const;

function service() {
  const access = new GameAccessService(new MemoryGameAccessStore());
  access.register(registration);
  return access;
}

describe('GameAccessService', () => {
  it('issues one-time-visible codes and makes repeated redemption idempotent', async () => {
    const access = service();
    const issued = await access.createCode({
      actorId: 'admin-1',
      gameId: registration.gameId,
      entitlement: 'beta-access',
      maxUses: 2,
      now: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(issued.code).toHaveLength(16);
    expect((await access.listCodes(registration.gameId))[0]).toMatchObject({
      codeId: issued.summary.codeId,
      usedCount: 0,
      maxUses: 2,
    });
    expect(JSON.stringify(issued.summary)).not.toContain(issued.code);

    const first = await access.redeem(
      registration.gameId,
      'player-1',
      issued.code,
    );
    const repeated = await access.redeem(
      registration.gameId,
      'player-1',
      issued.code.toLowerCase(),
    );
    expect(repeated).toEqual(first);
    expect(await access.grants(registration.gameId, 'player-1')).toHaveLength(
      1,
    );
    expect(
      await access.allows(
        registration.gameId,
        registration.releaseId,
        'player-1',
      ),
    ).toBe(true);
    expect((await access.listCodes(registration.gameId))[0]?.usedCount).toBe(1);
  });

  it('enforces expiry, usage limits, and code revocation while retaining grants', async () => {
    const access = service();
    const issued = await access.createCode({
      actorId: 'admin-1',
      gameId: registration.gameId,
      entitlement: 'beta-access',
      maxUses: 1,
      expiresAt: new Date('2027-01-02T00:00:00.000Z'),
      now: new Date('2027-01-01T00:00:00.000Z'),
    });
    await access.redeem(registration.gameId, 'player-1', issued.code);
    await expect(
      access.redeem(registration.gameId, 'player-2', issued.code),
    ).rejects.toMatchObject({
      envelope: {
        code: 'CONFLICT',
        messageKey: 'platform.game_access.code_exhausted',
      },
    });
    await access.revokeCode(
      registration.gameId,
      issued.summary.codeId,
      new Date('2027-01-01T12:00:00.000Z'),
    );
    expect(
      await access.allows(
        registration.gameId,
        registration.releaseId,
        'player-1',
      ),
    ).toBe(true);
    await expect(
      access.redeem(registration.gameId, 'player-3', issued.code),
    ).rejects.toMatchObject({
      envelope: {
        code: 'CONFLICT',
        messageKey: 'platform.game_access.code_revoked',
      },
    });
  });

  it('maps revocation of an unknown code to the public conflict contract', async () => {
    const access = service();

    await expect(
      access.revokeCode(registration.gameId, 'missing-code'),
    ).rejects.toMatchObject({
      envelope: {
        code: 'CONFLICT',
        messageKey: 'platform.game_access.code_not_found',
      },
    });
  });

  it('leaves unregistered game releases public', async () => {
    const access = new GameAccessService(new MemoryGameAccessStore());
    expect(await access.allows('public-game', 'public-v1', 'player-1')).toBe(
      true,
    );
  });
});

describe('GameAccessRegistry', () => {
  it('rejects a required entitlement that is absent from the catalog', () => {
    const registry = new GameAccessRegistry();
    expect(() =>
      registry.register({
        gameId: 'fixture-game',
        releaseId: 'fixture-v1',
        entitlements: [],
        requiredEntitlement: 'missing',
      }),
    ).toThrow('platform.game_access.required_entitlement');
  });
});

describe('game access migration', () => {
  it('persists hashed codes, grants, usage counters, and audit source keys', () => {
    const statements = gameAccessMigrationStatements().join('\n');
    expect(statements).toContain('"board_platform_game_access"."codes"');
    expect(statements).toContain('code_hash TEXT NOT NULL UNIQUE');
    expect(statements).toContain('"board_platform_game_access"."grants"');
    expect(statements).toContain('UNIQUE (code_id, principal_id)');
    expect(statements).toContain('source_record_id TEXT NOT NULL UNIQUE');
  });
});
