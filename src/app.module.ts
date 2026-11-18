import { ConnectorsModule } from './connectors/connectors.module';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ApiKeyGuard } from './common/api-key.guard';
import { HealthController } from './health.controller';
import { BrandingController } from './branding.controller';
import { InitModule } from './init/init.module';
import { McpModule } from './mcp/mcp.module';
import { StorageModule } from './storage/storage.module';

@Module({
  imports: [StorageModule, InitModule, McpModule, ConnectorsModule],
  controllers: [HealthController, BrandingController],
  providers: [{ provide: APP_GUARD, useClass: ApiKeyGuard }],
})
export class AppModule {}
