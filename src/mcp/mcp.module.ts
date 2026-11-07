import { ConnectorsModule } from '../connectors/connectors.module';
import { NyxModule } from '../nyx/nyx.module';
import { Module } from '@nestjs/common';
import { InitModule } from '../init/init.module';
import { StorageModule } from '../storage/storage.module';
import { McpAuthService } from './mcp-auth.service';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';
import { RuntimeMaintenanceService } from './runtime-maintenance.service';

@Module({
  imports: [StorageModule, InitModule, NyxModule, ConnectorsModule],
  controllers: [McpController],
  providers: [McpAuthService, McpService, RuntimeMaintenanceService],
})
export class McpModule {}
