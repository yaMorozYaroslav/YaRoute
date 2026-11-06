const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Tester deliberately stages src/docs/tests but not Dev-only operator scripts.
// Dev executes these audit tests; Tester records an explicit skip instead of
// pretending the absent CLI artifact is a runtime failure.
const operatorScript=path.join(__dirname,'..','scripts','nyx-heroku-two-app-audit.mjs');
const operatorTest=fs.existsSync(operatorScript)?test:test.skip;

function fixture() {
  return {
    'dev-nest-nyx': {
      NYX_PUBLIC_URL:'https://dev-nest-nyx.example.test',
      NYX_DEPLOYMENT_MODE:'public',
      NYX_PUBLIC_CONNECTORS_ENABLED:'true',
      NYX_MULTIUSER_RCLONE_ENABLED:'true',
      NYX_PUBLIC_TENANT_GOOGLE_MULTI_ENABLED:'true',
      NYX_PUBLIC_TENANT_MEGA_ONLY:'false',
      NYX_PUBLIC_NEON_HOST:'public-db.example.test',
      DATABASE_URL:'postgresql://public-db.example.test/nyx',
      NYX_STORAGE_ENCRYPTION_KEY:'public-key-placeholder',
      NYX_PRIVATE_OWNER_LINK_ENABLED:'true',
      NYX_PRIVATE_BROKER_CLIENT_ENABLED:'true',
      NYX_PRIVATE_LEGACY_OWNER_MCP_SUBJECT:'approved-subject',
      NYX_PRIVATE_BROKER_SHARED_KEY_B64:'nonsecret-fixture-marker',
    },
    'nest-nyx-pro': {
      NYX_PUBLIC_URL:'https://nest-nyx-pro.example.test',
      NYX_DEPLOYMENT_MODE:'private',
      DATABASE_URL:'postgresql://private-db.example.test/nyx',
      NYX_STORAGE_ENCRYPTION_KEY:'private-key-placeholder',
      RCLONE_CONFIG_B64:'not-a-real-config',
      NYX_PRIVATE_OAUTH_SUBJECTS:'approved-subject',
    },
  };
}

function audit(configs) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nyx-heroku-config-audit-'));
  try {
    const mock=path.join(dir,'heroku');
    const mockSource=[
      '#!/usr/bin/env node',
      'const fixture=JSON.parse(process.env.NYX_HEROKU_AUDIT_FIXTURE);',
      'const command=process.argv[2], app=process.argv[4];',
      'if(!Object.hasOwn(fixture,app))process.exit(2);',
      'process.stdout.write(JSON.stringify(command==="config"?fixture[app]:{web_url:fixture[app].NYX_PUBLIC_URL}));',
    ].join('\n')+'\n';
    fs.writeFileSync(mock,mockSource,{mode:0o700});
    const result=spawnSync(process.execPath,['scripts/nyx-heroku-two-app-audit.mjs'],{
      cwd:path.join(__dirname,'..'),
      env:{...process.env,PATH:dir+path.delimiter+(process.env.PATH||''),
        NYX_HEROKU_AUDIT_FIXTURE:JSON.stringify(configs)},
      encoding:'utf8',timeout:10000,
    });
    if(result.error)throw result.error;
    return {code:result.status,report:JSON.parse(result.stdout),stderr:result.stderr};
  } finally {
    fs.rmSync(dir,{recursive:true,force:true});
  }
}

operatorTest('public broker delegation identity and key do not falsely imply legacy Rclone leakage',()=>{
  const result=audit(fixture());
  assert.equal(result.code,0);
  assert.equal(result.report.dev.hasLegacyPrivateRcloneConfig,false);
  assert.equal(result.report.dev.hasBrokerDelegationKey,true);
  assert.equal(result.report.dev.hasPrivateBrokerServerEnabled,false);
  assert.equal(result.report.publicCutoverReadyForLiveAcceptance,true);
  assert.equal(result.report.legacyProRemotesOnlineVerified,false);
  assert.doesNotMatch(JSON.stringify(result.report),/nonsecret-fixture-marker|not-a-real-config/);
  assert.equal(result.stderr,'');
});

operatorTest('public app with inherited legacy operator Rclone or OAuth allowlist is denied',()=>{
  for(const [name,value] of [
    ['RCLONE_CONFIG_B64','legacy-placeholder'],
    ['NYX_SHARED_ROOTS_JSON','legacy-placeholder'],
    ['NYX_PRIVATE_OAUTH_SUBJECTS','old-owner'],
  ]) {
    const c=fixture();
    c['dev-nest-nyx'][name]=value;
    const result=audit(c);
    assert.equal(result.code,2,name);
    assert.equal(result.report.dev.hasLegacyPrivateRcloneConfig,true,name);
    assert.equal(result.report.publicCutoverReadyForLiveAcceptance,false,name);
  }
});

operatorTest('private broker server may not run in the public Dev app',()=>{
  const c=fixture();
  c['dev-nest-nyx'].NYX_PRIVATE_BROKER_SERVER_ENABLED='true';
  const result=audit(c);
  assert.equal(result.code,2);
  assert.equal(result.report.dev.hasPrivateBrokerServerEnabled,true);
  assert.equal(result.report.publicCutoverReadyForLiveAcceptance,false);
});
