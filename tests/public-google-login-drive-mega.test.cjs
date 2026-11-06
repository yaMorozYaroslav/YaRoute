const {test}=require('node:test');
const assert=require('node:assert/strict');
const {
  publicTenantGoogleMulti,publicTenantGoogleLoginRequired,
  assertPublicTenantStorageProvider,assertPublicTenantGoogleSubject,
  assertPublicTenantGoogleOwnerId,
}=require('../dist/connectors/public-tenant-provider.policy');
const {ConnectorsService}=require('../dist/connectors/connectors.service');
const {TenantRcloneService}=require('../dist/connectors/tenant-rclone.service');
const {McpAuthService}=require('../dist/mcp/mcp-auth.service');

const ownerA='google-oauth2|111111111111111111111';
const ownerB='google-oauth2|222222222222222222222';
const id='12345678-1234-4234-8234-123456789abc';
function multi() {
  return {NYX_DEPLOYMENT_MODE:'public',NYX_PUBLIC_CONNECTORS_ENABLED:'true',
    NYX_MULTIUSER_RCLONE_ENABLED:'true',NYX_PUBLIC_TENANT_MEGA_ONLY:'false',
    NYX_PUBLIC_TENANT_GOOGLE_MULTI_ENABLED:'true'};
}
function setMode(t) {
  const next=multi();
  const old=Object.fromEntries(Object.keys(next).map(k=>[k,process.env[k]]));
  t.after(()=>{for(const [k,v] of Object.entries(old)) {
    if(v===undefined)delete process.env[k];else process.env[k]=v;
  }});
  Object.assign(process.env,next);
}
function response() {
  return {locals:{},statusCode:200,body:null,headers:{},
    status(n){this.statusCode=n;return this},
    json(v){this.body=v;return this},
    setHeader(k,v){this.headers[k]=v;return this}};
}
test('public mode permits MEGA and Google Drive, never Photos or arbitrary providers',()=>{
  const env=multi();
  assert.equal(publicTenantGoogleMulti(env),true);
  assert.equal(publicTenantGoogleLoginRequired(env),true);
  assert.doesNotThrow(()=>assertPublicTenantStorageProvider('mega',env));
  assert.doesNotThrow(()=>assertPublicTenantStorageProvider('google-drive',env));
  for(const p of ['google-photos','github','',null]) {
    assert.throws(()=>assertPublicTenantStorageProvider(p,env),/PUBLIC_TENANT_PROVIDER_NOT_ENABLED/);
  }
  const legacy={...env,NYX_PUBLIC_TENANT_GOOGLE_MULTI_ENABLED:'false',
    NYX_PUBLIC_TENANT_MEGA_ONLY:'true'};
  assert.doesNotThrow(()=>assertPublicTenantStorageProvider('mega',legacy));
  assert.throws(()=>assertPublicTenantStorageProvider('google-drive',legacy),
    /PUBLIC_TENANT_MEGA_ONLY/);
  const ambiguous={...env,NYX_PUBLIC_TENANT_MEGA_ONLY:'true'};
  assert.throws(()=>assertPublicTenantStorageProvider('mega',ambiguous),
    /PUBLIC_TENANT_PROVIDER_MODE_CONFLICT/);
});
test('both provider enrollments require immutable Google-social OAuth tenant',()=>{
  const env=multi();
  assert.doesNotThrow(()=>assertPublicTenantGoogleSubject(ownerA,env));
  assert.doesNotThrow(()=>assertPublicTenantGoogleOwnerId('oauth:'+ownerB,env));
  for(const subject of ['auth0|112233445566','github|998877665544',
    'google-oauth2|not-numeric','google-oauth2|',undefined]) {
    assert.throws(()=>assertPublicTenantGoogleSubject(subject,env),
      /PUBLIC_GOOGLE_OAUTH_REQUIRED/);
  }
  assert.throws(()=>assertPublicTenantGoogleOwnerId('oauth:auth0|112233445566',env),
    /PUBLIC_GOOGLE_OAUTH_REQUIRED/);
});
test('MCP authorization enforces Google login in multi mode before any storage tool',async t=>{
  setMode(t);
  const oldIssuer=process.env.NYX_OAUTH_ISSUER;
  const oldScopes=process.env.NYX_OAUTH_SCOPES;
  t.after(()=>{
    if(oldIssuer===undefined)delete process.env.NYX_OAUTH_ISSUER;
    else process.env.NYX_OAUTH_ISSUER=oldIssuer;
    if(oldScopes===undefined)delete process.env.NYX_OAUTH_SCOPES;
    else process.env.NYX_OAUTH_SCOPES=oldScopes;
  });
  process.env.NYX_OAUTH_ISSUER='https://idp.example.com';
  process.env.NYX_OAUTH_SCOPES='nyx.read,nyx.write';
  const auth=new McpAuthService();
  auth.verify=async()=>({sub:'auth0|112233445566',
    iss:'https://idp.example.com',scope:'nyx.read nyx.write'});
  const req={headers:{authorization:'Bearer already-verified-by-verifier'}};
  const denied=response();
  assert.equal(await auth.authorize(req,denied),false);
  assert.equal(denied.statusCode,403);
  assert.equal(denied.locals.nyxSubject,undefined);
  auth.verify=async()=>({sub:ownerA,iss:'https://idp.example.com',
    scope:'nyx.read nyx.write'});
  const allowed=response();
  assert.equal(await auth.authorize(req,allowed),true);
  assert.equal(allowed.locals.nyxSubject,ownerA);
});
test('separate Google owners can create independent Drive and MEGA metadata',async t=>{
  setMode(t);
  const svc=new ConnectorsService();
  svc.assertTenantStorageMode=()=>{};
  svc.policy=()=>({list:async()=>[]});
  const saved=[];
  svc.repository={save:async c=>saved.push(c)};
  const a=await svc.createStorage('oauth:'+ownerA,'google-drive','A Drive');
  const b=await svc.createStorage('oauth:'+ownerB,'mega','B MEGA');
  assert.equal(a.provider,'google-drive');
  assert.equal(b.provider,'mega');
  assert.notEqual(a.id,b.id);
  assert.deepEqual(saved.map(c=>c.ownerId),['oauth:'+ownerA,'oauth:'+ownerB]);
  await assert.rejects(()=>svc.createStorage('oauth:auth0|999999999999','mega','Bad'),
    /PUBLIC_GOOGLE_OAUTH_REQUIRED/);
  await assert.rejects(()=>svc.createStorage('oauth:'+ownerA,'google-photos','Bad'),
    /PUBLIC_TENANT_PROVIDER_NOT_ENABLED/);
  assert.equal(saved.length,2);
});
test('Rclone operations do not accept another identity or cross-owner connection ID',async t=>{
  setMode(t);
  let reached=0;
  const svc=new TenantRcloneService({getOwned:async(actor,connId)=>{
    reached++;
    if(actor!=='oauth:'+ownerA||connId!==id)throw Error('FOREIGN_CONNECTION');
    return {id,ownerId:'oauth:'+ownerA,provider:'mega',status:'pending'};
  }});
  await assert.rejects(()=>svc.probePending('oauth:auth0|123456789012',id),
    /PUBLIC_GOOGLE_OAUTH_REQUIRED/);
  assert.equal(reached,0);
  await assert.rejects(()=>svc.probePending('oauth:'+ownerB,id),
    /TENANT_RCLONE_CONNECTION_FORBIDDEN/);
  assert.equal(reached,1);
});
