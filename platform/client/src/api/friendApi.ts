import type {
  ICreateFriendRequest,
  IFriendListResponse,
  IFriendRequest,
  IFriendRequestsResponse,
  IFriendSearchResponse,
} from '@board-platform/contracts/types/protocol/friends';
import { httpClient } from '@/api/httpClient';

export const friendApi = {
  search: async (query: string): Promise<IFriendSearchResponse> => {
    const res = await httpClient.get<IFriendSearchResponse>('/friends/search', {
      params: { q: query },
    });
    return res.data;
  },

  listFriends: async (): Promise<IFriendListResponse> => {
    const res = await httpClient.get<IFriendListResponse>('/friends');
    return res.data;
  },

  listRequests: async (): Promise<IFriendRequestsResponse> => {
    const res =
      await httpClient.get<IFriendRequestsResponse>('/friends/requests');
    return res.data;
  },

  sendRequest: async (targetUserId: string): Promise<IFriendRequest> => {
    const payload: ICreateFriendRequest = { targetUserId };
    const res = await httpClient.post<IFriendRequest>(
      '/friends/requests',
      payload,
    );
    return res.data;
  },

  acceptRequest: async (requestId: string): Promise<IFriendRequest> => {
    const res = await httpClient.post<IFriendRequest>(
      `/friends/requests/${requestId}/accept`,
    );
    return res.data;
  },

  declineRequest: async (requestId: string): Promise<void> => {
    await httpClient.post(`/friends/requests/${requestId}/decline`);
  },

  /**
   * Withdraws a request you sent. Distinct from `declineRequest`, which the
   * server only accepts from the recipient.
   */
  cancelRequest: async (requestId: string): Promise<void> => {
    await httpClient.post(`/friends/requests/${requestId}/cancel`);
  },

  removeFriend: async (friendUserId: string): Promise<void> => {
    await httpClient.delete(`/friends/${friendUserId}`);
  },
};
