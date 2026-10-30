const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {TenantRcloneService}=require('../dist/connectors/tenant-rclone.service');
const owner='oauth:user-one',id='11111111-2222-4333-8444-555555555555';
const mega={provider:'mega',user:['demo','invalid.test'].join('@'),obscuredPassword:'fixture-only'};
const drive={provider:'google-drive',rootFolderId:'folder-1',
 token:JSON.stringify({access_token:'test-only',refresh_token:'not-real'}),scope:'drive.readonly'};
function fixture(provider='mega') {
 const resourceId=provider==='mega'?'SharedDocs':'folder-1',profile=provider==='mega'?mega:drive;
 const traces=[];
 const svc=new TenantRcloneService({
  getOwned:async (actor,conn)=>{
   if(actor!==owner||conn!==id)throw Error('DENIED_OTHER_OWNER');
   return {ownerId:owner,id,provider,status:'active'};
  },
  registryPolicy:()=>({requireResource:async(actor,conn,cap,r)=>{
   traces.push({actor,conn,cap,r});
   if(actor!==owner||conn!==id||cap!=='storage:list'||
      r.kind!==(provider==='mega'?'mega-root':'drive')||r.id!==resourceId)
     throw Error('DENIED_OTHER_ROOT');
   return {provider};
  }}),
 });
 svc.profile=async()=>({provider,profile:provider==='mega'?{...profile,verifiedRoot:resourceId}:profile});
 svc.listIsolated=async(_profile,target)=>({items:[{path:target,isDir:true,size:null}],truncated:false,readOnly:true});
 return {svc,resourceId,traces};
}
test('MEGA list uses owner-owned active profile and exact configured folder',async()=>{
 const {svc,resourceId,traces}=fixture();
 const result=await svc.listAuthorizedRoot(owner,id,'mega',resourceId,'Reports');
 assert.deepEqual(result.items.map(x=>x.path),['SharedDocs/Reports']);
 assert.equal(traces.length,1);
 assert.deepEqual(traces[0].r,{kind:'mega-root',id:resourceId,path:'Reports'});
});
test('Google Drive list uses only granted folder ID, not global Drive remote',async()=>{
 const {svc,resourceId}=fixture('google-drive');
 const result=await svc.listAuthorizedRoot(owner,id,'google-drive',resourceId,'Notes');
 assert.equal(result.items[0].path,'Notes');
});
test('cross-owner, cross-provider, cross-root and traversal attempts fail closed',async()=>{
 const {svc,resourceId}=fixture();
 const called=[];
 svc.listIsolated=async()=>{called.push(true);return {items:[]}};
 await assert.rejects(()=>svc.listAuthorizedRoot('oauth:attacker',id,'mega',resourceId),/CONNECTION_FORBIDDEN/);
 await assert.rejects(()=>svc.listAuthorizedRoot(owner,id,'mega','OtherRoot'),/DENIED_OTHER_ROOT/);
 await assert.rejects(()=>svc.listAuthorizedRoot(owner,id,'google-drive',resourceId),/CONNECTION_FORBIDDEN/);
 await assert.rejects(()=>svc.listAuthorizedRoot(owner,id,'mega',resourceId,'../secret'),/PATH_INVALID/);
 assert.equal(called.length,0);
});
test('isolated subprocess reads only one per-user config and discards inherited secrets',async(t)=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nyx-mock-backend-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const executable=path.join(dir,'mock-rclone');
 const script=[
 '#!/usr/bin/env node',
 'const fs=require("node:fs");',
 'const argv=process.argv.slice(2);',
 'if(argv[0]!=="--config"||argv[2]!=="lsjson"||argv[3]!=="tenant:SharedDocs/Reports")process.exit(9);',
 'if(process.env.NYX_TEST_LEAK_MARKER||process.env.RCLONE_CONFIG_B64)process.exit(10);',
 'const c=fs.readFileSync(argv[1],"utf8");',
 'if(!c.includes("type = mega")||!c.includes("user = ")||c.includes("legacy-global"))process.exit(11);',
 'console.log(JSON.stringify([{Path:"2026/",IsDir:true,Size:-1},{Path:"notes.txt",IsDir:false,Size:42}]));',
 ].join('\n')+'\n';
 fs.writeFileSync(executable,script,{mode:0o700});
 const {svc}=fixture();
 svc.listIsolated=TenantRcloneService.prototype.listIsolated.bind(svc);
 svc.binary=executable;
 const previous=process.env.NYX_TEST_LEAK_MARKER;
 process.env.NYX_TEST_LEAK_MARKER='should-never-inherit';
 t.after(()=>{if(previous===undefined)delete process.env.NYX_TEST_LEAK_MARKER;
   else process.env.NYX_TEST_LEAK_MARKER=previous;});
 const result=await svc.listIsolated(mega,'SharedDocs/Reports');
 assert.deepEqual(result,{items:[
   {path:'2026/',isDir:true,size:null},{path:'notes.txt',isDir:false,size:42}
 ],truncated:false,readOnly:true});
});
test('connection UI and MCP list endpoint are read-only, owner-scoped and flag-gated',()=>{
 const mcp=fs.readFileSync('src/mcp/mcp.service.ts','utf8');
 const pos=mcp.indexOf("server.registerTool('nyx_storage_connection_list_files'");
 assert.ok(pos>0);
 const tool=mcp.slice(pos,mcp.indexOf("server.registerTool('nyx_storage_connection_test_active'",pos));
 assert.match(tool,/this\.connectorOwner\(\)/);
 assert.match(tool,/this\.tenantRclone\.listAuthorizedRoot/);
 assert.match(tool,/readOnlyHint:true/);
 assert.ok(pos>mcp.indexOf("process.env.NYX_MULTIUSER_RCLONE_ENABLED === 'true'"));
 const panel=fs.readFileSync('src/connectors/connections-panel.ts','utf8');
 assert.match(panel,/Browse selected folder \(read only\)/);
 assert.match(panel,/nyx_storage_connection_list_files/);
 assert.match(panel,/ul\.append\(el\('li'/);
});


test('public multi-user boot refuses legacy Rclone credentials instead of mixing accounts',async(t)=>{
 const vars=['NYX_MULTIUSER_RCLONE_ENABLED','NYX_DEPLOYMENT_MODE',
  'NYX_PUBLIC_CONNECTORS_ENABLED','RCLONE_CONFIG_B64','RCLONE_CONFIG_PATH',
  'RCLONE_CONFIG','NYX_SHARED_ROOTS_JSON'];
 const originals=Object.fromEntries(vars.map(key=>[key,process.env[key]]));
 t.after(()=>{for(const key of vars){
  if(originals[key]===undefined)delete process.env[key];
  else process.env[key]=originals[key];
 }});
 process.env.NYX_MULTIUSER_RCLONE_ENABLED='true';
 process.env.NYX_DEPLOYMENT_MODE='public';
 process.env.NYX_PUBLIC_CONNECTORS_ENABLED='true';
 for(const forbidden of ['RCLONE_CONFIG_B64','RCLONE_CONFIG_PATH',
                          'RCLONE_CONFIG','NYX_SHARED_ROOTS_JSON']){
  for(const key of ['RCLONE_CONFIG_B64','RCLONE_CONFIG_PATH',
                    'RCLONE_CONFIG','NYX_SHARED_ROOTS_JSON'])delete process.env[key];
  process.env[forbidden]='legacy-placeholder-not-a-secret';
  const {svc}=fixture();
  await assert.rejects(()=>svc.onModuleInit(),/TENANT_RCLONE_PRIVATE_CONFIG_PRESENT/);
  assert.equal(svc.pool,undefined);
  assert.equal(svc.encryptionKey,undefined);
 }
});
