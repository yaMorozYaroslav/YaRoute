import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../common/public.decorator';
import { GoogleDriveOAuthService } from './google-drive-oauth';

/** Public callback is authenticated by a single-use PKCE and state lease. */
@Public()
@Controller('connect/google')
export class GoogleDriveOAuthController {
  constructor(private readonly auth:GoogleDriveOAuthService){}
  @Get('callback')
  async callback(@Query('state') state:string,@Query('code') code:string,
    @Res() res:Response){
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'");
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Content-Type-Options','nosniff');
    try{
      await this.auth.complete(state,code);
      res.status(200).type('html').send(
        '<!doctype html><meta charset="utf-8"><title>Google Drive connected</title>'+
        '<main style="font:16px system-ui;margin:3rem"><h1>Google Drive connected</h1>'+
        '<p>Return to ChatGPT and refresh the NestNyx Connections Panel.</p>'+
        '<p>Read-only authorization was granted; file transfers remain disabled.</p></main>');
    }catch{
      res.status(400).type('html').send(
        '<!doctype html><meta charset="utf-8"><title>Authorization unsuccessful</title>'+
        '<main style="font:16px system-ui;margin:3rem"><h1>Connection was not completed</h1>'+
        '<p>Consent was denied, expired, or could not be verified. Restart authorization from NestNyx.</p></main>');
    }
  }
}
