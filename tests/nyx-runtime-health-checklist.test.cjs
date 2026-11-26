const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { buildNyxRuntimeChecklist } = require('../dist/nyx/runtime-health-checklist');
const sha = 'a'.repeat(40);
const h = 'b'.repeat(64);
const fixture = () => ({
  runtimeCommit: sha,
  canonical: { head: 'head_db_v032.zip', body: 'body_db_v028.zip', footer: 'footer_db_v102.zip' },
  cli: { version: 'v004', sha256: h, commands: { hel: {}, ini: {}, sum: {}, key: {} } },
  effectiveCommands: ['hel', 'ini', 'sum'],
  profile: {
    configured: true, ready: true, authorityMatches: true,
    keys: [
      { key: 'active_key', mode: 'enforce', status: 'verified' },
      { key: 'temp_paths', mode: 'observe', status: 'verified' },
      { key: 'temp_nyxcli', mode: 'observe', status: 'verified' },
    ],
  },
});
const pick = (r,id) => r.checks.find(x => x.id === id);
test('verified live CLI/profile does not pretend core bundles or all commands are verified', () => {
  const r = buildNyxRuntimeChecklist(fixture());
  assert.equal(r.schema, 'nyx.runtime-checklist.v1');
  assert.equal(r.overall, 'NEEDS_REVIEW');
  assert.equal(r.readOnly, true);
  assert.equal(r.productionApproved, false);
  assert.equal(pick(r, 'canonical.registry').status, 'PASS');
  assert.equal(pick(r, 'canonical.bundles').status, 'UNVERIFIED');
  assert.equal(pick(r, 'cli.contracts').status, 'WARN');
  assert.deepEqual(pick(r, 'cli.contracts').details.canonicalOnly, ['key']);
  assert.equal(pick(r, 'template.pins').status, 'PASS');
  assert.equal(pick(r, 'template.queue').status, 'UNVERIFIED');
  assert.equal(pick(r, 'ci.functions').status, 'UNVERIFIED');
  assert.equal(pick(r, 'cli.smoke').status, 'UNVERIFIED');
  assert.equal(pick(r, 'security.tenants').status, 'UNVERIFIED');
});
test('enforced key drift blocks release; observed staging drift is warning only', () => {
  const a = fixture();
  a.profile.keys[0].status = 'changed';
  const blocked = buildNyxRuntimeChecklist(a);
  assert.equal(blocked.overall, 'BLOCKED');
  assert.equal(pick(blocked,'template.pins').status,'FAIL');
  a.profile.keys[0].status = 'verified';
  a.profile.keys[1].status = 'unavailable';
  const warn = buildNyxRuntimeChecklist(a);
  assert.equal(warn.overall, 'NEEDS_REVIEW');
  assert.equal(pick(warn,'template.pins').status,'WARN');
  assert.equal(pick(warn,'template.pins').details.observedDrift,true);
});
test('missing bootstrap or CLI never reports green, and returns no source text', () => {
  const r = buildNyxRuntimeChecklist({sourceError:'RESOURCE_READ_FAILED',runtimeCommit:'not-a-sha'});
  assert.equal(r.overall,'BLOCKED');
  assert.equal(pick(r,'canonical.registry').status,'FAIL');
  assert.equal(pick(r,'canonical.bundles').status,'UNVERIFIED');
  assert.equal(pick(r,'deployment.commit').status,'UNVERIFIED');
  assert.ok(!JSON.stringify(r).includes('RESOURCE_READ_FAILED'));
});
test('invalid execution profile is a separate failure from CLI authority', () => {
  const x = fixture();
  x.profile = { configured:true, ready:false, error:'EXECUTION_PROFILE_INVALID_OR_UNAVAILABLE', keys:[] };
  x.effectiveCommands = undefined;
  const r = buildNyxRuntimeChecklist(x);
  assert.equal(pick(r,'canonical.registry').status,'PASS');
  assert.equal(pick(r,'runtime.profile').status,'FAIL');
  assert.equal(pick(r,'template.pins').status,'UNVERIFIED');
  assert.equal(pick(r,'cli.contracts').status,'UNVERIFIED');
  assert.equal(r.overall,'BLOCKED');
});
test('guarded endpoint cannot expose canonical diagnostics to public tenants', () => {
  const src = fs.readFileSync('src/nyx/nyx.controller.ts','utf8');
  const route=src.slice(src.indexOf("@Get('checklist')"),src.indexOf("@Get('head')"));
  assert.ok(route.includes('buildNyxRuntimeChecklist'));
  assert.ok(!route.includes('@Public()'));
  const guard = fs.readFileSync('src/common/api-key.guard.ts','utf8');
  assert.match(guard,/NYX_DEPLOYMENT_MODE === 'public'/);
  assert.match(guard,/NYX_PUBLIC_CONNECTORS_ENABLED === 'true'/);
});
