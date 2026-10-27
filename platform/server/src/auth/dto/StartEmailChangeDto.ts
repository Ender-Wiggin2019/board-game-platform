import { IsEmail, IsString, MaxLength } from 'class-validator';

export class StartEmailChangeDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MaxLength(1024)
  currentPassword!: string;
}
