import { Body, Controller, Get, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../common/public.decorator';
import { ConnectorsService } from './connectors.service';
import { MegaSetupService } from './mega-setup.service';

const esc=(v:string)=>v.replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]!));

export function megaSetupPage(state:string,remote:string):string {
  if(!/^[A-Za-z0-9_-]{43}$/.test(state) ||
     !/^[A-Za-z][A-Za-z0-9_.-]{0,119}$/.test(remote)) {
    throw new Error('MEGA_SETUP_LINK_INVALID');
  }
  const template=`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect MEGA · NestNyx</title>
<style>
body{font:16px/1.55 system-ui,sans-serif;max-width:690px;margin:4vh auto;padding:18px;color:#181818}
section{border:1px solid #ccd1d7;border-radius:12px;padding:20px}
h1{margin:0 0 8px;font-size:26px}label{display:block;margin:18px 0 8px;font-weight:700}
textarea{box-sizing:border-box;width:100%;min-height:145px;padding:12px;font:14px/1.5 monospace}
button{padding:12px 20px;background:#2459ae;color:white;border:0;border-radius:8px;cursor:pointer}
code{background:#f1f2f4;padding:2px 5px;border-radius:4px}
.warning{padding:12px;background:#fff2da;border-radius:8px}
</style></head><body><section>
<h1>Connect MEGA to NestNyx</h1>
<p>You do not need a MEGA API key or recovery key. Create an Rclone profile on your computer, then paste only that one profile here.</p>
<ol>
<li>Install <a href="https://rclone.org/install/" rel="noreferrer noopener">Rclone</a>.</li>
<li>Run <code>rclone config</code>. Create a MEGA remote named <code>__REMOTE__</code> and enter your MEGA credentials locally.</li>
<li>Run <code>rclone config file</code>, open that file and copy only the <code>[__REMOTE__]</code> section containing <code>type = mega</code>, <code>user = ...</code>, and <code>pass = ...</code>.</li>
<li>Paste that single section into the field below. This link expires in ten minutes and works once.</li>
</ol>
<p class="warning"><strong>Private information:</strong> The Rclone password value is reversible, not securely encrypted by Rclone. Your pasted profile is sent directly to NestNyx over HTTPS, then encrypted in your individual Neon vault. The server operator controls the encryption key. Never share it through ChatGPT or GitHub, and never supply a recovery key. Temporary 2FA codes are not supported here yet.</p>
<form action="/connect/mega/setup" method="post" enctype="application/x-www-form-urlencoded" autocomplete="off">
<input type="hidden" name="state" value="__STATE__">
<label for="profile"><strong>Single MEGA Rclone profile</strong></label>
<textarea id="profile" name="profile" maxlength="8192" required spellcheck="false" autocomplete="off" placeholder="[__REMOTE__]&#10;type = mega&#10;user = you@example.com&#10;pass = obscured-value"></textarea>
<p><button type="submit">Save encrypted connection</button></p>
</form>
<small>After saving, return to ChatGPT → Connections Panel → Test access. Saving does not prove MEGA accepted the credentials.</small>
</section></body></html>`;
  return template.replaceAll('__STATE__',esc(state)).replaceAll('__REMOTE__',esc(remote));
}
function resultPage(title:string,body:string):string {
  return '<!doctype html><meta charset="utf-8"><title>'+esc(title)+'</title>'+
    '<main style="font:16px/1.5 system-ui;margin:4rem auto;max-width:650px"><h1>'+
    esc(title)+'</h1><p>'+esc(body)+'</p></main>';
}
function secure(res:Response){
  res.setHeader('Cache-Control','no-store, max-age=0');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Content-Security-Policy',
    "default-src 'none'; base-uri 'none'; form-action 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'");
}
@Public()
@Controller('connect/mega')
export class MegaSetupController {
  constructor(private readonly connections:ConnectorsService,
    private readonly setup:MegaSetupService){}

  @Get('setup')
  async page(@Query('state') state:string,@Res() res:Response){
    secure(res);
    try{
      const {remote}=await this.connections.inspectMegaSetupState(state);
      res.status(200).type('html').send(megaSetupPage(state,remote));
    }catch{
      res.status(410).type('html').send(resultPage('Setup link unavailable',
        'Return to NestNyx and generate another one-time MEGA setup link.'));
    }
  }
  @Post('setup')
  async complete(@Body() body:{state?:unknown;profile?:unknown},
    @Req() req:Request,@Res() res:Response){
    secure(res);
    if(!req.is('application/x-www-form-urlencoded')){
      res.status(415).type('html').send(resultPage('Unsupported request','Use the NestNyx setup form.'));
      return;
    }
    try{
      if(!body || typeof body.state!=='string' || typeof body.profile!=='string'){
        throw new Error('MEGA_SETUP_INVALID');
      }
      await this.setup.complete(body.state,body.profile);
      res.status(200).type('html').send(resultPage('MEGA profile stored',
        'The profile was saved in your encrypted vault. Return to ChatGPT and select Test access in the NestNyx Connections Panel. The account is not yet verified.'));
    }catch{
      res.status(400).type('html').send(resultPage('MEGA setup incomplete',
        'The setup link may have expired or the profile was invalid. Return to the panel for a fresh setup link.'));
    }
  }
}
