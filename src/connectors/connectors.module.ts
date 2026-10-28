import { Module } from '@nestjs/common';
import { ConnectorsService } from './connectors.service';
import { TenantRcloneService } from './tenant-rclone.service';
import { TenantGoogleOAuthService } from './tenant-google-oauth.service';
import { TenantMegaEnrollmentService } from './tenant-mega-enrollment.service';
import { MegaEnrollmentController } from './mega-enrollment.controller';
import { GoogleOAuthController } from './google-oauth.controller';
import { GithubAppService } from './github-app.service';
import { GithubReadonlyConnector } from './github-readonly';
import { GithubWriteConnector } from './github-writes';
import { GithubOAuthController } from './github-oauth.controller';

@Module({
  controllers:[GithubOAuthController,GoogleOAuthController,MegaEnrollmentController],
  providers:[
    ConnectorsService, GithubAppService, TenantRcloneService, TenantGoogleOAuthService, TenantMegaEnrollmentService,
    {provide: GithubReadonlyConnector,
      useFactory:(connections:ConnectorsService,credentials:GithubAppService)=>
        new GithubReadonlyConnector(connections.registryPolicy(),credentials),
      // Defer registry until app initialization: Nest factory runs before OnModuleInit.
      inject:[ConnectorsService,GithubAppService]},
    {provide: GithubWriteConnector,
      useFactory:(connections:ConnectorsService,credentials:GithubAppService)=>
        new GithubWriteConnector(connections.registryPolicy(),credentials),
      inject:[ConnectorsService,GithubAppService]},
  ],
  exports:[ConnectorsService,GithubAppService,GithubReadonlyConnector,GithubWriteConnector,TenantRcloneService,TenantGoogleOAuthService,TenantMegaEnrollmentService],
})
export class ConnectorsModule {}
