import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { JobStoreService } from './job-store.service';
import { StorageService } from './storage.service';

@Injectable()
export class JobWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobWorkerService.name);
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(
    private readonly jobs: JobStoreService,
    private readonly storage: StorageService,
  ) {}

  onModuleInit() {
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
        const result = await this.storage.executeCopy(job.payload);
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
