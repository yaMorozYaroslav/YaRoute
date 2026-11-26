const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {safeCliPlan,publicGithubCliReadiness}=require('../dist/connectors/github-cli-safe');

test('Heroku APT Git uses fixed binary/helper paths, no arbitrary PATH or shell',()=>{
  const aptGit=path.resolve('.apt/usr/bin/git');
  const present=(f)=>f===aptGit;
  const token='synthetic-repository-scoped-app-token';
  const p=safeCliPlan('git','owner/repo',token,'/tmp/nyx-cli-isolated',present);
  assert.deepEqual(p.args,['ls-remote','--heads','https://github.com/owner/repo.git']);
  assert.equal(p.env.GIT_EXEC_PATH,path.resolve('.apt/usr/lib/git-core'));
  assert.equal(p.env.PATH,path.resolve('.apt/usr/bin')+':/usr/bin:/bin');
  assert.match(p.env.LD_LIBRARY_PATH,/\.apt\/usr\/lib\/x86_64-linux-gnu/);
  assert.equal(p.env.GIT_CONFIG_NOSYSTEM,'1');
  assert.equal(p.env.GIT_TERMINAL_PROMPT,'0');
  assert.ok(!p.args.join(' ').includes(token));
  assert.equal(Object.keys(p.env).some(k=>k.toLowerCase().includes('shell')),false);
});

test('GitHub API gh path does not inherit APT Git loader variables',()=>{
  const p=safeCliPlan('gh','owner/repo','synthetic-repository-scoped-app-token',
    '/tmp/nyx-cli-isolated',()=>true);
  assert.equal(p.env.GIT_EXEC_PATH,undefined);
  assert.equal(p.env.LD_LIBRARY_PATH,undefined);
  assert.deepEqual(p.args,['api','repos/owner/repo','--method','GET']);
});

test('readiness detects APT runtime git even when OS git is absent',()=>{
  const present=(p)=>p===path.resolve('.apt/usr/bin/git');
  const status=publicGithubCliReadiness({
    NYX_DEPLOYMENT_MODE:'public',NYX_PUBLIC_CONNECTORS_ENABLED:'true',
  },present);
  assert.equal(status.gitBinaryPresent,true);
  assert.equal(status.pilotEnabled,false);
  assert.equal(status.probeVerified,false);
});
