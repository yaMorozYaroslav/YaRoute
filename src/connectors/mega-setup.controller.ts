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
<p>Connect your own MEGA account. No API key or recovery key is required. This password form is hosted by NestNyx, not ChatGPT.</p>
<div class="warning"><strong>What you authorize:</strong> MEGA authenticates your account using your email and password, not a Google-style OAuth consent screen. NestNyx stores an encrypted Rclone profile in your own account vault. Rclone's password-obscuring alone is reversible; NestNyx's encrypted vault provides storage protection. The NestNyx server operator holds its encryption key. Do not use your MEGA recovery key or share it with anyone.</div>
<p>If your MEGA account uses two-factor authentication, this first version does not support its login. Do not enter recovery codes or one-time codes in the password field. See <a href="https://rclone.org/mega/" rel="noreferrer noopener">Rclone's MEGA documentation</a>.</p>
<form action="/connect/mega/setup" method="post" enctype="application/x-www-form-urlencoded" autocomplete="off">
<input type="hidden" name="state" value="__STATE__">
<label for="email"><strong>MEGA account email</strong></label>
<input id="email" type="email" name="email" maxlength="254" required autocomplete="username" style="box-sizing:border-box;width:100%;padding:12px">
<label for="password"><strong>MEGA account password</strong></label>
<input id="password" type="password" name="password" minlength="1" maxlength="1024" required autocomplete="off" style="box-sizing:border-box;width:100%;padding:12px">
<fieldset><legend>Permissions requested for NestNyx</legend>
<label><input type="radio" name="mode" value="read" checked> Read-only: basic connection checks (available now)</label>
<label><input type="radio" name="mode" value="manage"> Request file management access (not active until separate permission-enforced tools are released)</label>
</fieldset>
<p class="warning">Choosing file management does not grant write access now. MEGA itself does not limit the credentials to read-only, so NestNyx must enforce all operations. This release currently offers connectivity checks, not uploads, deletes, or file browsing.</p>
<p><button type="submit">Encrypt and save MEGA connection</button></p>
</form>
<p><small>The 10-minute link can only be used once. Return to ChatGPT → NestNyx Connections → Test access afterward. An encrypted profile is not proof of a successful MEGA login.</small></p>
<hr><details><summary>Advanced: use an existing Rclone profile instead</summary>
<p>If you already have Rclone, enter one <code>[__REMOTE__]</code> MEGA profile with <code>type</code>, <code>user</code>, and <code>pass</code>. It contains sensitive reversible credentials. Never paste a profile into ChatGPT or GitHub.</p>
<form action="/connect/mega/setup" method="post" enctype="application/x-www-form-urlencoded" autocomplete="off">
<input type="hidden" name="state" value="__STATE__">
<label for="profile">MEGA Rclone profile</label>
<textarea id="profile" name="profile" maxlength="8192" spellcheck="false" autocomplete="off" placeholder="[__REMOTE__]&#10;type = mega&#10;user = you@example.com&#10;pass = obscured-value"></textarea>
<p><button type="submit">Save existing profile</button></p></form>
</details>
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
  async complete(@Body() body:{state?:unknown;profile?:unknown;email?:unknown;password?:unknown;mode?:unknown},
    @Req() req:Request,@Res() res:Response){
    secure(res);
    if(!req.is('application/x-www-form-urlencoded')){
      res.status(415).type('html').send(resultPage('Unsupported request','Use the NestNyx setup form.'));
      return;
    }
    try{
      if(!body || typeof body.state!=='string')throw new Error('MEGA_SETUP_INVALID');
      if(typeof body.profile==='string' && body.profile.length>0){
        await this.setup.complete(body.state,body.profile);
      }else if(typeof body.email==='string' && typeof body.password==='string' &&
               (body.mode==='read'||body.mode==='manage')){
        await this.setup.completeCredentials(body.state,body.email,body.password,body.mode);
      }else throw new Error('MEGA_SETUP_INVALID');
      res.status(200).type('html').send(resultPage('MEGA profile stored',
        'The profile was saved in your encrypted vault. Return to ChatGPT and select Test access in the NestNyx Connections Panel. The account is not yet verified.'));
    }catch{
      res.status(400).type('html').send(resultPage('MEGA setup incomplete',
        'The link may have expired or the credentials were rejected during validation. Return to the panel for a new link. Do not paste credentials into ChatGPT.'));
    }
  }
}
