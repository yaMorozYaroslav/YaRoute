import { NyxModule } from '../nyx/nyx.module';
import { BootstrapAuditService } from './bootstrap-audit.service';
import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { InitController } from './init.controller';
import { InitService } from './init.service';
import { InitSessionStoreService } from './init-session-store.service';

@Module({
  imports: [StorageModule, NyxModule],
  controllers: [InitController],
  providers: [InitService, InitSessionStoreService, BootstrapAuditService],
  exports: [InitService, InitSessionStoreService],
})
export class InitModule {}
