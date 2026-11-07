import { Body, Controller, Get, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../common/public.decorator';
import { TenantMegaEnrollmentService } from './tenant-mega-enrollment.service';

function noCache(res: Response) {
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
}

@Public()
@Controller('connect/mega')
export class MegaEnrollmentController {
  constructor(private readonly enrollment:TenantMegaEnrollmentService) {}

  @Get('setup')
  async setup(@Query('state') state:string,@Res() res:Response) {
    noCache(res);
    if (!state || !await this.enrollment.canDisplay(state)) {
      return res.status(400).type('html').send('<h1>Expired connection link</h1><p>Return to NestNyx and create a new one-time link.</p>');
    }
    // State is a verified URL-safe capability; never include owner identity in HTML.
    return res.status(200).type('html').send(
      '<!doctype html><meta charset="utf-8"><title>NestNyx MEGA connection</title>' +
      '<main style="font:16px system-ui;margin:3rem;max-width:34rem">' +
      '<h1>Connect your MEGA account</h1><p>Credentials are sent only to the NestNyx HTTPS server.' +
      ' Never share your password in ChatGPT. Existing connections remain unchanged until tested.</p>' +
      '<form method="post" action="/connect/mega/complete" autocomplete="off">' +
      '<input type="hidden" name="state" value="'+state+'">' +
      '<label>MEGA account email<br><input required type="email" name="email" maxlength="200" autocomplete="username"></label>' +
      '<br><br><label>MEGA password<br><input required type="password" name="password" maxlength="1024" autocomplete="current-password"></label>' +
      '<br><br><label>Six-digit MEGA authenticator code (if enabled)<br>' +
      '<input type="text" name="twoFactorCode" inputmode="numeric" pattern="[0-9]{6}" ' +
      'maxlength="6" minlength="6" autocomplete="one-time-code"></label>' +
      '<br><br><button type="submit">Verify read-only connection</button></form>' +
      '<p>If MFA is enabled, enter a fresh code when submitting. Your code is never stored. ' +
      'Enrollment requires a reusable MEGA session after verification.</p></main>'
    );
  }

  @Post('complete')
  async complete(@Body() body: {state?:string;email?:string;password?:string;twoFactorCode?:string},@Res() res:Response) {
    noCache(res);
    try {
      if (!body || typeof body.state!=='string' || typeof body.email!=='string' ||
          typeof body.password!=='string') throw new Error('TENANT_MEGA_FORM_INVALID');
      await this.enrollment.complete(body.state,body.email,body.password,
        body.twoFactorCode || undefined);
      return res.status(200).type('html').send(
        '<!doctype html><meta charset="utf-8"><h1>MEGA read access verified</h1>' +
        '<p>Return to NestNyx to activate your separate connection. No old account was replaced.</p>'
      );
    } catch {
      return res.status(400).type('html').send(
        '<!doctype html><meta charset="utf-8"><h1>MEGA connection not completed</h1>' +
        '<p>Verification failed or the one-time link expired. Your existing connections are unchanged.' +
        ' Return to NestNyx for a fresh link and authenticator code if needed. Do not disable 2FA.</p>'
      );
    }
  }
}
