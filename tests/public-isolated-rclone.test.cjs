const {test}=require('node:test');
const assert=require('node:assert/strict');
const {ConnectorsService}=require('../dist/connectors/connectors.service');
const {ConnectorRegistry}=require('../dist/connectors/connector-registry');
const {RcloneService}=require('../dist/storage/rclone.service');
const {SharedRootsService}=require('../dist/storage/shared-roots.service');
const old={...Object.fromEntries(['NYX_DEPLOYMENT_MODE','NYX_PUBLIC_CONNECTORS_ENABLED',
 'NYX_RCLONE_VAULT_ENABLED','NYX_SHARED_ROOTS_JSON','RCLONE_CONFIG_B64','RCLONE_CONFIG_PATH'].map(k=>[k,process.env[k]]))};
function configure(t){
 t.after(()=>{for(const[k,v]of Object.entries(old))v===undefined?
 delete process.env[k]:process.env[k]=v});
 process.env.NYX_DEPLOYMENT_MODE='public';
 process.env.NYX_PUBLIC_CONNECTORS_ENABLED='true';
 process.env.NYX_RCLONE_VAULT_ENABLED='true';
 delete process.env.NYX_SHARED_ROOTS_JSON;
 delete process.env.RCLONE_CONFIG_B64;
 delete process.env.RCLONE_CONFIG_PATH;
}
test('public connector mode has no global roots and shared Rclone executor is blocked',async t=>{
 configure(t);
 const roots=new SharedRootsService();
 assert.deepEqual(roots.listAreas(),[]);
 process.env.NYX_SHARED_ROOTS_JSON=JSON.stringify({OPERATOR:{remote:'shared',root:'.'}});
 assert.deepEqual(new SharedRootsService().listAreas(),[]);
 const rclone=new RcloneService();
 assert.throws(()=>rclone.onModuleInit(),/PUBLIC_OPERATOR_RCLONE_CONFIG_FORBIDDEN/);
 delete process.env.NYX_SHARED_ROOTS_JSON;
 assert.doesNotThrow(()=>rclone.onModuleInit());
 process.env.RCLONE_CONFIG_B64='not-a-real-config';
 assert.throws(()=>rclone.onModuleInit(),/PUBLIC_OPERATOR_RCLONE_CONFIG_FORBIDDEN/);
 delete process.env.RCLONE_CONFIG_B64;
 await assert.rejects(()=>rclone.run(['listremotes']),/LEGACY_RCLONE_PUBLIC_DISABLED/);
 await assert.rejects(()=>rclone.run(['copy','remote:path','another:path']),/LEGACY_RCLONE_PUBLIC_DISABLED/);
});
test('public owner metadata never grants a different tenant Rclone probe or unlink',async t=>{
 configure(t);
 const rows=new Map(),sharedCalls=[];
 const storage={
  rcloneConnections:async()=>{throw Error('public must not enumerate operator config');},
  testRcloneConnection:async()=>{sharedCalls.push('bad');throw Error('must not use shared Rclone');},
  testIsolatedRcloneConnection:async(provider,name,profile)=>({
   schema:'nyx.storage.rclone.probe.v1',provider,name,
   status:profile?'reachable':'unverified',configurationChanged:false}),
 };
 const vault={isEnabled:()=>true,load:async(owner,id)=>'['+owner+':'+id+']',
   revoke:async()=>{}};
 const db={
  get:async id=>rows.get(id)??null,
  list:async owner=>[...rows.values()].filter(x=>x.ownerId===owner),
  save:async row=>{rows.set(row.id,row);},
 };
 const svc=new ConnectorsService(storage,vault);
 svc.repository=db;svc.registry=new ConnectorRegistry(db);
 svc.pool={query:async()=>({rowCount:1,rows:[]})};
 const alice=await svc.createRclone('oauth:alice','google-drive','alice_drive','Personal');
 const bob=await svc.createRclone('oauth:bob','google-drive','bob_drive','Work');
 assert.notEqual(alice.id,bob.id);
 assert.equal((await svc.list('oauth:alice')).length,1);
 assert.equal((await svc.list('oauth:bob')).length,1);
 await assert.rejects(()=>svc.testRclone('oauth:bob',alice.id),/CONNECTOR_NOT_FOUND/);
 await assert.rejects(()=>svc.disconnect('oauth:bob',alice.id),/CONNECTOR_NOT_FOUND/);
 const check=await svc.testRclone('oauth:alice',alice.id);
 assert.equal(check.status,'reachable');
 assert.equal(sharedCalls.length,0);
});
test('public Rclone references fail closed when vault is disabled',async t=>{
 configure(t);
 process.env.NYX_RCLONE_VAULT_ENABLED='false';
 const storage={rcloneConnections:async()=>({remotes:[{provider:'google-drive',name:'drive'}]})};
 const svc=new ConnectorsService(storage,{isEnabled:()=>false});
 svc.repository={get:async()=>null};
 await assert.rejects(()=>svc.createRclone('oauth:alice','google-drive','drive','Personal'),
   /PUBLIC_RCLONE_VAULT_REQUIRED/);
});

test('public MEGA accounts use independent owner credentials, not global Rclone',async t=>{
 configure(t);
 const records=new Map(),provisioned=new Map(),isolatedCalls=[];
 let leakedGlobal=false;
 const storage={
   rcloneConnections:async()=>{leakedGlobal=true;throw Error('shared remotes forbidden');},
   testRcloneConnection:async()=>{leakedGlobal=true;throw Error('shared probe forbidden');},
   testIsolatedRcloneConnection:async(provider,remote,profile)=>{
     isolatedCalls.push({provider,remote,profile});
     return {schema:'nyx.storage.rclone.probe.v1',provider,name:remote,
       status:'reachable',configurationChanged:false};
   },
 };
 const vault={isEnabled:()=>true,
   load:async(owner,id)=>provisioned.get(owner+':'+id),
   revoke:async(owner,id)=>{provisioned.delete(owner+':'+id);}};
 const repo={get:async id=>records.get(id)||null,
   list:async owner=>[...records.values()].filter(x=>x.ownerId===owner),
   save:async row=>{records.set(row.id,{...row});}};
 const svc=new ConnectorsService(storage,vault);
 svc.repository=repo;svc.registry=new ConnectorRegistry(repo);
 svc.pool={query:async(sql,args)=>{
   if(sql.includes("SET status='revoked'")){
     const row=records.get(args[0]);
     if(row&&row.ownerId===args[1])records.set(row.id,{...row,status:'revoked'});
   }
   return {rowCount:1,rows:[]};
 }};
 const alice=await svc.createRclone('oauth:alice','mega','mega_remote','Private MEGA');
 const bob=await svc.createRclone('oauth:bob','mega','mega_remote','Bob MEGA');
 assert.notEqual(alice.id,bob.id);
 assert.deepEqual((await svc.list('oauth:alice')).map(x=>x.id),[alice.id]);
 assert.deepEqual((await svc.list('oauth:bob')).map(x=>x.id),[bob.id]);
 const pending=await svc.testRclone('oauth:bob',bob.id);
 assert.equal(pending.status,'unverified');
 assert.equal(pending.reason,'ISOLATED_CREDENTIAL_NOT_PROVISIONED');
 assert.equal(isolatedCalls.length,0);
 provisioned.set('oauth:alice:'+alice.id,'single-owner-profile');
 const working=await svc.testRclone('oauth:alice',alice.id);
 assert.equal(working.status,'reachable');
 assert.deepEqual(isolatedCalls,[{provider:'mega',remote:'mega_remote',profile:'single-owner-profile'}]);
 await assert.rejects(()=>svc.testRclone('oauth:bob',alice.id),/CONNECTOR_NOT_FOUND/);
 await assert.rejects(()=>svc.rename('oauth:bob',alice.id,'Stolen'),/CONNECTOR_NOT_FOUND/);
 await assert.rejects(()=>svc.disconnect('oauth:bob',alice.id),/CONNECTOR_NOT_FOUND/);
 assert.equal(leakedGlobal,false);
 const disconnected=await svc.disconnect('oauth:alice',alice.id);
 assert.equal(disconnected.status,'revoked');
 assert.equal(provisioned.has('oauth:alice:'+alice.id),false);
 assert.equal((await svc.list('oauth:bob')).length,1);
});
test('public Yaro capability discovery does not claim private commands are registered',()=>{
 const fs=require('node:fs'),path=require('node:path');
 const mcp=fs.readFileSync(path.join(__dirname,'../src/mcp/mcp.service.ts'),'utf8');
 assert.match(mcp,/blocked_pending_per_user_yaro_workspace/);
 assert.match(mcp,/if \(process\.env\.NYX_DEPLOYMENT_MODE==='public'\) return server/);
 const panel=fs.readFileSync(path.join(__dirname,'../src/connectors/connections-panel.ts'),'utf8');
 assert.doesNotMatch(panel,/Configured in Rclone|renderRclone/);
 assert.match(panel,/<details id="nyx-legacy-options" class="nyx-provider-group" hidden>/);
 assert.match(panel,/legacyOptions\.hidden=!legacyAvailable/);
 assert.match(panel,/existingOption\.disabled=!legacyAvailable/);
 assert.match(panel,/if\(!legacyAvailable \|\| !legacyOptions\.open\) return/);
 assert.match(mcp,/provider:z\.enum\(\['google-drive','mega'\]\)/);
});

test("public cloud browsing only lists an active owner's own vaulted account",async t=>{
 configure(t);
 const cid='123e4567-e89b-42d3-a456-426614174000';
 const rows=new Map([[cid,{id:cid,ownerId:'oauth:alice',provider:'mega',
   externalAccountId:'alice_mega',status:'active'}]]);
 let probes=0,globalCalls=0;
 const svc=new ConnectorsService({
   listIsolatedRcloneConnection:async(provider,name,profile,folder)=>{
     probes++;
     assert.equal(provider,'mega');assert.equal(name,'alice_mega');
     assert.equal(profile,'one-secret-owner-profile');
     assert.equal(folder,'private');
     return {schema:'nyx.storage.rclone.list.v1',provider,folder,
       readOnly:true,entries:[{name:'report.txt',isDirectory:false,size:15}],truncated:false};
   },
   rcloneConnections:async()=>{globalCalls++;throw Error('forbidden');},
 },{isEnabled:()=>true,load:async(owner,id)=>{
   assert.equal(owner,'oauth:alice');assert.equal(id,cid);
   return 'one-secret-owner-profile';
 }});
 svc.repository={get:async id=>rows.get(id)||null};
 svc.registry={list:async()=>[...rows.values()]};
 svc.pool={query:async(sql,params)=>{
   assert.match(sql,/nyx_owner_storage_listing_limits/);
   assert.deepEqual(params,['oauth:alice',cid]);
   return{rowCount:1,rows:[{count:1}]};
 }};
 await assert.rejects(()=>svc.listRclone('oauth:bob',cid,'private'),/CONNECTOR_NOT_FOUND/);
 await assert.rejects(()=>svc.listRclone('oauth:alice',cid,'../private'),/RCLONE_LIST_PATH_INVALID/);
 await assert.rejects(()=>svc.listRclone('oauth:alice',cid,'/private'),/RCLONE_LIST_PATH_INVALID/);
 const result=await svc.listRclone('oauth:alice',cid,'private');
 assert.equal(result.readOnly,true);
 assert.equal(result.connectionId,cid);
 assert.deepEqual(result.entries.map(x=>x.name),['report.txt']);
 assert.equal(probes,1);assert.equal(globalCalls,0);
 rows.get(cid).status='pending';
 await assert.rejects(()=>svc.listRclone('oauth:alice',cid,'private'),/STORAGE_CONNECTION_NOT_ACTIVE/);
});
