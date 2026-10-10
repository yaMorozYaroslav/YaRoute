import { Module } from '@nestjs/common';
import { ConnectorsService } from './connectors.service';
import { GithubAppService } from './github-app.service';
import { GithubReadonlyConnector } from './github-readonly';
import { HerokuReadonlyConnector } from './heroku-readonly';
import { HerokuBrokerClient } from './heroku-broker.client';
import { GithubOAuthController } from './github-oauth.controller';

@Module({
  controllers:[GithubOAuthController],
  providers:[
    ConnectorsService, GithubAppService, HerokuBrokerClient,
    {provide: GithubReadonlyConnector,
      useFactory:(connections:ConnectorsService,credentials:GithubAppService)=>
        new GithubReadonlyConnector(connections.registryPolicy(),credentials),
      // Defer registry until app initialization: Nest factory runs before OnModuleInit.
      inject:[ConnectorsService,GithubAppService]},
    {provide: HerokuReadonlyConnector,
      useFactory:(connections:ConnectorsService,broker:HerokuBrokerClient)=>
        new HerokuReadonlyConnector(connections.registryPolicy(),broker),
      inject:[ConnectorsService,HerokuBrokerClient]},
  ],
  exports:[ConnectorsService,GithubAppService,GithubReadonlyConnector,HerokuReadonlyConnector,HerokuBrokerClient],
})
export class ConnectorsModule {}
