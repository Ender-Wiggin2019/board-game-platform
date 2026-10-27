import { IsEmail } from 'class-validator';

export class PasswordForgotDto {
  @IsEmail()
  email!: string;
}
