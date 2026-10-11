const {test}=require('node:test');
const assert=require('node:assert/strict');

test('manual release preflight rejects MEGA setup without vault or valid HTTPS host',async()=>{
  const {privateReleaseConditions}=await import('../scripts/private-release-conditions.mjs');
  const basic={NYX_DEPLOYMENT_MODE:'public',NYX_PUBLIC_CONNECTORS_ENABLED:'true',
    NYX_RCLONE_VAULT_ENABLED:'false',
    NYX_MEGA_SELF_SERVICE_ENABLED:'true',
    NYX_PUBLIC_URL:'http://localhost:3000',
    DATABASE_URL:'configured-through-secure-host'};
  const errors=privateReleaseConditions(basic);
  assert.ok(errors.includes('PUBLIC_RCLONE_VAULT_REQUIRED'));
  assert.ok(errors.includes('MEGA_SELF_SERVICE_REQUIRES_VAULT'));
  assert.ok(errors.includes('MEGA_SELF_SERVICE_PUBLIC_HTTPS_REQUIRED'));
});
test('manual release preflight accepts independent encrypted MEGA vault and HTTPS origin',async()=>{
  const {privateReleaseConditions}=await import('../scripts/private-release-conditions.mjs');
  const valid={NYX_DEPLOYMENT_MODE:'public',NYX_PUBLIC_CONNECTORS_ENABLED:'true',
    NYX_RCLONE_VAULT_ENABLED:'true',NYX_MEGA_SELF_SERVICE_ENABLED:'true',
    NYX_PUBLIC_URL:'https://nestnyx.example',DATABASE_URL:'configured-in-heroku',
    NYX_RCLONE_CREDENTIAL_KEY:Buffer.alloc(32).toString('base64')};
  assert.deepEqual(privateReleaseConditions(valid),[]);
});
