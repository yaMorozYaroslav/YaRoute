import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Public } from './common/public.decorator';

/** Public, credential-free brand resources. No access to NYX storage, DB or user data. */
@Public()
@Controller()
export class BrandingController {
  @Get('branding/icon.png')
  async icon(@Res() res:Response) {
    // Fixed, repository-controlled path: the caller cannot choose any file.
    const image=await fs.readFile(path.resolve('public/branding/icon.png'));
    res.setHeader('Cache-Control','public, max-age=3600');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.type('image/png').send(image);
  }

  @Get('favicon.ico')
  favicon(@Res() res:Response) {
    res.setHeader('Cache-Control','public, max-age=3600');
    res.redirect(302,'/branding/icon.png');
  }

  @Get('manifest.webmanifest')
  manifest(@Res() res:Response) {
    const label=process.env.NYX_SERVICE_NAME || 'NestNyx';
    const title=label==='DevProNestNyx'?'NestNyx Development':'NestNyx';
    res.setHeader('Cache-Control','public, max-age=3600');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.type('application/manifest+json').send({
      name:title,short_name:'NestNyx',description:'Cloud connection management through NestNyx',
      icons:[{src:'/branding/icon.png',sizes:'96x96',type:'image/png',purpose:'any'}],
      display:'standalone',start_url:'/',theme_color:'#0874E8',background_color:'#0C1333',
    });
  }

  @Get()
  home(@Res() res:Response) {
    // Never advertise provider verification or commercial availability.
    const dev=process.env.NYX_SERVICE_NAME==='DevProNestNyx';
    const title=dev?'NestNyx Development':'NestNyx';
    res.setHeader('Cache-Control','public, max-age=3600');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy',"default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
    res.type('html').send('<!doctype html><html lang="en"><head>'+
      '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+
      '<meta name="theme-color" content="#0874E8">'+
      '<link rel="icon" type="image/png" href="/branding/icon.png">'+
      '<link rel="manifest" href="/manifest.webmanifest">'+
      '<meta property="og:image" content="/branding/icon.png">'+
      '<title>'+title+'</title></head>'+
      '<body style="font-family:system-ui;text-align:center;margin:8vh auto;max-width:36rem;padding:1rem;color:#20294f">'+
      '<img src="/branding/icon.png" alt="" width="128" height="128">'+
      '<h1>'+title+'</h1><p>Cloud connections and automation through NestNyx.</p>'+
      (dev?'<p>Development environment. Not a public production release.</p>':'')+
      '<p>Account access is managed through the authenticated NestNyx integration.</p>'+
      '</body></html>');
  }
}
