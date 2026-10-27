import type { IPlatformPerformanceSnapshot } from '@board-platform/contracts/types/protocol/administration';
import { httpClient } from './httpClient.js';

export const platformPerformanceApi = {
  async getSnapshot(): Promise<IPlatformPerformanceSnapshot> {
    const response = await httpClient.get<IPlatformPerformanceSnapshot>(
      '/platform/admin/performance',
      { showServerUpdateDialog: true },
    );
    return response.data;
  },
};
