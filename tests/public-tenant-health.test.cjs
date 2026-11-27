const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {RcloneService}=require('../dist/storage/rclone.service');
test('public Rclone version checks binary without reading global credentials',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nyx-public-health-test-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const executable=path.join(dir,'rclone-test');
 fs.writeFileSync(executable,[
  '#!/usr/bin/env node',
  'if(process.argv.slice(2).join(",")!=="version")process.exit(9);',
  'if(process.env.NYX_TEST_LEAK_MARKER||process.env.RCLONE_CONFIG_B64)process.exit(10);',
  'console.log("rclone v1.99.0 - safe-health-fixture");',
 ].join('\n')+'\n',{mode:0o700});
 const oldMode=process.env.NYX_DEPLOYMENT_MODE,oldMarker=process.env.NYX_TEST_LEAK_MARKER;
 process.env.NYX_DEPLOYMENT_MODE='public';
 process.env.NYX_TEST_LEAK_MARKER='must-never-reach-subprocess';
 t.after(()=>{
  if(oldMode===undefined)delete process.env.NYX_DEPLOYMENT_MODE;
  else process.env.NYX_DEPLOYMENT_MODE=oldMode;
  if(oldMarker===undefined)delete process.env.NYX_TEST_LEAK_MARKER;
  else process.env.NYX_TEST_LEAK_MARKER=oldMarker;
 });
 const svc=new RcloneService();
 svc.binary=executable;
 assert.equal(await svc.version(),'rclone v1.99.0 - safe-health-fixture');
 await assert.rejects(()=>svc.run(['listremotes']),/PRIVATE_RCLONE_CONNECTIONS_ONLY/);
});
test('private version behavior remains unchanged for legacy operator Rclone',async t=>{
 const old=process.env.NYX_DEPLOYMENT_MODE;
 process.env.NYX_DEPLOYMENT_MODE='private';
 t.after(()=>{if(old===undefined)delete process.env.NYX_DEPLOYMENT_MODE;
  else process.env.NYX_DEPLOYMENT_MODE=old;});
 const svc=new RcloneService(),args=[];
 svc.run=async a=>{args.push(a);return{stdout:'rclone v1.98.1\n',stderr:''};};
 assert.equal(await svc.version(),'rclone v1.98.1');
 assert.deepEqual(args,[['version']]);
});
