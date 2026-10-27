import { ECapability } from '@board-platform/contracts/auth/permissions';
import type { IAuthPublicConfig } from '@board-platform/contracts/types/protocol/auth';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Put,
  UseGuards,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DRIZZLE_DB } from '@/persistence/drizzle.module.js';
import { appSettings } from '@/persistence/schema/appSettings.js';
import { Capabilities } from './capabilities.decorator.js';
import { Public } from './public.decorator.js';
import { RolesGuard } from './roles.guard.js';

const ADMIN_CONTACT_KEY = 'adminContact';
const DEFAULT_ADMIN_CONTACT = 'QQ: 209926937';

@Controller('auth/config')
export class AuthConfigController {
  constructor(@Inject(DRIZZLE_DB) private readonly db: NodePgDatabase) {}

  @Public()
  @Get()
  async getConfig(): Promise<IAuthPublicConfig> {
    const [setting] = await this.db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, ADMIN_CONTACT_KEY))
      .limit(1);
    return { adminContact: setting?.value ?? DEFAULT_ADMIN_CONTACT };
  }

  @Put()
  @UseGuards(RolesGuard)
  @Capabilities(ECapability.USER_MANAGE)
  async updateConfig(
    @Body() body: Partial<IAuthPublicConfig>,
  ): Promise<IAuthPublicConfig> {
    const adminContact = body?.adminContact;
    if (
      typeof adminContact !== 'string' ||
      !adminContact.trim() ||
      adminContact.trim().length > 300
    ) {
      throw new BadRequestException(
        'Administrator contact must contain 1 to 300 characters',
      );
    }
    const value = adminContact.trim();
    await this.db
      .insert(appSettings)
      .values({ key: ADMIN_CONTACT_KEY, value })
      .onConflictDoUpdate({ target: appSettings.key, set: { value } });
    return { adminContact: value };
  }
}
