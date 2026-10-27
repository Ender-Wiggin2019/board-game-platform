import { ACCOUNT_PASSWORD_MIN_CODE_POINTS } from '@board-platform/contracts/auth/accountRules';
import type { IRegisterRequest } from '@board-platform/contracts/types/protocol/auth';
import {
  SUPPORTED_USER_LANGUAGES,
  type TUserLanguage,
} from '@board-platform/contracts/types/protocol/userLanguage';
import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class RegisterDto implements IRegisterRequest {
  @IsEmail()
  email!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @MinLength(ACCOUNT_PASSWORD_MIN_CODE_POINTS)
  @MaxLength(128)
  password!: string;

  @IsString()
  @MinLength(ACCOUNT_PASSWORD_MIN_CODE_POINTS)
  @MaxLength(128)
  passwordConfirm!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  consentVersion!: string;

  @ValidateIf((_object: object, value: unknown) => value !== undefined)
  @IsIn(SUPPORTED_USER_LANGUAGES)
  language?: TUserLanguage;
}
