import { Module } from '@nestjs/common';
import { InitModule } from '../init/init.module';
import { StorageModule } from '../storage/storage.module';
import { McpAuthService } from './mcp-auth.service';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';

@Module({
  imports: [StorageModule, InitModule],
  controllers: [McpController],
  providers: [McpAuthService, McpService],
})
export class McpModule {}
