const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  TenantRcloneService, tenantRcloneConfig, tenantRclonePath,
} = require('../dist/connectors/tenant-rclone.service');

const id = '12345678-1234-4234-8234-123456789abc';
function meta(owner = 'oauth:alice', provider = 'google-drive') {
  return {id, ownerId: owner, provider, status:'active',
    capabilities:['storage:list'], providerCapabilities:['storage:list'],
    resources:[{kind:provider==='mega'?'mega-root':'drive',id:'root-1',capabilities:['storage:list']}]};
}
function service(owner = 'oauth:alice', provider = 'google-drive') {
  const connection = meta(owner,provider);
  const connectors = {
    getOwned: async (actor,key) => {
      if (actor !== owner || key !== id) throw Error('DENIED');
      return connection;
    },
    registryPolicy: () => ({
    require: async (actor, key, capability) => {
      if (actor!==owner || key!==id || capability!=='storage:list') throw Error('DENIED');
      return connection;
    },
    requireResource: async (actor,key,capability,resource) => {
      if (actor!==owner || key!==id || capability!=='storage:list' ||
          resource.kind!==(provider==='mega'?'mega-root':'drive') ||
          resource.id!=='root-1') throw Error('RESOURCE_DENIED');
      return connection;
    },
    }),
  };
  const svc = new TenantRcloneService(connectors);
  svc.encryptionKey = Buffer.alloc(32, 7);
  return svc;
}

const drive = {provider:'google-drive',token:JSON.stringify({access_token:'dummy'}),
  rootFolderId:'root-1',scope:'drive.readonly'};
const mega = {provider:'mega',user:'test@example.com',obscuredPassword:'obscured-for-testing'};

test('isolated per-invocation rclone configuration is provider-specific',()=>{
  const driveConfig=tenantRcloneConfig(drive);
  const megaConfig=tenantRcloneConfig(mega);
  assert.match(driveConfig,/^\[tenant\]\ntype = drive\n/);
  assert.match(driveConfig,/root_folder_id = root-1/);
  assert.doesNotMatch(driveConfig,/pass =/);
  assert.match(megaConfig,/^\[tenant\]\ntype = mega\n/);
  assert.doesNotMatch(megaConfig,/token =/);
  assert.throws(()=>tenantRcloneConfig({...drive,rootFolderId:undefined}),/ROOT_REQUIRED/);
  assert.throws(()=>tenantRcloneConfig({...mega,user:'a\n[evil]'}),/PROFILE_INVALID/);
  assert.throws(()=>tenantRcloneConfig({...drive,token:'{bad-json}'}),/PROFILE_INVALID/);
});

test('paths cannot change remote, escape grant, or inject INI commands',()=>{
  for(const value of ['../private','a/../other','/home','other:root',
    'evil\\escape','line\nbreak','a/../../x']){
    assert.throws(()=>tenantRclonePath(value),/PATH_INVALID/,value);
  }
  assert.equal(tenantRclonePath('folder/file.txt'),'folder/file.txt');
  assert.equal(tenantRclonePath(''), '');
});

test('multi-user service is opt-in and does not initialize the legacy operator config',async t=>{
  const previous=process.env.NYX_MULTIUSER_RCLONE_ENABLED;
  delete process.env.NYX_MULTIUSER_RCLONE_ENABLED;
  t.after(()=>{if(previous===undefined)delete process.env.NYX_MULTIUSER_RCLONE_ENABLED;
    else process.env.NYX_MULTIUSER_RCLONE_ENABLED=previous;});
  const svc=service();
  await svc.onModuleInit();
  assert.equal(svc.pool,undefined);
  await svc.onModuleDestroy();
});

test('foreign tenant may not stage a credential or request an active probe',async()=>{
  const svc=service();
  await assert.rejects(()=>svc.stageCredential('oauth:bob',id,drive),/CONNECTION_FORBIDDEN/);
  await assert.rejects(()=>svc.probeAuthorizedRoot('oauth:bob',id,'google-drive','root-1'),/CONNECTION_FORBIDDEN/);
  await assert.rejects(()=>svc.probeAuthorizedRoot('oauth:alice',id,'mega','root-1'),/CONNECTION_FORBIDDEN/);
});

test('ciphertext cannot be decrypted for another tenant or connection',()=>{
  const svc=service();
  const sealed=svc.seal('oauth:alice',id,drive);
  assert.deepEqual(svc.open('oauth:alice',id,'google-drive',sealed),drive);
  assert.throws(()=>svc.open('oauth:bob',id,'google-drive',sealed));
  assert.throws(()=>svc.open('oauth:alice','12345678-1234-4234-8234-123456789abd','google-drive',sealed));
});

test('staging writes only pending state and preserves active rows',async()=>{
  const svc=service();
  const queries=[];
  svc.pool={query:async (sql,params)=>{queries.push({sql,params});return {rowCount:1}}};
  assert.equal((await svc.stageCredential('oauth:alice',id,drive)).status,'pending_read_probe');
  assert.match(queries[0].sql,/ON CONFLICT \(owner_id, connection_id, state\)/);
  assert.match(queries[0].sql,/VALUES \(\$1,\$2,\$3,\$4,'pending'\)/);
  assert.doesNotMatch(queries[0].sql,/DELETE FROM/);
});

test('activation requires a recent verified candidate and promotes transactionally',async()=>{
  const svc=service();
  const statements=[];
  const client={
    query:async sql=>{
      statements.push(sql);
      if(sql.includes('SELECT connection_id'))return {rowCount:0};
      return {rowCount:1};
    },
    release:()=>{},
  };
  svc.pool={connect:async()=>client,query:async()=>({rowCount:1,rows:[{
    provider:'google-drive',encrypted_profile:svc.seal('oauth:alice',id,drive),
  }]})};
  await assert.rejects(()=>svc.activate('oauth:alice',id),/VERIFICATION_REQUIRED/);
  assert.equal(statements.some(x=>x.includes('DELETE FROM')),false);
  assert.equal(statements.at(-1),'ROLLBACK');
});

test('authorized probes honor Google folder ID and MEGA relative root',async()=>{
  const a=service();
  a.pool={query:async()=>({rowCount:1,rows:[{provider:'google-drive',encrypted_profile:a.seal('oauth:alice',id,drive)}]})};
  a.probe=async(_profile,relative)=>relative?'failed':'verified';
  assert.equal(await a.probeAuthorizedRoot('oauth:alice',id,'google-drive','root-1'), 'verified');
  const mismatch={...drive,rootFolderId:'another-root'};
  a.pool={query:async()=>({rowCount:1,rows:[{provider:'google-drive',encrypted_profile:a.seal('oauth:alice',id,mismatch)}]})};
  await assert.rejects(()=>a.probeAuthorizedRoot('oauth:alice',id,'google-drive','root-1'),/ROOT_FORBIDDEN/);

  const b=service('oauth:alice','mega');
  b.pool={query:async()=>({rowCount:1,rows:[{provider:'mega',encrypted_profile:b.seal('oauth:alice',id,mega)}]})};
  b.probe=async (_profile,relative)=>relative==='root-1/docs'?'verified':'failed';
  assert.equal(await b.probeAuthorizedRoot('oauth:alice',id,'mega','root-1','docs'),'verified');
});
