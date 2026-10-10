import { Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import type { HerokuReadBroker } from './heroku-readonly';

/**
 * External finance-blind broker. Never give the NestNyx process a Heroku
 * bearer token, an arbitrary URL proxy or a generic Heroku API client.
 * Broker itself MUST separately enforce per-owner/app allowlists and
 * read-only Heroku OAuth scopes. Deploy it separately from YaRoute.
 */
@Injectable()
export class HerokuBrokerClient implements HerokuReadBroker {
  private config() {
    const uri=process.env.NYX_HEROKU_BROKER_URL||'';
    const key=process.env.NYX_HEROKU_BROKER_SHARED_KEY||'';
    let parsed:URL;
    try { parsed=new URL(uri); } catch { throw new Error('HEROKU_BROKER_NOT_CONFIGURED'); }
    if (parsed.protocol!=='https:' || parsed.username || parsed.password ||
      parsed.search || parsed.hash || parsed.hostname==='localhost' ||
      /^\d+\.\d+\.\d+\.\d+$/.test(parsed.hostname) ||
      !/^[A-Za-z0-9._~\/-]*$/.test(parsed.pathname) ||
      key.length<32) throw new Error('HEROKU_BROKER_NOT_CONFIGURED');
    return {url:parsed.origin+parsed.pathname.replace(/\/$/,''),key};
  }
  private async request(ownerId:string,connectionId:string,app:string,operation:string):Promise<any> {
    if(!/^[a-z][a-z0-9-]{1,28}[a-z0-9]$/.test(app)) throw new Error('HEROKU_APP_INVALID');
    const {url,key}=this.config();
    const body=JSON.stringify({ownerId,connectionId,app,operation});
    const ts=String(Math.floor(Date.now()/1000));
    const signature=createHmac('sha256',key).update(ts+'\n'+body).digest('hex');
    const response=await fetch(url+'/v1/read',{
      method:'POST',
      headers:{'content-type':'application/json','x-nyx-timestamp':ts,
        'x-nyx-signature':signature},
      body,
      redirect:'error',
      signal:AbortSignal.timeout(10000),
    });
    const text=await response.text();
    if(!response.ok||text.length>100000) throw new Error('HEROKU_BROKER_UNAVAILABLE');
    try{return JSON.parse(text);}catch{throw new Error('HEROKU_BROKER_RESPONSE_INVALID');}
  }
  async appInfo(ownerId:string,connectionId:string,app:string) {
    const data=await this.request(ownerId,connectionId,app,'app.info');
    if(!data||typeof data.name!=='string') throw new Error('HEROKU_BROKER_RESPONSE_INVALID');
    return {name:data.name,id:typeof data.id==='string'?data.id:undefined,
      web_url:typeof data.web_url==='string'?data.web_url:undefined,
      region:typeof data.region==='string'?data.region:undefined};
  }
  async releases(ownerId:string,connectionId:string,app:string) {
    const data=await this.request(ownerId,connectionId,app,'app.releases');
    if(!Array.isArray(data)||data.length>50) throw new Error('HEROKU_BROKER_RESPONSE_INVALID');
    return data.map(x=>({id:typeof x.id==='string'?x.id:undefined,
      version:Number.isSafeInteger(x.version)?x.version:undefined,
      created_at:typeof x.created_at==='string'?x.created_at:undefined,
      current:typeof x.current==='boolean'?x.current:undefined}));
  }
  async configNames(_ownerId:string,_connectionId:string,_app:string):Promise<string[]> {
    // Heroku read-only OAuth excludes config vars. Never escalate scopes
    // merely to retrieve metadata; provide a safe unsupported response.
    throw new Error('HEROKU_CONFIG_ACCESS_NOT_AVAILABLE');
  }
}
