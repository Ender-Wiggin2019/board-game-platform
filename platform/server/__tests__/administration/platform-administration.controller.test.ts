import { ERole } from '@board-platform/contracts/auth/roles';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlatformAdministrationController } from '@/administration/platform-administration.controller.js';
import { UserRepository } from '@/persistence/repository/UserRepository.js';
import type { TUserRow } from '@/persistence/schema/users.js';

const USER = {
  id: 'user-1',
  name: 'Pilot',
  email: 'pilot@example.com',
  role: ERole.PLAYER,
  navigatorGrantedAt: null,
  navigatorExpiresAt: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
} as TUserRow;

describe('PlatformAdministrationController', () => {
  afterEach(() => vi.restoreAllMocks());

  it('lists platform accounts while preserving an explicit role filter', async () => {
    const findPage = vi
      .spyOn(UserRepository.prototype, 'findPage')
      .mockResolvedValue({
        list: [USER],
        total: 1,
        sort: 'createdAt:desc',
      });
    const controller = new PlatformAdministrationController(
      {} as never,
      {} as never,
      {} as never,
    );

    await controller.listUsers(undefined, '25', '1');
    expect(findPage).toHaveBeenNthCalledWith(1, {
      search: undefined,
      role: undefined,
      pageSize: 25,
      pageNum: 1,
      sort: '',
    });

    await controller.listUsers(
      undefined,
      undefined,
      undefined,
      undefined,
      JSON.stringify({ role: ERole.PLAYER }),
    );
    expect(findPage).toHaveBeenNthCalledWith(2, {
      search: undefined,
      role: ERole.PLAYER,
      pageSize: 50,
      pageNum: 1,
      sort: '',
    });
  });
});
