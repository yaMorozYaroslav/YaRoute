import { Module } from '@nestjs/common';
import { StorageConnectionsService } from './storage-connections.service';
import { RcloneCredentialVaultService } from './rclone-credential-vault.service';
import { JobStoreService } from './job-store.service';
import { JobWorkerService } from './job-worker.service';
import { RcloneService } from './rclone.service';
import { SharedRootsService } from './shared-roots.service';
import { StorageController } from './storage.controller';
import { StorageService } from './storage.service';

@Module({
  controllers: [StorageController],
  providers: [StorageConnectionsService, RcloneCredentialVaultService, RcloneService, SharedRootsService, StorageService, JobStoreService, JobWorkerService],
  exports: [StorageConnectionsService, RcloneCredentialVaultService, RcloneService, SharedRootsService, StorageService, JobStoreService],
})
export class StorageModule {}
