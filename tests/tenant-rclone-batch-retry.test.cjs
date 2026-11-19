const {test}=require('node:test');
const assert=require('node:assert/strict');
const {TenantRcloneUploadService}=require('../dist/connectors/tenant-rclone-upload.service');
const {TenantRcloneService}=require('../dist/connectors/tenant-rclone.service');
const owner='oauth:google-oauth2|123456789012345678';
const id='d18a4c63-b94d-4a92-9e59-52c82b2152a1';
const config='[drive_one]\ntype = drive\ntoken = '+
  JSON.stringify({access_token:'fixture_access',refresh_token:'fixture_refresh'});
const pending={
 id,displayName:'drive_one',status:'pending',provider:'google-drive',
 externalAccountId:'pending',capabilities:['storage:list'],
 providerCapabilities:[],resources:[{kind:'drive',id:'root',
 capabilities:['storage:list']}],
};

test('retry stages only an identical pending connection with no existing credential',async()=>{
 const seen=[];
 const con={
   listStorage:async()=>[pending],
   createStorage:async()=>{throw Error('MUST_NOT_CREATE_DUPLICATE');},
 };
 const storage={
   stageImportedCredentialIfAbsent:async(actor,cid,profile)=>{
     seen.push({actor,cid,profile});return {staged:true};
   },
 };
 const svc=new TenantRcloneUploadService(con,storage);
 svc.pool={query:async(sql,args=[])=>{
   if(sql.startsWith('DELETE FROM nyx_rclone_import_batch_states_v1'))
     return {rowCount:1,rows:[{owner_id:owner}]};
   if(sql.startsWith('INSERT INTO nyx_rclone_import_batch_states_v1'))
     return {rowCount:1};
   throw Error('Unexpected SQL query');
 }};
 const result=await svc.stageAll('a'.repeat(43),config);
 assert.equal(result.staged.length,1);
 assert.equal(result.staged[0].id,id);
 assert.equal(seen.length,1);
 assert.equal(seen[0].actor,owner);
 assert.equal(seen[0].cid,id);
});
test('already credentialed placeholder is never overwritten during retry',async()=>{
 const con={listStorage:async()=>[pending],
   createStorage:async()=>{throw Error('MUST_NOT_CREATE');}};
 let stageCalls=0;
 const storage={stageImportedCredentialIfAbsent:async()=>{
   stageCalls++;return {staged:false};}};
 const svc=new TenantRcloneUploadService(con,storage);
 svc.pool={query:async(sql)=>{
   if(sql.startsWith('DELETE FROM nyx_rclone_import_batch_states_v1'))
     return {rowCount:1,rows:[{owner_id:owner}]};
   if(sql.startsWith('INSERT INTO nyx_rclone_import_batch_states_v1'))
     return {rowCount:1};
   throw Error('Unexpected SQL');
 }};
 const result=await svc.stageAll('b'.repeat(43),config);
 assert.equal(stageCalls,1);
 assert.deepEqual(result.alreadyPresent,['drive_one']);
 assert.equal(result.staged.length,0);
});
test('wrong pending root never invokes staging',async()=>{
 let invoked=false;
 const con={listStorage:async()=>[{...pending,resources:[{
   kind:'drive',id:'other',capabilities:['storage:list']}]}]};
 const storage={stageImportedCredentialIfAbsent:async()=>{invoked=true;}};
 const svc=new TenantRcloneUploadService(con,storage);
 svc.pool={query:async(sql)=>{
   if(sql.startsWith('DELETE FROM nyx_rclone_import_batch_states_v1'))
     return {rowCount:1,rows:[{owner_id:owner}]};
   if(sql.startsWith('INSERT INTO nyx_rclone_import_batch_states_v1'))
     return {rowCount:1};
   throw Error('Unexpected SQL');
 }};
 const result=await svc.stageAll('c'.repeat(43),config);
 assert.deepEqual(result.alreadyPresent,['drive_one']);
 assert.equal(invoked,false);
});
test('credential insert is atomic and refuses existing encrypted versions',async()=>{
 const checks=[];
 const svc=new TenantRcloneService({
   getOwned:async(actor,cid)=>{
     if(actor!==owner||cid!==id)throw Error('foreign');
     return pending;
   },
 });
 svc.encryptionKey=Buffer.alloc(32,8);
 svc.pool={query:async(sql,args)=>{
   checks.push({sql,args});return {rowCount:0};
 }};
 const profile={provider:'google-drive',rootFolderId:'root',accountRoot:true,
   token:JSON.stringify({access_token:'fixture_access',refresh_token:'fixture_refresh'})};
 const result=await svc.stageImportedCredentialIfAbsent(owner,id,profile);
 assert.equal(result.staged,false);
 assert.match(checks[0].sql,/ON CONFLICT \(owner_id,connection_id,state\) DO NOTHING/);
 assert.match(checks[0].sql,/NOT EXISTS/);
 assert.equal(checks.length,1);
 assert.ok(!JSON.stringify(result).includes('fixture_refresh'));
});
