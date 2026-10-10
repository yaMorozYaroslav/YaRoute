const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
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
   {provider:'google-drive',name:'drive_secondary',aliases:[],state:'configured'},
   {provider:'google-drive',name:'gmain',aliases:['DRIVE_TEAM','MAIN'],state:'configured'},
   {provider:'mega',name:'mega_archive',aliases:['MEGA_ARCHIVE'],state:'configured'},
   {provider:'mega',name:'mega_private',aliases:[],state:'configured'},
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

test('Rclone panel MCP tool is private-only; renders names as text, not HTML',()=>{
 const mcp=fs.readFileSync(require('node:path').join(__dirname,'../src/mcp/mcp.service.ts'),'utf8');
 const panel=fs.readFileSync(require('node:path').join(__dirname,'../src/connectors/connections-panel.ts'),'utf8');
 const privateGate=mcp.indexOf("if (process.env.NYX_DEPLOYMENT_MODE==='public') return server;");
 const tool=mcp.indexOf("server.registerTool('nyx_rclone_connections_list'");
 assert.ok(privateGate>0&&tool>privateGate);
 assert.match(mcp,/this\.storage\.rcloneConnections\(\)/);
 assert.match(panel,/id="rclone-list"/);
 assert.match(panel,/nyx_rclone_connections_list/);
 assert.match(panel,/renderRclone/);
 assert.match(panel,/\['google-drive','mega'\]/);
 assert.match(panel,/line\.append\(el\('strong',remote\.name\)/);
 assert.doesNotMatch(panel,/<input[^>]*type="password"/);
});
