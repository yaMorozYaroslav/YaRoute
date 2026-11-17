import { Body, Controller, Get, Headers, Post, Query, Res } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Response } from 'express';
import { Public } from '../common/public.decorator';
import { TenantRcloneUploadService } from './tenant-rclone-upload.service';

function hardened(res:Response,nonce:string) {
  res.setHeader('Cache-Control','no-store, private, max-age=0');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Content-Security-Policy',
    "default-src 'none'; script-src 'nonce-"+nonce+
    "'; connect-src 'self'; style-src 'unsafe-inline'; form-action 'none';"+
    " base-uri 'none'; frame-ancestors 'none'");
}

@Public()
@Controller('connect/rclone/import')
export class RcloneUploadController {
  constructor(private readonly upload:TenantRcloneUploadService) {}

  @Get()
  async page(@Query('state') state:string,@Res() res:Response) {
    const nonce=randomBytes(18).toString('base64');
    hardened(res,nonce);
    if(!state || !await this.upload.canDisplay(state).catch(()=>false))
      return res.status(400).type('html').send('<h1>Expired Rclone import link</h1>');
    const safeState=JSON.stringify(state);
    return res.status(200).type('html').send(
      '<!doctype html><html lang="en"><meta charset="utf-8">'+
      '<title>Import local Rclone to NestNyx</title>'+
      '<main style="font:16px system-ui;margin:3rem auto;max-width:38rem">'+
      '<h1>Import one local Rclone remote</h1>'+
      '<p>Choose a local rclone.conf file. Only the remote you name is imported; '+
      'other remotes are not sent. The selected remote is sent directly to this NestNyx HTTPS '+
      'service, never to ChatGPT. Do not use a shared computer.</p>'+
      '<label>Local Rclone file <input id="file" type="file" required '+
      'accept=".conf,.txt,text/plain"></label><br><br>'+
      '<label>Remote name from [section] <input id="remote" type="text" '+
      'maxlength="120" pattern="[A-Za-z][A-Za-z0-9_.-]*" required></label>'+
      '<br><br><button id="submit" type="button">Stage and verify this remote</button>'+
      '<p id="status" role="status" aria-live="polite"></p>'+
      '<p>Credentials are encrypted for your authenticated NestNyx owner. '+
      'Activation is a separate step in Connections, and initially read-only.</p></main>'+
      '<script nonce="'+nonce+'">'+
      '(function(){"use strict";const state='+safeState+';'+
      'const s=document.getElementById("status");'+
      'document.getElementById("submit").addEventListener("click",async()=>{'+
      'const b=document.getElementById("submit"),'+
      'f=document.getElementById("file").files[0],'+
      'r=document.getElementById("remote").value.trim();'+
      'if(!f||!r||!/^[A-Za-z][A-Za-z0-9_.-]{0,119}$/.test(r)||'+
      'f.size>65536||f.size<10){s.textContent="Choose a valid file (up to 64 KiB) and remote name.";return;}'+
      'b.disabled=true;s.textContent="Checking remote…";'+
      'try{const lines=(await f.text()).split(/\\r?\\n/);'+
      'let selected=false,sections=0;const chosen=[];'+
      'for(const line of lines){const match=/^\\[([A-Za-z][A-Za-z0-9_.-]{0,119})\\]$/.exec(line.trim());'+
      'if(match){selected=match[1]===r;if(selected)sections++;}'+
      'if(selected)chosen.push(line);}'+
      'if(sections!==1)throw Error("Selected remote not unique");'+
      'const content=chosen.join("\\n");'+
      'const response=await fetch("/connect/rclone/import/complete",'+
      '{method:"POST",credentials:"omit",headers:{"Content-Type":"application/json",'+
      '"X-Nyx-Rclone-Import":"1"},body:JSON.stringify({state,remote:r,config:content})});'+
      'if(!response.ok)throw Error("Import failed or link expired");'+
      'const data=await response.json();'+
      'if(data.status!=="pending_activation"||data.readVerified!==true)throw Error("Import not verified");'+
      's.textContent="Read verified. Return to Connections and activate this pending connection.";'+
      '}catch{s.textContent="Import was not verified. Existing connections were not changed. Start a fresh import link.";}' +
      'finally{b.disabled=false;}'+
      '});})();</script></html>');
  }

  @Post('complete')
  async complete(@Headers('origin') origin:string,
                 @Headers('x-nyx-rclone-import') marker:string,
                 @Body() body:{state?:string;remote?:string;config?:string},
                 @Res() res:Response) {
    hardened(res,randomBytes(18).toString('base64'));
    const base=process.env.NYX_PUBLIC_URL||'';
    const trusted=/^https:\/\/[A-Za-z0-9.-]+(?::443)?\/?$/.test(base)
      ?base.replace(/\/$/,''):null;
    if(marker!=='1'||!trusted||origin!==trusted||
       !body||typeof body.state!=='string'||typeof body.remote!=='string'||
       typeof body.config!=='string'||body.config.length>65536) {
      return res.status(400).json({status:'failed'});
    }
    try {
      const result=await this.upload.complete(body.state,body.remote,body.config);
      return res.status(200).json(result);
    }catch{
      return res.status(400).json({status:'failed'});
    }
  }
}
