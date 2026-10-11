import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { ConnectorsService } from './connectors.service';
import { GithubAppService } from './github-app.service';
import { GithubReadonlyConnector } from './github-readonly';
import { GithubWriteConnector } from './github-writes';
import { GithubOAuthController } from './github-oauth.controller';
import { GoogleDriveOAuthController } from './google-drive-oauth.controller';
import { GoogleDriveOAuthService } from './google-drive-oauth';

@Module({
  imports: [StorageModule],
  controllers:[GithubOAuthController,GoogleDriveOAuthController],
  providers:[
    ConnectorsService, GithubAppService, GoogleDriveOAuthService,
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
  exports:[ConnectorsService,GithubAppService,GithubReadonlyConnector,GithubWriteConnector],
})
export class ConnectorsModule {}
