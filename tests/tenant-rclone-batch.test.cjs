const {test}=require('node:test');
const assert=require('node:assert/strict');
const {parseLocalRcloneBatch}=require('../dist/connectors/tenant-rclone-file-import');
const {TenantRcloneUploadService}=require('../dist/connectors/tenant-rclone-upload.service');

const owner='oauth:google-oauth2|123456789012345678';
const foreign='oauth:google-oauth2|999999999999999';
const ids=['a7c86541-298c-4bbe-8123-5d61bc220e11',
 'a7c86541-298c-4bbe-8123-5d61bc220e12',
 'a7c86541-298c-4bbe-8123-5d61bc220e13'];
const token=JSON.stringify({access_token:'fixture_access',refresh_token:'fixture_refresh'});
const config=[
 '[drive_one]','type = drive','token = '+token,
 '[drive_two]','type = drive','token = '+token,'root_folder_id = folder_two',
 '[mega_three]','type = mega','user = fixture_user','pass = fixture_obscured',
 '[photos_four]','type = google photos','token = unsupported_do_not_import',
].join('\n');
test('batch enumerates all supported, preserves an explicit Drive root, and reports unsupported',()=>{
 const result=parseLocalRcloneBatch(config);
 assert.deepEqual(result.items.map(r=>r.name),['drive_one','drive_two','mega_three']);
 assert.equal(result.items[0].profile.accountRoot,true);
 assert.equal(result.items[1].rootId,'folder_two');
 assert.equal(result.items[2].provider,'mega');
 assert.deepEqual(result.unsupported,['photos_four']);
 assert.equal(result.rejected.length,0);
 assert.ok(!JSON.stringify(result.unsupported).includes('unsupported_do_not_import'));
});
test('duplicate sections, oversized files and malformed sections fail closed',()=>{
 assert.throws(()=>parseLocalRcloneBatch(config+'\n[DRIVE_ONE]\ntype = mega'),/DUPLICATE_REMOTE/);
 assert.throws(()=>parseLocalRcloneBatch(config+'\n[../unsafe]'),/SECTION_INVALID/);
 assert.throws(()=>parseLocalRcloneBatch(config+'z'.repeat(70000)),/FILE_INVALID/);
});
test('batch stages all supported without overwriting active/pending connections and probes exact owner ids',async()=>{
 const created=[], staged=[], requests=[];
 let nonce=0, stored=null;
 const profiles=new Map();
 const connections={
  listStorage:async(actor)=>{
   assert.equal(actor,owner);
   return [{displayName:'drive_one',status:'active',id:'existing',provider:'google-drive'}];
  },
  createStorage:async(actor,provider,name)=>{
   assert.equal(actor,owner);
   const id=ids[nonce++];
   profiles.set(id,{id,provider,status:'pending'});
   created.push({provider,name,id});
   return {id,provider,displayName:name,status:'pending'};
  },
  storagePermissions:async(actor,id,caps)=>{
   assert.equal(actor,owner);assert.deepEqual(caps,['storage:list']);requests.push({id,caps});
  },
  storageResources:async(actor,id,roots)=>{
   assert.equal(actor,owner);assert.equal(roots.length,1);requests.push({id,roots});
  },
  getOwned:async(actor,id)=>{
   if(actor!==owner||!profiles.has(id))throw Error('FOREIGN_OWNER');
   return profiles.get(id);
  },
 };
 const storage={
  stageImportedCredentialIfAbsent:async(actor,id,profile)=>{
   assert.equal(actor,owner);staged.push({id,profile});return {staged:true};
  },
  probePending:async(actor,id)=>{
   assert.equal(actor,owner);assert.ok(profiles.has(id));return 'verified';
  },
  activateImportedReadOnly:async(actor,id)=>{
   assert.equal(actor,owner);const p=profiles.get(id);p.status='active';
   return {status:'active',provider:p.provider};
  },
 };
 const svc=new TenantRcloneUploadService(connections,storage);
 svc.pool={query:async(sql,args=[])=>{
   if(sql.startsWith('INSERT INTO nyx_rclone_import_batch_states_v1')){
     stored={digest:args[0],owner_id:args[1],connection_ids:JSON.parse(args[2]||'[]')};
     return {rowCount:1};
   }
   if(sql.startsWith('DELETE FROM nyx_rclone_import_batch_states_v1')){
     return {rowCount:1,rows:[{owner_id:owner}]};
   }
   if(sql.startsWith('SELECT owner_id,connection_ids')){
     return {rowCount:1,rows:[stored]};
   }
   if(sql.startsWith('SELECT digest'))return {rowCount:1};
   throw Error('UNEXPECTED_SQL');
 }};
 const old=process.env.NYX_PUBLIC_URL;
 process.env.NYX_PUBLIC_URL='https://nestnyx.example.invalid';
 try{
  const begin=await svc.beginAll(owner);
  assert.equal(new URL(begin.url).pathname,'/connect/rclone/import/batch');
  const result=await svc.stageAll(new URL(begin.url).searchParams.get('state'),config);
  assert.equal(result.status,'pending_read_probes');
  assert.equal(result.staged.length,2);
  assert.deepEqual(result.alreadyPresent,['drive_one']);
  assert.deepEqual(result.unsupported,['photos_four']);
  assert.deepEqual(created.map(x=>x.name),['drive_two','mega_three']);
  assert.equal(staged.length,2);
  assert.equal(requests.length,4);
  assert.deepEqual(result.staged.map(r=>r.id),ids.slice(0,2));
  await assert.rejects(
    svc.probeAndActivateAllStep(result.continuation,ids[2]),
    /NOT_AUTHORIZED/);
  const first=await svc.probeAndActivateAllStep(result.continuation,ids[0]);
  assert.equal(first.status,'active');
  const second=await svc.probeAndActivateAllStep(result.continuation,ids[1]);
  assert.equal(second.status,'active');
  assert.equal((await svc.probeAndActivateAllStep(result.continuation,ids[0])).status,'active');
  assert.ok(!JSON.stringify(first).includes('fixture_refresh'));
  assert.equal(foreign===owner,false);
 }finally{
   if(old===undefined)delete process.env.NYX_PUBLIC_URL;
   else process.env.NYX_PUBLIC_URL=old;
 }
});
