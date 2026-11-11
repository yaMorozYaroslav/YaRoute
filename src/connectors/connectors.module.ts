import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { PrivateLegacyBrokerService } from './private-legacy-broker.service';
import { PrivateLegacyBrokerController } from './private-legacy-broker.controller';
import { PrivateLegacyBrokerClient } from './private-legacy-broker.client';
import { ConnectorsService } from './connectors.service';
import { TenantRcloneService } from './tenant-rclone.service';
import { TenantGoogleOAuthService } from './tenant-google-oauth.service';
import { TenantMegaEnrollmentService } from './tenant-mega-enrollment.service';
import { MegaEnrollmentController } from './mega-enrollment.controller';
import { GoogleOAuthController } from './google-oauth.controller';
import { PrivateLegacyOwnerLinkService } from './private-legacy-owner-link.service';
import { PrivateLegacyOwnerLinkController } from './private-legacy-owner-link.controller';
import { GithubAppService } from './github-app.service';
import { GithubReadonlyConnector } from './github-readonly';
import { GithubWriteConnector } from './github-writes';
import { HerokuBrokerClient } from './heroku-broker.client';
import { GithubOAuthController } from './github-oauth.controller';

@Module({
  imports:[StorageModule],
  controllers:[GithubOAuthController,GoogleOAuthController,MegaEnrollmentController,PrivateLegacyOwnerLinkController,PrivateLegacyBrokerController],
  providers:[
    ConnectorsService, GithubAppService, HerokuBrokerClient, PrivateLegacyBrokerService, PrivateLegacyBrokerClient, TenantRcloneService, TenantGoogleOAuthService, TenantMegaEnrollmentService, PrivateLegacyOwnerLinkService,
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
  exports:[HerokuBrokerClient,PrivateLegacyBrokerClient,ConnectorsService,GithubAppService,GithubReadonlyConnector,GithubWriteConnector,TenantRcloneService,TenantGoogleOAuthService,TenantMegaEnrollmentService,PrivateLegacyOwnerLinkService],
})
export class ConnectorsModule {}
