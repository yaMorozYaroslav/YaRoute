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
      commit: process.env.HEROKU_SLUG_COMMIT ?? require('./build-info.json').commit,
      rclone: version,
      durableJobs: this.jobs.isDurable(),
      // These are configuration/registration flags, not live provider proofs.
      // A deploy is reconnect-ready only after real OAuth/MEGA probes succeed.
      connectorRelease: {
        mode: process.env.NYX_DEPLOYMENT_MODE === 'public' ? 'public_connectors_only' : 'private_compatibility',
        panelRegistered: true,
        googleOAuthConfigured: Boolean(
          process.env.NYX_PUBLIC_URL?.startsWith('https://') &&
          process.env.NYX_GOOGLE_CLIENT_ID && process.env.NYX_GOOGLE_CLIENT_SECRET),
        ownerVaultConfigured: Boolean(process.env.NYX_RCLONE_VAULT_ENABLED === 'true' &&
          process.env.NYX_RCLONE_CREDENTIAL_KEY && process.env.DATABASE_URL),
        megaFormEnabled: process.env.NYX_MEGA_SELF_SERVICE_ENABLED === 'true' &&
          process.env.NYX_RCLONE_VAULT_ENABLED === 'true',
        legacySharedRcloneAllowed: process.env.NYX_DEPLOYMENT_MODE !== 'public',
        multiUserYaroReady: false,
        requiresLiveProviderVerification: true,
      },
    };
  }
}
