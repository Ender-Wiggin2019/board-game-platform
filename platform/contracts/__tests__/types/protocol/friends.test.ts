import { describe, expect, it } from 'vitest';
import type {
  IAccountPublicProfile,
  IFriendRequest,
} from '../../../src/types/protocol/friends.js';
import {
  FRIENDSHIP_STATUSES,
  RELATIONSHIP_STATUSES,
} from '../../../src/types/protocol/friends.js';

describe('account friendship contracts', () => {
  it('keeps relationship and friendship status vocabularies neutral', () => {
    expect(RELATIONSHIP_STATUSES).toEqual([
      'none',
      'friend',
      'outgoing_pending',
      'incoming_pending',
      'self',
    ]);
    expect(FRIENDSHIP_STATUSES).toEqual(['pending', 'accepted']);
  });

  it('models public account fields without game state', () => {
    const alice: IAccountPublicProfile = { id: 'user-1', name: 'Alice' };
    const request: IFriendRequest = {
      id: 'friendship-1',
      fromUser: alice,
      toUser: { id: 'user-2', name: 'Bob' },
      status: 'pending',
      direction: 'outgoing',
      createdAt: '2026-06-19T00:00:00.000Z',
      updatedAt: '2026-06-19T00:00:00.000Z',
    };

    expect(request.fromUser).toEqual(alice);
    expect(request.status).toBe('pending');
  });
});
