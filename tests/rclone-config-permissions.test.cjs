const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {RcloneService}=require('../dist/storage/rclone.service');
const {CONNECTIONS_PANEL_HTML,CONNECTIONS_PANEL_URI}=require('../dist/connectors/connections-panel');

test('Rclone config permissions include only safe boolean flags and recognized scope',t=>{
 const previous=Object.fromEntries(['NYX_DEPLOYMENT_MODE','RCLONE_CONFIG_PATH']
   .map(k=>[k,process.env[k]]));
 t.after(()=>{for(const [k,v] of Object.entries(previous))
   v===undefined?delete process.env[k]:process.env[k]=v;});
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'rclone-safe-read-'));
 t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const config=path.join(temp,'rclone.conf');
 fs.writeFileSync(config,[
  '[drive_private]','type = drive','scope = drive.readonly',
  'team_drive = confidential-team-id','root_folder_id = private-root-id',
  'service_account_file = /local/account.json',
  'token = {"access_token":"never-expose"}',
  'client_secret = never-expose-secret',
  '[drive_unspecified]','type = drive','token = {"access_token":"hidden"}',
  '[drive_unknown]','type = drive','scope = https://malicious.invalid/do-not-echo',
  '[mega_private]','type = mega','user = hidden-private-mega-user','pass = do-not-echo',
  '',
 ].join('\n'),{mode:0o600});
 process.env.NYX_DEPLOYMENT_MODE='private';
 process.env.RCLONE_CONFIG_PATH=config;
 const svc=new RcloneService();
 assert.deepEqual(svc.safeRemoteConfiguration('drive_private','drive'),{
  inspection:'available',declaredScope:'drive.readonly',requestedAccess:'read-only-requested',
  sharedDriveConfigured:true,rootFolderConfigured:true,serviceAccountConfigured:true,
 });
 assert.equal(svc.safeRemoteConfiguration('drive_unspecified','drive').declaredScope,'unknown');
 assert.equal(svc.safeRemoteConfiguration('drive_unknown','drive').declaredScope,'unknown');
 assert.equal(svc.safeRemoteConfiguration('mega_private','mega').requestedAccess,'unknown');
 assert.equal(svc.safeRemoteConfiguration('mega_private','drive').inspection,'unavailable');
 assert.equal(svc.safeRemoteConfiguration('missing','drive').inspection,'unavailable');
 assert.throws(()=>svc.safeRemoteConfiguration('other:remote','drive'),/RCLONE_REMOTE_INVALID/);
 const exposed=JSON.stringify([
   svc.safeRemoteConfiguration('drive_private','drive'),
   svc.safeRemoteConfiguration('drive_unknown','drive'),
   svc.safeRemoteConfiguration('mega_private','mega'),
 ]);
 for(const secret of ['never-expose','confidential-team-id','private-root-id',
   'hidden-private-mega-user','/local/account.json','malicious.invalid']){
   assert.equal(exposed.includes(secret),false,secret);
 }
 process.env.NYX_DEPLOYMENT_MODE='public';
 assert.throws(()=>svc.safeRemoteConfiguration('drive_private','drive'),/PRIVATE_RCLONE_CONNECTIONS_ONLY/);
});

test('Rclone permission sections are read-only and never render raw config or secret inputs',()=>{
 assert.match(CONNECTIONS_PANEL_URI,/v6\.html$/);
 const ui=CONNECTIONS_PANEL_HTML;
 assert.match(ui,/Permissions & Rclone configuration/);
 assert.match(ui,/Declared Google OAuth scope:/);
 assert.match(ui,/Root folder restriction configured:/);
 assert.match(ui,/Service account configured:/);
 assert.match(ui,/MEGA remote: account permissions cannot be inferred/);
 assert.match(ui,/Change settings only in Rclone/);
 assert.doesNotMatch(ui,/JSON\.stringify\(remote\.configuration\)|innerHTML=remote/);
 assert.doesNotMatch(ui,/<input[^>]+type="password"/);
});
