import { Module } from '@nestjs/common';
import { AccountExtensionsRegistry } from './account-extensions.js';

@Module({
  providers: [AccountExtensionsRegistry],
  exports: [AccountExtensionsRegistry],
})
export class AccountExtensionsModule {}
