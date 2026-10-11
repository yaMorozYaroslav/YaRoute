const {test}=require('node:test');
const assert=require('node:assert/strict');
const {HealthController,buildHealthResponse}=require('../dist/health.controller');

const keys=['NYX_DEPLOYMENT_MODE','NYX_PUBLIC_URL','NYX_GOOGLE_CLIENT_ID',
  'NYX_GOOGLE_CLIENT_SECRET','NYX_RCLONE_VAULT_ENABLED',
  'NYX_RCLONE_CREDENTIAL_KEY','DATABASE_URL','NYX_MEGA_SELF_SERVICE_ENABLED'];
function setup(t){
  const old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  t.after(()=>{for(const[k,v]of Object.entries(old))
    v===undefined?delete process.env[k]:process.env[k]=v;});
  for(const k of keys)delete process.env[k];
}
function health(){
  return new HealthController({version:async()=> 'rclone mock version'},
    {isDurable:()=>true}).getHealth();
}
test('private health distinguishes configuration readiness from live provider checks',async t=>{
  setup(t);
  const q=(await health()).connectorRelease;
  assert.equal(q.mode,'private_compatibility');
  assert.equal(q.legacySharedRcloneAllowed,true);
  assert.equal(q.googleOAuthConfigured,false);
  assert.equal(q.megaFormEnabled,false);
  assert.equal(q.multiUserYaroReady,false);
  assert.equal(q.requiresLiveProviderVerification,true);
});
test('public health remains connectors-only even when storage credentials are configured',async t=>{
  setup(t);
  Object.assign(process.env,{NYX_DEPLOYMENT_MODE:'public',
    NYX_PUBLIC_URL:'https://nestnyx.example',NYX_GOOGLE_CLIENT_ID:'mock',
    NYX_GOOGLE_CLIENT_SECRET:'mock',NYX_RCLONE_VAULT_ENABLED:'true',
    NYX_RCLONE_CREDENTIAL_KEY:'A'.repeat(44),DATABASE_URL:'dummy',
    NYX_MEGA_SELF_SERVICE_ENABLED:'true'});
  const q=(await health()).connectorRelease;
  assert.equal(q.mode,'public_connectors_only');
  assert.equal(q.legacySharedRcloneAllowed,false);
  assert.equal(q.googleOAuthConfigured,true);
  assert.equal(q.ownerVaultConfigured,true);
  assert.equal(q.megaFormEnabled,true);
  assert.equal(q.multiUserYaroReady,false);
});

test('nyx_health MCP uses the same pure health implementation as GET /health',async t=>{
  setup(t);
  const healthSnapshot=await health();
  const shared=buildHealthResponse('rclone mock version',true);
  assert.deepEqual(healthSnapshot,shared);
  const fs=require('node:fs');
  const mcp=fs.readFileSync(require('node:path').join(__dirname,'../src/mcp/mcp.service.ts'),'utf8');
  assert.match(mcp,/server\\.registerTool\\(\\s*'nyx_health'/);
  assert.match(mcp,/this\\.connectorOwner\\(\\)/);
  assert.match(mcp,/buildHealthResponse\\(await this\\.rclone\\.version\\(\\),this\\.jobs\\.isDurable\\(\\)\\)/);
  assert.match(mcp,/readOnlyHint:true,destructiveHint:false,idempotentHint:true/);
});
