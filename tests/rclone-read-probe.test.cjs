const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {RcloneService}=require('../dist/storage/rclone.service');
const {StorageService}=require('../dist/storage/storage.service');
const {CONNECTIONS_PANEL_HTML,CONNECTIONS_PANEL_URI}=require('../dist/connectors/connections-panel');

const oldMode=process.env.NYX_DEPLOYMENT_MODE;
function reset(){if(oldMode===undefined)delete process.env.NYX_DEPLOYMENT_MODE;
 else process.env.NYX_DEPLOYMENT_MODE=oldMode;}

test('read-only probe checks exact configured remote and does not imply writes',async t=>{
 t.after(reset);
 process.env.NYX_DEPLOYMENT_MODE='private';
 let checks=0;
 const kinds=[];
 const rclone={
  listRemoteNamesByType:async type=>{kinds.push(type);return type==='drive'?['drive_one']:['mega_one'];},
  probeRemoteRead:async name=>{checks++;return name==='drive_one'?'verified':'failed';},
 };
 const storage=new StorageService({listAreas:()=>[]},rclone);
 const drive=await storage.probeRcloneConnection('google-drive','drive_one');
 assert.deepEqual(Object.keys(drive).sort(),['checkedAt','connectivity','name','provider','schema','writeAccess']);
 assert.equal(drive.schema,'nyx.storage.rclone.read-probe.v1');
 assert.equal(drive.connectivity,'verified');
 assert.equal(drive.writeAccess,'not-tested');
 const mega=await storage.probeRcloneConnection('mega','mega_one');
 assert.equal(mega.connectivity,'failed');
 assert.equal(mega.writeAccess,'not-tested');
 await assert.rejects(()=>storage.probeRcloneConnection('mega','drive_one'),/RCLONE_REMOTE_NOT_CONFIGURED/);
 await assert.rejects(()=>storage.probeRcloneConnection('google-drive','mega_one'),/RCLONE_REMOTE_NOT_CONFIGURED/);
 await assert.rejects(()=>storage.probeRcloneConnection('mega','drive:one'),/RCLONE_REMOTE_INVALID/);
 assert.equal(checks,2);
 assert.deepEqual(kinds,['drive','mega','mega','drive']);
 process.env.NYX_DEPLOYMENT_MODE='public';
 await assert.rejects(()=>storage.probeRcloneConnection('google-drive','drive_one'),/PRIVATE_RCLONE_CONNECTIONS_ONLY/);
 assert.equal(checks,2);
});

test('same remote concurrent probes perform only one outbound check',async t=>{
 t.after(reset);process.env.NYX_DEPLOYMENT_MODE='private';
 let probeCalls=0,done;
 const storage=new StorageService({listAreas:()=>[]},{
  listRemoteNamesByType:async()=>['drive_one'],
  probeRemoteRead:async()=>{probeCalls++;return new Promise(resolve=>{done=resolve;});},
 });
 const p1=storage.probeRcloneConnection('google-drive','drive_one');
 const p2=storage.probeRcloneConnection('google-drive','drive_one');
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(probeCalls,1);
 done('verified');
 const result=await Promise.all([p1,p2]);
 assert.deepEqual(result[0],result[1]);
 assert.equal(result[0].writeAccess,'not-tested');
});

test('subprocess probe uses read-only lsf, discards stdout/stderr, bounds runtime and output',async t=>{
 t.after(reset);process.env.NYX_DEPLOYMENT_MODE='private';
 const prev=process.env.RCLONE_BINARY;
 const config=process.env.RCLONE_CONFIG_PATH;
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nyx-rclone-probe-'));
 t.after(()=>{
  fs.rmSync(dir,{recursive:true,force:true});
  if(prev===undefined)delete process.env.RCLONE_BINARY;else process.env.RCLONE_BINARY=prev;
  if(config===undefined)delete process.env.RCLONE_CONFIG_PATH;else process.env.RCLONE_CONFIG_PATH=config;
 });
 const script=path.join(dir,'fake-rclone');
 fs.writeFileSync(script,'#!/bin/sh\nprintf "secret-file-name\\n"\nexit 0\n',{mode:0o700});
 process.env.RCLONE_BINARY=script;process.env.RCLONE_CONFIG_PATH=path.join(dir,'config');
 const svc=new RcloneService();
 assert.equal(await svc.probeRemoteRead('drive_one'),'verified');
 await assert.rejects(()=>svc.probeRemoteRead('invalid:remote'),/RCLONE_REMOTE_INVALID/);
 process.env.NYX_DEPLOYMENT_MODE='public';
 await assert.rejects(()=>svc.probeRemoteRead('drive_one'),/PRIVATE_RCLONE_CONNECTIONS_ONLY/);
});

test('UI presents per-remote expandable scope, connectivity, write status and test button',()=>{
 const ui=CONNECTIONS_PANEL_HTML;
 const mcp=fs.readFileSync(path.join(__dirname,'../src/mcp/mcp.service.ts'),'utf8');
 assert.match(CONNECTIONS_PANEL_URI,/v7\.html$/);
 for(const expression of [/el\('details'\)/,/className='nyx-remote card'/,
  /Configured scope:/,/Connectivity:/,/Write access: Not tested/,
  /Test connection/,/remoteReadChecks=new Map\(\)/,/result\.writeAccess!=='not-tested'/]){
  assert.match(ui,expression);
 }
 assert.doesNotMatch(ui,/Configured · not connectivity-tested/);
 const start=mcp.indexOf("server.registerTool('nyx_rclone_connection_test_read'");
 const end=mcp.indexOf("server.registerTool('nyx_head_status'",start);
 assert.ok(start>=0&&end>start);
 const tool=mcp.slice(start,end);
 assert.match(tool,/this\.connectorOwner\(\)/);
 assert.match(tool,/this\.storage\.probeRcloneConnection\(provider,name\)/);
 assert.match(tool,/readOnlyHint:true/);
 assert.match(tool,/visibility:\['app'\]/);
 assert.doesNotMatch(ui,/innerHTML=remote|JSON\.stringify\(remote\.configuration\)/);
});
