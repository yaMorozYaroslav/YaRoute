const {test}=require('node:test');
const assert=require('node:assert/strict');
const {publicTenantMegaOnly,assertPublicTenantStorageProvider}=
  require('../dist/connectors/public-tenant-provider.policy');
const {TenantRcloneService}=require('../dist/connectors/tenant-rclone.service');
const {ConnectorsService}=require('../dist/connectors/connectors.service');

function enabled(){
  return {NYX_DEPLOYMENT_MODE:'public',NYX_PUBLIC_CONNECTORS_ENABLED:'true',
    NYX_MULTIUSER_RCLONE_ENABLED:'true',NYX_PUBLIC_TENANT_MEGA_ONLY:'true'};
}
const vars=Object.keys(enabled());
function withMegaOnly(t) {
  const old=Object.fromEntries(vars.map(k=>[k,process.env[k]]));
  t.after(()=>{for(const [k,v] of Object.entries(old)){
    if(v===undefined)delete process.env[k];else process.env[k]=v;
  }});
  Object.assign(process.env,enabled());
}
const id='12345678-1234-4234-8234-123456789abc';
const owner='oauth:tenant-one';

test('MEGA-only public mode rejects independent Google Drive and allows only MEGA',()=>{
  assert.equal(publicTenantMegaOnly(enabled()),true);
  assert.doesNotThrow(()=>assertPublicTenantStorageProvider('mega',enabled()));
  for(const provider of ['google-drive','github',undefined,'drive']) {
    assert.throws(()=>assertPublicTenantStorageProvider(provider,enabled()),
      /PUBLIC_TENANT_MEGA_ONLY/);
  }
  const privateEnv={...enabled(),NYX_DEPLOYMENT_MODE:'private'};
  assert.equal(publicTenantMegaOnly(privateEnv),false);
  assert.doesNotThrow(()=>assertPublicTenantStorageProvider('google-drive',privateEnv));
  const optOut={...enabled(),NYX_PUBLIC_TENANT_MEGA_ONLY:'false'};
  assert.equal(publicTenantMegaOnly(optOut),false);
});

test('backend rejects Google Drive creation before writing connection metadata',async t=>{
  withMegaOnly(t);
  const svc=new ConnectorsService();
  svc.assertTenantStorageMode=()=>{};
  svc.owner=x=>x;
  let persisted=false;
  svc.policy=()=>({list:async()=>[]});
  svc.repository={save:async()=>{persisted=true;}};
  await assert.rejects(()=>svc.createStorage(owner,'google-drive','Another Drive'),
    /PUBLIC_TENANT_MEGA_ONLY/);
  assert.equal(persisted,false);
  const mega=await svc.createStorage(owner,'mega','Personal MEGA');
  assert.equal(mega.provider,'mega');
  assert.equal(persisted,true);
});

test('foreign/old Google tenant cannot stage, probe or activate credentials',async t=>{
  withMegaOnly(t);
  const conn={id,ownerId:owner,provider:'google-drive',status:'active',
    resources:[{kind:'drive',id:'folder-1',capabilities:['storage:list']}],
    capabilities:['storage:list'],providerCapabilities:['storage:list']};
  const svc=new TenantRcloneService({
    getOwned:async(actor,connectionId)=>{
      if(actor!==owner||connectionId!==id)throw Error('NOT_OWNED');
      return conn;
    },
  });
  const profile={provider:'google-drive',
    token:JSON.stringify({access_token:'synthetic'}),rootFolderId:'folder-1'};
  await assert.rejects(()=>svc.stageCredential(owner,id,profile),
    /PUBLIC_TENANT_MEGA_ONLY/);
  await assert.rejects(()=>svc.probePending(owner,id),/PUBLIC_TENANT_MEGA_ONLY/);
  await assert.rejects(()=>svc.activate(owner,id),/PUBLIC_TENANT_MEGA_ONLY/);
  await assert.rejects(()=>svc.listAuthorizedRoot(owner,id,'google-drive','folder-1'),
    /PUBLIC_TENANT_MEGA_ONLY/);
  await assert.rejects(()=>svc.probeAuthorizedRoot(owner,id,'google-drive','folder-1'),
    /PUBLIC_TENANT_MEGA_ONLY/);
  await assert.rejects(()=>svc.stageCredential('oauth:foreign',id,profile),
    /TENANT_RCLONE_CONNECTION_FORBIDDEN/);
});

test('existing owner-owned Google Drive connections can still be revoked',async t=>{
  withMegaOnly(t);
  const svc=new TenantRcloneService({getOwned:async(actor,connectionId)=>{
    if(actor!==owner||connectionId!==id)throw Error('FOREIGN');
    return {id,provider:'google-drive',status:'active',ownerId:owner};
  }});
  svc.encryptionKey=Buffer.alloc(32,7); // synthetic initialized vault, no real key
  const statements=[];
  const client={query:async(sql)=>{
    statements.push(sql);
    return {rowCount:1,rows:[{id}]};
  },release(){}};
  svc.pool={connect:async()=>client};
  const result=await svc.revokeStorage(owner,id);
  assert.equal(result.status,'revoked');
  assert.equal(result.localCredentialsDeleted,true);
  assert.ok(statements.some(sql=>sql.includes('nyx_rclone_tenant_credentials_v2')));
});
