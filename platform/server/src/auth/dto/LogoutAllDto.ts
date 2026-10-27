import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** Password proof required before revoking every account session. */
export class LogoutAllDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1024)
  currentPassword!: string;
}
