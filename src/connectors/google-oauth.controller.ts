import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../common/public.decorator';
import { TenantGoogleOAuthService } from './tenant-google-oauth.service';

/** Public Google OAuth callback; authorizes only one previously bound owner. */
@Public()
@Controller('connect/google')
export class GoogleOAuthController {
  constructor(private readonly oauth: TenantGoogleOAuthService) {}

  @Get('callback')
  async callback(@Query('state') state: string, @Query('code') code: string,
                 @Res() res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      await this.oauth.complete(state, code);
      res.status(200).type('html').send(
        '<!doctype html><meta charset="utf-8"><title>NestNyx Google authorized</title>' +
        '<main style="font:16px system-ui;margin:3rem;max-width:36rem">' +
        '<h1>Google Drive authorization received</h1>' +
        '<p>Return to NestNyx. The new connection remains pending a read-only check ' +
        'and separate activation. Your existing storage configuration is unchanged.</p></main>'
      );
    } catch {
      res.status(400).type('html').send(
        '<!doctype html><meta charset="utf-8"><title>NestNyx connection failed</title>' +
        '<main style="font:16px system-ui;margin:3rem;max-width:36rem">' +
        '<h1>Authorization not completed</h1>' +
        '<p>The authorization may have expired or been denied. ' +
        'Return to NestNyx and start a fresh connection request. ' +
        'No legacy account configuration was changed.</p></main>'
      );
    }
  }
}
