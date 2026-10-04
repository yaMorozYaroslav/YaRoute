import { Controller, Get } from '@nestjs/common';
import { Public } from './common/public.decorator';
import { JobStoreService } from './storage/job-store.service';
import { RcloneService } from './storage/rclone.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly rclone: RcloneService,
    private readonly jobs: JobStoreService,
  ) {}

  @Public()
  @Get()
  async getHealth() {
    const version = await this.rclone.version();
    return {
      ok: true,
      service: 'NestNyx',
      rclone: version,
      durableJobs: this.jobs.isDurable(),
    };
  }
}
