const {test}=require('node:test');
const assert=require('node:assert/strict');
const {RcloneCredentialVaultService,assertSingleRcloneProfile}=require('../dist/storage/rclone-credential-vault.service');
const id='123e4567-e89b-42d3-a456-426614174000';
const config='[drive_personal]\ntype = drive\ntoken = {"access_token":"SECRET_EXAMPLE"}\n';
const original=process.env.NYX_RCLONE_VAULT_ENABLED;
function setup(){
 process.env.NYX_RCLONE_VAULT_ENABLED='true';
 const vault=new RcloneCredentialVaultService();
 vault.key=Buffer.alloc(32,7);
 const store=new Map();const sql=[];
 vault.pool={query:async(text,params)=>{
   sql.push(text);
   const key=params[0]+':'+params[1];
   if(text.includes('INSERT INTO nyx_rclone_credential_vault')){
     if(params[0]!=='oauth:alice')return{rowCount:0,rows:[]};
     store.set(key,params[4]);return{rowCount:1,rows:[{connection_id:params[1]}]};
   }
   if(text.includes('SELECT v.ciphertext')){
     const ciphertext=store.get(key);
     return ciphertext?{rowCount:1,rows:[{ciphertext}]}:{rowCount:0,rows:[]};
   }
   if(text.includes('DELETE FROM nyx_rclone_credential_vault')){
     store.delete(key);return{rowCount:1,rows:[]};
   }
   throw Error('unexpected SQL');
 }};
 return{vault,store,sql};
}
function restore(){if(original===undefined)delete process.env.NYX_RCLONE_VAULT_ENABLED;
 else process.env.NYX_RCLONE_VAULT_ENABLED=original;}
test('vault seals a single remote profile in existing Neon owner connection registry',async t=>{
 t.after(restore);
 const {vault,store,sql}=setup();
 await vault.store('oauth:alice',id,'google-drive','drive_personal',config);
 assert.equal(store.size,1);
 assert.equal(store.get('oauth:alice:'+id).includes('SECRET_EXAMPLE'),false);
 assert.equal(await vault.load('oauth:alice',id,'google-drive','drive_personal'),config);
 assert.equal(await vault.load('oauth:bob',id,'google-drive','drive_personal'),undefined);
 assert.ok(sql.some(x=>x.includes('JOIN nyx_connector_connections')&&x.includes('c.owner_id=$1')));
 await vault.revoke('oauth:alice',id);
 assert.equal(await vault.load('oauth:alice',id,'google-drive','drive_personal'),undefined);
});
test('profile is bound to provider and remote by authenticated encryption',async t=>{
 t.after(restore);
 const {vault,store}=setup();
 await vault.store('oauth:alice',id,'google-drive','drive_personal',config);
 await assert.rejects(()=>vault.load('oauth:alice',id,'mega','drive_personal'),/RCLONE_VAULT_DECRYPT_FAILED/);
 const entry='oauth:alice:'+id;
 const bytes=Buffer.from(store.get(entry),'base64');
 bytes[bytes.length-1]^=1;store.set(entry,bytes.toString('base64'));
 await assert.rejects(()=>vault.load('oauth:alice',id,'google-drive','drive_personal'),/RCLONE_VAULT_DECRYPT_FAILED/);
});
test('profile validation disallows multi-remote configs and indirect local secret files',()=>{
 assert.doesNotThrow(()=>assertSingleRcloneProfile('google-drive','drive_personal',config));
 assert.throws(()=>assertSingleRcloneProfile('mega','drive_personal',config),/RCLONE_PROFILE_INVALID/);
 assert.throws(()=>assertSingleRcloneProfile('google-drive','drive_personal',config+'[another]\ntype = drive\n'),/RCLONE_PROFILE_INVALID/);
 assert.throws(()=>assertSingleRcloneProfile('google-drive','drive_personal',config+'service_account_file = /private/key.json\n'),/RCLONE_PROFILE_UNSAFE/);
 assert.throws(()=>assertSingleRcloneProfile('google-drive','--config',config),/RCLONE_PROFILE_INVALID/);
});
test('vault mode never falls back to operator-wide Rclone credentials when unprovisioned',async t=>{
 t.after(restore);process.env.NYX_RCLONE_VAULT_ENABLED='true';
 const {ConnectorsService}=require('../dist/connectors/connectors.service');
 const row={id,ownerId:'oauth:alice',provider:'google-drive',externalAccountId:'drive_personal',
  displayName:'Drive',capabilities:[],providerCapabilities:[],resources:[],status:'pending'};
 let shared=0,isolated=0;
 const storage={testRcloneConnection:async()=>{shared++;throw Error('shared credentials forbidden');},
  testIsolatedRcloneConnection:async()=>{isolated++;return{schema:'nyx.storage.rclone.probe.v1',status:'reachable'};}};
 const vault={isEnabled:()=>true,load:async()=>undefined};
 const service=new ConnectorsService(storage,vault);
 service.repository={get:async()=>row,list:async()=>[row]};
 const absent=await service.testRclone('oauth:alice',id);
 assert.equal(absent.reason,'ISOLATED_CREDENTIAL_NOT_PROVISIONED');
 assert.equal(shared,0);assert.equal(isolated,0);
 vault.load=async()=>config;
 assert.equal((await service.testRclone('oauth:alice',id)).status,'reachable');
 assert.equal(isolated,1);assert.equal(shared,0);
});
