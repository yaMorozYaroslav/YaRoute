import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeDevAudit } from '../scripts/nyx-dev-public-plan.mjs';

const fixture = () => ({
  schema: 'nyx.heroku-two-app-audit.v1',
  dev: {
    name: 'dev-nest-nyx',
    flags: {
      NYX_DEPLOYMENT_MODE:'private', NYX_PUBLIC_CONNECTORS_ENABLED:'true',
      NYX_MULTIUSER_RCLONE_ENABLED:null,
      NYX_PUBLIC_TENANT_GOOGLE_MULTI_ENABLED:null,
      NYX_PUBLIC_TENANT_MEGA_ONLY:null,
    },
    hasLegacyPrivateRcloneConfig:true,
    hasEncryptedDatabase:false,
    databaseHostMatchesPublicNeon:false,
    publicUrlMatchesHeroku:true,
  },
  // Pro data is deliberately ignored. It cannot unlock Dev-only planning.
  pro: { singleGoogleOwnerConfigured:false, secret:'never-print-me' },
  distinctEncryptionKeys:false,
});

test('current sanitized live audit identifies blockers without requiring Pro readiness',()=>{
  const p=analyzeDevAudit(fixture());
  assert.equal(p.devConfigurationPrepared,false);
  assert.equal(p.inviteSecondUser,false);
  assert.equal(p.proCalls,0);
  assert.equal(p.herokuCalls,0);
  assert.equal(p.changesApplied,false);
  assert.ok(p.blockers.some(b=>b.id==='legacyPrivateRemotesAbsent'));
  assert.ok(p.blockers.some(b=>b.id==='encryptedTenantDatabasePresent'));
  assert.ok(p.blockers.some(b=>b.id==='modePublic'));
  assert.doesNotMatch(JSON.stringify(p),/never-print-me/);
});

test('even completed config-only checks never certify two-user isolation',()=>{
  const a=fixture();
  Object.assign(a.dev,{hasLegacyPrivateRcloneConfig:false,
    hasEncryptedDatabase:true,databaseHostMatchesPublicNeon:true});
  Object.assign(a.dev.flags,{NYX_DEPLOYMENT_MODE:'public',
    NYX_MULTIUSER_RCLONE_ENABLED:'true',
    NYX_PUBLIC_TENANT_GOOGLE_MULTI_ENABLED:'true',
    NYX_PUBLIC_TENANT_MEGA_ONLY:'false'});
  const p=analyzeDevAudit(a);
  assert.equal(p.devConfigurationPrepared,true);
  assert.equal(p.blockers.length,0);
  assert.equal(p.liveTwoUserSecurityVerified,false);
  assert.equal(p.inviteSecondUser,false);
});

test('private Rclone remains a hard blocker even with every public switch enabled',()=>{
  const a=fixture();
  Object.assign(a.dev,{hasEncryptedDatabase:true,databaseHostMatchesPublicNeon:true});
  Object.assign(a.dev.flags,{NYX_DEPLOYMENT_MODE:'public',
    NYX_MULTIUSER_RCLONE_ENABLED:'true',
    NYX_PUBLIC_TENANT_GOOGLE_MULTI_ENABLED:'true',
    NYX_PUBLIC_TENANT_MEGA_ONLY:'false'});
  const p=analyzeDevAudit(a);
  assert.deepEqual(p.blockers.map(b=>b.id),['legacyPrivateRemotesAbsent']);
});

test('rejects untrusted, incomplete or unrelated audit input',()=>{
  for(const a of [null,{}, {...fixture(),schema:'other'},
      {...fixture(),dev:{...fixture().dev,name:'nest-nyx-pro'}},
      {...fixture(),dev:{...fixture().dev,hasLegacyPrivateRcloneConfig:undefined}}]) {
    assert.throws(()=>analyzeDevAudit(a),/INVALID_SANITIZED_AUDIT/);
  }
});

test('CLI reads local sanitized JSON without shell or provider calls or secret output',()=>{
  const dir=mkdtempSync(join(tmpdir(),'nyx-dev-public-plan-'));
  try {
    const file=join(dir,'report.json');
    const data=fixture();
    data.unexpectedRawCredentials='should-not-appear';
    writeFileSync(file,JSON.stringify(data),{mode:0o600});
    const r=spawnSync(process.execPath,['scripts/nyx-dev-public-plan.mjs',
      '--audit-file',file], {cwd:join(import.meta.dirname,'..'),encoding:'utf8'});
    assert.equal(r.status,2);
    const out=JSON.parse(r.stdout);
    assert.equal(out.proCalls,0);
    assert.equal(out.herokuCalls,0);
    assert.equal(out.inviteSecondUser,false);
    assert.doesNotMatch(r.stdout+r.stderr,/should-not-appear|never-print-me/);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
