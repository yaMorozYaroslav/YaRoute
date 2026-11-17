const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {verifiedStorageNamespace}=require('../dist/connectors/storage-identity.policy');
const {ConnectorsService}=require('../dist/connectors/connectors.service');

test('same physical Google Drive is the same namespace despite different folder selections',()=>{
  assert.equal(
    verifiedStorageNamespace('google-drive','google_user_1','0A_shared_1'),
    verifiedStorageNamespace('google-drive','google_user_2','0A_shared_1'));
  assert.notEqual(
    verifiedStorageNamespace('google-drive','google_user_1','0A_shared_1'),
    verifiedStorageNamespace('google-drive','google_user_1','0A_shared_2'));
  assert.equal(verifiedStorageNamespace('google-drive','google_user_1',null),
    'my-drive:google_user_1');
  assert.notEqual(verifiedStorageNamespace('google-drive','google_user_1',null),
    verifiedStorageNamespace('google-drive','google_user_2',null));
});
test('MEGA identity is case-insensitive and can never reuse a Shared Drive namespace',()=>{
  const make=(v)=>verifiedStorageNamespace('mega',v);
  assert.equal(make('Member@Example.com'),make('member@example.com'));
  assert.notEqual(make('member@example.com'),make('other@example.com'));
  assert.throws(()=>verifiedStorageNamespace('mega','member@example.com','drive-a'),
    /STORAGE_NAMESPACE_INVALID/);
  for(const invalid of ['bad/path','not-an-email','a\nb']){
    assert.throws(()=>make(invalid),/STORAGE_IDENTITY_INVALID/);
  }
  assert.throws(()=>verifiedStorageNamespace('google-drive','valid','x/y'),
    /STORAGE_NAMESPACE_INVALID/);
});
function fixture(unique=false) {
  const owner='oauth:google-oauth2|123456789012',id='12345678-1234-4234-8234-123456789abc';
  const connection={id,ownerId:owner,provider:'google-drive',status:'pending',
    displayName:'My Drive',externalAccountId:'pending',
    capabilities:['storage:list'],providerCapabilities:[],
    resources:[{kind:'drive',id:'folder123',capabilities:['storage:list']}]};
  const events=[];let saved=0;
  const repository={
    get:async key=>key===id?connection:null,
    list:async()=>[connection],
    save:async(c,transaction)=>{
      assert.ok(transaction,'Must save connection metadata in same SQL transaction');
      saved++;events.push('save');
    },
  };
  const client={query:async(sql,args=[])=>{
    events.push(sql.startsWith('INSERT INTO nyx_storage_verified_identity_v1')?'identity':sql);
    if(unique && sql.startsWith('INSERT INTO nyx_storage_verified_identity_v1')) {
      const err=Error('unique conflict');err.code='23505';throw err;
    }
    if(sql.startsWith('INSERT INTO nyx_storage_verified_identity_v1'))
      assert.deepEqual(args,[id,owner,'google-drive','shared-drive:0A_SAME_DRIVE','google-user']);
    return {rowCount:1,rows:[{connection_id:id}]};
  },release:()=>events.push('release')};
  const svc=new ConnectorsService();
  svc.pool={connect:async()=>client,query:async()=>({rowCount:1})};
  svc.repository=repository;
  svc.registry={get:repository.get,list:repository.list,save:repository.save};
  return {svc,owner,id,events,connection,get saved(){return saved;}};
}
test('verified connection claims namespace and metadata in one transaction',async t=>{
  const state=fixture();
  const prev=['NYX_DEPLOYMENT_MODE','NYX_PUBLIC_CONNECTORS_ENABLED',
    'NYX_MULTIUSER_RCLONE_ENABLED','NYX_PUBLIC_TENANT_GOOGLE_MULTI_ENABLED']
    .map(k=>[k,process.env[k]]);
  t.after(()=>prev.forEach(([k,v])=>{if(v===undefined)delete process.env[k];else process.env[k]=v;}));
  Object.assign(process.env,{NYX_DEPLOYMENT_MODE:'public',
    NYX_PUBLIC_CONNECTORS_ENABLED:'true',NYX_MULTIUSER_RCLONE_ENABLED:'true',
    NYX_PUBLIC_TENANT_GOOGLE_MULTI_ENABLED:'true'});
  const response=await state.svc.confirmStorageProvider(state.owner,state.id,
    'google-drive','google-user','0A_SAME_DRIVE','permission_id_123');
  assert.equal(response.id,state.id);
  assert.equal(state.saved,1);
  assert.deepEqual(state.events.filter(s=>['BEGIN','identity','save','COMMIT'].includes(s)),
    ['BEGIN','identity','save','COMMIT']);
});
test('duplicate verified physical Drive fails before connection metadata save',async t=>{
  const prev=['NYX_DEPLOYMENT_MODE','NYX_PUBLIC_CONNECTORS_ENABLED',
    'NYX_MULTIUSER_RCLONE_ENABLED','NYX_PUBLIC_TENANT_GOOGLE_MULTI_ENABLED']
    .map(k=>[k,process.env[k]]);
  t.after(()=>prev.forEach(([k,v])=>{if(v===undefined)delete process.env[k];else process.env[k]=v;}));
  Object.assign(process.env,{NYX_DEPLOYMENT_MODE:'public',
    NYX_PUBLIC_CONNECTORS_ENABLED:'true',NYX_MULTIUSER_RCLONE_ENABLED:'true',
    NYX_PUBLIC_TENANT_GOOGLE_MULTI_ENABLED:'true'});
  const state=fixture(true);
  await assert.rejects(state.svc.confirmStorageProvider(state.owner,state.id,
    'google-drive','google-user','0A_SAME_DRIVE','permission_id_123'),
  /STORAGE_DUPLICATE_DRIVE_ALREADY_CONNECTED/);
  assert.equal(state.saved,0);
  assert.ok(state.events.includes('ROLLBACK'));
});
test('Google connection refuses missing provider Drive namespace attestation',async t=>{
  const prev=['NYX_DEPLOYMENT_MODE','NYX_PUBLIC_CONNECTORS_ENABLED',
    'NYX_MULTIUSER_RCLONE_ENABLED','NYX_PUBLIC_TENANT_GOOGLE_MULTI_ENABLED']
    .map(k=>[k,process.env[k]]);
  t.after(()=>prev.forEach(([k,v])=>{if(v===undefined)delete process.env[k];else process.env[k]=v;}));
  Object.assign(process.env,{NYX_DEPLOYMENT_MODE:'public',
    NYX_PUBLIC_CONNECTORS_ENABLED:'true',NYX_MULTIUSER_RCLONE_ENABLED:'true',
    NYX_PUBLIC_TENANT_GOOGLE_MULTI_ENABLED:'true'});
  const state=fixture();
  await assert.rejects(state.svc.confirmStorageProvider(state.owner,state.id,
    'google-drive','google-user'),/NAMESPACE_ATTESTATION_REQUIRED/);
  assert.equal(state.saved,0);
});
test('panel uses exact typed confirmation; imports cannot invent provider grants',()=>{
  const panel=readFileSync('src/connectors/connections-panel.ts','utf8');
  assert.match(panel,/nyx_storage_connection_rename/);
  assert.match(panel,/nyx_storage_connection_revoke/);
  assert.match(panel,/REMOVE CONNECTION /);
  assert.match(panel,/localCredentialsDeleted!==true/);
  assert.match(panel,/cloud files remain untouched/i);
  const mcp=readFileSync('src/mcp/mcp.service.ts','utf8');
  assert.match(mcp,/nyx_storage_connection_rename/);
  assert.match(mcp,/this\.connections\.renameStorage\(this\.connectorOwner\(\),id,name\)/);
});
