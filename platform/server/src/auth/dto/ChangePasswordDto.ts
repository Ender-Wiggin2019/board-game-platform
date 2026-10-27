import { ACCOUNT_PASSWORD_MIN_CODE_POINTS } from '@board-platform/contracts/auth/accountRules';
import type { IChangePasswordRequest } from '@board-platform/contracts/types/protocol/auth';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export class ChangePasswordDto implements IChangePasswordRequest {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1024)
  currentPassword!: string;

  @IsString()
  @MinLength(ACCOUNT_PASSWORD_MIN_CODE_POINTS)
  @MaxLength(128)
  newPassword!: string;

  @IsString()
  @MinLength(ACCOUNT_PASSWORD_MIN_CODE_POINTS)
  @MaxLength(128)
  passwordConfirm!: string;
}
