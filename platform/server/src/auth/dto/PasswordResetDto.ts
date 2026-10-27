import { ACCOUNT_PASSWORD_MIN_CODE_POINTS } from '@board-platform/contracts/auth/accountRules';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class PasswordResetDto {
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  token!: string;

  @IsString()
  @MinLength(ACCOUNT_PASSWORD_MIN_CODE_POINTS)
  @MaxLength(128)
  password!: string;

  @IsString()
  @MinLength(ACCOUNT_PASSWORD_MIN_CODE_POINTS)
  @MaxLength(128)
  passwordConfirm!: string;
}
