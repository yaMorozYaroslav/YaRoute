const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {RcloneService}=require('../dist/storage/rclone.service');
const {StorageService}=require('../dist/storage/storage.service');

const oldMode=process.env.NYX_DEPLOYMENT_MODE;
function restoreMode(){
 if(oldMode===undefined)delete process.env.NYX_DEPLOYMENT_MODE;
 else process.env.NYX_DEPLOYMENT_MODE=oldMode;
}
function fixtures() {
 const calls=[];
 const roots={
  listAreas:()=>['MAIN','DRIVE_TEAM','MEGA_ARCHIVE','UNRELATED'],
  get:area=>({
   MAIN:{remote:'gmain',root:'Private/personal',provider:'google-drive',token:'do-not-return'},
   DRIVE_TEAM:{remote:'gmain,team_drive=opaque-id,root_folder_id=',root:'Some/dir',provider:'google-drive'},
   MEGA_ARCHIVE:{remote:'mega_archive',root:'.',provider:'mega',password:'do-not-return'},
   UNRELATED:{remote:'other_remote',root:'/',provider:'other'},
  }[area]),
 };
 const rclone={
  safeRemoteConfiguration:(name,type)=>({
   inspection:'available',declaredScope:type==='drive'?'drive.readonly':'unknown',
   requestedAccess:type==='drive'?'read-only-requested':'unknown',
   sharedDriveConfigured:name==='gmain',rootFolderConfigured:false,serviceAccountConfigured:false,
  }),
  listRemoteNamesByType:async type=>{
   calls.push(type);
   if(type==='drive')return ['gmain','drive_secondary','gmain'];
   if(type==='mega')return ['mega_archive','mega_private'];
   throw Error('Unsupported provider');
  },
  json:async()=>{throw Error('Inventory must not read account files or quota');},
  run:async()=>{throw Error('Inventory must not execute transfers');},
 };
 return {storage:new StorageService(roots,rclone),calls};
}

test('private Rclone inventory lists Google Drive and MEGA remotes with safe aliases only',async t=>{
 t.after(restoreMode);
 process.env.NYX_DEPLOYMENT_MODE='private';
 const {storage,calls}=fixtures();
 const actual=await storage.rcloneConnections();
 assert.deepEqual(actual,{
  schema:'nyx.storage.rclone.connections.v1',
  source:'rclone_config',
  status:'configured_not_live_verified',
  remotes:[
   {provider:'google-drive',name:'drive_secondary',aliases:[],state:'configured',
    configuration:{inspection:'available',declaredScope:'drive.readonly',
      requestedAccess:'read-only-requested',
      sharedDriveConfigured:false,rootFolderConfigured:false,serviceAccountConfigured:false}},
   {provider:'google-drive',name:'gmain',aliases:['DRIVE_TEAM','MAIN'],state:'configured',
    configuration:{inspection:'available',declaredScope:'drive.readonly',
      requestedAccess:'read-only-requested',
      sharedDriveConfigured:true,rootFolderConfigured:false,serviceAccountConfigured:false}},
   {provider:'mega',name:'mega_archive',aliases:['MEGA_ARCHIVE'],state:'configured',
    configuration:{inspection:'available',declaredScope:'unknown',
      requestedAccess:'unknown',
      sharedDriveConfigured:false,rootFolderConfigured:false,serviceAccountConfigured:false}},
   {provider:'mega',name:'mega_private',aliases:[],state:'configured',
    configuration:{inspection:'available',declaredScope:'unknown',
      requestedAccess:'unknown',
      sharedDriveConfigured:false,rootFolderConfigured:false,serviceAccountConfigured:false}},
  ],
 });
 assert.deepEqual(calls,['drive','mega']);
 const serialized=JSON.stringify(actual);
 for(const secret of ['do-not-return','Private/personal','Some/dir','opaque-id','password','token','other_remote'])
  assert.equal(serialized.includes(secret),false,secret);
});

test('Rclone remote enumeration is forbidden in public multi-user mode',async t=>{
 t.after(restoreMode);
 process.env.NYX_DEPLOYMENT_MODE='public';
 const {storage,calls}=fixtures();
 await assert.rejects(()=>storage.rcloneConnections(),/PRIVATE_RCLONE_CONNECTIONS_ONLY/);
 assert.deepEqual(calls,[]);
});

test('Unknown or malformed Rclone remote names fail closed',async t=>{
 t.after(restoreMode);
 process.env.NYX_DEPLOYMENT_MODE='private';
 const roots={listAreas:()=>[],get:()=>{throw Error('unexpected');}};
 const svc=new StorageService(roots,{
  listRemoteNamesByType:async type=>type==='drive'?['secret:argument']:[],
 });
 await assert.rejects(()=>svc.rcloneConnections(),/RCLONE_REMOTE_INVENTORY_INVALID/);
});

test('private inventory remains backend-only; the public-facing panel hides names',()=>{
 const mcp=fs.readFileSync(require('node:path').join(__dirname,'../src/mcp/mcp.service.ts'),'utf8');
 const panel=fs.readFileSync(require('node:path').join(__dirname,'../src/connectors/connections-panel.ts'),'utf8');
 const privateGate=mcp.indexOf("if (process.env.NYX_DEPLOYMENT_MODE==='public') return server;");
 const tool=mcp.indexOf("server.registerTool('nyx_rclone_connections_list'");
 assert.ok(privateGate>0&&tool>privateGate);
 assert.ok(mcp.includes('this.storage.rcloneConnections()'));
 assert.doesNotMatch(panel,/id="rclone-list"/);
 assert.doesNotMatch(panel,/renderRclone|Configured in Rclone/);
 assert.match(panel,/<details id="nyx-legacy-options" class="nyx-provider-group" hidden>/);
 assert.match(panel,/if\(!legacyAvailable \|\| !legacyOptions\.open\) return/);
 assert.match(panel,/call\('nyx_rclone_connections_list',\{\}\)/);
 assert.match(panel,/legacyAvailable=data\.legacyInventoryAvailable===true/);
 assert.match(panel,/id="nyx-add"/);
 assert.match(panel,/google-drive/);
 assert.match(panel,/mega/);
 assert.doesNotMatch(panel,/<input[^>]*type="password"/);
});


test('private Rclone config inspection emits only safe allowlisted fields',async t=>{
 t.after(restoreMode);
 process.env.NYX_DEPLOYMENT_MODE='private';
 const old=process.env.RCLONE_CONFIG_PATH;
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'nyx-safe-config-test-'));
 const config=path.join(folder,'rclone.conf');
 t.after(()=>{fs.rmSync(folder,{recursive:true,force:true});
   if(old===undefined)delete process.env.RCLONE_CONFIG_PATH;
   else process.env.RCLONE_CONFIG_PATH=old;});
 fs.writeFileSync(config,[
  '[drive_alpha]','type = drive','scope = drive.readonly',
  'team_drive = id-do-not-leak','root_folder_id = root-do-not-leak',
  'service_account_file = /secret/service-account.json',
  'token = {"access_token":"top-secret-token"}',
  'client_secret = hidden-client-secret',
  '[mega_private]','type = mega','user = private@example.com',
  'pass = hidden-mega-password',
  '[drive_weird]','type = drive','scope = secret-malicious-scope',
  '',
 ].join('\n'),{mode:0o600});
 process.env.RCLONE_CONFIG_PATH=config;
 const service=new RcloneService();
 const drive=service.safeRemoteConfiguration('drive_alpha','drive');
 assert.deepEqual(drive,{
  inspection:'available',declaredScope:'drive.readonly',
  requestedAccess:'read-only-requested',
  sharedDriveConfigured:true,rootFolderConfigured:true,serviceAccountConfigured:true,
 });
 const mega=service.safeRemoteConfiguration('mega_private','mega');
 assert.equal(mega.declaredScope,'unknown');
 assert.equal(mega.requestedAccess,'unknown');
 assert.equal(mega.sharedDriveConfigured,false);
 assert.equal(service.safeRemoteConfiguration('drive_weird','drive').declaredScope,'unknown');
 assert.equal(service.safeRemoteConfiguration('missing','drive').inspection,'unavailable');
 assert.equal(service.safeRemoteConfiguration('mega_private','drive').inspection,'unavailable');
 const exposed=JSON.stringify([drive,mega,service.safeRemoteConfiguration('drive_weird','drive')]);
 for(const secret of ['top-secret','hidden-client-secret','id-do-not-leak',
   'root-do-not-leak','private@example','hidden-mega','/secret/','secret-malicious']){
   assert.equal(exposed.includes(secret),false,secret);
 }
 process.env.NYX_DEPLOYMENT_MODE='public';
 assert.throws(()=>service.safeRemoteConfiguration('drive_alpha','drive'),/PRIVATE_RCLONE_CONNECTIONS_ONLY/);
});

test('private panel shows expandable safe configuration without claiming verified grants',()=>{
 const panel=fs.readFileSync(require('node:path').join(__dirname,'../src/connectors/connections-panel.ts'),'utf8');
 assert.match(panel,/item\.className='nyx-rclone-remote card'/);
 assert.match(panel,/Configured Google scope:/);
 assert.match(panel,/Requested access:/);
 assert.match(panel,/Shared Drive binding configured:/);
 assert.match(panel,/Root folder binding configured:/);
 assert.match(panel,/Service account configured:/);
 assert.match(panel,/MEGA permissions: unknown/);
 assert.match(panel,/not live-verified/);
 assert.match(panel,/cfg\?\.inspection==='available'/);
 assert.doesNotMatch(panel,/JSON\.stringify\(remote\.configuration\)/);
});
