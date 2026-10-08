import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { NyxBootstrapService } from './bootstrap.service';
import { NyxCliRegistryService } from './cli-registry.service';
import { NyxCommandResolver } from './command-resolver';
import { NyxResourceResolver } from './resource-resolver.service';
import { NyxResourceStore } from './resource-store.service';
import { HandoffStore } from './handoff-store.service';
import { NyxCommandExecutor } from './command-executor.service';
import { NyxController } from './nyx.controller';
@Module({ imports: [StorageModule], controllers: [NyxController], providers: [NyxBootstrapService, NyxCliRegistryService, NyxCommandResolver, NyxResourceResolver, NyxResourceStore, HandoffStore, NyxCommandExecutor], exports: [NyxCommandExecutor] })
export class NyxModule {}
