import { beforeEach, describe, expect, it, vi } from 'vitest';

const httpMocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('@/api/httpClient.js', () => ({ httpClient: httpMocks }));

import { platformPerformanceApi } from '@/api/platformPerformanceApi.js';

describe('platformPerformanceApi', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requests the platform-wide performance snapshot', async () => {
    const snapshot = { capturedAt: '2026-10-26T12:00:00.000Z' };
    httpMocks.get.mockResolvedValueOnce({ data: snapshot });

    await expect(platformPerformanceApi.getSnapshot()).resolves.toEqual(
      snapshot,
    );
    expect(httpMocks.get).toHaveBeenCalledWith('/platform/admin/performance', {
      showServerUpdateDialog: true,
    });
  });
});
