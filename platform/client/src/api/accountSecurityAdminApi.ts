import type {
  IAdminAccountSecurityEvent,
  IAdminAccountSecurityList,
  IAdminMigrationReceipt,
} from '@board-platform/contracts/types/protocol/accountSecurityAdmin';
import { httpClient } from './httpClient.js';

export const accountSecurityAdminApi = {
  receipts: async (userId?: string): Promise<IAdminMigrationReceipt[]> => {
    const response = await httpClient.get<
      IAdminAccountSecurityList<IAdminMigrationReceipt>
    >('/platform/admin/account-security/receipts', {
      params: userId ? { userId } : undefined,
    });
    return response.data.items;
  },
  events: async (userId?: string): Promise<IAdminAccountSecurityEvent[]> => {
    const response = await httpClient.get<
      IAdminAccountSecurityList<IAdminAccountSecurityEvent>
    >('/platform/admin/account-security/events', {
      params: userId ? { userId } : undefined,
    });
    return response.data.items;
  },
};
