const {test}=require('node:test');
const assert=require('node:assert/strict');
const {publicMegaActivationPreflight}=require('../dist/runtime/public-mega-activation-preflight');

const privateOrigin='https://private-dev.example.com';
function prepared() {
  return {
    NYX_PUBLIC_URL:'https://public-pilot.herokuapp.com',
    NYX_SERVICE_NAME:'NestNyxPublicPilot',
    NYX_DEPLOYMENT_MODE:'public',
    NYX_PUBLIC_CONNECTORS_ENABLED:'true',
    NYX_MULTIUSER_RCLONE_ENABLED:'true',
    NYX_PUBLIC_TENANT_MEGA_ONLY:'true',
    NYX_OAUTH_ISSUER:'https://trusted-issuer.example.com',
    NYX_OAUTH_AUDIENCE:'https://public-pilot.herokuapp.com/mcp',
    NYX_OAUTH_SCOPES:'nyx.read,nyx.write',
    NYX_OAUTH_ALGORITHMS:'RS256',
    DATABASE_URL:['postgresql://synthetic:test-only-password','db.example.com/pilot'].join('@'),
    NYX_STORAGE_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64'),
    NYX_PRIVATE_OWNER_LINK_ENABLED:'false',
    NYX_PRIVATE_BROKER_CLIENT_ENABLED:'false',
    HOME:'/home/pilot',
  };
}
async function check(env,options={}) {
  return publicMegaActivationPreflight(env,{
    existingPrivateOrigin:privateOrigin,exists:()=>false,...options,
  });
}
test('valid isolated public config is PREPARED, never misrepresented as live verified',async()=>{
  const env=prepared(),result=await check(env);
  assert.equal(result.status,'CONFIG_PREPARED_LIVE_TESTS_REQUIRED');
  assert.equal(result.blockers.length,0);
  assert.equal(result.liveDeploymentVerified,false);
  assert.equal(result.externalIdentityProviderVerified,false);
  assert.equal(result.realTwoGoogleUsersAndMegaAccountsVerified,false);
  assert.equal(result.ownerPrivateBrokerVerified,false);
  assert.equal(result.noSecretValuesReturned,true);
  const safe=JSON.stringify(result);
  assert.doesNotMatch(safe,/test-only-password|NYX_STORAGE_ENCRYPTION_KEY|db\.example/);
  assert.doesNotMatch(safe,new RegExp(env.NYX_STORAGE_ENCRYPTION_KEY.replace(/[+/=]/g,'')));
});
test('cannot point public pilot at the existing private application',async()=>{
  const env=prepared();
  env.NYX_PUBLIC_URL=privateOrigin;
  env.NYX_OAUTH_AUDIENCE=privateOrigin+'/mcp';
  const result=await check(env);
  assert.equal(result.status,'BLOCKED');
  assert.ok(result.blockers.includes('PUBLIC_ORIGIN_MUST_DIFFER_FROM_PRIVATE_DEV'));
  const noReference=await check(prepared(),{existingPrivateOrigin:''});
  assert.ok(noReference.blockers.includes('EXISTING_PRIVATE_ORIGIN_EVIDENCE_REQUIRED'));
});
test('legacy operator configs, allowlists, and any leftover rclone file block public startup',async()=>{
  for(const [key,value] of [
    ['RCLONE_CONFIG_B64','synthetic'],
    ['RCLONE_CONFIG_OTHER_PASSWORD','synthetic'],
    ['NYX_SHARED_ROOTS_JSON','{}'],
    ['NYX_PRIVATE_OAUTH_SUBJECTS','some-subject'],
    ['NYX_PRIVATE_BROKER_SHARED_KEY_B64','synthetic'],
  ]) {
    const result=await check({...prepared(),[key]:value});
    assert.ok(result.blockers.includes('PRIVATE_OPERATOR_CREDENTIALS_OR_ALLOWLIST_FORBIDDEN'),key);
    assert.doesNotMatch(JSON.stringify(result),/synthetic/);
  }
  const oldFile=await check(prepared(),{exists:f=>f==='/tmp/rclone.conf'});
  assert.ok(oldFile.blockers.includes('PRIVATE_RCLONE_FILE_PRESENT'));
  const homeFile=await check(prepared(),{exists:f=>f==='/home/pilot/.config/rclone/rclone.conf'});
  assert.ok(homeFile.blockers.includes('PRIVATE_RCLONE_FILE_PRESENT'));
  const premature=await check({...prepared(),NYX_PRIVATE_OWNER_LINK_ENABLED:'true'});
  assert.ok(premature.blockers.includes('PRIVATE_BROKER_MUST_REMAIN_OFF_DURING_TENANT_PILOT'));
});
test('missing security prerequisites never pass initial public pilot preflight',async()=>{
  const cases=[
    ['NYX_DEPLOYMENT_MODE','private','PUBLIC_DEPLOYMENT_MODE_REQUIRED'],
    ['NYX_PUBLIC_CONNECTORS_ENABLED','false','PUBLIC_CONNECTORS_REQUIRED'],
    ['NYX_MULTIUSER_RCLONE_ENABLED','false','TENANT_RCLONE_REQUIRED'],
    ['NYX_PUBLIC_TENANT_MEGA_ONLY','false','EXACTLY_ONE_TENANT_PROVIDER_MODE_REQUIRED'],
    ['NYX_OAUTH_ISSUER','http://issuer.example.com','TRUSTED_HTTPS_OAUTH_ISSUER_REQUIRED'],
    ['NYX_OAUTH_AUDIENCE','https://other.example.com/mcp','SEPARATE_MCP_AUDIENCE_REQUIRED'],
    ['NYX_OAUTH_SCOPES','nyx.read','EXACT_MCP_SCOPES_REQUIRED'],
    ['NYX_OAUTH_ALGORITHMS','HS256','ASYMMETRIC_RSA256_JWT_REQUIRED'],
    ['NYX_STORAGE_ENCRYPTION_KEY','weak','DEDICATED_AES256_KEY_REQUIRED'],
    ['DATABASE_URL','sqlite://in-memory','DEDICATED_POSTGRES_REQUIRED'],
    ['NYX_SERVICE_NAME','DevNestNyx','PUBLIC_PILOT_SERVICE_ID_REQUIRED'],
  ];
  for(const [key,value,blocker] of cases) {
    const result=await check({...prepared(),[key]:value});
    assert.equal(result.status,'BLOCKED',key);
    assert.ok(result.blockers.includes(blocker),key);
  }
});

test('public Google login Drive+MEGA mode passes static checks but not live acceptance',async()=>{
  const old=prepared();
  const mode={...old,NYX_PUBLIC_TENANT_MEGA_ONLY:'false',
    NYX_PUBLIC_TENANT_GOOGLE_MULTI_ENABLED:'true'};
  const result=await check(mode);
  assert.equal(result.status,'CONFIG_PREPARED_LIVE_TESTS_REQUIRED');
  assert.equal(result.providerMode,'mega-and-google-drive');
  assert.equal(result.liveDeploymentVerified,false);
  assert.equal(result.externalIdentityProviderVerified,false);
  assert.equal(result.ownerPrivateBrokerVerified,false);
});
test('simultaneous or missing provider switches fail closed',async()=>{
  const old=prepared();
  for(const mode of [
    {...old,NYX_PUBLIC_TENANT_MEGA_ONLY:'false',
      NYX_PUBLIC_TENANT_GOOGLE_MULTI_ENABLED:'false'},
    {...old,NYX_PUBLIC_TENANT_MEGA_ONLY:'true',
      NYX_PUBLIC_TENANT_GOOGLE_MULTI_ENABLED:'true'},
  ]) {
    const result=await check(mode);
    assert.equal(result.status,'BLOCKED');
    assert.equal(result.providerMode,'invalid');
    assert.ok(result.blockers.includes('EXACTLY_ONE_TENANT_PROVIDER_MODE_REQUIRED'));
  }
});
