import { beforeEach, describe, expect, it, vi } from 'vitest';

const httpMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('@/api/httpClient', () => ({ httpClient: httpMocks }));

import { platformAdministrationApi } from '@/api/platformAdministrationApi';

describe('platformAdministrationApi', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps account administration on the platform route and serializes filters', async () => {
    const response = {
      list: [],
      total: 0,
      pageSize: 25,
      pageNum: 1,
      sort: 'createdAt:desc',
    };
    httpMocks.get.mockResolvedValueOnce({ data: response });
    await expect(
      platformAdministrationApi.listUsers({
        search: 'ada',
        pageSize: 25,
        filters: { role: ['admin'] },
      }),
    ).resolves.toEqual(response);
    expect(httpMocks.get).toHaveBeenCalledWith('/platform/admin/users', {
      params: {
        search: 'ada',
        pageSize: 25,
        filters: JSON.stringify({ role: ['admin'] }),
      },
    });
  });

  it('encodes account ids for role mutations', async () => {
    const user = {
      id: 'user/1',
      name: 'Ada',
      email: 'ada@example.com',
      role: 'player',
      baseRole: 'player',
      navigator: { active: false, source: null, expiresAt: null },
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    };
    httpMocks.patch.mockResolvedValueOnce({ data: user });
    await platformAdministrationApi.setUserRole('user/1', 'player');
    expect(httpMocks.patch).toHaveBeenCalledWith(
      '/platform/admin/users/user%2F1/role',
      { role: 'player' },
    );
  });

  it('loads secret-free release reconciliation from the admin route', async () => {
    const response = {
      schemaVersion: 1,
      platformId: 'platform-test',
      generatedAt: 1_735_000_000_000,
      desiredConfigured: false,
      desired: [],
      actual: { releases: [], bindings: [], channels: [] },
      differences: [],
      channelHistory: [],
    };
    httpMocks.get.mockResolvedValueOnce({ data: response });

    await expect(
      platformAdministrationApi.getReleaseReconciliation(),
    ).resolves.toEqual(response);
    expect(httpMocks.get).toHaveBeenCalledWith(
      '/platform/admin/releases/reconciliation',
    );
  });
});
