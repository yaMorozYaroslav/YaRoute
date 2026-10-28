const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {TenantRcloneService,tenantRcloneConfig} =
 require('../dist/connectors/tenant-rclone.service');
const {TenantMegaEnrollmentService} =
 require('../dist/connectors/tenant-mega-enrollment.service');
const owner='oauth:alice',id='11111111-2222-4333-8444-555555555555';
const password='not-a-real-obscured-password';
const base={provider:'mega',user:['test','example.invalid'].join('@'),obscuredPassword:password};
const item={id,ownerId:owner,provider:'mega',status:'pending',
 resources:[{kind:'mega-root',id:'MEGA_ROOT',capabilities:['storage:list']}]};
const pending='encrypted-old-profile-fixture';
function storage(){
 const queries=[];
 const svc=new TenantRcloneService({getOwned:async(o,k)=>{
  assert.equal(o,owner);assert.equal(k,id);return item;
 }});
 svc.encryptionKey=Buffer.alloc(32,4);
 svc.pool={query:async(...args)=>{
  queries.push(args);return {rowCount:1};
 }};
 svc.profile=async()=>({provider:'mega',profile:{...base},packed:pending});
 return {svc,queries};
}
test('rclone transient MEGA 2FA is six digits and never silently promoted into a session',()=>{
 assert.match(tenantRcloneConfig({...base,transientTwoFactorCode:'123456'}),/^2fa = 123456$/m);
 assert.doesNotMatch(tenantRcloneConfig(base),/^2fa = /m);
 for(const value of ['1','abcdef','1234567','12345\n','']) {
  assert.throws(()=>tenantRcloneConfig({...base,transientTwoFactorCode:value}),/TENANT_MEGA_2FA_INVALID/);
 }
 assert.throws(()=>tenantRcloneConfig({...base,sessionId:'abc'}),/TENANT_MEGA_SESSION_INCOMPLETE/);
});
test('stageCredential refuses ephemeral MFA value even when encrypted vault exists',async()=>{
 const {svc,queries}=storage();
 await assert.rejects(()=>svc.stageCredential(owner,id,{...base,transientTwoFactorCode:'123456'}),
  /TENANT_MEGA_2FA_PERSISTENCE_FORBIDDEN/);
 assert.equal(queries.length,0);
});
test('MFA enrollment fails closed if verified probe cannot capture reusable session',async()=>{
 const {svc,queries}=storage();
 svc.probe=async (_profile, _path, capture)=>{
  assert.equal(typeof capture,'function');
  const file=path.join(os.tmpdir(),'nyx-test-missing-session-'+process.pid);
  fs.writeFileSync(file,'[tenant]\ntype = mega\n');
  try {return (await capture(file))?'verified':'failed';}
  finally {fs.rmSync(file,{force:true});}
 };
 assert.equal(await svc.probePending(owner,id,'MEGA_ROOT','123456'),'failed');
 assert.equal(queries.length,0);
});
test('successful MFA probe captures only session, not OTP, in encrypted pending row',async()=>{
 const {svc,queries}=storage();
 let seen;
 svc.probe=async (profile,scope,capture)=>{
  seen=profile;
  assert.equal(scope,'');
  const file=path.join(os.tmpdir(),'nyx-test-session-'+process.pid);
  fs.writeFileSync(file,'[tenant]\ntype = mega\nsession_id = fake_session_id_12345678\nmaster_key = aaaaaaaaaaaaaaaaaaaaaaaa\n');
  try {return await capture(file)?'verified':'failed';}
  finally {fs.rmSync(file,{force:true});}
 };
 assert.equal(await svc.probePending(owner,id,'MEGA_ROOT','654321'),'verified');
 assert.equal(seen.transientTwoFactorCode,'654321');
 assert.equal(queries.length,1);
 assert.match(queries[0][0],/encrypted_profile=\$4/);
 const newPacked=queries[0][1][3];
 assert.equal(typeof newPacked,'string');
 assert.doesNotMatch(newPacked,/654321/);
 const restored=svc.open(owner,id,'mega',newPacked);
 assert.equal(restored.sessionId,'fake_session_id_12345678');
 assert.equal(restored.masterKey,'aaaaaaaaaaaaaaaaaaaaaaaa');
 assert.equal(Object.hasOwn(restored,'transientTwoFactorCode'),false);
 assert.match(tenantRcloneConfig(restored),/^session_id = fake_session_id_12345678$/m);
 assert.doesNotMatch(tenantRcloneConfig(restored),/^2fa = /m);
});
test('invalid MFA is rejected before contacting Rclone or modifying vault',async()=>{
 const {svc,queries}=storage();
 svc.probe=async()=>{throw Error('SHOULD_NOT_RUN');};
 await assert.rejects(()=>svc.probePending(owner,id,'MEGA_ROOT','abc'),/TENANT_MEGA_2FA_INVALID/);
 assert.equal(queries.length,0);
});
test('MEGA secure enrollment forwards OTP only to probe and not stage',async t=>{
 const old=process.env.NYX_PUBLIC_URL;
 process.env.NYX_PUBLIC_URL='https://dev.example.invalid';
 t.after(()=>{if(old===undefined)delete process.env.NYX_PUBLIC_URL;
  else process.env.NYX_PUBLIC_URL=old;});
 const record={owner_id:owner,connection_id:id,root_path:'MEGA_ROOT'};
 const connections={getOwned:async()=>item,confirmStorageProvider:async()=>{}};
 const calls=[];
 const storage={stageCredential:async(...a)=>calls.push({op:'stage',a}),
  probePending:async(...a)=>{calls.push({op:'probe',a});return 'verified';}};
 const svc=new TenantMegaEnrollmentService(connections,storage);
 svc.pool={query:async(sql,params)=>{
  if(sql.includes('RETURNING'))return {rowCount:1,rows:[record]};
  return {rowCount:1};
 }};
 svc.obscure=async()=>password;
 const url=await svc.begin(owner,id,'MEGA_ROOT');
 const state=new URL(url.url).searchParams.get('state');
 assert.equal((await svc.complete(state,base.user,'synthetic-secret','123456')).status,'pending_activation');
 assert.deepEqual(calls[0].a[2],base);
 assert.equal(calls[1].a[3],'123456');
 await assert.rejects(()=>svc.complete(state,base.user,'synthetic-secret','777'),/TENANT_MEGA_ENROLLMENT_INVALID/);
});
