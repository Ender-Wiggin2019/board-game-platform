import { Public } from '@board-platform/server/auth/public.decorator.js';
import {
  PLATFORM_CONFIGURATION,
  type PlatformPublicConfiguration,
} from '@board-platform/server/platform/platform-configuration.js';
import { Controller, Get, Header, Inject } from '@nestjs/common';

@Controller('platform/config')
export class PublicConfigurationController {
  constructor(
    @Inject(PLATFORM_CONFIGURATION)
    private readonly configuration: PlatformPublicConfiguration,
  ) {}

  @Public()
  @Get()
  @Header('Cache-Control', 'no-store')
  get(): PlatformPublicConfiguration {
    return this.configuration;
  }
}
