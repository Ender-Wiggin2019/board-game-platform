import { httpClient } from '@/api/httpClient.js';

export interface IPushConfig {
  configured: boolean;
  publicKey: string | null;
  deviceCount: number;
}

/** Web Push subscription endpoints for authenticated PLAYER+ accounts. */
export const pushApi = {
  async getConfig(): Promise<IPushConfig> {
    const { data } = await httpClient.get<IPushConfig>('/push/config');
    return data;
  },

  /** Persist the account opt-in before attempting optional Web Push setup. */
  async enable(): Promise<void> {
    await httpClient.post('/push/enable');
  },

  async subscribe(
    subscription: PushSubscriptionJSON,
    mode: 'enable' | 'refresh',
  ): Promise<void> {
    await httpClient.post('/push/subscribe', { ...subscription, mode });
  },

  /** Omit `endpoint` to remove every device for the account. */
  async unsubscribe(endpoint?: string, timeout?: number): Promise<void> {
    await httpClient.delete('/push/subscribe', {
      data: endpoint ? { endpoint } : {},
      timeout,
    });
  },

  async sendTest(): Promise<number> {
    const { data } = await httpClient.post<{ delivered: number }>('/push/test');
    return data.delivered;
  },
};
