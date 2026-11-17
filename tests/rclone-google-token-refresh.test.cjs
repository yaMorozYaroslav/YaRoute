const {test}=require('node:test');
const assert=require('node:assert/strict');
const {refreshedGoogleFromIsolatedConfig}=require('../dist/connectors/rclone-google-token-refresh');

const oldToken={access_token:'old_access_token_123',token_type:'Bearer',
  refresh_token:'original_refresh_token_123',expiry:'2026-11-16T12:00:00.000Z'};
const profile={provider:'google-drive',rootFolderId:'root',accountRoot:true,
  teamDriveId:'0A_shared_123',token:JSON.stringify(oldToken)};
const isolated=payload=>['[tenant]','type = drive','token = '+JSON.stringify(payload),
  'root_folder_id = root','[other]','token = {not-used}'].join('\n');

test('successful Rclone refresh preserves imported root/Shared Drive and new refresh token',()=>{
 const refreshed={access_token:'new_access_token_123',token_type:'Bearer',
  refresh_token:'rotated_refresh_token_123',expiry:'2026-11-17T12:00:00Z'};
 const updated=refreshedGoogleFromIsolatedConfig(profile,isolated(refreshed));
 assert.equal(JSON.parse(updated.token).access_token,refreshed.access_token);
 assert.equal(JSON.parse(updated.token).refresh_token,refreshed.refresh_token);
 assert.equal(updated.accountRoot,true);
 assert.equal(updated.teamDriveId,'0A_shared_123');
 assert.equal(updated.rootFolderId,'root');
 assert.equal(profile.token,JSON.stringify(oldToken));
});
test('never discard existing refresh grant when Rclone only updates access token',()=>{
 const updated=refreshedGoogleFromIsolatedConfig(profile,isolated({
  access_token:'new_access_token_456',token_type:'Bearer'}));
 assert.equal(JSON.parse(updated.token).refresh_token,oldToken.refresh_token);
 assert.equal(JSON.parse(updated.token).access_token,'new_access_token_456');
});
test('unchanged Rclone token requires no vault write',()=>{
 assert.equal(refreshedGoogleFromIsolatedConfig(profile,isolated(oldToken)),null);
});
test('invalid, duplicated, missing, or INI-injected token fails closed',()=>{
 const invalid=[
   '[tenant]\ntype = drive\n[another]\ntoken = '+JSON.stringify(oldToken),
   '[tenant]\ntoken = '+JSON.stringify(oldToken)+'\ntoken = '+JSON.stringify(oldToken),
   '[tenant]\ntoken = {not-json}',

   '[tenant]\ntoken = '+JSON.stringify({access_token:'abc\n[evil]'}),
   'x'.repeat(150000)
 ];
 for(const config of invalid){
  assert.throws(()=>refreshedGoogleFromIsolatedConfig(profile,config),
    /TENANT_GOOGLE_REFRESH_/);
 }
 const noDurableGrant={...profile,token:JSON.stringify({access_token:'old_access_token_123'})};
 assert.throws(()=>refreshedGoogleFromIsolatedConfig(noDurableGrant,
  isolated({access_token:'new_access_token_123'})),/MISSING_REFRESH_TOKEN/);
});
test('token section cannot be fooled by another remote token',()=>{
 const current=isolated(oldToken);
 assert.equal(refreshedGoogleFromIsolatedConfig(profile,current),null);
});
test('active refresh code uses encrypted row CAS, not raw token logging or plaintext storage',()=>{
 const fs=require('node:fs');
 const source=fs.readFileSync('src/connectors/tenant-rclone.service.ts','utf8');
 assert.match(source,/persistActiveGoogleRefresh/);
 assert.match(source,/refreshedGoogleFromIsolatedConfig/);
 assert.match(source,/AND encrypted_profile=\$3 RETURNING connection_id/);
 assert.match(source,/const sealed=this\.seal\(ownerId,connectionId,next\)/);
 assert.match(source,/state='active'/);
 assert.match(source,/target\.profile\.provider==='google-drive'/);
 assert.match(source,/afterSuccess\(config\)/);
 assert.doesNotMatch(source,/console\.log\(.*access_token/);
});
