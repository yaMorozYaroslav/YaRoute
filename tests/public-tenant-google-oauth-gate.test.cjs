const {test}=require('node:test');
const assert=require('node:assert/strict');
const {generateKeyPairSync}=require('node:crypto');
const jwt=require('jsonwebtoken');
const {McpAuthService}=require('../dist/mcp/mcp-auth.service');
const {McpController}=require('../dist/mcp/mcp.controller');
const {ConnectorsService}=require('../dist/connectors/connectors.service');
const {TenantMegaEnrollmentService}=require('../dist/connectors/tenant-mega-enrollment.service');
const {TenantRcloneService}=require('../dist/connectors/tenant-rclone.service');
const {
  assertPublicTenantGoogleSubject,assertPublicTenantGoogleOwnerId,
}=require('../dist/connectors/public-tenant-provider.policy');

const {publicKey,privateKey}=generateKeyPairSync('rsa',{
  modulusLength:2048,
  publicKeyEncoding:{type:'spki',format:'pem'},
  privateKeyEncoding:{type:'pkcs8',format:'pem'},
});
const issuer='https://issuer.example.com';
const audience='https://nyx.example.com/mcp';
const a='google-oauth2|111111111111111111111';
const b='google-oauth2|222222222222222222222';
const id='12345678-1234-4234-8234-123456789abc';
const env={
  NYX_DEPLOYMENT_MODE:'public',NYX_PUBLIC_CONNECTORS_ENABLED:'true',
  NYX_MULTIUSER_RCLONE_ENABLED:'true',NYX_PUBLIC_TENANT_MEGA_ONLY:'true',
  NYX_OAUTH_ISSUER:issuer,NYX_OAUTH_AUDIENCE:audience,
  NYX_OAUTH_SCOPES:'nyx.read,nyx.write',NYX_PUBLIC_URL:'https://nyx.example.com',
  NYX_PRIVATE_OAUTH_SUBJECTS:a,
};
function setup(t) {
  const previous=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));
  t.after(()=>{for(const [k,v] of Object.entries(previous)){
    if(v===undefined)delete process.env[k];else process.env[k]=v;
  }});
  Object.assign(process.env,env);
}
function signed(subject,opts={}) {
  return jwt.sign({sub:subject,scope:opts.scope??'nyx.read nyx.write',
    email:opts.email},
    privateKey,{
      issuer:opts.issuer??issuer,audience,expiresIn:1800,
      algorithm:'RS256',keyid:'test-kid',
    });
}
function response() {
  return {statusCode:200,locals:{},headers:{},body:null,
    status(n){this.statusCode=n;return this;},
    setHeader(name,v){this.headers[name]=v;return this;},
    json(v){this.body=v;return this;},
  };
}
function auth() {
  const svc=new McpAuthService();
  svc.client={getSigningKey:(_kid,callback)=>
    callback(null,{getPublicKey:()=>publicKey})};
  return svc;
}
async function login(svc,token) {
  const res=response();
  const ok=await svc.authorize({
    headers:token===undefined?{}:{authorization:'Bearer '+token},
  },res);
  return {ok,res};
}

test('two independent Google OAuth logins are accepted with separate signed subjects',async t=>{
  setup(t);
  const svc=auth();
  const alice=await login(svc,signed(a));
  const bob=await login(svc,signed(b));
  assert.equal(alice.ok,true);
  assert.equal(bob.ok,true);
  assert.equal(alice.res.locals.nyxSubject,a);
  assert.equal(bob.res.locals.nyxSubject,b);
  assert.notEqual(alice.res.locals.nyxSubject,bob.res.locals.nyxSubject);
  assert.equal((await login(svc,undefined)).res.statusCode,401);
});

test('non-Google tokens fail with 403 even if their signed email says Google',async t=>{
  setup(t);
  const svc=auth();
  for(const subject of ['auth0|123456789012','github|123456789012',
    'tenant-one','google-oauth2|letters','google-oauth2|123']) {
    const result=await login(svc,signed(subject,{email:'owner@example.com'}));
    assert.equal(result.ok,false,subject);
    assert.equal(result.res.statusCode,403,subject);
    assert.equal(result.res.locals.nyxSubject,undefined,subject);
  }
  assert.equal((await login(svc,signed(a,{issuer:'https://wrong.example.com'}))).res.statusCode,401);
  assert.equal((await login(svc,signed(a,{scope:'nyx.read'}))).res.statusCode,401);
  assert.equal((await login(svc,'not-a-jwt')).res.statusCode,401);
});

test('MCP entrypoint never dispatches MEGA tool calls without Google OAuth',async t=>{
  setup(t);
  const handlerCalls=[];
  const ctrl=new McpController({
    handle:async(_req,res,body)=>{
      handlerCalls.push([res.locals.nyxSubject,body.method]);
      return {ok:true};
    },
  },auth());
  const request={method:'tools/call',params:{
    name:'nyx_storage_connection_begin_mega',arguments:{id,rootPath:'MEGA_ROOT'},
  }};
  const denied=response();
  await ctrl.handle({headers:{authorization:'Bearer '+signed('auth0|123456789012')}},denied,request);
  assert.equal(denied.statusCode,403);
  assert.equal(handlerCalls.length,0);
  const allowed=response();
  await ctrl.handle({headers:{authorization:'Bearer '+signed(a)}},allowed,request);
  assert.equal(handlerCalls.length,1);
  assert.equal(handlerCalls[0][0],a);
});

test('backend storage creation persists separate MEGA metadata only for Google owners',async t=>{
  setup(t);
  const svc=new ConnectorsService();
  svc.assertTenantStorageMode=()=>{};
  svc.policy=()=>({list:async()=>[]});
  const saved=[];
  svc.repository={save:async c=>saved.push(c)};
  await assert.rejects(()=>svc.createStorage('oauth:auth0|attacker','mega','Bad'),
    /PUBLIC_GOOGLE_OAUTH_REQUIRED/);
  assert.equal(saved.length,0);
  const one=await svc.createStorage('oauth:'+a,'mega','Alice MEGA');
  const two=await svc.createStorage('oauth:'+b,'mega','Bob MEGA');
  assert.equal(one.provider,'mega');
  assert.equal(two.provider,'mega');
  assert.notEqual(one.id,two.id);
  assert.deepEqual(saved.map(x=>x.ownerId),['oauth:'+a,'oauth:'+b]);
});

test('MEGA enrollment cannot redeem a legacy non-Google one-time state',async t=>{
  setup(t);
  let exposed=false;
  const svc=new TenantMegaEnrollmentService({
    getOwned:async()=>{exposed=true;throw Error('SHOULD_NOT_READ_CONNECTION');},
  },{stageCredential:async()=>{exposed=true;}});
  svc.pool={query:async()=>({rowCount:1,rows:[{
    owner_id:'oauth:auth0|not-google',connection_id:id,root_path:'MEGA_ROOT',
  }]})};
  svc.obscure=async()=>{exposed=true;throw Error('SHOULD_NOT_HANDLE_PASSWORD');};
  await assert.rejects(()=>svc.complete('A'.repeat(43),'test@example.com','synthetic-pass'),
    /PUBLIC_GOOGLE_OAUTH_REQUIRED/);
  assert.equal(exposed,false);
});

test('Rclone credential guard checks Google owner before reaching connector database',async t=>{
  setup(t);
  let accessed=false;
  const svc=new TenantRcloneService({getOwned:async()=>{accessed=true;throw Error('SHOULD_NOT_QUERY');}});
  await assert.rejects(()=>svc.probePending('oauth:auth0|attacker',id),
    /PUBLIC_GOOGLE_OAUTH_REQUIRED/);
  assert.equal(accessed,false);
  assert.doesNotThrow(()=>assertPublicTenantGoogleSubject(a));
  assert.doesNotThrow(()=>assertPublicTenantGoogleOwnerId('oauth:'+b));
  assert.throws(()=>assertPublicTenantGoogleOwnerId('oauth:github|not-google'),
    /PUBLIC_GOOGLE_OAUTH_REQUIRED/);
});
