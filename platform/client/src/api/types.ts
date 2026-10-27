import type { INavigatorAccess } from '@board-platform/contracts/auth/navigator';
import type { ERole } from '@board-platform/contracts/auth/roles';
import type {
  IAccountPreferences,
  TAccountPreferencesPatch,
} from '@board-platform/contracts/types/protocol/accountPreferences';
import type {
  IAuthPublicConfig,
  IChangePasswordRequest,
  IRegisterRequest,
} from '@board-platform/contracts/types/protocol/auth';

/**
 * Game adapters extend this interface with account fields that belong to one
 * game. The platform owns the one runtime user shape and never imports those
 * adapters back.
 */
export interface IAuthUserExtensions {}

/** Game adapters extend account preferences without replacing platform fields. */
export interface IAuthPreferenceExtensions {}

/** Game adapters extend preference patches sent to the account service. */
export interface IAuthPreferencePatchExtensions {}

/** Session user projection shared by every registered game. */
export interface IAuthUser extends IAuthUserExtensions {
  id: string;
  name: string;
  email: string;
  role?: ERole | string;
  /** Stable account role before any time-bound Navigator grant. */
  baseRole?: ERole | string;
  /** Server-authoritative Navigator access projection. */
  navigator?: INavigatorAccess;
  createdAt?: Date | string;
  preferences?: IAccountPreferences & IAuthPreferenceExtensions;
  emailVerifiedAt?: Date | string | null;
}

export interface ILoginRequest {
  /** Email address or username; wire key retained for existing clients. */
  email: string;
  password: string;
}

export interface ILoginResponse {
  token: string;
  user: IAuthUser;
}

export type { IRegisterRequest };

export interface IRegisterResponse {
  token: string;
  user: IAuthUser;
}

export interface IUpdateProfileRequest {
  name?: string;
}

export type IUpdatePreferencesRequest = TAccountPreferencesPatch &
  IAuthPreferencePatchExtensions;

export type { IAuthPublicConfig, IChangePasswordRequest };

export interface IEmailChallengeResponse {
  challengeId: string;
  expiresAt: string;
}

export interface IPasswordResetRequest {
  email: string;
}

export interface IPasswordResetSubmit {
  token: string;
  password: string;
  passwordConfirm: string;
}

export interface IEmailChangeStartRequest {
  email: string;
  currentPassword: string;
}

export interface IEmailChangeConfirmRequest {
  challengeId: string;
  code: string;
}

export interface IEmailChangeConfirmResponse {
  email: string;
  emailKey?: string;
}

export interface ILogoutAllRequest {
  currentPassword: string;
}
