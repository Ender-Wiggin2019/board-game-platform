import type { INavigatorAccess } from '../../auth/navigator.js';
import type { ERole } from '../../auth/roles.js';
import type { TUserLanguage } from './userLanguage.js';

/**
 * Authenticated account identity shared by the platform and game adapters.
 * Game-owned profile fields (cosmetics, progression, game guides, and game
 * preferences) are projected by an adapter-specific extension.
 */
export interface IUserProfile {
  id: string;
  name: string;
  email: string;
  role: ERole;
  baseRole: ERole;
  navigator: INavigatorAccess;
  createdAt: Date | string;
  emailVerifiedAt?: Date | string | null;
}

/** Explicit neutral name for new platform code. */
export type IAccountProfile = IUserProfile;

export interface IChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

export interface IAuthPublicConfig {
  adminContact: string;
}

/** Registration records an email without verifying ownership or sending mail. */
export interface IRegisterRequest {
  email: string;
  name: string;
  password: string;
  passwordConfirm: string;
  consentVersion: string;
  /** Interface language retained by the account service. */
  language?: TUserLanguage;
}
