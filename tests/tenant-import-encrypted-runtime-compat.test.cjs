const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {TenantRcloneService,tenantRcloneConfig}=
  require('../dist/connectors/tenant-rclone.service');
const importer=()=>import(pathToFileURL(path.resolve('scripts/nyx-neon-owner-rclone-import.mjs')).href);
const owner='oauth:google-oauth2|123456789012345678';
const id='6d621bdd-0c89-419d-aec7-56b4b1a15245';
const key=Buffer.alloc(32,11);
const remote={type:'drive',token:JSON.stringify({
  access_token:'fixture_old_access_123',refresh_token:'fixture_refresh_123',
  token_type:'Bearer',expiry:'2026-11-16T10:00:00Z'}),
  client_id:'fixture-client',client_secret:'fixture-secret',
  root_folder_id:'folder_ABC123',team_drive:'0A_shared_fixture_01',
  scope:'drive'};

test('local Rclone profile encrypted in Neon V2 decrypts unchanged by NestNyxDev runtime',async()=>{
 const {sealForTenant}=await importer();
 const profile={provider:'google-drive',token:remote.token,
   rootFolderId:remote.root_folder_id,teamDriveId:remote.team_drive,
   clientId:remote.client_id,clientSecret:remote.client_secret,scope:remote.scope};
 const encrypted=sealForTenant(owner,id,profile,key);
 assert.ok(!encrypted.includes(remote.token));
 assert.ok(!encrypted.includes(remote.client_secret));
 const svc=new TenantRcloneService({});
 svc.encryptionKey=key;
 const recovered=svc.open(owner,id,'google-drive',encrypted);
 assert.deepEqual(recovered,profile);
 const isolated=tenantRcloneConfig(recovered);
 assert.match(isolated,/^root_folder_id = folder_ABC123$/m);
 assert.match(isolated,/^team_drive = 0A_shared_fixture_01$/m);
 assert.match(isolated,/^scope = drive$/m);
 assert.match(isolated,/^client_id = fixture-client$/m);
 assert.equal(svc.open(owner,id,'google-drive',encrypted).token,remote.token);
 assert.throws(()=>svc.open('oauth:google-oauth2|555555555555555',id,'google-drive',encrypted));
 assert.throws(()=>svc.open(owner,'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff','google-drive',encrypted));
});
test('after successful read, rotated Google token is encrypted with exact-owner row CAS',async()=>{
 const {sealForTenant}=await importer();
 const original={provider:'google-drive',rootFolderId:'root',accountRoot:true,
   token:remote.token};
 const encrypted=sealForTenant(owner,id,original,key);
 const fresh={access_token:'fixture_fresh_access_456',
   refresh_token:'fixture_fresh_refresh_456',token_type:'Bearer',
   expiry:'2026-11-17T10:00:00Z'};
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nyx-refresh-test-'));
 const config=path.join(dir,'rclone.conf');
 const writes=[];
 const svc=new TenantRcloneService({});
 svc.encryptionKey=key;
 svc.pool={query:async(sql,args)=>{
   writes.push({sql,args});
   return {rowCount:1};
 }};
 try{
   await fs.writeFile(config,tenantRcloneConfig(original).replace(
     'token = '+original.token,'token = '+JSON.stringify(fresh)),{mode:0o600});
   assert.equal(await svc.persistActiveGoogleRefresh(owner,id,
     original,encrypted,config),true);
   assert.equal(writes.length,1);
   assert.match(writes[0].sql,/state='active'/);
   assert.match(writes[0].sql,/AND encrypted_profile=\$3 RETURNING connection_id/);
   assert.equal(writes[0].args[0],owner);
   assert.equal(writes[0].args[1],id);
   assert.equal(writes[0].args[2],encrypted);
   assert.ok(!writes[0].args[3].includes(fresh.refresh_token));
   const restored=svc.open(owner,id,'google-drive',writes[0].args[3]);
   assert.equal(JSON.parse(restored.token).refresh_token,fresh.refresh_token);
   assert.equal(restored.accountRoot,true);
   svc.pool={query:async()=>({rowCount:0})};
   await assert.rejects(svc.persistActiveGoogleRefresh(owner,id,
     original,encrypted,config),/REFRESH_CONCURRENT_CHANGE/);
 }finally{
   await fs.rm(dir,{recursive:true,force:true});
 }
});
