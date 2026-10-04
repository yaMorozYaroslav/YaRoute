import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ApiKeyGuard } from './common/api-key.guard';
import { HealthController } from './health.controller';
import { InitModule } from './init/init.module';
import { McpModule } from './mcp/mcp.module';
import { StorageModule } from './storage/storage.module';

@Module({
  imports: [StorageModule, InitModule, McpModule],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ApiKeyGuard }],
})
export class AppModule {}
