/**
 * Finance-blind Heroku READ broker, deploy MANUALLY as an isolated process,
 * without GitHub deployment credentials or access to the editable NYX runtime.
 * Never deploy this inside the NestNyx app or automate its upgrade from NYX.
 *
 * Node 22+, no external dependencies. Must be served over HTTPS by its platform.
 *
 * HEROKU_READ_OAUTH_TOKEN: Heroku OAuth token with 'read' only, NOT 'global',
 * 'read-protected', 'write' or 'write-protected'.
 * NYX_HEROKU_BROKER_SHARED_KEY: >=32-character random independent secret.
 * NYX_HEROKU_BROKER_GRANTS_JSON: {"oauth:subject":{"uuid-conn":["my-app"]}}.
 *
 * The owner provisions these manually OUTSIDE NYX.
 */
import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

const key=process.env.NYX_HEROKU_BROKER_SHARED_KEY||'';
const token=process.env.HEROKU_READ_OAUTH_TOKEN||'';
const rawGrants=process.env.NYX_HEROKU_BROKER_GRANTS_JSON||'';
if(key.length<32 || token.length<16 || !rawGrants || !process.env.PORT) {
  throw new Error('BROKER_REQUIRED_MANUAL_CONFIGURATION_MISSING');
}
let grants;
try {grants=JSON.parse(rawGrants);}catch{throw new Error('BROKER_GRANTS_INVALID');}
if(!grants||Array.isArray(grants)||typeof grants!=='object') throw new Error('BROKER_GRANTS_INVALID');
const allowedOperations=new Set(['app.info','app.releases']);
const applicationPattern=/^[a-z][a-z0-9-]{1,28}[a-z0-9]$/;
const ownerPattern=/^oauth:[^\x00-\x1f]{1,500}$/;
const idPattern=/^[a-f0-9-]{36}$/;
const hits=new Map();
const cutoff=Date.now;
function send(res,status,data){
  res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff'});
  res.end(JSON.stringify(data));
}
async function readHeroku(app,operation){
  // Hard-coded, approved read-only endpoints. No arbitrary URL or method.
  const path=operation==='app.info' ? '/apps/'+app : '/apps/'+app+'/releases';
  const response=await fetch('https://api.heroku.com'+path,{
    method:'GET',
    headers:{Authorization:'Bearer '+token,Accept:'application/vnd.heroku+json; version=3'},
    redirect:'error',signal:AbortSignal.timeout(8000),
  });
  const raw=await response.text();
  if(!response.ok||raw.length>250000) throw new Error('UPSTREAM_UNAVAILABLE');
  let data;
  try{data=JSON.parse(raw);}catch{throw new Error('UPSTREAM_RESPONSE_INVALID');}
  if(operation==='app.info'){
    if(!data||typeof data.name!=='string'||data.name!==app) throw new Error('UPSTREAM_RESPONSE_INVALID');
    return {name:data.name,id:typeof data.id==='string'?data.id:undefined,
      web_url:typeof data.web_url==='string'?data.web_url:undefined,
      region:typeof data.region?.name==='string'?data.region.name:undefined};
  }
  if(!Array.isArray(data))throw new Error('UPSTREAM_RESPONSE_INVALID');
  return data.slice(0,50).map(x=>({
    id:typeof x.id==='string'?x.id:undefined,
    version:Number.isSafeInteger(x.version)?x.version:undefined,
    created_at:typeof x.created_at==='string'?x.created_at:undefined,
    current:typeof x.current==='boolean'?x.current:undefined,
  }));
}
const app=createServer(async(req,res)=>{
  if(req.method!=='POST'||req.url!=='/v1/read')return send(res,404,{error:'not_found'});
  if(req.headers['content-type']!=='application/json')return send(res,415,{error:'invalid_type'});
  const ts=req.headers['x-nyx-timestamp'];
  const provided=req.headers['x-nyx-signature'];
  if(typeof ts!=='string'||!/^[1-9]\d{9,10}$/.test(ts)||
     Math.abs(cutoff()/1000-Number(ts))>60 ||
     typeof provided!=='string'|| !/^[0-9a-f]{64}$/.test(provided)) {
    return send(res,401,{error:'unauthorized'});
  }
  let raw='';
  try{for await(const chunk of req){raw+=chunk;if(raw.length>8192)throw Error('too-large');}}
  catch{return send(res,413,{error:'invalid_request'});}
  const expected=createHmac('sha256',key).update(ts+'\n'+raw).digest();
  if(!timingSafeEqual(expected,Buffer.from(provided,'hex')))return send(res,401,{error:'unauthorized'});
  let input;
  try{input=JSON.parse(raw);}catch{return send(res,400,{error:'invalid_request'});}
  const {ownerId,connectionId,app:appName,operation}=input||{};
  if(typeof ownerId!=='string'||!ownerPattern.test(ownerId)||
    typeof connectionId!=='string'||!idPattern.test(connectionId)||
    typeof appName!=='string'||!applicationPattern.test(appName)||
    typeof operation!=='string'||!allowedOperations.has(operation)) {
    return send(res,403,{error:'not_authorized'});
  }
  // A separate, manually curated exact owner/connection/app map is authoritative.
  if(!Array.isArray(grants[ownerId]?.[connectionId]) ||
    !grants[ownerId][connectionId].includes(appName)) {
    return send(res,403,{error:'not_authorized'});
  }
  const bucket=ownerId+'|'+connectionId+'|'+appName;
  const old=hits.get(bucket)||{since:cutoff(),count:0};
  if(cutoff()-old.since>60000){old.since=cutoff();old.count=0;}
  if(++old.count>30)return send(res,429,{error:'rate_limited'});
  hits.set(bucket,old);
  try {return send(res,200,await readHeroku(appName,operation));}
  catch {return send(res,502,{error:'upstream_failed'});}
});
app.requestTimeout=10000;
app.headersTimeout=10000;
app.listen(Number(process.env.PORT),'0.0.0.0');
