import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { InitController } from './init.controller';
import { InitService } from './init.service';
import { InitSessionStoreService } from './init-session-store.service';

@Module({
  imports: [StorageModule],
  controllers: [InitController],
  providers: [InitService, InitSessionStoreService],
  exports: [InitService, InitSessionStoreService],
})
export class InitModule {}
