import { Module } from '@nestjs/common';
import { ConnectorsService } from './connectors.service';
import { GithubAppService } from './github-app.service';
import { GithubReadonlyConnector } from './github-readonly';
import { GithubWriteConnector } from './github-writes';
import { GithubOAuthController } from './github-oauth.controller';

@Module({
  controllers:[GithubOAuthController],
  providers:[
    ConnectorsService, GithubAppService,
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
