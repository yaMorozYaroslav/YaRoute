const {test}=require('node:test');
const assert=require('node:assert/strict');
const {privateDevSingleGoogleOwnerAllowed,privateSingleGoogleOwnerAllowed}=require('../dist/mcp/private-dev-google-login.policy');
const {McpAuthService}=require('../dist/mcp/mcp-auth.service');

const trustedIssuer='https://idp.example.com';
const soleSubject='google-oauth2|12345678901234567890';
function config() {
  return {
    NYX_DEPLOYMENT_MODE:'private',
    NYX_SERVICE_NAME:'DevNestNyx',
    NYX_OAUTH_ISSUER:trustedIssuer,
    NYX_PRIVATE_OAUTH_SUBJECTS:soleSubject,
    NYX_PRIVATE_LEGACY_OWNER_MCP_SUBJECT:soleSubject,
  };
}
const token=(sub=soleSubject)=>({iss:trustedIssuer,sub,scope:'nyx.read nyx.write'});

test('only an exact configured Google-social subject can enter private Dev',()=>{
  assert.equal(privateDevSingleGoogleOwnerAllowed(token(),config()),true);
  assert.equal(privateDevSingleGoogleOwnerAllowed(token('google-oauth2|111111111111'),
    config()),false);
  assert.equal(privateDevSingleGoogleOwnerAllowed(token('auth0|12345678901234567890'),
    config()),false);
  assert.equal(privateDevSingleGoogleOwnerAllowed({...token(),iss:'https://other.example.com'},
    config()),false);
});
test('private Dev gate fails closed for multiple, duplicated, or missing owner ACLs',()=>{
  for (const entries of [
    '',
    soleSubject+',google-oauth2|222222222222',
    soleSubject+','+soleSubject,
    ','+soleSubject,
  ]) {
    assert.equal(privateDevSingleGoogleOwnerAllowed(token(),
      {...config(),NYX_PRIVATE_OAUTH_SUBJECTS:entries}),false);
  }
  assert.equal(privateDevSingleGoogleOwnerAllowed(token(),
    {...config(),NYX_PRIVATE_LEGACY_OWNER_MCP_SUBJECT:'google-oauth2|222222222222'}),false);
  assert.equal(privateDevSingleGoogleOwnerAllowed(token(),
    {...config(),NYX_PRIVATE_LEGACY_OWNER_MCP_SUBJECT:undefined}),false);
});
test('gate cannot be reused in public tenants or production',()=>{
  assert.equal(privateDevSingleGoogleOwnerAllowed(token(),
    {...config(),NYX_DEPLOYMENT_MODE:'public'}),false);
  assert.equal(privateDevSingleGoogleOwnerAllowed(token(),
    {...config(),NYX_SERVICE_NAME:'NestNyx'}),false);
  assert.equal(privateDevSingleGoogleOwnerAllowed(token(),
    {...config(),NYX_OAUTH_ISSUER:'http://idp.example.com'}),false);
});
test('general private single-owner policy works for Pro but rejects public and ambiguous ACLs',()=>{
  const pro={...config(),NYX_SERVICE_NAME:'NestNyxPro'};
  assert.equal(privateSingleGoogleOwnerAllowed(token(),pro),true);
  assert.equal(privateSingleGoogleOwnerAllowed(token('google-oauth2|222222222222'),pro),false);
  assert.equal(privateSingleGoogleOwnerAllowed(token(),
    {...pro,NYX_PRIVATE_OAUTH_SUBJECTS:soleSubject+',google-oauth2|222222222222'}),false);
  assert.equal(privateSingleGoogleOwnerAllowed(token(),
    {...pro,NYX_PRIVATE_OAUTH_SUBJECTS:soleSubject+','+soleSubject}),false);
  assert.equal(privateSingleGoogleOwnerAllowed(token(),
    {...pro,NYX_PRIVATE_LEGACY_OWNER_MCP_SUBJECT:'auth0|other-owner'}),false);
  assert.equal(privateSingleGoogleOwnerAllowed(token(),
    {...pro,NYX_DEPLOYMENT_MODE:'public'}),false);
  assert.equal(privateSingleGoogleOwnerAllowed({...token(),iss:'https://other.example.com'},pro),false);
});
function response() {
  return {locals:{},code:200,body:null,headers:{},
    status(n){this.code=n;return this},
    json(obj){this.body=obj;return this},
    setHeader(name,v){this.headers[name]=v;return this},
  };
}
test('signed-JWT authorization path rejects other Google subjects before MCP tools',async t=>{
  const keys=['NYX_DEPLOYMENT_MODE','NYX_SERVICE_NAME','NYX_OAUTH_ISSUER',
    'NYX_PRIVATE_OAUTH_SUBJECTS','NYX_PRIVATE_LEGACY_OWNER_MCP_SUBJECT',
    'NYX_PRIVATE_DEV_SINGLE_GOOGLE_OWNER','NYX_OAUTH_SCOPES'];
  const old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  t.after(()=>{for(const k of keys)if(old[k]===undefined)delete process.env[k];
    else process.env[k]=old[k];});
  Object.assign(process.env,config(),{
    NYX_PRIVATE_DEV_SINGLE_GOOGLE_OWNER:'true',
    NYX_OAUTH_SCOPES:'nyx.read,nyx.write',
  });
  const auth=new McpAuthService();
  // The existing verifier is tested independently; stub here only to prove
  // a successfully verified JWT is still subjected to the private owner gate.
  auth.verify=async()=>token('google-oauth2|222222222222');
  const req={headers:{authorization:'Bearer synthetic-test-only'}};
  const denied=response();
  assert.equal(await auth.authorize(req,denied),false);
  assert.equal(denied.code,403);
  assert.equal(denied.locals.nyxSubject,undefined);
  auth.verify=async()=>token();
  const allowed=response();
  assert.equal(await auth.authorize(req,allowed),true);
  assert.equal(allowed.locals.nyxSubject,soleSubject);
  process.env.NYX_PRIVATE_OAUTH_SUBJECTS=soleSubject+',google-oauth2|222222222222';
  const misconfigured=response();
  assert.equal(await auth.authorize(req,misconfigured),false);
  assert.equal(misconfigured.code,403);
});
test('opt-in private Pro gate refuses an ambiguous allowlist even for a signed-in owner',async t=>{
  const keys=['NYX_DEPLOYMENT_MODE','NYX_SERVICE_NAME','NYX_OAUTH_ISSUER',
    'NYX_PRIVATE_OAUTH_SUBJECTS','NYX_PRIVATE_LEGACY_OWNER_MCP_SUBJECT',
    'NYX_PRIVATE_SINGLE_GOOGLE_OWNER','NYX_PRIVATE_DEV_SINGLE_GOOGLE_OWNER',
    'NYX_OAUTH_SCOPES'];
  const old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  t.after(()=>{for(const k of keys)if(old[k]===undefined)delete process.env[k];
    else process.env[k]=old[k];});
  Object.assign(process.env,{...config(),NYX_SERVICE_NAME:'NestNyxPro',
    NYX_PRIVATE_SINGLE_GOOGLE_OWNER:'true',
    NYX_PRIVATE_DEV_SINGLE_GOOGLE_OWNER:'false',NYX_OAUTH_SCOPES:'nyx.read,nyx.write'});
  const auth=new McpAuthService();
  auth.verify=async()=>token();
  const req={headers:{authorization:'Bearer synthetic-test-only'}};
  const success=response();
  assert.equal(await auth.authorize(req,success),true);
  assert.equal(success.locals.nyxSubject,soleSubject);

  process.env.NYX_PRIVATE_OAUTH_SUBJECTS=soleSubject+',google-oauth2|222222222222';
  const ambiguous=response();
  assert.equal(await auth.authorize(req,ambiguous),false);
  assert.equal(ambiguous.code,403);
  assert.equal(ambiguous.locals.nyxSubject,undefined);
  process.env.NYX_PRIVATE_OAUTH_SUBJECTS=soleSubject;

  auth.verify=async()=>token('google-oauth2|222222222222');
  const foreign=response();
  assert.equal(await auth.authorize(req,foreign),false);
  assert.equal(foreign.code,403);
});
