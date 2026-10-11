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
