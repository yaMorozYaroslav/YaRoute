import { Controller, Get } from '@nestjs/common';
import { Public } from './common/public.decorator';
import { JobStoreService } from './storage/job-store.service';
import { RcloneService } from './storage/rclone.service';
import { composeRuntimeHealthReport, fetchPublicGitHubEvidence } from './mcp/runtime-health-report';

@Controller('health')
export class HealthController {
  constructor(
    private readonly rclone: RcloneService,
    private readonly jobs: JobStoreService,
  ) {}

  /** Public metadata only; does not resolve private Head, Drive or Rclone roots. */
  @Public()
  @Get('checklist')
  async getChecklist() {
    const runtimeCommit = process.env.HEROKU_SLUG_COMMIT || (() => {
      try { return (require('./build-info.json') as { commit?: string }).commit || ''; }
      catch { return ''; }
    })();
    const evidence = await fetchPublicGitHubEvidence(runtimeCommit);
    return composeRuntimeHealthReport({
      runtimeCommit,
      service: process.env.NYX_SERVICE_NAME?.trim() || 'NestNyx',
      deploymentMode: 'public',
    }, evidence);
  }

  @Public()
  @Get()
  async getHealth() {
    const version = await this.rclone.version();
    return {
      ok: true,
      service: process.env.NYX_SERVICE_NAME?.trim() || 'NestNyx',
      commit: process.env.HEROKU_SLUG_COMMIT ?? require('./build-info.json').commit,
      rclone: version,
      durableJobs: this.jobs.isDurable(),
    };
  }
}
