import { IsNotEmpty, IsString } from 'class-validator';

export class LoginDto {
  /** Email address or username; retain the existing wire key. */
  @IsString()
  @IsNotEmpty()
  email!: string;

  @IsString()
  password!: string;
}
