const {test}=require('node:test');
const assert=require('node:assert/strict');
const {ApiKeyGuard}=require('../dist/common/api-key.guard');
const {IS_PUBLIC_KEY}=require('../dist/common/public.decorator');
const {JobWorkerService}=require('../dist/storage/job-worker.service');

const vars=['NYX_DEPLOYMENT_MODE','NYX_PUBLIC_CONNECTORS_ENABLED','NYX_API_KEY','NYX_GLOBAL_INDEX_ON_BOOT'];
function save(){const old=Object.fromEntries(vars.map(k=>[k,process.env[k]]));
 return()=>{for(const[k,v]of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}};}
function guard(publicRoute,apiKey){
 const reflector={getAllAndOverride:()=>publicRoute};
 const context={
  getHandler:()=>({}),getClass:()=>({}),
  switchToHttp:()=>({getRequest:()=>({headers:{'x-nyx-key':apiKey}})}),
 };
 return ()=>new ApiKeyGuard(reflector).canActivate(context);
}
test('public connector mode denies all legacy HTTP routes even with old valid API key',()=>{
 const restore=save();
 try{
  process.env.NYX_DEPLOYMENT_MODE='public';
  process.env.NYX_PUBLIC_CONNECTORS_ENABLED='true';
  process.env.NYX_API_KEY='correct-secret';
  assert.throws(guard(false,'correct-secret'),/Legacy HTTP API disabled in public connector mode/);
  assert.equal(guard(true,undefined)(),true); // dedicated OAuth and health routes
 }finally{restore();}
});
test('private mode preserves legacy authenticated endpoints',()=>{
 const restore=save();
 try{
  process.env.NYX_DEPLOYMENT_MODE='private';
  process.env.NYX_PUBLIC_CONNECTORS_ENABLED='false';
  process.env.NYX_API_KEY='correct-secret';
  assert.equal(guard(false,'correct-secret')(),true);
  assert.throws(guard(false,'wrong-secret'),/Invalid X-Nyx-Key/);
 }finally{restore();}
});
test('public connector mode never starts process-global Rclone job worker',async()=>{
 const restore=save();
 try{
  process.env.NYX_DEPLOYMENT_MODE='public';
  process.env.NYX_PUBLIC_CONNECTORS_ENABLED='true';
  process.env.NYX_GLOBAL_INDEX_ON_BOOT='true';
  const jobs={createGlobalIndex:async()=>{throw Error('legacy global index must not run');}};
  const worker=new JobWorkerService(jobs,{});
  await worker.onModuleInit();
  assert.equal(worker.timer,undefined);
  worker.onModuleDestroy();
 }finally{restore();}
});
