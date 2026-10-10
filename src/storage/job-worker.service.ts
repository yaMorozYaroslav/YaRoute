import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { JobStoreService } from './job-store.service';
import { StorageService } from './storage.service';
import { CopyJobPayload, GlobalIndexJobPayload } from './storage.types';

@Injectable()
export class JobWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobWorkerService.name);
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(
    private readonly jobs: JobStoreService,
    private readonly storage: StorageService,
  ) {}

  async onModuleInit() {
    // Legacy global-storage jobs may contain unscoped Rclone roots; do not
    // process them alongside public multi-user connector traffic.
    if (process.env.NYX_DEPLOYMENT_MODE === 'public' &&
        process.env.NYX_PUBLIC_CONNECTORS_ENABLED === 'true') return;
    if (process.env.NYX_GLOBAL_INDEX_ON_BOOT === 'true') {
      const job = await this.jobs.createGlobalIndex({ snapshot: true });
      this.logger.log(`Queued boot global-index job ${job.id}`);
    }

    this.timer = setInterval(() => void this.tick(), 2000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const job = await this.jobs.claimNext();
      if (!job) return;

      try {
        let result: unknown;
        if (job.type === 'copy-file') {
          result = await this.storage.executeCopy(job.payload as CopyJobPayload);
        } else if (job.type === 'global-index') {
          result = await this.storage.executeGlobalIndex(job.payload as GlobalIndexJobPayload);
        } else {
          throw new Error(`Unsupported storage job type: ${job.type}`);
        }
        await this.jobs.succeed(job.id, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Job ${job.id} failed: ${message}`);
        await this.jobs.fail(job.id, message);
      }
    } finally {
      this.busy = false;
    }
  }
}
