const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {RcloneService}=require('../dist/storage/rclone.service');
const vars=['RCLONE_BINARY','NYX_DEPLOYMENT_MODE','NYX_API_KEY','RCLONE_CONFIG_B64'];
function backup(){const values=Object.fromEntries(vars.map(k=>[k,process.env[k]]));
 return()=>{for(const [k,v] of Object.entries(values)){
 if(v===undefined)delete process.env[k];else process.env[k]=v;}};}
test('isolated provider probe uses temporary 0600 profile and does not forward inherited secrets',async t=>{
 const restore=backup();t.after(restore);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nyx-probe-test-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const report=path.join(dir,'report.json');
 const binary=path.join(dir,'fake-rclone');
 const lines=[
  '#!/usr/bin/env node',
  "const fs=require('node:fs');",
  "const args=process.argv.slice(2);",
  "const config=args[1];",
  "const info={args,mode:fs.statSync(config).mode & 0o777,",
  " secretInConfig:fs.readFileSync(config,'utf8').includes('FAKE_SECRET'),",
  " inheritedNyx:!!process.env.NYX_API_KEY,inheritedRclone:!!process.env.RCLONE_CONFIG_B64};",
  'fs.writeFileSync('+JSON.stringify(report)+',JSON.stringify(info));',
  "process.stdout.write('PROVIDER_SECRET_IN_OUTPUT');",
 ];
 fs.writeFileSync(binary,lines.join('\n'),{mode:0o700});
 process.env.RCLONE_BINARY=binary;
 process.env.NYX_DEPLOYMENT_MODE='private';
 process.env.NYX_API_KEY='SECRET_SERVER_API_KEY';
 process.env.RCLONE_CONFIG_B64='SECRET_GLOBAL_RCLONE_CONFIG';
 const service=new RcloneService();
 const ok=await service.probeIsolated('drive_one','[drive_one]\ntype = drive\ntoken = FAKE_SECRET\n');
 assert.equal(ok,true);
 const result=JSON.parse(fs.readFileSync(report,'utf8'));
 assert.equal(result.args[0],'--config');
 assert.equal(result.args[2],'about');
 assert.equal(result.args[3],'drive_one:');
 assert.equal(result.mode,0o600);
 assert.equal(result.secretInConfig,true);
 assert.equal(result.inheritedNyx,false);
 assert.equal(result.inheritedRclone,false);
 assert.equal(fs.existsSync(result.args[1]),false);
 assert.equal(fs.existsSync(path.dirname(result.args[1])),false);
});
test('isolated probe rejects public mode and injected remote arguments',async t=>{
 const restore=backup();t.after(restore);
 process.env.NYX_DEPLOYMENT_MODE='public';
 const service=new RcloneService();
 await assert.rejects(()=>service.probeIsolated('drive_one','[drive_one]\ntype = drive\n'),
 /PUBLIC_RCLONE_RUNTIME_DISABLED/);
 process.env.NYX_DEPLOYMENT_MODE='private';
 await assert.rejects(()=>service.probeIsolated('--config','bad'),/RCLONE_PROFILE_INVALID/);
});
