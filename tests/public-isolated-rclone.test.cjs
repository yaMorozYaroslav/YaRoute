const {test}=require('node:test');
const assert=require('node:assert/strict');
const {ConnectorsService}=require('../dist/connectors/connectors.service');
const {ConnectorRegistry}=require('../dist/connectors/connector-registry');
const {RcloneService}=require('../dist/storage/rclone.service');
const {SharedRootsService}=require('../dist/storage/shared-roots.service');
const old={...Object.fromEntries(['NYX_DEPLOYMENT_MODE','NYX_PUBLIC_CONNECTORS_ENABLED',
 'NYX_RCLONE_VAULT_ENABLED','NYX_SHARED_ROOTS_JSON'].map(k=>[k,process.env[k]]))};
function configure(t){
 t.after(()=>{for(const[k,v]of Object.entries(old))v===undefined?
 delete process.env[k]:process.env[k]=v});
 process.env.NYX_DEPLOYMENT_MODE='public';
 process.env.NYX_PUBLIC_CONNECTORS_ENABLED='true';
 process.env.NYX_RCLONE_VAULT_ENABLED='true';
 delete process.env.NYX_SHARED_ROOTS_JSON;
}
test('public connector mode has no global roots and shared Rclone executor is blocked',async t=>{
 configure(t);
 const roots=new SharedRootsService();
 assert.deepEqual(roots.listAreas(),[]);
 process.env.NYX_SHARED_ROOTS_JSON=JSON.stringify({OPERATOR:{remote:'shared',root:'.'}});
 assert.deepEqual(new SharedRootsService().listAreas(),[]);
 const rclone=new RcloneService();
 assert.doesNotThrow(()=>rclone.onModuleInit());
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

test('public tenants never see, create, test, rename or revoke MEGA connections',async t=>{
 configure(t);
 const id='123e4567-e89b-42d3-a456-426614174000';
 const oldMega={id,ownerId:'oauth:alice',provider:'mega',displayName:'Legacy MEGA',
   externalAccountId:'MEGA_1',status:'active',capabilities:[],providerCapabilities:[],resources:[]};
 const ownDrive={id:'123e4567-e89b-42d3-a456-426614174001',
   ownerId:'oauth:alice',provider:'google-drive',displayName:'Personal Drive',
   externalAccountId:'drive_1',status:'pending',capabilities:[],providerCapabilities:[],resources:[]};
 const stored=[oldMega,ownDrive];
 let providerCalls=0;
 const storage={rcloneConnections:async()=>{providerCalls++;throw Error('private inventory forbidden');}};
 const vault={isEnabled:()=>true,load:async()=>{providerCalls++;throw Error('MEGA vault forbidden');},
   revoke:async()=>{providerCalls++;throw Error('MEGA vault mutation forbidden');}};
 const svc=new ConnectorsService(storage,vault);
 svc.repository={get:async key=>stored.find(x=>x.id===key)||null,
   list:async owner=>stored.filter(x=>x.ownerId===owner),save:async()=>{}};
 svc.registry={list:async owner=>stored.filter(x=>x.ownerId===owner)};
 svc.pool={query:async()=>{providerCalls++;throw Error('DB mutation forbidden');}};
 assert.deepEqual((await svc.list('oauth:alice')).map(x=>x.provider),['google-drive']);
 await assert.rejects(()=>svc.createRclone('oauth:alice','mega','MEGA_2','No public MEGA'),/PUBLIC_MEGA_DISABLED/);
 await assert.rejects(()=>svc.testRclone('oauth:alice',id),/PUBLIC_MEGA_DISABLED/);
 await assert.rejects(()=>svc.rename('oauth:alice',id,'Changed'),/PUBLIC_MEGA_DISABLED/);
 await assert.rejects(()=>svc.disconnect('oauth:alice',id),/PUBLIC_MEGA_DISABLED/);
 assert.equal(oldMega.status,'active');
 assert.equal(providerCalls,0);
});
test('public Yaro capability discovery does not claim private commands are registered',()=>{
 const fs=require('node:fs'),path=require('node:path');
 const mcp=fs.readFileSync(path.join(__dirname,'../src/mcp/mcp.service.ts'),'utf8');
 assert.match(mcp,/blocked_pending_per_user_yaro_workspace/);
 assert.match(mcp,/if \(process\.env\.NYX_DEPLOYMENT_MODE==='public'\) return server/);
 const panel=fs.readFileSync(path.join(__dirname,'../src/connectors/connections-panel.ts'),'utf8');
 assert.match(panel,/megaOption\.disabled=!legacy/);
 assert.match(mcp,/z\.literal\('google-drive'\) : z\.enum\(\['google-drive','mega'\]\)/);
});
