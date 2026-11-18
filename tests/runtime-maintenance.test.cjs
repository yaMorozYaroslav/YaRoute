const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {GithubWriteConnector}=require('../dist/connectors/github-writes');
const {RuntimeMaintenanceService}=require('../dist/mcp/runtime-maintenance.service');
const {NyxExecutionProfileService}=require('../dist/nyx/execution-profile.service');
const {reconcileRuntimePins,assertPinOnlyRepair,textHash,gitBlobHash,RUNTIME_PROFILE_PATH}=require('../dist/nyx/runtime-pin-repair');
const OWNER='oauth:test-owner',ID='test-connection',REPO='owner/YaRoute';
const BASE='a'.repeat(40),COMMIT='b'.repeat(40),TREE='c'.repeat(40),CLI='d'.repeat(64);
const LIVE='PRIVATE_SOURCE_CONTENT';
const model=()=>({schema:'nyx.runtime-profile.v1',authority:'user-authorized-runtime-configuration',
 cliSha256:CLI,commands:{},keySources:[{key:'temp_paths',ref:{area:'MAIN',path:'draft/source'},sha256:textHash('old')}]});
const before=JSON.stringify(model(),null,2)+'\n';
const reviewed=[{key:'temp_paths',sha256:textHash(LIVE)}];
const after=reconcileRuntimePins(before,reviewed,CLI).content;

test('pin transform changes only reviewed existing hashes and rejects altered contracts/refs/CLI',()=>{
 assert.equal(assertPinOnlyRepair(before,after).length,1);
 for(const mutate of [
  p=>p.keySources[0].ref.path='elsewhere',p=>p.cliSha256='e'.repeat(64),
  p=>p.keySources.push({...p.keySources[0],key:'new_source'}),p=>p.commands.new_command={},
 ]) {
  const p=JSON.parse(after);mutate(p);
  assert.throws(()=>assertPinOnlyRepair(before,JSON.stringify(p)));
 }
 assert.throws(()=>assertPinOnlyRepair(before,before),/NON_PIN_CHANGE/);
 for(const pins of [[],[...reviewed,...reviewed],[{key:'other',sha256:textHash(LIVE)}]])
  assert.throws(()=>reconcileRuntimePins(before,pins,CLI),/REVIEWED_PINS_INVALID/);
});
function provider({deny=false,moved=false,protectedBranch=false,corruptReadback=false}={}) {
 const calls=[],grants=[];let branchChecks=0;
 const file=text=>({type:'file',path:RUNTIME_PROFILE_PATH,size:Buffer.byteLength(text),
  encoding:'base64',content:Buffer.from(text).toString('base64'),sha:gitBlobHash(text)});
 const registry={requireResource:async(owner,id,cap,resource)=>{
  assert.equal(owner,OWNER);assert.equal(id,ID);assert.equal(resource.id,REPO);
  assert.equal(resource.path,RUNTIME_PROFILE_PATH);
  assert.ok(['resources:read','contents:write'].includes(cap));
  grants.push({cap,resource});
  if(deny)throw Error('FORBIDDEN');
  return {provider:'github',installationId:'7'};
 }};
 const http=async(url,init)=>{
  const suffix=url.slice(('https://api.github.com/repos/'+REPO).length);
  const body=init.body?JSON.parse(init.body):undefined;
  calls.push({suffix,method:init.method,body});
  let result;
  if(init.method==='GET'&&suffix==='')result={default_branch:'master'};
  else if(suffix==='/branches/tester') {
   branchChecks++;
   result={name:'tester',protected:protectedBranch,commit:{sha:moved&&branchChecks>1?'f'.repeat(40):BASE}};
  } else if(suffix==='/contents/'+RUNTIME_PROFILE_PATH+'?ref='+BASE)result=file(before);
  else if(suffix==='/contents/'+RUNTIME_PROFILE_PATH+'?ref='+COMMIT)
   result=file(corruptReadback?before:after);
  else if(suffix==='/git/commits/'+BASE)result={tree:{sha:TREE}};
  else if(init.method==='POST'&&suffix==='/git/trees') {
   assert.deepEqual(body.tree,[{path:RUNTIME_PROFILE_PATH,mode:'100644',type:'blob',content:after}]);
   result={sha:TREE};
  } else if(init.method==='POST'&&suffix==='/git/commits') {
   assert.deepEqual(body.parents,[BASE]);result={sha:COMMIT};
  } else if(init.method==='POST'&&suffix==='/git/refs') {
   assert.equal(body.ref,'refs/heads/nyx/pin-repair');
   result={ref:body.ref,object:{sha:body.sha}};
  } else if(suffix==='/git/ref/heads/nyx%2Fpin-repair')result={object:{sha:COMMIT}};
  else throw Error('UNEXPECTED:'+suffix);
  return {ok:true,status:200,text:async()=>JSON.stringify(result)};
 };
 return {api:new GithubWriteConnector(registry,{tokenFor:async()=> 'fixture-token'},http),calls,grants};
}
test('Nyx GitHub transport stages one fixed profile file, verifies it and leaves tester/default untouched',async()=>{
 const {api,calls,grants}=provider();
 const out=await api.stageRuntimePinRepair(OWNER,ID,REPO,'nyx/pin-repair',BASE,before,after);
 assert.equal(out.readbackVerified,true);assert.equal(out.merged,false);assert.equal(out.deployed,false);
 assert.equal(out.reviewSha,COMMIT);
 assert.deepEqual(calls.filter(x=>x.method!=='GET').map(x=>x.suffix),['/git/trees','/git/commits','/git/refs']);
 assert.ok(grants.some(g=>g.resource.branch==='tester'));
 assert.ok(grants.some(g=>g.resource.branch==='nyx/pin-repair'));
});
test('owner/provider denial, protected source and changed root contract create no Git objects',async()=>{
 for(const options of [{deny:true},{protectedBranch:true}]) {
  const {api,calls}=provider(options);
  await assert.rejects(()=>api.stageRuntimePinRepair(OWNER,ID,REPO,'nyx/pin-repair',BASE,before,after));
  assert.equal(calls.some(c=>c.method!=='GET'),false);
 }
 const {api,calls}=provider();
 const changed=JSON.parse(after);changed.keySources[0].ref.path='different';
 await assert.rejects(()=>api.stageRuntimePinRepair(OWNER,ID,REPO,'nyx/pin-repair',BASE,before,JSON.stringify(changed)));
 assert.equal(calls.length,0);
});
test('source drift or corrupt written profile never publishes a review branch',async()=>{
 for(const options of [{moved:true},{corruptReadback:true}]) {
  const {api,calls}=provider(options);
  await assert.rejects(()=>api.stageRuntimePinRepair(OWNER,ID,REPO,'nyx/pin-repair',BASE,before,after));
  assert.equal(calls.some(c=>c.suffix==='/git/refs'),false);
 }
});
test('general file-write API still rejects all runtime configuration writes',async()=>{
 const {api,calls}=provider();
 await assert.rejects(()=>api.commitFile(OWNER,ID,REPO,'nyx/pin-repair',RUNTIME_PROFILE_PATH,after,'change'),/INFRASTRUCTURE_WRITE_FORBIDDEN/);
 assert.equal(calls.length,0);
});
function service() {
 const files=new Map([['draft/source',LIVE],['configured-profile',before]]),writes=[];
 const pins=new NyxExecutionProfileService({read:async ref=>{
  if(!files.has(ref.path))throw Error('private provider failure');return files.get(ref.path);
 }});
 const github={readTesterRuntimeProfile:async(owner,id,repo,sha)=>{
  assert.equal(owner,OWNER);assert.equal(sha,BASE);return {text:before};
 },stageRuntimePinRepair:async(...args)=>{
  writes.push(args);return {branch:'nyx/pin-repair',reviewSha:COMMIT,readbackVerified:true,merged:false,deployed:false};
 },draftPullToNonDefault:async()=>({number:1,url:'https://github.com/owner/YaRoute/pull/1',draft:true})};
 const registry={current:async()=>({cli:{},hash:CLI})};
 const svc=new RuntimeMaintenanceService({locate:async()=>({executionProfile:{area:'MAIN',path:'configured-profile'},canonical:{head:'fixture',body:'fixture',footer:'fixture'}})},registry,pins,github);
 const input={id:ID,repo:REPO,expectedTesterSha:BASE,reviewBranch:'nyx/pin-repair',
  expectedProfileSha256:textHash(before),expectedCliSha256:CLI,reviewedKeys:reviewed};
 return {svc,files,writes,github,input,registry};
}
test('maintenance inspect reads source pins and returns receipts without source contents or writes',async()=>{
 const {svc,writes}=service();
 const result=await svc.inspect(OWNER,ID,REPO,BASE);
 assert.equal(result.status,'REVIEW_REQUIRED');
 assert.equal(result.expectedProfileSha256,textHash(before));
 assert.equal(result.preflight.keys[0].actual,textHash(LIVE));
 assert.doesNotMatch(JSON.stringify(result),/PRIVATE_SOURCE_CONTENT|private provider failure/);
 assert.equal(writes.length,0);
});
test('explicitly reviewed fresh pins create a verified draft repair through Nyx',async()=>{
 const {svc,writes,input}=service();
 const result=await svc.prepare(OWNER,input);
 assert.equal(result.status,'DRAFT_REVIEW_READY');assert.equal(result.readbackVerified,true);
 assert.equal(writes.length,1);assert.equal(writes[0][6],after);
});
test('source changes after review, missing sources and stale fingerprints block before writes',async()=>{
 for(const mutation of [
  f=>f.files.set('draft/source','changed again'),f=>f.files.clear(),
  f=>f.input.expectedProfileSha256='e'.repeat(64),
  f=>f.input.expectedCliSha256='e'.repeat(64),
  f=>f.input.reviewedKeys=[...reviewed,...reviewed],
  f=>f.registry.current=async()=>({cli:{},hash:'e'.repeat(64)}),
 ]) {
  const f=service();mutation(f);
  await assert.rejects(()=>f.svc.prepare(OWNER,f.input));assert.equal(f.writes.length,0);
 }
});
test('branch receipt remains available when draft PR creation fails',async()=>{
 const {svc,github,input}=service();
 github.draftPullToNonDefault=async()=>{throw Error('provider failure');};
 const out=await svc.prepare(OWNER,input);
 assert.equal(out.status,'BRANCH_VERIFIED_PR_PENDING');assert.equal(out.reviewSha,COMMIT);
});
test('public tenant runtime cannot invoke maintenance even outside the MCP registration gate',async t=>{
 const old=process.env.NYX_DEPLOYMENT_MODE;process.env.NYX_DEPLOYMENT_MODE='public';
 t.after(()=>{if(old===undefined)delete process.env.NYX_DEPLOYMENT_MODE;else process.env.NYX_DEPLOYMENT_MODE=old;});
 const {svc,writes,input}=service();
 await assert.rejects(()=>svc.inspect(OWNER,ID,REPO,BASE),/PRIVATE_ONLY/);
 await assert.rejects(()=>svc.prepare(OWNER,input),/PRIVATE_ONLY/);
 assert.equal(writes.length,0);
});
test('maintenance tools require owner-scoped connection API and remain private-only',()=>{
 const src=fs.readFileSync('src/mcp/mcp.service.ts','utf8');
 const gate=src.indexOf("if (process.env.NYX_DEPLOYMENT_MODE==='public') return server;");
 for(const name of ['inspect','prepare']) {
  const at=src.indexOf("server.registerTool('nyx_maintenance_runtime_"+name+"'");
  assert.ok(at>gate);
  const tool=src.slice(at,src.indexOf('server.registerTool(',at+20));
  assert.match(tool,/this\.connectorOwner\(\)/);assert.match(tool,/this\.limitedConnectionApi/);
  assert.doesNotMatch(tool,/execFile|spawn\(|shell:/);
 }
});

test('repository-controlled profile cannot redirect operator-private source reads',async()=>{
 const {svc,github,files,writes}=service();
 files.set('private/credentials','must-never-be-read');
 const target=JSON.parse(before);target.keySources[0].ref.path='private/credentials';
 github.readTesterRuntimeProfile=async()=>({text:JSON.stringify(target)});
 let privateReads=0;
 files.get=((original)=>function(key){if(key==='private/credentials')privateReads++;return original.call(this,key);})(files.get);
 await assert.rejects(()=>svc.inspect(OWNER,ID,REPO,BASE),/PROFILE_BOUNDARY_CHANGED/);
 assert.equal(privateReads,0);assert.equal(writes.length,0);
});
test('unconfigured deployment cannot use repository contents as a private source allowlist',async()=>{
 const {svc,files}=service();files.delete('configured-profile');
 await assert.rejects(()=>svc.inspect(OWNER,ID,REPO,BASE));
});
