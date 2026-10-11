const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawnSync}=require('node:child_process');
const {pathToFileURL}=require('node:url');
const key=Buffer.alloc(32,7).toString('base64');
const base={NYX_DEPLOYMENT_MODE:'private',NYX_PRIVATE_OAUTH_SUBJECTS:'subject-1',
 DATABASE_URL:'configured-nonsecret-placeholder',
 RCLONE_CONFIG_B64:'non-secret-fixture',
 NYX_RCLONE_VAULT_ENABLED:'true',NYX_RCLONE_CREDENTIAL_KEY:key};
test('private release validator rejects unsafe conditions without exposing secrets',async()=>{
 const {privateReleaseConditions}=await import(pathToFileURL(path.resolve('scripts/private-release-conditions.mjs')));
 assert.deepEqual(privateReleaseConditions(base),[]);
 assert.ok(privateReleaseConditions({...base,NYX_PRIVATE_OAUTH_SUBJECTS:'a,b'}).includes('PRIVATE_OAUTH_REQUIRES_ONE_SUBJECT'));
 assert.ok(privateReleaseConditions({...base,NYX_PRIVATE_OAUTH_SUBJECTS:''}).includes('PRIVATE_OAUTH_REQUIRES_ONE_SUBJECT'));
 assert.ok(privateReleaseConditions({...base,DATABASE_URL:''}).includes('NEON_DATABASE_NOT_CONFIGURED'));
 assert.ok(privateReleaseConditions({...base,NYX_RCLONE_VAULT_ENABLED:'true',NYX_RCLONE_CREDENTIAL_KEY:''}).includes('RCLONE_VAULT_KEY_NOT_CONFIGURED'));
 const publicBase={...base,NYX_DEPLOYMENT_MODE:'public',
   NYX_PUBLIC_CONNECTORS_ENABLED:'true',NYX_PRIVATE_OAUTH_SUBJECTS:'alice,bob'};
 delete publicBase.RCLONE_CONFIG_B64;
 assert.deepEqual(privateReleaseConditions(publicBase),[]);
 assert.ok(privateReleaseConditions({...publicBase,NYX_RCLONE_VAULT_ENABLED:'false'})
   .includes('PUBLIC_RCLONE_VAULT_REQUIRED'));
 assert.ok(privateReleaseConditions({...publicBase,RCLONE_CONFIG_B64:'operator-config'})
   .includes('PUBLIC_GLOBAL_RCLONE_CONFIG_FORBIDDEN'));
 assert.ok(privateReleaseConditions({...publicBase,NYX_PUBLIC_CONNECTORS_ENABLED:'false'})
   .includes('PUBLIC_CONNECTOR_MODE_REQUIRED'));
});
test('release preflight reads Heroku config and does not leak secret values in logs',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nyx-private-check-'));
 try{
   const file=path.join(dir,'vars.json');
   fs.writeFileSync(file,JSON.stringify({...base,NYX_PRIVATE_OAUTH_SUBJECTS:'a,b'}),{mode:0o600});
   const res=spawnSync(process.execPath,['scripts/verify-private-release-config.mjs',file],{encoding:'utf8'});
   assert.equal(res.status,1);
   assert.match(res.stderr,/PRIVATE_OAUTH_REQUIRES_ONE_SUBJECT/);
   assert.ok(!res.stderr.includes(base.DATABASE_URL));
   assert.ok(!res.stderr.includes(key));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
