import { IsString, IsUUID, Matches } from 'class-validator';

export class ConfirmEmailChangeDto {
  @IsUUID()
  challengeId!: string;

  @IsString()
  @Matches(/^\d{6}$/)
  code!: string;
}
