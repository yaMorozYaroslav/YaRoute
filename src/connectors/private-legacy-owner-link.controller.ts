import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../common/public.decorator';
import { PrivateLegacyOwnerLinkService } from './private-legacy-owner-link.service';

/** One-time Google OIDC callback: no Rclone credentials or broker capabilities. */
@Public()
@Controller('connect/private-owner')
export class PrivateLegacyOwnerLinkController {
  constructor(private readonly ownerLinks: PrivateLegacyOwnerLinkService) {}

  @Get('callback')
  async callback(@Query('state') state: string, @Query('code') code: string,
                 @Res() res: Response) {
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
    try {
      await this.ownerLinks.complete(state,code);
      res.status(200).type('html').send(
        '<!doctype html><meta charset="utf-8"><title>NestNyx identity linked</title>' +
        '<main style="font:16px system-ui;margin:3rem;max-width:36rem">' +
        '<h1>Owner identity linked</h1>' +
        '<p>Your identity is verified. Private legacy Rclone remains inaccessible ' +
        'until the separately secured broker is deployed and tested.</p></main>'
      );
    } catch {
      res.status(400).type('html').send(
        '<!doctype html><meta charset="utf-8"><title>NestNyx link failed</title>' +
        '<main style="font:16px system-ui;margin:3rem;max-width:36rem">' +
        '<h1>Owner identity not linked</h1>' +
        '<p>Return to NestNyx and retry with the approved Google account.</p></main>'
      );
    }
  }
}
