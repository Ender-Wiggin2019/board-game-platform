/** Relationship state for an account pair from the current viewer's side. */
export const RELATIONSHIP_STATUSES = [
  'none',
  'friend',
  'outgoing_pending',
  'incoming_pending',
  'self',
] as const;

export type TRelationshipStatus = (typeof RELATIONSHIP_STATUSES)[number];

export const FRIENDSHIP_STATUSES = ['pending', 'accepted'] as const;

export type TFriendshipStatus = (typeof FRIENDSHIP_STATUSES)[number];

/** Account fields safe to display in a social relationship or public profile. */
export interface IAccountPublicProfile {
  id: string;
  name: string;
}

/** Backward-compatible social name for the neutral public account projection. */
export type IFriendPublicUser = IAccountPublicProfile;

export interface IFriendSearchResult extends IAccountPublicProfile {
  relationshipStatus: TRelationshipStatus;
}

export interface IFriendListItem extends IAccountPublicProfile {
  relationshipStatus: 'friend';
  friendsSince: string;
}

export interface IFriendRequest {
  id: string;
  fromUser: IAccountPublicProfile;
  toUser: IAccountPublicProfile;
  status: TFriendshipStatus;
  direction: 'incoming' | 'outgoing';
  createdAt: string;
  updatedAt: string;
}

export interface IFriendSearchResponse {
  items: IFriendSearchResult[];
}

export interface IFriendListResponse {
  items: IFriendListItem[];
}

export interface IFriendRequestsResponse {
  incoming: IFriendRequest[];
  outgoing: IFriendRequest[];
}

export interface ICreateFriendRequest {
  targetUserId: string;
}
