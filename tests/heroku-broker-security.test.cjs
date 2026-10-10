const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createServer}=require('node:net');
const {spawn}=require('node:child_process');
const {createHmac}=require('node:crypto');
const path=require('node:path');

async function freePort() {
 return new Promise((resolve,reject)=>{
  const socket=createServer();
  socket.once('error',reject);
  socket.listen(0,'127.0.0.1',()=>{
   const port=socket.address().port;
   socket.close(err=>err?reject(err):resolve(port));
  });
 });
}
const ID='11111111-1111-4111-8111-111111111111';
const OWNER='oauth:test';
const APP='existing-app';
const KEY='test-only-not-a-production-secret-of-48-characters';

test('independent Heroku broker blocks financial and unassigned operations',async t=>{
 const port=await freePort();
 const env={...process.env,
  PORT:String(port),
  NYX_HEROKU_BROKER_SHARED_KEY:KEY,
  HEROKU_READ_OAUTH_TOKEN:'test-only-fake-read-oauth-token',
  NYX_HEROKU_BROKER_GRANTS_JSON:JSON.stringify({[OWNER]:{[ID]:[APP]}}),
 };
 const child=spawn(process.execPath,[path.join(process.cwd(),'broker/heroku-readonly.mjs')],{
  env,stdio:['ignore','ignore','pipe'],
 });
 let output='';
 child.stderr.on('data',chunk=>{output+=chunk.toString().slice(0,1000);});
 t.after(()=>child.kill('SIGTERM'));
 const endpoint='http://127.0.0.1:'+port+'/v1/read';
 let ready=false;
 for(let i=0;i<40;i++){
  if(child.exitCode!==null)break;
  try{const res=await fetch(endpoint,{method:'GET'});if(res.status===404){ready=true;break;}}
  catch{}
  await new Promise(resolve=>setTimeout(resolve,40));
 }
 assert.equal(ready,true,'Broker did not boot '+output);
 const request=async (operation,app=APP,sign=true,timestamp=Math.floor(Date.now()/1000))=>{
  const body=JSON.stringify({ownerId:OWNER,connectionId:ID,app,operation});
  const ts=String(timestamp);
  const sig=sign?createHmac('sha256',KEY).update(ts+'\\n'+body).digest('hex'):'0'.repeat(64);
  return fetch(endpoint,{
   method:'POST',
   headers:{'content-type':'application/json','x-nyx-timestamp':ts,'x-nyx-signature':sig},
   body,
  });
 };
 assert.equal((await request('app.scale')).status,403);
 assert.equal((await request('app.create')).status,403);
 assert.equal((await request('billing.read')).status,403);
 assert.equal((await request('config.names')).status,403);
 assert.equal((await request('app.info','different-app')).status,403);
 assert.equal((await request('app.info',APP,false)).status,401);
 assert.equal((await request('app.info',APP,true,Math.floor(Date.now()/1000)-600)).status,401);
});
