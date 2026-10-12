const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {ConnectorsService}=require('../dist/connectors/connectors.service');
const {summarizeOwnedRcloneProfile}=require('../dist/storage/rclone-credential-vault.service');

const aliceId='123e4567-e89b-42d3-a456-426614174000';
const bobId='123e4567-e89b-42d3-a456-426614174001';
const legacyId='123e4567-e89b-42d3-a456-426614174002';
const profile=(scope,tag)=>[
 '[drive_shared]','type = drive','scope = '+scope,
 'root_folder_id = private-'+tag,
 'team_drive = confidential-'+tag,
 'token = {"access_token":"never-echo-'+tag+'"}',''
].join('\n');
test('vault summary returns only recognized requested scope, flags and no raw values',()=>{
 const result=summarizeOwnedRcloneProfile('google-drive','drive_shared',profile('drive.readonly','owner-A'));
 assert.deepEqual(result,{
  source:'owner-scoped-encrypted-vault',declaredScope:'drive.readonly',
  requestedAccess:'read-only-requested',
  sharedDriveConfigured:true,rootFolderConfigured:true,serviceAccountConfigured:false,
  providerGrantVerified:false,rcloneConfigEditable:false,
 });
 const other=summarizeOwnedRcloneProfile('google-drive','drive_shared',profile('drive','owner-B'));
 assert.equal(other.requestedAccess,'write-capable-scope-requested-unverified');
 assert.equal(other.providerGrantVerified,false);
 const unknown=summarizeOwnedRcloneProfile('google-drive','drive_shared',
  profile('unsafe-unrecognized-secret-value','owner-B'));
 assert.equal(unknown.declaredScope,'unknown');
 const display=JSON.stringify([result,other,unknown]);
 for(const secret of ['never-echo','confidential-','private-owner','unsafe-unrecognized'])
   assert.equal(display.includes(secret),false);
 assert.throws(()=>summarizeOwnedRcloneProfile('google-drive','drive_shared',
  '[other]\ntype = drive\nscope = drive\n'),/RCLONE_PROFILE_INVALID/);
});
test('two OAuth owners with same remote name see only their own vaulted permission summary',async t=>{
 const keys=['NYX_DEPLOYMENT_MODE','NYX_PUBLIC_CONNECTORS_ENABLED'];
 const prev=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 t.after(()=>keys.forEach(k=>prev[k]===undefined?delete process.env[k]:process.env[k]=prev[k]));
 process.env.NYX_DEPLOYMENT_MODE='public';
 process.env.NYX_PUBLIC_CONNECTORS_ENABLED='true';
 const records=new Map([
  [aliceId,{id:aliceId,ownerId:'oauth:alice',provider:'google-drive',
   externalAccountId:'drive_shared',status:'active',credentialMode:'isolated-credential-vault'}],
  [bobId,{id:bobId,ownerId:'oauth:bob',provider:'google-drive',
   externalAccountId:'drive_shared',status:'active',credentialMode:'isolated-credential-vault'}],
  [legacyId,{id:legacyId,ownerId:'oauth:alice',provider:'google-drive',
   externalAccountId:'legacy_remote',status:'active',credentialMode:'private-rclone-reference'}],
 ]);
 const calls=[];
 const vault={isEnabled:()=>true,load:async(owner,id,provider,remote)=>{
  calls.push([owner,id,provider,remote]);
  if(id===aliceId)return profile('drive.readonly','owner-A');
  if(id===bobId)return profile('drive','owner-B');
  return null;
 }};
 const storage={rcloneConnections:async()=>{throw Error('global Rclone must not be reached');}};
 const svc=new ConnectorsService(storage,vault);
 svc.repository={get:async id=>records.get(id)??null};
 const alice=await svc.rcloneConfiguration('oauth:alice',aliceId);
 const bob=await svc.rcloneConfiguration('oauth:bob',bobId);
 assert.equal(alice.configuration.declaredScope,'drive.readonly');
 assert.equal(bob.configuration.declaredScope,'drive');
 assert.equal(alice.configuration.providerGrantVerified,false);
 assert.equal(bob.configuration.rcloneConfigEditable,false);
 assert.equal(JSON.stringify([alice,bob]).includes('never-echo'),false);
 assert.deepEqual(calls.map(x=>x.slice(0,2)),[['oauth:alice',aliceId],['oauth:bob',bobId]]);
 await assert.rejects(()=>svc.rcloneConfiguration('oauth:bob',aliceId),/CONNECTOR_NOT_FOUND/);
 await assert.rejects(()=>svc.rcloneConfiguration('oauth:alice',bobId),/CONNECTOR_NOT_FOUND/);
 await assert.rejects(()=>svc.rcloneConfiguration('oauth:alice',legacyId),/PRIVATE_RCLONE_DETAILS_NOT_OWNER_ISOLATED/);
 assert.equal(calls.length,2);
});
test('owner details show unprovisioned and disabled-vault states without sharing credentials',async()=>{
 const id=aliceId;
 const svc=new ConnectorsService({},{
  isEnabled:()=>true,load:async()=>null,
 });
 svc.repository={get:async()=>({id,ownerId:'oauth:alice',provider:'google-drive',
   externalAccountId:'drive_shared',status:'pending',credentialMode:'isolated-credential-vault'})};
 const oldMode=process.env.NYX_DEPLOYMENT_MODE;
 try{
  process.env.NYX_DEPLOYMENT_MODE='private';
  const data=await svc.rcloneConfiguration('oauth:alice',id);
  assert.equal(data.configuration.inspection,'not-provisioned');
  assert.equal(data.configuration.declaredScope,'unknown');
 }finally{
  if(oldMode===undefined)delete process.env.NYX_DEPLOYMENT_MODE;
  else process.env.NYX_DEPLOYMENT_MODE=oldMode;
 }
});
test('MCP permission tool and panel enforce owner identity, read-only and safe rendering',()=>{
 const mcp=fs.readFileSync(path.join(__dirname,'../src/mcp/mcp.service.ts'),'utf8');
 const ui=fs.readFileSync(path.join(__dirname,'../src/connectors/connections-panel.ts'),'utf8');
 const start=mcp.indexOf("server.registerTool('nyx_rclone_connection_config'");
 const end=mcp.indexOf("server.registerTool('nyx_rclone_connection_test'",start);
 assert.ok(start>0&&end>start);
 const tool=mcp.slice(start,end);
 assert.match(tool,/this\.connections\.rcloneConfiguration\(this\.connectorOwner\(\),id\)/);
 assert.match(tool,/readOnlyHint:true/);
 assert.match(tool,/visibility:\['app'\]/);
 assert.match(ui,/call\('nyx_rclone_connection_config',\{id:c\.id\}\)/);
 assert.match(ui,/info\.connectionId!==c\.id/);
 assert.match(ui,/providerGrantVerified!==false/);
 assert.match(ui,/rcloneConfigEditable!==false/);
 assert.doesNotMatch(ui,/innerHTML=cfg|JSON\.stringify\(cfg\)/);
});
