import type { ERole, TInviteCodeGrantRole } from '../../auth/roles.js';
import type { IListQuery, IListResponse } from './list.js';

export type IAdminTableQuery = IListQuery;
export type IAdminTableResponse<T> = IListResponse<T>;

export interface IAdminInviteCodeSummary {
  id: string;
  code: string;
  /** Navigator values are retained only for historical disabled codes. */
  role: TInviteCodeGrantRole | ERole.NAVIGATOR;
  expiresAt: Date | string | null;
  maxUses: number | null;
  usedCount: number;
  disabledAt: Date | string | null;
  createdByUserId: string;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface IGenerateInviteCodeRequest {
  role: TInviteCodeGrantRole;
  expiresAt: Date | string | null;
  maxUses: number | null;
  /** Omit or leave blank to generate a random code. */
  code?: string;
}

export const CUSTOM_INVITE_CODE_PATTERN = /^[A-Za-z0-9]{6,32}$/;

export interface IRedeemInviteCodeRequest {
  code: string;
}
