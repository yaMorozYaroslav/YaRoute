import { Controller, Get, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { Public } from '../common/public.decorator';
import { GithubAppService } from './github-app.service';

/** Public OAuth callback, authenticated by one-time random state and GitHub OAuth. */
@Public()
@Controller('connect/github')
export class GithubOAuthController {
  constructor(private readonly auth:GithubAppService) {}

  @Get('callback')
  async callback(
    @Query('state') state:string,
    @Query('code') code:string,
    @Res() res:Response,
  ) {
    // No token, account identifier, state or GitHub code ever returned to browser.
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    res.setHeader('X-Content-Type-Options','nosniff');
    try {
      await this.auth.completeCallback(state,code);
      res.status(200).type('html').send(
        '<!doctype html><meta charset="utf-8"><title>NestNyx connected</title>'+
        '<main style="font:16px system-ui;margin:3rem;max-width:36rem">'+
        '<h1>GitHub connected to NestNyx</h1>'+
        '<p>Return to ChatGPT and refresh your NestNyx connections. '+
        'Enable the desired permissions and repositories there. '+
        'No repository access is enabled by default.</p></main>',
      );
    } catch {
      res.status(400).type('html').send(
        '<!doctype html><meta charset="utf-8"><title>NestNyx authorization failed</title>'+
        '<main style="font:16px system-ui;margin:3rem;max-width:36rem">'+
        '<h1>Connection was not completed</h1><p>The request expired, was denied, '+
        'or does not match an installation you can access. '+
        'Start a new connection authorization from NestNyx in ChatGPT.</p></main>',
      );
    }
  }
}
